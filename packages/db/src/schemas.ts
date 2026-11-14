import { ObjectId } from "mongodb";
import { z } from "zod";

const idSchema = z.union([z.string(), z.instanceof(ObjectId)]);
const dateSchema = z.date();
const amountSchema = z.number().finite().nonnegative();

export const AccidentSchema = z.object({
  date: z.string(), place: z.string(), description: z.string(), policeReportNumber: z.string().nullable().optional(), injuries: z.boolean(),
  mentionsFault: z.boolean().optional(), faultStatement: z.string().nullable().optional(),
  otherDriver: z.object({ name: z.string().nullable(), plate: z.string().nullable(), insurer: z.string().nullable() }).strict().nullable().optional()
}).strict();
export type Accident = z.infer<typeof AccidentSchema>;

export const ClaimPhaseSchema = z.enum(["intake", "opening", "active", "closing", "closed"]);
export const ClaimSchema = z.object({
  _id: z.string().regex(/^CLM-[A-Za-z0-9-]+$/),
  claimant: z.object({ name: z.string(), firstName: z.string().optional(), phone: z.string().optional(), email: z.string().optional(), licenceNumber: z.string().optional() }).strict(),
  parties: z.object({ claimant: z.string(), insurer: z.string(), adjuster: z.string().optional(), bodyShop: z.string().optional(), rentalCompany: z.string().optional(), clinic: z.string().optional() }).strict(),
  vehicle: z.object({ make: z.string(), model: z.string(), year: z.number().int().nonnegative().optional(), vin: z.string().optional(), licencePlate: z.string().optional() }).strict(),
  policy: z.object({ number: z.string(), insurer: z.string(), rentalDailyLimit: amountSchema, rentalMaxDays: z.number().int().nonnegative(), deductible: amountSchema.optional() }).strict(),
  /** Agent additions (all optional): accident details from intake (T1), external system references, working facts. */
  accident: AccidentSchema.optional(),
  external: z.record(z.string(), z.unknown()).optional(),
  facts: z.record(z.string(), z.unknown()).optional(),
  closedAt: dateSchema.optional(),
  phase: ClaimPhaseSchema,
  compactSummary: z.string().max(2000),
  money: z.object({
    totals: z.array(z.object({ category: z.string(), billed: amountSchema, submitted: amountSchema, paid: amountSchema }).strict()),
    items: z.array(z.object({ itemId: z.string(), kind: z.enum(["invoice", "estimate"]), category: z.string(), billed: amountSchema, submitted: amountSchema, paid: amountSchema, reason: z.string().optional() }).strict()).default([])
  }).strict(),
  createdAt: dateSchema,
  updatedAt: dateSchema.optional()
}).strict();
export type Claim = z.infer<typeof ClaimSchema>;

export const TaskStatusSchema = z.enum(["pending", "ready", "in_progress", "waiting", "blocked_drift", "awaiting_approval", "confirmed", "denied", "closed_by_human"]);
export const TaskSchema = z.object({
  _id: idSchema.optional(), claimId: z.string(), taskId: z.string(), type: z.string(), track: z.enum(["intake", "repair", "rental", "medical", "close"]), dependsOn: z.array(z.string()), status: TaskStatusSchema,
  title: z.string().optional(), isWait: z.boolean().optional(), params: z.record(z.string(), z.unknown()).optional(), trigger: z.string().optional(), triggeredAt: dateSchema.nullable().optional(),
  history: z.array(z.object({ status: TaskStatusSchema, at: dateSchema, wallAt: dateSchema, by: z.string(), note: z.string().optional() }).strict()),
  createdAt: dateSchema.optional(), updatedAt: dateSchema.optional()
}).strict();
export type Task = z.infer<typeof TaskSchema>;

