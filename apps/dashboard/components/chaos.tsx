"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { advanceClock, chaos, fireWebhooks, killWorker, resetDemo, setClaimDaySeconds, simulateCall, startDemoClaim, startWorker } from "@/app/actions";
import { Button, Dialog, useRun } from "./ui";
import { VoiceCall } from "./voicecall";

type Btn = { key: string; label: string; watch: string; run: () => Promise<{ ok: boolean; message: string; claimId?: string }>; needsClaim?: boolean; kind?: "primary" | "danger" | "good" };
type Group = { title: string; buttons: Btn[] };

/** The demo/chaos panel, docked at the bottom of /ops. One button per scene from the design doc's demo mapping. */
export function ChaosDrawer({ claimId }: { claimId?: string }) {
  const router = useRouter();
  const { run, busy } = useRun();
  const [open, setOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const groups: Group[] = [
    { title: "Start", buttons: [
      { key: "start", label: "Start demo claim", watch: "T1–T6 go sent → confirmed", kind: "primary", run: async () => { const r = await startDemoClaim(); if (r.ok && r.claimId) router.push(`/ops/claim/${r.claimId}`); return r; } },
    ] },
    { title: "Proof", buttons: [
      { key: "rental-drop", label: "Rental drops next booking", watch: "T5 acknowledged, read-back fails, same-key retry confirms", run: () => chaos("rental-drop") },
    ] },
    { title: "Crash", buttons: [
      { key: "kill", label: "Kill agent", watch: "Worker shows dead; timeline freezes", kind: "danger", run: () => killWorker() },
      { key: "fire", label: "Fire 3 webhooks", watch: "Observations pile up unprocessed", needsClaim: true, run: () => fireWebhooks(claimId) },
      { key: "restart", label: "Restart agent", watch: "Recovery processes all 3; nothing resent", kind: "good", run: () => startWorker() },
    ] },
    { title: "Drift", buttons: [
      { key: "rename", label: "Rename policyNumber", watch: "Task goes blocked_drift, then a mapping is applied or sent for approval", run: () => chaos("rename-policy") },
      { key: "photos", label: "Require photos", watch: "A new task appears before T9", run: () => chaos("require-photos") },
    ] },
    { title: "Rejection", buttons: [
      { key: "reject", label: "Reject next invoice", watch: "New key, supersedes link", run: () => chaos("reject-invoice") },
    ] },
    { title: "Phone", buttons: [
      { key: "call", label: "Simulate inbound call", watch: "“Approved” claimed, portal pending: unverified", needsClaim: true, run: () => simulateCall(claimId!, "approved") },
      { key: "call-bank", label: "Call: change bank details", watch: "Never acted on; fraud alert", needsClaim: true, run: () => simulateCall(claimId!, "bank") },
    ] },
  ];
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-[color-mix(in_oklab,var(--surface-1)_92%,transparent)] shadow-[0_-12px_32px_-16px_rgb(0_0_0/0.25)] backdrop-blur-md">
      <div className="mx-auto max-w-[1440px] px-4 sm:px-6">
        <div className="flex h-12 items-center gap-3">
          <button className="flex items-center gap-2 text-sm font-semibold" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <span aria-hidden className={`inline-block text-mute transition-transform ${open ? "rotate-90" : ""}`}>›</span>
            Demo controls
          </button>
          <span className="hidden truncate text-xs text-mute sm:inline">{claimId ? <>acting on <span className="font-mono text-ink2">{claimId}</span></> : "select a claim to enable claim-specific scenes"}</span>
          <div className="ml-auto flex items-center gap-1.5">
            <span className="hidden text-xs text-mute md:inline">Fast-forward</span>
            <div className="inline-flex rounded-lg bg-s2 p-0.5">
              {[1, 10, 30].map((d) => (
                <button key={d} disabled={!!busy} onClick={() => run(`ff${d}`, () => advanceClock(d))} className="rounded-md px-2 py-0.5 text-xs font-medium text-ink2 hover:bg-s1 hover:text-ink disabled:opacity-40">+{d}d</button>
              ))}
            </div>
            <select aria-label="Clock speed: wall seconds per claim day" className="h-7 rounded-lg border border-line bg-s1 px-2 text-xs text-ink2" defaultValue="" onChange={(e) => e.target.value && run("speed", () => setClaimDaySeconds(Number(e.target.value)))}>
              <option value="">Speed</option>
              {[5, 10, 20, 40, 60].map((s) => <option key={s} value={s}>1 day = {s}s</option>)}
            </select>
            <Button size="sm" kind="ghost" onClick={() => setConfirmReset(true)} className="text-[var(--st-critical)]">Reset</Button>
          </div>
        </div>
        {/* stays mounted when collapsed so collapsing the panel doesn't hang up a live call */}
        {claimId && <div className={open ? "pb-2" : "hidden"}><VoiceCall claimId={claimId} /></div>}
        {open && (
          <div className="grid grid-cols-2 gap-x-5 gap-y-3 pb-4 sm:grid-cols-3 lg:grid-cols-6">
            {groups.map((g) => (
              <div key={g.title} className="min-w-0">
                <div className="mb-1.5 text-[10px] font-semibold tracking-widest text-mute uppercase">{g.title}</div>
                <div className="grid gap-1.5">
                  {g.buttons.map((b) => (
                    <Button key={b.key} size="sm" kind={b.kind ?? "default"} title={`Watch for: ${b.watch}`} disabled={!!busy || (b.needsClaim && !claimId)} onClick={() => run(b.key, b.run)} className="w-full justify-start truncate">
                      {busy === b.key ? "…" : b.label}
                    </Button>
                  ))}
                </div>
                <p className="mt-1 line-clamp-2 text-[10.5px] leading-snug text-mute">{g.buttons.map((b) => b.watch).join(" · ")}</p>
              </div>
            ))}
          </div>
        )}
      </div>
      <Dialog open={confirmReset} onClose={() => setConfirmReset(false)} title="Reset the demo?">
        <p className="text-sm text-ink2">This deletes every demo claim, task, action, observation, timer and approval, and wipes the mock systems' state, then restarts the sim clock. It keeps the seeded claim CLM-1042, seed data, the 3 Atlas Search indexes and the workers' resume tokens.</p>
        <p className="mt-2 text-sm text-mute">It does not run db:reset (that would drop the whole shared database).</p>
        <div className="mt-5 flex gap-2">
          <Button kind="danger" onClick={async () => { setConfirmReset(false); await run("reset", () => resetDemo()); router.push("/ops"); }}>Yes, reset</Button>
          <Button onClick={() => setConfirmReset(false)}>Cancel</Button>
        </div>
      </Dialog>
    </div>
  );
}
