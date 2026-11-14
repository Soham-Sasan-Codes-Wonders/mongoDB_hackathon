"use client";

import { useEffect, useRef, useState } from "react";
import { decide, sendMessage, uploadPhotos } from "@/app/actions";
import { GATE_LABEL, waitingOn, type StatusLook } from "@/lib/status";
import { simDay, wall } from "@/lib/time";
import type { ApprovalJ, ClaimSnapshot, MoneyRowJ, ObservationJ, TaskJ } from "@/lib/types";
import { Button, Card, Label, Pill, useRun } from "./ui";

export const taskRank = (id: string) => {
  const m = id.match(/^T(\d+)([a-z])?/);
  return m ? Number(m[1]) - (m[2] ? 0.5 : 0) : 99;
};
const byRank = (a: TaskJ, b: TaskJ) => taskRank(a.taskId) - taskRank(b.taskId) || a.taskId.localeCompare(b.taskId);
const DONE = ["confirmed", "denied", "closed_by_human"];

/* ------------------------------------------------------------------ tracks */

function plainStatus(t: TaskJ, approvals: ApprovalJ[]): StatusLook {
  const v = (n: string) => `var(--st-${n})`;
  switch (t.status) {
    case "confirmed": return { color: v("confirmed"), icon: "✓", label: "Done" };
    case "denied": return { color: v("critical"), icon: "✕", label: "Denied" };
    case "closed_by_human": return { color: v("human"), icon: "✓", label: "Closed by our team" };
    case "blocked_drift": return { color: v("critical"), icon: "!", label: "Blocked" };
    case "awaiting_approval":
      return approvals.some((a) => a.status === "pending" && a.approverRole === "claimant" && a.taskId === t.taskId)
        ? { color: v("approval"), icon: "●", label: "Needs you" }
        : { color: v("approval"), icon: "⏸", label: "With our team" };
    case "waiting":
    case "in_progress": return { color: v("acknowledged"), icon: "◐", label: `Waiting on ${waitingOn(t.type)}` };
    default: return { color: v("idle"), icon: "○", label: "Not started" };
  }
}

const TRACKS: { key: TaskJ["track"]; label: string; empty: string }[] = [
  { key: "repair", label: "Repair", empty: "Nothing yet." },
  { key: "rental", label: "Rental car", empty: "Nothing yet." },
  { key: "medical", label: "Medical", empty: "No medical bills yet." },
];

/* ---------------------------------------------------- step details (plain) */

const PARTY: Record<string, string> = { insurer: "the insurer", body_shop: "the body shop", rental: "the rental company", clinic: "the clinic" };

const STEP_ABOUT: Record<string, string> = {
  collect_details: "We read your intake form and check we have everything the insurer needs.",
  open_claim: "We open your claim with the insurer (the “first notice of loss”).",
  adjuster_assigned: "The insurer assigns an adjuster to your claim.",
  rental_coverage: "We read your policy to see how many rental days and how much per day are covered.",
  book_rental: "We book a rental car within what your policy covers.",
  book_body_shop: "We book your car into the body shop.",
  repair_estimate: "The body shop inspects the car and sends a repair estimate.",
  submit_estimate: "We send the body shop's estimate to the insurer.",
  estimate_approved: "The insurer reviews and approves the repair estimate.",
  authorize_repair: "We tell the body shop the repair is approved so they can start.",
  track_repair: "We follow the repair until the car is ready.",
  extend_rental: "If the repair runs past the rental's end date, we extend the rental.",
  forward_invoice: "We send this medical bill to the insurer.",
  medical_reimbursement: "The insurer pays this medical bill.",
  invoice_fact: "We ask the clinic for a missing detail on the bill.",
  settle_repair: "The insurer's settlement offer, which needs your OK.",
  car_picked_up: "You pick up the repaired car.",
  return_rental: "We return the rental car and check the final charge.",
  reconcile_close: "We check every bill was submitted and paid, then close the claim.",
  upload_step: "The insurer added a new requirement, so we added this step.",
  claimant_request: "Someone needs something from you.",
  relay_decision: "We pass your answer back to whoever asked.",
};

