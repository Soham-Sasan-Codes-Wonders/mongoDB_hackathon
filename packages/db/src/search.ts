import type { Collection, Document } from "mongodb";
import { collection } from "./database.js";
import { ExperienceSchema } from "./schemas.js";

export type EmbedInputType = "document" | "query";
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

export async function embed(texts: string[], inputType: EmbedInputType): Promise<number[][]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key && process.env.ALLOW_LOCAL_EMBEDDINGS === "1") return texts.map(localEmbedding);
  if (!key) throw new Error("VOYAGE_API_KEY is required to create embeddings (or set ALLOW_LOCAL_EMBEDDINGS=1 for offline dev)");
  const output: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += 64) {
    const batch = texts.slice(offset, offset + 64);
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(VOYAGE_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "voyage-3.5", input: batch, input_type: inputType })
        });
        if (!response.ok) {
          const error = new Error(`Voyage request failed (${response.status}): ${await response.text()}`) as Error & { retryDelayMs?: number };
          if (response.status === 429) {
            const retryAfterSeconds = Number(response.headers.get("retry-after"));
            error.retryDelayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1_000 : 20_500 * (attempt + 1);
          }
          throw error;
        }
        const body = await response.json() as { data: Array<{ embedding: number[]; index: number }> };
        const ordered = [...body.data].sort((a, b) => a.index - b.index);
        if (ordered.length !== batch.length || ordered.some(({ embedding }) => embedding.length !== 1024)) throw new Error("Voyage returned an unexpected embedding shape");
        output.push(...ordered.map(({ embedding }) => embedding));
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          const retryDelay = typeof error === "object" && error !== null && "retryDelayMs" in error && typeof error.retryDelayMs === "number" ? error.retryDelayMs : 300 * 2 ** attempt;
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }
      }
    }
    if (lastError) throw lastError;
  }
  return output;
}

export async function matchCanonicalField(fieldText: string, k: number): Promise<Document[]> {
  const [vector] = await embed([fieldText], "query");
  return vectorSearch(collection("system_profiles"), [
    { $vectorSearch: { index: "system_profiles_vector", path: "embedding", queryVector: vector, numCandidates: Math.max(k * 10, 100), limit: k, filter: { docType: "canonical_field" } } },
    { $project: { _id: 1, fieldName: 1, description: 1, score: { $meta: "vectorSearchScore" } } }
  ], vector!, { docType: "canonical_field" }, k, { _id: 1, fieldName: 1, description: 1 });
}

export async function findSimilarExperiences(problemText: string, filters: { problemType?: string; system?: string }, k: number): Promise<Document[]> {
  const [vector] = await embed([problemText], "query");
  const filter: Document = { ...(filters.problemType ? { problemType: filters.problemType } : {}), ...(filters.system ? { system: filters.system } : {}) };
  return vectorSearch(collection("experiences"), [
    { $vectorSearch: { index: "experiences_vector", path: "embedding", queryVector: vector, numCandidates: Math.max(k * 10, 100), limit: k, filter } },
    { $project: { problemType: 1, system: 1, problem: 1, fix: 1, outcome: 1, score: { $meta: "vectorSearchScore" } } }
  ], vector!, filter, k, { problemType: 1, system: 1, problem: 1, fix: 1, outcome: 1 });
}

export async function recordExperience(input: Omit<import("./schemas.js").Experience, "_id" | "embedding" | "createdAt">): Promise<import("mongodb").InsertOneResult<Document>> {
  const [embedding] = await embed([input.problem], "document");
  return collection("experiences").insertOne(ExperienceSchema.parse({ ...input, embedding, createdAt: new Date() }) as unknown as Document);
}

export async function ensureSearchIndexes(): Promise<void> {
  await Promise.all([
    ensureIndex(collection("system_profiles"), "system_profiles_vector", "vectorSearch", { fields: [
      { type: "vector", path: "embedding", numDimensions: 1024, similarity: "cosine" },
      { type: "filter", path: "docType" }, { type: "filter", path: "system" }
    ] }),
    ensureIndex(collection("experiences"), "experiences_vector", "vectorSearch", { fields: [
      { type: "vector", path: "embedding", numDimensions: 1024, similarity: "cosine" },
      { type: "filter", path: "problemType" }, { type: "filter", path: "system" }
    ] }),
    ensureIndex(collection("documents"), "documents_text", "search", { mappings: { dynamic: false, fields: {
      extractedText: { type: "string" }, docType: { type: "token" }, claimId: { type: "token" }
    } } })
  ]);
}

async function ensureIndex(target: Collection, name: string, type: "search" | "vectorSearch", definition: Document): Promise<void> {
  const existing = await target.listSearchIndexes().toArray();
  if (!existing.some((index) => index.name === name)) await target.createSearchIndex({ name, type, definition });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const current = await target.listSearchIndexes().toArray() as Array<{ name: string; queryable?: boolean; status?: string; statusDetail?: string }>;
    const index = current.find((candidate) => candidate.name === name);
    if (index?.queryable === true) return;
    if (index?.status === "FAILED") throw new Error(`Atlas Search index ${name} failed: ${index.statusDetail ?? "unknown reason"}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Timed out waiting for Atlas Search index ${name} to become queryable`);
}

/* ---------------------------------------------------------------- local-dev fallbacks (agent additions) */

let localWarned = false;
/**
 * Run a $vectorSearch pipeline; on a deployment without Atlas Search (a local replica set) fall back
 * to an in-process cosine scan over the filtered docs, warning once. Atlas is always tried first.
 */
async function vectorSearch(target: Collection, pipeline: Document[], vector: number[], filter: Document, k: number, projection: Document): Promise<Document[]> {
  try {
    return await target.aggregate(pipeline).toArray();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/only allowed on MongoDB Atlas|Unrecognized pipeline stage|not supported|SearchNotEnabled/i.test(message)) throw error;
    if (!localWarned) console.warn(`[db] $vectorSearch unavailable here (${message.slice(0, 80)}); using a local cosine scan`);
    localWarned = true;
  }
  const docs = await target.find(filter).limit(5000).toArray();
  return docs
    .map((d) => {
      const out: Document = { _id: d._id, score: Array.isArray(d.embedding) ? (1 + cosine(vector, d.embedding as number[])) / 2 : 0 };
      for (const key of Object.keys(projection)) out[key] = d[key];
      return out;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * Deterministic offline embedding (character trigrams + words, hashed into 1024 dims), used only when
 * ALLOW_LOCAL_EMBEDDINGS=1 and no VOYAGE_API_KEY. Every value is a non-integer so BSON stores doubles.
 */
export function localEmbedding(text: string): number[] {
  const v = new Array<number>(1024).fill(0);
  const norm = ` ${text.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\-.]/g, " ").toLowerCase()} `;
  const add = (gram: string, w: number) => {
    let h = 2166136261;
    for (let i = 0; i < gram.length; i += 1) h = Math.imul(h ^ gram.charCodeAt(i), 16777619);
    v[(h >>> 0) % 1024]! += ((h >>> 10) & 1 ? 1 : -1) * w;
  };
  for (let i = 0; i < norm.length - 2; i += 1) add(norm.slice(i, i + 3), 1);
  for (const w of norm.split(/\s+/).filter(Boolean)) add(`w:${w}`, 2);
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / mag + 1e-9);
}
