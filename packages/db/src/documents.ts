import { GridFSBucket, ObjectId, type WithId } from "mongodb";
import { col } from "./collections.ts";
import { now } from "./clock.ts";
import { getDb, atlasSearchAvailable, setAtlasSearchAvailable } from "./env.ts";
import { DocumentMeta } from "./schemas.ts";

export const DOCUMENTS_TEXT_INDEX = "documents_text";

async function bucket() {
  return new GridFSBucket(await getDb(), { bucketName: "files" });
}

export interface NewDocument {
  claimId: string;
  docType: DocumentMeta["docType"];
  source: string;
  extractedText?: string;
  filename?: string;
  contentType?: string;
  data?: Buffer;
  meta?: Record<string, unknown>;
}

/** Store a file in GridFS (bucket `files`) plus its `documents` metadata row. Data is optional. */
export async function putDocument(d: NewDocument): Promise<string> {
  let gridfsId: ObjectId | null = null;
  if (d.data) {
    const b = await bucket();
    gridfsId = await new Promise<ObjectId>((resolve, reject) => {
      const up = b.openUploadStream(d.filename ?? `${d.docType}.bin`, { metadata: { claimId: d.claimId, docType: d.docType, contentType: d.contentType } });
      up.on("error", reject);
      up.on("finish", () => resolve(up.id as ObjectId));
      up.end(d.data);
    });
  }
  const doc = DocumentMeta.parse({
    claimId: d.claimId,
    docType: d.docType,
    gridfsId,
    filename: d.filename ?? null,
    contentType: d.contentType ?? null,
    extractedText: d.extractedText ?? "",
    source: d.source,
    meta: d.meta ?? {},
    createdAt: now(),
  });
  const res = await (await col.documents()).insertOne(doc);
  return String(res.insertedId);
}

export async function getFile(gridfsId: string | ObjectId): Promise<Buffer> {
  const b = await bucket();
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    b.openDownloadStream(typeof gridfsId === "string" ? new ObjectId(gridfsId) : gridfsId)
      .on("data", (c: Buffer) => chunks.push(c))
      .on("error", reject)
      .on("end", () => resolve(Buffer.concat(chunks)));
  });
}

export async function listDocuments(claimId: string, docType?: DocumentMeta["docType"]): Promise<WithId<DocumentMeta>[]> {
  return (await col.documents()).find({ claimId, ...(docType ? { docType } : {}) }).sort({ createdAt: 1 }).toArray();
}

export async function findDocumentByMeta(claimId: string, key: string, value: unknown): Promise<WithId<DocumentMeta> | null> {
  return (await col.documents()).findOne({ claimId, [`meta.${key}`]: value });
}

let warned = false;
/** Atlas Search full-text over extractedText (index `documents_text`); regex fallback locally. */
export async function searchDocuments(claimId: string, query: string, limit = 20) {
  const docs = await col.documents();
  if (atlasSearchAvailable() !== false) {
    try {
      const rows = await docs
        .aggregate([
          {
            $search: {
              index: DOCUMENTS_TEXT_INDEX,
              compound: {
                must: [{ text: { query, path: "extractedText" } }],
                filter: [{ equals: { path: "claimId", value: claimId } }],
              },
              highlight: { path: "extractedText" },
            },
          },
          { $limit: limit },
          { $set: { score: { $meta: "searchScore" }, highlights: { $meta: "searchHighlights" } } },
        ])
        .toArray();
      setAtlasSearchAvailable(true);
      return rows;
    } catch (e) {
      if (atlasSearchAvailable() === true) throw e;
      setAtlasSearchAvailable(false);
      if (!warned) {
        console.warn("[db] $search unavailable: using regex fallback for searchDocuments");
        warned = true;
      }
    }
  }
  const rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  return docs.find({ claimId, extractedText: rx }).limit(limit).toArray();
}
