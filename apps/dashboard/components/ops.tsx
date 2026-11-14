"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { decide } from "@/app/actions";
import { GATE_LABEL, SOURCE_LABEL } from "@/lib/status";
import { simDay, simUntil, wall } from "@/lib/time";
import type { AgentStatus, ApprovalJ, ClaimRow, ClaimSnapshot, ObservationJ } from "@/lib/types";
import { TrustBadge } from "./claimant";
import { Button, Card, Dialog, Json, Label, LiveDot, Pill, Segmented, useRun, useToast } from "./ui";

/* ------------------------------------------------------------ observations */

function obsSummary(o: ObservationJ): string {
  const b = o.body;
  if (o.source === "phone") return `${(b.caller as Record<string, string>)?.name ?? "caller"}: ${o.note ?? String(b.summary ?? "")}`;
  if (o.source === "approval_ui") return `${b.decidedBy} ${b.decision}`;
  if (b.text) return String(b.text);
  if (b.event || b.data) return `${o.kind.replace(/_/g, " ")} ${JSON.stringify(b.data ?? {}).slice(0, 120)}`;
  return o.note ?? o.kind;
}

const SOURCES = ["all", "insurer", "body_shop", "rental", "clinic", "claimant", "approval_ui", "phone", "system"] as const;

