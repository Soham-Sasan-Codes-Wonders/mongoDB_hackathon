import { ObjectId, type Document } from "mongodb";
import { collection } from "./database.js";
import { TimerSchema, type Timer } from "./schemas.js";

export async function dueTimers(simNow: Date, claimId?: string): Promise<Timer[]> {
  return collection<Timer & Document>("timers").find({ fired: false, cancelled: false, dueAt: { $lte: simNow }, ...(claimId ? { claimId } : {}) }).sort({ dueAt: 1 }).toArray();
}
export async function createTimer(timer: Omit<Timer, "_id">): Promise<string> {
  const result = await collection("timers").insertOne(TimerSchema.parse(timer) as unknown as Document);
  return result.insertedId.toString();
}
export async function cancelTimersForTask(claimId: string, taskId: string, rules?: Timer["rule"][]): Promise<number> {
  return (await collection("timers").updateMany({ claimId, taskId, fired: false, cancelled: false, ...(rules ? { rule: { $in: rules } } : {}) }, { $set: { cancelled: true } })).modifiedCount;
}
export async function markFired(timerId: string): Promise<boolean> {
  const id = ObjectId.isValid(timerId) ? new ObjectId(timerId) : timerId;
  const result = await collection("timers").updateOne({ _id: id, fired: false, cancelled: false } as Document, { $set: { fired: true } });
  return result.modifiedCount === 1;
}

/* ---------------------------------------------------------------- agent additions */

export type TimerDoc = Timer & { _id: ObjectId };

/** Create unless an open timer with the same claim/task/rule (and action/approval, if given) exists. */
export async function ensureTimer(timer: Omit<Timer, "_id">): Promise<string | null> {
  const existing = await collection("timers").findOne({ claimId: timer.claimId, taskId: timer.taskId, rule: timer.rule, fired: false, cancelled: false, ...(timer.actionId ? { actionId: timer.actionId } : {}), ...(timer.approvalId ? { approvalId: timer.approvalId } : {}) });
  return existing ? null : createTimer(timer);
}
export async function cancelTimersForAction(actionId: string): Promise<number> {
  return (await collection("timers").updateMany({ actionId, fired: false, cancelled: false }, { $set: { cancelled: true } })).modifiedCount;
}
export async function cancelTimersForApproval(approvalId: string): Promise<number> {
  return (await collection("timers").updateMany({ approvalId, fired: false, cancelled: false }, { $set: { cancelled: true } })).modifiedCount;
}
export async function listOpenTimers(claimId: string): Promise<TimerDoc[]> {
  return collection<TimerDoc>("timers").find({ claimId, fired: false, cancelled: false }).sort({ dueAt: 1 }).toArray();
}
