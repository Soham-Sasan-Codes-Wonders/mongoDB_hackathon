"use client";

import { use } from "react";
import { CallSummaries, Chat, DecisionCards, Money, Tracks } from "@/components/claimant";
import { useLiveClaim } from "@/components/live";
import { simDay } from "@/lib/time";

export default function ClaimantView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { snap, missing, connected } = useLiveClaim(id);
  if (missing) return <main className="p-6 text-lg">Claim {id} not found.</main>;
  if (!snap) return <main className="p-6 text-mute">Loading {id}…</main>;
  const c = snap.claim;
  return (
    <main className="mx-auto grid max-w-6xl gap-4 px-4 py-5">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">Hi {c.claimant.firstName ?? c.claimant.name.split(" ")[0]}, here's your claim</h1>
          <p className="break-words text-ink2"><span className="font-mono">{c._id}</span> · {c.vehicle.make} {c.vehicle.model} · policy {c.policy.number} · phase <b>{c.phase}</b></p>
        </div>
        <p className="text-sm text-mute">{simDay(snap.simNow, c.createdAt)} · {connected ? "● live" : "○ reconnecting"}</p>
      </header>
      <DecisionCards snap={snap} who={`claimant:${c.claimant.name}`} />
      <Tracks snap={snap} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Chat snap={snap} />
        <CallSummaries snap={snap} />
      </div>
      <Money rows={snap.money} closing={["closing", "closed"].includes(c.phase) || snap.tasks.some((t) => t.taskId === "T18" && t.status !== "pending")} />
    </main>
  );
}