export function ObservationsFeed({ snap }: { snap: ClaimSnapshot }) {
  const [f, setF] = useState<(typeof SOURCES)[number]>("all");
  const list = snap.observations.filter((o) => f === "all" || o.source === f);
  return (
    <div>
      <div className="mb-3 overflow-x-auto">
        <Segmented size="sm" value={f} onChange={setF} options={SOURCES.map((s) => ({ value: s, label: s === "all" ? "All" : SOURCE_LABEL[s] }))} />
      </div>
      <ul className="-mx-2 max-h-[340px] overflow-auto">
        {list.map((o) => (
          <li key={o._id} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 rounded-lg px-2 py-2 hover:bg-s2">
            <div className="text-[11px] leading-tight text-mute" title={wall(o.receivedWallAt)}>
              <div className="font-medium text-ink2">{SOURCE_LABEL[o.source] ?? o.source}</div>
              {simDay(o.receivedAt, snap.claim.createdAt)}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[11px] text-ink2">{o.kind}</span>
                {o.source === "phone" && <TrustBadge trust={o.trust} />}
                {o.source === "phone" && o.processedAt && (o.verified ? <Pill size="sm" look={{ color: "var(--st-confirmed)", icon: "✓", label: "Verified" }} /> : <Pill size="sm" look={{ color: "var(--st-acknowledged)", icon: "◐", label: "Claimed, not confirmed" }} />)}
                {!o.processedAt && <Pill size="sm" look={{ color: "var(--st-sent)", icon: "⧗", label: "Unprocessed" }} />}
                {o.matchedActionId && <span className="text-[11px] text-mute">→ action …{o.matchedActionId.slice(-6)}</span>}
              </div>
              <p className="truncate text-sm text-ink" title={obsSummary(o)}>{obsSummary(o)}</p>
            </div>
          </li>
        ))}
        {!list.length && <li className="px-2 py-6 text-center text-sm text-mute">Nothing yet.</li>}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ timers */

export function Timers({ snap }: { snap: ClaimSnapshot }) {
  const open = snap.timers.filter((t) => !t.fired && !t.cancelled);
  const fired = snap.timers.filter((t) => t.fired).slice(-12).reverse();
  const row = (t: (typeof snap.timers)[number], muted = false) => (
    <li key={t._id} className={`flex items-center justify-between gap-3 py-2 text-sm ${muted ? "text-ink2" : ""}`}>
      <span className="min-w-0 truncate"><span className="font-mono text-xs">{t.rule}</span> <span className="text-mute">· {t.taskId}{t.escalationLevel ? ` · level ${t.escalationLevel}` : ""}</span></span>
      <span className="shrink-0 tabular text-xs text-mute">{simUntil(t.dueAt, snap.simNow)}</span>
    </li>
  );
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div><Label>Upcoming</Label><ul className="divide-y divide-line">{open.map((t) => row(t))}{!open.length && <li className="py-2 text-sm text-mute">None.</li>}</ul></div>
      <div><Label>Fired</Label><ul className="divide-y divide-line">{fired.map((t) => row(t, true))}{!fired.length && <li className="py-2 text-sm text-mute">None yet.</li>}</ul></div>
    </div>
  );
}

/* --------------------------------------------------------------- approvals */

export function ApprovalBody({ a }: { a: ApprovalJ }) {
  const d = (a.details ?? {}) as Record<string, unknown>;
  if (a.gate === "drift_mapping" && !d.analysisFailed) {
    const renames = (d.renames as { endpoint: string; from: string; to: string | null }[] | undefined) ?? [];
    const matches = (d.canonicalMatches as { systemField: string; endpoint?: string; candidates: { fieldName: string; score: number }[] }[] | undefined) ?? [];
    const proposal = (d.proposal ?? {}) as { mappings?: { canonical: string; systemField: string; confidence: number; rationale: string }[]; newTasks?: { title: string; kind: string; blocksTaskIds: string[]; confidence: number }[] };
    const exps = (d.similarExperiences as { problem: string; outcome: string; score: number }[] | undefined) ?? [];
    const conf = Number(d.confidence ?? 0);
    const threshold = Number(d.threshold ?? 0.85);
    return (
      <div className="grid gap-5 text-sm">
        <p className="text-ink2">{a.request}</p>
        <div>
          <div className="mb-1.5 flex justify-between text-xs"><span className="text-ink2">LLM confidence <b className="tabular text-ink">{conf.toFixed(2)}</b></span><span className="text-mute">auto-apply at {threshold.toFixed(2)}</span></div>
          <div className="relative h-1.5 rounded-full bg-s2" role="meter" aria-valuenow={conf} aria-valuemin={0} aria-valuemax={1} aria-label="Confidence">
            <div className="h-full rounded-full" style={{ width: `${conf * 100}%`, background: conf >= threshold ? "var(--st-confirmed)" : "var(--st-acknowledged)" }} />
            <span className="absolute -top-1 h-3.5 w-px bg-ink" style={{ left: `${threshold * 100}%` }} />
          </div>
        </div>
        {!!renames.length && (
          <div><Label>Old → new field</Label>
            <ul className="grid gap-1">{renames.map((r, i) => <li key={i} className="font-mono text-xs"><span className="text-mute">{r.endpoint}</span> <span className="text-ink2 line-through">{r.from}</span> → <b>{r.to ?? "?"}</b></li>)}</ul></div>
        )}
        {!!proposal.mappings?.length && (
          <div><Label>Proposed mappings</Label>
            <ul className="grid gap-1.5">{proposal.mappings.map((m, i) => <li key={i}><span className="font-mono text-xs">{m.canonical} → {m.systemField}</span> <span className="tabular text-xs text-ink2">{m.confidence.toFixed(2)}</span><p className="text-xs text-mute">{m.rationale}</p></li>)}</ul></div>
        )}
        {!!proposal.newTasks?.length && (
          <div><Label>Proposed new tasks</Label>
            <ul className="grid gap-1">{proposal.newTasks.map((t, i) => <li key={i}>{t.title} <span className="font-mono text-xs text-mute">({t.kind}, blocks {t.blocksTaskIds.join(", ") || "-"})</span> <span className="tabular text-xs text-ink2">{t.confidence.toFixed(2)}</span></li>)}</ul></div>
        )}
        {!!matches.length && (
          <div><Label>Vector Search: new field → canonical field</Label>
            <ul className="grid gap-1">{matches.map((m, i) => <li key={i} className="text-xs"><span className="font-mono">{m.endpoint ? `${m.endpoint}.` : ""}{m.systemField}</span> <span className="text-mute">→</span> {m.candidates.map((c) => `${c.fieldName} ${c.score.toFixed(2)}`).join(" · ")}</li>)}</ul></div>
        )}
        {!!exps.length && (
          <div><Label>Similar past experiences</Label>
            <ul className="grid gap-1.5">{exps.map((e, i) => <li key={i} className="text-xs">{e.problem} <span className="text-mute">→ {e.outcome}</span> <span className="tabular text-ink2">({e.score.toFixed(2)})</span></li>)}</ul></div>
        )}
      </div>
    );
  }
  return (
    <div className="grid gap-3 text-sm">
      <p className="text-ink2">{a.request}</p>
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
      push({ key: `approval:${a._id}`, text: `Needs ${a.approverRole}: ${GATE_LABEL[a.gate] ?? a.gate}. Click to review.`, tone: "info", sticky: true, onClick: () => setOpen(a) });
    }
    // a decided approval's toast goes away
    for (const a of snap.approvals) if (a.status !== "pending") dismiss(`approval:${a._id}`);
  }, [pending, snap.approvals, push, dismiss]);
  const actAs = (a: ApprovalJ) => (a.approverRole === "claimant" ? `claimant:${snap.claim.claimant.name} (via ops)` : "operator:console");
  return (
    <>
      <ul className="grid gap-2">
        {pending.map((a) => (
          <li key={a._id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-s2 px-3 py-2.5">
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--st-approval)" }} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{GATE_LABEL[a.gate] ?? a.gate}</div>
              <div className="text-xs text-mute">{a.approverRole} decides{a.taskId ? ` · ${a.taskId}` : ""}</div>
            </div>
            <div className="flex gap-1.5">
              <Button size="sm" kind="ghost" onClick={() => setOpen(a)}>Review</Button>
              <Button size="sm" kind="good" disabled={!!busy} title={`Approve: ${GATE_LABEL[a.gate] ?? a.gate}`} onClick={() => run(a._id, () => decide(a._id, "approved", actAs(a)))}><span aria-hidden>✓</span><span className="sr-only">Approve {GATE_LABEL[a.gate] ?? a.gate}</span></Button>
              <Button size="sm" kind="danger" disabled={!!busy} title={`Decline: ${GATE_LABEL[a.gate] ?? a.gate}`} onClick={() => run(a._id, () => decide(a._id, "declined", actAs(a)))}><span aria-hidden>✕</span><span className="sr-only">Decline {GATE_LABEL[a.gate] ?? a.gate}</span></Button>
            </div>
          </li>
        ))}
        {!pending.length && <li className="py-6 text-center text-sm text-mute">No pending approvals.</li>}
      </ul>
      <Dialog open={!!open} onClose={() => setOpen(null)} title={open ? `${GATE_LABEL[open.gate] ?? open.gate}` : ""}>
        {open && (
          <>
            <ApprovalBody a={open} />
            <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <Button kind="primary" disabled={!!busy} onClick={async () => { await run(open._id, () => decide(open._id, "approved", actAs(open))); setOpen(null); }}>Approve</Button>
              <Button disabled={!!busy} onClick={async () => { await run(open._id, () => decide(open._id, "declined", actAs(open))); setOpen(null); }}>Decline</Button>
              <span className="text-xs text-mute">{open.approverRole === "claimant" ? "Normally the claimant decides in their view; this records you as acting for them." : "Operator decision"}</span>
            </div>
          </>
        )}
      </Dialog>
    </>
  );
}

