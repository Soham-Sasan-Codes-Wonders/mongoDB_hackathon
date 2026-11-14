import { col } from "./collections.ts";
import { now } from "./clock.ts";

/** Record one call to an outside system (time-series collection `system_health`, ts = sim time). */
export async function recordHealth(s: { system: string; latencyMs: number; ok: boolean; errorCode?: string | null; endpoint?: string }): Promise<void> {
  await (await col.health()).insertOne({ ts: now(), system: s.system, latencyMs: s.latencyMs, ok: s.ok, errorCode: s.errorCode ?? null, endpoint: s.endpoint });
}

export async function getHealthSeries(system: string, sinceMs: number) {
  const since = new Date(now().getTime() - sinceMs);
  return (await col.health()).find({ system, ts: { $gte: since } }, { projection: { _id: 0 } }).sort({ ts: 1 }).limit(2000).toArray();
}

/** Error rate + p50-ish latency over a window, for drift detection and the dashboard. */
export async function healthSummary(system: string, sinceMs: number) {
  const since = new Date(now().getTime() - sinceMs);
  const [r] = await (await col.health())
    .aggregate<{ calls: number; errors: number; avgLatencyMs: number }>([
      { $match: { system, ts: { $gte: since } } },
      { $group: { _id: null, calls: { $sum: 1 }, errors: { $sum: { $cond: ["$ok", 0, 1] } }, avgLatencyMs: { $avg: "$latencyMs" } } },
      { $project: { _id: 0 } },
    ])
    .toArray();
  return r ? { ...r, errorRate: r.calls ? r.errors / r.calls : 0 } : { calls: 0, errors: 0, avgLatencyMs: 0, errorRate: 0 };
}
