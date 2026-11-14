"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { decide } from "@/app/actions";
import { GATE_LABEL, SOURCE_LABEL } from "@/lib/status";
import { simDay, simUntil, wall } from "@/lib/time";
import type { AgentStatus, ApprovalJ, ClaimRow, ClaimSnapshot, ObservationJ } from "@/lib/types";
import { TrustBadge } from "./claimant";
import { Button, Card, Dialog, Json, Pill, useRun, useToast } from "./ui";

/* ------------------------------------------------------------ observations */

function obsSummary(o: ObservationJ): string {
  const b = o.body;
  if (o.source === "phone") return `${(b.caller as Record<string, string>)?.name ?? "caller"}: ${o.note ?? String(b.summary ?? "")}`;
  if (o.source === "approval_ui") return `${b.decidedBy} ${b.decision}`;
  if (b.text) return String(b.text);
  if (b.event || b.data) return `${o.kind} ${JSON.stringify(b.data ?? {}).slice(0, 120)}`;
  return o.note ?? o.kind;
}

export function ObservationsFeed({ snap }: { snap: ClaimSnapshot }) {
  const sources = ["all", "insurer", "body_shop", "rental", "clinic", "claimant", "approval_ui", "phone", "system"];
  const [f, setF] = useState("all");
  const list = snap.observations.filter((o) => f === "all" || o.source === f);
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1">
        {sources.map((s) => (
          <button key={s} onClick={() => setF(s)} className={`rounded-full border px-2 py-0.5 text-xs ${f === s ? "border-accent text-accent" : "border-line text-ink2"}`}>{s === "all" ? "All" : SOURCE_LABEL[s]}</button>
        ))}
      </div>
      <ul className="max-h-[340px] divide-y divide-line overflow-auto pr-1">
        {list.map((o) => (
          <li key={o._id} className="flex items-start gap-2 py-1.5 text-sm">
            <span className="w-24 shrink-0 text-xs text-mute" title={wall(o.receivedWallAt)}>{simDay(o.receivedAt, snap.claim.createdAt)}</span>
            <span className="w-20 shrink-0 text-xs font-semibold text-ink2">{SOURCE_LABEL[o.source] ?? o.source}</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-xs text-ink2">{o.kind}</span>
                {o.source === "phone" && <TrustBadge trust={o.trust} />}
                {o.source === "phone" && o.processedAt && (o.verified ? <Pill size="sm" look={{ color: "var(--st-confirmed)", icon: "✔", label: "verified" }} /> : <Pill size="sm" look={{ color: "var(--st-acknowledged)", icon: "◐", label: "claimed, not confirmed" }} />)}
                {!o.processedAt && <Pill size="sm" look={{ color: "var(--st-sent)", icon: "⧗", label: "unprocessed" }} />}
                {o.matchedActionId && <span className="text-[11px] text-mute">→ action …{o.matchedActionId.slice(-6)}</span>}
              </div>
              <p className="truncate text-ink" title={obsSummary(o)}>{obsSummary(o)}</p>
            </div>
          </li>
        ))}
        {!list.length && <li className="py-2 text-mute">Nothing yet.</li>}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ timers */

export function Timers({ snap }: { snap: ClaimSnapshot }) {
  const open = snap.timers.filter((t) => !t.fired && !t.cancelled);
  const fired = snap.timers.filter((t) => t.fired).slice(-12).reverse();
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div>
        <h3 className="mb-1 text-sm font-semibold text-ink2">Upcoming</h3>
        <ul className="divide-y divide-line text-sm">
          {open.map((t) => (
            <li key={t._id} className="flex justify-between gap-2 py-1"><span><span className="font-mono text-xs">{t.rule}</span> · {t.taskId}</span><span className="tabular text-ink2">{simUntil(t.dueAt, snap.simNow)}</span></li>
          ))}
          {!open.length && <li className="py-1 text-mute">None.</li>}
        </ul>
      </div>
      <div>
        <h3 className="mb-1 text-sm font-semibold text-ink2">Fired</h3>
        <ul className="divide-y divide-line text-sm">
          {fired.map((t) => (
            <li key={t._id} className="flex justify-between gap-2 py-1 text-ink2"><span><span className="font-mono text-xs">{t.rule}</span> · {t.taskId}{t.escalationLevel ? ` · level ${t.escalationLevel}` : ""}</span><span className="tabular">{simUntil(t.dueAt, snap.simNow)}</span></li>
          ))}
          {!fired.length && <li className="py-1 text-mute">None yet.</li>}
        </ul>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- approvals */

export function ApprovalBody({ a }: { a: ApprovalJ }) {
  const d = (a.details ?? {}) as Record<string, unknown>;
  if (a.gate === "drift_mapping") {
    const renames = (d.renames as { endpoint: string; from: string; to: string | null }[] | undefined) ?? [];
    const matches = (d.canonicalMatches as { systemField: string; endpoint?: string; candidates: { fieldName: string; score: number }[] }[] | undefined) ?? [];
    const proposal = (d.proposal ?? {}) as { mappings?: { canonical: string; systemField: string; confidence: number; rationale: string }[]; newTasks?: { title: string; kind: string; blocksTaskIds: string[]; confidence: number }[] };
    const exps = (d.similarExperiences as { problem: string; outcome: string; score: number }[] | undefined) ?? [];
    return (
      <div className="grid gap-3 text-sm">
        <p className="text-ink">{a.request}</p>
        <div className="flex flex-wrap gap-3">
          <span>LLM confidence <b className="tabular">{Number(d.confidence ?? 0).toFixed(2)}</b></span>
          <span className="text-ink2">auto-apply threshold <b className="tabular">{Number(d.threshold ?? 0.85).toFixed(2)}</b></span>
        </div>
        {!!renames.length && (
          <div><h4 className="mb-1 text-xs text-mute">Old → new field</h4>
            <ul>{renames.map((r, i) => <li key={i} className="font-mono">{r.endpoint}: <span className="line-through text-ink2">{r.from}</span> → <b>{r.to ?? "?"}</b></li>)}</ul></div>
        )}
        {!!proposal.mappings?.length && (
          <div><h4 className="mb-1 text-xs text-mute">Proposed mappings</h4>
            <ul>{proposal.mappings.map((m, i) => <li key={i}><span className="font-mono">{m.canonical} → {m.systemField}</span> <span className="tabular text-ink2">({m.confidence.toFixed(2)})</span> <span className="text-mute">{m.rationale}</span></li>)}</ul></div>
        )}
        {!!proposal.newTasks?.length && (
          <div><h4 className="mb-1 text-xs text-mute">Proposed new tasks</h4>
            <ul>{proposal.newTasks.map((t, i) => <li key={i}>{t.title} <span className="font-mono text-ink2">({t.kind}, blocks {t.blocksTaskIds.join(", ") || "-"})</span> <span className="tabular text-ink2">{t.confidence.toFixed(2)}</span></li>)}</ul></div>
        )}
        {!!matches.length && (
          <div><h4 className="mb-1 text-xs text-mute">Vector Search: new field → canonical fields</h4>
            <ul>{matches.map((m, i) => <li key={i}><span className="font-mono">{m.endpoint ? `${m.endpoint}.` : ""}{m.systemField}</span> → {m.candidates.map((c) => `${c.fieldName} ${c.score.toFixed(2)}`).join(" · ")}</li>)}</ul></div>
        )}
        {!!exps.length && (
          <div><h4 className="mb-1 text-xs text-mute">Similar past experiences</h4>
            <ul className="list-disc pl-5">{exps.map((e, i) => <li key={i}>{e.problem} <span className="text-mute">→ {e.outcome}</span> <span className="tabular text-ink2">({e.score.toFixed(2)})</span></li>)}</ul></div>
        )}
      </div>
    );
  }
  return (
    <div className="grid gap-2 text-sm">
      <p className="text-ink">{a.request}</p>
      {Object.keys(d).length > 0 && <Json value={d} />}
    </div>
  );
}

export function Approvals({ snap }: { snap: ClaimSnapshot }) {
  const { run, busy } = useRun();
  const { push, dismiss } = useToast();
  const [open, setOpen] = useState<ApprovalJ | null>(null);
  const pending = useMemo(() => snap.approvals.filter((a) => a.status === "pending"), [snap.approvals]);
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!known.current) {
      known.current = new Set(pending.map((a) => a._id));
      return;
    }
    for (const a of pending) {
      if (known.current.has(a._id)) continue;
      known.current.add(a._id);
      push({ key: `approval:${a._id}`, text: `⏸ Needs ${a.approverRole}: ${GATE_LABEL[a.gate] ?? a.gate} (click to review)`, tone: "info", sticky: true, onClick: () => setOpen(a) });
    }
    // a decided approval's toast goes away
    for (const a of snap.approvals) if (a.status !== "pending") dismiss(`approval:${a._id}`);
  }, [pending, snap.approvals, push, dismiss]);
  const actAs = (a: ApprovalJ) => (a.approverRole === "claimant" ? `claimant:${snap.claim.claimant.name} (via ops)` : "operator:console");
  return (
    <>
      <ul className="grid gap-2">
        {pending.map((a) => (
          <li key={a._id} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--st-approval)] p-2">
            <Pill size="sm" look={{ color: "var(--st-approval)", icon: "⏸", label: a.approverRole }} />
            <span className="font-medium">{GATE_LABEL[a.gate] ?? a.gate}</span>
            {a.taskId && <span className="font-mono text-xs text-mute">{a.taskId}</span>}
            <div className="ml-auto flex gap-1.5">
              <Button onClick={() => setOpen(a)}>Review</Button>
              <Button kind="good" disabled={!!busy} title={`Approve: ${GATE_LABEL[a.gate] ?? a.gate}`} onClick={() => run(a._id, () => decide(a._id, "approved", actAs(a)))}><span aria-hidden>✔</span><span className="sr-only">Approve {GATE_LABEL[a.gate] ?? a.gate}</span></Button>
              <Button kind="danger" disabled={!!busy} title={`Decline: ${GATE_LABEL[a.gate] ?? a.gate}`} onClick={() => run(a._id, () => decide(a._id, "declined", actAs(a)))}><span aria-hidden>✕</span><span className="sr-only">Decline {GATE_LABEL[a.gate] ?? a.gate}</span></Button>
            </div>
          </li>
        ))}
        {!pending.length && <li className="text-mute">No pending approvals.</li>}
      </ul>
      <Dialog open={!!open} onClose={() => setOpen(null)} title={open ? `${GATE_LABEL[open.gate] ?? open.gate} · ${open.approverRole} decides` : ""}>
        {open && (
          <>
            <ApprovalBody a={open} />
            <div className="mt-4 flex gap-2">
              <Button kind="good" disabled={!!busy} onClick={async () => { await run(open._id, () => decide(open._id, "approved", actAs(open))); setOpen(null); }}>✔ Approve</Button>
              <Button kind="danger" disabled={!!busy} onClick={async () => { await run(open._id, () => decide(open._id, "declined", actAs(open))); setOpen(null); }}>✕ Decline</Button>
              {open.approverRole === "claimant" && <span className="self-center text-xs text-mute">Normally the claimant decides in their view; this records you as acting for them.</span>}
            </div>
          </>
        )}
      </Dialog>
    </>
  );
}

