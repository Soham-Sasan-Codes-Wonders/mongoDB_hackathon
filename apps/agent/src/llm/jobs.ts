import { z } from "zod";
import { callStructured, type LlmResult } from "./client.ts";

const conf = z.number().min(0).max(1);
const J = (v: unknown) => JSON.stringify(v, null, 1);

/* 1 ----------------------------------------------------------- extractAccidentDetails */

export const AccidentDetails = z.object({
  date: z.string().nullable(),
  place: z.string().nullable(),
  description: z.string().nullable(),
  otherDriver: z.object({ name: z.string().nullable(), plate: z.string().nullable(), insurer: z.string().nullable() }).nullable(),
  policyNumber: z.string().nullable(),
  policeReportNumber: z.string().nullable(),
  injuries: z.boolean(),
  mentionsFault: z.boolean(),
  faultStatement: z.string().nullable(),
  missingFields: z.array(z.string()),
  confidence: conf,
});
export type AccidentDetails = z.infer<typeof AccidentDetails>;

export function extractAccidentDetails(input: { form: Record<string, unknown>; messages: string[] }): Promise<LlmResult<AccidentDetails>> {
  return callStructured({
    job: "extractAccidentDetails",
    effort: "medium",
    schema: AccidentDetails,
    confidence: (v) => v.confidence,
    user: `Extract the accident details from the claimant's intake form and messages. Prefer explicit form values; use the messages to fill gaps. List every required field that is still missing in missingFields (required: date, place, policyNumber, description). Set mentionsFault=true if the claimant states or implies who was at fault, and quote it in faultStatement. Set injuries=true if anyone was hurt.\n\nFORM:\n${J(input.form)}\n\nMESSAGES:\n${input.messages.map((m, i) => `${i + 1}. ${m}`).join("\n") || "(none)"}`,
    stub: () => {
      const f = input.form as Record<string, unknown>;
      const text = [String(f.description ?? ""), ...input.messages].join(" ");
      const od = (f.otherDriver ?? null) as AccidentDetails["otherDriver"] | string | null;
      const otherDriver = typeof od === "string" ? { name: od, plate: null, insurer: null } : od ?? null;
      const pick = (k: string) => (typeof f[k] === "string" && (f[k] as string).trim() ? (f[k] as string) : null);
      const v = {
        date: pick("date"),
        place: pick("place"),
        description: pick("description"),
        otherDriver,
        policyNumber: pick("policyNumber") ?? text.match(/POL-\d+/)?.[0] ?? null,
        policeReportNumber: pick("policeReportNumber") ?? text.match(/PR-\d+/)?.[0] ?? null,
        injuries: Boolean(f.injuries) || /\b(hurt|injur|whiplash|clinic|pain)\b/i.test(text),
        mentionsFault: /\b(my fault|i was at fault|i hit|their fault|ran the red|admit)\b/i.test(text),
        faultStatement: text.match(/[^.]*\b(fault|ran the red)\b[^.]*\./i)?.[0]?.trim() ?? null,
        missingFields: [] as string[],
        confidence: 0.9,
      };
      for (const k of ["date", "place", "policyNumber", "description"] as const) if (!v[k]) v.missingFields.push(k);
      return v;
    },
  });
}

/* 2 ---------------------------------------------------------- interpretInboundMessage */

export const InboundInterpretation = z.object({
  intent: z.enum(["provide_info", "question", "complaint", "approval", "document", "other"]),
  providedFields: z.array(z.object({ field: z.string(), value: z.string() })),
  summary: z.string(),
  needsReply: z.boolean(),
  replyText: z.string().nullable(),
  confidence: conf,
});
export type InboundInterpretation = z.infer<typeof InboundInterpretation>;

