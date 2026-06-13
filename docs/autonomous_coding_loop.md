# Autonomous Coding Loop

The missing stage of `docs/self_running_ops_loop.md`. That loop collects
production signals and ranks them into task candidates, then **stops at a human
gate by design**. This loop adds the coding agent that closes it: it takes the
next ranked task and drives it all the way to a verified production deploy,
continuously, until the dealer is "high level usable."

"High level usable" has a concrete definition: every row of
`docs/dealer_ready_checklist.md` is a verified `WORKING`, and the agent-manager
report has no open P0/P1.

## Orchestration

A single orchestrator (Claude Code) conducts each iteration and prompts
specialized agents block to block. The output of each block is the prompt seed
for the next ("the loop prompts the agents").

```
┌─ DETECT ─→ PLAN ─→ BUILD ─→ VERIFY ─→ SHIP ─┐
│                              │ red           │
│                              └──→ BUILD      │   (retry ≤ 2, then HALT)
└──────────────── next iteration ─────────────┘
```

### Block 1 — DETECT (`scripts/auto_loop_next_task.ts`)
Merges `dealer_ready_checklist.md` open rows + the agent-manager report's
P0/P1s, ranks them (P0 → P1 → code-shippable checklist gaps → P2/P3, preferring
work that closes this pass), and writes `reports/auto_loop/next_task.json`. If
nothing is open and the checklist is clean it emits `stop: true` — the loop's
graceful exit. Richer signal comes from a live read-only production sweep
(`ssh lightsail`, conversations.json) for new parser gaps, per the AGENTS.md
sweep convention.

### Block 2 — PLAN (architect agent)
Turns the task into an implementation plan: root-cause hypothesis, exact files,
the parser-first approach (AGENTS.md is law), acceptance criteria, and the eval
fixture to add. Read-only; produces a plan, not edits.

### Block 3 — BUILD (implementer)
Implements the change parser-first in **both** the live `/webhooks/twilio` path
and `/conversations/:id/regenerate`, adds the eval fixture pinning the
production case, and wires it into `ci:eval`.

### Block 4 — VERIFY (gatekeeper, deterministic)
`(cd services/api && node --max-old-space-size=4096 ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit)`
then `npm run ci:eval`. Red → bounce back to BUILD with the failure (≤ 2
retries), then HALT. Never ships on a red gate.

### Block 5 — SHIP (release, deterministic)
Commit → push origin main → `npm run deploy:api` (which backs up runtime data,
checks conversation-store sanity before/after, and health-checks). Then update
`AGENTS.md`, `dealer_ready_checklist.md` evidence, and memory. Re-enter DETECT.

## Hard stops (halt the loop, do not continue unattended)
- `ci:eval` red or `tsc` error after build retries
- conversation-store sanity drop after deploy (count collapses)
- `/health` 502 after deploy retries → auto-rollback, then halt
- DETECT `stop: true` → graceful done; report what shipped + remaining P2/P3

## Standing authorization
Joe authorized eval-gated push + deploy without asking (memory:
`autonomous-execution-authorization`) and, on 2026-06-13, full prod autonomy for
this loop against American Harley. Every deploy is gated on a green `ci:eval`;
that gate is non-negotiable.

## Run
- One DETECT pass: `npm run auto_loop:next`
- The orchestrator (Claude Code session) executes PLAN→SHIP per task and
  self-paces re-entry until DETECT emits `stop: true`.
