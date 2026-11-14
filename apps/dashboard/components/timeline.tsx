"use client";

import { useState } from "react";
import { ACTION_LOOK, ACTION_PATH, look } from "@/lib/status";
import { simDay, wall } from "@/lib/time";
import type { ActionJ } from "@/lib/types";
import { Dialog, Json, Pill } from "./ui";

/**
 * One row per action. The stepper is planned -> sent -> acknowledged -> confirmed. `acknowledged`
 * (an API said OK: hollow, amber, half-filled) and `confirmed` (proven by read-back: solid green
 * with a check) are drawn deliberately differently, because that gap is the point of the project.
 */
function Step({ name, reached, current }: { name: (typeof ACTION_PATH)[number]; reached: boolean; current: boolean }) {
  const l = look(ACTION_LOOK, name);
  const base = "flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold";
  let style: React.CSSProperties = { border: "2px solid var(--border)", color: "var(--text-muted)" };
  if (reached) {
    if (name === "confirmed") style = { background: l.color, color: "#fff", border: `2px solid ${l.color}` };
    else if (name === "acknowledged") style = { border: `2px dashed ${l.color}`, color: l.color, background: `linear-gradient(90deg, color-mix(in oklab, ${l.color} 35%, transparent) 50%, transparent 50%)` };
    else style = { border: `2px solid ${l.color}`, color: l.color };
  }
  return (
    <div className="flex flex-col items-center gap-0.5" title={l.label}>
      <span className={`${base} ${current ? "ring-2 ring-offset-2 ring-offset-[var(--surface-1)]" : ""}`} style={{ ...style, ...(current ? { ["--tw-ring-color" as string]: l.color } : {}) }}>{reached ? l.icon : ""}</span>
      <span className="text-[10px] text-mute">{name === "acknowledged" ? "ack" : name}</span>
    </div>
  );
}

export function ActionRow({ a, since, onOpen, supersededBy, supersedes }: { a: ActionJ; since: string; onOpen: () => void; supersededBy?: ActionJ; supersedes?: ActionJ }) {
  const reached = new Set(a.history.map((h) => h.status));
  const sends = a.history.filter((h) => h.status === "sent").length;
  const side = !ACTION_PATH.includes(a.status as (typeof ACTION_PATH)[number]);
  const last = a.history.at(-1);
  return (
    <button onClick={onOpen} className="grid w-full grid-cols-[minmax(0,1.3fr)_auto_minmax(0,1fr)] items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-s2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-bold">{a.taskId}</span>
          <span className="truncate text-sm text-ink2">{a.system}.{a.kind}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-mute">
          <span className="font-mono">key …{a.idempotencyKey.split(":").slice(-2).join(":")}</span>
          {sends > 1 && <span className="font-medium text-[var(--st-acknowledged)]">↻ {sends} sends · same key</span>}
          {supersedes && <span className="text-[var(--st-approval)]">↳ supersedes {supersedes.kind} key …:{supersedes.idempotencyKey.split(":").at(-1)}</span>}
          {supersededBy && <span className="text-[var(--st-critical)]">superseded by key …:{supersededBy.idempotencyKey.split(":").at(-1)}</span>}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        {ACTION_PATH.map((s, i) => (
          <div key={s} className="flex items-center gap-1.5">
            {i > 0 && <span className="mb-3 h-0.5 w-3 rounded" style={{ background: reached.has(s) ? look(ACTION_LOOK, s).color : "var(--border)" }} />}
            <Step name={s} reached={reached.has(s)} current={a.status === s} />
          </div>
        ))}
      </div>
      <div className="flex min-w-0 flex-col items-end gap-0.5">
        <Pill look={look(ACTION_LOOK, a.status)} size="sm" />
        {side && a.status !== "awaiting_approval" && a.lastError && <span className="max-w-full truncate text-[11px] text-[var(--st-critical)]">{a.lastError}</span>}
        {last && <span className="text-[11px] text-mute" title={wall(last.wallAt)}>{simDay(last.at, since)}</span>}
      </div>
    </button>
  );
}

export function ActionTimeline({ actions, since }: { actions: ActionJ[]; since: string }) {
  const [open, setOpen] = useState<ActionJ | null>(null);
  const byId = new Map(actions.map((a) => [a._id, a]));
  const supersededBy = new Map(actions.filter((a) => a.supersedes).map((a) => [String(a.supersedes!.actionId), a]));
  const sorted = [...actions].sort((x, y) => (y.createdAt ?? "").localeCompare(x.createdAt ?? ""));
  return (
    <>
      <div className="flex max-h-[470px] flex-col divide-y divide-line overflow-auto pr-1">
        {sorted.map((a) => (
          <ActionRow key={a._id} a={a} since={since} onOpen={() => setOpen(a)} supersedes={a.supersedes ? byId.get(String(a.supersedes.actionId)) : undefined} supersededBy={supersededBy.get(a._id)} />
        ))}
        {!sorted.length && <p className="p-2 text-mute">No actions yet.</p>}
      </div>
      <Dialog open={!!open} onClose={() => setOpen(null)} title={open ? `${open.taskId} · ${open.system}.${open.kind}` : ""}>
        {open && <ActionDetail a={open} since={since} supersedes={open.supersedes ? byId.get(String(open.supersedes.actionId)) : undefined} onJump={(x) => setOpen(x)} />}
      </Dialog>
    </>
  );
}

function ActionDetail({ a, since, supersedes, onJump }: { a: ActionJ; since: string; supersedes?: ActionJ; onJump: (a: ActionJ) => void }) {
  return (
    <div className="grid gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Pill look={look(ACTION_LOOK, a.status)} />
        <span className="text-ink2">attempts <b className="text-ink">{a.attempts}</b></span>
        <span className="text-ink2">verify by <b className="text-ink">{a.verifyBy}</b></span>
        {a.gate && <span className="text-ink2">gate <b className="text-[var(--st-approval)]">{a.gate}</b></span>}
      </div>
      <div><div className="text-xs text-mute">idempotencyKey (every retry reuses it; a resubmission mints a new one)</div><code className="font-mono text-ink">{a.idempotencyKey}</code></div>
      {supersedes && (
        <button className="text-left text-[var(--st-approval)] underline" onClick={() => onJump(supersedes)}>↳ supersedes the rejected {supersedes.kind} ({supersedes.idempotencyKey})</button>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <div><div className="mb-1 text-xs text-mute">payload</div><Json value={a.payload.pdfBase64 ? { ...a.payload, pdfBase64: "…(PDF omitted)" } : a.payload} /></div>
        <div><div className="mb-1 text-xs text-mute">expectedEffect (what a read-back must prove)</div><Json value={a.expectedEffect} /></div>
      </div>
      <div>
        <div className="mb-1 text-xs text-mute">history[] (audit trail)</div>
        <table className="w-full text-xs">
          <tbody className="divide-y divide-line">
            {a.history.map((h, i) => (
              <tr key={i}>
                <td className="py-1 pr-2"><Pill size="sm" look={look(ACTION_LOOK, h.status)} /></td>
                <td className="pr-2 whitespace-nowrap text-mute" title={wall(h.wallAt)}>{simDay(h.at, since)}</td>
                <td className="pr-2 whitespace-nowrap text-ink2">{h.by}</td>
                <td className="text-ink">{h.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {a.readback !== undefined && <div><div className="mb-1 text-xs text-mute">last read-back</div><Json value={a.readback} /></div>}
    </div>
  );
}
