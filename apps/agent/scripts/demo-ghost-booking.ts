/** Scene 2 — Ghost booking: rental returns 200 but stores nothing; read-back finds nothing; retry with the SAME key confirms. */
import { actions, api, banner, check, fileClaim, freshWorld, MOCKS, printHistory, run, step, taskIs, waitFor } from "./lib.ts";

run("demo-ghost-booking", async () => {
  banner("Scene 2 · Ghost booking (rental drops the next booking)");
  await freshWorld();
  step("Chaos: POST /chaos/rental-drop-next-booking");
  await api("POST", `${MOCKS}/chaos/rental-drop-next-booking`, {});
  const id = await fileClaim();
  await waitFor("T5 confirmed", taskIs(id, "T5", "confirmed"), 90_000);
  const [a] = await actions.listActions(id, { taskId: "T5" });
  check(!!a, "T5 has one action");
  const seq = a!.history.map((h) => h.status);
  console.log(`   history: ${seq.join(" -> ")}`);
  check(seq.indexOf("acknowledged") >= 0 && seq.indexOf("acknowledged") < seq.lastIndexOf("sent"), "acknowledged (HTTP 200) but then re-sent: the 200 was not trusted");
  check(a!.history.some((h) => /read-back: effect not found/.test(h.note ?? "")), "read-back found no reservation for the key (ghost)");
  check(a!.attempts === 2, `exactly one retry (attempts = ${a!.attempts})`);
  check(a!.history.filter((h) => h.status === "sent").every((h) => (h.note ?? "").includes(a!.idempotencyKey)), `every send used the same key ${a!.idempotencyKey}`);
  check(a!.status === "confirmed", "retry with the same key confirmed by read-back");
  const st = await api<{ reservations: { claimRef: string; key: string }[] }>("GET", `${MOCKS}/chaos/state`);
  const mine = st.json.reservations.filter((r) => r.claimRef === id);
  check(mine.length === 1, `exactly one reservation exists at the rental company (${mine.length})`);
  check(mine[0]!.key === a!.idempotencyKey, "and it carries our idempotency key");
  await printHistory(id, (x) => x.taskId === "T5");
});
