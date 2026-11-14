import { Db, type Document } from "mongodb";
import { db } from "./database.js";
import { ensureSearchIndexes } from "./search.js";

type JsonSchema = Record<string, unknown>;
const str = { bsonType: "string" };
const date = { bsonType: "date" };
const bool = { bsonType: "bool" };
const num = { bsonType: ["int", "long", "double", "decimal"], minimum: 0 };
const intNum = { bsonType: ["int", "long"], minimum: 0 };
const obj = (properties: Record<string, unknown>, required: string[], _additionalProperties = false) => ({ bsonType: "object", required, properties, additionalProperties: false });
const arr = (items: unknown) => ({ bsonType: "array", items });
const enumString = (values: string[]) => ({ bsonType: "string", enum: values });
const profileValidator = {
  bsonType: "object",
  required: ["docType", "system", "version", "createdAt"],
  properties: {
    _id: { bsonType: ["objectId", "string"] }, docType: enumString(["profile", "field", "canonical_field"]), system: str,
    version: { bsonType: "int", minimum: 1 }, createdAt: date,
    fields: arr(obj({ name: str, type: str, required: bool, sampleValues: arr(str) }, ["name", "type", "required", "sampleValues"])),
    workflowSteps: arr(str), fieldName: str, description: str, sampleValues: arr(str),
    embedding: { bsonType: "array", minItems: 1024, maxItems: 1024, items: { bsonType: "double" } }
  },
  additionalProperties: false,
  oneOf: [
    { bsonType: "object", required: ["docType", "system", "version", "createdAt", "fields", "workflowSteps"], properties: { docType: { enum: ["profile"] } }, not: { anyOf: [{ required: ["fieldName"] }, { required: ["description"] }, { required: ["sampleValues"] }, { required: ["embedding"] }] } },
    { bsonType: "object", required: ["docType", "system", "version", "createdAt", "fieldName", "description", "sampleValues", "embedding"], properties: { docType: { enum: ["field"] } }, not: { anyOf: [{ required: ["fields"] }, { required: ["workflowSteps"] }] } },
    { bsonType: "object", required: ["docType", "system", "version", "createdAt", "fieldName", "description", "embedding"], properties: { docType: { enum: ["canonical_field"] } }, not: { anyOf: [{ required: ["fields"] }, { required: ["workflowSteps"] }, { required: ["sampleValues"] }] } }
  ]
};
const validators: Record<string, JsonSchema> = {
  claims: obj({ _id: { ...str, pattern: "^CLM-[A-Za-z0-9-]+$" }, claimant: obj({ name: str, phone: str, email: str, licenceNumber: str }, ["name"], true), parties: obj({ claimant: str, insurer: str, adjuster: str, bodyShop: str, rentalCompany: str, clinic: str }, ["claimant", "insurer"], true), vehicle: obj({ make: str, model: str, year: intNum, vin: str, licencePlate: str }, ["make", "model"], true), policy: obj({ number: str, insurer: str, rentalDailyLimit: num, rentalMaxDays: intNum }, ["number", "insurer", "rentalDailyLimit", "rentalMaxDays"]), phase: enumString(["intake", "opening", "active", "closing", "closed"]), compactSummary: { ...str, maxLength: 2000 }, money: obj({ totals: arr(obj({ category: str, billed: num, submitted: num, paid: num }, ["category", "billed", "submitted", "paid"])), items: arr(obj({ itemId: str, kind: enumString(["invoice", "estimate"]), category: str, billed: num, submitted: num, paid: num, reason: str }, ["itemId", "kind", "category", "billed", "submitted", "paid"], true)) }, ["totals", "items"]), createdAt: date, updatedAt: date }, ["_id", "claimant", "parties", "vehicle", "policy", "phase", "compactSummary", "money", "createdAt"], true),
  tasks: obj({ _id: { bsonType: ["objectId", "string"] }, claimId: str, taskId: str, type: str, track: enumString(["intake", "repair", "rental", "medical", "close"]), dependsOn: arr(str), status: enumString(["pending", "ready", "in_progress", "waiting", "blocked_drift", "awaiting_approval", "confirmed", "denied", "closed_by_human"]), history: arr(obj({ status: enumString(["pending", "ready", "in_progress", "waiting", "blocked_drift", "awaiting_approval", "confirmed", "denied", "closed_by_human"]), at: date, wallAt: date, by: str, note: str }, ["status", "at", "wallAt", "by"], true)), createdAt: date, updatedAt: date }, ["claimId", "taskId", "type", "track", "dependsOn", "status", "history"], true),
  actions: obj({ _id: { bsonType: ["objectId", "string"] }, claimId: str, taskId: str, system: enumString(["insurer", "body_shop", "rental", "clinic"]), kind: str, idempotencyKey: { ...str, minLength: 1 }, payload: { bsonType: "object" }, expectedEffect: { bsonType: "object" }, verifyBy: enumString(["readback", "webhook", "readback_or_webhook"]), status: enumString(["planned", "awaiting_approval", "approved", "sent", "acknowledged", "confirmed", "rejected", "failed", "cancelled", "closed_by_human"]), attempts: intNum, deadline: date, history: arr(obj({ status: enumString(["planned", "awaiting_approval", "approved", "sent", "acknowledged", "confirmed", "rejected", "failed", "cancelled", "closed_by_human"]), at: date, wallAt: date, by: str, note: str }, ["status", "at", "wallAt", "by", "note"], true)), supersedes: obj({ actionId: { bsonType: ["objectId", "string"] } }, ["actionId"]), createdAt: date }, ["claimId", "taskId", "system", "kind", "idempotencyKey", "payload", "expectedEffect", "verifyBy", "status", "attempts", "deadline", "history"], true),
  observations: obj({ _id: { bsonType: ["objectId", "string"] }, claimId: str, source: enumString(["insurer", "body_shop", "rental", "clinic", "claimant", "approval_ui", "phone", "system"]), kind: str, body: { oneOf: [{ bsonType: "string" }, { bsonType: "object" }] }, matchedActionId: { bsonType: ["objectId", "string"] }, verified: bool, trust: enumString(["known", "company_line", "unknown"]), receivedAt: date, processedAt: date }, ["claimId", "source", "kind", "body", "verified", "receivedAt"], true),
  timers: obj({ _id: { bsonType: ["objectId", "string"] }, claimId: str, taskId: str, rule: enumString(["verify_action", "chase_party", "rental_expiring", "payment_overdue", "claimant_reminder", "promise_check"]), dueAt: date, fired: bool, cancelled: bool, escalationLevel: intNum, createdAt: date }, ["claimId", "taskId", "rule", "dueAt", "fired", "cancelled", "escalationLevel"], true),
  leases: obj({ _id: str, workerId: str, expiresAt: date }, ["_id", "workerId", "expiresAt"]),
  approvals: obj({ _id: { bsonType: ["objectId", "string"] }, claimId: str, actionId: { bsonType: ["objectId", "string"] }, gate: enumString(["accept_settlement", "sign_release", "discuss_fault", "rental_overage", "drift_mapping", "unverified_after_retries"]), approverRole: enumString(["claimant", "operator"]), request: str, status: enumString(["pending", "approved", "declined"]), decidedBy: str, decidedAt: date, createdAt: date }, ["claimId", "actionId", "gate", "approverRole", "request", "status"], true),
  system_profiles: profileValidator,
  experiences: obj({ _id: { bsonType: ["objectId", "string"] }, problemType: enumString(["drift", "rejection", "crash", "caller_pattern"]), system: str, problem: str, fix: { bsonType: "object" }, outcome: str, embedding: { bsonType: "array", minItems: 1024, maxItems: 1024, items: { bsonType: "double" } }, createdAt: date }, ["problemType", "system", "problem", "fix", "outcome", "embedding", "createdAt"]),
  documents: obj({ _id: { bsonType: ["objectId", "string"] }, claimId: str, docType: enumString(["photo", "police_report", "estimate", "invoice", "call_transcript", "other"]), gridfsId: { bsonType: ["objectId", "string"] }, extractedText: str, source: str, createdAt: date }, ["claimId", "docType", "gridfsId", "extractedText", "source", "createdAt"]),
  "files.files": obj({ _id: { bsonType: "objectId" }, length: num, chunkSize: { bsonType: "int", minimum: 1 }, uploadDate: date, filename: str, contentType: str, aliases: arr(str), metadata: { bsonType: "object" } }, ["_id", "length", "chunkSize", "uploadDate", "filename"], true),
  "files.chunks": obj({ _id: { bsonType: "objectId" }, files_id: { bsonType: "objectId" }, n: intNum, data: { bsonType: "binData" } }, ["_id", "files_id", "n", "data"]),
  system_health: obj({ _id: { bsonType: ["objectId", "string"] }, ts: date, system: str, latencyMs: num, ok: bool, errorCode: str }, ["ts", "system", "latencyMs", "ok"], true),
  contacts: obj({ _id: { bsonType: ["objectId", "string"] }, phone: { bsonType: "string", pattern: "^\\+[1-9][0-9]{1,14}$" }, name: str, company: str, role: enumString(["adjuster", "body_shop", "rental_branch", "clinic", "claimant"]), claimIds: arr(str), trust: enumString(["known", "company_line", "unknown"]), isCompanyMainLine: bool }, ["phone", "name", "company", "role", "claimIds", "trust", "isCompanyMainLine"]),
  sim_clock: obj({ _id: { bsonType: "string", enum: ["clock"] }, simEpoch: date, wallEpoch: date, speed: { bsonType: ["int", "long", "double"], minimum: 0 }, paused: bool }, ["_id", "simEpoch", "wallEpoch", "speed", "paused"]),
  worker_state: obj({ _id: str, resumeToken: { bsonType: "object" }, updatedAt: date }, ["_id", "updatedAt"], true)
};

