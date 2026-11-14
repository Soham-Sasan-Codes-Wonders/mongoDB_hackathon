"use client";

import { ChaosDrawer } from "@/components/chaos";
import { useLiveClaims } from "@/components/live";
import { AgentStatusPanel, ClaimsTable, Experiences, Health } from "@/components/ops";
import { Card } from "@/components/ui";

export default function Ops() {
  const { rows, status, connected } = useLiveClaims();
  return (
    <main className="mx-auto grid max-w-[1440px] gap-4 px-4 pt-6 pb-64 sm:px-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Operator console</h1>
        <p className="mt-0.5 text-sm text-ink2">Every claim, the agent's workers, the outside systems' health and what the agent has learned.</p>
      </header>
      <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
        <Card title="Claims" right={rows ? `${rows.length} total` : undefined}><ClaimsTable rows={rows} /></Card>
        <AgentStatusPanel status={status} connected={connected} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Health />
        <Experiences />
      </div>
      <ChaosDrawer />
    </main>
  );
}