export function interpretInboundMessage(input: { from: string; text: string; compactSummary: string; openTasks: string[] }): Promise<LlmResult<InboundInterpretation>> {
  return callStructured({
    job: "interpretInboundMessage",
    effort: "medium",
    schema: InboundInterpretation,
    confidence: (v) => v.confidence,
    user: `Interpret one inbound message (from the claimant, or an email/letter from a party) and turn it into a structured observation. providedFields uses our canonical field names (e.g. policyNumber, policeReportNumber, date, place, otherDriverName, treatmentCode). If a reply to the claimant is useful, write it (short, plain language, no promises).\n\nFROM: ${input.from}\nCLAIM SUMMARY: ${input.compactSummary || "(none yet)"}\nOPEN TASKS: ${input.openTasks.join("; ")}\n\nMESSAGE:\n${input.text}`,
    stub: () => {
      const fields: { field: string; value: string }[] = [];
      const pol = input.text.match(/POL-\d+/)?.[0];
      if (pol) fields.push({ field: "policyNumber", value: pol });
      const pr = input.text.match(/PR-\d+/)?.[0];
      if (pr) fields.push({ field: "policeReportNumber", value: pr });
      const q = input.text.trim().endsWith("?");
      return {
        intent: fields.length ? "provide_info" : q ? "question" : "other",
        providedFields: fields,
        summary: input.text.slice(0, 200),
        needsReply: q,
        replyText: q ? "Thanks for your message. We're checking with the relevant party and will update you here as soon as we have confirmation." : null,
        confidence: 0.8,
      };
    },
  });
}

/* 3 ------------------------------------------------------------------ classifyRejection */

export const RejectionClassification = z.object({
  category: z.enum(["missing_field", "wrong_document", "out_of_coverage", "duplicate", "other"]),
  missingField: z.string().nullable(),
  factSource: z.enum(["clinic", "claimant", "body_shop", "insurer"]).nullable(),
  needsNewFacts: z.boolean(),
  proposedFix: z.string(),
  confidence: conf,
});
export type RejectionClassification = z.infer<typeof RejectionClassification>;

export function classifyRejection(input: { system: string; kind: string; reason: string; payload: Record<string, unknown>; knownFacts: Record<string, unknown>; experiences: { problem: string; fix: unknown; outcome: string }[] }): Promise<LlmResult<RejectionClassification>> {
  return callStructured({
    job: "classifyRejection",
    effort: "medium",
    schema: RejectionClassification,
    confidence: (v) => v.confidence,
    user: `A system definitively refused a submission. Classify why and propose the fix. needsNewFacts=true when the fix needs information we do not already hold in KNOWN FACTS or the payload (then name factSource: who has it). Use canonical field names.\n\nSYSTEM: ${input.system}\nSUBMISSION KIND: ${input.kind}\nREASON: ${input.reason}\nPAYLOAD: ${J(input.payload)}\nKNOWN FACTS: ${J(input.knownFacts)}\nSIMILAR PAST REJECTIONS:\n${input.experiences.map((e) => `- ${e.problem} -> ${J(e.fix)} (${e.outcome})`).join("\n") || "(none)"}`,
    stub: () => {
      const r = input.reason.toLowerCase();
      if (/treatment code|cpt/.test(r)) {
        const have = Boolean(input.knownFacts.treatmentCode);
        return { category: "missing_field", missingField: "treatmentCode", factSource: "clinic", needsNewFacts: !have, proposedFix: have ? "Resubmit including the treatment code we already hold" : "Get the treatment code from the clinic invoice detail, then resubmit", confidence: 0.92 };
      }
      if (/duplicate/.test(r)) return { category: "duplicate", missingField: null, factSource: null, needsNewFacts: false, proposedFix: "Confirm the original submission and close", confidence: 0.9 };
      if (/not covered|coverage|exclud/.test(r)) return { category: "out_of_coverage", missingField: null, factSource: null, needsNewFacts: false, proposedFix: "Tell the claimant; close as denied", confidence: 0.9 };
      if (/document|pdf|attachment/.test(r)) return { category: "wrong_document", missingField: null, factSource: "body_shop", needsNewFacts: true, proposedFix: "Request the correct document", confidence: 0.75 };
      return { category: "other", missingField: null, factSource: null, needsNewFacts: false, proposedFix: "Operator review", confidence: 0.4 };
    },
  });
}

/* 4 ---------------------------------------------------------------- proposeFieldMapping */