const indexSpecs: Record<string, Array<{ key: Document; options?: Document }>> = {
  claims: [{ key: { phase: 1, createdAt: -1 } }],
  tasks: [{ key: { claimId: 1, taskId: 1 }, options: { unique: true } }, { key: { claimId: 1, status: 1 } }],
  actions: [{ key: { idempotencyKey: 1 }, options: { unique: true } }, { key: { claimId: 1, taskId: 1, createdAt: -1 } }, { key: { status: 1, deadline: 1 } }],
  observations: [{ key: { claimId: 1, receivedAt: -1 } }, { key: { processedAt: 1 } }],
  timers: [{ key: { fired: 1, cancelled: 1, dueAt: 1 } }, { key: { claimId: 1, taskId: 1 } }],
  leases: [{ key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } }],
  approvals: [{ key: { claimId: 1, status: 1 } }, { key: { actionId: 1 } }],
  system_profiles: [{ key: { docType: 1, system: 1, version: -1 } }, { key: { docType: 1, system: 1, fieldName: 1 } }],
  experiences: [{ key: { problemType: 1, system: 1 } }],
  documents: [{ key: { claimId: 1, docType: 1, createdAt: -1 } }],
  "files.files": [{ key: { filename: 1, uploadDate: 1 } }],
  "files.chunks": [{ key: { files_id: 1, n: 1 }, options: { unique: true } }],
  system_health: [{ key: { system: 1, ts: -1 } }],
  contacts: [{ key: { phone: 1 }, options: { unique: true } }],
  worker_state: []
};

