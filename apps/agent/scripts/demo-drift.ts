/** Scene 4 — Drift: insurer renames policyNumber -> policy_ref and requires photos. Mapping auto-applies (or is gated); a new task blocks T9. */
import { profiles } from "../src/db.ts";
import { actions, api, banner, check, decide, fileClaim, freshWorld, MOCKS, pendingApprovals, printHistory, printTasks, run, step, taskIs, tasks, waitFor } from "./lib.ts";

run("demo-drift", async () => {
  banner("Scene 4 · Drift: rename policyNumber + require photos");
  await freshWorld({ claimDayMs: 8_000 });
  const id = await fileClaim();
  await waitFor("T6 confirmed (body shop booked)", taskIs(id, "T6", "confirmed"), 60_000);

  step("Chaos: rename insurer policyNumber -> policy_ref, and require a 'photos' step before approval");
  await api("POST", `${MOCKS}/chaos/rename-field`, { system: "insurer", from: "policyNumber", to: "policy_ref" });
  await api("POST", `${MOCKS}/chaos/require-step`, { system: "insurer", step: "photos" });

  // Below the confidence threshold the proposal is gated (drift_mapping): approve it as the operator would.
  const gated: string[] = [];
  await waitFor("drift handled: T9a#photos exists (auto-applied or operator-approved)", async () => {
    for (const a of (await pendingApprovals(id)).filter((x) => x.gate === "drift_mapping")) {
      gated.push(String(a._id));
      await decide(a, "approved", "operator:demo");
    }
    return !!(await tasks.getTask(id, "T9a#photos"));
  }, 120_000);
  await waitFor("T8 confirmed (estimate submitted after the mapping)", async () => {
    for (const a of (await pendingApprovals(id)).filter((x) => x.gate === "drift_mapping")) {
      gated.push(String(a._id));
      await decide(a, "approved", "operator:demo");
    }
    return taskIs(id, "T8", "confirmed")();
  }, 120_000);
  await waitFor("T9a#photos confirmed", taskIs(id, "T9a#photos", "confirmed"), 120_000);
  await waitFor("T9 confirmed (insurer approved)", taskIs(id, "T9", "confirmed"), 120_000);

  step("Checks");
  const t9 = await tasks.getTask(id, "T9");
  check(t9!.dependsOn.includes("T9a#photos"), `T9.dependsOn = [${t9!.dependsOn.join(", ")}]`);
  const p = await profiles.getLatestProfile("insurer");
  check((p?.version ?? 1) >= 2 && p!.fieldMap?.policyNumber === "policy_ref", `insurer profile v${p?.version}: fieldMap ${JSON.stringify(p?.fieldMap)}`);
  check(p!.workflowSteps.includes("photos"), `workflow steps now: ${p!.workflowSteps.join(" > ")}`);
  const t8 = await actions.listActions(id, { taskId: "T8" });
  check(t8.length === 1, "T8 kept ONE action (same key) through the drift");
  const sentNotes = t8[0]!.history.filter((h) => h.status === "sent").map((h) => h.note ?? "");
  if (t8[0]!.history.some((h) => /validation/.test(h.note ?? ""))) {
    check(true, "T8's first send hit a validation error (drift trigger)");
    check(sentNotes.length >= 2 && sentNotes.every((n) => n.includes(t8[0]!.idempotencyKey)), `retried with the same key ${t8[0]!.idempotencyKey} (${sentNotes.length} sends)`);
  } else {
    check(sentNotes.every((n) => /profile v[2-9]/.test(n)), "the requirement_added webhook triggered drift first, so T8 went out already mapped (profile v2+)");
  }
  console.log(`   auto-applied: ${gated.length ? "no (operator approved a gated proposal)" : "yes (confidence >= threshold)"}`);
  await printTasks(id);
  await printHistory(id, (a) => ["T8", "T9a#photos"].includes(a.taskId));
});
