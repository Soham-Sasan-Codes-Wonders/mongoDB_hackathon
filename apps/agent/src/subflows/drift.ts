import {
  actions, approvals, experiences, profiles, tasks,
  type ActionDoc, type OutsideSystem, type ProfileField, type SystemSpec,
} from "../db.ts";
import { config } from "../config.ts";
import { getter, retry, type ExecOutcome } from "../executor/index.ts";
import { reads } from "../executor/adapters.ts";
import { proposeFieldMapping, type MappingProposal } from "../llm/jobs.ts";
import { errMsg } from "../log.ts";
import type { ClaimCtx } from "../worker/context.ts";

export interface DriftTrigger {
  system: OutsideSystem;
  taskId: string;
  action?: ActionDoc | null;
  trigger: "validation_error" | "readback_mismatch" | "webhook_shape" | "new_required_step";
  error: string;
  op?: string;
  step?: string;
}

type Diff = { added: ProfileField[]; removed: ProfileField[]; newSteps: string[] };

/** Diff a live /describe against the latest stored profile (per endpoint op + field name). */
export function diffProfile(latest: { fields: ProfileField[]; workflowSteps: string[] } | null, describe: SystemSpec): Diff {
  const live: ProfileField[] = describe.endpoints.flatMap((e) => e.fields.map((f) => ({ ...f, endpoint: e.op })));
  const k = (f: ProfileField) => `${f.endpoint}:${f.name}`;
  const known = new Set((latest?.fields ?? []).map(k));
  const now = new Set(live.map(k));
  return {
    added: live.filter((f) => !known.has(k(f))),
    removed: (latest?.fields ?? []).filter((f) => !now.has(k(f))),
    newSteps: describe.workflowSteps.filter((s) => !(latest?.workflowSteps ?? []).includes(s)),
  };
}

/**
 * Drift subflow (doc steps 1-7): pause ONLY the affected task, diff /describe against the latest
 * profile, vector-match new fields to canonical fields, look up similar past drift, let the LLM
 * propose a mapping / new task with a confidence, auto-apply at >= threshold or ask an operator,
 * then save a new profile version, retry with the SAME key, and record the experience.
 */
export async function runDrift(c: ClaimCtx, d: DriftTrigger): Promise<{ status: "applied" | "awaiting_operator" | "skipped"; outcome?: ExecOutcome | null }> {
  // Don't open a second drift for the same task while one waits for an operator.
  const pending = (await approvals.listApprovals(c.claimId, "pending")).find((a) => a.gate === "drift_mapping" && a.taskId === d.taskId);
  if (pending) return { status: "skipped" };
  try {
    return await analyseDrift(c, d);
  } catch (e) {
    // e.g. the embeddings API rate-limited us. Never leave the task blocked with nothing to act on:
    // hand it to an operator, whose approval reruns the analysis.
    const msg = errMsg(e).slice(0, 300);
    c.log("drift", `analysis failed: ${msg}; operator approval created (approve = retry)`);
    await approvals.createApproval({
      claimId: c.claimId,
      actionId: d.action ? String(d.action._id) : null,
      taskId: d.taskId,
      gate: "drift_mapping",
      request: `Drift analysis on ${d.system} for ${d.taskId} failed (${msg}). Approve to retry the analysis; decline to fix it by hand.`,
      details: { trigger: { system: d.system, taskId: d.taskId, trigger: d.trigger, error: d.error, op: d.op ?? null, step: d.step ?? null }, analysisFailed: true, failure: msg },
    });
    c.event(`drift analysis on ${d.system} failed; operator asked to retry`);
    return { status: "awaiting_operator" };
  }
}

