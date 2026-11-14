# @claims/db — the MongoDB data layer

Owns every collection, `$jsonSchema` validator, index, Atlas Search / Vector Search index,
embedding helper and typed data-access function for Claim Coordinator. `apps/agent` and
`apps/dashboard` import only from this package and never call `db.collection(...)` themselves.
TS types are inferred from the zod schemas in `src/schemas.ts`, so there is one definition.

```bash
pnpm db:setup   # collections + validators + indexes + time-series + the 3 search indexes (idempotent; --no-wait skips waiting)
pnpm db:seed    # canonical fields, v1 system_profiles, 10 starter experiences, demo contacts, clock
pnpm db:smoke   # claim -> outbox transaction -> planned/sent/acknowledged/confirmed -> validator check -> vector + text query -> cleanup
pnpm db:reset   # drop the database (asks unless --yes)
```

Env: `MONGODB_URI`, `MONGODB_DB` (default `claims_coordinator`), `VOYAGE_API_KEY`. The `.env` at the
repo root is loaded automatically.

## Atlas Free (M0) fit, and the 3-search-index budget

M0 allows **at most 3 search indexes**, and we use exactly 3:

1. `system_profiles_vector` — vector index on `system_profiles.embedding` (1024 dims, cosine), filters `docType`, `system`.
2. `experiences_vector` — vector index on `experiences.embedding`, filters `problemType`, `system`.
3. `documents_text` — Atlas Search on `documents.extractedText` (+ `docType`, `claimId` tokens). Call transcripts land here as `docType: "call_transcript"`.

**Why `system_profiles` uses `docType`:** Atlas Vector Search can't index vectors nested in
arrays of subdocuments, and we can't afford a fourth index for canonical fields. So one collection
holds three document types:

- `docType: "profile"` — `system`, `version`, `fields[]` (name, type, required, endpoint, sampleValues), `workflowSteps[]`, `fieldMap` (canonical → system name), `createdAt`. No embedding.
- `docType: "field"` — one per field per profile version, with an `embedding`.
- `docType: "canonical_field"` — our internal fields (`policyNumber`, `claimNumber`, `vehicleVin`, `treatmentCode`, …), each with an `embedding`.

Drift matching (`policy_ref` → `policyNumber`) is a vector query filtered to `docType: "canonical_field"`.

Other M0 adaptations: timers and lease sweeps run in the worker every 2 s (Scheduled Triggers fire
at most once a minute); lease takeover checks `expiresAt` directly and the TTL index only cleans up;
change streams are opened on the `observations` collection (no db-name filters); mock systems keep
their own state outside Atlas (100 ops/s budget). `system_health` is a time-series collection, with
a fallback to a normal collection if the cluster refuses.

**Local replica set** (`mongod --replSet rs0`): everything works, including transactions and change
streams. `$vectorSearch` / `$search` aren't available, so `db:setup` skips the 3 search indexes with
a message, and queries fall back to an in-process cosine scan / regex (warned once). Without
`VOYAGE_API_KEY`, `embed()` uses deterministic local hashing embeddings (dev only).

## Collections

`claims`, `tasks`, `actions`, `observations`, `timers`, `leases`, `approvals`, `system_profiles`,
`experiences`, `documents` (+ GridFS bucket `files`), `system_health` (time-series), `contacts`,
`sim_clock`, `worker_state` (resume tokens + worker heartbeats), `counters` (claim ids). Validators
are strict (`validationLevel: "strict"`, `validationAction: "error"`). The `actions` validator rejects
an action without `idempotencyKey`, `expectedEffect` (and it must be non-empty) or `verifyBy`.

Indexes: `tasks {claimId,taskId}` unique; `actions {idempotencyKey}` unique; `timers {fired,cancelled,dueAt}`;
`leases {expiresAt}` TTL (cleanup only); `contacts {phone}` unique; plus query indexes on
`observations {claimId,processedAt,receivedAt}`, `actions {claimId,status}`, `approvals {claimId,status}`.

