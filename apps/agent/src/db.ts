/**
 * The agent's view of `@claim-coordinator/db`. This file contains NO driver calls: every function
 * delegates to the shared package and only translates names/shapes for the agent's call sites
 * (sim time from the cached clock, omitting nulls the strict schemas reject, gate→approver role).
 * Anything that touches MongoDB lives in packages/db.
 */
import * as db from "@claim-coordinator/db";
import type { ObjectId, ResumeToken } from "mongodb";

/** A claim as the agent reads it: the optional agent sections are always present (defaults filled in). */
export type Claim = db.Claim & { accident: db.Accident; external: Record<string, unknown>; facts: Record<string, unknown> };
/** A task as the agent reads it: title and params always present. */
export type TaskDoc = db.Task & { title: string; params: Record<string, unknown> };
export type ActionDoc = db.ActionDoc;
/** Agent observations always carry an object body. */
export type ObservationDoc = Omit<db.ObservationDoc, "body"> & { body: Record<string, unknown> };
export type ApprovalDoc = db.ApprovalDoc;
export type TimerDoc = db.TimerDoc;
export type Gate = db.Approval["gate"];
export type TaskStatus = db.Task["status"];
export type ActionStatus = db.Action["status"];
export type TimerRule = db.Timer["rule"];
export type OutsideSystem = db.OutsideSystem;
export type SystemSpec = db.SystemSpec;
export type ProfileField = db.ProfileField;
export const { V1_SYSTEM_SPECS, specToProfileFields, mintIdempotencyKey, canTransition, ACTION_TRANSITIONS, readyFrom, GATE_APPROVER } = db;
export const ACTION_STATUSES = db.ActionStatusSchema.options;

const EMPTY_ACCIDENT: db.Accident = { date: "", place: "", description: "", policeReportNumber: null, injuries: false };
function normClaim(c: db.Claim | null): Claim | null {
  return c ? { ...c, accident: c.accident ?? EMPTY_ACCIDENT, external: c.external ?? {}, facts: c.facts ?? {} } : null;
}
function normTask<T extends db.Task | null>(t: T): T extends null ? TaskDoc | null : TaskDoc {
  return (t ? { ...t, title: t.title ?? t.taskId, params: t.params ?? {} } : null) as never;
}
const normTasks = (ts: db.Task[]) => ts.map((t) => normTask(t));
const normObs = (o: db.ObservationDoc) => ({ ...o, body: typeof o.body === "string" ? { text: o.body } : o.body }) as ObservationDoc;

/** Drop undefined (and, when asked, null) values: the shared schemas are strict. */
function clean<T extends Record<string, unknown>>(o: T, dropNull = true): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(dropNull && v === null))) as Partial<T>;
}

/* ------------------------------------------------------------------ clock */

const DAY = 86_400_000;
const HOUR = 3_600_000;
export const clock = {
  DAY,
  HOUR,
  initClock: () => db.initClockCache(),
  now: () => db.nowSync(),
  nowMs: () => db.nowSync().getTime(),
  refresh: () => db.refreshClock(),
  async advance(ms: number) {
    await db.advance(ms);
    await db.refreshClock();
    return db.nowSync();
  },
  async setSpeed(speed: number) {
    await db.setSpeed(speed);
    await db.refreshClock();
  },
  resetClock: () => db.resetClock(),
  simToWallMs: (ms: number) => db.simToWallMs(ms),
  claimDay: (since: Date, at: Date = db.nowSync()) => Math.floor((at.getTime() - since.getTime()) / DAY),
};

/* ----------------------------------------------------------------- claims */

export interface MoneyGap {
  ref: string;
  category: string;
  billed: number;
  submitted: number;
  paid: number;
  gapReason: string | null;
  explained: boolean;
}

