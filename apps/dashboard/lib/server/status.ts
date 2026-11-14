import type { AgentStatus } from "../types";
import { control } from "./agent";
import { getDb, plain } from "./db";

/** Agent status from GET /control/status (server-side only) plus the clock speed. */
export async function getAgentStatus(): Promise<AgentStatus> {
  const db = await getDb();
  const [r, clock] = await Promise.all([control<Omit<AgentStatus, "reachable">>("/control/status"), db.refreshClock()]);
  const speed = clock?.speed ?? undefined;
  if (!r.ok || !r.json) return { reachable: false, clock: { sim: db.nowSync().toISOString(), wall: new Date().toISOString() }, ...(speed ? { speed } : {}) };
  return plain({ reachable: true, ...r.json, ...(speed ? { speed } : {}) });
}
