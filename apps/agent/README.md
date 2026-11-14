# apps/agent — Claim Coordinator agent

Takes a car accident claim from first report to a closed file across four mock outside systems
(insurer, body shop, rental, clinic billing), a claimant, and an inbound phone line. Source of
truth for the design: `Claim Coordinator Agent — Workflow Design (1).md` at the repo root. All
database access goes through `packages/db` (`@claim-coordinator/db`). `src/db.ts` is a thin facade
over it that only renames and reshapes; it never calls the driver.

Three rules everything follows:

1. **Proof, not responses.** HTTP 2xx moves an action to `acknowledged`. Only a read-back (or a
   webhook-triggered read-back) that satisfies `expectedEffect` moves it to `confirmed`.
2. **State lives in MongoDB.** `kill -9` the worker between any two steps and nothing is lost. The
   LLM never sees old conversation, only `claims.compactSummary`, open tasks and new observations.
3. **The model judges, code enforces.** State transitions, the dependency graph, idempotency keys,
   gates, timers, retry limits, leases and money reconciliation are plain TypeScript.

## Run it

```bash
# repo root
pnpm install
# create .env at the repo root (gitignored) with MONGODB_URI, MONGODB_DB, VOYAGE_API_KEY, ANTHROPIC_API_KEY, ELEVENLABS_WEBHOOK_SECRET (see the table below)
pnpm db:setup && pnpm db:seed # collections, validators, indexes, 3 search indexes, seed data (v1 profiles = the mocks' /describe)
pnpm --filter agent dev       # builds packages/db, then mocks :4000 + control/webhooks/phone :4100 + supervised worker(s)
```

`dev` re-runs `setupDatabase()` (idempotent) on start; run `pnpm db:seed` once per database.

| Env | Meaning |
| --- | --- |
| `MONGODB_URI`, `MONGODB_DB` | Atlas (M0 is fine) or a local replica set (`mongod --replSet rs0`; transactions and change streams need one) |
| `ANTHROPIC_API_KEY` | When set, the LLM runs live. When unset, `LLM_MODE` defaults to `stub`: deterministic offline heuristics that go through the same zod validation. Force with `LLM_MODE=live\|stub`. |
| `LLM_MODEL` | Claude model for every job. Default `claude-haiku-5-5` (fast, low cost); e.g. `claude-opus-5-5` for harder judgment. |
| `VOYAGE_API_KEY` | `voyage-3.5` embeddings (required by `packages/db`). For offline dev only, `ALLOW_LOCAL_EMBEDDINGS=1` uses a local hashing embedding instead. |
| `ELEVENLABS_WEBHOOK_SECRET` | HMAC secret for `/phone/post-call`. Unset: every post-call webhook is rejected. |
| `WORKERS` | `1` (default) or `2` to show lease takeover. |
| `CLAIM_DAY_MS` | Wall ms per simulated claim day for a fresh clock (default `20000`). |
| `DRIFT_AUTO_APPLY_THRESHOLD` | Drift mapping auto-apply confidence (default `0.85`). |
| `LEASE_TTL_MS`, `VERIFY_DELAY_SIM_MS`, `LLM_MIN_CONFIDENCE` | Tuning knobs (see `src/config.ts`). |

Without Atlas, `$vectorSearch`/`$search` fall back to in-process cosine and regex with a warning.

### Demo scenes

Start `pnpm --filter agent dev` in one terminal, then in another:

```bash
pnpm --filter agent demo:day0       # 1. T1–T6, sent -> acknowledged -> confirmed
pnpm --filter agent demo:ghost      # 2. ghost booking, same-key retry, exactly one reservation
pnpm --filter agent demo:crash      # 3. SIGKILL worker, 3 webhooks, restart, resume token, 0 re-sends
pnpm --filter agent demo:drift      # 4. rename policyNumber + require photos -> mapping + T9a#photos blocks T9
pnpm --filter agent demo:close      # 5. fast-forward through T15 gates and T18 reconciliation
pnpm --filter agent demo:phone      # 6. "approved" on the phone vs pending portal -> claimed, not confirmed
pnpm --filter agent demo:rejection  # bonus: rejected invoice -> fact task -> new key supersedes
pnpm --filter agent demo:all        # all of the above, in order
```

