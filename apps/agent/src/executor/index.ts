import { actions, approvals, claims, clock, health, profiles, timers, type ActionDoc, type ApprovalDoc, type Claim, type OutsideSystem } from "../db.ts";
import { config } from "../config.ts";
import { claimLog, errMsg } from "../log.ts";
import { kindSpec, type Get, type ReadBackResult } from "./adapters.ts";

/* ------------------------------------------------------------------ errors */

export class GateError extends Error {
  constructor(public readonly actionId: string, reason: string) {
    super(`executor refused action ${actionId}: ${reason}`);
    this.name = "GateError";
  }
}

export type ExecOutcome =
  | { outcome: "acknowledged"; action: ActionDoc; response: unknown }
  | { outcome: "drift"; action: ActionDoc; status: number; error: string; details: unknown; op: string }
  | { outcome: "rejected"; action: ActionDoc; reason: string }
  | { outcome: "transient"; action: ActionDoc; error: string };

/* ------------------------------------------------------- the gate (code) */

/**
 * The executor's hard precondition. Plain code, not a prompt:
 *  - a first send needs status `planned` or `approved`; a retry (same key) needs `sent`/`acknowledged`,
 *    or `failed` (a validation error the drift subflow has since fixed)
 *  - a gated action needs ITS approval document, decided `approved`
 */
export function assertExecutable(action: Pick<ActionDoc, "_id" | "status" | "gate" | "approvalId">, approval: Pick<ApprovalDoc, "_id" | "status" | "actionId"> | null, mode: "send" | "retry" = "send"): void {
  const id = String(action._id);
  const allowed = mode === "send" ? ["planned", "approved"] : ["sent", "acknowledged", "failed"];
  if (!allowed.includes(action.status)) throw new GateError(id, `status is ${action.status}, needs ${allowed.join("/")}`);
  if (action.gate) {
    if (!approval) throw new GateError(id, `gate ${action.gate} has no approval document`);
    if (String(approval.actionId) !== id) throw new GateError(id, `approval ${approval._id} belongs to another action`);
    if (approval.status !== "approved") throw new GateError(id, `gate ${action.gate} is ${approval.status}`);
  }
}

/* --------------------------------------------------------------- transport */

const isOutside = (s: string): s is OutsideSystem => ["insurer", "body_shop", "rental", "clinic"].includes(s);

async function http(system: string, method: "GET" | "POST", path: string, body: Record<string, unknown> | undefined, idempotencyKey: string | null) {
  const started = Date.now();
  try {
    const res = await fetch(`${config.mocksUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    await health.recordHealth({ system, latencyMs: Date.now() - started, ok: res.status < 500, errorCode: res.status >= 400 ? String(res.status) : null, endpoint: `${method} ${path.split("?")[0]}` }).catch(() => undefined);
    return { status: res.status, json };
  } catch (e) {
    await health.recordHealth({ system, latencyMs: Date.now() - started, ok: false, errorCode: "network", endpoint: `${method} ${path.split("?")[0]}` }).catch(() => undefined);
    throw e;
  }
}

/** Read-only GET used by adapters' read-backs (recorded to system_health). */
export function getter(system: string): Get {
  return (path) => http(system, "GET", path, undefined, null);
}

/** Map canonical payload keys to the system's current names using the latest system_profiles version. */
export async function mapPayload(system: OutsideSystem, payload: Record<string, unknown>): Promise<{ body: Record<string, unknown>; version: number | null }> {
  const profile = await profiles.getLatestProfile(system);
  const map = profile?.fieldMap ?? {};
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) body[map[k] ?? k] = v;
  return { body, version: profile?.version ?? null };
}

/* ------------------------------------------------------------------ execute */

async function send(action: ActionDoc, mode: "send" | "retry", by: string): Promise<ExecOutcome> {
  const approval = action.approvalId ? await approvals.getApproval(action.approvalId) : null;
  assertExecutable(action, approval, mode);
  if (!isOutside(action.system)) throw new GateError(String(action._id), `system ${action.system} is not executed over HTTP`);
  const claim = await claims.getClaim(action.claimId);
  if (!claim) throw new Error(`claim ${action.claimId} missing`);
  const spec = kindSpec(action.system, action.kind);
  const req = spec.request(action, claim as Claim);
  const { body, version } = req.body ? await mapPayload(action.system, req.body) : { body: undefined, version: null };

  // The shared state machine retries through `failed -> sent` (same key); an unproven send is parked there first.
  if (mode === "retry" && (action.status === "sent" || action.status === "acknowledged")) {
    await actions.transitionAction(action._id, "failed", { by, note: "no proof of the effect: resending with the same idempotency key" });
  }
  // Outbox order: record `sent` BEFORE the call, so a crash mid-call leaves an action recovery will read back.
  const sent = await actions.transitionAction(action._id, "sent", {
    by,
    note: `${mode === "retry" ? "retry" : "send"} #${action.attempts + 1} ${req.method} ${req.path} key=${action.idempotencyKey}${version ? ` profile v${version}` : ""}`,
    set: { profileVersion: version },
  });
  claimLog(action.claimId, "step 8 execute", `${action.taskId} ${action.system}.${action.kind} -> sent (attempt ${sent.attempts})`);

  let res: { status: number; json: unknown };
  try {
    res = await http(action.system, req.method, req.path, body, action.idempotencyKey);
  } catch (e) {
    const verifyAfter = new Date(clock.nowMs() + config.verifyDelaySim);
    await actions.noteAction(action._id, `transport error: ${errMsg(e)}`, by, { lastError: errMsg(e), verifyAfter });
    await scheduleVerify({ ...sent, verifyAfter });
    return { outcome: "transient", action: sent, error: errMsg(e) };
  }
  const j = (res.json ?? {}) as Record<string, unknown>;
  if (res.status >= 200 && res.status < 300) {
    const verifyAfter = new Date(clock.nowMs() + config.verifyDelaySim);
    const acked = await actions.transitionAction(action._id, "acknowledged", {
      by,
      note: `HTTP ${res.status}: acknowledged (not proof)`,
      set: { response: res.json, verifyAfter, lastError: null },
    });
    await scheduleVerify(acked);
    return { outcome: "acknowledged", action: acked, response: res.json };
  }
  if (res.status === 422 || (res.status === 400 && j.error === "validation")) {
    const msg = String(j.message ?? "validation error");
    // Not accepted: `failed` until the drift subflow fixes the mapping and resends with the same key.
    const failed = await actions.transitionAction(action._id, "failed", { by, note: `HTTP ${res.status} validation: ${msg} (drift?)`, set: { lastError: msg } });
    return { outcome: "drift", action: failed, status: res.status, error: msg, details: j.details ?? null, op: req.op };
  }
  if (res.status === 409 || j.error === "rejected" || (spec.readOnly && res.status === 404)) {
    const reason = String(j.reason ?? j.message ?? `HTTP ${res.status}`);
    const rejected = await actions.transitionAction(action._id, "rejected", { by, note: `refused: ${reason}`, set: { response: res.json, lastError: reason } });
    await timers.cancelTimersForAction(String(action._id));
    return { outcome: "rejected", action: rejected, reason };
  }
  const err = `HTTP ${res.status}: ${JSON.stringify(res.json).slice(0, 200)}`;
  const verifyAfter = new Date(clock.nowMs() + config.verifyDelaySim);
  await actions.noteAction(action._id, err, by, { lastError: err, verifyAfter });
  await scheduleVerify({ ...sent, verifyAfter });
  return { outcome: "transient", action: sent, error: err };
}

