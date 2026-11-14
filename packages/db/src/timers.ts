import { ObjectId, type Document } from "mongodb";
import { collection } from "./database.js";
import { TimerSchema, type Timer } from "./schemas.js";

export async function dueTimers(simNow: Date): Promise<Timer[]> {
  return collection<Timer & Document>("timers").find({ fired: false, cancelled: false, dueAt: { $lte: simNow } }).sort({ dueAt: 1 }).toArray();
}
export async function createTimer(timer: Omit<Timer, "_id">): Promise<string> {
  const result = await collection("timers").insertOne(TimerSchema.parse(timer) as unknown as Document);
  return result.insertedId.toString();
}
export async function cancelTimersForTask(claimId: string, taskId: string): Promise<number> {
  return (await collection("timers").updateMany({ claimId, taskId, fired: false, cancelled: false }, { $set: { cancelled: true } })).modifiedCount;
}
export async function markFired(timerId: string): Promise<boolean> {
  const id = ObjectId.isValid(timerId) ? new ObjectId(timerId) : timerId;
  const result = await collection("timers").updateOne({ _id: id, fired: false, cancelled: false } as Document, { $set: { fired: true } });
  return result.modifiedCount === 1;
}
