import { ObjectId, type ChangeStream, type ChangeStreamInsertDocument, type ResumeToken, type WithId } from "mongodb";
import { col } from "./collections.ts";
import { now } from "./clock.ts";
import { Observation } from "./schemas.ts";

export type ObservationDoc = WithId<Observation>;

export interface NewObservation {
  claimId: string;
  source: Observation["source"];
  kind: string;
  body: Record<string, unknown>;
  trust?: Observation["trust"];
  verified?: boolean | null;
  matchedActionId?: string | null;
  /** Insert already processed (outbound agent messages that shouldn't wake the loop). */
  processed?: boolean;
  note?: string;
}

export async function insertObservation(o: NewObservation): Promise<string> {
  const at = now();
  const doc = Observation.parse({
    claimId: o.claimId,
    source: o.source,
    kind: o.kind,
    body: o.body,
    matchedActionId: o.matchedActionId ?? null,
    verified: o.verified ?? null,
    trust: o.trust ?? null,
    receivedAt: at,
    receivedWallAt: new Date(),
    processedAt: o.processed ? at : null,
    processedBy: o.processed ? "outbound" : null,
    note: o.note ?? null,
  });
  const res = await (await col.observations()).insertOne(doc);
  return String(res.insertedId);
}

export async function listUnprocessed(claimId: string): Promise<ObservationDoc[]> {
  return (await col.observations()).find({ claimId, processedAt: null }).sort({ receivedAt: 1, _id: 1 }).toArray();
}

export async function listObservations(claimId: string, limit = 200): Promise<ObservationDoc[]> {
  return (await col.observations()).find({ claimId }).sort({ receivedAt: -1, _id: -1 }).limit(limit).toArray();
}

export async function markProcessed(
  id: string | ObjectId,
  by: string,
  set: { matchedActionId?: string | null; verified?: boolean | null; note?: string | null } = {},
): Promise<void> {
  const _id = typeof id === "string" ? new ObjectId(id) : id;
  await (await col.observations()).updateOne({ _id }, { $set: { processedAt: now(), processedBy: by, ...set } });
}

export async function updateObservation(id: string | ObjectId, set: Partial<Observation>): Promise<void> {
  const _id = typeof id === "string" ? new ObjectId(id) : id;
  await (await col.observations()).updateOne({ _id }, { $set: set });
}

/** Claims that have unprocessed observations (startup safety net next to the resume token). */
export async function claimsWithUnprocessed(): Promise<string[]> {
  return (await col.observations()).distinct("claimId", { processedAt: null });
}

/**
 * Change stream on `observations` inserts. M0 limits change-stream filters on db names, so this
 * filters on the collection only (by opening the stream on the collection) and operationType.
 */
export async function watchObservations(resumeToken?: ResumeToken | null): Promise<ChangeStream<Observation, ChangeStreamInsertDocument<Observation>>> {
  const c = await col.observations();
  return c.watch<Observation, ChangeStreamInsertDocument<Observation>>([{ $match: { operationType: "insert" } }], {
    ...(resumeToken ? { resumeAfter: resumeToken } : {}),
    fullDocument: "default",
  });
}

export async function saveResumeToken(workerId: string, token: ResumeToken): Promise<void> {
  let simAt: Date | null = null;
  try {
    simAt = now();
  } catch {
    simAt = null;
  }
  await (await col.workerState()).updateOne(
    { _id: workerId },
    { $set: { resumeToken: token, savedAt: new Date(), savedSimAt: simAt } },
    { upsert: true },
  );
}

export async function loadResumeToken(workerId: string): Promise<ResumeToken | null> {
  const doc = await (await col.workerState()).findOne({ _id: workerId });
  return (doc?.resumeToken as ResumeToken) ?? null;
}

export async function listWorkerStates() {
  return (await col.workerState()).find({}).toArray();
}

/** Worker liveness (for GET /control/status). */
export async function saveWorkerHeartbeat(workerId: string, info: Record<string, unknown>): Promise<void> {
  await (await col.workerState()).updateOne({ _id: workerId }, { $set: { heartbeatAt: new Date(), ...info } }, { upsert: true });
}
