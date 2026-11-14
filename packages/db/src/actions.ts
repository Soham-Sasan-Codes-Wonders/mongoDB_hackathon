import { ObjectId, type ClientSession, type WithId } from "mongodb";
import { col } from "./collections.ts";
import { now } from "./clock.ts";
import { Action, ACTION_TERMINAL, type ActionStatus } from "./schemas.ts";

export type ActionDoc = WithId<Action>;

/**
 * The only legal action transitions (the doc's "Action lifecycle").
 *  - sent -> confirmed: a webhook proved the effect before the API responded.
 *  - sent/acknowledged -> sent: a retry with the SAME idempotency key.
 *  - rejected is terminal: the rejection subflow creates a new action with a new key.
 *  - awaiting_approval -> cancelled: the human declined.
 *  - any non-terminal -> closed_by_human: an operator closed it out of band.
 */
export const TRANSITIONS: Record<ActionStatus, readonly ActionStatus[]> = {
  planned: ["awaiting_approval", "sent", "cancelled", "failed", "closed_by_human"],
  awaiting_approval: ["approved", "cancelled", "closed_by_human"],
  approved: ["sent", "cancelled", "closed_by_human"],
  sent: ["sent", "acknowledged", "confirmed", "rejected", "failed", "cancelled", "closed_by_human"],
  acknowledged: ["sent", "confirmed", "rejected", "failed", "cancelled", "closed_by_human"],
  confirmed: [],
  rejected: [],
  failed: [],
  cancelled: [],
  closed_by_human: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    public readonly actionId: string,
    public readonly from: ActionStatus,
    public readonly to: ActionStatus,
  ) {
    super(`Illegal action transition ${from} -> ${to} (action ${actionId})`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransition(from: ActionStatus, to: ActionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(s: ActionStatus): boolean {
  return ACTION_TERMINAL.includes(s);
}

/** `CLM-1042:T5:create_reservation:1`. Retries reuse it; only a new submission mints attempt+1. */
export function mintIdempotencyKey(claimId: string, taskId: string, kind: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`attempt must be >= 1, got ${attempt}`);
  return `${claimId}:${taskId}:${kind}:${attempt}`;
}

export interface NewAction {
  claimId: string;
  taskId: string;
  system: Action["system"];
  kind: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  expectedEffect: Record<string, unknown>;
  verifyBy: Action["verifyBy"];
  deadline: Date;
  gate?: Action["gate"];
  supersedes?: string | null;
  status?: "planned" | "awaiting_approval";
  by?: string;
  note?: string;
}

export function buildActionDoc(a: NewAction): Action {
  const at = now();
  const status = a.status ?? "planned";
  const doc: Action = {
    claimId: a.claimId,
    taskId: a.taskId,
    system: a.system,
    kind: a.kind,
    idempotencyKey: a.idempotencyKey,
    payload: a.payload,
    expectedEffect: a.expectedEffect,
    verifyBy: a.verifyBy,
    status,
    attempts: 0,
    deadline: a.deadline,
    gate: a.gate ?? null,
    approvalId: null,
    supersedes: a.supersedes ?? null,
    lastError: null,
    verifyAfter: null,
    history: [{ status: "planned", at, wallAt: new Date(), by: a.by ?? "agent", note: a.note }],
    createdAt: at,
    updatedAt: at,
  };
  if (status === "awaiting_approval") {
    doc.history.push({ status, at, wallAt: new Date(), by: a.by ?? "agent", note: `gate: ${a.gate}` });
  }
  return Action.parse(doc);
}

export interface TransitionMeta {
  by: string;
  note?: string;
  set?: Partial<Pick<Action, "response" | "readback" | "lastError" | "verifyAfter" | "approvalId" | "profileVersion" | "payload">>;
  incAttempts?: boolean;
  session?: ClientSession;
}

/**
 * Move an action to `to`. Enforces TRANSITIONS with a compare-and-set on the current status,
 * so two workers can't both move it. Appends {status, at, wallAt, by, note} to history.
 */
export async function transitionAction(actionId: string | ObjectId, to: ActionStatus, meta: TransitionMeta): Promise<ActionDoc> {
  const actions = await col.actions();
  const _id = typeof actionId === "string" ? new ObjectId(actionId) : actionId;
  const current = await actions.findOne({ _id }, { session: meta.session });
  if (!current) throw new Error(`action ${_id} not found`);
  if (!canTransition(current.status, to)) throw new IllegalTransitionError(String(_id), current.status, to);
  const at = now();
  const entry = { status: to, at, wallAt: new Date(), by: meta.by, note: meta.note };
  const res = await actions.findOneAndUpdate(
    { _id, status: current.status },
    {
      $set: { status: to, updatedAt: at, ...(meta.set ?? {}) },
      $push: { history: entry },
      ...(meta.incAttempts ? { $inc: { attempts: 1 } } : {}),
    },
    { returnDocument: "after", session: meta.session },
  );
  if (!res) {
    const again = await actions.findOne({ _id });
    throw new IllegalTransitionError(String(_id), again?.status ?? current.status, to);
  }
  return res;
}

/** Record a note in history without changing status (e.g. "read-back: effect missing"). */
export async function noteAction(actionId: string | ObjectId, note: string, by: string, set: Record<string, unknown> = {}): Promise<void> {
  const _id = typeof actionId === "string" ? new ObjectId(actionId) : actionId;
  const at = now();
  const a = await (await col.actions()).findOne({ _id });
  if (!a) return;
  await (await col.actions()).updateOne(
    { _id },
    { $set: { updatedAt: at, ...set }, $push: { history: { status: a.status, at, wallAt: new Date(), by, note } } },
  );
}

export async function getAction(actionId: string | ObjectId): Promise<ActionDoc | null> {
  const _id = typeof actionId === "string" ? new ObjectId(actionId) : actionId;
  return (await col.actions()).findOne({ _id });
}

export async function findActionByKey(idempotencyKey: string): Promise<ActionDoc | null> {
  return (await col.actions()).findOne({ idempotencyKey });
}

export async function listActions(claimId: string, filter: { status?: ActionStatus[]; taskId?: string } = {}): Promise<ActionDoc[]> {
  const q: Record<string, unknown> = { claimId };
  if (filter.status) q.status = { $in: filter.status };
  if (filter.taskId) q.taskId = filter.taskId;
  return (await col.actions()).find(q).sort({ createdAt: 1, _id: 1 }).toArray();
}

/** Actions that must be verified before anything new is done (loop step 3, crash recovery step 4). */
export async function listUnverified(claimId: string): Promise<ActionDoc[]> {
  return listActions(claimId, { status: ["sent", "acknowledged"] });
}

export async function listOpenForTask(claimId: string, taskId: string): Promise<ActionDoc[]> {
  return (await col.actions())
    .find({ claimId, taskId, status: { $nin: [...ACTION_TERMINAL] } })
    .sort({ createdAt: 1 })
    .toArray();
}

export async function countActionsForTask(claimId: string, taskId: string, kind?: string): Promise<number> {
  return (await col.actions()).countDocuments({ claimId, taskId, ...(kind ? { kind } : {}) });
}

export async function latestActionForTask(claimId: string, taskId: string, kind?: string): Promise<ActionDoc | null> {
  return (await col.actions()).findOne({ claimId, taskId, ...(kind ? { kind } : {}) }, { sort: { createdAt: -1, _id: -1 } });
}
