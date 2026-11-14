# Claim Coordinator Agent Demo

This project turns the workflow design for a claim-coordination agent into a working local proof-of-concept. It models the claim lifecycle, action-state tracking, evidence-based task completion, and the review gates described in the workflow.

## What is included

- A lightweight Node.js + Express API that stores claims in memory.
- A task graph that mirrors the mock claim lifecycle from intake through close.
- Action-state tracking so a task is only considered done after the required proof is recorded.
- A simulation UI for the main workflow events and human approval gate.
- A test suite covering the happy path to a closed claim.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000 to view the dashboard.

## Useful workflow events

The UI exposes a set of demo events that move the claim through the lifecycle:

- Claim filed
- Insurer opened
- Rental covered
- Rental booked
- Body shop booked
- Estimate arrived
- Estimate submitted
- Estimate approved
- Repair authorized
- Repair ready
- Rental extended
- Medical invoice
- Medical paid
- Settlement offer
- Approve settlement
- Rental returned
- Reconcile and close

## Validate

```bash
npm test
```

## Workspace packages

The repo is also a pnpm workspace (`pnpm install` at the root):

- `packages/db` (`@claim-coordinator/db`): the MongoDB data layer. Run `pnpm db:setup`, `pnpm db:seed`, `pnpm db:smoke`. See `packages/db/README.md`.
- `apps/dashboard`: the web UI on `:3000`. Claimants start a claim and follow it; operators watch the task graph and action timeline, decide approvals and run the demo panel. Run `pnpm --filter dashboard dev` next to `pnpm agent:dev`. See `apps/dashboard/README.md`.
- `apps/agent`: the Claim Coordinator agent. It has mock insurer/body shop/rental/clinic systems on `:4000` and the control API, webhooks and phone line on `:4100`, plus the supervised workers. Run `pnpm agent:dev`. See `apps/agent/README.md` for endpoints and the demo scenes (`pnpm --filter agent demo:all`).

The Express prototype above (`npm start`) is separate from those and keeps its state in memory. It also uses `:3000`, so don't run it alongside the dashboard.