export const MappingProposal = z.object({
  mappings: z.array(z.object({ canonical: z.string(), systemField: z.string(), confidence: conf, rationale: z.string() })),
  newTasks: z.array(
    z.object({
      step: z.string(),
      title: z.string(),
      kind: z.string(),
      endpoint: z.string().nullable(),
      blocksTaskIds: z.array(z.string()),
      confidence: conf,
      rationale: z.string(),
    }),
  ),
  confidence: conf,
});
export type MappingProposal = z.infer<typeof MappingProposal>;

export function proposeFieldMapping(input: {
  system: string;
  error: string;
  diff: { added: unknown[]; removed: unknown[]; newSteps: string[] };
  canonicalMatches: { systemField: string; endpoint?: string; candidates: { fieldName: string; score: number }[] }[];
  experiences: { problem: string; fix: unknown; outcome: string }[];
  openTaskIds: string[];
}): Promise<LlmResult<MappingProposal>> {
  return callStructured({
    job: "proposeFieldMapping",
    effort: "medium",
    schema: MappingProposal,
    user: `A system changed underneath us. Propose (a) mappings from our canonical field names to the system's new field names, and/or (b) new tasks for any new required workflow step, each with a confidence. Only map a field when the vector matches, the error, and the samples agree. For a new step, say which existing tasks it must block (blocksTaskIds, from OPEN TASKS) and which endpoint performs it. The task kind must be one the agent can execute: "upload_photos" (POST /insurer/claims/:claimNo/photos, for a photos step). If no kind fits, still propose the task with kind "manual_step" and a low confidence so an operator handles it. The step is the workflow step name exactly as it appears in the diff.\n\nSYSTEM: ${input.system}\nERROR / TRIGGER: ${input.error}\nDESCRIBE DIFF: ${J(input.diff)}\nVECTOR MATCHES (new system field -> canonical candidates): ${J(input.canonicalMatches)}\nSIMILAR PAST DRIFT:\n${input.experiences.map((e) => `- ${e.problem} -> ${J(e.fix)} (${e.outcome})`).join("\n") || "(none)"}\nOPEN TASKS: ${input.openTaskIds.join(", ")}`,
    stub: () => {
      // A rename = a field removed AND a field added on the same endpoint, where the vector match
      // of the added field points at the removed one. Brand-new fields are not mapped.
      const removed = input.diff.removed as { name?: string; endpoint?: string }[];
      const seen = new Set<string>();
      const mappings = input.canonicalMatches
        .map((m) => {
          const ep = (m as { endpoint?: string }).endpoint;
          const gone = removed.filter((r) => !ep || r.endpoint === ep).map((r) => r.name);
          const top = m.candidates.find((c) => gone.includes(c.fieldName));
          if (!top || seen.has(`${top.fieldName}>${m.systemField}`)) return null;
          seen.add(`${top.fieldName}>${m.systemField}`);
          const exp = input.experiences.some((e) => JSON.stringify(e.fix).includes(m.systemField));
          const c = Math.min(0.97, top.score + 0.08 + (exp ? 0.05 : 0));
          return { canonical: top.fieldName, systemField: m.systemField, confidence: Number(c.toFixed(2)), rationale: `vector score ${top.score.toFixed(2)}; ${top.fieldName} was removed from the same endpoint${exp ? "; matches a past fix" : ""}` };
        })
        .filter((x): x is NonNullable<typeof x> => !!x);
      const newTasks = input.diff.newSteps.map((step) => ({
        step,
        title: `Upload ${step} to the insurer`,
        kind: `upload_${step}`,
        endpoint: `/insurer/claims/:claimNo/${step}`,
        blocksTaskIds: input.openTaskIds.includes("T9") ? ["T9"] : [],
        confidence: input.experiences.some((e) => JSON.stringify(e.fix).includes(step)) ? 0.9 : 0.7,
        rationale: `new required workflow step '${step}'`,
      }));
      const all = [...mappings.map((m) => m.confidence), ...newTasks.map((t) => t.confidence)];
      return { mappings, newTasks, confidence: all.length ? Math.min(...all) : 0.3 };
    },
  });
}

/* 5 ------------------------------------------------------------------------ writeFollowUp */

export const FollowUp = z.object({ subject: z.string(), text: z.string() });
export type FollowUp = z.infer<typeof FollowUp>;

