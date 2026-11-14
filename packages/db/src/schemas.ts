import { z } from "zod";

/* ------------------------------------------------------------------ enums */

export const SYSTEMS = ["insurer", "body_shop", "rental", "clinic", "claimant", "internal"] as const;
export type SystemName = (typeof SYSTEMS)[number];
export const OUTSIDE_SYSTEMS = ["insurer", "body_shop", "rental", "clinic"] as const;
export type OutsideSystem = (typeof OUTSIDE_SYSTEMS)[number];

export const TASK_STATUSES = [
  "pending",
  "ready",
  "in_progress",
  "waiting",
  "blocked_drift",
  "awaiting_approval",
  "confirmed",
  "denied",
  "closed_by_human",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_RESOLVED: readonly TaskStatus[] = ["confirmed", "denied", "closed_by_human"];

export const TRACKS = ["intake", "repair", "rental", "medical", "close"] as const;

export const ACTION_STATUSES = [
  "planned",
  "awaiting_approval",
  "approved",
  "sent",
  "acknowledged",
  "confirmed",
  "rejected",
  "failed",
  "cancelled",
  "closed_by_human",
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];
export const ACTION_TERMINAL: readonly ActionStatus[] = ["confirmed", "rejected", "failed", "cancelled", "closed_by_human"];

export const VERIFY_BY = ["readback", "webhook", "webhook_or_readback", "schema"] as const;

export const OBS_SOURCES = ["insurer", "body_shop", "rental", "clinic", "claimant", "approval_ui", "phone", "system"] as const;
export const TRUST = ["known", "company_line", "unknown"] as const;

export const TIMER_RULES = [
  "verify_action",
  "chase_party",
  "rental_expiring",
  "payment_overdue",
  "claimant_reminder",
  "promise_check",
] as const;
export type TimerRule = (typeof TIMER_RULES)[number];

/**
 * The doc's six gates, plus three approval kinds the doc describes but doesn't list as gates:
 * a phone "decision request" for the claimant, a reconciliation gap handed to an operator (T18),
 * and an LLM result that was malformed/refused/low-confidence ("goes to a human instead of the database").
 */
export const GATES = [
  "settlement_acceptance",
  "sign_release",
  "fault_statement",
  "rental_beyond_coverage",
  "low_confidence_drift",
  "unverified_after_retries",
  "decision_request",
  "reconciliation_gap",
  "llm_review",
] as const;
export type Gate = (typeof GATES)[number];

export const CONTACT_ROLES = ["adjuster", "body_shop", "rental_branch", "clinic", "claimant"] as const;
export const DOC_TYPES = ["photo", "police_report", "estimate_pdf", "invoice", "call_transcript", "release", "other"] as const;
export const PROBLEM_TYPES = ["drift", "rejection", "crash", "caller_pattern", "ghost_booking"] as const;

/* ---------------------------------------------------------------- helpers */

const date = z.date();
const historyEntry = z.object({
  status: z.string(),
  at: date, // simulated time
  wallAt: date,
  by: z.string(),
  note: z.string().optional(),
});
export type HistoryEntry = z.infer<typeof historyEntry>;

/* ------------------------------------------------------------ collections */

export const MoneyItem = z.object({
  ref: z.string(), // e.g. "estimate:EST-1", "invoice:INV-3", "rental:RES-9"
  category: z.enum(["repair", "rental", "medical"]),
  billed: z.number(),
  submitted: z.number(),
  paid: z.number(),
  gapReason: z.string().nullable().optional(),
});
export type MoneyItem = z.infer<typeof MoneyItem>;

const moneyCat = z.object({ billed: z.number(), submitted: z.number(), paid: z.number() });
export const MoneyTotals = z.object({ repair: moneyCat, rental: moneyCat, medical: moneyCat });

export const Claim = z.object({
  _id: z.string().regex(/^CLM-\d+$/),
  claimant: z.object({
    name: z.string(),
    firstName: z.string(),
    phone: z.string(),
    email: z.string().nullable().optional(),
  }),
  parties: z
    .object({
      otherDriver: z
        .object({ name: z.string().nullable(), plate: z.string().nullable(), insurer: z.string().nullable() })
        .nullable(),
    })
    .default({ otherDriver: null }),
  vehicle: z.object({
    vin: z.string(),
    make: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    year: z.number().nullable().optional(),
    plate: z.string().nullable().optional(),
  }),
  policy: z.object({
    number: z.string(),
    insurer: z.string(),
    rentalDailyLimit: z.number().nullable(),
    rentalMaxDays: z.number().nullable(),
    deductible: z.number().nullable().optional(),
  }),
  accident: z.object({
    date: z.string(),
    place: z.string(),
    description: z.string(),
    policeReportNumber: z.string().nullable(),
    injuries: z.boolean(),
    mentionsFault: z.boolean().optional(),
  }),
  phase: z.enum(["intake", "open", "in_progress", "closing", "closed"]),
  compactSummary: z.string().max(2000),
  money: z.object({ items: z.array(MoneyItem), totals: MoneyTotals }),
  external: z.record(z.string(), z.unknown()).default({}),
  facts: z.record(z.string(), z.unknown()).default({}),
  createdAt: date,
  createdWallAt: date,
  closedAt: date.nullable().optional(),
});
export type Claim = z.infer<typeof Claim>;

export const Task = z.object({
  claimId: z.string(),
  taskId: z.string(), // T1..T18, T13#INV-1, T14#INV-1, plus inserted ids like T9a#photos
  type: z.string(),
  title: z.string(),
  track: z.enum(TRACKS),
  dependsOn: z.array(z.string()),
  status: z.enum(TASK_STATUSES),
  isWait: z.boolean().default(false),
  /** Free-form planner parameters (e.g. invoiceId for T13 copies, the step for inserted drift tasks). */
  params: z.record(z.string(), z.unknown()).default({}),
  /** e.g. T12 only acts after a `rental_expiring` timer fires. */
  trigger: z.string().nullable().optional(),
  triggeredAt: date.nullable().optional(),
  history: z.array(historyEntry),
  createdAt: date,
  updatedAt: date,
});
export type Task = z.infer<typeof Task>;

export const Action = z.object({
  claimId: z.string(),
  taskId: z.string(),
  system: z.enum(SYSTEMS),
  kind: z.string(),
  idempotencyKey: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  expectedEffect: z.record(z.string(), z.unknown()),
  verifyBy: z.enum(VERIFY_BY),
  status: z.enum(ACTION_STATUSES),
  attempts: z.number().int(),
  deadline: date,
  gate: z.enum(GATES).nullable().optional(),
  approvalId: z.string().nullable().optional(),
  supersedes: z.string().nullable().optional(),
  response: z.unknown().optional(),
  readback: z.unknown().optional(),
  lastError: z.string().nullable().optional(),
  verifyAfter: date.nullable().optional(),
  profileVersion: z.number().nullable().optional(),
  history: z.array(historyEntry),
  createdAt: date,
  updatedAt: date,
});
export type Action = z.infer<typeof Action>;

export const Observation = z.object({
  claimId: z.string(),
  source: z.enum(OBS_SOURCES),
  kind: z.string(),
  body: z.record(z.string(), z.unknown()),
  matchedActionId: z.string().nullable().optional(),
  verified: z.boolean().nullable().optional(),
  trust: z.enum(TRUST).nullable().optional(),
  receivedAt: date, // simulated
  receivedWallAt: date,
  processedAt: date.nullable().optional(),
  processedBy: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});
export type Observation = z.infer<typeof Observation>;

export const Timer = z.object({
  claimId: z.string(),
  taskId: z.string(),
  rule: z.enum(TIMER_RULES),
  dueAt: date,
  fired: z.boolean(),
  cancelled: z.boolean(),
  escalationLevel: z.number().int(),
  actionId: z.string().nullable().optional(),
  approvalId: z.string().nullable().optional(),
  params: z.record(z.string(), z.unknown()).default({}),
  createdAt: date,
  firedAt: date.nullable().optional(),
});
export type Timer = z.infer<typeof Timer>;

export const Lease = z.object({ _id: z.string(), workerId: z.string(), expiresAt: date, acquiredAt: date });
export type Lease = z.infer<typeof Lease>;

export const Approval = z.object({
  claimId: z.string(),
  actionId: z.string().nullable(),
  taskId: z.string().nullable().optional(),
  gate: z.enum(GATES),
  approverRole: z.enum(["claimant", "operator"]),
  request: z.string(),
  details: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(["pending", "approved", "declined"]),
  decidedBy: z.string().nullable().optional(),
  decidedAt: date.nullable().optional(),
  decisionNote: z.string().nullable().optional(),
  createdAt: date,
});
export type Approval = z.infer<typeof Approval>;

export const ProfileField = z.object({
  name: z.string(),
  type: z.string(),
  required: z.boolean(),
  endpoint: z.string().optional(),
  description: z.string().optional(),
  sampleValues: z.array(z.string()).default([]),
});
export type ProfileField = z.infer<typeof ProfileField>;

export const SystemProfile = z.object({
  docType: z.literal("profile"),
  system: z.enum(OUTSIDE_SYSTEMS),
  version: z.number().int(),
  fields: z.array(ProfileField),
  workflowSteps: z.array(z.string()),
  /** canonical field name -> the system's current name for it */
  fieldMap: z.record(z.string(), z.string()).default({}),
  source: z.string().optional(),
  createdAt: date,
});
export type SystemProfile = z.infer<typeof SystemProfile>;

export const Experience = z.object({
  problemType: z.enum(PROBLEM_TYPES),
  system: z.string(),
  problem: z.string(),
  fix: z.record(z.string(), z.unknown()),
  outcome: z.string(),
  claimId: z.string().nullable().optional(),
  embedding: z.array(z.number()),
  createdAt: date,
});
export type Experience = z.infer<typeof Experience>;

export const DocumentMeta = z.object({
  claimId: z.string(),
  docType: z.enum(DOC_TYPES),
  gridfsId: z.unknown().nullable(),
  filename: z.string().nullable().optional(),
  contentType: z.string().nullable().optional(),
  extractedText: z.string().default(""),
  source: z.string(),
  meta: z.record(z.string(), z.unknown()).default({}),
  createdAt: date,
});
export type DocumentMeta = z.infer<typeof DocumentMeta>;

export const HealthSample = z.object({
  ts: date,
  system: z.string(),
  latencyMs: z.number(),
  ok: z.boolean(),
  errorCode: z.string().nullable().optional(),
  endpoint: z.string().optional(),
});
export type HealthSample = z.infer<typeof HealthSample>;

export const Contact = z.object({
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/),
  name: z.string(),
  company: z.string().nullable(),
  role: z.enum(CONTACT_ROLES),
  claimIds: z.array(z.string()),
  trust: z.enum(TRUST),
  isCompanyMainLine: z.boolean(),
});
export type Contact = z.infer<typeof Contact>;

