import { GridFSBucket, ObjectId, type Document } from "mongodb";
import { db, collection } from "./database.js";
import type { DocumentMetadata } from "./schemas.js";

const bucket = new GridFSBucket(db, { bucketName: "files" });
export async function uploadDocument(input: { claimId: string; docType: DocumentMetadata["docType"]; filename: string; bytes: Buffer; contentType: string; extractedText?: string; source: string }): Promise<string> {
  const upload = bucket.openUploadStream(input.filename, { contentType: input.contentType, metadata: { claimId: input.claimId, docType: input.docType } });
  await new Promise<void>((resolve, reject) => { upload.once("error", reject); upload.once("finish", () => resolve()); upload.end(input.bytes); });
  const metadata = await collection("documents").insertOne({ claimId: input.claimId, docType: input.docType, gridfsId: upload.id, extractedText: input.extractedText ?? "", source: input.source, createdAt: new Date() });
  return metadata.insertedId.toString();
}
export async function downloadDocument(gridfsId: string | ObjectId): Promise<Buffer> {
  const id = gridfsId instanceof ObjectId ? gridfsId : new ObjectId(gridfsId);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => { bucket.openDownloadStream(id).on("data", (chunk: Buffer) => chunks.push(chunk)).once("error", reject).once("end", resolve); });
  return Buffer.concat(chunks);
}
export async function searchDocuments(claimId: string, query: string): Promise<Document[]> {
  return collection("documents").aggregate([
    { $search: { index: "documents_text", compound: { must: [{ text: { query, path: "extractedText" } }], filter: [{ equals: { path: "claimId", value: claimId } }] } } },
    { $limit: 20 }, { $project: { claimId: 1, docType: 1, gridfsId: 1, extractedText: 1, source: 1, score: { $meta: "searchScore" } } }
  ]).toArray();
}
export async function deleteClaimDocuments(claimId: string): Promise<number> {
  const docs = await collection<DocumentMetadata & Document>("documents").find({ claimId }).toArray();
  await Promise.all(docs.map((doc) => bucket.delete(doc.gridfsId instanceof ObjectId ? doc.gridfsId : new ObjectId(String(doc.gridfsId)))));
  return (await collection("documents").deleteMany({ claimId })).deletedCount;
}
