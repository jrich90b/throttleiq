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

### Outcome-audit detection feed cron (Phase 2/2.5, LIVE on americanharley 2026-06-25)
The unified anomaly feed (Layer 1) refreshes daily, read-only, into `reports/outcome_audit/latest.json`:

```
# 8:50 AM ET — unified outcome-audit detection feed (state + comprehension + feedback)
50 8 * * * /bin/bash -lc "cd /home/ubuntu/leadrider-api/americanharley && CONVERSATIONS_DB_PATH=/home/ubuntu/leadrider-runtime/americanharley/data/conversations.json REPORT_ROOT=/home/ubuntu/leadrider-runtime/americanharley/reports npm run conversation_outcome_audit >> /home/ubuntu/leadrider-runtime/americanharley/reports/outcome_audit_cron.log 2>&1"
```

It reads the store FILE directly (the store module hydrates async, so a sync accessor read would race
it) and never mutates anything. A healthy store ⇒ 0 anomalies; `byCategory` (state/comprehension/feedback)
and the per-dimension `healed` flag let DETECT route each by tier. The cron repo is kept at HEAD by
`deploy:api` (or a manual `git pull --ff-only`) so it always runs the latest detectors. For dealer #2,
point the same cron at that dealer's runtime store.

### Open-critic sweep cron (Net 3, unknown-unknowns) — runs BETWEEN the feed and DETECT
The open-ended critic (Net 3) refreshes its sibling feed `reports/open_critic/latest.json` a couple of
minutes after the deterministic feed and BEFORE DETECT, so DETECT merges it. UNLIKE the deterministic
sweep, this one is LLM-backed, so its cron MUST load the OpenAI key (source the runtime env file):

```
# 8:52 AM ET — open-ended critic over recent convs → discovery findings (needs OPENAI_API_KEY)
52 8 * * * /bin/bash -lc "cd /home/ubuntu/leadrider-api/americanharley && set -a; . /home/ubuntu/leadrider-runtime/americanharley/api.env; set +a; CONVERSATIONS_DB_PATH=/home/ubuntu/leadrider-runtime/americanharley/data/conversations.json REPORT_ROOT=/home/ubuntu/leadrider-runtime/americanharley/reports npm run open_critic_sweep >> /home/ubuntu/leadrider-runtime/americanharley/reports/open_critic_cron.log 2>&1"
```

Conservative + capped (OPEN_CRITIC_MAX, OPEN_CRITIC_WINDOW_DAYS); kill with LLM_OPEN_CRITIC_ENABLED=0.
Findings are category=`discovery` → DETECT escalates them (Tier 2, notify, never auto-merge).

### Anomaly-loop DETECT → CLASSIFY cron (Phase 3, LIVE on americanharley 2026-06-25)
Five minutes after the feed refreshes, classify it into a tier-tagged WORK ORDER (`reports/anomaly_loop/
next.json`) via `classifyOutcomeAnomaly` (the tier contract as code). It also MERGES the Net 3
`reports/open_critic/latest.json` sibling feed when present. Read-only; nothing auto-merges —
graduated autonomy starts every work order at PR + (when behavioral) notify.

```
# 8:55 AM ET — classify the feed into a tier-tagged work order (DETECT → CLASSIFY)
55 8 * * * /bin/bash -lc "cd /home/ubuntu/leadrider-api/americanharley && REPORT_ROOT=/home/ubuntu/leadrider-runtime/americanharley/reports npm run anomaly_loop_detect >> /home/ubuntu/leadrider-runtime/americanharley/reports/anomaly_loop_cron.log 2>&1"
```

