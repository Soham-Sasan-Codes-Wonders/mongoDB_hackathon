const DAY = 86_400_000;

/** "Day 4, 14:00" relative to the claim's sim start. */
export function simDay(at: string | Date, since: string | Date): string {
  const a = new Date(at).getTime();
  const s = new Date(since).getTime();
  const d = Math.floor((a - s) / DAY);
  const t = new Date(at).toISOString().slice(11, 16);
  return `Day ${d}, ${t}`;
}

/** Sim duration until a time, e.g. "in 1d 4h" / "2h ago". */
export function simUntil(at: string, now: string): string {
  const ms = new Date(at).getTime() - new Date(now).getTime();
  const abs = Math.abs(ms);
  const d = Math.floor(abs / DAY);
  const h = Math.floor((abs % DAY) / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const txt = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  return ms >= 0 ? `in ${txt}` : `${txt} ago`;
}

export const wall = (at?: string) => (at ? `wall ${new Date(at).toLocaleTimeString()}` : "");
