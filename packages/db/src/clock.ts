import { col } from "./collections.ts";
import type { SimClock } from "./schemas.ts";

/** Wall ms per simulated claim day. Default: 1 claim day = 20 s. */
export const DEFAULT_CLAIM_DAY_MS = Number(process.env.CLAIM_DAY_MS ?? 20_000);
export const DAY = 86_400_000;
export const HOUR = 3_600_000;

let cached: SimClock | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

function compute(c: SimClock, wallNow = Date.now()): number {
  if (c.paused) return c.simEpoch;
  return c.simEpoch + (wallNow - c.wallEpoch) * c.speed;
}

/** Default sim speed (sim ms per wall ms). */
export function defaultSpeed(claimDayMs = DEFAULT_CLAIM_DAY_MS): number {
  return DAY / claimDayMs;
}

/** Load (creating if needed) the singleton clock and keep a 1 s refreshed cache so now() is synchronous. */
export async function initClock(opts: { refreshMs?: number } = {}): Promise<SimClock> {
  const clocks = await col.clock();
  let doc = await clocks.findOne({ _id: "clock" });
  if (!doc) {
    // Sim time starts at 09:00 on the real current date so "Day 0" reads naturally.
    const start = new Date();
    start.setUTCHours(9, 0, 0, 0);
    const fresh: SimClock = { _id: "clock", simEpoch: start.getTime(), wallEpoch: Date.now(), speed: defaultSpeed(), paused: false };
    await clocks.updateOne({ _id: "clock" }, { $setOnInsert: fresh }, { upsert: true });
    doc = (await clocks.findOne({ _id: "clock" }))!;
  }
  cached = doc;
  if (!refreshTimer && opts.refreshMs !== 0) {
    refreshTimer = setInterval(() => {
      refresh().catch(() => undefined);
    }, opts.refreshMs ?? 1000);
    refreshTimer.unref();
  }
  return doc;
}

export async function refresh(): Promise<SimClock | null> {
  const doc = await (await col.clock()).findOne({ _id: "clock" });
  if (doc) cached = doc;
  return cached;
}

export function stopClock() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

/** Current simulated time. The ONLY source of business time. Requires initClock(). */
export function now(): Date {
  if (!cached) throw new Error("clock.now() called before clock.initClock()");
  return new Date(compute(cached));
}

export function nowMs(): number {
  return now().getTime();
}

/** Fast-forward the simulated clock by `ms` (powers the dashboard's "Fast-forward clock" button). */
export async function advance(ms: number): Promise<Date> {
  await refresh();
  const simNow = cached ? compute(cached) : Date.now();
  const next = { simEpoch: simNow + ms, wallEpoch: Date.now() };
  await (await col.clock()).updateOne({ _id: "clock" }, { $set: next });
  await refresh();
  return now();
}

export async function setSpeed(speed: number): Promise<void> {
  await refresh();
  const simNow = cached ? compute(cached) : Date.now();
  await (await col.clock()).updateOne({ _id: "clock" }, { $set: { simEpoch: simNow, wallEpoch: Date.now(), speed } });
  await refresh();
}

export async function setPaused(paused: boolean): Promise<void> {
  await refresh();
  const simNow = cached ? compute(cached) : Date.now();
  await (await col.clock()).updateOne({ _id: "clock" }, { $set: { simEpoch: simNow, wallEpoch: Date.now(), paused } });
  await refresh();
}

export async function resetClock(): Promise<void> {
  await (await col.clock()).deleteOne({ _id: "clock" });
  cached = null;
  await initClock();
}

/** Claim day index of `at` relative to `since` (Day 0, Day 1, ...). */
export function claimDay(since: Date, at: Date = now()): number {
  return Math.floor((at.getTime() - since.getTime()) / DAY);
}

/** Convert a simulated duration into wall ms at the current speed. */
export function simToWallMs(simMs: number): number {
  const speed = cached?.speed ?? defaultSpeed();
  return simMs / speed;
}
