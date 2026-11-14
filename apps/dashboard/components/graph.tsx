"use client";

import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo, useRef } from "react";
import { look, TASK_LOOK } from "@/lib/status";
import type { TaskJ } from "@/lib/types";

const LANES: TaskJ["track"][] = ["intake", "repair", "rental", "medical", "close"];
const LANE_LABEL: Record<string, string> = { intake: "Intake", repair: "Repair", rental: "Rental", medical: "Medical", close: "Close" };
const COL = 168;
const ROW = 62;
const LANE_GAP = 26;

type TaskNodeData = { task: TaskJ; inserted: boolean; fresh: boolean; onSelect?: (t: TaskJ) => void };

function TaskNode({ data }: NodeProps<Node<TaskNodeData>>) {
  const t = data.task;
  const l = look(TASK_LOOK, t.status);
  return (
    <div
      onClick={() => data.onSelect?.(t)}
      className={`w-[156px] cursor-pointer rounded-lg border-2 bg-s2 px-2 py-1.5 text-left ${data.fresh ? "node-inserted" : ""}`}
      style={{ borderColor: l.color, borderStyle: data.inserted ? "dashed" : "solid" }}
      title={`${t.taskId} · ${t.title ?? t.type} · ${l.label}${data.inserted ? " · inserted by a subflow" : ""}`}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div className="flex items-center justify-between gap-1">
        <span className="font-mono text-xs font-bold text-ink">{t.taskId.replace("#", "·")}</span>
        <span aria-hidden className="text-sm" style={{ color: l.color }}>{l.icon}</span>
      </div>
      <div className="truncate text-[11px] leading-tight text-ink2">{t.title ?? t.type}</div>
      <div className="text-[10px] font-medium" style={{ color: l.color }}>{l.label}</div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}
function LaneLabel({ data }: NodeProps<Node<{ label: string }>>) {
  return <div className="w-[90px] text-xs font-semibold tracking-wider text-mute uppercase">{data.label}</div>;
}
const nodeTypes = { task: TaskNode, lane: LaneLabel };

/** Longest-path depth from the roots (dependsOn), computed in plain code. */
function depths(tasks: TaskJ[]): Map<string, number> {
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  const memo = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const t = byId.get(id);
    const d = t && t.dependsOn.length ? 1 + Math.max(...t.dependsOn.filter((x) => byId.has(x)).map((x) => visit(x, seen)), -1) : 0;
    memo.set(id, d);
    return d;
  };
  for (const t of tasks) visit(t.taskId, new Set());
  return memo;
}

export function TaskGraph({ tasks, onSelect }: { tasks: TaskJ[]; onSelect?: (t: TaskJ) => void }) {
  const seen = useRef<Set<string> | null>(null);
  const { nodes, edges } = useMemo(() => {
    const first = seen.current === null;
    if (first) seen.current = new Set(tasks.map((t) => t.taskId));
    const d = depths(tasks);
    const slot = new Map<string, number>();
    // each lane is as tall as its tallest stack of same-depth tasks
    const stack = new Map<string, number>();
    for (const t of tasks) { const k = `${d.get(t.taskId) ?? 0}:${t.track}`; stack.set(k, (stack.get(k) ?? 0) + 1); }
    const laneRows = LANES.map((lane) => Math.max(1, ...[...stack.entries()].filter(([k]) => k.endsWith(`:${lane}`)).map(([, n]) => n)));
    const laneY = LANES.map((_, i) => laneRows.slice(0, i).reduce((a, n) => a + n * ROW + LANE_GAP, 0));
    const ns: Node[] = LANES.map((lane, i) => ({ id: `lane-${lane}`, type: "lane", position: { x: -110, y: laneY[i]! + 18 }, data: { label: LANE_LABEL[lane] }, draggable: false, selectable: false }));
    const sorted = [...tasks].sort((a, b) => (d.get(a.taskId) ?? 0) - (d.get(b.taskId) ?? 0) || a.taskId.localeCompare(b.taskId));
    for (const t of sorted) {
      const col = d.get(t.taskId) ?? 0;
      const lane = Math.max(0, LANES.indexOf(t.track));
      const key = `${col}:${lane}`;
      const k = slot.get(key) ?? 0;
      slot.set(key, k + 1);
      const inserted = !!t.params?.insertedBy || t.taskId.includes(":") || /a#/.test(t.taskId) || t.taskId.startsWith("CALL#");
      const fresh = !first && !seen.current!.has(t.taskId);
      seen.current!.add(t.taskId);
      ns.push({ id: t.taskId, type: "task", position: { x: col * COL, y: laneY[lane]! + k * ROW }, data: { task: t, inserted, fresh, onSelect } });
    }
    const es: Edge[] = [];
    for (const t of tasks) {
      for (const dep of t.dependsOn) {
        if (!tasks.some((x) => x.taskId === dep)) continue;
        const toClose = t.taskId === "T18";
        const live = ["in_progress", "waiting", "ready"].includes(t.status);
        es.push({ id: `${dep}->${t.taskId}`, source: dep, target: t.taskId, animated: live && !toClose, style: { stroke: "var(--border)", strokeWidth: toClose ? 1 : 1.6, opacity: toClose ? 0.25 : 0.9 } });
      }
    }
    return { nodes: ns, edges: es };
  }, [tasks, onSelect]);

  return (
    <div className="h-[400px] w-full overflow-hidden rounded-lg border border-line">
      <ReactFlow key={tasks.length} nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.04 }} minZoom={0.3} nodesDraggable={false} nodesConnectable={false} proOptions={{ hideAttribution: true }}>
        <Background gap={24} size={1} color="var(--surface-3)" />
        <Controls showInteractive={false} position="top-right" />
      </ReactFlow>
    </div>
  );
}
