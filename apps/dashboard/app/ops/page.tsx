"use client";

import { ChaosDrawer } from "@/components/chaos";
import { useLiveClaims } from "@/components/live";
import { AgentStatusPanel, ClaimsTable, Experiences, Health } from "@/components/ops";
import { Card } from "@/components/ui";

export default function Ops() {
  const { rows, status, connected } = useLiveClaims();
  return (
    <main className="mx-auto grid max-w-7xl gap-4 px-4 pt-5 pb-56">
      <h1 className="text-3xl font-bold">Operator console</h1>
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card title="Claims"><ClaimsTable rows={rows} /></Card>
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
