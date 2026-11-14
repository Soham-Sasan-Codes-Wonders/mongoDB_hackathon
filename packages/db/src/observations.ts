import { type ChangeStream, type ChangeStreamDocument, type Document } from "mongodb";
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
