import { ObjectId, type ClientSession, type Document } from "mongodb";
import { collection, wallNow } from "./database.js";
import { now, nowSync } from "./clock.js";
import { client } from "./database.js";
import { ActionSchema, ActionStatusSchema, ApprovalSchema, TaskSchema, type Action, type Approval, type Task } from "./schemas.js";

export type ActionTransitionMeta = { by: string; note?: string };
export class IllegalActionTransitionError extends Error {
  constructor(readonly from: string, readonly to: string) { super(`Illegal action transition: ${from} → ${to}`); this.name = "IllegalActionTransitionError"; }
}
export class ActionTransitionConflictError extends Error {
  constructor() { super("Action changed concurrently; reload before retrying the transition"); this.name = "ActionTransitionConflictError"; }
}

const transitions: Record<string, readonly string[]> = {
  planned: ["awaiting_approval", "sent", "failed", "cancelled", "closed_by_human"],
  awaiting_approval: ["approved", "cancelled", "closed_by_human"],
  approved: ["sent", "cancelled"],
  sent: ["acknowledged", "confirmed", "rejected", "failed", "cancelled", "closed_by_human"],
  acknowledged: ["confirmed", "rejected", "failed", "cancelled", "closed_by_human"],
  failed: ["sent", "cancelled", "closed_by_human"],
  confirmed: [], rejected: [], cancelled: [], closed_by_human: []
};

export function mintIdempotencyKey(claimId: string, taskId: string, kind: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError("attempt must be a positive integer");
  return `${claimId}:${taskId}:${kind}:${attempt}`;
}

export async function transitionAction(actionId: string | ObjectId, to: Action["status"], meta: ActionTransitionMeta): Promise<void> {
  if (!ActionStatusSchema.safeParse(to).success) throw new TypeError(`Unknown action status: ${to}`);
  const id = typeof actionId === "string" && ObjectId.isValid(actionId) ? new ObjectId(actionId) : actionId;
  const actions = collection("actions");
  const action = await actions.findOne({ _id: id } as Document);
  if (!action) throw new Error(`Action ${String(actionId)} was not found`);
  if (!transitions[action.status]?.includes(to)) throw new IllegalActionTransitionError(action.status, to);
  const historyEntry = { status: to, at: await now(), wallAt: wallNow(), by: meta.by, note: meta.note ?? "" };
  const setFields = { status: to, ...(to === "sent" ? { attempts: action.status === "failed" ? action.attempts + 1 : Math.max(action.attempts, 1) } : {}) };
  const result = await actions.updateOne({ _id: id, status: action.status } as Document, { $set: setFields, $push: { history: historyEntry } } as any);
  if (result.modifiedCount !== 1) throw new ActionTransitionConflictError();
}

export async function planTaskWithAction(session: ClientSession, task: Task, action: Action): Promise<string | ObjectId> {
  const parsedTask = TaskSchema.parse(task);
  const { _id: ignoredId, history: ignoredHistory, ...taskData } = parsedTask;
  void ignoredId;
  void ignoredHistory;
  const parsedAction = ActionSchema.parse(action);
  let actionId: string | ObjectId = "";
  await session.withTransaction(async () => {
    const taskCollection = collection("tasks");
    const taskStatus = taskData.status;
    const at = await now();
    const historyEntry = { status: taskStatus, at, wallAt: wallNow(), by: "agent", note: "Task and action planned atomically" };
    await taskCollection.updateOne({ claimId: taskData.claimId, taskId: taskData.taskId }, {
      $set: { ...taskData, updatedAt: wallNow() },
      $setOnInsert: { createdAt: wallNow() },
      $push: { history: historyEntry }
    } as Document, { upsert: true, session });
    const actionDocument = { ...parsedAction, createdAt: parsedAction.createdAt ?? wallNow() };
    const result = await collection("actions").insertOne(actionDocument as unknown as Document, { session });
    actionId = result.insertedId!;
  });
  return actionId;
}

export async function getLatestActionsByTask(claimId: string): Promise<Document[]> {
  return collection("actions").aggregate([
    { $match: { claimId } }, { $sort: { createdAt: -1, _id: -1 } },
    { $group: { _id: "$taskId", action: { $first: "$$ROOT" } } }, { $replaceRoot: { newRoot: "$action" } }
  ]).toArray();
}

/* ---------------------------------------------------------------- agent additions */

export type ActionDoc = Action & { _id: ObjectId };
export const ACTION_TRANSITIONS: Readonly<Record<string, readonly string[]>> = transitions;
export const TERMINAL_ACTION_STATUSES: readonly Action["status"][] = ["confirmed", "rejected", "cancelled", "closed_by_human"];

