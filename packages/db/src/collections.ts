import type { Collection, Document } from "mongodb";
import { getDb } from "./env.ts";
import type {
  Action, Approval, Claim, Contact, DocumentMeta, Experience, HealthSample, Lease, Observation, SimClock, Task, Timer,
} from "./schemas.ts";

export const COLLECTIONS = [
  "claims", "tasks", "actions", "observations", "timers", "leases", "approvals",
  "system_profiles", "experiences", "documents", "system_health", "contacts", "sim_clock", "worker_state", "counters",
] as const;

async function c<T extends Document>(name: string): Promise<Collection<T>> {
  return (await getDb()).collection<T>(name);
}

export const col = {
  claims: () => c<Claim>("claims"),
  tasks: () => c<Task>("tasks"),
  actions: () => c<Action>("actions"),
  observations: () => c<Observation>("observations"),
  timers: () => c<Timer>("timers"),
  leases: () => c<Lease>("leases"),
  approvals: () => c<Approval>("approvals"),
  profiles: () => c<Document>("system_profiles"),
  experiences: () => c<Experience>("experiences"),
  documents: () => c<DocumentMeta>("documents"),
  health: () => c<HealthSample>("system_health"),
  contacts: () => c<Contact>("contacts"),
  clock: () => c<SimClock>("sim_clock"),
  workerState: () => c<{ _id: string; resumeToken: unknown; savedAt: Date; savedSimAt?: Date | null }>("worker_state"),
  counters: () => c<{ _id: string; seq: number }>("counters"),
};