`next.json` carries `stop:true` when healthy, else the ranked work orders (Tier 2 first), each with its
action (parser_fix_candidate / add_invariant_or_heal / redraft_or_diagnose / heal_regression / escalate),
`notify`, and `autoMergeEligible` (from the category ledger). **ACT** = the orchestrator/runner (the
"Unattended operation" section) consumes `next.json`, runs PLAN→BUILD→VERIFY, and opens a PR — auto-merging
only categories the ledger has graduated; everything behavioral notifies Joe. Wiring the scheduled runner
to read `next.json` (alongside `auto_loop/next_task.json`) is the remaining ACT integration.

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

---

## The self-healing program (Joe, 2026-06-25): detect every aspect, auto-patch the safe tier, escalate the rest

Goal: Joe stops being the monitor. The system watches itself across **every aspect of a turn**, diagnoses
gaps, and either auto-patches them (gated) or hands Joe a ready decision — while pushing de-tangle and
commercial-grade reliability. Autonomy is **graduated/earned**, not day-one full-auto (graduated posture
chosen 2026-06-25). Build order chosen: **law first, then detection, then close the loop.**

### Layer 1 — per-turn OUTCOME auditor (the detection feed)
Today the live judges only grade the *reply* (draft-quality / no-response / context-fidelity / cadence-
quality). Extend that to **every side-effect of every turn**, each as a structured "did we do the right
thing?" verdict, logged as an anomaly when not (shadow; never blocks a turn):
- reply correctness + tone (in-charter) + fabrication/safety
- task: created when it should be, NOT created when it shouldn't, closed correctly
- inventory watch: created/triggered/opted-out correctly
- follow-up cadence: right kind (standard/long_term/post_sale/engaged) + right timing + not running while held/handed-off
- ADF/email intake: routed to the right department/bucket; initial first-touch fired (right channel)
- appointment: booked vs deflected correctly; confirmed only with a real `bookedEventId`
- sticky/held state: still valid for this turn (no stale service/handoff/closed contradictions)
- live/regen parity: the two paths agree
This feed replaces Joe watching. It unifies the scattered nightly audits + the agent-watch sweep + the
closed-loop 👎 feed into ONE anomaly store the loop consumes.

**Why Joe was still catching gaps, and the fix (three nets).** A gap is auto-catchable ONLY if something
emits a machine-readable "this was wrong" signal. There are exactly three sources: (a) the model
critiquing itself (LLM judges), (b) a human acting (👎 / edit / takeover), (c) a deterministic invariant.
The feed already wired (c) and the 👎 half of (b). The Elizabeth Klapa ADF misroute slipped through
because her bad draft wasn't *held* and Joe corrected it *manually* (no 👎). The two highest-value unwired
signals already EXIST as computed-but-unfed data — so we wire them:
- **Net 1 (DONE) — proactive: context-fidelity SHADOW verdict → feed.** The scorer already runs on every
  reply draft in shadow and knows when it's out of context (wrong_lead_type / over_attached_model /
  stale_intent / dropped_anchor). That verdict went only to the in-memory decision trace (ephemeral). Now
  `publishCustomerReplyDraft` PERSISTS a MAJOR would-hold on the conversation (`conv.contextFidelityShadow`),
  and `auditConversationOutcome` emits `context_fidelity_shadow_unresolved` (comprehension, P2) when no
  corrective reply followed. Catches the out-of-context class AT DRAFT TIME, before a human sees it.
  Detection only — the draft still publishes exactly as before. A passing/operator draft clears it; the
  detector treats a DIFFERENT reply after the flag as resolved. Pinned by `conversation_outcome_audit:eval`.