async function analyseDrift(c: ClaimCtx, d: DriftTrigger): Promise<{ status: "applied" | "awaiting_operator" | "skipped"; outcome?: ExecOutcome | null }> {
  const tag = "drift";

  // 1. pause the affected task only
  await tasks.setTaskStatus(c.claimId, d.taskId, "blocked_drift", { by: c.workerId, note: `${d.trigger}: ${d.error}` });
  c.log(tag, `1 ${d.taskId} -> blocked_drift (${d.trigger} on ${d.system}: ${d.error})`);

  // 2. fetch the live description and diff it against the latest profile version
  const latest = await profiles.getLatestProfile(d.system);
  const r = await reads.describe(getter(d.system), d.system);
  if (r.status !== 200) {
    c.log(tag, `2 /describe failed (${r.status}); leaving ${d.taskId} blocked for an operator`);
    return { status: "awaiting_operator" };
  }
  const describe = r.json as SystemSpec;
  const diff = diffProfile(latest, describe);
  c.log(tag, `2 diff vs profile v${latest?.version ?? 0}: +${diff.added.map((f) => `${f.endpoint}.${f.name}`).join(",") || "-"} / -${diff.removed.map((f) => `${f.endpoint}.${f.name}`).join(",") || "-"} / new steps ${diff.newSteps.join(",") || "-"}`);

  // 3. embed each new/renamed field with samples -> Vector Search against canonical fields
  // One embedding per distinct field name: a rename usually shows up on several endpoints.
  const canonicalMatches = [];
  const byName = new Map<string, { fieldName: string; score: number }[]>();
  for (const f of diff.added) {
    let candidates = byName.get(f.name);
    if (!candidates) {
      const text = `${d.system} field ${f.name} (${f.type}): ${f.description ?? ""}. samples: ${(f.sampleValues ?? []).join(", ")}`;
      candidates = (await profiles.matchCanonicalField(text, 3)).map((x) => ({ fieldName: x.fieldName, score: Number(x.score.toFixed(3)) }));
      byName.set(f.name, candidates);
      c.log(tag, `3 vector: ${f.name} -> ${candidates.map((x) => `${x.fieldName}(${x.score.toFixed(2)})`).join(", ")}`);
    }
    canonicalMatches.push({ systemField: f.name, endpoint: f.endpoint, candidates });
  }

  // 4. Vector Search experiences for similar past drift
  const similar = await experiences.findSimilarExperiences(`${d.error}. ${diff.added.map((f) => f.name).join(" ")} ${diff.newSteps.join(" ")}`, { problemType: "drift", system: d.system }, 3);
  c.log(tag, `4 similar experiences: ${similar.map((e) => `"${e.problem.slice(0, 50)}"(${e.score.toFixed(2)})`).join("; ") || "none"}`);

  // 5. LLM proposes a mapping and/or new task with a confidence score
  const openTaskIds = (await tasks.listOpenTasks(c.claimId)).map((t) => t.taskId);
  const p = await proposeFieldMapping({
    system: d.system,
    error: `${d.trigger}: ${d.error}`,
    diff: { added: diff.added, removed: diff.removed, newSteps: diff.newSteps },
    canonicalMatches,
    experiences: similar.map((e) => ({ problem: e.problem, fix: e.fix, outcome: e.outcome })),
    openTaskIds,
  });
  const proposal: MappingProposal | null = p.ok ? p.value : null;
  const confidence = proposal ? Math.min(proposal.confidence, ...proposal.mappings.map((m) => m.confidence), ...proposal.newTasks.map((t) => t.confidence)) : 0;
  const empty = !proposal || (!proposal.mappings.length && !proposal.newTasks.length);
  c.log(tag, `5 proposal ${p.ok ? JSON.stringify({ mappings: proposal!.mappings.map((m) => `${m.canonical}->${m.systemField}@${m.confidence}`), newTasks: proposal!.newTasks.map((t) => `${t.kind}@${t.confidence}`) }) : `failed (${p.reason})`} confidence ${confidence}`);

  // 6. high confidence: apply. low confidence (or nothing usable): an operator confirms.
  if (empty || confidence < config.driftAutoApplyThreshold) {
    await approvals.createApproval({
      claimId: c.claimId,
      actionId: d.action ? String(d.action._id) : null,
      taskId: d.taskId,
      gate: "drift_mapping",
      request: empty
        ? `${d.system} changed (${d.error}) and no mapping could be proposed. Fix the profile manually, then approve to retry ${d.taskId}.`
        : `${d.system} changed. Proposed: ${proposal!.mappings.map((m) => `${m.canonical} -> ${m.systemField}`).join(", ")}${proposal!.newTasks.length ? `; new task(s): ${proposal!.newTasks.map((t) => t.title).join(", ")}` : ""} (confidence ${confidence.toFixed(2)} < ${config.driftAutoApplyThreshold}). Approve to apply and retry with the same key.`,
      details: {
        trigger: { system: d.system, taskId: d.taskId, trigger: d.trigger, error: d.error, op: d.op ?? null, step: d.step ?? null },
        proposal,
        diff,
        describe,
        confidence,
        threshold: config.driftAutoApplyThreshold,
        // What the operator card shows: old -> new field, the Vector Search matches with scores, similar past drift.
        renames: diff.removed.map((r) => ({ endpoint: r.endpoint, from: r.name, to: diff.added.find((a) => a.endpoint === r.endpoint && proposal?.mappings.some((m) => m.systemField === a.name && m.canonical === r.name))?.name ?? null })),
        canonicalMatches,
        similarExperiences: similar.map((e) => ({ problem: e.problem, fix: e.fix, outcome: e.outcome, score: e.score })),
      },
    });
    c.event(`drift on ${d.system}: proposal sent to operator (confidence ${confidence.toFixed(2)})`);
    c.log(tag, `6 confidence ${confidence.toFixed(2)} < ${config.driftAutoApplyThreshold}: operator approval created; ${d.taskId} stays blocked_drift`);
    return { status: "awaiting_operator" };
  }
  c.log(tag, `6 confidence ${confidence.toFixed(2)} >= ${config.driftAutoApplyThreshold}: auto-applying`);
  const outcome = await applyDriftProposal(c, d, proposal!, describe, "auto");
  return { status: "applied", outcome };
}

