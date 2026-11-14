import type { FastifyInstance } from "fastify";
import { claims, contacts, documents, observations } from "../db.ts";
import { config } from "../config.ts";
import { log } from "../log.ts";
import { verifyElevenLabsSignature } from "./hmac.ts";

export const DATA_COLLECTION_FIELDS = [
  "caller_role", "claim_reference", "update_type", "status_claimed", "amount_claimed", "promised_date",
  "request_for_claimant", "decision_requested", "payment_details_mentioned", "callback_number",
] as const;

const obj = (x: unknown) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});

/** The trust table: who is calling decides only how the voice agent talks, never what is true. */
export async function lookupCaller(callerId: string) {
  const c = await contacts.findByPhone(callerId); // one indexed query (unique index on phone), no LLM
  if (!c) return { caller_name: "", caller_role: "unknown", claim_reference: "", trust_level: "unknown", claimant_first_name: "", contact: null };
  const claimId = c.claimIds.at(-1) ?? "";
  if (c.isCompanyMainLine) return { caller_name: c.company ?? c.name, caller_role: c.role, claim_reference: c.claimIds.length === 1 ? claimId : "", trust_level: "company_line", claimant_first_name: "", contact: c };
  let first = "";
  if (claimId) {
    const cl = await claims.getClaim(claimId);
    first = cl?.claimant.firstName ?? cl?.claimant.name.split(/\s+/)[0] ?? "";
  }
  return { caller_name: c.name, caller_role: c.role, claim_reference: claimId, trust_level: "known", claimant_first_name: first, contact: c };
}

/**
 * A claim number as callers actually say it: "CLM-1047", "CLM 1047", "claim 1047", "claim number
 * 1047", or a bare "1047" in the claim_reference field. Returns "CLM-1047" or "". Only a claim
 * that exists is ever matched (checked by the caller of this).
 */