const ACTION_DONE: Record<string, string> = {
  create_claim: "Opened your claim with the insurer",
  get_policy: "Read your policy's rental coverage",
  create_reservation: "Booked a rental car",
  create_booking: "Booked the body shop",
  submit_estimate: "Sent the repair estimate to the insurer",
  upload_photos: "Uploaded your photos to the insurer",
  authorize_repair: "Authorized the repair",
  extend_reservation: "Extended the rental",
  submit_medical_invoice: "Sent the medical bill to the insurer",
  get_invoice: "Asked the clinic for the bill's details",
  sign_release: "Signed the release",
  accept_settlement: "Accepted the settlement",
  return_reservation: "Returned the rental car",
  send_message: "Sent a follow-up",
};

const TIMER_NEXT: Record<string, (party: string) => string> = {
  verify_action: (p) => `double-check ${p}'s records`,
  chase_party: (p) => `follow up with ${p}`,
  rental_expiring: () => "check the rental's end date against the repair",
  payment_overdue: (p) => `chase ${p} about the payment`,
  claimant_reminder: () => "remind you",
  promise_check: () => "check what a caller promised",
};

/** One action's history in plain words: what we did, what they said, and what we proved. */
function actionEvents(a: ClaimSnapshot["actions"][number]): { at: string; text: string; tone: string }[] {
  const party = PARTY[a.system] ?? a.system;
  const what = ACTION_DONE[a.kind] ?? a.kind.replace(/_/g, " ");
  const out: { at: string; text: string; tone: string }[] = [];
  let sends = 0;
  for (const h of a.history) {
    switch (h.status) {
      case "awaiting_approval": out.push({ at: h.at, text: `${what}: waiting for approval`, tone: "var(--st-approval)" }); break;
      case "approved": out.push({ at: h.at, text: "Approved", tone: "var(--st-approval)" }); break;
      case "sent":
        sends++;
        out.push({ at: h.at, text: sends === 1 ? `${what} (sent to ${party})` : `Sent again with the same request, so ${party} can't get a duplicate`, tone: "var(--st-sent)" });
        break;
      case "acknowledged": out.push({ at: h.at, text: `${party[0]!.toUpperCase()}${party.slice(1)} said OK. We still check their records before calling it done.`, tone: "var(--st-acknowledged)" }); break;
      case "confirmed": out.push({ at: h.at, text: `Confirmed in ${party}'s records`, tone: "var(--st-confirmed)" }); break;
      case "rejected": out.push({ at: h.at, text: `${party[0]!.toUpperCase()}${party.slice(1)} refused it${h.note ? `: ${h.note.replace(/^refused:\s*/, "")}` : ""}`, tone: "var(--st-critical)" }); break;
      case "failed": out.push({ at: h.at, text: /validation/i.test(h.note ?? "") ? `${party[0]!.toUpperCase()}${party.slice(1)} changed what their system accepts, so it didn't go through. We're adapting.` : /no proof|resending/i.test(h.note ?? "") ? `We couldn't find it in ${party}'s records yet` : "It didn't go through", tone: "var(--st-critical)" }); break;
      case "cancelled": out.push({ at: h.at, text: "Cancelled", tone: "var(--st-idle)" }); break;
      case "closed_by_human": out.push({ at: h.at, text: "Closed by our team", tone: "var(--st-human)" }); break;
    }
  }
  return out;
}

