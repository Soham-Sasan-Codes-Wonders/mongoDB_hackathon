import { type ClientSession, type Document } from "mongodb";
import { collection, wallNow } from "./database.js";
import { nowSync } from "./clock.js";
import { TaskSchema, type Task } from "./schemas.js";

export async function findReadyTasks(claimId: string): Promise<Task[]> {
  const tasks = await collection<Task & Document>("tasks").find({ claimId } as Document).toArray();
  return readyFrom(tasks).map((task) => ({ ...task, status: "ready" }));
}

export async function updateTaskStatus(claimId: string, taskId: string, status: Task["status"], meta: { by: string; note?: string }, simAt: Date, wallAt = new Date()): Promise<boolean> {
  const task = collection("tasks");
  const result = await task.updateOne({ claimId, taskId }, { $set: { status, updatedAt: wallAt }, $push: { history: { status, at: simAt, wallAt, by: meta.by, ...(meta.note === undefined ? {} : { note: meta.note }) } } } as Document);
  return result.modifiedCount === 1;
}

export async function listTasks(claimId: string): Promise<Task[]> {
  return collection<Task & Document>("tasks").find({ claimId } as Document).sort({ taskId: 1 }).toArray();
}

/* ---------------------------------------------------------------- agent additions */

/** A dependency is resolved when it is confirmed, denied or closed by a human (so a denied invoice doesn't block T18). */
export const RESOLVED_TASK_STATUSES: readonly Task["status"][] = ["confirmed", "denied", "closed_by_human"];

/** Pure dependency check behind findReadyTasks (plain code, exported for tests). */
export function readyFrom<T extends Pick<Task, "taskId" | "status" | "dependsOn">>(tasks: T[]): T[] {
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  return tasks.filter((t) => (t.status === "pending" || t.status === "ready") && t.dependsOn.every((d) => {
    const dep = byId.get(d);
    return !!dep && RESOLVED_TASK_STATUSES.includes(dep.status);
  }));
}

export type NewTask = Omit<Task, "_id" | "history" | "createdAt" | "updatedAt" | "status"> & { status?: Task["status"] };

export function buildTask(t: NewTask, by = "agent"): Task {
  const at = nowSync();
  const status = t.status ?? "pending";
  return TaskSchema.parse({ ...t, status, history: [{ status, at, wallAt: wallNow(), by }], createdAt: at, updatedAt: at });
}

export async function insertTaskIfMissing(t: NewTask, session?: ClientSession): Promise<boolean> {
  const res = await collection("tasks").updateOne({ claimId: t.claimId, taskId: t.taskId }, { $setOnInsert: buildTask(t) as unknown as Document }, { upsert: true, ...(session ? { session } : {}) });
  return res.upsertedCount === 1;
}

export async function getTask(claimId: string, taskId: string): Promise<Task | null> {
  return collection<Task & Document>("tasks").findOne({ claimId, taskId });
}

export async function listOpenTasks(claimId: string): Promise<Task[]> {
  return collection<Task & Document>("tasks").find({ claimId, status: { $nin: [...RESOLVED_TASK_STATUSES] } }).sort({ createdAt: 1, _id: 1 }).toArray();
}

/** Status change with a history entry (sim time from the cached clock). `from` makes it a compare-and-set. */
export async function setTaskStatus(claimId: string, taskId: string, status: Task["status"], meta: { by: string; note?: string | undefined; from?: Task["status"][]; set?: Record<string, unknown>; session?: ClientSession }): Promise<boolean> {
  const at = nowSync();
  const q: Document = { claimId, taskId, ...(meta.from ? { status: { $in: meta.from } } : {}) };
  const res = await collection("tasks").updateOne(q, {
    $set: { status, updatedAt: at, ...(meta.set ?? {}) },
    $push: { history: { status, at, wallAt: wallNow(), by: meta.by, ...(meta.note ? { note: meta.note } : {}) } },
  } as Document, meta.session ? { session: meta.session } : {});
  return res.modifiedCount === 1;
}

export async function updateTaskFields(claimId: string, taskId: string, set: Record<string, unknown>): Promise<void> {
  await collection("tasks").updateOne({ claimId, taskId }, { $set: { ...set, updatedAt: nowSync() } });
}

/** Wire a dependency into an existing task (e.g. an inserted "upload photos" task blocks T9). */
export async function addDependency(claimId: string, taskId: string, dependsOnTaskId: string): Promise<void> {
  await collection("tasks").updateOne({ claimId, taskId }, { $addToSet: { dependsOn: dependsOnTaskId }, $set: { updatedAt: nowSync() } });
}