async function scheduleVerify(a: ActionDoc) {
  const due = a.verifyAfter ?? new Date(clock.nowMs() + config.verifyDelaySim);
  await timers.ensureTimer({ claimId: a.claimId, taskId: a.taskId, rule: "verify_action", dueAt: due, actionId: String(a._id) });
}

/** First send. Refuses unless status is planned/approved and the gate (if any) is approved. */
export function execute(action: ActionDoc, by = "executor"): Promise<ExecOutcome> {
  return send(action, "send", by);
}

/** Retry with the SAME idempotency key (the system treats it as the same request). */
export function retry(action: ActionDoc, by = "executor"): Promise<ExecOutcome> {
  return send(action, "retry", by);
}

/* ----------------------------------------------------------------- readBack */

export type VerifyResult = ReadBackResult & { action: ActionDoc; confirmed: boolean };

/**
 * Query the system and check expectedEffect. Satisfied -> `confirmed` (sent can jump straight to
 * confirmed). Not satisfied -> unchanged; the caller decides whether to retry (same key) or escalate.
 */
export async function readBack(action: ActionDoc, by = "verifier"): Promise<VerifyResult> {
  if (!isOutside(action.system)) throw new Error(`readBack: ${action.system} has no system of record`);
  const claim = await claims.getClaim(action.claimId);
  const spec = kindSpec(action.system, action.kind);
  let r: ReadBackResult;
  try {
    r = await spec.readBack(action, claim as Claim, getter(action.system));
  } catch (e) {
    await actions.noteAction(action._id, `read-back error: ${errMsg(e)}`, by);
    return { satisfied: false, observed: null, action, confirmed: false };
  }
  if (r.satisfied && (action.status === "sent" || action.status === "acknowledged")) {
    const confirmed = await actions.transitionAction(action._id, "confirmed", {
      by,
      note: `read-back proves expectedEffect ${JSON.stringify(action.expectedEffect)}`,
      set: { readback: r.observed },
    });
    await timers.cancelTimersForAction(String(action._id));
    claimLog(action.claimId, "step 3 verify", `${action.taskId} ${action.system}.${action.kind} -> confirmed by read-back`);
    return { ...r, action: confirmed, confirmed: true };
  }
  if (!r.satisfied) await actions.noteAction(action._id, `read-back: effect not found${r.shapeError ? ` (shape: ${r.shapeError})` : ""}`, by, { readback: r.observed ?? null });
  return { ...r, action, confirmed: false };
}
