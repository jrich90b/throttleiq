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
Merges three sources and ranks them (P0 → P1 → code-shippable gaps → P2/P3,
preferring codeable work that closes this pass), writing
`reports/auto_loop/next_task.json`:
1. `dealer_ready_checklist.md` open rows (non-codeable ops/external-verify rows
   are flagged `codeable:false`).
2. The agent-manager report's P0/P1s.
3. **Continuous-mode fuel**: production agent-quality sweeps. Run the
   deterministic `answer_correctness:audit` (and peers: outcome_qa,
   agent_actions, response_latency) against live data — read-only, ON the
   instance so prod data stays on the box — into `reports/answer_correctness/`;
   DETECT turns each graded check's findings into a codeable reply-quality task
   carrying a real inbound/reply reproduction.

It emits `stop: true` only when **no codeable work remains**. If non-codeable
items are still open (DocuSign/Stripe live verify, ops cutovers) it stops with a
reason naming them — those need the user, not an unattended deploy.

DETECT is **eval-aware** so it never re-fixes a ghost: a sweep over a 30-day
window surfaces replies that predate fixes already shipped. A check whose
canonical case is pinned by an eval in `ci:eval` is treated as guarded (green
gate ⇒ current code is correct) and skipped; a check with no recent finding is
skipped as historical. Both are reported in `skippedSweepChecks`. (2026-06-13:
the first sweep surfaced `owned_bike_offered` and `requested_day_reasked` — both
already fixed and eval-guarded, i.e. stale. The loop correctly shipped nothing.)
Maintain the `GUARDED_CHECK_EVALS` map as new checks gain eval coverage.

Caveat: always set `DATA_DIR` when running audits on the instance, or the
conversation-store module auto-creates a stray empty store in the repo's
`data/` dir (gitignored, but tidy it up). Tiebreak among equal-priority sweep
tasks is currently alphabetical — count/recency weighting is a known TODO.

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
- Fresh-signal sweep + DETECT in one shot: `npm run auto_loop:sweep`
  (`scripts/auto_loop_sweep.ts`) — runs the deterministic answer_correctness
  audit over a tight recent window (default 48h, `SWEEP_WINDOW_HOURS`) against
  the live store, then DETECT, and prints whether the loop has NEW codeable
  work. Read-only; pins `DATA_DIR` to the store's dir so no stray store is
  created.
- One DETECT pass on existing signal: `npm run auto_loop:next`
- The orchestrator (Claude Code session) executes PLAN→SHIP per task and
  self-paces re-entry until DETECT emits `stop: true`.

### Daily sweep cron (per dealer, on the instance)
A tight window is what keeps the loop honest — a 30-day audit buries new
regressions under already-fixed history (iteration 2). Run the sweep daily so a
real regression surfaces within a day:

```
# 8:45 AM ET — fresh agent-quality signal for the autonomous loop
45 8 * * * cd /home/ubuntu/leadrider-api/americanharley && CONVERSATIONS_DB_PATH=/home/ubuntu/leadrider-runtime/americanharley/data/conversations.json REPORT_ROOT=/home/ubuntu/leadrider-runtime/americanharley/reports SWEEP_WINDOW_HOURS=48 npm run auto_loop:sweep >> /home/ubuntu/leadrider-runtime/americanharley/reports/auto_loop_sweep_cron.log 2>&1
```

The loop reads the resulting `reports/auto_loop/next_task.json`: `stop:true`
means nothing new to code; otherwise it carries the next task + a production
repro. For dealer #2, point the same cron at that dealer's runtime store.

### Unattended operation (two parts)
There is no headless coding agent on the instance, and the live data + deploy
access live only on the box — so the loop runs in two complementary halves:

1. **Detection (always-on, server-side):** the instance sweep cron above runs
   daily regardless of anything, refreshing `next_task.json` + a log. Pure,
   read-only — it only generates a work order.
2. **Coding + deploy (when the operator's Claude Code app is open):** a daily
   scheduled task (`~/.claude/scheduled-tasks/throttleiq-loop-runner`, runs at
   ~9:20am local, or on next app launch if closed) runs ONE iteration: fresh
   sweep+DETECT → if a concrete reproducible regression exists, PLAN (sub-agent,
   re-confirms the bug still reproduces on current main) → BUILD → VERIFY
   (tsc + ci:eval). It **auto-deploys only** a small, localized, high-confidence
   fix on a green gate; anything uncertain/large/possibly-stale → branch + PR +
   notify. It never deploys on a red gate and never touches needs-user items.

The common case is a no-op (sweep → `stop:true`), so the runner only does real
work when a genuinely new, unguarded, concrete regression appears.