/* --------------------------------------------------------- agent status */

export function AgentStatusPanel({ status, connected }: { status: AgentStatus | null; connected: boolean }) {
  if (!status) return <Card title="Agent"><p className="text-mute">Connecting…</p></Card>;
  const now = Date.now();
  const ids = status.workers?.configured ?? status.workerState?.map((w) => w.workerId) ?? [];
  return (
    <Card title="Agent" right={<span className="text-xs text-mute">{connected ? "● live (SSE)" : "○ reconnecting"} · LLM {status.llmMode ?? "?"}</span>}>
      {!status.reachable && <p className="mb-2 font-semibold text-[var(--st-critical)]">⚠ Control API on :4100 not reachable. Start it with pnpm agent:dev.</p>}
      <ul className="grid gap-2">
        {ids.map((id) => {
          const proc = status.workers?.running.find((r) => r.workerId === id);
          const ws = status.workerState?.find((w) => w.workerId === id);
          const beat = ws?.heartbeatAt ? (now - new Date(ws.heartbeatAt).getTime()) / 1000 : Infinity;
          const alive = !!proc && beat < 10;
          const held = (status.leases ?? []).filter((l) => l.workerId === id && l.live).map((l) => l.claimId);
          return (
            <li key={id} className="flex flex-wrap items-center gap-2 text-sm">
              <Pill size="sm" look={alive ? { color: "var(--st-confirmed)", icon: "●", label: "alive" } : { color: "var(--st-critical)", icon: "✕", label: "dead" }} />
              <span className="font-mono font-semibold">{id}</span>
              {proc && <span className="text-mute">pid {proc.pid}</span>}
              <span className="text-ink2">leases: {held.length ? held.join(", ") : "none"}</span>
              <span className="text-mute">resume token saved {ws?.resumeTokenSavedAt ? new Date(ws.resumeTokenSavedAt).toLocaleTimeString() : "never"}</span>
              {!!ws?.replayedFromToken && <span className="text-ink2">replayed {ws.replayedFromToken} from token</span>}
            </li>
          );
        })}
      </ul>
      {status.clock && <p className="mt-2 text-xs text-mute">sim clock {new Date(status.clock.sim).toISOString().slice(0, 16).replace("T", " ")}{status.speed ? ` · 1 claim day = ${Math.round(86_400_000 / status.speed / 1000)}s` : ""}</p>}
    </Card>
  );
}

