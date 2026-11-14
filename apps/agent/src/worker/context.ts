import { claims, observations, type Claim } from "@claims/db";
import { claimLog } from "../log.ts";

/** Per-wake context for one claim. Holds no durable state: everything is re-read from MongoDB. */
export class ClaimCtx {
  claim!: Claim;
  events: string[] = [];
  progress = false;
  /** Wait tasks to re-check (read-only) in this iteration. */
  recheck = new Set<string>();
  /** Unverified actions to read back now (matched by a webhook). */
  verifyNow = new Set<string>();
  constructor(
    public readonly claimId: string,
    public readonly workerId: string,
  ) {}

  async reload(): Promise<Claim> {
    const c = await claims.getClaim(this.claimId);
    if (!c) throw new Error(`claim ${this.claimId} not found`);
    this.claim = c;
    return c;
  }
  log(step: string, msg: string, extra?: unknown) {
    claimLog(this.claimId, step, msg, extra);
  }
  /** Something durable changed: remember it for the summary and run another loop iteration. */
  event(msg: string) {
    this.events.push(msg);
    this.progress = true;
  }
  ext(k: string): string | null {
    const v = (this.claim.external ?? {})[k];
    return v === undefined || v === null ? null : String(v);
  }
}

/** Outbound message to the claimant (shown in the claimant view). Inserted pre-processed so it doesn't wake the loop. */
export async function messageClaimant(c: ClaimCtx, text: string, extra: Record<string, unknown> = {}) {
  await observations.insertObservation({ claimId: c.claimId, source: "system", kind: "agent_message", body: { to: "claimant", text, ...extra }, processed: true });
  c.log("notify", `-> claimant: ${text.slice(0, 120)}`);
}

export async function notifyOperator(c: ClaimCtx, text: string, extra: Record<string, unknown> = {}) {
  await observations.insertObservation({ claimId: c.claimId, source: "system", kind: "operator_notice", body: { to: "operator", text, ...extra }, processed: true });
  c.log("notify", `-> operator: ${text.slice(0, 120)}`);
}