export const claims = {
  getClaim: async (id: string) => normClaim(await db.getClaim(id)),
  nextClaimId: () => db.nextClaimId(),
  listActiveClaimIds: () => db.listActiveClaimIds(),
  createClaimWithTasks: (c: db.Claim, t: db.Task[]) => db.createClaimWithTasks(c, t),
  /** `$set` with dot paths. Undefined values are dropped; nulls are dropped under policy./claimant./vehicle. (typed fields). */
  updateClaim(id: string, set: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(set)) {
      if (v === undefined) continue;
      if (v === null && /^(policy|claimant|vehicle|parties)\./.test(k)) continue;
      out[k] = k === "phase" && v === "open" ? "active" : v;
    }
    return db.updateClaimFields(id, out);
  },
  setCompactSummary: (id: string, s: string) => db.updateCompactSummary(id, s.slice(0, 2000)),
  upsertMoneyItem: (id: string, i: { ref: string; category: "repair" | "rental" | "medical"; billed?: number; submitted?: number; paid?: number; gapReason?: string | null }) =>
    db.upsertMoneyItem(id, {
      itemId: i.ref,
      kind: i.ref.startsWith("estimate:") ? "estimate" : "invoice",
      category: i.category,
      ...clean({ billed: i.billed, submitted: i.submitted, paid: i.paid }),
      ...(i.gapReason !== undefined ? { reason: i.gapReason } : {}),
    }),
  recomputeMoneyTotals: (id: string) => db.recomputeMoneyTotals(id),
  /** reconcileMoney's aggregation (billed vs submitted vs paid per line) -> gaps and whether each has a recorded reason. */
  async reconcileMoney(id: string): Promise<{ balanced: boolean; gaps: MoneyGap[]; unexplained: MoneyGap[]; itemCount: number }> {
    const rows = await db.reconcileMoney(id);
    const round = (n: number) => Math.round(n * 100) / 100;
    const gaps = rows
      .filter((r) => round(r.billedToSubmittedGap) !== 0 || round(r.submittedToPaidGap) !== 0)
      .map((r) => ({ ref: r.itemId, category: r.category, billed: r.billed, submitted: r.submitted, paid: r.paid, gapReason: r.reason ?? null, explained: !!r.reason }));
    const unexplained = gaps.filter((g) => !g.explained);
    return { balanced: unexplained.length === 0, gaps, unexplained, itemCount: rows.length };
  },
};

/* ------------------------------------------------------------------ tasks */

export const tasks = {
  getTask: async (claimId: string, taskId: string) => normTask(await db.getTask(claimId, taskId)),
  listTasks: (claimId: string, f: { status?: TaskStatus[] } = {}) => db.listTasks(claimId).then((all) => normTasks(f.status ? all.filter((t) => f.status!.includes(t.status)) : all)),
  listOpenTasks: async (claimId: string) => normTasks(await db.listOpenTasks(claimId)),
  /** Dependencies resolved (plain code); the tasks keep their stored status. */
  findReadyTasks: async (claimId: string) => normTasks(db.readyFrom(await db.listTasks(claimId))),
  setTaskStatus: (claimId: string, taskId: string, status: TaskStatus, meta: { by: string; note?: string | undefined; from?: TaskStatus[]; set?: Record<string, unknown> }) =>
    db.setTaskStatus(claimId, taskId, status, meta),
  insertTaskIfMissing: (t: { claimId: string; taskId: string; type: string; title: string; track: TaskDoc["track"]; dependsOn: string[]; isWait?: boolean; params?: Record<string, unknown>; trigger?: string | null }) =>
    db.insertTaskIfMissing(clean(t) as db.NewTask),
  buildTask: (t: db.NewTask) => db.buildTask(t),
  updateTaskFields: (claimId: string, taskId: string, set: Record<string, unknown>) => db.updateTaskFields(claimId, taskId, set),
  addDependency: (claimId: string, taskId: string, dep: string) => db.addDependency(claimId, taskId, dep),
};

/* ---------------------------------------------------------------- actions */

export interface NewAction {
  claimId: string;
  taskId: string;
  system: OutsideSystem;
  kind: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  expectedEffect: Record<string, unknown>;
  verifyBy: "readback" | "webhook" | "readback_or_webhook";
  deadline: Date;
  gate?: Gate | null;
  supersedes?: string | null;
}

