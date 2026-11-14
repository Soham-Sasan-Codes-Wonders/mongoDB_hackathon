import type { Document } from "mongodb";
import { collection } from "./database.js";
import { embed } from "./search.js";
import { SystemProfileSchema, type SystemProfile } from "./schemas.js";

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
