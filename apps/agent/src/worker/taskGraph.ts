import type { TaskDoc } from "../db.ts";

export type NewTask = Pick<TaskDoc, "claimId" | "taskId" | "type" | "title" | "track" | "dependsOn"> & { isWait?: boolean; trigger?: string };

/**
 * The doc's task graph (T1–T18). T13/T14 are not seeded: one copy of each is created per clinic
 * invoice (T13#INV-x, T14#INV-x) and wired into T18. T12 is armed by the `rental_expiring` timer
 * (see handlers) and resolves once T11 proves the car is ready.
 */
export const TASK_TEMPLATES: Omit<NewTask, "claimId">[] = [
  { taskId: "T1", type: "collect_details", title: "Collect accident details", track: "intake", dependsOn: [] },
  { taskId: "T2", type: "open_claim", title: "Open the claim (first notice of loss)", track: "intake", dependsOn: ["T1"] },
  { taskId: "T3", type: "adjuster_assigned", title: "Adjuster assigned", track: "repair", dependsOn: ["T2"], isWait: true },
  { taskId: "T4", type: "rental_coverage", title: "Check rental coverage", track: "rental", dependsOn: ["T2"] },
  { taskId: "T5", type: "book_rental", title: "Book the rental", track: "rental", dependsOn: ["T4"] },
  { taskId: "T6", type: "book_body_shop", title: "Book the body shop", track: "repair", dependsOn: ["T2"] },
  { taskId: "T7", type: "repair_estimate", title: "Get the repair estimate", track: "repair", dependsOn: ["T6"], isWait: true },
  { taskId: "T8", type: "submit_estimate", title: "Submit the estimate", track: "repair", dependsOn: ["T3", "T7"] },
  { taskId: "T9", type: "estimate_approved", title: "Estimate approved", track: "repair", dependsOn: ["T8"], isWait: true },
  { taskId: "T10", type: "authorize_repair", title: "Authorize the repair", track: "repair", dependsOn: ["T9"] },
  { taskId: "T11", type: "track_repair", title: "Track the repair", track: "repair", dependsOn: ["T10"], isWait: true },
  { taskId: "T12", type: "extend_rental", title: "Extend the rental if needed", track: "rental", dependsOn: ["T5"], trigger: "rental_expiring" },
  { taskId: "T15", type: "settle_repair", title: "Settle the repair", track: "close", dependsOn: ["T11"] },
  { taskId: "T16", type: "car_picked_up", title: "Car picked up", track: "repair", dependsOn: ["T15"], isWait: true },
  { taskId: "T17", type: "return_rental", title: "Return the rental", track: "rental", dependsOn: ["T16"] },
  {
    taskId: "T18",
    type: "reconcile_close",
    title: "Reconcile and close",
    track: "close",
    dependsOn: ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12", "T15", "T16", "T17"],
  },
];

export function seedTasks(claimId: string): NewTask[] {
  return TASK_TEMPLATES.map((t) => ({ ...t, claimId, dependsOn: [...t.dependsOn] }));
}

export const medicalTaskIds = (invoiceId: string) => ({ submit: `T13#${invoiceId}`, paid: `T14#${invoiceId}` });

/** Numeric rank for deterministic ordering (T9a#photos sorts right before T9). */
export function taskRank(taskId: string): number {
  const m = taskId.match(/^T(\d+)([a-z])?/);
  if (!m) return 99;
  return Number(m[1]) - (m[2] ? 0.5 : 0);
}
