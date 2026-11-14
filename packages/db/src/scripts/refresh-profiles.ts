import type { Document } from "mongodb";
import { client, closeDatabase, collection } from "../database.js";
import { embed } from "../search.js";
import { SystemProfileSchema } from "../schemas.js";
import { V1_SYSTEM_SPECS, specToProfileFields, type SystemSpec } from "../systemSpecs.js";

/**
 * Rewrite the v1 `system_profiles` docs from systemSpecs.ts (the API descriptions the mock systems
 * serve at GET /<system>/describe), removing any later drift versions. Canonical fields are untouched.
 * Per-field embedding docs are rebuilt only when embeddings are available (VOYAGE_API_KEY);
 * otherwise the existing field docs are left as they are and the script says so.
 */
try {
  await client.connect();
  const profiles = collection("system_profiles");
  const now = new Date();
  const specs = Object.values(V1_SYSTEM_SPECS) as SystemSpec[];
  for (const spec of specs) {
    const doc = SystemProfileSchema.parse({ docType: "profile", system: spec.system, version: 1, fields: specToProfileFields(spec), workflowSteps: spec.workflowSteps, fieldMap: {}, source: "systemSpecs:v1", createdAt: now });
    await profiles.deleteMany({ docType: "profile", system: spec.system });
    await profiles.insertOne(doc as unknown as Document);
    console.log(`profile ${spec.system} v1: ${specToProfileFields(spec).length} fields, steps ${spec.workflowSteps.join(" > ")}`);
  }
  const canEmbed = !!process.env.VOYAGE_API_KEY || process.env.ALLOW_LOCAL_EMBEDDINGS === "1";
  if (!canEmbed) {
    console.log("field docs: NOT rebuilt (no VOYAGE_API_KEY). Existing field docs kept; rerun with a key to rebuild them.");
  } else {
    const fields = specs.flatMap((spec) => specToProfileFields(spec).map((f) => ({ system: spec.system, f })));
    const vectors = await embed(fields.map(({ f }) => `${f.endpoint}.${f.name}: ${f.type}. ${f.description ?? ""} Samples: ${f.sampleValues.join(", ")}`), "document");
    await profiles.deleteMany({ docType: "field", system: { $in: specs.map((s) => s.system) } });
    await profiles.insertMany(fields.map(({ system, f }, i) => SystemProfileSchema.parse({ docType: "field", system, version: 1, fieldName: f.name, description: `${f.endpoint} ${f.description ?? ""} (${f.type}${f.required ? ", required" : ""})`, sampleValues: f.sampleValues, embedding: vectors[i]!, createdAt: now }) as unknown as Document));
    console.log(`field docs: rebuilt ${fields.length}`);
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
