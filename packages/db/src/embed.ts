import { createHash } from "node:crypto";
import { env } from "./env.ts";

export const EMBED_MODEL = "voyage-3.5";
export const EMBED_DIM = 1024;
const BATCH = 96;

let warned = false;

/**
 * Voyage AI embeddings (voyage-3.5, 1024 dims, cosine). input_type "document" when storing,
 * "query" when searching. Batches and retries. Without VOYAGE_API_KEY it falls back to a
 * deterministic local hashing embedding (character trigrams) so local dev and tests still run.
 */
export async function embed(texts: string[], inputType: "document" | "query"): Promise<number[][]> {
  if (!texts.length) return [];
  if (!env.voyageKey) {
    if (!warned) {
      console.warn("[db] VOYAGE_API_KEY not set: using local hashing embeddings (dev only)");
      warned = true;
    }
    return texts.map(localEmbedding);
  }
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    out.push(...(await voyageBatch(texts.slice(i, i + BATCH), inputType)));
  }
  return out;
}

export async function embedOne(text: string, inputType: "document" | "query"): Promise<number[]> {
  return (await embed([text], inputType))[0]!;
}

async function voyageBatch(input: string[], inputType: "document" | "query"): Promise<number[][]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.voyageKey}` },
        body: JSON.stringify({ input, model: EMBED_MODEL, input_type: inputType, output_dimension: EMBED_DIM }),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`voyage ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`voyage ${res.status}: ${await res.text()}`), { fatal: true });
      const json = (await res.json()) as { data: { embedding: number[]; index: number }[] };
      return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    } catch (e) {
      lastErr = e;
      if ((e as { fatal?: boolean }).fatal) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr;
}

/** Split camelCase/snake_case into words so "policy_ref" and "policyNumber" share tokens. */
export function normalizeForEmbedding(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]/g, " ")
    .toLowerCase();
}

export function localEmbedding(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  const norm = ` ${normalizeForEmbedding(text)} `;
  const add = (gram: string, w: number) => {
    const h = createHash("md5").update(gram).digest();
    const idx = h.readUInt32BE(0) % EMBED_DIM;
    v[idx]! += (h[4]! & 1 ? 1 : -1) * w;
  };
  for (let i = 0; i < norm.length - 2; i++) add(norm.slice(i, i + 3), 1);
  for (const w of norm.split(/\s+/).filter(Boolean)) add(`w:${w}`, 2);
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / mag);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
