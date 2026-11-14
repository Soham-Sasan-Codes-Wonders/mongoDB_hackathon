import type { SimClock } from "./schemas.js";
import { type Document } from "mongodb";
import { collection, wallNow } from "./database.js";

export async function now(): Promise<Date> {
  const clock = await collection<SimClock>("sim_clock").findOne({ _id: "clock" });
  if (!clock) return wallNow();
  if (clock.paused) return clock.simEpoch;
  return new Date(clock.simEpoch.getTime() + (wallNow().getTime() - clock.wallEpoch.getTime()) * clock.speed);
}

export async function advance(ms: number): Promise<Date> {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError("advance(ms) requires a finite, non-negative duration");
  const clocks = collection<SimClock>("sim_clock");
  const current = await clocks.findOne({ _id: "clock" });
  const simNow = await now();
  const base: SimClock = current ? { ...current, simEpoch: new Date(simNow.getTime() + ms), wallEpoch: wallNow() } : { _id: "clock", simEpoch: new Date(simNow.getTime() + ms), wallEpoch: wallNow(), speed: 4320, paused: false };
  await clocks.replaceOne({ _id: "clock" }, base, { upsert: true });
  return base.simEpoch;
}

export async function setSpeed(speed: number): Promise<void> {
  if (!Number.isFinite(speed) || speed < 0) throw new RangeError("setSpeed(speed) requires a finite, non-negative speed");
  const clocks = collection<SimClock>("sim_clock");
  const simNow = await now();
  await clocks.updateOne({ _id: "clock" } as Document, { $set: { simEpoch: simNow, wallEpoch: wallNow(), speed, paused: speed === 0 } }, { upsert: true });
}

export async function pauseClock(paused: boolean): Promise<void> {
  const clocks = collection<SimClock>("sim_clock");
  const simNow = await now();
  const current = await clocks.findOne({ _id: "clock" });
  await clocks.updateOne({ _id: "clock" }, { $set: { simEpoch: simNow, wallEpoch: wallNow(), speed: current?.speed ?? 4320, paused } }, { upsert: true });
}

/* ---------------------------------------------------------------- cached clock (agent additions) */

export const DAY_MS = 86_400_000;
export const DEFAULT_SPEED = DAY_MS / 20_000; // 1 claim day = 20 s

let cached: SimClock | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

function compute(clock: SimClock | null, wall = wallNow()): Date {
  if (!clock) return wall;
  if (clock.paused) return clock.simEpoch;
  return new Date(clock.simEpoch.getTime() + (wall.getTime() - clock.wallEpoch.getTime()) * clock.speed);
}

/** Re-read the clock document into the in-process cache. */
export async function refreshClock(): Promise<SimClock | null> {
  const doc = await collection<SimClock>("sim_clock").findOne({ _id: "clock" });
  if (doc) cached = doc;
  return cached;
}

/**
 * Create the clock if missing and keep a cache refreshed every `refreshMs` (default 1 s), so
 * `nowSync()` costs no database round trip. Every process that calls nowSync() must call this first.
 */
export async function initClockCache(refreshMs = 1_000): Promise<SimClock> {
  const clocks = collection<SimClock>("sim_clock");
  if (!(await clocks.findOne({ _id: "clock" }))) {
    const start = new Date();
    start.setUTCHours(9, 0, 0, 0);
    await clocks.updateOne({ _id: "clock" }, { $setOnInsert: { _id: "clock", simEpoch: start, wallEpoch: wallNow(), speed: DEFAULT_SPEED, paused: false } }, { upsert: true });
  }
  await refreshClock();
  if (!refreshTimer && refreshMs > 0) {
    refreshTimer = setInterval(() => void refreshClock().catch(() => undefined), refreshMs);
    refreshTimer.unref();
  }
  return cached!;
}

/** Synchronous simulated now() from the cache (at most `refreshMs` stale across processes). */
export function nowSync(): Date {
  if (!cached) throw new Error("nowSync() called before initClockCache()");
  return compute(cached);
}

/** Wall milliseconds that `simMs` of simulated time takes at the current speed. */
export function simToWallMs(simMs: number): number {
  return simMs / (cached?.speed || DEFAULT_SPEED);
}

/** Restart the clock at 09:00 today (sim) at the default speed. */
export async function resetClock(speed = DEFAULT_SPEED): Promise<void> {
  const start = new Date();
  start.setUTCHours(9, 0, 0, 0);
  await collection<SimClock>("sim_clock").replaceOne({ _id: "clock" }, { simEpoch: start, wallEpoch: wallNow(), speed, paused: false }, { upsert: true });
  await refreshClock();
}

export function stopClockCache(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}