- **Net 2 (DONE) — backstop: human edit-corrections → feed.** When staff EDIT the AI draft before sending
  (`finalizeDraftAsSent` records `originalDraftBody` ≠ sent), the send path fires a fire-and-forget typed
  LLM diff-judge (`classifyDraftEditWithLLM`, material vs cosmetic — comprehend, not the old regex
  edit-labeler). A MATERIAL correction (intent / facts / lead-type / context changed, conf ≥ 0.6) is
  persisted on `conv.humanCorrection`; cosmetic edits (voice/length/formatting) are dropped. The read-only
  sweep emits `human_correction_material` (comprehension P2, recent ≤ 21d) → parser_fix_candidate (Tier 1,
  notify). The strongest "the agent was wrong here" signal — a human already corrected it — turned into the
  loop's parser-fix input. Wired at both successful send sites (email + twilio); never blocks a send. Pinned
  by `conversation_outcome_audit:eval`. (Follow-on: a material correction the scorer DIDN'T flag is also a
  signal to add a context-fidelity fixture — Net 2 self-improves Net 1.)
- **Net 3 (DONE) — unknown-unknowns: open-ended critic (CROSS-MODEL).** `critiqueConversationHandlingWithLLM`
  reads a recent conversation with NO fixed checklist and decides whether the agent mishandled the lead in
  ANY way, NAMING the issue class itself (`issue_class` is free-form) — that's how a brand-new gap class
  surfaces. The critic runs on **Claude (a different model lineage than the OpenAI generator)** by default,
  because a model is systematically blind to errors rooted in its own understanding — a cross-model judge
  catches what OpenAI misses. Claude via raw fetch + tool-use (`requestStructuredJsonAnthropic`, no SDK);
  auto-falls back to OpenAI when `ANTHROPIC_API_KEY` is unset or `LLM_OPEN_CRITIC_PROVIDER=openai`, and on
  any Claude error (so it's safe to ship before the key lands and a Claude outage never blinds Net 3). The
  open-critic cron must therefore have `ANTHROPIC_API_KEY` in the env it sources (the runtime api.env).
  Model: `ANTHROPIC_OPEN_CRITIC_MODEL || ANTHROPIC_MODEL || claude-sonnet-4-6`.
  `scripts/open_critic_sweep.ts` runs it over RECENT convs (deterministic prefilter: open, ≤ OPEN_CRITIC_
  WINDOW_DAYS=2 days, has a customer msg + a real reply; capped at OPEN_CRITIC_MAX=40), keeps only CLEAR
  MAJOR conf≥0.8 findings (`decideOpenCriticAnomaly`), and writes `reports/open_critic/latest.json` in the
  OutcomeAnomaly shape (category=`discovery`). `anomaly_loop_detect` MERGES that sibling feed; the
  classifier ALWAYS escalates `discovery` (Tier 2, notify, never auto-merge — the class is unconfirmed).
  A confirmed discovery then earns a real detector + eval (and, if it's an out-of-context type, a
  context-fidelity fixture — so Net 3 feeds Nets 1-2). Conservative + capped (the noisiest net). Pinned by
  `conversation_outcome_audit:eval` + `anomaly_classifier:eval`. Kill: LLM_OPEN_CRITIC_ENABLED=0.

Honest limit: a residual (a novel class the model can't flag AND no human touches) never fully reaches
zero, but Net 3 shrinks it and each instance permanently teaches the loop instead of relying on Joe.

### Layer 2 — DECIDE: the auto-patch tier contract (graduated)
For each confirmed, de-duplicated gap the loop routes by tier (the AGENTS.md "Autonomous Self-Healing
Loop" law is the binding short form; this is the working detail):

- **Tier 0 — deterministic invariant** → already auto-healed by the 60s reconcile tick. The loop only
  ADDS a new heal (that addition is itself Tier 1).
- **Tier 1 — SAFE AUTO-PATCH** (eligible for auto-merge+deploy once the category has graduated):
  - additive parser few-shot / replay fixture — must NOT change an already-accepted case (verified by
    re-running the parser eval on the prior fixtures: all still pass).
  - a new reconcile heal whose fail-direction is safe (only ever moves toward contacting / not-closing /
    repairing an invariant), tightly gated against the engine's hold conditions.
  - a fail-safe gate-window tightening (e.g. a max-idle bound) that only narrows over-firing.
  - a behavior-PRESERVING de-tangle extraction/centralization, proven equivalent by ci:eval.
  - test / eval / doc-only changes.
  Gate (all required): tsc + `ci:eval` green + a NEW deterministic eval pinning the repro + (parser/reply)
  a shadow replay over recent live traffic showing no net regression.
- **Tier 2 — ESCALATE (open a PR + notify Joe), never auto-merge:**
  new customer-facing behavior, a routing cutover, a new reply class, a flag shadow→enforce flip, ANY
  change to an already-accepted parser/decision case, or any "what should it say / do" judgment call.
  **Conservative default: unsure ⇒ Tier 2.** The PR carries the repro + shadow data + before/after.
- **De-tangle is an optimization constraint, not just a hope:** a patch that would add an inline
  `parser || regex` precedence gate is Tier 2 by construction; the loop prefers extending a `decide*Turn`
  reducer or a typed parser. Source-string `assert.match` guards are a smell — prefer a behavioral eval on
  an extracted pure decision (the 2026-06-25 confirm-booking extraction is the template).

### Graduated-autonomy ladder (how a category EARNS auto-merge)
Each Tier-1 **category** (e.g. "additive scheduling-parser fixture", "new state-invariant reconcile heal")
climbs:
1. **Shadow/PR** — loop writes the patch, runs all gates, opens a PR, notifies. Human merges. (default for
   a new category.)
2. **Auto-merge** — after ≥5 consecutive clean human-approved merges in that category with zero
   post-deploy rollbacks, the loop may auto-merge+deploy that category on a green gate. Track the per-
   category record in `reports/auto_loop/category_ledger.json`.
A post-deploy rollback in any category demotes it to step 1. `ci:eval` green is non-negotiable at every step.

### Law compliance — re-read every iteration AND encode it as gates
Two layers; the second is the real guarantee:
1. **Mandatory re-read (intent):** every loop iteration MUST re-read `CLAUDE.md` + `AGENTS.md` (and the
   section nearest the gap) in its PLAN block before proposing a patch — non-skippable. This carries the
   JUDGMENT rules that can't be unit-tested: the de-tangle direction, the fail-direction test, "prefer a
   `decide*Turn` reducer/parser over a new inline gate", the tier classification itself. (In supervised
   sessions a `UserPromptSubmit` hook already injects Rule 0 every turn.)
2. **Deterministic gates (enforcement):** an LLM can re-read the law and still misjudge, so the load-
   bearing rules are encoded as checks that run REGARDLESS of what the agent understood, and a violating
   patch cannot merge: the `twilio_comprehension_debt` ratchet (no new comprehension regex), the
   `eval_suite_manifest` guard (every behavior change has an eval), the decision-table + parity evals
   (centralized, both paths), and the non-negotiable `tsc` + `ci:eval`. **The .md is the spec; the gate is
   the enforcement.**
   - Hardening backlog (convert prose law → gate, so autonomy doesn't rely on the model obeying prose):
     extend the comprehension-debt ratchet beyond the twilio handler (orchestrator + sendgrid), a
     structural lint for "no new inline `parser||regex` precedence gate", a both-paths-parity lint, and a
     pre-commit check for staged-paths-only + the commit trailer. Each converted rule is itself Tier-1 work.

### Consolidation — one loop, one skill (the endgame)
The pieces exist but are fragmented: the reconcile tick (Tier 0), the live reply judges (partial Layer 1),
the nightly comprehension audits, the `agent-watch` skill (Tier-2 PRs), and the closed-loop feedback
(👎→fix). Unify them: ONE skill owns DETECT(all aspects)→CLASSIFY(tier)→ACT(auto-patch | PR+notify),
reusing the existing detection audits + the gate. The `agent-watch` and `customer-reply`/feedback skills
become callers of this contract, not separate policies. Notifications to Joe fire ONLY on Tier 2 (a
behavioral decision) or a hard-stop halt.
