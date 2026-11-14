# apps/dashboard — see what actually happened, and drive the agent

Next.js 16 (App Router) + React 19 + Tailwind 4 + React Flow, on **:3000**. It reads MongoDB only
through `@claim-coordinator/db` (server-side), and triggers the agent only by:

1. inserting `observations` (claimant messages, uploaded photos, `approval_ui` decisions),
2. calling the agent control API on **:4100** (`/control/claims`, `/control/kill-worker`, `/control/start-worker`, `/control/status`),
3. calling the mock systems' chaos endpoints on **:4000** (the demo panel).

It never calls an outside system or the LLM, and never sets a task's or an action's status. An
approval decision updates the approval document (`decideApproval`: who and when) **and** inserts an
`approval_ui` observation; the agent then moves the action.

## Run it

```bash
# repo root, with .env set (MONGODB_URI, MONGODB_DB, VOYAGE_API_KEY, ELEVENLABS_WEBHOOK_SECRET)
pnpm agent:dev                    # mocks :4000 + control :4100 + worker(s)
pnpm --filter dashboard dev       # builds packages/db, then the dashboard on :3000
```

Open `http://localhost:3000`. The claimant flow starts at **/new**; the operator console is **/ops**;
**Start demo claim** in the bottom panel files a seeded claim and jumps to it.

Don't run Soham's Express prototype (`npm start`) at the same time: it also uses :3000.

## Live updates (no polling from the browser)

`GET /api/stream?claimId=…` is Server-Sent Events. The server opens one MongoDB change stream
(`watchDashboardChanges`, filtered on collection names for M0: claims, tasks, actions,
observations, approvals, timers, leases) and pushes `change` events; the page refetches its
snapshot (`/api/claims/[id]`, debounced 250 ms). Agent status is fetched from `:4100/control/status`
**on the server** every 2 s and pushed as `status`. Every time is shown in simulated claim time
("Day 4, 14:00", from the package's cached `nowSync()`), with wall time on hover.

## Screens → design doc sections

| Screen region | What it shows | Design doc section |
| --- | --- | --- |
| **/new** intake form | date, place, other driver, policy number, police report, photos (GridFS) + "tell us what happened" | Task graph (T1), Phone calls → contacts |
| **/claim/[id]** Needs your decision | pending claimant gates with what they cost or give up, Approve/Decline, "Reminder sent" when a `claimant_reminder` fired | Human approval gates; Timers and events |
| **/claim/[id]** Progress | Intake → Repair / Rental / Medical in parallel → Close; Done (proven) / Waiting on … / Needs you / Blocked | Claim lifecycle |
| **/claim/[id]** Messages | claimant messages (→ `claimant` observations), agent replies, reminders, post-call summaries | Timers (claimant hasn't answered), Phone calls |
| **/claim/[id]** Calls | caller, trust, verified vs "claimed, not confirmed", red fraud alert for payment-detail changes | Phone calls (inbound only) |
| **/claim/[id]** Money | billed / submitted / paid per item from `reconcileMoney`; gap reasons | LLM vs code (money reconciliation), T18 |
| **/ops** Claims | phase, tasks done, open gates, unconfirmed actions, lease holder | Data touched (claims, leases) |
| **/ops** Agent | workers alive/dead, held leases, resume-token time, events replayed from the token | The agent loop; Crash recovery |
| **/ops** System health | per-system latency sparkline with error dots, error rate | Data touched (`system_health` time series) |
| **/ops** What the agent has learned | searchable `experiences` | Subflows (each ends by recording an experience) |
| **/ops/claim/[id]** Task graph | T1–T18 + per-invoice copies + inserted tasks as a DAG (React Flow), coloured by status, dashed + pulsing when inserted by a subflow | Task graph; Drift (new task before T9) |
| **/ops/claim/[id]** Action timeline | stepper planned → sent → **acknowledged** (hollow amber, "not proof") → **confirmed** (solid green, "proven"); side states; "↻ n sends · same key"; `supersedes` links; click for payload, expectedEffect, key, attempts, full `history[]` | Action lifecycle; Proof, not responses |
| **/ops/claim/[id]** Observations | live feed filterable by source; trust badge + "claimed, not confirmed" for calls; unprocessed marker | Timers and events (wake-up sources) |
| **/ops/claim/[id]** Approvals | operator gates; drift shows old → new field, Vector Search matches with scores, LLM confidence vs threshold, similar experiences; toasts for new approvals | Human approval gates; Drift |
| **/ops/claim/[id]** Timers | upcoming (countdown in sim time) and fired | Timers and events |
| **/ops/claim/[id]** Summary | the agent's `compactSummary` (all it reloads after a crash) | State lives in MongoDB, not in the prompt |
| Demo / chaos panel (bottom drawer) | one button per scene with what to watch for; fast-forward +1/+10/+30 days; clock speed; Reset demo | Demo mapping |

## Demo panel

| Button | Calls | Watch for |
| --- | --- | --- |
| Start demo claim | `POST :4100/control/claims` (seeded data) | T1–T6 actions go sent → confirmed |
| Rental drops next booking | `POST :4000/chaos/rental-drop-next-booking` | T5 at acknowledged, read-back fails, same-key retry confirms |
| Kill agent | `POST :4100/control/kill-worker` | Worker shows dead; timeline freezes |
| Fire 3 webhooks | `POST :4000/chaos/fire-webhooks {count:3}` | Observations pile up unprocessed |
| Restart agent | `POST :4100/control/start-worker` | Recovery processes all 3; nothing resent |
| Rename policyNumber | `POST :4000/chaos/rename-field` | A task goes blocked_drift; mapping applied or sent for approval |
| Require photos | `POST :4000/chaos/require-step` | A new task appears before T9 |
| Reject next invoice | `POST :4000/chaos/insurer-reject-next-invoice` | Rejection subflow, new key, `supersedes` link |
| Simulate inbound call | signed payload → `POST :4100/phone/post-call` | "Approved" claimed, portal pending, shown unverified |
| Call: change bank details | signed payload → `POST :4100/phone/post-call` | Never acted on; red fraud alert |
| Fast-forward | `advance()` in `@claim-coordinator/db` | Timers fire, T15 gate, T18 reconciliation |

**Reset demo** (behind a confirm dialog) calls `resetDemoData()` + `POST :4000/chaos/reset`. It is
deliberately **not** `db:reset`, which would drop the whole shared database including the 3 Atlas
Search indexes. It keeps the seeded `CLM-1042`, seed data and worker resume tokens.

## Design

Dark by default for the projector, with a light toggle (top right). Status colours: confirmed =
green, acknowledged = amber, sent = blue, rejected/failed = red, awaiting approval = purple. Every
colour is paired with an icon and a label. The claim detail is one screen: graph on top, the
action timeline and tabs below, the demo panel docked at the bottom, approvals as toasts that open a
dialog. The claimant view works at phone width.

## Verified

All scenes were clicked through in headless Chrome against a running agent with live updates and no
page refresh: start claim (T1–T6 confirmed), ghost booking (2 sends, same key), drift (operator
approved the mapping from the review dialog; `T9a#photos` inserted), inbound call (stored
unverified), bank-change call (fraud alert), kill → 3 webhooks → restart (all processed, 0 re-sends),
rejected invoice (new key with `supersedes`), and close (claimant approvals, operator explained a
rental gap, fast-forward to T18).