export function writeFollowUp(input: { to: string; purpose: string; facts: Record<string, unknown>; escalationLevel: number }): Promise<LlmResult<FollowUp>> {
  return callStructured({
    job: "writeFollowUp",
    effort: "low",
    schema: FollowUp,
    maxTokens: 4000,
    user: `Write a short, polite follow-up message (<= 80 words). Escalation level ${input.escalationLevel} (0 = first nudge, 1 = second, firmer). State the facts; do not invent dates or amounts.\n\nTO: ${input.to}\nPURPOSE: ${input.purpose}\nFACTS: ${J(input.facts)}`,
    stub: () => ({
      subject: `${input.escalationLevel > 0 ? "Second follow-up" : "Follow-up"}: ${input.purpose}`,
      text: `Hello ${input.to}, ${input.escalationLevel > 0 ? "following up again" : "a quick follow-up"} regarding ${input.purpose}${input.facts.claimRef ? ` for claim ${input.facts.claimRef}` : ""}. Could you let us know the current status? Thank you.`,
    }),
  });
}

/* 6 ---------------------------------------------------------------------- summarizeClaim */

export const ClaimSummary = z.object({ summary: z.string().max(2000) });

export function summarizeClaim(input: { previousSummary: string; claimFacts: Record<string, unknown>; tasks: { taskId: string; title: string; status: string }[]; recentEvents: string[]; money: unknown }): Promise<LlmResult<{ summary: string }>> {
  return callStructured({
    job: "summarizeClaim",
    effort: "low",
    schema: ClaimSummary,
    maxTokens: 4000,
    user: `Rewrite the compact claim summary (<= 1500 characters). This summary is the ONLY context the agent reloads after a crash, so include: key facts and external reference numbers, what is confirmed (proven), what is merely claimed/unverified, what is blocked or waiting on whom, pending human decisions, and money status. No speculation.\n\nPREVIOUS SUMMARY: ${input.previousSummary || "(none)"}\nCLAIM FACTS: ${J(input.claimFacts)}\nTASKS: ${input.tasks.map((t) => `${t.taskId} ${t.title}: ${t.status}`).join(" | ")}\nRECENT EVENTS:\n${input.recentEvents.join("\n")}\nMONEY: ${J(input.money)}`,
    stub: () => {
      const done = input.tasks.filter((t) => t.status === "confirmed").map((t) => t.taskId);
      const open = input.tasks.filter((t) => !["confirmed", "denied", "closed_by_human"].includes(t.status)).map((t) => `${t.taskId}:${t.status}`);
      const f = input.claimFacts;
      const s = `Claim ${f.claimId} for ${f.claimant}. Insurer claim ${f.insurerClaimNo ?? "not yet opened"}, shop booking ${f.bookingId ?? "-"}, rental ${f.reservationId ?? "-"}. Confirmed: ${done.join(", ") || "none"}. Open: ${open.join(", ") || "none"}. Recent: ${input.recentEvents.slice(-4).join("; ")}`;
      return { summary: s.slice(0, 1500) };
    },
  });
}

/* 7 ----------------------------------------------------------------------- pickNextTask */

export const TaskOrder = z.object({ order: z.array(z.string()), rationale: z.string() });

export function pickNextTask(input: { ready: { taskId: string; title: string; track: string }[]; compactSummary: string }): Promise<LlmResult<z.infer<typeof TaskOrder>>> {
  return callStructured({
    job: "pickNextTask",
    effort: "low",
    schema: TaskOrder,
    maxTokens: 2000,
    user: `Several tasks are ready. Order them (most important first). Favour the critical repair path and anything time-sensitive for the claimant (e.g. getting them a rental car). Use only the taskIds listed.\n\nREADY: ${input.ready.map((t) => `${t.taskId} (${t.track}) ${t.title}`).join("; ")}\nSUMMARY: ${input.compactSummary || "(none)"}`,
    stub: () => {
      const rank = (id: string) => {
        const n = Number(id.replace(/^T(\d+).*/, "$1"));
        return Number.isNaN(n) ? 99 : n;
      };
      return { order: [...input.ready].sort((a, b) => rank(a.taskId) - rank(b.taskId)).map((t) => t.taskId), rationale: "graph order (stub)" };
    },
  });
}

