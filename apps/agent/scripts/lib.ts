import { actions, approvals, claims, clock, closeDb, observations, readModels, setup, tasks, type ApprovalDoc } from "@claims/db";
import { config } from "../src/config.ts";

export const MOCKS = config.mocksUrl;
export const CONTROL = config.controlUrl;

export async function api<T = Record<string, unknown>>(method: "GET" | "POST", url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: T }> {
  const res = await fetch(url, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as T };
}

export function banner(title: string) {
  console.log(`\n${"=".repeat(78)}\n  ${title}\n${"=".repeat(78)}`);
}
export const step = (m: string) => console.log(`\n-> ${m}`);

export class DemoFailure extends Error {}
export function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new DemoFailure(msg);
  console.log(`   ok  ${msg}`);
}

/** Wipe claim data + mock state + clock, keeping seed data. Needs `pnpm --filter agent dev` running. */
export async function freshWorld(opts: { claimDayMs?: number } = {}) {
  const h = await api("GET", `${CONTROL}/health`).catch(() => null);
  if (!h || h.status !== 200) throw new DemoFailure(`agent control API not reachable at ${CONTROL}. Start it with: pnpm --filter agent dev`);
  await clock.initClock();
  await setup.resetDemoData();
  await api("POST", `${MOCKS}/chaos/reset`, {});
  await api("POST", `${MOCKS}/chaos/rental-webhook-drop-rate`, { rate: 0.5 });
  if (opts.claimDayMs) await clock.setSpeed(clock.DAY / opts.claimDayMs);
  const st = await api<{ workers: { running: unknown[] } | null }>("GET", `${CONTROL}/control/status`);
  if (!st.json.workers?.running.length) await api("POST", `${CONTROL}/control/start-worker`, {});
  // Every process caches the sim clock for 1 s: let them all pick up the reset before acting.
  await new Promise((r) => setTimeout(r, 2500));
  await clock.refresh();
  console.log(`   world reset; sim clock ${clock.now().toISOString()} (1 claim day = ${Math.round(clock.simToWallMs(clock.DAY) / 1000)} s)`);
}

export const DEMO_INTAKE = {
  claimant: { name: "Dana Reyes", phone: "+15550109999", email: "dana@example.com" },
  accident: { date: "2026-11-14", place: "Main St & 3rd Ave, Springfield", description: "I was stopped at a red light and a pickup truck rear-ended me.", otherDriver: { name: "J. Smith", plate: "7ABC123", insurer: "Other Mutual" }, policeReportNumber: "PR-55120", injuries: false },
  policyNumber: "POL-88812",
  vehicle: { vin: "1HGCM82633A004352", make: "Honda", model: "Accord", year: 2021, plate: "8XYZ999" },
  photos: ["damage-rear.jpg", "damage-bumper.jpg"],
};

export async function fileClaim(over: { injuries?: boolean } = {}): Promise<string> {
  const body = structuredClone(DEMO_INTAKE);
  if (over.injuries !== undefined) body.accident.injuries = over.injuries;
  const r = await api<{ claimId: string }>("POST", `${CONTROL}/control/claims`, body);
  if (r.status !== 201) throw new DemoFailure(`claim creation failed: ${JSON.stringify(r.json)}`);
  console.log(`   filed ${r.json.claimId}`);
  return r.json.claimId;
}

export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 120_000, everyMs = 500): Promise<T> {
  const start = Date.now();
  process.stdout.write(`   waiting: ${what} `);
  let dots = 0;
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) {
      process.stdout.write(`done (${((Date.now() - start) / 1000).toFixed(1)}s)\n`);
      return v as T;
    }
    if (++dots % 4 === 0) process.stdout.write(".");
    await new Promise((r) => setTimeout(r, everyMs));
  }
  process.stdout.write("TIMEOUT\n");
  throw new DemoFailure(`timed out after ${timeoutMs / 1000}s waiting for: ${what}`);
}

export async function taskStatus(claimId: string, taskId: string) {
  return (await tasks.getTask(claimId, taskId))?.status ?? null;
}
export const taskIs = (claimId: string, taskId: string, ...st: string[]) => async () => st.includes(String(await taskStatus(claimId, taskId)));

/** What the dashboard does: decide the approval doc AND insert an approval_ui observation. */
export async function decide(a: ApprovalDoc, decision: "approved" | "declined", by: string, note?: string) {
  await approvals.decideApproval(String(a._id), decision, by, note);
  await observations.insertObservation({ claimId: a.claimId, source: "approval_ui", kind: "approval_decision", body: { approvalId: String(a._id), actionId: a.actionId, decision, decidedBy: by, note: note ?? null } });
  console.log(`   ${by} ${decision}: ${a.gate} — "${a.request.slice(0, 90)}..."`);
}

export async function pendingApprovals(claimId: string) {
  return approvals.listApprovals(claimId, "pending");
}

/** Print the action history this demo produced (the audit trail). */
export async function printHistory(claimId: string, filter?: (a: { taskId: string }) => boolean) {
  const list = (await actions.listActions(claimId)).filter((a) => (filter ? filter(a) : true));
  console.log(`\n   Action history for ${claimId}:`);
  for (const a of list) {
    console.log(`   ${a.taskId.padEnd(16)} ${(a.system + "." + a.kind).padEnd(36)} key=${a.idempotencyKey}${a.supersedes ? ` supersedes=${a.supersedes.slice(-6)}` : ""}`);
    for (const h of a.history) console.log(`      ${h.status.padEnd(18)} sim ${h.at.toISOString().slice(5, 16)}  by ${h.by.padEnd(18)} ${h.note ?? ""}`);
  }
}

export async function printTasks(claimId: string) {
  const ov = await readModels.getClaimOverview(claimId);
  console.log(`\n   Tasks for ${claimId}:`);
  for (const t of ov?.tasks ?? []) console.log(`   ${t.taskId.padEnd(16)} ${t.status.padEnd(18)} ${t.title}${t.dependsOn.length ? `  <- ${t.dependsOn.join(",")}` : ""}`);
}

export async function run(name: string, fn: () => Promise<void>) {
  const started = Date.now();
  try {
    await fn();
    console.log(`\nPASS ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    await closeDb();
    process.exit(0);
  } catch (e) {
    console.error(`\nFAIL ${name}: ${e instanceof Error ? e.message : e}`);
    if (!(e instanceof DemoFailure)) console.error(e);
    await closeDb();
    process.exit(1);
  }
}

export { actions, approvals, claims, clock, observations, readModels, tasks };
