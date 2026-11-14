"use client";

import { useState } from "react";
import { ACTION_LOOK, ACTION_PATH, look } from "@/lib/status";
import { simDay, wall } from "@/lib/time";
import type { ActionJ } from "@/lib/types";
import { Dialog, Json, Label, Pill } from "./ui";

/**
 * One row per action. The stepper is planned -> sent -> acknowledged -> confirmed. `acknowledged`
 * (an API said OK: dashed amber ring, half-filled) and `confirmed` (proven by read-back: solid
 * green with a check) are deliberately different, because that gap is the point of the project.
 */
function Step({ name, reached, current }: { name: (typeof ACTION_PATH)[number]; reached: boolean; current: boolean }) {
  const l = look(ACTION_LOOK, name);
  let style: React.CSSProperties = { boxShadow: "inset 0 0 0 1.5px var(--border-strong)" };
  let inner = "";
  if (reached) {
    if (name === "confirmed") { style = { background: l.color, color: "#fff" }; inner = "✓"; }
    else if (name === "acknowledged") style = { border: `1.5px dashed ${l.color}`, background: `linear-gradient(90deg, color-mix(in oklab, ${l.color} 40%, transparent) 50%, transparent 50%)` };
    else style = { background: `color-mix(in oklab, ${l.color} 18%, transparent)`, boxShadow: `inset 0 0 0 1.5px ${l.color}` };
  }
  return (
    <span title={`${name === "acknowledged" ? "acknowledged (not proof)" : name}${current ? " · current" : ""}`}
      className={`grid h-[18px] w-[18px] place-items-center rounded-full text-[10px] font-bold ${current ? "ring-2 ring-offset-2 ring-offset-[var(--surface-1)]" : ""}`}
      style={{ ...style, ...(current ? { ["--tw-ring-color" as string]: `color-mix(in oklab, ${l.color} 45%, transparent)` } : {}) }}>
      {inner}
    </span>
  );
}

function Stepper({ a }: { a: ActionJ }) {
  const reached = new Set(a.history.map((h) => h.status));
  return (
    <div className="flex items-center" aria-label={`Progress: ${ACTION_PATH.filter((s) => reached.has(s)).join(" → ")}`}>
      {ACTION_PATH.map((s, i) => (
        <div key={s} className="flex items-center">
          {i > 0 && <span className="h-px w-4" style={{ background: reached.has(s) ? look(ACTION_LOOK, s).color : "var(--border-strong)" }} />}
          <Step name={s} reached={reached.has(s)} current={a.status === s} />
        </div>
      ))}
    </div>
  );
}