function nowLine(t: TaskJ, snap: ClaimSnapshot): string {
  const mine = snap.approvals.filter((a) => a.status === "pending" && a.taskId === t.taskId);
  const party = waitingOn(t.type);
  const lastNote = [...t.history].reverse().find((h) => h.note)?.note ?? "";
  switch (t.status) {
    case "blocked_drift": {
      const sys = /insurer|policy/i.test(lastNote) ? "The insurer" : "A company we work with";
      return `${sys} changed how their system works, so we paused just this step to adapt. ${mine.length ? "Our team is reviewing the fix, and the rest of your claim keeps moving." : "We're adapting automatically; nothing is needed from you."}`;
    }
    case "awaiting_approval":
      if (mine.some((a) => a.approverRole === "claimant")) return "This is waiting for your decision (see “Needs your decision”).";
      return `Our team is reviewing this step${mine[0] ? ` (${(GATE_LABEL[mine[0].gate] ?? mine[0].gate).toLowerCase()})` : ""}. Nothing is needed from you.`;
    case "waiting":
    case "in_progress":
      if (t.type === "extend_rental") return "We're watching the rental's end date. If the repair isn't ready 2 days before it ends, we extend the rental (asking you first if it would go past what your policy covers).";
      return `Waiting on ${party}. We only mark it done once their records confirm it, not when they just say OK.`;
    case "confirmed":
      return "Done, and confirmed in the other company's records.";
    case "denied":
      return `This was denied${lastNote ? `: ${lastNote}` : "."} You've been sent the details.`;
    case "closed_by_human":
      return "Our team closed this step by hand.";
    default: {
      const waitingFor = t.dependsOn.map((d) => snap.tasks.find((x) => x.taskId === d)).filter((x): x is TaskJ => !!x && !DONE.includes(x.status));
      return waitingFor.length ? `Starts after: ${waitingFor.map((x) => x.title ?? x.taskId).join(", ")}.` : "Starting soon.";
    }
  }
}

