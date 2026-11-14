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
