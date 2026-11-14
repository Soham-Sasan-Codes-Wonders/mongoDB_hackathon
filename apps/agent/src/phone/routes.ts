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

export function registerPhoneRoutes(app: FastifyInstance) {
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
    const callerNumber = String(phoneCall.external_number ?? dyn.system__caller_id ?? fields.callback_number ?? "");
    const caller = await lookupCaller(callerNumber);
    const transcript = ((data.transcript as unknown[]) ?? []).map(obj).map((t) => ({ role: String(t.role ?? ""), message: String(t.message ?? "") }));
    const transcriptText = transcript.map((t) => `${t.role}: ${t.message}`).join("\n");
    // Claim reference: the known contact's open claim first; what the caller said only for company lines.
    const said = String(fields.claim_reference ?? "").toUpperCase().match(/CLM-\d+/)?.[0] ?? "";
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