export const ActionStatusSchema = z.enum(["planned", "awaiting_approval", "approved", "sent", "acknowledged", "confirmed", "rejected", "failed", "cancelled", "closed_by_human"]);
export const ActionHistorySchema = z.object({ status: ActionStatusSchema, at: dateSchema, wallAt: dateSchema, by: z.string(), note: z.string() }).strict();
export const ActionSchema = z.object({
  _id: idSchema.optional(), claimId: z.string(), taskId: z.string(), system: z.enum(["insurer", "body_shop", "rental", "clinic"]), kind: z.string(), idempotencyKey: z.string().min(1), payload: z.record(z.string(), z.unknown()), expectedEffect: z.record(z.string(), z.unknown()), verifyBy: z.enum(["readback", "webhook", "readback_or_webhook"]), status: ActionStatusSchema, attempts: z.number().int().nonnegative(), deadline: dateSchema, history: z.array(ActionHistorySchema), supersedes: z.object({ actionId: idSchema }).strict().optional(), createdAt: dateSchema.optional(),
  gate: z.lazy(() => ApprovalGateSchema).optional(), approvalId: z.string().optional(), response: z.unknown().optional(), readback: z.unknown().optional(), lastError: z.string().nullable().optional(), verifyAfter: dateSchema.nullable().optional(), profileVersion: z.number().int().nullable().optional(), updatedAt: dateSchema.optional()
}).strict();
export type Action = z.infer<typeof ActionSchema>;

export const ObservationSchema = z.object({ _id: idSchema.optional(), claimId: z.string(), source: z.enum(["insurer", "body_shop", "rental", "clinic", "claimant", "approval_ui", "phone", "system"]), kind: z.string(), body: z.union([z.string(), z.record(z.string(), z.unknown())]), matchedActionId: idSchema.optional(), verified: z.boolean(), trust: z.enum(["known", "company_line", "unknown"]).optional(), receivedAt: dateSchema, processedAt: dateSchema.optional(), receivedWallAt: dateSchema.optional(), processedBy: z.string().optional(), note: z.string().optional() }).strict();
export type Observation = z.infer<typeof ObservationSchema>;

export const TimerRuleSchema = z.enum(["verify_action", "chase_party", "rental_expiring", "payment_overdue", "claimant_reminder", "promise_check"]);
export const TimerSchema = z.object({ _id: idSchema.optional(), claimId: z.string(), taskId: z.string(), rule: TimerRuleSchema, dueAt: dateSchema, fired: z.boolean(), cancelled: z.boolean(), escalationLevel: z.number().int().nonnegative(), createdAt: dateSchema.optional(), actionId: z.string().optional(), approvalId: z.string().optional(), params: z.record(z.string(), z.unknown()).optional(), firedAt: dateSchema.optional() }).strict();
export type Timer = z.infer<typeof TimerSchema>;

export const LeaseSchema = z.object({ _id: z.string(), workerId: z.string(), expiresAt: dateSchema }).strict();
export type Lease = z.infer<typeof LeaseSchema>;
/** The doc's six gates, plus three approval kinds the doc describes: a phone decision for the claimant, an unexplained reconciliation gap, and an LLM answer that needs a human. */
export const ApprovalGateSchema = z.enum(["accept_settlement", "sign_release", "discuss_fault", "rental_overage", "drift_mapping", "unverified_after_retries", "decision_request", "reconciliation_gap", "llm_review"]);
export const ApprovalSchema = z.object({ _id: idSchema.optional(), claimId: z.string(), actionId: idSchema.optional(), gate: ApprovalGateSchema, approverRole: z.enum(["claimant", "operator"]), request: z.string(), status: z.enum(["pending", "approved", "declined"]), decidedBy: z.string().optional(), decidedAt: dateSchema.optional(), createdAt: dateSchema.optional(), taskId: z.string().optional(), details: z.record(z.string(), z.unknown()).optional(), decisionNote: z.string().optional() }).strict();
export type Approval = z.infer<typeof ApprovalSchema>;

