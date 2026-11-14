import type { Collection, Document } from "mongodb";
import { atlasSearchAvailable, setAtlasSearchAvailable } from "./env.ts";
import { cosine } from "./embed.ts";

let warned = false;

/**
 * $vectorSearch on Atlas; on a local replica set (no search nodes) falls back to an in-process
 * cosine scan over the filtered docs, with a one-time warning. Results carry `score` in [0,1]-ish.
 */
export async function vectorQuery<T extends Document>(
  coll: Collection<T>,
  index: string,
  queryVector: number[],
  filter: Record<string, unknown>,
  k: number,
  projection: Record<string, 0 | 1> = { embedding: 0 },
): Promise<(T & { score: number })[]> {
  if (atlasSearchAvailable() !== false) {
    try {
      const rows = await coll
        .aggregate<T & { score: number }>([
          { $vectorSearch: { index, path: "embedding", queryVector, numCandidates: Math.max(50, k * 20), limit: k, filter } },
          { $set: { score: { $meta: "vectorSearchScore" } } },
          { $project: projection },
        ])
        .toArray();
      setAtlasSearchAvailable(true);
      return rows;
    } catch (e) {
      if (atlasSearchAvailable() === true) throw e;
      setAtlasSearchAvailable(false);
      if (!warned) {
        console.warn(`[db] $vectorSearch unavailable (${(e as Error).message.slice(0, 80)}): using local cosine fallback`);
        warned = true;
      }
    }
  }
  const docs = await coll.find(filter as never).limit(5000).toArray();
  return docs
    .map((d) => {
      const emb = (d as unknown as { embedding?: number[] }).embedding;
      const score = emb ? (1 + cosine(queryVector, emb)) / 2 : 0; // same scale as Atlas cosine score
      const out: Record<string, unknown> = { ...d, score };
      for (const [key, v] of Object.entries(projection)) if (v === 0) delete out[key];
      return out as T & { score: number };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