Each script resets the claim data (`resetDemoData()`, which keeps the seeded `CLM-1042`), mock state and clock (seed data and resume tokens are kept),
drives the scene, asserts the outcome, and prints the action history it produced.

### Tests

```bash
pnpm --filter agent test      # vitest: state machine, executor gates, idempotent retries, HMAC, schemas, drift diff
pnpm --filter agent typecheck
```

## Processes and ports

```
pnpm --filter agent dev
 ├─ mocks (Fastify :4000)           insurer / body_shop / rental / clinic + /chaos/*   own JSON state (.data/mocks.json)
 ├─ control (Fastify :4100)         /control/*, /webhooks/:system, /phone/*
 └─ supervisor ──spawns──> worker-1 [worker-2]   (child processes: "Kill agent" = SIGKILL)
```

The worker never polls outside systems. It wakes on a change stream on `observations` (the
resume token is saved after each event), a timer loop (`dueTimers(clock.now())` every 2 s), and a
lease sweeper (takes over claims whose lease expired). Per-claim runs are serialised, and the
claim lease (wall-clock TTL 10 s, heartbeat 3 s) keeps two workers off the same claim.

## Endpoints

### Control + inbound (`:4100`)

| Method | Path | What |
| --- | --- | --- |
| POST | `/control/claims` | Create a claim from the intake form, seed T1–T18 with `dependsOn`, link contacts, insert the intake observation. Returns `{claimId}`. Body: `{claimant:{name,phone,email?}, accident:{date,place,description,otherDriver?,policeReportNumber?,injuries}, policyNumber, insurer?, vehicle:{vin,make?,model?,year?,plate?}, photos?:string[], message?}` |
| POST | `/control/kill-worker` | SIGKILL the worker(s). Body `{workerId?}` |
| POST | `/control/start-worker` | Start the worker(s). Body `{workerId?}` |
| GET | `/control/status` | Worker ids/pids/history, leases (holder, expiry, live), resume-token save time per worker, events replayed from the token, sim + wall clock, LLM mode |
| POST | `/webhooks/:system` | Mock-system webhooks (`insurer`, `body_shop`, `rental`, `clinic`) → `observations` |
| POST | `/phone/initiation` | ElevenLabs conversation-initiation webhook → dynamic variables (one indexed query, no LLM) |
| POST | `/phone/post-call` | ElevenLabs post-call webhook (HMAC verified) → `observations` + `documents.call_transcript` |
| GET | `/health` | Liveness |

The dashboard triggers the agent only by inserting into `observations` (claimant messages,
documents, `approval_ui` decisions) or through the endpoints above. For an approval the dashboard
calls `approvals.decideApproval()` **and** inserts `{source:"approval_ui", kind:"approval_decision",
body:{approvalId, decision, decidedBy, note?}}`. The agent then moves the action.

Claimant observations the loop understands: `kind: "intake"` (from `/control/claims`),
`kind: "message"` `{text}`, `kind: "document"` `{docType, documentId}`, `kind: "task_done"` `{taskId}`.
Outbound messages to the claimant/operator are observations with `source:"system"`,
`kind:"agent_message"|"operator_notice"`, inserted already processed.

### Mock outside systems (`:4000`)

Every write honours `Idempotency-Key` (same key → same stored response, header
`idempotent-replay: true`, never a duplicate). Validation errors (422) are not stored, so the same
key can be retried after a drift fix. Business refusals (409) are stored.

