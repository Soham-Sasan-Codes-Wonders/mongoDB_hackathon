"use client";

import { useEffect, useRef, useState } from "react";
import { decide, sendMessage } from "@/app/actions";
import { GATE_LABEL, waitingOn, type StatusLook } from "@/lib/status";
import { simDay, wall } from "@/lib/time";
import type { ApprovalJ, ClaimSnapshot, MoneyRowJ, ObservationJ, TaskJ } from "@/lib/types";
import { Button, Card, Pill, useRun } from "./ui";

export const taskRank = (id: string) => {
  const m = id.match(/^T(\d+)([a-z])?/);
  return m ? Number(m[1]) - (m[2] ? 0.5 : 0) : 99;
};
const byRank = (a: TaskJ, b: TaskJ) => taskRank(a.taskId) - taskRank(b.taskId) || a.taskId.localeCompare(b.taskId);

/* ------------------------------------------------------------------ tracks */

function plainStatus(t: TaskJ, approvals: ApprovalJ[]): StatusLook {
  const v = (n: string) => `var(--st-${n})`;
  switch (t.status) {
    case "confirmed": return { color: v("confirmed"), icon: "✔", label: "Done (proven)" };
    case "denied": return { color: v("critical"), icon: "✕", label: "Denied" };
    case "closed_by_human": return { color: v("human"), icon: "✋", label: "Closed by our team" };
    case "blocked_drift": return { color: v("critical"), icon: "⚠", label: "Blocked" };
    case "awaiting_approval":
      return approvals.some((a) => a.status === "pending" && a.approverRole === "claimant" && a.taskId === t.taskId)
        ? { color: v("approval"), icon: "✋", label: "Needs you" }
        : { color: v("approval"), icon: "⏸", label: "With our team" };
    case "waiting":
    case "in_progress": return { color: v("acknowledged"), icon: "◐", label: `Waiting on ${waitingOn(t.type)}` };
    default: return { color: v("idle"), icon: "○", label: "Not started" };
  }
}

const TRACKS: { key: TaskJ["track"]; label: string }[] = [
  { key: "repair", label: "Repair" },
  { key: "rental", label: "Rental" },
  { key: "medical", label: "Medical" },
];

function TaskLine({ t, approvals }: { t: TaskJ; approvals: ApprovalJ[] }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5">
      <span className="min-w-0 text-ink"><span className="mr-2 font-mono text-xs text-mute">{t.taskId.replace("#", " ")}</span>{t.title ?? t.type}</span>
      <Pill look={plainStatus(t, approvals)} size="sm" />
    </li>
  );
}

