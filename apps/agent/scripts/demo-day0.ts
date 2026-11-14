/** Scene 1 — Day 0: a claim is filed; T1–T6 run; actions visibly go sent -> acknowledged -> confirmed. */
import { actions, banner, check, fileClaim, freshWorld, printHistory, printTasks, run, step, taskIs, waitFor } from "./lib.ts";

run("demo-day0", async () => {
  banner("Scene 1 · Day 0: claim filed, T1–T6, proof not responses");
  await freshWorld();
  step("File the claim (dashboard intake form -> POST /control/claims)");
  const id = await fileClaim();
  for (const t of ["T1", "T2", "T4", "T5", "T6", "T3"]) await waitFor(`${t} confirmed`, taskIs(id, t, "confirmed"), 90_000);
  step("Check every outbound action moved planned -> sent -> acknowledged -> confirmed");
  const list = (await actions.listActions(id)).filter((a) => ["T2", "T4", "T5", "T6"].includes(a.taskId));
  check(list.length >= 4, `${list.length} actions for T2/T4/T5/T6`);
  for (const a of list) {
    const seq = a.history.map((h) => h.status);
    const ack = seq.indexOf("acknowledged");
    const conf = seq.lastIndexOf("confirmed");
    check(a.status === "confirmed" && seq[0] === "planned" && seq.includes("sent") && (ack === -1 || ack < conf), `${a.taskId} ${a.kind}: ${seq.join(" -> ")}`);
    check(a.history.some((h) => h.status === "confirmed" && /read-back/.test(h.note ?? "")), `${a.taskId} confirmed by a read-back, not by the HTTP 200`);
  }
  await printTasks(id);
  await printHistory(id, (a) => ["T2", "T4", "T5", "T6"].includes(a.taskId));
});