| System | Endpoints |
| --- | --- |
| insurer | `POST /insurer/claims` (FNOL) · `GET /insurer/claims?key=&externalRef=` · `GET /insurer/claims/:claimNo` · `GET /insurer/policies/:policyNumber` (rental limits, deductible) · `POST /insurer/claims/:claimNo/estimates` · `POST …/photos` · `POST …/medical-invoices` · `POST …/settlement/release` · `POST …/settlement/accept` · `POST /insurer/messages` · `GET /insurer/messages?key=` · `GET /insurer/describe` |
| body_shop | `POST /body_shop/bookings` · `GET /body_shop/bookings?key=&claimRef=` · `GET /body_shop/bookings/:id` · `GET /body_shop/bookings/:id/estimate.pdf` · `POST /body_shop/bookings/:id/authorize` · `POST/GET /body_shop/messages` · `GET /body_shop/describe` |
| rental | `POST /rental/reservations` · `GET /rental/reservations?key=&claimRef=` · `GET /rental/reservations/:id` · `POST …/:id/extend` · `POST …/:id/return` (final charge) · `POST/GET /rental/messages` · `GET /rental/describe` |
| clinic | `POST /clinic/visits` (world simulation, called on claim creation when injured) · `GET /clinic/invoices?claimRef=` · `GET /clinic/invoices/:id` · `POST/GET /clinic/messages` · `GET /clinic/describe` |
| chaos | `POST /chaos/rental-drop-next-booking` · `POST /chaos/rename-field {system,from,to}` · `POST /chaos/require-step {system:"insurer",step}` · `POST /chaos/insurer-reject-next-invoice {reason}` · `POST /chaos/fire-webhooks {count, claimRef?}` · `POST /chaos/rental-webhook-drop-rate {rate}` · `POST /chaos/reset` · `GET /chaos/state` |

Timeline on the simulated clock: adjuster 0.5 day after FNOL; drop-off ≤ 1 day after booking;
estimate (with PDF) 2 days after drop-off; approval 1 day after submission (0.5 after a missing
step arrives); repair 6 days; settlement paid 1 day after acceptance; car released 1 day after it's
ready and paid; clinic invoices on days 2 and 5 of an injured claimant's visit; medical invoices
paid 2 days after receipt; rental paid 1 day after return. Rental webhooks are dropped 50% of the
time on purpose, so the agent depends on read-back.

## Code map

| Path | What |
| --- | --- |
| `src/mocks/` | The four systems + chaos (`server.ts`), state (`state.ts`), PDF (`pdf.ts`) |
| `src/executor/` | `adapters.ts`: per system/kind, request builder + read-back of `expectedEffect`. `index.ts`: `assertExecutable` (the gate check, code), `execute`, `retry` (same key), `readBack`, payload mapping via the latest `system_profiles` version, `system_health` recording |
| `src/worker/loop.ts` | The 10 steps, one function each (`[CLM-1042] step 3 verify …`) |
| `src/worker/handlers.ts` | Per-task planners (payload + `expectedEffect`), wait-task read-only proof checks, confirmation effects, T18 reconciliation |
| `src/worker/observe.ts` | Step 3: due timers, new observations (matched to actions by idempotency key → `matchedActionId`), read-backs |
| `src/worker/outcomes.ts` | Verify/retry policy (3 same-key retries, then the operator gate), confirmation, outcome → subflow |
| `src/worker/decisions.ts` | Human decisions on approvals (approve → `approved`; decline → `cancelled` + back to step 5) |
| `src/worker/wake.ts`, `main.ts` | Change stream + resume token, timer loop, lease sweeper, heartbeat |
| `src/subflows/` | `drift.ts`, `rejection.ts`, `recovery.ts`; each ends with `recordExperience` |
| `src/phone/` | `routes.ts` (initiation + post-call), `hmac.ts`, `handleCall.ts` (read-only treatment of what callers say) |
| `src/llm/` | `client.ts` (one structured call path), `prompts.ts` (stable cached system prompt), `jobs.ts` (the 8 jobs) |
| `src/control/` | `server.ts` (:4100), `supervisor.ts` |
| `scripts/` | Demo scenes |
| `docs/elevenlabs-setup.md` | Twilio import, initiation + post-call webhooks, HMAC, data collection, voice agent prompt |

## How the design maps to code

**Task graph.** `src/worker/taskGraph.ts` seeds T1–T18. T13/T14 are created per clinic invoice
(`T13#INV-x`, `T14#INV-x`, own keys) and wired into `T18.dependsOn`. T12 depends on T5 in the
graph, acts only after its `rental_expiring` timer fires (2 days before the rental end while T11
isn't confirmed), re-arms after each extension, and resolves when T11 proves the car is ready.
Days beyond coverage are a claimant gate. Inserted tasks (e.g. `T9a#photos` from drift, the
`:fact` tasks from rejection) are added to the blocked task's `dependsOn`.

**Action lifecycle.** `packages/db/src/actions.ts` (`transitions` / `ACTION_TRANSITIONS`, compare-and-set on the current status, `history[]`).
`sent → confirmed` is allowed (a webhook triggers the read-back before the response is handled).
A retry reuses the key and goes through the shared state machine's `failed -> sent` (an unproven
`sent`/`acknowledged` action is parked as `failed` with a note, then resent); a validation error also
parks the action as `failed` until the drift subflow fixes the mapping. Rejected is terminal; the rejection subflow's corrected action gets a new key
(`…:2`) and `supersedes` the old one. The executor writes `sent` before the HTTP call (outbox), so a
crash mid-call leaves an action recovery will read back.

