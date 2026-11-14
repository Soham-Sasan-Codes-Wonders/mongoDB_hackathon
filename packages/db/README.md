# `@claim-coordinator/db`

The MongoDB boundary for Claim Coordinator. Apps should import the typed operations and Zod schemas from this package and should not create collections directly.

## Setup

Use Node 22 and run `pnpm install` from the repository root. Export `MONGODB_URI`; the database defaults to `claims_coordinator` and can be overridden with `MONGODB_DB`. `VOYAGE_API_KEY` is required for embedding and seeding. `pnpm db:setup`, `pnpm db:seed`, `pnpm db:smoke`, and `pnpm db:reset [--yes]` operate on that database. Transactions and change streams require an Atlas deployment or a local replica set.

## Search index budget

Setup creates exactly three Atlas indexes: `system_profiles_vector`, `experiences_vector`, and `documents_text`. System profile metadata, individual field vectors, and canonical field vectors share `system_profiles` with `docType` discriminators because Atlas Vector Search cannot index vectors nested inside arrays; `docType` and `system` filters keep each vector query in the right subset. Index creation is idempotent and setup waits until each index is queryable. Local MongoDB does not provide Atlas Search; the smoke script skips those two checks with a message.

## Exported functions

### Claims

- `getClaim(claimId)` loads one claim by its `CLM-*` identifier.
- `putClaim(claim)` inserts or replaces a validated claim.
- `listClaims()` returns claims ordered by creation time, newest first.
- `updateCompactSummary(claimId, compactSummary)` stores the crash-recovery summary and enforces the 2,000-character limit.
- `reconcileMoney(claimId)` uses an aggregation pipeline to return billed-to-submitted and submitted-to-paid gaps per invoice or estimate.
- `getClaimOverview(claimId)` returns a claim with tasks, latest action per task, pending approvals, and open timers.
- `getActionTimeline(claimId)` flattens action history into chronological dashboard events.

### Tasks and actions

- `findReadyTasks(claimId)` returns nonterminal tasks whose dependencies are all confirmed.
- `updateTaskStatus(claimId, taskId, status, meta, simAt, wallAt)` appends a status event and updates one task.
- `listTasks(claimId)` returns tasks ordered by task identifier.
- `mintIdempotencyKey(claimId, taskId, kind, attempt)` builds a stable request key; only a corrected rejection submission should increment the attempt.
- `transitionAction(actionId, to, meta)` applies a code-checked action transition and appends simulated and wall-clock audit times.
- `planTaskWithAction(session, task, action)` transactionally writes the task state and its action so an action cannot exist without its task.
- `getLatestActionsByTask(claimId)` returns the newest action for each task.
- `IllegalActionTransitionError` identifies a forbidden action-state transition.
- `ActionTransitionConflictError` identifies a concurrent state change that must be reloaded.

### Observations and recovery

- `insertObservation(observation)` validates and inserts an observation that wakes the agent change stream.
- `watchObservations(resumeToken)` watches only the observations collection and optionally resumes from a saved token.
- `saveResumeToken(workerId, token)` persists a worker's change-stream resume token.
- `loadResumeToken(workerId)` loads a worker's saved resume token.
- `acquireLease(claimId, workerId, ttlMs)` takes an absent, expired, or already-owned wall-clock lease atomically.
- `renewLease(claimId, workerId, ttlMs)` extends a lease held by that worker.
- `releaseLease(claimId, workerId)` releases a lease only when held by that worker.

### Timers and approvals

- `dueTimers(simNow)` returns unfired, uncancelled timers due on the simulated claim clock.
- `createTimer(timer)` inserts a follow-up timer.
- `cancelTimersForTask(claimId, taskId)` cancels outstanding timers when a task completes.
- `markFired(timerId)` atomically marks one active timer as fired.
- `createApproval(approval)` creates a pending audit record for one of the six human gates.
- `decideApproval(approvalId, decision, decidedBy, decidedAt)` records a single approval decision.
- `listPendingApprovals(claimId)` lists outstanding gates, optionally for one claim.

### Profiles, embeddings, and experiences