/* --------------------------------------------------------- agent status */

export function AgentStatusPanel({ status, connected }: { status: AgentStatus | null; connected: boolean }) {
  if (!status) return <Card title="Agent"><p className="text-sm text-mute">Connecting…</p></Card>;
  const now = Date.now();
  const ids = status.workers?.configured ?? status.workerState?.map((w) => w.workerId) ?? [];
  return (
    <Card title="Agent" right={<span className="flex items-center gap-3"><LiveDot on={connected} /><span>LLM {status.llmMode ?? "?"}</span></span>}>
      {!status.reachable && <p className="mb-3 rounded-lg px-3 py-2 text-sm font-medium text-[var(--st-critical)]" style={{ background: "color-mix(in oklab, var(--st-critical) 10%, transparent)" }}>Control API on :4100 isn't reachable. Start it with <code className="font-mono">pnpm agent:dev</code>.</p>}
      <ul className="grid gap-2.5">
        {ids.map((id) => {
          const proc = status.workers?.running.find((r) => r.workerId === id);
          const ws = status.workerState?.find((w) => w.workerId === id);
          const beat = ws?.heartbeatAt ? (now - new Date(ws.heartbeatAt).getTime()) / 1000 : Infinity;
          const alive = !!proc && beat < 10;
          const held = (status.leases ?? []).filter((l) => l.workerId === id && l.live).map((l) => l.claimId);
          return (
            <li key={id} className="rounded-xl bg-s2 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <Pill size="sm" look={alive ? { color: "var(--st-confirmed)", icon: "●", label: "Alive" } : { color: "var(--st-critical)", icon: "✕", label: "Dead" }} />
                <span className="font-mono text-sm font-semibold">{id}</span>
                {proc && <span className="text-xs text-mute">pid {proc.pid}</span>}
              </div>
              <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
                <dt className="text-mute">Leases</dt><dd className="truncate text-ink2">{held.length ? held.join(", ") : "none"}</dd>
                <dt className="text-mute">Resume token</dt><dd className="text-ink2">{ws?.resumeTokenSavedAt ? `saved ${new Date(ws.resumeTokenSavedAt).toLocaleTimeString()}` : "never"}{ws?.replayedFromToken ? ` · replayed ${ws.replayedFromToken}` : ""}</dd>
              </dl>
            </li>
          );
        })}
      </ul>
      {status.clock && <p className="mt-3 text-xs text-mute">Sim clock {new Date(status.clock.sim).toISOString().slice(0, 16).replace("T", " ")}{status.speed ? ` · 1 claim day = ${Math.round(86_400_000 / status.speed / 1000)}s` : ""}</p>}
    </Card>
  );
}

/* ----------------------------------------------------------- claims list */

export function ClaimsTable({ rows }: { rows: ClaimRow[] | null }) {
  if (!rows) return <p className="py-6 text-center text-sm text-mute">Loading…</p>;
  if (!rows.length) return <p className="py-8 text-center text-sm text-mute">No claims yet. Start one from the demo panel below.</p>;
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="w-full text-sm tabular">
        <thead className="text-left text-[11px] tracking-wider text-mute uppercase"><tr><th className="py-2 pr-3 pl-5 font-medium">Claim</th><th className="pr-3 font-medium">Claimant</th><th className="pr-3 font-medium">Phase</th><th className="pr-3 font-medium">Progress</th><th className="pr-3 font-medium">Gates</th><th className="pr-3 font-medium">Unconfirmed</th><th className="pr-5 font-medium">Lease</th></tr></thead>
        <tbody className="divide-y divide-line border-t border-line">
          {rows.map((r) => {
            const pct = r.tasksTotal ? Math.round((r.tasksDone / r.tasksTotal) * 100) : 0;
            return (
              <tr key={r._id} className="transition-colors hover:bg-s2">
                <td className="py-2.5 pr-3 pl-5"><Link className="font-mono font-semibold text-ink hover:underline" href={`/ops/claim/${r._id}`}>{r._id}</Link> <Link className="ml-1 text-xs text-mute hover:text-ink" href={`/claim/${r._id}`}>claimant view ↗</Link></td>
                <td className="pr-3 text-ink2">{r.claimantName}</td>
                <td className="pr-3"><span className="rounded-md bg-s2 px-1.5 py-0.5 text-xs text-ink2">{r.phase}</span></td>
                <td className="pr-3">
                  <div className="flex items-center gap-2"><div className="h-1 w-16 overflow-hidden rounded-full bg-s2"><div className="h-full rounded-full" style={{ width: `${pct}%`, background: "var(--st-confirmed)" }} /></div><span className="text-xs text-mute">{r.tasksDone}/{r.tasksTotal}</span></div>
                </td>
                <td className="pr-3">{r.openGates ? <Pill size="sm" look={{ color: "var(--st-approval)", icon: "⏸", label: String(r.openGates) }} /> : <span className="text-mute">0</span>}</td>
                <td className="pr-3">{r.unconfirmedActions ? <Pill size="sm" look={{ color: "var(--st-acknowledged)", icon: "◐", label: String(r.unconfirmedActions) }} /> : <span className="text-mute">0</span>}</td>
                <td className="pr-5">{r.leaseHolder ? <span className={`font-mono text-xs ${r.leaseLive ? "text-ink2" : "text-mute line-through"}`}>{r.leaseHolder}</span> : <span className="text-mute">–</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------------------------------------- health */

type Sample = { ts: string; latencyMs: number; ok: boolean };
function Sparkline({ samples }: { samples: Sample[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 220, H = 40;
  if (samples.length < 2) return <div className="flex h-10 items-center text-xs text-mute">Not enough data yet</div>;
  const max = Math.max(...samples.map((s) => s.latencyMs), 1);
  const x = (i: number) => (i / (samples.length - 1)) * (W - 4) + 2;
  const y = (v: number) => H - 3 - (v / max) * (H - 8);
  const pts = samples.map((s, i) => `${x(i)},${y(s.latencyMs)}`).join(" ");
  const h = hover !== null ? samples[hover] : null;
  return (
    <div className="relative">
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" height={H} role="img" aria-label="latency over time" onMouseLeave={() => setHover(null)} onMouseMove={(e) => {
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        setHover(Math.max(0, Math.min(samples.length - 1, Math.round(((e.clientX - r.left) / r.width) * (samples.length - 1)))));
      }}>
        <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {samples.map((s, i) => (!s.ok ? <circle key={i} cx={x(i)} cy={y(s.latencyMs)} r={3} fill="var(--st-critical)" stroke="var(--surface-2)" strokeWidth={1.5} /> : null))}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} stroke="var(--text-muted)" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
      </svg>
      {h && <div className="pointer-events-none absolute -top-8 left-0 rounded-md border border-line bg-s1 px-2 py-0.5 text-xs whitespace-nowrap shadow-[var(--shadow-sm)]">{h.latencyMs} ms · {h.ok ? "ok" : "error"} · {new Date(h.ts).toISOString().slice(5, 16).replace("T", " ")}</div>}
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
    <Card title="System health" right="latency per call · red = errors · last 3 sim days">
      <div className="grid gap-3 sm:grid-cols-2">
        {(series ?? []).map((s) => {
          const n = s.samples.length;
          const err = n ? s.samples.filter((x) => !x.ok).length / n : 0;
          const avg = n ? Math.round(s.samples.reduce((a, b) => a + b.latencyMs, 0) / n) : 0;
          const tone = err === 0 ? { color: "var(--st-confirmed)", icon: "✓", label: "0% errors" } : err < 0.1 ? { color: "var(--st-acknowledged)", icon: "◐", label: `${(err * 100).toFixed(0)}% errors` } : { color: "var(--st-critical)", icon: "!", label: `${(err * 100).toFixed(0)}% errors` };
          return (
            <div key={s.system} className="rounded-xl bg-s2 p-3">
              <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium capitalize">{s.system.replace("_", " ")}</span><Pill size="sm" look={tone} /></div>
              <div className="mb-1 text-xs text-mute tabular">{n} calls · avg {avg} ms</div>
              <Sparkline samples={s.samples} />
            </div>
          );
        })}
        {!series && <p className="text-sm text-mute">Loading…</p>}
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
    <Card title="What the agent has learned" right={<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label="Search experiences" className="h-7 w-44 rounded-lg border border-line bg-s2 px-2.5 text-xs text-ink outline-none placeholder:text-mute focus:bg-s1" />}>
      <ul className="-mx-2 max-h-80 overflow-auto">
        {rows.map((e) => (
          <li key={e._id} className="rounded-lg px-2 py-2 hover:bg-s2">
            <div className="flex items-center gap-2 text-[11px]"><span className="rounded-md bg-s2 px-1.5 py-0.5 font-medium text-ink2">{e.problemType.replace("_", " ")}</span><span className="text-mute">{e.system.replace("_", " ")}</span></div>
            <p className="mt-1 text-sm text-ink">{e.problem}</p>
            <p className="text-xs text-mute">→ {e.outcome}</p>
          </li>
        ))}
        {!rows.length && <li className="py-6 text-center text-sm text-mute">No matches.</li>}
      </ul>
    </Card>
  );
}

export function Summary({ snap }: { snap: ClaimSnapshot }) {
  return (
    <div>
      <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink">{snap.claim.compactSummary || "Empty: the agent hasn't summarised this claim yet."}</p>
      <p className="mt-3 text-xs text-mute">{snap.claim.compactSummary.length}/2000 characters. This is all the agent reloads after a crash; no conversation history.</p>
    </div>
  );
}
