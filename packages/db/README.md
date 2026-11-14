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