export const collectionNames = Object.keys(validators);

export async function setupDatabase(database: Db = db): Promise<void> {
  for (const [name, $jsonSchema] of Object.entries(validators)) {
    const exists = await database.listCollections({ name }, { nameOnly: true }).hasNext();
    if (!exists && name === "system_health") {
      try {
        await database.createCollection(name, { timeseries: { timeField: "ts", metaField: "system" }, validator: { $jsonSchema }, validationLevel: "strict", validationAction: "error" });
      } catch (error) {
        console.warn(`Time-series system_health unavailable; using a regular collection: ${error instanceof Error ? error.message : String(error)}`);
        await database.createCollection(name, { validator: { $jsonSchema }, validationLevel: "strict", validationAction: "error" });
      }
    } else if (!exists) {
      await database.createCollection(name, { validator: { $jsonSchema }, validationLevel: "strict", validationAction: "error" });
    } else {
      await database.command({ collMod: name, validator: { $jsonSchema }, validationLevel: "strict", validationAction: "error" });
    }
    for (const { key, options } of indexSpecs[name] ?? []) await database.collection(name).createIndex(key, options);
  }
  await ensureSearchIndexes().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/command not found|not supported|only supported on Atlas|unrecognized pipeline stage|no such command/i.test(message) && !/timed out|failed:/i.test(message)) {
      console.warn(`Atlas Search indexes skipped (this server does not provide Atlas Search): ${message}`);
      return;
    }
    throw error;
  });
}

export const validatorSchemas = validators;
