"use client";

import { use } from "react";
import { CallSummaries, Chat, DecisionCards, Money, PhotoRequest, Tracks } from "@/components/claimant";
import { DemoMenu } from "@/components/demo-menu";
import { useLiveClaim } from "@/components/live";
import { simDay } from "@/lib/time";

export default function ClaimantView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { snap, missing, connected } = useLiveClaim(id);
  if (missing) return <main className="mx-auto max-w-6xl px-6 py-10 text-sm">Claim {id} not found.</main>;
  if (!snap) return <main className="mx-auto max-w-6xl px-6 py-10 text-sm text-mute">Loading your claim…</main>;
  const c = snap.claim;
  const closing = ["closing", "closed"].includes(c.phase) || snap.tasks.some((t) => t.taskId === "T18" && t.status !== "pending");
  const hasCalls = snap.observations.some((o) => o.source === "phone");
  return (
    <main className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Hi {c.claimant.firstName ?? c.claimant.name.split(" ")[0]}, here's your claim</h1>
          <p className="mt-0.5 text-sm text-ink2">{c.vehicle.make} {c.vehicle.model} · policy {c.policy.number}</p>
        </div>
        <p className="text-xs text-mute"><span className="font-mono">{c._id}</span> · {simDay(snap.simNow, c.createdAt)}</p>
      </header>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* the conversation is the main surface */}
        <Chat snap={snap} connected={connected} />
        <aside className="grid gap-4">
          <PhotoRequest snap={snap} />
          <DecisionCards snap={snap} who={`claimant:${c.claimant.name}`} />
          <Tracks snap={snap} compact />
          {hasCalls && <CallSummaries snap={snap} />}
          <Money rows={snap.money} closing={closing} />
        </aside>
      </div>
      <DemoMenu claimId={c._id} />
    </main>
  );
}
