import { col } from "./collections.ts";
import { now } from "./clock.ts";
import { embedOne } from "./embed.ts";
import { vectorQuery } from "./vector.ts";
import { Experience } from "./schemas.ts";

export const EXPERIENCE_VECTOR_INDEX = "experiences_vector";

export interface NewExperience {
  problemType: Experience["problemType"];
  system: string;
  problem: string;
  fix: Record<string, unknown>;
  outcome: string;
  claimId?: string | null;
}

/** Embed the problem text, then insert. Every subflow ends with this. */
export async function recordExperience(e: NewExperience): Promise<string> {
  const embedding = await embedOne(`${e.problemType} on ${e.system}: ${e.problem}`, "document");
  const doc = Experience.parse({ ...e, claimId: e.claimId ?? null, embedding, createdAt: now() });
  const res = await (await col.experiences()).insertOne(doc);
  return String(res.insertedId);
}

export async function findSimilarExperiences(
  problemText: string,
  filter: { problemType?: Experience["problemType"]; system?: string },
  k = 3,
): Promise<(Omit<Experience, "embedding"> & { score: number })[]> {
  const q = await embedOne(`${filter.problemType ?? ""} on ${filter.system ?? ""}: ${problemText}`, "query");
  const f: Record<string, unknown> = {};
  if (filter.problemType) f.problemType = filter.problemType;
  if (filter.system) f.system = filter.system;
  return vectorQuery(await col.experiences(), EXPERIENCE_VECTOR_INDEX, q, f, k) as never;
}
