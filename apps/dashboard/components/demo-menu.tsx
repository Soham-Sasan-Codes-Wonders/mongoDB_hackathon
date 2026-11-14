"use client";

import { useEffect, useRef, useState } from "react";
import { advanceClock, chaos, simulateCall } from "@/app/actions";
import { useRun } from "./ui";

type Item = { key: string; label: string; hint: string; run: () => Promise<{ ok: boolean; message: string }> };

/**
 * A small demo menu on the claimant screen (bottom-left, clear of the voice widget bottom-right):
 * fast-forward the claim clock and inject blocks into the workflow, using the same chaos endpoints
 * as the operator console. Demo-only; it's labelled as such.
 */
export function DemoMenu({ claimId }: { claimId: string }) {
  const { run, busy } = useRun();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  const blocks: Item[] = [
    { key: "rename", label: "Insurer changes a field", hint: "The insurer renames policyNumber: the next submission is paused and adapted", run: () => chaos("rename-policy") },
    { key: "photos", label: "Insurer requires photos", hint: "A new step appears before the estimate can be approved", run: () => chaos("require-photos") },
    { key: "reject", label: "Insurer rejects next bill", hint: "The next medical bill is refused; it's corrected and resent", run: () => chaos("reject-invoice") },
    { key: "ghost", label: "Rental loses next booking", hint: "The rental company says OK but saves nothing; caught by checking", run: () => chaos("rental-drop") },
  ];
  const calls: Item[] = [
    { key: "call", label: "Adjuster calls: “approved”", hint: "Shown as claimed, not confirmed, until the insurer's records agree", run: () => simulateCall(claimId, "approved") },
    { key: "bank", label: "Caller asks to change bank details", hint: "Never acted on; you get a fraud alert", run: () => simulateCall(claimId, "bank") },
  ];

  const itemBtn = (i: Item) => (
    <button key={i.key} role="menuitem" disabled={!!busy} onClick={() => run(i.key, i.run)}
      className="flex w-full flex-col items-start rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-s2 disabled:opacity-40">
      <span className="text-sm text-ink">{busy === i.key ? "Working…" : i.label}</span>
      <span className="text-[11px] leading-snug text-mute">{i.hint}</span>
    </button>
  );

  return (
    <div ref={ref} className="fixed bottom-[6.5rem] left-4 z-30 sm:bottom-4">
      {open && (
        <div role="menu" aria-label="Demo controls" className="rise mb-2 w-80 overflow-hidden rounded-2xl border border-line bg-s1 shadow-[var(--shadow-md)]">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <span className="text-[13px] font-semibold">Demo controls</span>
            <span className="rounded-md bg-s2 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-mute uppercase">Demo only</span>
          </div>
          <div className="px-4 pt-3 pb-2">
            <div className="mb-1.5 text-[10px] font-semibold tracking-widest text-mute uppercase">Fast-forward the claim</div>
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-s2 p-0.5">
              {[1, 3, 10].map((d) => (
                <button key={d} disabled={!!busy} onClick={() => run(`ff${d}`, () => advanceClock(d))} className="rounded-md py-1 text-xs font-medium text-ink2 transition hover:bg-s1 hover:text-ink disabled:opacity-40">
                  +{d} day{d > 1 ? "s" : ""}
                </button>
              ))}
            </div>
          </div>
          <div className="px-1.5 pb-1">
            <div className="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-widest text-mute uppercase">Add a block</div>
            {blocks.map(itemBtn)}
          </div>
          <div className="border-t border-line px-1.5 pt-1 pb-1.5">
            <div className="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-widest text-mute uppercase">Phone line</div>
            {calls.map(itemBtn)}
          </div>
        </div>
      )}
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu"
        className="flex h-10 items-center gap-2 rounded-full border border-line bg-s1 px-4 text-sm font-medium text-ink shadow-[var(--shadow-md)] transition hover:bg-s2">
        <span aria-hidden className="text-base leading-none">⚡</span>
        Demo
      </button>
    </div>
  );
}