export function Tracks({ snap }: { snap: ClaimSnapshot }) {
  const tasks = [...snap.tasks].filter((t) => !t.taskId.includes(":") && !t.taskId.startsWith("CALL#")).sort(byRank);
  const lane = (k: TaskJ["track"]) => tasks.filter((t) => t.track === k);
  return (
    <Card title="Progress" right={<span className="text-sm text-mute">three tracks in parallel, joining at Close</span>}>
      <div className="grid gap-4">
        <div>
          <h3 className="mb-1 text-sm font-semibold tracking-wide text-ink2 uppercase">Intake</h3>
          <ul className="grid gap-x-6 md:grid-cols-2">{lane("intake").map((t) => <TaskLine key={t.taskId} t={t} approvals={snap.approvals} />)}</ul>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {TRACKS.map((tr) => (
            <div key={tr.key} className="rounded-lg bg-s2 p-3">
              <h3 className="mb-1 text-sm font-semibold tracking-wide text-ink2 uppercase">{tr.label}</h3>
              {lane(tr.key).length ? (
                <ul className="divide-y divide-line">{lane(tr.key).map((t) => <TaskLine key={t.taskId} t={t} approvals={snap.approvals} />)}</ul>
              ) : (
                <p className="text-sm text-mute">{tr.key === "medical" ? "No medical invoices yet." : "Nothing yet."}</p>
              )}
            </div>
          ))}
        </div>
        <div>
          <h3 className="mb-1 text-sm font-semibold tracking-wide text-ink2 uppercase">Close</h3>
          <ul className="grid gap-x-6 md:grid-cols-2">{lane("close").map((t) => <TaskLine key={t.taskId} t={t} approvals={snap.approvals} />)}</ul>
        </div>
      </div>
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
  return (
    <Card title={`Needs your decision${pending.length ? ` (${pending.length})` : ""}`}>
      {!pending.length && <p className="text-mute">Nothing needs you right now.</p>}
      <div className="grid gap-3">
        {pending.map((a) => (
          <div key={a._id} className="rounded-lg border-2 p-4" style={{ borderColor: "var(--st-approval)" }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-lg font-semibold">{GATE_LABEL[a.gate] ?? a.gate}</h3>
              {reminded(a) && <span className="rounded-full bg-s3 px-2 py-0.5 text-xs text-ink2">⏰ Reminder sent</span>}
            </div>
            <p className="mt-1 text-ink">{a.request}</p>
            {costLine(a) && <p className="mt-1 text-sm text-ink2">{costLine(a)}</p>}
            <div className="mt-3 flex gap-2">
              <Button kind="good" disabled={!!busy} onClick={() => run(a._id, () => decide(a._id, "approved", who))}>✔ Approve</Button>
              <Button kind="danger" disabled={!!busy} onClick={() => run(a._id, () => decide(a._id, "declined", who))}>✕ Decline</Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------- chat */

export function Chat({ snap }: { snap: ClaimSnapshot }) {
  const { run, busy } = useRun();
  const [text, setText] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const msgs = snap.observations
    .filter((o) => (o.source === "claimant" && (o.kind === "message" || o.kind === "intake")) || (o.source === "system" && o.kind === "agent_message"))
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [msgs.length]);
  return (
    <Card title="Messages">
      <div ref={box} className="flex max-h-[28rem] flex-col gap-2 overflow-auto pr-1">
        {msgs.map((o) => <Bubble key={o._id} o={o} since={snap.claim.createdAt} />)}
        {!msgs.length && <p className="text-mute">No messages yet.</p>}
      </div>
      <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); const t = text; setText(""); void run("msg", () => sendMessage(snap.claim._id, t)); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Tell us what happened, or reply here…" className="flex-1 rounded-lg border border-line bg-s2 px-3 py-2 text-ink outline-none focus:border-accent" />
        <Button type="submit" kind="primary" disabled={!!busy || !text.trim()}>Send</Button>
      </form>
    </Card>
  );
}

function Bubble({ o, since }: { o: ObservationJ; since: string }) {
  const mine = o.source === "claimant";
  const kind = String(o.body.kind ?? "");
  const fraud = kind === "fraud_alert";
  const text = o.kind === "intake" ? `Filed the claim: ${String((o.body.form as Record<string, unknown>)?.description ?? "")}` : String(o.body.text ?? "");
  return (
    <div className={`max-w-[85%] rounded-xl px-3 py-2 ${mine ? "self-end bg-accent/20" : "self-start bg-s2"}`} style={fraud ? { border: "2px solid var(--st-critical)" } : undefined}>
      <div className="mb-0.5 flex items-center gap-2 text-xs text-mute" title={wall(o.receivedWallAt)}>
        <span>{mine ? "You" : fraud ? "⚠ Possible fraud" : kind === "post_call_summary" ? "☎ Call summary" : "Claim Coordinator"}</span>
        <span>{simDay(o.receivedAt, since)}</span>
      </div>
      <p className={fraud ? "font-semibold text-[var(--st-critical)]" : "text-ink"}>{text}</p>
    </div>
  );
}

/* ---------------------------------------------------------- call summaries */

export function CallSummaries({ snap }: { snap: ClaimSnapshot }) {
  const calls = snap.observations.filter((o) => o.source === "phone").sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const summaries = snap.observations.filter((o) => o.kind === "agent_message" && (o.body.kind === "post_call_summary" || o.body.kind === "fraud_alert"));
  return (
    <Card title="Calls">
      {!calls.length && <p className="text-mute">No calls about this claim yet.</p>}
      <div className="grid gap-3">
        {calls.map((c) => {
          const s = summaries.find((m) => m.body.observationId === c._id && m.body.kind === "post_call_summary");
          const fields = (c.body.fields ?? {}) as Record<string, unknown>;
          const fraud = fields.payment_details_mentioned === true;
          const caller = (c.body.caller ?? {}) as Record<string, string>;
          return (
            <div key={c._id} className="rounded-lg bg-s2 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">☎ {caller.name ?? "Unknown caller"}</span>
                <TrustBadge trust={c.trust} />
                {c.processedAt ? (c.verified ? <Pill size="sm" look={{ color: "var(--st-confirmed)", icon: "✔", label: "verified by read-back" }} /> : <Pill size="sm" look={{ color: "var(--st-acknowledged)", icon: "◐", label: "claimed, not confirmed" }} />) : <span className="text-xs text-mute">processing…</span>}
                <span className="ml-auto text-xs text-mute">{simDay(c.receivedAt, snap.claim.createdAt)}</span>
              </div>
              {fraud && <p className="mt-2 rounded-md border-2 border-[var(--st-critical)] px-2 py-1 font-semibold text-[var(--st-critical)]">⚠ Asked to change payment or bank details. Not acted on. Possible fraud.</p>}
              <p className="mt-2 text-sm text-ink">{s ? String(s.body.text) : c.note ?? String(c.body.summary ?? "")}</p>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function TrustBadge({ trust }: { trust?: string }) {
  const map: Record<string, StatusLook> = {
    known: { color: "var(--st-confirmed)", icon: "●", label: "known contact" },
    company_line: { color: "var(--st-acknowledged)", icon: "◐", label: "company line" },
    unknown: { color: "var(--st-critical)", icon: "?", label: "unknown number" },
  };
  return <Pill size="sm" look={map[trust ?? "unknown"] ?? map.unknown!} />;
}

/* ------------------------------------------------------------------- money */

export function Money({ rows, closing }: { rows: MoneyRowJ[]; closing: boolean }) {
  const usd = (n: number) => `$${n.toLocaleString()}`;
  return (
    <Card title="Money" right={<span className="text-sm text-mute">billed = submitted = paid, or the gap is explained</span>}>
      {!rows.length ? <p className="text-mute">No bills yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular">
            <thead className="text-left text-ink2"><tr><th className="py-1 pr-3">Item</th><th className="pr-3 text-right">Billed</th><th className="pr-3 text-right">Submitted</th><th className="pr-3 text-right">Paid</th><th>Gap</th></tr></thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => {
                const gap = r.billedToSubmittedGap !== 0 || r.submittedToPaidGap !== 0;
                return (
                  <tr key={r.itemId}>
                    <td className="py-1.5 pr-3"><span className="text-ink">{r.itemId}</span> <span className="text-mute">· {r.category}</span></td>
                    <td className="pr-3 text-right">{usd(r.billed)}</td>
                    <td className="pr-3 text-right">{usd(r.submitted)}</td>
                    <td className="pr-3 text-right">{usd(r.paid)}</td>
                    <td>{!gap ? <Pill size="sm" look={{ color: "var(--st-confirmed)", icon: "✔", label: "balanced" }} /> : r.reason ? <span className="text-ink2">ⓘ {r.reason}</span> : closing ? <Pill size="sm" look={{ color: "var(--st-critical)", icon: "⚠", label: "unexplained" }} /> : r.billedToSubmittedGap !== 0 ? <Pill size="sm" look={{ color: "var(--st-sent)", icon: "↗", label: "not yet submitted" }} /> : <Pill size="sm" look={{ color: "var(--st-acknowledged)", icon: "◐", label: "awaiting payment" }} />}</td>
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
