import { ObjectId, type ClientSession, type WithId } from "mongodb";
import { col } from "./collections.ts";
import { now } from "./clock.ts";
import { withTransaction } from "./env.ts";
import { buildActionDoc, type ActionDoc, type NewAction } from "./actions.ts";
import { buildApprovalDoc, type NewApproval } from "./approvals.ts";
import { Task, TASK_RESOLVED, type TaskStatus } from "./schemas.ts";

export type TaskDoc = WithId<Task>;

export interface NewTask {
  claimId: string;
  taskId: string;
  type: string;
  title: string;
  track: Task["track"];
  dependsOn: string[];
  isWait?: boolean;
  params?: Record<string, unknown>;
  trigger?: string | null;
  status?: TaskStatus;
}

export function buildTaskDoc(t: NewTask, by = "agent"): Task {
  const at = now();
  return Task.parse({
    claimId: t.claimId,
    taskId: t.taskId,
    type: t.type,
    title: t.title,
    track: t.track,
    dependsOn: t.dependsOn,
    status: t.status ?? "pending",
    isWait: t.isWait ?? false,
    params: t.params ?? {},
    trigger: t.trigger ?? null,
    triggeredAt: null,
    history: [{ status: t.status ?? "pending", at, wallAt: new Date(), by }],
    createdAt: at,
    updatedAt: at,
  });
}

export async function insertTasks(tasks: NewTask[], session?: ClientSession): Promise<void> {
  if (!tasks.length) return;
  await (await col.tasks()).insertMany(tasks.map((t) => buildTaskDoc(t)), { session });
}

/** Insert a task if (claimId, taskId) doesn't exist yet. Returns true when inserted. */
export async function insertTaskIfMissing(t: NewTask, session?: ClientSession): Promise<boolean> {
  const res = await (await col.tasks()).updateOne(
    { claimId: t.claimId, taskId: t.taskId },
    { $setOnInsert: buildTaskDoc(t) },
    { upsert: true, session },
  );
  return res.upsertedCount === 1;
}

export async function getTask(claimId: string, taskId: string): Promise<TaskDoc | null> {
  return (await col.tasks()).findOne({ claimId, taskId });
}

export async function listTasks(claimId: string, filter: { status?: TaskStatus[] } = {}): Promise<TaskDoc[]> {
  const q: Record<string, unknown> = { claimId };
  if (filter.status) q.status = { $in: filter.status };
  return (await col.tasks()).find(q).sort({ createdAt: 1, _id: 1 }).toArray();
}

export async function listOpenTasks(claimId: string): Promise<TaskDoc[]> {
  return (await col.tasks()).find({ claimId, status: { $nin: [...TASK_RESOLVED] } }).sort({ createdAt: 1, _id: 1 }).toArray();
}

/** Set a task's status with a history entry. Optional `from` makes it a compare-and-set. */
export async function setTaskStatus(
  claimId: string,
  taskId: string,
  status: TaskStatus,
  meta: { by: string; note?: string; from?: TaskStatus[]; set?: Record<string, unknown>; session?: ClientSession },
): Promise<boolean> {
  const at = now();
  const q: Record<string, unknown> = { claimId, taskId };
  if (meta.from) q.status = { $in: meta.from };
  const res = await (await col.tasks()).updateOne(
    q,
    {
      $set: { status, updatedAt: at, ...(meta.set ?? {}) },
      $push: { history: { status, at, wallAt: new Date(), by: meta.by, note: meta.note } },
    },
    { session: meta.session },
  );
  return res.modifiedCount === 1;
}

export async function updateTaskFields(claimId: string, taskId: string, set: Record<string, unknown>): Promise<void> {
  await (await col.tasks()).updateOne({ claimId, taskId }, { $set: { ...set, updatedAt: now() } });
}

/** Wire a new dependency into an existing task (e.g. an inserted "upload photos" task blocks T9). */
export async function addDependency(claimId: string, taskId: string, dependsOnTaskId: string, session?: ClientSession): Promise<void> {
  await (await col.tasks()).updateOne(
    { claimId, taskId },
    { $addToSet: { dependsOn: dependsOnTaskId }, $set: { updatedAt: now() } },
    { session },
  );
}

/**
 * Tasks whose every dependency is resolved (confirmed / denied / closed_by_human) and that are
 * themselves still `pending` or `ready`. Plain code, never the LLM.
 */
export async function findReadyTasks(claimId: string): Promise<TaskDoc[]> {
  const all = await listTasks(claimId);
  return computeReady(all);
}

/** Pure dependency check, exported for tests. */
export function computeReady<T extends Pick<Task, "taskId" | "status" | "dependsOn">>(all: T[]): T[] {
  const byId = new Map(all.map((t) => [t.taskId, t]));
  return all.filter((t) => {
    if (t.status !== "pending" && t.status !== "ready") return false;
    return t.dependsOn.every((d) => {
      const dep = byId.get(d);
      return !!dep && TASK_RESOLVED.includes(dep.status);
    });
  });
}

export interface PlanTaskUpdate {
  claimId: string;
  taskId: string;
  status: TaskStatus;
  note?: string;
  by?: string;
}

/**
 * Transactional outbox: the task's status change, its new action and (if the action hits a gate)
 * the approval request are written in ONE transaction, so no action can exist without its task.
 * Pass a session to join an outer transaction, or null to open one here.
 */
export async function planTaskWithAction(
  session: ClientSession | null,
  task: PlanTaskUpdate,
  action: NewAction,
  approval?: Omit<NewApproval, "actionId" | "claimId">,
): Promise<{ action: ActionDoc; approvalId: string | null }> {
  const run = async (s: ClientSession) => {
    const actions = await col.actions();
    const doc = buildActionDoc({ ...action, status: approval ? "awaiting_approval" : "planned" });
    const _id = new ObjectId();
    let approvalId: string | null = null;
    if (approval) {
      const aId = new ObjectId();
      approvalId = String(aId);
      doc.approvalId = approvalId;
      await (await col.approvals()).insertOne(
        { _id: aId, ...buildApprovalDoc({ ...approval, claimId: action.claimId, actionId: String(_id) }) },
        { session: s },
      );
    }
    await actions.insertOne({ _id, ...doc }, { session: s });
    const ok = await setTaskStatus(task.claimId, task.taskId, approval ? "awaiting_approval" : task.status, {
      by: task.by ?? "agent",
      note: task.note,
      session: s,
    });
    if (!ok) {
      const exists = await (await col.tasks()).findOne({ claimId: task.claimId, taskId: task.taskId }, { session: s });
      if (!exists) throw new Error(`planTaskWithAction: task ${task.claimId}/${task.taskId} does not exist`);
    }
    return { action: { _id, ...doc } as ActionDoc, approvalId };
  };
  return session ? run(session) : withTransaction(run);
}
