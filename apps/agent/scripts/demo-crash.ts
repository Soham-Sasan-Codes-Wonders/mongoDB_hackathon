/** Scene 3 — Crash: kill the worker (SIGKILL), fire 3 webhooks, restart. Recovery picks them up from the resume token and re-sends nothing. */
import { actions, api, banner, check, CONTROL, fileClaim, freshWorld, MOCKS, observations, printHistory, run, step, taskIs, waitFor } from "./lib.ts";

const sends = (a: { history: { status: string }[] }) => a.history.filter((h) => h.status === "sent").length;

run("demo-crash", async () => {
  banner("Scene 3 · Crash: kill -9 the agent, 3 webhooks arrive, restart");
  await freshWorld();
  const id = await fileClaim();
  await waitFor("T5 and T6 confirmed", async () => (await taskIs(id, "T5", "confirmed")()) && (await taskIs(id, "T6", "confirmed")()), 90_000);
  await waitFor("no action in sent/acknowledged", async () => (await actions.listUnverified(id)).length === 0, 30_000);
  const before = new Map((await actions.listActions(id)).map((a) => [String(a._id), sends(a)]));

  step("Kill agent: POST /control/kill-worker (SIGKILL, no cleanup)");
  const k = await api<{ killed: { workerId: string; pid: number }[] }>("POST", `${CONTROL}/control/kill-worker`, {});
  check(k.json.killed.length >= 1, `killed ${k.json.killed.map((x) => `${x.workerId} (pid ${x.pid})`).join(", ")}`);
  await new Promise((r) => setTimeout(r, 1000));

  step("While it's down: POST /chaos/fire-webhooks {count: 3}");
  const f = await api<{ fired: number; events: string[] }>("POST", `${MOCKS}/chaos/fire-webhooks`, { count: 3, claimRef: id });
  check(f.json.fired === 3, `fired ${f.json.events.join(", ")}`);
  await new Promise((r) => setTimeout(r, 1500));
  const waiting = (await observations.listUnprocessed(id)).length;
  check(waiting >= 3, `${waiting} observations stored, unprocessed (nobody is awake)`);

  step("Restart: POST /control/start-worker");
  await api("POST", `${CONTROL}/control/start-worker`, {});
  await waitFor("all observations processed", async () => (await observations.listUnprocessed(id)).length === 0, 60_000);
  const status = await api<{ workerState: { workerId: string; replayedFromToken: number }[] }>("GET", `${CONTROL}/control/status`);
  await new Promise((r) => setTimeout(r, 3500)); // one heartbeat
  const st2 = await api<{ workerState: { workerId: string; replayedFromToken: number }[] }>("GET", `${CONTROL}/control/status`);
  const replayed = Math.max(...st2.json.workerState.map((w) => w.replayedFromToken ?? 0), ...status.json.workerState.map((w) => w.replayedFromToken ?? 0));
  check(replayed >= 3, `${replayed} events delivered from the saved resume token`);
  const obs = (await observations.listObservations(id)).filter((o) => ["insurer", "body_shop", "rental"].includes(o.source) && /status/.test(o.kind)).slice(0, 3);
  for (const o of obs) console.log(`   processed ${o.source}.${o.kind} by ${o.processedBy}: ${o.note}`);

  step("Nothing was re-sent");
  for (const a of await actions.listActions(id)) {
    const b = before.get(String(a._id));
    if (b !== undefined) check(sends(a) === b, `${a.taskId} ${a.kind}: ${b} send(s) before, ${sends(a)} after`);
  }
  await printHistory(id, (a) => ["T2", "T5", "T6"].includes(a.taskId));
});
