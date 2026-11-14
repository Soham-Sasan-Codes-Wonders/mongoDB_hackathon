import type { Document } from "mongodb";
import { collection } from "./database.js";
import { embed } from "./search.js";
import { SystemProfileSchema, type ProfileField, type SystemProfile } from "./schemas.js";

export async function saveSystemProfile(profile: Omit<Extract<SystemProfile, { docType: "profile" }>, "_id">): Promise<string> {
  const result = await collection("system_profiles").insertOne(SystemProfileSchema.parse(profile) as unknown as Document);
  return result.insertedId.toString();
}
export async function saveProfileFields(system: string, version: number, fields: Array<{ fieldName: string; description: string; sampleValues: string[] }>): Promise<number> {
  const vectors = await embed(fields.map((field) => `${field.fieldName}: ${field.description}. Examples: ${field.sampleValues.join(", ")}`), "document");
  if (fields.length === 0) return 0;
  const docs = fields.map((field, i) => ({ docType: "field", system, version, ...field, embedding: vectors[i]!, createdAt: new Date() }));
  await collection("system_profiles").insertMany(docs);
  return docs.length;
}
export async function saveCanonicalFields(fields: Array<{ fieldName: string; description: string }>): Promise<number> {
  const vectors = await embed(fields.map((field) => `${field.fieldName}: ${field.description}`), "document");
  if (fields.length === 0) return 0;
  const docs = fields.map((field) => ({ docType: "canonical_field", system: "internal", version: 1, ...field, embedding: vectors[fields.indexOf(field)]!, createdAt: new Date() }));
  await collection("system_profiles").insertMany(docs, { ordered: false });
  return docs.length;
}
export async function latestSystemProfile(system: string): Promise<Document | null> {
  return collection("system_profiles").find({ docType: "profile", system }).sort({ version: -1 }).limit(1).next();
}

/* ---------------------------------------------------------------- agent additions */

type ProfileDoc = Extract<SystemProfile, { docType: "profile" }>;

/** Latest `docType: "profile"` version for a system, typed. */
export async function getLatestProfile(system: string): Promise<ProfileDoc | null> {
  return (await latestSystemProfile(system)) as ProfileDoc | null;
}

/** Save the next profile version (latest + 1) plus one embedded `field` doc per field. Returns the version. */
export async function saveProfileVersion(p: { system: string; fields: ProfileField[]; workflowSteps: string[]; fieldMap?: Record<string, string>; source?: string }): Promise<number> {
  const latest = await getLatestProfile(p.system);
  const version = (latest?.version ?? 0) + 1;
  const fieldMap = p.fieldMap ?? latest?.fieldMap;
  await saveSystemProfile({ docType: "profile", system: p.system, version, fields: p.fields, workflowSteps: p.workflowSteps, ...(fieldMap ? { fieldMap } : {}), ...(p.source ? { source: p.source } : {}), createdAt: new Date() });
  await saveProfileFields(p.system, version, p.fields.map((f) => ({ fieldName: f.name, description: `${f.endpoint ?? ""} ${f.description ?? ""} (${f.type}${f.required ? ", required" : ""})`.trim(), sampleValues: f.sampleValues })));
  return version;
}