export function ActionRow({ a, since, onOpen, supersededBy, supersedes }: { a: ActionJ; since: string; onOpen: () => void; supersededBy?: ActionJ; supersedes?: ActionJ }) {
  const sends = a.history.filter((h) => h.status === "sent").length;
  const side = !ACTION_PATH.includes(a.status as (typeof ACTION_PATH)[number]);
  const last = a.history.at(-1);
  return (
    <button onClick={onOpen} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-s2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(8.5rem,auto)]">
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-mono text-[13px] font-semibold">{a.taskId}</span>
          <span className="truncate text-sm text-ink2">{a.kind.replace(/_/g, " ")}</span>
          <span className="hidden shrink-0 text-xs text-mute lg:inline">{a.system.replace("_", " ")}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 text-[11px] text-mute">
          <span className="font-mono">…{a.idempotencyKey.split(":").slice(-2).join(":")}</span>
          {sends > 1 && <span className="font-medium" style={{ color: "var(--st-acknowledged)" }}>↻ {sends} sends · same key</span>}
          {supersedes && <span style={{ color: "var(--st-approval)" }}>↳ supersedes key …:{supersedes.idempotencyKey.split(":").at(-1)}</span>}
          {supersededBy && <span style={{ color: "var(--st-critical)" }}>superseded by …:{supersededBy.idempotencyKey.split(":").at(-1)}</span>}
        </div>
      </div>
      <Stepper a={a} />
      <div className="col-span-2 flex min-w-0 items-center justify-between gap-2 sm:col-span-1 sm:flex-col sm:items-end sm:justify-center">
        <Pill look={look(ACTION_LOOK, a.status)} size="sm" />
        {side && a.status !== "awaiting_approval" && a.lastError ? <span className="max-w-[14rem] truncate text-[11px] text-[var(--st-critical)]" title={a.lastError}>{a.lastError}</span>
          : last && <span className="text-[11px] text-mute" title={wall(last.wallAt)}>{simDay(last.at, since)}</span>}
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
      <div className="-mx-2 flex max-h-[460px] flex-col overflow-auto">
        {sorted.map((a) => (
          <ActionRow key={a._id} a={a} since={since} onOpen={() => setOpen(a)} supersedes={a.supersedes ? byId.get(String(a.supersedes.actionId)) : undefined} supersededBy={supersededBy.get(a._id)} />
        ))}
        {!sorted.length && <p className="px-2 py-6 text-center text-sm text-mute">No actions yet.</p>}
      </div>
      <Dialog open={!!open} onClose={() => setOpen(null)} title={open ? `${open.taskId} · ${open.kind.replace(/_/g, " ")}` : ""}>
        {open && <ActionDetail a={open} since={since} supersedes={open.supersedes ? byId.get(String(open.supersedes.actionId)) : undefined} onJump={(x) => setOpen(x)} />}
      </Dialog>
    </>
  );
}

function ActionDetail({ a, since, supersedes, onJump }: { a: ActionJ; since: string; supersedes?: ActionJ; onJump: (a: ActionJ) => void }) {
  return (
    <div className="grid gap-5 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Pill look={look(ACTION_LOOK, a.status)} />
        <Stepper a={a} />
        <span className="text-ink2">{a.system.replace("_", " ")}</span>
        <span className="text-ink2">{a.attempts} attempt{a.attempts === 1 ? "" : "s"}</span>
        <span className="text-ink2">verify by {a.verifyBy}</span>
        {a.gate && <span style={{ color: "var(--st-approval)" }}>gate: {a.gate}</span>}
      </div>
      <div>
        <Label>Idempotency key</Label>
        <code className="block rounded-lg bg-s2 px-3 py-2 font-mono text-xs text-ink">{a.idempotencyKey}</code>
        <p className="mt-1.5 text-xs text-mute">Every retry reuses it; a corrected resubmission mints a new one.</p>
      </div>
      {supersedes && (
        <button className="text-left text-sm underline-offset-2 hover:underline" style={{ color: "var(--st-approval)" }} onClick={() => onJump(supersedes)}>↳ Supersedes the rejected {supersedes.kind.replace(/_/g, " ")} ({supersedes.idempotencyKey})</button>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <div><Label>Payload</Label><Json value={a.payload.pdfBase64 ? { ...a.payload, pdfBase64: "…(PDF omitted)" } : a.payload} /></div>
        <div><Label>Expected effect (what a read-back must prove)</Label><Json value={a.expectedEffect} /></div>
      </div>
      <div>
        <Label>History</Label>
        <ol className="relative grid gap-3 border-l border-line pl-4">
          {a.history.map((h, i) => (
            <li key={i} className="relative">
              <span className="absolute top-1.5 -left-[21px] h-2 w-2 rounded-full ring-4 ring-[var(--surface-1)]" style={{ background: look(ACTION_LOOK, h.status).color }} />
              <div className="flex flex-wrap items-center gap-2">
                <Pill size="sm" look={look(ACTION_LOOK, h.status)} />
                <span className="text-xs text-mute" title={wall(h.wallAt)}>{simDay(h.at, since)}</span>
                <span className="text-xs text-mute">· {h.by}</span>
              </div>
              {h.note && <p className="mt-1 text-[13px] text-ink2">{h.note}</p>}
            </li>
          ))}
        </ol>
      </div>
      {a.readback !== undefined && <div><Label>Last read-back</Label><Json value={a.readback} /></div>}
    </div>
  );
}
