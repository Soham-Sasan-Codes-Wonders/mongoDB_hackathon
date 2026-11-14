import { col } from "./collections.ts";
import { now } from "./clock.ts";
import { embed, embedOne } from "./embed.ts";
import { vectorQuery } from "./vector.ts";
import { SystemProfile, type OutsideSystem, type ProfileField } from "./schemas.ts";

export const PROFILE_VECTOR_INDEX = "system_profiles_vector";

/** Latest `docType: "profile"` version for a system. */
export async function getLatestProfile(system: OutsideSystem): Promise<SystemProfile | null> {
  const doc = await (await col.profiles()).findOne({ docType: "profile", system }, { sort: { version: -1 }, projection: { _id: 0 } });
  return doc ? SystemProfile.parse(doc) : null;
}

export async function listProfileVersions(system: OutsideSystem): Promise<SystemProfile[]> {
  const docs = await (await col.profiles()).find({ docType: "profile", system }, { projection: { _id: 0 } }).sort({ version: 1 }).toArray();
  return docs.map((d) => SystemProfile.parse(d));
}

function fieldText(system: string, f: Pick<ProfileField, "name" | "description" | "sampleValues" | "type">): string {
  return `${system} field ${f.name} (${f.type}): ${f.description ?? ""}. samples: ${(f.sampleValues ?? []).join(", ")}`;
}

/**
 * Save a new profile version (version = latest + 1) plus one `docType: "field"` doc per field
 * with its embedding. Returns the new version number.
 */
export async function saveProfileVersion(p: {
  system: OutsideSystem;
  fields: ProfileField[];
  workflowSteps: string[];
  fieldMap?: Record<string, string>;
  source?: string;
}): Promise<number> {
  const profiles = await col.profiles();
  const latest = await getLatestProfile(p.system);
  const version = (latest?.version ?? 0) + 1;
  const doc = SystemProfile.parse({
    docType: "profile",
    system: p.system,
    version,
    fields: p.fields,
    workflowSteps: p.workflowSteps,
    fieldMap: p.fieldMap ?? latest?.fieldMap ?? {},
    source: p.source ?? "agent",
    createdAt: now(),
  });
  const vectors = await embed(p.fields.map((f) => fieldText(p.system, f)), "document");
  await profiles.insertOne({ ...doc });
  if (p.fields.length) {
    await profiles.insertMany(
      p.fields.map((f, i) => ({
        docType: "field",
        system: p.system,
        version,
        fieldName: f.name,
        description: f.description ?? "",
        sampleValues: f.sampleValues ?? [],
        embedding: vectors[i]!,
      })),
    );
  }
  return version;
}

export async function upsertCanonicalField(f: { name: string; description: string; sampleValues: string[] }): Promise<void> {
  const embedding = await embedOne(`canonical field ${f.name}: ${f.description}. samples: ${f.sampleValues.join(", ")}`, "document");
  await (await col.profiles()).updateOne(
    { docType: "canonical_field", fieldName: f.name },
    { $set: { docType: "canonical_field", system: "canonical", fieldName: f.name, description: f.description, sampleValues: f.sampleValues, embedding } },
    { upsert: true },
  );
}

/** Vector match a system field (name + description + samples) against our canonical fields. */
export async function matchCanonicalField(fieldText: string, k = 3): Promise<{ fieldName: string; description: string; score: number }[]> {
  const q = await embedOne(fieldText, "query");
  const rows = await vectorQuery(await col.profiles(), PROFILE_VECTOR_INDEX, q, { docType: "canonical_field" }, k, { embedding: 0, _id: 0 });
  return rows.map((r) => ({ fieldName: String(r.fieldName), description: String(r.description ?? ""), score: r.score }));
}
