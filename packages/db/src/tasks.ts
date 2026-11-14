import { type Document } from "mongodb";
import { collection } from "./database.js";
import type { Task } from "./schemas.js";

export async function findReadyTasks(claimId: string): Promise<Task[]> {
  const tasks = await collection<Task & Document>("tasks").find({ claimId } as Document).toArray();
  const confirmed = new Set(tasks.filter((task) => task.status === "confirmed").map((task) => task.taskId));
  return tasks.filter((task) => ["pending", "ready"].includes(task.status) && task.dependsOn.every((dependency) => confirmed.has(dependency))).map((task) => ({ ...task, status: "ready" }));
}

export async function updateTaskStatus(claimId: string, taskId: string, status: Task["status"], meta: { by: string; note?: string }, simAt: Date, wallAt = new Date()): Promise<boolean> {
  const task = collection("tasks");
  const result = await task.updateOne({ claimId, taskId }, { $set: { status, updatedAt: wallAt }, $push: { history: { status, at: simAt, wallAt, by: meta.by, ...(meta.note === undefined ? {} : { note: meta.note }) } } } as Document);
  return result.modifiedCount === 1;
}

export async function listTasks(claimId: string): Promise<Task[]> {
  return collection<Task & Document>("tasks").find({ claimId } as Document).sort({ taskId: 1 }).toArray();
}