export const actions = {
  /** transitionAction (the shared state machine) plus optional non-status fields; returns the updated action. */
  async transitionAction(id: string | ObjectId, to: ActionStatus, meta: { by: string; note?: string; set?: Parameters<typeof db.setActionFields>[1] }): Promise<ActionDoc> {
    await db.transitionAction(id, to, { by: meta.by, ...(meta.note ? { note: meta.note } : {}) });
    if (meta.set && Object.keys(meta.set).length) await db.setActionFields(id, clean(meta.set as Record<string, unknown>, false) as never);
    return (await db.getAction(id))!;
  },
  noteAction: (id: string | ObjectId, note: string, by: string, set: Record<string, unknown> = {}) => db.appendActionNote(id, note, by, clean(set, false) as never),
  getAction: (id: string | ObjectId) => db.getAction(id),
  findActionByKey: (k: string) => db.findActionByKey(k),
  listActions: (claimId: string, f: { status?: ActionStatus[]; taskId?: string } = {}) => db.listActions(claimId, f),
  listUnverified: (claimId: string) => db.listActions(claimId, { status: ["sent", "acknowledged"] }),
  /** Open = not terminal (a `failed` action waiting for a drift fix still counts as open). */
  listOpenForTask: (claimId: string, taskId: string) => db.listActions(claimId, { taskId, status: ["planned", "awaiting_approval", "approved", "sent", "acknowledged", "failed"] }),
  countActionsForTask: (claimId: string, taskId: string, kind?: string) => db.countActionsForTask(claimId, taskId, kind),
};

/** The transactional outbox (+ approval when gated), returning the new action. */
export async function planTaskWithAction(
  task: { claimId: string; taskId: string; status: TaskStatus; note?: string | undefined; by?: string },
  a: NewAction,
  approval?: { taskId: string; gate: Gate; request: string; details?: Record<string, unknown> },
): Promise<{ action: ActionDoc; approvalId: string | null }> {
  const { actionId, approvalId } = await db.planTaskWithActionAndApproval(
    clean(task) as { claimId: string; taskId: string; status: TaskStatus },
    {
      claimId: a.claimId,
      taskId: a.taskId,
      system: a.system,
      kind: a.kind,
      idempotencyKey: a.idempotencyKey,
      payload: a.payload,
      expectedEffect: a.expectedEffect,
      verifyBy: a.verifyBy,
      deadline: a.deadline,
      ...(a.gate ? { gate: a.gate } : {}),
      ...(a.supersedes ? { supersedes: { actionId: a.supersedes } } : {}),
    },
    approval ? { ...approval, approverRole: db.GATE_APPROVER[approval.gate] } : undefined,
  );
  return { action: (await db.getAction(actionId))!, approvalId: approvalId ? String(approvalId) : null };
}

/* ----------------------------------------------------------- observations */

export const observations = {
  insertObservation(o: { claimId: string; source: db.Observation["source"]; kind: string; body: Record<string, unknown>; trust?: db.Observation["trust"]; verified?: boolean | null; matchedActionId?: string | null; processed?: boolean; note?: string | null }) {
    const at = db.nowSync();
    return db.insertObservation({
      claimId: o.claimId,
      source: o.source,
      kind: o.kind,
      body: o.body,
      verified: o.verified ?? false,
      receivedAt: at,
      receivedWallAt: new Date(),
      ...(o.trust ? { trust: o.trust } : {}),
      ...(o.matchedActionId ? { matchedActionId: o.matchedActionId } : {}),
      ...(o.processed ? { processedAt: at, processedBy: "outbound" } : {}),
      ...(o.note ? { note: o.note } : {}),
    });
  },
  listUnprocessed: async (claimId: string) => (await db.listUnprocessed(claimId)).map(normObs),
  listObservations: async (claimId: string, limit?: number) => (await db.listObservations(claimId, limit)).map(normObs),
  markProcessed: (id: string | ObjectId, by: string, set: { matchedActionId?: string | null; verified?: boolean | null; note?: string | null } = {}) =>
    db.markProcessed(id, by, db.nowSync(), clean(set) as { matchedActionId?: string; verified?: boolean; note?: string }),
  updateObservation: (id: string | ObjectId, set: { verified?: boolean; note?: string }) => db.updateObservationFields(id, set),
  claimsWithUnprocessed: () => db.claimsWithUnprocessed(),
  watchObservations: (token?: ResumeToken | null) => db.watchObservations((token ?? undefined) as never),
  saveResumeToken: (workerId: string, token: ResumeToken) => db.saveResumeToken(workerId, token as never),
  loadResumeToken: (workerId: string) => db.loadResumeToken(workerId),
  saveWorkerHeartbeat: (workerId: string, info: { pid: number; held: string[]; replayed: number; startedAt: Date }) => db.saveWorkerHeartbeat(workerId, info),
  listWorkerStates: () => db.listWorkerStates(),
};

