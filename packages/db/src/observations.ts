import { ObjectId, type ChangeStream, type ChangeStreamDocument, type Document } from "mongodb";
import { collection } from "./database.js";
import { ObservationSchema, type Observation, type WorkerState } from "./schemas.js";

export async function insertObservation(observation: Observation): Promise<string> {
  const result = await collection("observations").insertOne(ObservationSchema.parse(observation) as unknown as Document);
  return result.insertedId!.toString();
}

export function watchObservations(resumeToken?: Document): ChangeStream<ChangeStreamDocument<Document>> {
  return collection("observations").watch([{ $match: { "ns.coll": "observations" } }], resumeToken ? { resumeAfter: resumeToken } : {});
}

export async function saveResumeToken(workerId: string, token: Document): Promise<void> {
  await collection<WorkerState & Document>("worker_state").updateOne({ _id: workerId }, { $set: { resumeToken: token, updatedAt: new Date() } }, { upsert: true });
}

export async function loadResumeToken(workerId: string): Promise<Document | undefined> {
  return (await collection<WorkerState & Document>("worker_state").findOne({ _id: workerId }))?.resumeToken;
}

/* ---------------------------------------------------------------- agent additions */

export type ObservationDoc = Observation & { _id: ObjectId };
const oid = (id: string | ObjectId) => (typeof id === "string" && ObjectId.isValid(id) ? new ObjectId(id) : id);

export async function listUnprocessed(claimId: string): Promise<ObservationDoc[]> {
  return collection<ObservationDoc>("observations").find({ claimId, processedAt: { $exists: false } }).sort({ receivedAt: 1, _id: 1 }).toArray();
}
export async function listObservations(claimId: string, limit = 200): Promise<ObservationDoc[]> {
  return collection<ObservationDoc>("observations").find({ claimId }).sort({ receivedAt: -1, _id: -1 }).limit(limit).toArray();
}
export async function getObservation(id: string | ObjectId): Promise<ObservationDoc | null> {
  return collection<ObservationDoc>("observations").findOne({ _id: oid(id) } as Document);
}
/** Mark processed; also records which action it matched and whether it was verified. */
export async function markProcessed(id: string | ObjectId, by: string, processedAt: Date, set: { matchedActionId?: string; verified?: boolean; note?: string } = {}): Promise<void> {
  await collection("observations").updateOne({ _id: oid(id) } as Document, { $set: { processedAt, processedBy: by, ...set } });
}
export async function updateObservationFields(id: string | ObjectId, set: { verified?: boolean; note?: string }): Promise<void> {
  await collection("observations").updateOne({ _id: oid(id) } as Document, { $set: set });
}
export async function claimsWithUnprocessed(): Promise<string[]> {
  return (await collection("observations").distinct("claimId", { processedAt: { $exists: false } })) as string[];
}
/** Worker liveness for GET /control/status. */
export async function saveWorkerHeartbeat(workerId: string, info: { pid: number; held: string[]; replayed: number; startedAt: Date }): Promise<void> {
  await collection<WorkerState & Document>("worker_state").updateOne({ _id: workerId }, { $set: { heartbeatAt: new Date(), ...info }, $setOnInsert: { updatedAt: new Date() } }, { upsert: true });
}
export async function listWorkerStates(): Promise<WorkerState[]> {
  return collection<WorkerState & Document>("worker_state").find({}).toArray();
}