/* 8 ------------------------------------------------------------------------ interpretCall */

export const CallItem = z.object({
  type: z.enum(["status_claim", "promise", "request", "decision_request", "payment_change", "other"]),
  system: z.enum(["insurer", "body_shop", "rental", "clinic"]).nullable(),
  subject: z.enum(["estimate_approval", "adjuster", "repair_status", "rental", "payment", "invoice", "document", "other"]),
  valueClaimed: z.string().nullable(),
  amountClaimed: z.number().nullable(),
  promisedDate: z.string().nullable(),
  requestText: z.string().nullable(),
  decisionQuestion: z.string().nullable(),
});
export const CallInterpretation = z.object({ items: z.array(CallItem), callerSummary: z.string(), confidence: conf });
export type CallInterpretation = z.infer<typeof CallInterpretation>;
export type CallItem = z.infer<typeof CallItem>;

export function interpretCall(input: { callerRole: string | null; trust: string; transcript: string; fields: Record<string, unknown> }): Promise<LlmResult<CallInterpretation>> {
  return callStructured({
    job: "interpretCall",
    effort: "medium",
    schema: CallInterpretation,
    confidence: (v) => v.confidence,
    user: `Turn one inbound phone call into separate items, one per thing the caller said: a status claim (something a system of record can confirm), a promise (a future date with no system of record yet), a request for the claimant, a question needing the claimant's decision, or any change to payment/bank details. promisedDate as YYYY-MM-DD when a date is stated or clearly implied relative to TODAY in the fields; otherwise null. Do not judge whether claims are true; code verifies them.\n\nCALLER ROLE: ${input.callerRole ?? "unknown"} (trust: ${input.trust})\nEXTRACTED FIELDS: ${J(input.fields)}\nTRANSCRIPT:\n${input.transcript}`,
    stub: () => {
      const f = input.fields;
      const items: CallItem[] = [];
      const sysFor = (role: string | null): CallItem["system"] =>
        role === "adjuster" ? "insurer" : role === "body_shop" ? "body_shop" : role === "rental_branch" ? "rental" : role === "clinic" ? "clinic" : null;
      const sys = sysFor(String(f.caller_role ?? input.callerRole ?? ""));
      const ut = String(f.update_type ?? "other");
      if (f.status_claimed) {
        items.push({ type: "status_claim", system: sys, subject: ut === "approval" || ut === "estimate" ? "estimate_approval" : ut === "repair status" || ut === "repair_status" ? "repair_status" : ut === "payment" ? "payment" : ut === "rental" ? "rental" : "other", valueClaimed: String(f.status_claimed), amountClaimed: typeof f.amount_claimed === "number" ? f.amount_claimed : f.amount_claimed ? Number(f.amount_claimed) || null : null, promisedDate: null, requestText: null, decisionQuestion: null });
      }
      if (f.promised_date) items.push({ type: "promise", system: sys, subject: sys === "body_shop" ? "repair_status" : "other", valueClaimed: String(f.status_claimed ?? "ready"), amountClaimed: null, promisedDate: String(f.promised_date), requestText: null, decisionQuestion: null });
      if (f.request_for_claimant) items.push({ type: "request", system: sys, subject: "document", valueClaimed: null, amountClaimed: null, promisedDate: null, requestText: String(f.request_for_claimant), decisionQuestion: null });
      if (f.decision_requested) items.push({ type: "decision_request", system: sys, subject: "other", valueClaimed: null, amountClaimed: null, promisedDate: null, requestText: null, decisionQuestion: String(f.decision_requested) });
      if (f.payment_details_mentioned === true || f.payment_details_mentioned === "true" || /bank|account number|routing|wire/i.test(input.transcript)) items.push({ type: "payment_change", system: sys, subject: "payment", valueClaimed: null, amountClaimed: null, promisedDate: null, requestText: null, decisionQuestion: null });
      const said = input.transcript.split("\n").filter((l) => /^user:/i.test(l)).map((l) => l.replace(/^user:\s*/i, "")).join(" ").replace(/\s+/g, " ");
      return { items, callerSummary: `"${(said || input.transcript).slice(0, 200)}"`, confidence: 0.85 };
    },
  });
}