/* ----------------------------------------------------------------- timers */

type NewTimer = { claimId: string; taskId: string; rule: TimerRule; dueAt: Date; escalationLevel?: number; actionId?: string | null; approvalId?: string | null; params?: Record<string, unknown> };
const timerDoc = (t: NewTimer): Omit<db.Timer, "_id"> => ({
  claimId: t.claimId,
  taskId: t.taskId,
  rule: t.rule,
  dueAt: t.dueAt,
  fired: false,
  cancelled: false,
  escalationLevel: t.escalationLevel ?? 0,
  createdAt: db.nowSync(),
  ...(t.actionId ? { actionId: t.actionId } : {}),
  ...(t.approvalId ? { approvalId: t.approvalId } : {}),
  ...(t.params ? { params: t.params } : {}),
});
export const timers = {
  createTimer: (t: NewTimer) => db.createTimer(timerDoc(t)),
  ensureTimer: (t: NewTimer) => db.ensureTimer(timerDoc(t)),
  dueTimers: (simNow: Date, claimId?: string) => db.dueTimers(simNow, claimId) as Promise<TimerDoc[]>,
  markFired: (id: string | ObjectId) => db.markFired(String(id)),
  cancelTimersForTask: (claimId: string, taskId: string, rules?: TimerRule[]) => db.cancelTimersForTask(claimId, taskId, rules),
  cancelTimersForAction: (actionId: string) => db.cancelTimersForAction(actionId),
  cancelTimersForApproval: (approvalId: string) => db.cancelTimersForApproval(approvalId),
  listOpenTimers: (claimId: string) => db.listOpenTimers(claimId),
};

/* ----------------------------------------------------------------- leases */

export const leases = {
  acquireLease: async (claimId: string, workerId: string, ttlMs: number) => !!(await db.acquireLease(claimId, workerId, ttlMs)),
  renewLease: (claimId: string, workerId: string, ttlMs: number) => db.renewLease(claimId, workerId, ttlMs),
  releaseLease: (claimId: string, workerId: string) => db.releaseLease(claimId, workerId),
  getLease: (claimId: string) => db.getLease(claimId),
  listLeases: () => db.listLeases(),
  expiredLeases: () => db.expiredLeases(),
};

/* -------------------------------------------------------------- approvals */

export const approvals = {
  async createApproval(a: { claimId: string; actionId: string | null; taskId?: string | null; gate: Gate; request: string; details?: Record<string, unknown> }) {
    const id = await db.createApproval({
      claimId: a.claimId,
      gate: a.gate,
      approverRole: db.GATE_APPROVER[a.gate],
      request: a.request,
      status: "pending",
      ...(a.actionId ? { actionId: a.actionId } : {}),
      ...(a.taskId ? { taskId: a.taskId } : {}),
      ...(a.details ? { details: a.details } : {}),
    });
    // Operator gates: the agent decides them itself unless AUTOPILOT=off (lazy import: no cycle).
    if (db.GATE_APPROVER[a.gate] === "operator") await (await import("./worker/autopilot.ts")).autopilotApproval(String(id));
    return id;
  },
  getApproval: (id: string | ObjectId) => db.getApproval(id),
  listApprovals: (claimId: string, status?: db.Approval["status"]) => db.listApprovals(claimId, status),
  findPendingApproval: (claimId: string, gate: Gate, taskId?: string) => db.findPendingApproval(claimId, gate, taskId),
  async decideApproval(id: string, decision: "approved" | "declined", decidedBy: string, note?: string) {
    await db.decideApproval(id, decision, decidedBy, new Date(), note);
    return db.getApproval(id);
  },
};

