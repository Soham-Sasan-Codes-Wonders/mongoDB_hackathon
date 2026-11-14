import type { Collection, Document } from "mongodb";
import { collection } from "./database.js";
import { ExperienceSchema } from "./schemas.js";

export type EmbedInputType = "document" | "query";
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

export async function embed(texts: string[], inputType: EmbedInputType): Promise<number[][]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error("VOYAGE_API_KEY is required to create embeddings");
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
  return collection("system_profiles").aggregate([
    { $vectorSearch: { index: "system_profiles_vector", path: "embedding", queryVector: vector, numCandidates: Math.max(k * 10, 100), limit: k, filter: { docType: "canonical_field" } } },
    { $project: { _id: 1, fieldName: 1, description: 1, score: { $meta: "vectorSearchScore" } } }
  ]).toArray();
}

export async function findSimilarExperiences(problemText: string, filters: { problemType: string; system: string }, k: number): Promise<Document[]> {
  const [vector] = await embed([problemText], "query");
  return collection("experiences").aggregate([
    { $vectorSearch: { index: "experiences_vector", path: "embedding", queryVector: vector, numCandidates: Math.max(k * 10, 100), limit: k, filter: { problemType: filters.problemType, system: filters.system } } },
    { $project: { problemType: 1, system: 1, problem: 1, fix: 1, outcome: 1, score: { $meta: "vectorSearchScore" } } }
  ]).toArray();
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
