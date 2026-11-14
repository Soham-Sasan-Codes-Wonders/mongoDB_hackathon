import { ObjectId, type WithId } from "mongodb";
import { col } from "./collections.ts";
import { now } from "./clock.ts";
import { Timer, type TimerRule } from "./schemas.ts";

export type TimerDoc = WithId<Timer>;

export interface NewTimer {
  claimId: string;
  taskId: string;
  rule: TimerRule;
  dueAt: Date;
  escalationLevel?: number;
  actionId?: string | null;
  approvalId?: string | null;
  params?: Record<string, unknown>;
}

export async function createTimer(t: NewTimer): Promise<string> {
  const doc = Timer.parse({
    claimId: t.claimId,
    taskId: t.taskId,
    rule: t.rule,
    dueAt: t.dueAt,
    fired: false,
    cancelled: false,
    escalationLevel: t.escalationLevel ?? 0,
    actionId: t.actionId ?? null,
    approvalId: t.approvalId ?? null,
    params: t.params ?? {},
    createdAt: now(),
    firedAt: null,
  });
  const res = await (await col.timers()).insertOne(doc);
  return String(res.insertedId);
}

/** Create unless an open timer with the same (claim, task, rule[, actionId]) already exists. */
export async function ensureTimer(t: NewTimer): Promise<string | null> {
  const existing = await (await col.timers()).findOne({
    claimId: t.claimId,
    taskId: t.taskId,
    rule: t.rule,
    fired: false,
    cancelled: false,
    ...(t.actionId ? { actionId: t.actionId } : {}),
    ...(t.approvalId ? { approvalId: t.approvalId } : {}),
  });
  if (existing) return null;
  return createTimer(t);
}

/** Uses index {fired:1, cancelled:1, dueAt:1}. */
export async function dueTimers(simNow: Date, claimId?: string): Promise<TimerDoc[]> {
  return (await col.timers())
    .find({ fired: false, cancelled: false, dueAt: { $lte: simNow }, ...(claimId ? { claimId } : {}) })
    .sort({ dueAt: 1 })
    .limit(500)
    .toArray();
}

/** Compare-and-set so two workers never fire the same timer. Returns true if this caller fired it. */
export async function markFired(timerId: string | ObjectId): Promise<boolean> {
  const _id = typeof timerId === "string" ? new ObjectId(timerId) : timerId;
  const res = await (await col.timers()).updateOne({ _id, fired: false, cancelled: false }, { $set: { fired: true, firedAt: now() } });
  return res.modifiedCount === 1;
}

/** A confirmed task never gets chased. */
export async function cancelTimersForTask(claimId: string, taskId: string, rules?: TimerRule[]): Promise<number> {
  const res = await (await col.timers()).updateMany(
    { claimId, taskId, fired: false, cancelled: false, ...(rules ? { rule: { $in: rules } } : {}) },
    { $set: { cancelled: true } },
  );
  return res.modifiedCount;
}

export async function cancelTimersForAction(actionId: string): Promise<number> {
  const res = await (await col.timers()).updateMany({ actionId, fired: false, cancelled: false }, { $set: { cancelled: true } });
  return res.modifiedCount;
}

export async function cancelTimersForApproval(approvalId: string): Promise<number> {
  const res = await (await col.timers()).updateMany({ approvalId, fired: false, cancelled: false }, { $set: { cancelled: true } });
  return res.modifiedCount;
}

export async function listOpenTimers(claimId: string): Promise<TimerDoc[]> {
  return (await col.timers()).find({ claimId, fired: false, cancelled: false }).sort({ dueAt: 1 }).toArray();
}
