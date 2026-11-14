/** Status -> color role + icon + label. Color never carries meaning alone. */
export interface StatusLook { color: string; icon: string; label: string }

const v = (name: string) => `var(--st-${name})`;

export const ACTION_LOOK: Record<string, StatusLook> = {
  planned: { color: v("idle"), icon: "○", label: "Planned" },
  awaiting_approval: { color: v("approval"), icon: "⏸", label: "Awaiting approval" },
  approved: { color: v("approval"), icon: "✓", label: "Approved" },
  sent: { color: v("sent"), icon: "↗", label: "Sent" },
  acknowledged: { color: v("acknowledged"), icon: "◐", label: "Acknowledged · not proof" },
  confirmed: { color: v("confirmed"), icon: "✔", label: "Confirmed · proven" },
  rejected: { color: v("critical"), icon: "✕", label: "Rejected" },
  failed: { color: v("critical"), icon: "⚠", label: "Failed" },
  cancelled: { color: v("idle"), icon: "⊘", label: "Cancelled" },
  closed_by_human: { color: v("human"), icon: "✋", label: "Closed by human" },
};

export const TASK_LOOK: Record<string, StatusLook> = {
  pending: { color: v("idle"), icon: "○", label: "Pending" },
  ready: { color: v("idle"), icon: "◎", label: "Ready" },
  in_progress: { color: v("sent"), icon: "↻", label: "In progress" },
  waiting: { color: v("acknowledged"), icon: "◐", label: "Waiting" },
  blocked_drift: { color: v("critical"), icon: "⚠", label: "Blocked (drift)" },
  awaiting_approval: { color: v("approval"), icon: "⏸", label: "Needs approval" },
  confirmed: { color: v("confirmed"), icon: "✔", label: "Confirmed" },
  denied: { color: v("critical"), icon: "✕", label: "Denied" },
  closed_by_human: { color: v("human"), icon: "✋", label: "Closed by human" },
};

export const look = (map: Record<string, StatusLook>, s: string): StatusLook => map[s] ?? { color: v("idle"), icon: "?", label: s };

/** The happy path the action stepper draws. */
export const ACTION_PATH = ["planned", "sent", "acknowledged", "confirmed"] as const;

export const SOURCE_LABEL: Record<string, string> = {
  insurer: "Insurer", body_shop: "Body shop", rental: "Rental", clinic: "Clinic", claimant: "Claimant", approval_ui: "Approval UI", phone: "Phone", system: "Agent",
};

export const GATE_LABEL: Record<string, string> = {
  accept_settlement: "Accept settlement offer",
  sign_release: "Sign the release",
  discuss_fault: "Statement about fault",
  rental_overage: "Rental days beyond coverage",
  drift_mapping: "Low-confidence drift mapping",
  unverified_after_retries: "Unverified after 3 retries",
  decision_request: "Decision asked on a call",
  reconciliation_gap: "Money doesn't reconcile",
  llm_review: "AI result needs review",
};

/** Who a waiting task is waiting on (claimant view wording). */
export function waitingOn(type: string): string {
  if (["adjuster_assigned", "estimate_approved", "medical_reimbursement", "open_claim", "rental_coverage", "submit_estimate", "forward_invoice"].includes(type)) return "the insurer";
  if (["repair_estimate", "track_repair", "book_body_shop", "authorize_repair"].includes(type)) return "the body shop";
  if (["book_rental", "extend_rental", "return_rental"].includes(type)) return "the rental company";
  if (["car_picked_up", "claimant_request", "collect_details"].includes(type)) return "you";
  if (type === "invoice_fact") return "the clinic";
  return "the agent";
}