export const SimClock = z.object({
  _id: z.literal("clock"),
  simEpoch: z.number(),
  wallEpoch: z.number(),
  speed: z.number(),
  paused: z.boolean(),
});
export type SimClock = z.infer<typeof SimClock>;

/* -------------------------------------------- $jsonSchema validators */

const str = { bsonType: "string" };
const dt = { bsonType: "date" };
const obj = { bsonType: "object" };
const enumOf = (v: readonly string[]) => ({ enum: [...v] });

export const validators: Record<string, Record<string, unknown>> = {
  claims: {
    bsonType: "object",
    required: ["_id", "claimant", "vehicle", "policy", "accident", "phase", "compactSummary", "money", "createdAt"],
    properties: {
      _id: { bsonType: "string", pattern: "^CLM-[0-9]+$" },
      phase: enumOf(["intake", "open", "in_progress", "closing", "closed"]),
      compactSummary: { bsonType: "string", maxLength: 2000 },
      money: { bsonType: "object", required: ["items", "totals"] },
      policy: { bsonType: "object", required: ["number", "insurer"] },
      createdAt: dt,
    },
  },
  tasks: {
    bsonType: "object",
    required: ["claimId", "taskId", "type", "track", "dependsOn", "status", "history"],
    properties: {
      claimId: str,
      taskId: str,
      track: enumOf(TRACKS),
      dependsOn: { bsonType: "array", items: str },
      status: enumOf(TASK_STATUSES),
      history: { bsonType: "array" },
    },
  },
  actions: {
    bsonType: "object",
    required: ["claimId", "taskId", "system", "kind", "idempotencyKey", "payload", "expectedEffect", "verifyBy", "status", "attempts", "deadline", "history"],
    properties: {
      claimId: str,
      taskId: str,
      system: enumOf(SYSTEMS),
      kind: str,
      idempotencyKey: { bsonType: "string", minLength: 1 },
      payload: obj,
      expectedEffect: { bsonType: "object", minProperties: 1 },
      verifyBy: enumOf(VERIFY_BY),
      status: enumOf(ACTION_STATUSES),
      attempts: { bsonType: ["int", "long", "double"] },
      deadline: dt,
      history: { bsonType: "array" },
    },
  },
  observations: {
    bsonType: "object",
    required: ["claimId", "source", "kind", "body", "receivedAt"],
    properties: { claimId: str, source: enumOf(OBS_SOURCES), kind: str, body: obj, receivedAt: dt },
  },
  timers: {
    bsonType: "object",
    required: ["claimId", "taskId", "rule", "dueAt", "fired", "cancelled", "escalationLevel"],
    properties: { rule: enumOf(TIMER_RULES), dueAt: dt, fired: { bsonType: "bool" }, cancelled: { bsonType: "bool" } },
  },
  leases: {
    bsonType: "object",
    required: ["_id", "workerId", "expiresAt"],
    properties: { workerId: str, expiresAt: dt },
  },
  approvals: {
    bsonType: "object",
    required: ["claimId", "gate", "approverRole", "request", "status", "createdAt"],
    properties: {
      gate: enumOf(GATES),
      approverRole: enumOf(["claimant", "operator"]),
      status: enumOf(["pending", "approved", "declined"]),
    },
  },
  system_profiles: {
    bsonType: "object",
    required: ["docType", "system"],
    properties: { docType: enumOf(["profile", "field", "canonical_field"]) },
  },
  experiences: {
    bsonType: "object",
    required: ["problemType", "system", "problem", "fix", "outcome", "embedding"],
    properties: { problemType: enumOf(PROBLEM_TYPES), embedding: { bsonType: "array" } },
  },
  documents: {
    bsonType: "object",
    required: ["claimId", "docType", "source"],
    properties: { docType: enumOf(DOC_TYPES) },
  },
  contacts: {
    bsonType: "object",
    required: ["phone", "name", "role", "claimIds", "trust", "isCompanyMainLine"],
    properties: {
      phone: { bsonType: "string", pattern: "^\\+[1-9][0-9]{6,14}$" },
      role: enumOf(CONTACT_ROLES),
      trust: enumOf(TRUST),
    },
  },
};