/** Step 7 (also used when an operator approves a low-confidence proposal). */
export async function applyDriftProposal(c: ClaimCtx, d: DriftTrigger, proposal: MappingProposal, describe: SystemSpec, by: "auto" | "operator") {
  const tag = "drift";
  const latest = await profiles.getLatestProfile(d.system);
  const fieldMap = { ...(latest?.fieldMap ?? {}) };
  for (const m of proposal.mappings) fieldMap[m.canonical] = m.systemField;
  const version = await profiles.saveProfileVersion({
    system: d.system,
    fields: describe.endpoints.flatMap((e) => e.fields.map((f) => ({ ...f, endpoint: e.op }))),
    workflowSteps: describe.workflowSteps,
    fieldMap,
    source: `drift:${by}:${c.claimId}`,
  });
  c.log(tag, `7 saved ${d.system} profile v${version} fieldMap=${JSON.stringify(fieldMap)}`);

  // New required steps become tasks wired into dependsOn so they block what they must precede.
  const inserted: string[] = [];
  for (const nt of proposal.newTasks) {
    // Code, not the model, decides what a new required step blocks: the task whose proof it withheld
    // (the drift was detected on it) comes first; the model's suggestions are added after.
    const own = d.trigger === "new_required_step" ? [d.taskId] : [];
    const blocks = [...new Set([...own, ...nt.blocksTaskIds])];
    if (!blocks.length) blocks.push("T9");
    const newId = `${blocks[0]}a#${nt.step}`;
    const added = await tasks.insertTaskIfMissing({
      claimId: c.claimId,
      taskId: newId,
      type: "upload_step",
      title: nt.title,
      track: "repair",
      dependsOn: ["T2"],
      params: { step: nt.step, kind: nt.kind, endpoint: nt.endpoint, insertedBy: "drift" },
    });
    for (const b of blocks) {
      await tasks.addDependency(c.claimId, b, newId);
      const bt = await tasks.getTask(c.claimId, b);
      if (bt && ["waiting", "blocked_drift", "ready"].includes(bt.status)) await tasks.setTaskStatus(c.claimId, b, "pending", { by: c.workerId, note: `now depends on ${newId}` });
    }
    if (added) inserted.push(newId);
    c.log(tag, `7 inserted task ${newId} (${nt.kind}); it now blocks ${blocks.join(", ")}`);
  }

  // Retry the failed action with the SAME idempotency key.
  let outcome: ExecOutcome | null = null;
  if (d.action) {
    const a = await actions.getAction(d.action._id);
    // A 422 parks the action as `failed` (shared state machine: failed -> sent is the same-key retry).
    if (a && (a.status === "failed" || a.status === "sent" || a.status === "acknowledged")) {
      await tasks.setTaskStatus(c.claimId, d.taskId, "in_progress", { by: c.workerId, note: `drift fixed (profile v${version}); retrying with the same key` });
      try {
        outcome = await retry(a, c.workerId);
        c.log(tag, `7 retry same key ${a.idempotencyKey} -> ${outcome.outcome}`);
      } catch (e) {
        c.log(tag, `7 retry failed: ${errMsg(e)}`);
      }
    }
  } else {
    const t = await tasks.getTask(c.claimId, d.taskId);
    if (t?.status === "blocked_drift") await tasks.setTaskStatus(c.claimId, d.taskId, "pending", { by: c.workerId, note: `drift handled (profile v${version})` });
  }

  await experiences.recordExperience({
    problemType: "drift",
    system: d.system,
    problem: `${d.trigger}: ${d.error}`,
    fix: { mapping: Object.fromEntries(proposal.mappings.map((m) => [m.canonical, m.systemField])), newTasks: proposal.newTasks.map((t) => ({ kind: t.kind, step: t.step, blocks: t.blocksTaskIds })), appliedBy: by, profileVersion: version },
    outcome: outcome ? `retried with the same key -> ${outcome.outcome}` : inserted.length ? `inserted ${inserted.join(", ")}` : "profile updated",
    claimId: c.claimId,
  });
  c.event(`drift on ${d.system} fixed (${by}): profile v${version}${inserted.length ? `, new task ${inserted.join(", ")}` : ""}`);
  return outcome;
}