export function claimRefFrom(text: string): string {
  const t = text.trim();
  const m = t.match(/\bCLM[-\s]?(\d{3,})\b/i) ?? t.match(/\bclaim\s*(?:number|no\.?|#)?\s*(\d{3,})\b/i) ?? t.match(/^#?(\d{3,})$/);
  return m ? `CLM-${m[1]}` : "";
}

const E164 = /^\+[1-9]\d{1,14}$/;
const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Browser "phone call" page for demos without a phone number. Open
 * `/phone/web?phone=+14165551001` (over HTTPS, e.g. ngrok, so the mic works) and talk to the same
 * ElevenLabs agent. Browser calls have no caller ID, so the page does the caller lookup itself and
 * passes the result as dynamic variables, plus `caller_phone` so /phone/post-call can match the
 * claim. Like caller ID, the number is self-asserted: it only decides how the agent talks.
 */
function webCallPage(agentId: string, vars: Record<string, string>, caller: string): string {
  const who = vars.trust_level === "unknown" ? `unknown caller (${caller || "no number"})` : `${vars.caller_name} · ${vars.caller_role} · ${vars.claim_reference || "no claim"}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claim line</title>
<style>body{font:16px system-ui,sans-serif;margin:0;padding:32px 16px;background:#f6f6f4;color:#1b1b1b}main{max-width:480px;margin:0 auto}h1{font-size:22px;margin:0 0 8px}p{color:#555;margin:0 0 16px}code{background:#e9e9e4;padding:2px 6px;border-radius:4px}
@media (prefers-color-scheme:dark){body{background:#151515;color:#eee}p{color:#aaa}code{background:#2a2a2a}}</style>
</head><body><main>
<h1>Claim line (browser call)</h1>
<p>Calling as: <code>${attr(who)}</code></p>
<p>Press the call button and allow the microphone. Hang up when done; the transcript arrives at the agent via the post-call webhook.</p>
<elevenlabs-convai agent-id='${attr(agentId)}' dynamic-variables='${attr(JSON.stringify(vars))}'></elevenlabs-convai>
</main>
<script src="https://unpkg.com/@elevenlabs/convai-widget-embed" async type="text/javascript"></script>
</body></html>`;
}

export function registerPhoneRoutes(app: FastifyInstance) {
  app.get("/phone/web", async (req, reply) => {
    if (!config.elevenLabsAgentId) return reply.code(500).type("text/plain").send("ELEVENLABS_AGENT_ID not configured");
    // An unencoded "+" in a query string arrives as a space, so accept "?phone=14165551001" too.
    const raw = String(obj(req.query).phone ?? "").replace(/\s/g, "");
    const phone = /^\d/.test(raw) ? `+${raw}` : raw;
    if (phone && !E164.test(phone)) return reply.code(400).type("text/plain").send("phone must be E.164, e.g. +14165551001");
    const { contact: _c, ...vars } = await lookupCaller(phone);
    return reply.type("text/html").send(webCallPage(config.elevenLabsAgentId, { ...vars, caller_phone: phone }, phone));
  });

  /** ElevenLabs conversation-initiation webhook. Must answer fast: one indexed lookup, no LLM. */
  app.post("/phone/initiation", async (req) => {
    const b = obj(req.body);
    const callerId = String(b.caller_id ?? b.callerId ?? "");
    const { contact: _c, ...vars } = await lookupCaller(callerId);
    return { type: "conversation_initiation_client_data", dynamic_variables: vars };
  });

  /** ElevenLabs post-call webhook: verify HMAC, then store the call as an observation (claimed, not confirmed). */
  app.post("/phone/post-call", async (req, reply) => {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
    const v = verifyElevenLabsSignature(raw, req.headers["elevenlabs-signature"] as string | undefined, config.elevenLabsSecret);
    if (!v.ok) {
      log("phone", `post-call rejected: ${v.reason}`);
      return reply.code(401).send({ error: v.reason });
    }
    const payload = obj(req.body);
    const data = obj(payload.data);
    const analysis = obj(data.analysis);
    const dc = obj(analysis.data_collection_results);
    const fields: Record<string, unknown> = {};
    for (const f of DATA_COLLECTION_FIELDS) {
      const x = dc[f];
      fields[f] = x && typeof x === "object" && "value" in (x as object) ? (x as { value: unknown }).value : x ?? null;
    }
    const meta = obj(data.metadata);
    const phoneCall = obj(meta.phone_call);
    const dyn = obj(obj(data.conversation_initiation_client_data).dynamic_variables);
    // Real calls carry caller ID. Browser calls (/phone/web) have none, so use the caller_phone
    // dynamic variable the page passed, then the callback number the caller said.
    const callerNumber = String(phoneCall.external_number ?? dyn.system__caller_id ?? dyn.caller_phone ?? fields.callback_number ?? "");
    const caller = await lookupCaller(callerNumber);
    const transcript = ((data.transcript as unknown[]) ?? []).map(obj).map((t) => ({ role: String(t.role ?? ""), message: String(t.message ?? "") }));
    const transcriptText = transcript.map((t) => `${t.role}: ${t.message}`).join("\n");
    // Claim reference: the known contact's open claim first; what the caller said only for company lines.
    const said = claimRefFrom(String(fields.claim_reference ?? "")) || claimRefFrom(transcript.filter((t) => t.role === "user").map((t) => t.message).join(" "));
    const claimId = caller.trust_level === "known" ? caller.claim_reference || said : said && (await claims.getClaim(said)) ? said : "";
    const trust = caller.trust_level as "known" | "company_line" | "unknown";
    const target = claimId || "CLM-0";
    const obsId = await observations.insertObservation({
      claimId: target,
      source: "phone",
      kind: "call",
      trust,
      verified: false,
      body: {
        conversationId: data.conversation_id ?? null,
        callerNumber,
        caller: { name: caller.caller_name || "unknown", role: caller.caller_role, company: caller.contact?.company ?? null },
        fields,
        transcript,
        transcriptText,
        summary: analysis.transcript_summary ?? null,
      },
      processed: !claimId, // a call we can't tie to a claim is stored for an operator, not processed by the loop
      note: claimId ? undefined : "no claim matched (unknown caller or reference)",
    });
    if (claimId) await documents.putDocument({ claimId, docType: "call_transcript", source: "phone", filename: `call-${String(data.conversation_id ?? obsId)}.txt`, contentType: "text/plain", extractedText: transcriptText });
    log("phone", `post-call stored: ${caller.caller_name || callerNumber || "unknown"} (${trust}) -> ${claimId || "unmatched"} [claimed, not confirmed]`);
    return { ok: true, observationId: obsId, claimId: claimId || null };
  });
}
