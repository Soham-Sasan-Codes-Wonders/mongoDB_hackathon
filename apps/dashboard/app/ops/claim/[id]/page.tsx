"use client";

import Link from "next/link";
import { use, useState } from "react";
import { ChaosDrawer } from "@/components/chaos";
import { TaskGraph } from "@/components/graph";
import { useLiveClaim } from "@/components/live";
import { AgentStatusPanel, Approvals, ObservationsFeed, Summary, Timers } from "@/components/ops";
import { ActionTimeline } from "@/components/timeline";
import { Card, Dialog, Json, Pill } from "@/components/ui";
import { look, TASK_LOOK } from "@/lib/status";
import { simDay } from "@/lib/time";
import type { TaskJ } from "@/lib/types";

const TABS = ["Observations", "Approvals", "Timers", "Summary"] as const;

export default function OpsClaim({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { snap, status, connected, missing } = useLiveClaim(id);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Observations");
  const [task, setTask] = useState<TaskJ | null>(null);
  if (missing) return <main className="p-6">Claim {id} not found. <Link className="text-accent underline" href="/ops">Back</Link></main>;
  if (!snap) return <main className="p-6 text-mute">Loading {id}…</main>;
  const c = snap.claim;
  const pending = snap.approvals.filter((a) => a.status === "pending").length;
  const unverified = snap.actions.filter((a) => a.status === "sent" || a.status === "acknowledged").length;
  const phones = snap.observations.filter((o) => o.source === "phone" && !o.verified).length;
  return (
    <main className="grid gap-3 px-4 pt-3 pb-56">
      <header className="flex flex-wrap items-center gap-3">
        <Link href="/ops" className="text-ink2 hover:text-ink">← Claims</Link>
        <h1 className="font-mono text-2xl font-bold">{c._id}</h1>
        <span className="text-ink2">{c.claimant.name} · phase <b>{c.phase}</b></span>
        <span className="text-sm text-mute">{simDay(snap.simNow, c.createdAt)}</span>
        <span className="text-sm">{pending ? <Pill size="sm" look={{ color: "var(--st-approval)", icon: "⏸", label: `${pending} pending approval${pending > 1 ? "s" : ""}` }} /> : null}</span>
        <span className="text-sm">{unverified ? <Pill size="sm" look={{ color: "var(--st-acknowledged)", icon: "◐", label: `${unverified} unverified action${unverified > 1 ? "s" : ""}` }} /> : null}</span>
        <span className="text-sm">{phones ? <Pill size="sm" look={{ color: "var(--st-acknowledged)", icon: "☎", label: `${phones} unverified call claim${phones > 1 ? "s" : ""}` }} /> : null}</span>
        <Link href={`/claim/${c._id}`} className="ml-auto text-sm text-accent underline">Claimant view →</Link>
      </header>
      <div className="grid gap-3">
        <Card title="Task graph" right={<span className="text-xs text-mute">edges = dependsOn · dashed = inserted by a subflow · click a task</span>}>
          <TaskGraph tasks={snap.tasks} onSelect={setTask} />
        </Card>
      </div>
      <div className="grid gap-3 xl:grid-cols-[1.25fr_1fr]">
        <Card title="Action timeline" right={<span className="text-xs text-mute">◐ acknowledged = an API said OK · ✔ confirmed = proven by read-back</span>}>
          <ActionTimeline actions={snap.actions} since={c.createdAt} />
        </Card>
        <div className="grid content-start gap-3">
        <Card title={<div className="flex gap-1">{TABS.map((t) => <button key={t} onClick={() => setTab(t)} className={`rounded-md px-2 py-0.5 text-sm ${tab === t ? "bg-s3 text-ink" : "text-ink2"}`}>{t}{t === "Approvals" && pending ? ` (${pending})` : ""}</button>)}</div>}>
          {tab === "Observations" && <ObservationsFeed snap={snap} />}
          {/* always mounted so new-approval toasts fire on every tab */}
          <div className={tab === "Approvals" ? "" : "hidden"}><Approvals snap={snap} /></div>
          {tab === "Timers" && <Timers snap={snap} />}
          {tab === "Summary" && <Summary snap={snap} />}
        </Card>
        <AgentStatusPanel status={status} connected={connected} />
        </div>
      </div>
      <Dialog open={!!task} onClose={() => setTask(null)} title={task ? `${task.taskId} · ${task.title ?? task.type}` : ""}>
        {task && (
          <div className="grid gap-2 text-sm">
            <div className="flex flex-wrap gap-2"><Pill look={look(TASK_LOOK, task.status)} /><span className="text-ink2">track {task.track}</span><span className="text-ink2">depends on {task.dependsOn.join(", ") || "nothing"}</span></div>
            {task.params && Object.keys(task.params).length > 0 && <Json value={task.params} />}
            <table className="w-full text-xs"><tbody className="divide-y divide-line">{task.history.map((h, i) => <tr key={i}><td className="py-1 pr-2"><Pill size="sm" look={look(TASK_LOOK, h.status)} /></td><td className="pr-2 text-mute">{simDay(h.at, c.createdAt)}</td><td className="pr-2 text-ink2">{h.by}</td><td>{h.note}</td></tr>)}</tbody></table>
          </div>
        )}
      </Dialog>
      <ChaosDrawer claimId={c._id} />
    </main>
  );
}