- `saveSystemProfile(profile)` stores one versioned system profile document.
- `saveProfileFields(system, version, fields)` embeds and stores each external field for a profile version.
- `saveCanonicalFields(fields)` embeds and stores canonical internal field definitions.
- `latestSystemProfile(system)` loads the latest profile document for a system.
- `embed(texts, inputType)` batches Voyage `voyage-3.5` embeddings with document/query modes and retries transient failures.
- `matchCanonicalField(fieldText, k)` vector-matches an external field to canonical fields.
- `findSimilarExperiences(problemText, filters, k)` retrieves prior fixes filtered by issue type and system.
- `recordExperience(input)` embeds and records one drift, rejection, crash, or caller-pattern experience.
- `ensureSearchIndexes()` idempotently creates the two vector indexes and the full-text index, then waits for them to become queryable.

### Documents, health, contacts, and simulated time

- `uploadDocument(input)` saves bytes to the `files` GridFS bucket and inserts searchable metadata.
- `downloadDocument(gridfsId)` returns the stored GridFS file as a buffer.
- `searchDocuments(claimId, query)` full-text searches metadata for a claim.
- `deleteClaimDocuments(claimId)` deletes a claim's GridFS objects and metadata.
- `recordHealth(entry)` records one system health sample.
- `getHealthSeries(system, sinceMs)` returns health samples from a wall-clock timestamp onward.
- `upsertContact(contact)` inserts or replaces a contact keyed by E.164 phone.
- `findContactByPhone(phone)` finds a contact by phone number.
- `listContacts(claimId)` lists all contacts or those associated with one claim.
- `now()` returns the current simulated claim time.
- `advance(ms)` advances simulated time by the requested number of simulated milliseconds.
- `setSpeed(speed)` sets simulated milliseconds per wall-clock millisecond; the default is 4,320 (one claim day per 20 seconds).
- `pauseClock(paused)` pauses or resumes simulated time.
- `setupDatabase(database)` idempotently creates collections, strict validators, regular indexes, the health time-series collection when available, and the three Atlas Search indexes.

## Schemas and types

Every collection has an exported Zod schema and an inferred TypeScript type, including `ClaimSchema`/`Claim`, `TaskSchema`/`Task`, `ActionSchema`/`Action`, `ObservationSchema`/`Observation`, `TimerSchema`/`Timer`, `LeaseSchema`/`Lease`, `ApprovalSchema`/`Approval`, `SystemProfileSchema`/`SystemProfile`, `ExperienceSchema`/`Experience`, `DocumentMetadataSchema`/`DocumentMetadata`, `GridFSFileSchema`/`GridFSFile`, `GridFSChunkSchema`/`GridFSChunk`, `SystemHealthSchema`/`SystemHealth`, `ContactSchema`/`Contact`, `SimClockSchema`/`SimClock`, and `WorkerStateSchema`/`WorkerState`. `ActionSchema` requires `idempotencyKey`, `expectedEffect`, and `verifyBy`, matching MongoDB's strict validator.

## Additions for `apps/agent`

Added when the agent was merged onto this package. Everything already here works as before: new
schema fields are optional, and new functions sit next to the existing ones. Build with
`pnpm db:build`; the agent's `dev`, `test` and `typecheck` scripts build first.

### Behaviour changes to existing code