Additions beyond Prompt 2's table: `approvals.gate` also allows `decision_request`,
`reconciliation_gap` and `llm_review` (the doc describes these approvals but doesn't list them as
gates); `experiences.problemType` also allows `ghost_booking`; money lines live in
`claims.money.items[]` so reconciliation is one aggregation over one collection.

## API (one line each)

### `clock` — simulated time (1 claim day = 20 s by default)
- `initClock({refreshMs?})` — load/create the singleton and keep a 1 s cache so `now()` is synchronous.
- `now()` / `nowMs()` — current simulated time; the only source of business time.
- `advance(ms)` — fast-forward (the dashboard's "Fast-forward clock").
- `setSpeed(simMsPerWallMs)`, `setPaused(bool)`, `resetClock()`, `refresh()`, `stopClock()`.
- `claimDay(since, at?)` — "Day N" index. `simToWallMs(ms)`. `defaultSpeed()`. Constants `DAY`, `HOUR`.

### `claims`
- `nextClaimId()` — `CLM-1042`, `CLM-1043`, … (atomic counter).
- `createClaim(claim, session?)` — validated insert (phase `intake`, empty money).
- `getClaim(id)`, `updateClaim(id, $set)`, `listActiveClaimIds()`.
- `setCompactSummary(id, text)` — the only context reloaded after a crash (≤ 2000 chars).
- `upsertMoneyItem(id, {ref, category, billed?, submitted?, paid?, gapReason?})` — one money line.
- `recomputeMoneyTotals(id)` — totals per category by aggregation.
- `reconcileMoney(id)` — aggregation pipeline: billed vs submitted vs paid per line → `{balanced, gaps, unexplained, itemCount}`.

### `tasks`
- `insertTasks(tasks, session?)`, `insertTaskIfMissing(task)` — seed / add tasks (unique on claimId+taskId).
- `getTask`, `listTasks(claimId, {status?})`, `listOpenTasks(claimId)`.
- `setTaskStatus(claimId, taskId, status, {by, note?, from?, set?, session?})` — with history; `from` makes it compare-and-set.
- `updateTaskFields(claimId, taskId, $set)`, `addDependency(claimId, taskId, dependsOnId)`.
- `findReadyTasks(claimId)` / `computeReady(tasks)` — dependencies all confirmed/denied/closed_by_human (plain code).
- `planTaskWithAction(session|null, taskUpdate, action, approval?)` — the transactional outbox: task change + new action (+ approval) in one transaction.

### `actions`
- `TRANSITIONS`, `canTransition(from, to)`, `isTerminal(status)` — the code-enforced lifecycle.
- `transitionAction(id, to, {by, note?, set?, incAttempts?})` — compare-and-set move, appends `history`; throws `IllegalTransitionError`.
- `noteAction(id, note, by, set?)` — history note without a status change.
- `mintIdempotencyKey(claimId, taskId, kind, attempt)` — `CLM-1042:T5:create_reservation:1`.
- `buildActionDoc(newAction)`, `getAction`, `findActionByKey`, `listActions(claimId, {status?, taskId?})`, `listUnverified(claimId)`, `listOpenForTask`, `countActionsForTask`, `latestActionForTask`.

### `observations`
- `insertObservation({claimId, source, kind, body, trust?, verified?, processed?})` — wakes the agent (change stream).
- `listUnprocessed(claimId)`, `listObservations(claimId, limit?)`, `markProcessed(id, by, {matchedActionId?, verified?, note?})`, `updateObservation`, `claimsWithUnprocessed()`.
- `watchObservations(resumeToken?)` — insert change stream on the collection (M0-safe).
- `saveResumeToken(workerId, token)`, `loadResumeToken(workerId)`, `saveWorkerHeartbeat(workerId, info)`, `listWorkerStates()`.

### `timers`
- `createTimer`, `ensureTimer` (no duplicate open timer), `dueTimers(simNow, claimId?)`, `markFired(id)` (compare-and-set).
- `cancelTimersForTask(claimId, taskId, rules?)`, `cancelTimersForAction(actionId)`, `cancelTimersForApproval(approvalId)`, `listOpenTimers(claimId)`.

### `leases` (wall clock)
- `acquireLease(claimId, workerId, ttlMs)` — conditional `findOneAndUpdate`: free, ours, or `expiresAt < now`.
- `renewLease`, `releaseLease`, `getLease`, `listLeases`, `expiredLeases`.

### `approvals`
- `createApproval({claimId, actionId, taskId?, gate, request, details?})` — approver role derived from the gate (`GATE_APPROVER`).
- `buildApprovalDoc`, `getApproval`, `listApprovals(claimId, status?)`, `findPendingApproval(claimId, gate, taskId?)`.
- `decideApproval(id, "approved"|"declined", decidedBy, note?)` — records who and when (only from pending).

### `profiles` (system_profiles)
- `getLatestProfile(system)`, `listProfileVersions(system)`.
- `saveProfileVersion({system, fields, workflowSteps, fieldMap?, source?})` — version+1 plus embedded `field` docs.
- `upsertCanonicalField({name, description, sampleValues})`, `matchCanonicalField(fieldText, k)` — vector match to canonical fields.

### `experiences`
- `recordExperience({problemType, system, problem, fix, outcome, claimId?})` — embeds, then inserts.
- `findSimilarExperiences(problemText, {problemType?, system?}, k)` — vector search.

### `documents` (GridFS bucket `files` + `documents` metadata)
- `putDocument({claimId, docType, source, data?, filename?, contentType?, extractedText?, meta?})`, `getFile(gridfsId)`, `listDocuments(claimId, docType?)`, `findDocumentByMeta(claimId, key, value)`.
- `searchDocuments(claimId, query, limit?)` — Atlas Search on `extractedText` (regex fallback locally).

### `health` (time-series `system_health`)
- `recordHealth({system, latencyMs, ok, errorCode?, endpoint?})`, `getHealthSeries(system, sinceMs)`, `healthSummary(system, sinceMs)`.

### `contacts`
- `findByPhone(e164)` — one indexed lookup (call initiation). `upsertContact`, `linkContactToClaim`, `listContacts(claimId?)`.

### `readModels` (dashboard)
- `getClaimOverview(claimId)` — claim + tasks (each with its latest action) + pending approvals + open timers.
- `listClaims()`, `getActionTimeline(claimId)` (every transition, flattened), `getHealthSeries`, `searchDocuments`.

### `setup`, seed, misc
- `setup.setupDatabase({searchIndexes?, waitForSearch?})`, `setup.setupSearchIndexes(db, wait)`, `setup.dropEverything()`.
- `setup.resetDemoData()` — clears claim data, profile versions > 1 and claim-made experiences, restarts the clock (keeps seed data and resume tokens; `deleteMany`, so live change streams survive).
- `seedDatabase(log?)`, `DEMO_CONTACTS`, `V1_SYSTEM_SPECS` (v1 API descriptions served by the mocks' `/describe`), `specToProfileFields`, `CANONICAL_FIELDS`.
- `embed(texts, "document"|"query")`, `embedOne`, `cosine`, `EMBED_DIM` — Voyage `voyage-3.5`, 1024 dims, batched + retried.
- `getDb()`, `getClient()`, `closeDb()`, `withTransaction(fn)`, `col` (typed collection getters, for this package's own use), `env`.
- Zod schemas + types: `Claim`, `Task`, `Action`, `Observation`, `Timer`, `Lease`, `Approval`, `SystemProfile`, `ProfileField`, `Experience`, `DocumentMeta`, `HealthSample`, `Contact`, `SimClock`, `MoneyItem`; enums `ACTION_STATUSES`, `TASK_STATUSES`, `GATES`, `TIMER_RULES`, `OBS_SOURCES`, `SYSTEMS`, …; `validators` (the `$jsonSchema` set).