function TaskLine({ t, snap }: { t: TaskJ; snap: ClaimSnapshot }) {
  const s = plainStatus(t, snap.approvals);
  const done = t.status === "confirmed";
  const needsContext = t.status === "blocked_drift" || (t.status === "awaiting_approval" && !snap.approvals.some((a) => a.status === "pending" && a.approverRole === "claimant" && a.taskId === t.taskId));
  const [open, setOpen] = useState(needsContext);
  const [all, setAll] = useState(false);
  useEffect(() => { if (needsContext) setOpen(true); }, [needsContext]);
  const events = snap.actions.filter((a) => a.taskId === t.taskId).sort((x, y) => (x.createdAt ?? "").localeCompare(y.createdAt ?? "")).flatMap(actionEvents);
  const next = snap.timers.filter((x) => x.taskId === t.taskId && !x.fired && !x.cancelled).sort((x, y) => x.dueAt.localeCompare(y.dueAt))[0];
  const party = waitingOn(t.type);
  const id = `step-${t.taskId.replace(/[^a-zA-Z0-9]/g, "-")}`;
  return (
    <li className="py-0.5">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={id}
        className="-mx-2 flex w-[calc(100%+1rem)] flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-s2">
        <span className={`flex min-w-0 items-center gap-1.5 text-sm ${done ? "text-ink2" : "text-ink"}`}>
          <span aria-hidden className={`text-[10px] text-mute transition-transform ${open ? "rotate-90" : ""}`}>›</span>
          {t.title ?? t.type}
        </span>
        <Pill look={s} size="sm" />
      </button>
      {open && (
        <div id={id} className="rise mt-1 mb-2 ml-3.5 rounded-xl bg-s2 px-3.5 py-3 text-[13px]">
          {STEP_ABOUT[t.type] && <p className="text-mute">{STEP_ABOUT[t.type]}</p>}
          <p className="mt-1.5 text-ink">{nowLine(t, snap)}</p>
          {events.length > 5 && !all && (
            <button onClick={() => setAll(true)} className="mt-3 text-xs font-medium text-ink2 underline-offset-2 hover:underline">Show {events.length - 5} earlier update{events.length - 5 === 1 ? "" : "s"}</button>
          )}
          {events.length > 0 && (
            <ol className={`${events.length > 5 && !all ? "mt-2" : "mt-3"} grid gap-2 border-l border-line pl-3.5`}>
              {(all ? events : events.slice(-5)).map((e, i) => (
                <li key={i} className="relative">
                  <span aria-hidden className="absolute top-[7px] -left-[18px] h-1.5 w-1.5 rounded-full" style={{ background: e.tone }} />
                  <span className="text-ink2">{e.text}</span> <span className="text-[11px] whitespace-nowrap text-mute">· {simDay(e.at, snap.claim.createdAt)}</span>
                </li>
              ))}
            </ol>
          )}
          {next && !done && (
            <p className="mt-3 text-xs text-mute">
              Next: we'll {(TIMER_NEXT[next.rule] ?? (() => "check in"))(party === "you" || party === "the agent" ? "them" : party)} on {simDay(next.dueAt, snap.claim.createdAt)}.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function Tracks({ snap, compact = false }: { snap: ClaimSnapshot; compact?: boolean }) {
  const tasks = [...snap.tasks].filter((t) => !t.taskId.includes(":") && !t.taskId.startsWith("CALL#")).sort(byRank);
  const lane = (k: TaskJ["track"]) => tasks.filter((t) => t.track === k);
  const done = tasks.filter((t) => DONE.includes(t.status)).length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  return (
    <Card title="Progress" right={<span className="tabular">{done} of {tasks.length} steps proven · {pct}%</span>}>
      <div className="mb-5 h-1.5 overflow-hidden rounded-full bg-s2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Claim progress">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: "var(--st-confirmed)" }} />
      </div>
      {compact ? (
        <div className="grid gap-5">
          {([["intake", "Getting started"], ["repair", "Repair"], ["rental", "Rental car"], ["medical", "Medical"], ["close", "Closing"]] as [TaskJ["track"], string][]).map(([k, label]) =>
            lane(k).length ? (
              <div key={k}>
                <Label>{label}</Label>
                <ul>{lane(k).map((t) => <TaskLine key={t.taskId} t={t} snap={snap} />)}</ul>
              </div>
            ) : null,
          )}
        </div>
      ) : (
      <div className="grid gap-6">
        <div>
          <Label>Getting started</Label>
          <ul className="grid gap-x-8 md:grid-cols-2">{lane("intake").map((t) => <TaskLine key={t.taskId} t={t} snap={snap} />)}</ul>
        </div>
        <div className="grid gap-6 md:grid-cols-3">
          {TRACKS.map((tr) => (
            <div key={tr.key}>
              <Label>{tr.label}</Label>
              {lane(tr.key).length ? (
                <ul>{lane(tr.key).map((t) => <TaskLine key={t.taskId} t={t} snap={snap} />)}</ul>
              ) : (
                <p className="py-2 text-sm text-mute">{tr.empty}</p>
              )}
            </div>
          ))}
        </div>
        <div>
          <Label>Closing</Label>
          <ul className="grid gap-x-8 md:grid-cols-2">{lane("close").map((t) => <TaskLine key={t.taskId} t={t} snap={snap} />)}</ul>
        </div>
      </div>
      )}
    </Card>
  );
}

/* --------------------------------------------------------------- decisions */

function costLine(a: ApprovalJ): string {
  const d = (a.details ?? {}) as Record<string, unknown>;
  const offer = (d.offer ?? {}) as Record<string, number>;
  switch (a.gate) {
    case "accept_settlement": return offer.amount !== undefined ? `$${offer.amount} goes to the body shop (repair $${offer.repairTotal} minus your $${offer.deductible} deductible). Usually final.` : "Usually final.";
    case "sign_release": return "You give up further repair claims for this accident.";
    case "rental_overage": return "You pay the rental days beyond what your policy covers.";
    case "discuss_fault": return "A statement about fault can change who pays.";
    case "decision_request": return `Asked by ${String(d.caller ?? "a caller")} on the claim line. We said you'd reply.`;
    default: return "";
  }
}

export function DecisionCards({ snap, who }: { snap: ClaimSnapshot; who: string }) {
  const { run, busy } = useRun();
  const pending = snap.approvals.filter((a) => a.status === "pending" && a.approverRole === "claimant");
  const reminded = (a: ApprovalJ) => snap.timers.some((t) => t.rule === "claimant_reminder" && t.approvalId === a._id && t.fired);
  if (!pending.length) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-line bg-s1 px-5 py-4 text-sm text-ink2 shadow-[var(--shadow-sm)]">
        <span aria-hidden className="grid h-6 w-6 place-items-center rounded-full text-xs" style={{ background: "color-mix(in oklab, var(--st-confirmed) 14%, transparent)", color: "var(--st-confirmed)" }}>✓</span>
        Nothing needs your decision right now. We'll let you know here.
      </div>
    );
  }
  return (
    <section aria-label="Needs your decision" className="grid gap-3">
      {pending.map((a) => (
        <div key={a._id} className="rise rounded-2xl border bg-s1 p-5 shadow-[var(--shadow-sm)]" style={{ borderColor: "color-mix(in oklab, var(--st-approval) 45%, var(--border))" }}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold tracking-wider uppercase" style={{ color: "var(--st-approval)" }}>Needs your decision</span>
            {reminded(a) && <span className="rounded-full bg-s2 px-2 py-0.5 text-[11px] text-ink2">Reminder sent</span>}
          </div>
          <h3 className="mt-1.5 text-lg font-semibold tracking-tight">{GATE_LABEL[a.gate] ?? a.gate}</h3>
          <p className="mt-1 text-ink2">{a.request}</p>
          {costLine(a) && <p className="mt-2 text-sm text-mute">{costLine(a)}</p>}
          <div className="mt-4 flex gap-2">
            <Button kind="primary" disabled={!!busy} onClick={() => run(a._id, () => decide(a._id, "approved", who))}>Approve</Button>
            <Button disabled={!!busy} onClick={() => run(a._id, () => decide(a._id, "declined", who))}>Decline</Button>
          </div>
        </div>
      ))}
    </section>
  );
}

/* ------------------------------------------------------------ photo upload */

/** Shown only while an insurer-added photo step is waiting on the claimant. */
export function PhotoRequest({ snap }: { snap: ClaimSnapshot }) {
  const { run, busy } = useRun();
  const [files, setFiles] = useState<File[]>([]);
  const [inputKey, setInputKey] = useState(0);
  const step = snap.tasks.find((t) => t.type === "upload_step" && t.status === "waiting" && /photo/i.test(`${t.params?.step ?? ""} ${t.params?.kind ?? ""}`));
  if (!step) return null;
  const submit = async () => {
    const form = new FormData();
    for (const f of files) form.append("photos", f);
    const r = await run("photos", () => uploadPhotos(snap.claim._id, form));
    if (r.ok) { setFiles([]); setInputKey((k) => k + 1); }
  };
  return (
    <section aria-label="Photos needed" className="rise rounded-2xl border bg-s1 p-5 shadow-[var(--shadow-sm)]" style={{ borderColor: "color-mix(in oklab, var(--st-approval) 45%, var(--border))" }}>
      <span className="text-[11px] font-semibold tracking-wider uppercase" style={{ color: "var(--st-approval)" }}>Needs you</span>
      <h3 className="mt-1.5 text-lg font-semibold tracking-tight">Photos of the damage</h3>
      <p className="mt-1 text-ink2">The insurer now needs photos of the damage. Upload them here and we'll send them to the insurer for you.</p>
      <input key={inputKey} type="file" multiple accept="image/*" aria-label="Damage photos" onChange={(e) => setFiles([...(e.target.files ?? [])])}
        className="mt-4 block w-full text-sm text-ink2 file:mr-3 file:h-8 file:rounded-lg file:border file:border-line file:bg-s1 file:px-3 file:text-sm file:font-medium file:text-ink hover:file:bg-s2" />
      <div className="mt-4 flex items-center gap-3">
        <Button kind="primary" disabled={!!busy || !files.length} onClick={() => void submit()}>{busy === "photos" ? "Uploading…" : `Upload${files.length ? ` ${files.length} photo${files.length === 1 ? "" : "s"}` : ""}`}</Button>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------- chat */

export function Chat({ snap, connected = true }: { snap: ClaimSnapshot; connected?: boolean }) {
  const { run, busy } = useRun();
  const [text, setText] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const msgs = snap.observations
    .filter((o) => (o.source === "claimant" && (o.kind === "message" || o.kind === "intake")) || (o.source === "system" && o.kind === "agent_message"))
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight, behavior: "smooth" });
  }, [msgs.length]);
  const send = () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    void run("msg", () => sendMessage(snap.claim._id, t));
  };
  return (
    <section aria-label="Conversation" className="flex h-[calc(100dvh-9rem)] min-h-[32rem] flex-col overflow-hidden rounded-2xl border border-line bg-s1 shadow-[var(--shadow-sm)] lg:sticky lg:top-[4.5rem]">
      <header className="flex items-center gap-3 border-b border-line px-5 py-3.5">
        <Avatar agent />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Claim Coordinator</div>
          <div className="flex items-center gap-1.5 text-xs text-mute">
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: connected ? "var(--st-confirmed)" : "var(--st-idle)" }} />
            {connected ? "Working on your claim" : "Reconnecting…"}
          </div>
        </div>
      </header>
      <div ref={box} className="flex flex-1 flex-col gap-4 overflow-auto px-5 py-5">
        {msgs.map((o) => <Bubble key={o._id} o={o} since={snap.claim.createdAt} />)}
        {!msgs.length && <p className="m-auto text-sm text-mute">No messages yet. Say hi.</p>}
      </div>
      <form className="border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <div className="flex items-end gap-2 rounded-2xl border border-line bg-s2 p-1.5 pl-4 focus-within:border-line2 focus-within:bg-s1">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={1} placeholder="Message Claim Coordinator…" aria-label="Message"
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            className="max-h-32 min-h-9 flex-1 resize-none bg-transparent py-2 text-sm text-ink outline-none placeholder:text-mute" />
          <button type="submit" disabled={!!busy || !text.trim()} aria-label="Send" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-ink text-[var(--bg)] transition hover:opacity-90 disabled:opacity-30">
            <span aria-hidden className="text-base leading-none">↑</span>
          </button>
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-mute">Enter to send · Shift+Enter for a new line</p>
      </form>
    </section>
  );
}

