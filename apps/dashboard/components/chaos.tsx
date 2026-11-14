"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { advanceClock, chaos, fireWebhooks, killWorker, resetDemo, setClaimDaySeconds, simulateCall, startDemoClaim, startWorker } from "@/app/actions";
import { Button, Dialog, useRun } from "./ui";

type Btn = { key: string; label: string; watch: string; run: () => Promise<{ ok: boolean; message: string; claimId?: string }>; needsClaim?: boolean; kind?: "primary" | "danger" | "good" };

/** The demo/chaos panel, docked at the bottom of /ops. One button per scene from the design doc's demo mapping. */
export function ChaosDrawer({ claimId }: { claimId?: string }) {
  const router = useRouter();
  const { run, busy } = useRun();
  const [open, setOpen] = useState(true);
  const [confirmReset, setConfirmReset] = useState(false);
  const buttons: Btn[] = [
    { key: "start", label: "Start demo claim", watch: "T1–T6 actions go sent → confirmed", kind: "primary", run: async () => { const r = await startDemoClaim(); if (r.ok && r.claimId) router.push(`/ops/claim/${r.claimId}`); return r; } },
    { key: "rental-drop", label: "Rental drops next booking", watch: "T5 stuck at acknowledged; read-back fails; same-key retry confirms", run: () => chaos("rental-drop") },
    { key: "kill", label: "Kill agent", watch: "Worker shows dead; timeline freezes", kind: "danger", run: () => killWorker() },
    { key: "fire", label: "Fire 3 webhooks", watch: "Observations pile up unprocessed", needsClaim: true, run: () => fireWebhooks(claimId) },
    { key: "restart", label: "Restart agent", watch: "Recovery processes all 3; nothing is resent", kind: "good", run: () => startWorker() },
    { key: "rename", label: "Rename policyNumber", watch: "A task goes blocked_drift, then a mapping is applied or sent for approval", run: () => chaos("rename-policy") },
    { key: "photos", label: "Require photos", watch: "A new task appears in the graph before T9", run: () => chaos("require-photos") },
    { key: "reject", label: "Reject next invoice", watch: "Rejection subflow, new key, supersedes link", run: () => chaos("reject-invoice") },
    { key: "call", label: "Simulate inbound call", watch: "“Approved” claimed; portal still pending; shown unverified", needsClaim: true, run: () => simulateCall(claimId!, "approved") },
    { key: "call-bank", label: "Call: change bank details", watch: "Never acted on; red fraud alert to the claimant", needsClaim: true, run: () => simulateCall(claimId!, "bank") },
  ];
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-s1/95 shadow-[0_-8px_24px_rgba(0,0,0,0.35)] backdrop-blur">
      <div className="flex items-center gap-3 px-4 py-1.5">
        <button className="text-sm font-semibold" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? "▾" : "▸"} Demo / chaos panel</button>
        <span className="text-xs text-mute">{claimId ? `acting on ${claimId}` : "no claim selected: claim-specific buttons are off"}</span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5 text-sm">
          <span className="text-mute">Fast-forward</span>
          {[1, 10, 30].map((d) => <Button key={d} disabled={!!busy} onClick={() => run(`ff${d}`, () => advanceClock(d))}>+{d}d</Button>)}
          <label className="ml-2 text-mute" htmlFor="speed">1 claim day =</label>
          <select id="speed" className="rounded-lg border border-line bg-s2 px-2 py-1" defaultValue="" onChange={(e) => e.target.value && run("speed", () => setClaimDaySeconds(Number(e.target.value)))}>
            <option value="">speed…</option>
            {[5, 10, 20, 40, 60].map((s) => <option key={s} value={s}>{s}s</option>)}
          </select>
          <Button kind="danger" onClick={() => setConfirmReset(true)}>Reset demo</Button>
        </div>
      </div>
      {open && (
        <div className="grid grid-cols-2 gap-2 px-4 pb-3 md:grid-cols-5">
          {buttons.map((b) => (
            <div key={b.key} className="flex flex-col gap-1">
              <Button kind={b.kind ?? "default"} disabled={!!busy || (b.needsClaim && !claimId)} onClick={() => run(b.key, b.run)}>{busy === b.key ? "…" : b.label}</Button>
              <span className="text-[11px] leading-tight text-mute">{b.watch}</span>
            </div>
          ))}
        </div>
      )}
      <Dialog open={confirmReset} onClose={() => setConfirmReset(false)} title="Reset the demo?">
        <p>This deletes every demo claim, task, action, observation, timer and approval, and wipes the mock systems' state, then restarts the sim clock. It keeps the seeded claim CLM-1042, seed data, the 3 Atlas Search indexes and the workers' resume tokens.</p>
        <p className="mt-2 text-sm text-ink2">It does not run db:reset (that would drop the whole shared database).</p>
        <div className="mt-4 flex gap-2">
          <Button kind="danger" onClick={async () => { setConfirmReset(false); await run("reset", () => resetDemo()); router.push("/ops"); }}>Yes, reset</Button>
          <Button onClick={() => setConfirmReset(false)}>Cancel</Button>
        </div>
      </Dialog>
    </div>
  );
}
