import { ObjectId, type ClientSession, type Document } from "mongodb";
import { collection, wallNow } from "./database.js";
import { now } from "./clock.js";
import { ActionSchema, ActionStatusSchema, TaskSchema, type Action, type Task } from "./schemas.js";

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