export const ProfileFieldSchema = z.object({ name: z.string(), type: z.string(), required: z.boolean(), sampleValues: z.array(z.string()), endpoint: z.string().optional(), description: z.string().optional() }).strict();
export type ProfileField = z.infer<typeof ProfileFieldSchema>;
const profileBase = { _id: idSchema.optional(), docType: z.enum(["profile", "field", "canonical_field"]), system: z.string(), version: z.number().int().positive(), createdAt: dateSchema };
export const SystemProfileSchema = z.discriminatedUnion("docType", [
  z.object({ ...profileBase, docType: z.literal("profile"), fields: z.array(ProfileFieldSchema), workflowSteps: z.array(z.string()), fieldMap: z.record(z.string(), z.string()).optional(), source: z.string().optional() }).strict(),
  z.object({ ...profileBase, docType: z.literal("field"), fieldName: z.string(), description: z.string(), sampleValues: z.array(z.string()), embedding: z.array(z.number()).length(1024) }).strict(),
  z.object({ ...profileBase, docType: z.literal("canonical_field"), fieldName: z.string(), description: z.string(), embedding: z.array(z.number()).length(1024) }).strict()
]);
export type SystemProfile = z.infer<typeof SystemProfileSchema>;
export const ExperienceSchema = z.object({ _id: idSchema.optional(), problemType: z.enum(["drift", "rejection", "crash", "caller_pattern"]), system: z.string(), problem: z.string(), fix: z.record(z.string(), z.unknown()), outcome: z.string(), embedding: z.array(z.number()).length(1024), createdAt: dateSchema, claimId: z.string().optional() }).strict();
export type Experience = z.infer<typeof ExperienceSchema>;

export const DocumentMetadataSchema = z.object({ _id: idSchema.optional(), claimId: z.string(), docType: z.enum(["photo", "police_report", "estimate", "invoice", "call_transcript", "other"]), gridfsId: idSchema, extractedText: z.string(), source: z.string(), createdAt: dateSchema }).strict();
export type DocumentMetadata = z.infer<typeof DocumentMetadataSchema>;
export const GridFSFileSchema = z.object({ _id: z.instanceof(ObjectId), length: z.number().finite().nonnegative(), chunkSize: z.number().int().positive(), uploadDate: dateSchema, filename: z.string(), contentType: z.string().optional(), aliases: z.array(z.string()).optional(), metadata: z.record(z.string(), z.unknown()).optional() }).strict();
export type GridFSFile = z.infer<typeof GridFSFileSchema>;
export const GridFSChunkSchema = z.object({ _id: z.instanceof(ObjectId), files_id: z.instanceof(ObjectId), n: z.number().int().nonnegative(), data: z.instanceof(Buffer) }).strict();
export type GridFSChunk = z.infer<typeof GridFSChunkSchema>;
export const SystemHealthSchema = z.object({ _id: idSchema.optional(), ts: dateSchema, system: z.string(), latencyMs: z.number().nonnegative(), ok: z.boolean(), errorCode: z.string().optional() }).strict();
export type SystemHealth = z.infer<typeof SystemHealthSchema>;
export const ContactSchema = z.object({ _id: idSchema.optional(), phone: z.string().regex(/^\+[1-9]\d{1,14}$/), name: z.string(), company: z.string(), role: z.enum(["adjuster", "body_shop", "rental_branch", "clinic", "claimant"]), claimIds: z.array(z.string()), trust: z.enum(["known", "company_line", "unknown"]), isCompanyMainLine: z.boolean() }).strict();
export type Contact = z.infer<typeof ContactSchema>;
export const SimClockSchema = z.object({ _id: z.literal("clock"), simEpoch: dateSchema, wallEpoch: dateSchema, speed: z.number().nonnegative(), paused: z.boolean() }).strict();
export type SimClock = z.infer<typeof SimClockSchema>;
export const WorkerStateSchema = z.object({ _id: z.string(), resumeToken: z.record(z.string(), z.unknown()).optional(), updatedAt: dateSchema, heartbeatAt: dateSchema.optional(), pid: z.number().int().optional(), held: z.array(z.string()).optional(), replayed: z.number().int().optional(), startedAt: dateSchema.optional() }).strict();
export type WorkerState = z.infer<typeof WorkerStateSchema>;

export const CounterSchema = z.object({ _id: z.string(), seq: z.number().int().nonnegative() }).strict();
export type Counter = z.infer<typeof CounterSchema>;