/* ----------------------------------------------------------- claims list */

export function ClaimsTable({ rows }: { rows: ClaimRow[] | null }) {
  if (!rows) return <p className="text-mute">Loading…</p>;
  if (!rows.length) return <p className="text-mute">No claims yet. Start one from the demo panel.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm tabular">
        <thead className="text-left text-ink2"><tr><th className="py-1 pr-3">Claim</th><th className="pr-3">Claimant</th><th className="pr-3">Phase</th><th className="pr-3">Tasks</th><th className="pr-3">Open gates</th><th className="pr-3">Unconfirmed actions</th><th>Lease</th></tr></thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={r._id} className="hover:bg-s2">
              <td className="py-1.5 pr-3"><Link className="font-mono font-semibold text-accent underline-offset-2 hover:underline" href={`/ops/claim/${r._id}`}>{r._id}</Link> <Link className="text-xs text-mute hover:text-ink" href={`/claim/${r._id}`}>claimant view</Link></td>
              <td className="pr-3">{r.claimantName}</td>
              <td className="pr-3">{r.phase}</td>
              <td className="pr-3">{r.tasksDone}/{r.tasksTotal}</td>
              <td className="pr-3">{r.openGates ? <Pill size="sm" look={{ color: "var(--st-approval)", icon: "⏸", label: String(r.openGates) }} /> : "0"}</td>
              <td className="pr-3">{r.unconfirmedActions ? <Pill size="sm" look={{ color: "var(--st-acknowledged)", icon: "◐", label: String(r.unconfirmedActions) }} /> : "0"}</td>
              <td>{r.leaseHolder ? <span className={r.leaseLive ? "" : "text-mute line-through"}>{r.leaseHolder}</span> : <span className="text-mute">-</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------------------------------------- health */

type Sample = { ts: string; latencyMs: number; ok: boolean };
function Sparkline({ samples }: { samples: Sample[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 220, H = 44;
  if (samples.length < 2) return <div className="flex h-11 items-center text-xs text-mute">not enough data</div>;
  const max = Math.max(...samples.map((s) => s.latencyMs), 1);
  const x = (i: number) => (i / (samples.length - 1)) * (W - 4) + 2;
  const y = (v: number) => H - 3 - (v / max) * (H - 8);
  const pts = samples.map((s, i) => `${x(i)},${y(s.latencyMs)}`).join(" ");
  const h = hover !== null ? samples[hover] : null;
  return (
    <div className="relative">
      <svg width={W} height={H} role="img" aria-label="latency over time" onMouseLeave={() => setHover(null)} onMouseMove={(e) => {
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        setHover(Math.max(0, Math.min(samples.length - 1, Math.round(((e.clientX - r.left - 2) / (W - 4)) * (samples.length - 1)))));
      }}>
        <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {samples.map((s, i) => (!s.ok ? <circle key={i} cx={x(i)} cy={y(s.latencyMs)} r={4} fill="var(--st-critical)" stroke="var(--surface-1)" strokeWidth={2} /> : null))}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} stroke="var(--text-muted)" strokeWidth={1} />}
      </svg>
      {h && <div className="pointer-events-none absolute -top-8 left-0 rounded bg-s3 px-2 py-0.5 text-xs whitespace-nowrap">{h.latencyMs} ms · {h.ok ? "ok" : "error"} · {new Date(h.ts).toISOString().slice(5, 16).replace("T", " ")}</div>}
    </div>
  );
}

export function Health() {
  const [series, setSeries] = useState<{ system: string; samples: Sample[] }[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => { const r = await fetch("/api/health", { cache: "no-store" }); if (r.ok && alive) setSeries(await r.json()); };
    void load();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return (
    <Card title="System health" right={<span className="text-xs text-mute">latency per call · red dots = errors · last 3 sim days</span>}>
      <div className="grid gap-3 sm:grid-cols-2">
        {(series ?? []).map((s) => {
          const n = s.samples.length;
          const err = n ? s.samples.filter((x) => !x.ok).length / n : 0;
          const avg = n ? Math.round(s.samples.reduce((a, b) => a + b.latencyMs, 0) / n) : 0;
          const tone = err === 0 ? { color: "var(--st-confirmed)", icon: "✔", label: "0% errors" } : err < 0.1 ? { color: "var(--st-acknowledged)", icon: "◐", label: `${(err * 100).toFixed(0)}% errors` } : { color: "var(--st-critical)", icon: "⚠", label: `${(err * 100).toFixed(0)}% errors` };
          return (
            <div key={s.system} className="rounded-lg bg-s2 p-2">
              <div className="flex items-center justify-between gap-2"><span className="font-semibold">{s.system}</span><Pill size="sm" look={tone} /></div>
              <div className="text-xs text-ink2 tabular">{n} calls · avg {avg} ms</div>
              <Sparkline samples={s.samples} />
            </div>
          );
        })}
        {!series && <p className="text-mute">Loading…</p>}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------ experiences */

export function Experiences() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<{ _id: string; problemType: string; system: string; problem: string; outcome: string; fix: Record<string, unknown> }[]>([]);
  useEffect(() => {
    const t = setTimeout(async () => { const r = await fetch(`/api/experiences?q=${encodeURIComponent(q)}`, { cache: "no-store" }); if (r.ok) setRows(await r.json()); }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <Card title="What the agent has learned" right={<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="w-48 rounded-lg border border-line bg-s2 px-2 py-1 text-sm" />}>
      <ul className="max-h-80 divide-y divide-line overflow-auto pr-1 text-sm">
        {rows.map((e) => (
          <li key={e._id} className="py-1.5">
            <div className="flex gap-2"><span className="rounded bg-s3 px-1.5 text-xs">{e.problemType}</span><span className="text-xs text-mute">{e.system}</span></div>
            <p className="text-ink">{e.problem}</p>
            <p className="text-ink2">→ {e.outcome}</p>
          </li>
        ))}
        {!rows.length && <li className="py-2 text-mute">No matches.</li>}
      </ul>
    </Card>
  );
}

export function Summary({ snap }: { snap: ClaimSnapshot }) {
  return (
    <div>
      <p className="whitespace-pre-wrap text-ink">{snap.claim.compactSummary || "(empty: the agent hasn't summarised this claim yet)"}</p>
      <p className="mt-2 text-xs text-mute">{snap.claim.compactSummary.length}/2000 chars. This is all the agent reloads after a crash: no conversation history.</p>
    </div>
  );
}