function Avatar({ agent, alert }: { agent?: boolean; alert?: boolean }) {
  return (
    <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold"
      style={alert ? { background: "color-mix(in oklab, var(--st-critical) 15%, transparent)", color: "var(--st-critical)" } : agent ? { background: "var(--text-primary)", color: "var(--bg)" } : { background: "var(--surface-3)", color: "var(--text-secondary)" }}>
      {alert ? "!" : agent ? "✓" : "You"}
    </span>
  );
}

function Bubble({ o, since }: { o: ObservationJ; since: string }) {
  const mine = o.source === "claimant";
  const kind = String(o.body.kind ?? "");
  const fraud = kind === "fraud_alert";
  const call = kind === "post_call_summary";
  const text = o.kind === "intake" ? `Filed the claim: ${String((o.body.form as Record<string, unknown>)?.description ?? "")}` : String(o.body.text ?? "");
  const who = mine ? "You" : fraud ? "Possible fraud" : call ? "Call summary" : "Claim Coordinator";
  return (
    <div className={`flex max-w-[88%] items-end gap-2.5 ${mine ? "flex-row-reverse self-end" : "self-start"}`}>
      {!mine && <Avatar agent={!fraud} alert={fraud} />}
      <div className="min-w-0">
        <div className={`mb-1 flex items-center gap-2 text-[11px] text-mute ${mine ? "justify-end" : ""}`} title={wall(o.receivedWallAt)}>
          <span className={fraud ? "font-semibold text-[var(--st-critical)]" : "font-medium text-ink2"}>{who}</span>
          <span>{simDay(o.receivedAt, since)}</span>
        </div>
        <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${mine ? "rounded-br-md bg-ink text-[var(--bg)]" : fraud ? "rounded-bl-md text-[var(--st-critical)]" : call ? "rounded-bl-md border border-line bg-s1 text-ink" : "rounded-bl-md bg-s2 text-ink"}`}
          style={fraud ? { background: "color-mix(in oklab, var(--st-critical) 10%, transparent)", boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--st-critical) 40%, transparent)" } : undefined}>
          {call && <span className="mb-1 block text-[11px] font-semibold tracking-wide text-mute uppercase">☎ Call summary</span>}
          {text}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- call summaries */

export function CallSummaries({ snap }: { snap: ClaimSnapshot }) {
  const calls = snap.observations.filter((o) => o.source === "phone").sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const summaries = snap.observations.filter((o) => o.kind === "agent_message" && (o.body.kind === "post_call_summary" || o.body.kind === "fraud_alert"));
  return (
    <Card title="Calls">
      {!calls.length && <p className="text-sm text-mute">No calls about this claim yet.</p>}
      <div className="grid gap-3">
        {calls.map((c) => {
          const s = summaries.find((m) => m.body.observationId === c._id && m.body.kind === "post_call_summary");
          const fields = (c.body.fields ?? {}) as Record<string, unknown>;
          const fraud = fields.payment_details_mentioned === true;
          const caller = (c.body.caller ?? {}) as Record<string, string>;
          return (
            <div key={c._id} className="rounded-xl bg-s2 p-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{caller.name ?? "Unknown caller"}</span>
                <TrustBadge trust={c.trust} />
                {c.processedAt ? (c.verified ? <Pill size="sm" look={{ color: "var(--st-confirmed)", icon: "✓", label: "Verified" }} /> : <Pill size="sm" look={{ color: "var(--st-acknowledged)", icon: "◐", label: "Claimed, not confirmed" }} />) : <span className="text-xs text-mute">Processing…</span>}
                <span className="ml-auto text-[11px] text-mute">{simDay(c.receivedAt, snap.claim.createdAt)}</span>
              </div>
              {fraud && <p className="mt-2 rounded-lg px-2.5 py-1.5 text-sm font-medium text-[var(--st-critical)]" style={{ background: "color-mix(in oklab, var(--st-critical) 10%, transparent)" }}>Asked to change payment or bank details. Not acted on: possible fraud.</p>}
              <p className="mt-2 text-sm text-ink2">{s ? String(s.body.text) : c.note ?? String(c.body.summary ?? "")}</p>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function TrustBadge({ trust }: { trust?: string }) {
  const map: Record<string, StatusLook> = {
    known: { color: "var(--st-confirmed)", icon: "●", label: "Known contact" },
    company_line: { color: "var(--st-acknowledged)", icon: "◐", label: "Company line" },
    unknown: { color: "var(--st-critical)", icon: "?", label: "Unknown number" },
  };
  return <Pill size="sm" look={map[trust ?? "unknown"] ?? map.unknown!} />;
}

/* ------------------------------------------------------------------- money */

export function Money({ rows, closing }: { rows: MoneyRowJ[]; closing: boolean }) {
  const usd = (n: number) => `$${n.toLocaleString()}`;
  return (
    <Card title="Money" right="billed = submitted = paid, or the gap is explained">
      {!rows.length ? <p className="text-sm text-mute">No bills yet.</p> : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full text-sm tabular">
            <thead className="text-left text-[11px] tracking-wider text-mute uppercase"><tr><th className="px-1 py-2 font-medium">Item</th><th className="px-1 text-right font-medium">Billed</th><th className="px-1 text-right font-medium">Submitted</th><th className="px-1 text-right font-medium">Paid</th><th className="px-1 pl-4 font-medium">Status</th></tr></thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => {
                const gap = r.billedToSubmittedGap !== 0 || r.submittedToPaidGap !== 0;
                return (
                  <tr key={r.itemId}>
                    <td className="px-1 py-2.5"><span className="text-ink">{r.itemId}</span> <span className="text-mute">· {r.category}</span></td>
                    <td className="px-1 text-right">{usd(r.billed)}</td>
                    <td className="px-1 text-right">{usd(r.submitted)}</td>
                    <td className="px-1 text-right">{usd(r.paid)}</td>
                    <td className="px-1 pl-4">{!gap ? <Pill size="sm" look={{ color: "var(--st-confirmed)", icon: "✓", label: "Balanced" }} /> : r.reason ? <span className="text-xs text-ink2">{r.reason}</span> : closing ? <Pill size="sm" look={{ color: "var(--st-critical)", icon: "!", label: "Unexplained" }} /> : r.billedToSubmittedGap !== 0 ? <Pill size="sm" look={{ color: "var(--st-sent)", icon: "↗", label: "Not yet submitted" }} /> : <Pill size="sm" look={{ color: "var(--st-acknowledged)", icon: "◐", label: "Awaiting payment" }} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
