import { ObjectId } from "mongodb";
import {
  actions, claims, clock, closeDb, col, documents, experiences, IllegalTransitionError, mintIdempotencyKey, planTaskWithAction, profiles, tasks,
} from "../src/index.ts";

const ok = (m: string) => console.log(`[db:smoke] ok  ${m}`);
const fail = (m: string) => {
  console.error(`[db:smoke] FAIL ${m}`);
  process.exitCode = 1;
};

await clock.initClock({ refreshMs: 0 });
const id = `CLM-${900000 + Math.floor(Math.random() * 99999)}`;
try {
  await claims.createClaim({
    _id: id,
    claimant: { name: "Smoke Test", firstName: "Smoke", phone: "+15550000000", email: null },
    parties: { otherDriver: null },
    vehicle: { vin: "SMOKE" },
    policy: { number: "POL-SMOKE", insurer: "Acme", rentalDailyLimit: null, rentalMaxDays: null },
    accident: { date: "2026-11-14", place: "test", description: "test", policeReportNumber: null, injuries: false },
  });
  ok("claim inserted");
  await tasks.insertTasks([{ claimId: id, taskId: "T1", type: "collect_details", title: "smoke", track: "intake", dependsOn: [] }]);
  const key = mintIdempotencyKey(id, "T1", "smoke", 1);
  const { action } = await planTaskWithAction(null, { claimId: id, taskId: "T1", status: "in_progress" }, {
    claimId: id, taskId: "T1", system: "internal", kind: "smoke", idempotencyKey: key, payload: {}, expectedEffect: { ok: true }, verifyBy: "readback", deadline: clock.now(),
  });
  ok("planTaskWithAction (transaction)");
  for (const s of ["sent", "acknowledged", "confirmed"] as const) await actions.transitionAction(action._id, s, { by: "smoke" });
  const after = await actions.getAction(action._id);
  after?.history.map((h) => h.status).join(",") === "planned,sent,acknowledged,confirmed" ? ok("planned -> sent -> acknowledged -> confirmed") : fail(`history ${after?.history.map((h) => h.status)}`);
  try {
    await actions.transitionAction(action._id, "sent", { by: "smoke" });
    fail("confirmed -> sent was allowed");
  } catch (e) {
    e instanceof IllegalTransitionError ? ok("illegal transition rejected") : fail(String(e));
  }
  try {
    await (await col.actions()).insertOne({ claimId: id, taskId: "T1", system: "internal", kind: "bad", idempotencyKey: `${key}:bad`, payload: {}, verifyBy: "readback", status: "planned", attempts: 0, deadline: new Date(), history: [] } as never);
    fail("validator accepted an action without expectedEffect");
  } catch (e) {
    (e as { code?: number }).code === 121 ? ok("validator rejects action without expectedEffect") : fail(String(e));
  }
  const m = await profiles.matchCanonicalField("insurer field policy_ref (string): policy reference. samples: POL-88812", 1);
  m[0]?.fieldName === "policyNumber" ? ok(`vector: policy_ref -> ${m[0].fieldName} (${m[0].score.toFixed(3)})`) : fail(`vector match ${JSON.stringify(m)}`);
  const ex = await experiences.findSimilarExperiences("rental said OK but nothing was stored", { system: "rental" }, 1);
  ex.length ? ok(`experience search: "${ex[0]!.problem.slice(0, 50)}..."`) : fail("no experiences (did you run db:seed?)");
  await documents.putDocument({ claimId: id, docType: "call_transcript", source: "smoke", extractedText: "the estimate is approved says the adjuster" });
  const hits = await documents.searchDocuments(id, "approved");
  hits.length ? ok("text search") : console.log("[db:smoke] note: text search returned nothing (Atlas Search index may still be syncing)");
  const rec = await claims.reconcileMoney(id);
  rec.balanced ? ok("reconcileMoney (empty)") : fail("reconcile");
} finally {
  for (const c of ["claims", "tasks", "actions", "documents"] as const) {
    const coll = await (col as unknown as Record<string, () => Promise<import("mongodb").Collection>>)[c]!();
    await coll.deleteMany(c === "claims" ? { _id: id as unknown as ObjectId } : { claimId: id });
  }
  ok("cleaned up");
  await closeDb();
}