/* --------------------------------------------- profiles, experiences, docs */

export const profiles = {
  getLatestProfile: (system: string) => db.getLatestProfile(system),
  saveProfileVersion: (p: { system: string; fields: ProfileField[]; workflowSteps: string[]; fieldMap?: Record<string, string>; source?: string }) => db.saveProfileVersion(p),
  async matchCanonicalField(text: string, k = 3): Promise<{ fieldName: string; description: string; score: number }[]> {
    return (await db.matchCanonicalField(text, k)).map((d) => ({ fieldName: String(d.fieldName), description: String(d.description ?? ""), score: Number(d.score ?? 0) }));
  },
};

export const experiences = {
  recordExperience: (e: { problemType: db.Experience["problemType"]; system: string; problem: string; fix: Record<string, unknown>; outcome: string; claimId?: string | null }) =>
    db.recordExperience({ problemType: e.problemType, system: e.system, problem: e.problem, fix: e.fix, outcome: e.outcome, ...(e.claimId ? { claimId: e.claimId } : {}) }),
  async findSimilarExperiences(text: string, filter: { problemType?: db.Experience["problemType"]; system?: string }, k = 3) {
    return (await db.findSimilarExperiences(text, filter, k)).map((d) => ({
      problemType: String(d.problemType),
      system: String(d.system),
      problem: String(d.problem),
      fix: (d.fix ?? {}) as Record<string, unknown>,
      outcome: String(d.outcome ?? ""),
      score: Number(d.score ?? 0),
    }));
  },
};

export const documents = {
  /** GridFS (bucket `files`) + `documents` metadata. Text-only documents (call transcripts) are stored as text files. */
  putDocument: (d: { claimId: string; docType: db.DocumentMetadata["docType"]; source: string; data?: Buffer; filename?: string; contentType?: string; extractedText?: string }) =>
    db.uploadDocument({
      claimId: d.claimId,
      docType: d.docType,
      filename: d.filename ?? `${d.docType}-${Date.now()}.txt`,
      bytes: d.data ?? Buffer.from(d.extractedText ?? "", "utf8"),
      contentType: d.contentType ?? "text/plain",
      source: d.source,
      ...(d.extractedText !== undefined ? { extractedText: d.extractedText } : {}),
    }),
  getDocumentMeta: (id: string) => db.getDocumentMeta(id),
  getFile: (gridfsId: string | ObjectId) => db.downloadDocument(gridfsId),
  listDocuments: (claimId: string, docType?: db.DocumentMetadata["docType"]) => db.listDocuments(claimId, docType),
  searchDocuments: (claimId: string, q: string) => db.searchDocuments(claimId, q),
};

export const health = {
  recordHealth: (h: { system: string; latencyMs: number; ok: boolean; errorCode?: string | null; endpoint?: string }) =>
    db.recordHealth({ ts: db.nowSync(), system: h.system, latencyMs: h.latencyMs, ok: h.ok, ...(h.errorCode ? { errorCode: h.errorCode } : {}) }),
};

export const contacts = {
  findByPhone: (phone: string) => db.findContactByPhone(phone),
  upsertContact: (c: db.Contact) => db.upsertContact(c),
  linkContactToClaim: (phone: string, claimId: string) => db.linkContactToClaim(phone, claimId),
  listContacts: (claimId?: string) => db.listContacts(claimId),
};

export const setup = {
  setupDatabase: () => db.setupDatabase(),
  resetDemoData: () => db.resetDemoData(),
};

export const closeDb = () => db.closeDatabase();