- `findReadyTasks` treats `denied` and `closed_by_human` dependencies as resolved, not only `confirmed`, so a denied medical invoice can't block T18 forever. The pure check is exported as `readyFrom(tasks)`.
- `setupDatabase` also recognises `$listSearchIndexes stage is only allowed on MongoDB Atlas` (what a local `mongod` 7 returns) as "no Atlas Search here", so setup works on a local replica set, as this README already said it did.
- `decideApproval(id, decision, decidedBy, decidedAt?, decisionNote?)` takes an optional note; `cancelTimersForTask(claimId, taskId, rules?)` and `dueTimers(simNow, claimId?)` take optional filters; `findSimilarExperiences` accepts `problemType` and/or `system`.
- `seed` writes v1 `system_profiles` from `systemSpecs.ts` (the exact API descriptions the agent's mock systems serve at `GET /<system>/describe`), so the drift subflow diffs against what the systems really accept. Field docs now carry the endpoint in their description.
- Package scripts are invoked as `pnpm --filter @claim-coordinator/db run <script>` from the root: a bare `setup` collides with pnpm's built-in `pnpm setup`.

### New optional schema fields (zod + `$jsonSchema`)

- `claims`: `claimant.firstName`, `policy.deductible`, `accident` (intake details), `external` (outside-system references), `facts` (working facts), `closedAt`.
- `tasks`: `title`, `isWait`, `params`, `trigger`, `triggeredAt`.
- `actions`: `gate`, `approvalId`, `response`, `readback`, `lastError`, `verifyAfter`, `profileVersion`, `updatedAt`.
- `observations`: `receivedWallAt`, `processedBy`, `note`. `timers`: `actionId`, `approvalId`, `params`, `firedAt`.
- `approvals`: `actionId` is now optional (a phone decision has no action), plus `taskId`, `details`, `decisionNote`. Gate enum adds `decision_request`, `reconciliation_gap`, `llm_review`.
- `system_profiles` (profile docs): `fieldMap` (canonical name → the system's current name), `source`; profile fields can carry `endpoint` and `description`.
- `experiences.claimId`; `worker_state` heartbeat fields (`heartbeatAt`, `pid`, `held`, `replayed`, `startedAt`); new `counters` collection (claim ids).

### New functions

- Clock: `initClockCache(refreshMs?)` + `nowSync()` (synchronous sim time from a 1 s cache, so the agent doesn't spend an M0 op per timestamp), `refreshClock()`, `resetClock(speed?)`, `simToWallMs(ms)`, `stopClockCache()`, `DAY_MS`, `DEFAULT_SPEED`.
- Claims: `nextClaimId()`, `createClaimWithTasks(claim, tasks)` (one transaction), `updateClaimFields(id, set, unset?)`, `listActiveClaimIds()`, `upsertMoneyItem(id, item)`, `recomputeMoneyTotals(id)` (aggregation).
- Tasks: `readyFrom(tasks)`, `buildTask(newTask)`, `insertTaskIfMissing(task)`, `getTask`, `listOpenTasks`, `setTaskStatus(claimId, taskId, status, {by, note?, from?, set?})` (compare-and-set when `from` is given), `updateTaskFields`, `addDependency`, `RESOLVED_TASK_STATUSES`.
- Actions: `canTransition(from, to)`, `ACTION_TRANSITIONS`, `TERMINAL_ACTION_STATUSES`, `setActionFields(id, set)`, `appendActionNote(id, note, by, set?)`, `getAction`, `findActionByKey`, `listActions(claimId, {status?, taskId?})`, `countActionsForTask`, `planTaskWithActionAndApproval(task, action, approval?)` (the outbox: task change + action + gate approval in one transaction).
- Observations: `listUnprocessed`, `listObservations`, `getObservation`, `markProcessed(id, by, processedAt, set?)`, `updateObservationFields`, `claimsWithUnprocessed`, `saveWorkerHeartbeat`, `listWorkerStates`.
- Timers: `ensureTimer` (no duplicate open timer), `cancelTimersForAction`, `cancelTimersForApproval`, `listOpenTimers`. Leases: `getLease`, `listLeases`, `expiredLeases`.
- Approvals: `GATE_APPROVER`, `getApproval`, `listApprovals(claimId, status?)`, `findPendingApproval(claimId, gate, taskId?)`.
- Profiles: `getLatestProfile(system)`, `saveProfileVersion({system, fields, workflowSteps, fieldMap?, source?})` (version + 1 plus embedded field docs).
- Documents: `listDocuments(claimId, docType?)`, `getDocumentMeta(id)`. Contacts: `linkContactToClaim(phone, claimId)`.
- Setup: `resetDemoData()` (clears demo claim data but keeps the seeded `CLM-1042`, seed data and resume tokens; uses `deleteMany` so live change streams survive). `closeDatabase` is now exported from the index.
- `systemSpecs.ts`: `V1_SYSTEM_SPECS`, `specToProfileFields`, `SystemSpec`, `EndpointSpec`, `OutsideSystem`.

### Local-dev fallbacks (Atlas is always tried first)

- `$vectorSearch` (in `matchCanonicalField`, `findSimilarExperiences`) and `$search` (in `searchDocuments`) fall back to an in-process cosine scan or a regex when the server says Atlas Search isn't available, with a one-time warning.
- `embed()` still requires `VOYAGE_API_KEY`. Only when `ALLOW_LOCAL_EMBEDDINGS=1` is set and there is no key does it use a deterministic local hashing embedding (every value is a non-integer, so the `double` validators accept it).