/** The code-enforced lifecycle as a pure check (same table transitionAction uses). */
export function canTransition(from: Action["status"], to: Action["status"]): boolean {
  return transitions[from]?.includes(to) ?? false;
}

const oid = (id: string | ObjectId) => (typeof id === "string" && ObjectId.isValid(id) ? new ObjectId(id) : id);

/** Set non-status fields (response, readback, verifyAfter, lastError, ...). Status only changes through transitionAction. */
export async function setActionFields(actionId: string | ObjectId, set: Partial<Pick<Action, "response" | "readback" | "lastError" | "verifyAfter" | "profileVersion" | "approvalId">>): Promise<void> {
  await collection("actions").updateOne({ _id: oid(actionId) } as Document, { $set: { ...set, updatedAt: nowSync() } });
}

/** History note without a status change (e.g. "read-back: effect not found"). */
export async function appendActionNote(actionId: string | ObjectId, note: string, by: string, set: Partial<Pick<Action, "response" | "readback" | "lastError" | "verifyAfter">> = {}): Promise<void> {
  const a = await collection("actions").findOne({ _id: oid(actionId) } as Document);
  if (!a) return;
  await collection("actions").updateOne({ _id: oid(actionId) } as Document, { $set: { ...set, updatedAt: nowSync() }, $push: { history: { status: a.status, at: nowSync(), wallAt: wallNow(), by, note } } } as Document);
}

export async function getAction(actionId: string | ObjectId): Promise<ActionDoc | null> {
  return collection<ActionDoc>("actions").findOne({ _id: oid(actionId) } as Document);
}
export async function findActionByKey(idempotencyKey: string): Promise<ActionDoc | null> {
  return collection<ActionDoc>("actions").findOne({ idempotencyKey });
}
export async function listActions(claimId: string, filter: { status?: Action["status"][]; taskId?: string } = {}): Promise<ActionDoc[]> {
  return collection<ActionDoc>("actions").find({ claimId, ...(filter.status ? { status: { $in: filter.status } } : {}), ...(filter.taskId ? { taskId: filter.taskId } : {}) }).sort({ createdAt: 1, _id: 1 }).toArray();
}
export async function countActionsForTask(claimId: string, taskId: string, kind?: string): Promise<number> {
  return collection("actions").countDocuments({ claimId, taskId, ...(kind ? { kind } : {}) });
}

/**
 * The transactional outbox, extended with gates: the task's status change, its new action and, when
 * the action hits a gate, the approval request, all in ONE transaction. A gated action is written
 * as `awaiting_approval` and the task as `awaiting_approval`.
 */
export async function planTaskWithActionAndApproval(
  task: { claimId: string; taskId: string; status: Task["status"]; note?: string; by?: string },
  action: Omit<Action, "_id" | "status" | "attempts" | "history" | "createdAt">,
  approval?: Omit<Approval, "_id" | "claimId" | "actionId" | "status" | "createdAt">,
): Promise<{ actionId: ObjectId; approvalId: ObjectId | null }> {
  const at = nowSync();
  const by = task.by ?? "agent";
  const actionId = new ObjectId();
  const approvalId = approval ? new ObjectId() : null;
  const history: Action["history"] = [{ status: "planned", at, wallAt: wallNow(), by, note: task.note ?? "planned" }];
  if (approval) history.push({ status: "awaiting_approval", at, wallAt: wallNow(), by, note: `gate: ${approval.gate}` });
  const doc = ActionSchema.parse({ ...action, status: approval ? "awaiting_approval" : "planned", attempts: 0, history, createdAt: at, updatedAt: at, ...(approvalId ? { approvalId: String(approvalId) } : {}) });
  const taskStatus = approval ? "awaiting_approval" : task.status;
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      if (approval && approvalId) {
        await collection("approvals").insertOne({ _id: approvalId, ...ApprovalSchema.parse({ ...approval, claimId: action.claimId, actionId: String(actionId), status: "pending", createdAt: at }) } as Document, { session });
      }
      await collection("actions").insertOne({ ...doc, _id: actionId } as unknown as Document, { session });
      const res = await collection("tasks").updateOne({ claimId: task.claimId, taskId: task.taskId }, {
        $set: { status: taskStatus, updatedAt: at },
        $push: { history: { status: taskStatus, at, wallAt: wallNow(), by, note: task.note ?? `${action.kind} planned` } },
      } as Document, { session });
      if (res.matchedCount !== 1) throw new Error(`task ${task.claimId}/${task.taskId} does not exist`);
    });
  } finally {
    await session.endSession();
  }
  return { actionId, approvalId };
}