**Gates** (`assertExecutable`, executor). The doc's six: `accept_settlement`, `sign_release`,
`discuss_fault` (FNOL text with a fault statement), `rental_overage`,
`drift_mapping`, `unverified_after_retries`. Three more approval kinds the doc describes:
`decision_request` (phone), `reconciliation_gap` (T18 → operator), `llm_review` (malformed, refused
or low-confidence LLM output → operator, nothing else written). A claimant gate that waits 1 claim
day gets a `claimant_reminder` timer. For `unverified_after_retries`, approve = closed by a human,
decline = cancelled and re-planned with a new key.

**Timers.** `verify_action` (read-back after the ack), `chase_party` (3 days; read back first in
case the webhook was dropped, then an LLM-written follow-up sent as a normal idempotent action,
escalation after the second), `rental_expiring`, `payment_overdue` (10 days), `claimant_reminder`
(1 day), `promise_check` (phone). All are cancelled when their task is confirmed.

**LLM** (`src/llm`). Official `@anthropic-ai/sdk`, `client.beta.messages.create` with model
`LLM_MODEL` (default `claude-haiku-5-5`), `thinking: {type: "adaptive"}`, explicit `output_config.effort` (`medium`, or
`low` for summaries, follow-ups and task ordering), `output_config.format` JSON schema (from zod).
Server-side refusal fallbacks (`betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`)
are sent only for models that have them (Opus 5/5.5, Fable 5.x, Sonnet 5.5); Haiku 5.5 has none, so a
refusal there goes straight to an operator approval.
`stop_reason` (including `refusal` and `max_tokens`) is checked before content is read, then
`JSON.parse` + zod `safeParse`. No prefill, no forced `tool_choice`. The one system prompt is stable
and carries `cache_control`, and each job's instructions go in the user turn, so every job shares
the cached prefix. The jobs: `extractAccidentDetails`, `interpretInboundMessage`,
`classifyRejection`, `proposeFieldMapping`, `writeFollowUp`, `summarizeClaim`, `pickNextTask`,
`interpretCall`. `pickNextTask` output is checked against the ready set in code. The summary is
capped at 2k chars by the validator.

**Money.** `claims.money.items[]` (`itemId` = `estimate:…`, `invoice:…`, `rental:…`; `kind` estimate or
invoice; `reason` explains a gap). `money.totals` (`recomputeMoneyTotals`) and `reconcileMoney` are
aggregation pipelines in `packages/db`. Gap reasons come from code
(policy deductible from the insurer's offer, claimant-approved days beyond coverage, an insurer
denial). Unexplained gaps go to an operator.

## Known limits

- Every scene passes both in stub mode and live on `claude-haiku-5-5`. Live, the model reads the
  demo intake ("a pickup truck rear-ended me") as a statement about fault, so FNOL waits for the
  claimant's `discuss_fault` gate; the demo scripts play the claimant and approve it. Live drift
  proposals for the new photos step come in around 0.7 confidence, so they go to an operator
  (`drift_mapping`) instead of auto-applying; the drift scene approves them as the operator.
- Each loop iteration that changed something rewrites the compact summary with one LLM call (~3 s on
  Haiku), so live scenes run 2-3x slower than in stub mode.
- Prompt caching works on Haiku 5.5: the shared system prompt plus schema is read from cache on
  every call (about 1.3–1.9k cached tokens per call in the live logs, `usage.cache_read_input_tokens`).
- Atlas Vector/Atlas Search are exercised only through the local fallbacks unless `MONGODB_URI`
  points at Atlas and `pnpm db:setup` has created the 3 search indexes.
- The mock systems keep their state in `.data/mocks.json`. `POST /chaos/reset` wipes it (the demo
  scripts do this).
