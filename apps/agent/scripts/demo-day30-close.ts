/** Scene 5 — Day 30: fast-forward the clock through the T15 settlement gate and T18 reconciliation. */
import { banner, check, claims, clock, decide, fileClaim, freshWorld, pendingApprovals, printHistory, printTasks, run, step, actions, tasks, waitFor } from "./lib.ts";

run("demo-day30-close", async () => {
  banner("Scene 5 · Day 30: fast-forward to settlement + reconciliation");
  await freshWorld({ claimDayMs: 6_000 });
  const id = await fileClaim({ injuries: true });
  const start = clock.now();
  step("Fast-forward: advance the sim clock a day at a time; approve claimant gates as they appear");
  const seen = new Set<string>();
  await waitFor(
    "claim closed (T18 confirmed)",
    async () => {
      for (const a of await pendingApprovals(id)) {
        if (seen.has(String(a._id))) continue;
        seen.add(String(a._id));
        if (a.approverRole === "claimant") await decide(a, "approved", "claimant:Dana Reyes");
      }
      const c = await claims.getClaim(id);
      if (c?.phase === "closed") return true;
      const ops = (await pendingApprovals(id)).filter((a) => a.approverRole === "operator");
      if (ops.length) throw new Error(`operator approval needed: ${ops.map((o) => `${o.gate}: ${o.request}`).join(" | ")}`);
      // Advance only while nothing is in flight, so the jump never skips a verification.
      if (!(await actions.listUnverified(id)).length && (await tasks.listTasks(id, { status: ["awaiting_approval"] })).length === 0) {
        await clock.advance(clock.DAY / 2);
      }
      return false;
    },
    300_000,
    2500,
  );
  const day = clock.claimDay(start);
  step(`Closed on claim day ${day}`);
  const rec = await claims.reconcileMoney(id);
  console.log(`   reconcileMoney: ${rec.itemCount} items, balanced=${rec.balanced}`);
  for (const g of rec.gaps) console.log(`     gap ${g.ref}: billed ${g.billed} / submitted ${g.submitted} / paid ${g.paid} -> ${g.gapReason}`);
  check(rec.balanced, "billed = submitted = paid, or every gap has a recorded reason");
  check((await actions.listUnverified(id)).length === 0, "no action left in sent/acknowledged");
  const c = await claims.getClaim(id);
  check(c!.phase === "closed", "claim phase = closed");
  for (const t of await tasks.listTasks(id)) check(["confirmed", "denied", "closed_by_human"].includes(t.status), `${t.taskId} ${t.status}`);
  console.log(`\n   compactSummary (${c!.compactSummary.length} chars): ${c!.compactSummary}`);
  await printTasks(id);
  await printHistory(id, (a) => ["T15", "T17"].includes(a.taskId) || a.taskId.startsWith("T12"));
});
