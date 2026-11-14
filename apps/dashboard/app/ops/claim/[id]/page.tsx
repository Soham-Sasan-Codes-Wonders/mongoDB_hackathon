"use client";

import Link from "next/link";
import { use, useState } from "react";
import { ChaosDrawer } from "@/components/chaos";
import { TaskGraph } from "@/components/graph";
import { useLiveClaim } from "@/components/live";
import { AgentStatusPanel, Approvals, ObservationsFeed, Summary, Timers } from "@/components/ops";
import { ActionTimeline } from "@/components/timeline";
import { Card, Dialog, Json, Label, LiveDot, Pill, Segmented } from "@/components/ui";
import { look, TASK_LOOK } from "@/lib/status";
import { simDay } from "@/lib/time";
import type { TaskJ } from "@/lib/types";

type Tab = "observations" | "approvals" | "timers" | "summary";

export default function OpsClaim({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { snap, status, connected, missing } = useLiveClaim(id);
  const [tab, setTab] = useState<Tab>("observations");
  const [task, setTask] = useState<TaskJ | null>(null);
  if (missing) return <main className="mx-auto max-w-[1440px] px-6 py-10 text-sm">Claim {id} not found. <Link className="font-medium text-ink underline" href="/ops">Back to claims</Link></main>;
  if (!snap) return <main className="mx-auto max-w-[1440px] px-6 py-10 text-sm text-mute">Loading {id}…</main>;
  const c = snap.claim;
  const pending = snap.approvals.filter((a) => a.status === "pending").length;
  const unverified = snap.actions.filter((a) => a.status === "sent" || a.status === "acknowledged").length;
  const phones = snap.observations.filter((o) => o.source === "phone" && !o.verified).length;
  const confirmed = snap.actions.filter((a) => a.status === "confirmed").length;
  return (
    <main className="mx-auto grid max-w-[1440px] gap-4 px-4 pt-5 pb-64 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <Link href="/ops" className="text-xs text-mute hover:text-ink">Claims /</Link>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="font-mono text-xl font-semibold tracking-tight">{c._id}</h1>
            <span className="text-sm text-ink2">{c.claimant.name}</span>
            <span className="rounded-md bg-s2 px-1.5 py-0.5 text-xs text-ink2">{c.phase}</span>
            <span className="text-xs text-mute">{simDay(snap.simNow, c.createdAt)}</span>
            <LiveDot on={connected} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill size="sm" look={{ color: "var(--st-confirmed)", icon: "✓", label: `${confirmed} confirmed` }} />
          {unverified > 0 && <Pill size="sm" look={{ color: "var(--st-acknowledged)", icon: "◐", label: `${unverified} unverified` }} />}
          {pending > 0 && <Pill size="sm" look={{ color: "var(--st-approval)", icon: "⏸", label: `${pending} approval${pending > 1 ? "s" : ""}` }} />}
          {phones > 0 && <Pill size="sm" look={{ color: "var(--st-acknowledged)", icon: "☎", label: `${phones} unverified call${phones > 1 ? "s" : ""}` }} />}
          <Link href={`/claim/${c._id}`} className="ml-2 text-xs font-medium text-ink2 hover:text-ink">Claimant view ↗</Link>
        </div>
      </header>

      <Card title="Task graph" right="edges = depends on · dashed = inserted by a subflow · click a task">
        <TaskGraph tasks={snap.tasks} onSelect={setTask} />
      </Card>

      <div className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
        <Card title="Actions" right={<span className="flex flex-wrap items-center gap-x-3"><span>◐ acknowledged: an API said OK</span><span>✓ confirmed: proven by read-back</span></span>}>
          <ActionTimeline actions={snap.actions} since={c.createdAt} />
        </Card>
        <div className="grid content-start gap-4">
          <Card>
            <div className="mb-3">
              <Segmented value={tab} onChange={setTab} options={[
                { value: "observations", label: "Observations" },
                { value: "approvals", label: <>Approvals{pending ? <span className="ml-1 rounded-full px-1.5 text-[10px] text-white" style={{ background: "var(--st-approval)" }}>{pending}</span> : null}</> },
                { value: "timers", label: "Timers" },
                { value: "summary", label: "Summary" },
              ]} />
            </div>
            {tab === "observations" && <ObservationsFeed snap={snap} />}
            {/* always mounted so new-approval toasts fire on every tab */}
            <div className={tab === "approvals" ? "" : "hidden"}><Approvals snap={snap} /></div>
            {tab === "timers" && <Timers snap={snap} />}
            {tab === "summary" && <Summary snap={snap} />}
          </Card>
          <AgentStatusPanel status={status} connected={connected} />
        </div>
      </div>

      <Dialog open={!!task} onClose={() => setTask(null)} title={task ? `${task.taskId} · ${task.title ?? task.type}` : ""}>
        {task && (
          <div className="grid gap-5 text-sm">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2"><Pill look={look(TASK_LOOK, task.status)} /><span className="text-ink2">{task.track} track</span><span className="text-ink2">depends on {task.dependsOn.join(", ") || "nothing"}</span></div>
            {task.params && Object.keys(task.params).length > 0 && <div><Label>Parameters</Label><Json value={task.params} /></div>}
            <div>
              <Label>History</Label>
              <ol className="relative grid gap-3 border-l border-line pl-4">
                {task.history.map((h, i) => (
                  <li key={i} className="relative">
                    <span className="absolute top-1.5 -left-[21px] h-2 w-2 rounded-full ring-4 ring-[var(--surface-1)]" style={{ background: look(TASK_LOOK, h.status).color }} />
                    <div className="flex flex-wrap items-center gap-2"><Pill size="sm" look={look(TASK_LOOK, h.status)} /><span className="text-xs text-mute">{simDay(h.at, c.createdAt)} · {h.by}</span></div>
                    {h.note && <p className="mt-1 text-[13px] text-ink2">{h.note}</p>}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}
      </Dialog>
      <ChaosDrawer claimId={c._id} />
    </main>
  );
}
