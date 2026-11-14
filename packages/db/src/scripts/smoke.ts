import assert from "node:assert/strict";
import { ObjectId, MongoServerError } from "mongodb";
import { client, closeDatabase, collection } from "../database.js";
import { setupDatabase } from "../setup.js";
import { planTaskWithAction, transitionAction, mintIdempotencyKey } from "../actions.js";
import { matchCanonicalField } from "../search.js";
import { searchDocuments } from "../documents.js";
import type { Claim, Task, Action } from "../schemas.js";

const claimId = `CLM-SMOKE-${new ObjectId().toHexString()}`;
let atlasSearchAvailable = false;
try {
  await client.connect();
  await setupDatabase();
  const stamp = new Date();
  const claim: Claim = { _id: claimId, claimant: { name: "Smoke Test" }, parties: { claimant: "Smoke Test", insurer: "Test Insurer" }, vehicle: { make: "Test", model: "Car" }, policy: { number: "TEST-POLICY", insurer: "Test Insurer", rentalDailyLimit: 40, rentalMaxDays: 10 }, phase: "intake", compactSummary: "Temporary database smoke test claim.", money: { totals: [], items: [] }, createdAt: stamp };
  await collection<Claim>("claims").insertOne(claim);
  const task: Task = { claimId, taskId: "T5", type: "Book the rental", track: "rental", dependsOn: [], status: "ready", history: [] };
  const action: Action = { claimId, taskId: "T5", system: "rental", kind: "create_reservation", idempotencyKey: mintIdempotencyKey(claimId, "T5", "create_reservation", 1), payload: { vehicleClass: "compact", days: 2 }, expectedEffect: { reservationExistsWithKey: true, days: 2 }, verifyBy: "readback", status: "planned", attempts: 0, deadline: new Date(Date.now() + 60_000), history: [{ status: "planned", at: stamp, wallAt: stamp, by: "smoke", note: "Action planned" }] };
  const session = client.startSession();
  let actionId: string | ObjectId;
  try { actionId = await planTaskWithAction(session, task, action); } finally { await session.endSession(); }
  await transitionAction(actionId, "sent", { by: "smoke" });
  await transitionAction(actionId, "acknowledged", { by: "smoke", note: "Mock API returned OK" });
  await transitionAction(actionId, "confirmed", { by: "smoke", note: "Read-back verified" });
  const saved = await collection("actions").findOne({ _id: actionId } as import("mongodb").Document);
  assert.equal(saved?.status, "confirmed");
  assert.equal((saved?.history as unknown[]).length, 4);

  let validatorRejected = false;
  try {
    await collection("actions").insertOne({ claimId, taskId: "T6", system: "rental", kind: "invalid", idempotencyKey: `${claimId}:T6:invalid:1`, payload: {}, verifyBy: "readback", status: "planned", attempts: 1, deadline: stamp, history: [] });
  } catch (error) {
    validatorRejected = error instanceof MongoServerError && error.code === 121;
  }
  assert.equal(validatorRejected, true, "MongoDB validator must reject actions without expectedEffect");

  try {
    const names = await collection("system_profiles").listSearchIndexes().toArray() as Array<{ name: string; queryable?: boolean; status?: string }>;
    atlasSearchAvailable = names.some((index) => index.name === "system_profiles_vector" && index.queryable === true);
  } catch { atlasSearchAvailable = false; }
  if (atlasSearchAvailable) {
    await matchCanonicalField("policy identifier", 1);
    await searchDocuments(claimId, "smoke test");
    console.log("Atlas Vector Search and Atlas Search smoke checks passed.");
  } else {
    console.log("Atlas Vector Search and Atlas Search skipped: this server has no queryable Atlas Search indexes (expected for a local replica set).");
  }
  console.log("Database smoke checks passed.");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await collection("actions").deleteMany({ claimId }).catch(() => undefined);
  await collection("tasks").deleteMany({ claimId }).catch(() => undefined);
  await collection("claims").deleteOne({ _id: claimId } as import("mongodb").Document).catch(() => undefined);
  await closeDatabase();
}
