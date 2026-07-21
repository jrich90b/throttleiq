# CLAUDE.md — read this before starting ANY task

**Rule 0 (always):** Before starting any task, re-read this file and the rules it points
to. **`AGENTS.md` is law** — when a task touches customer messaging, routing, parsers,
evals, or deploy, read the relevant `AGENTS.md` section before editing. If a rule here and
the code disagree, surface it; don't guess.

## What ThrottleIQ is
LeadRider: a parser-first, hybrid-LLM SaaS that runs Harley dealers' lead conversations
(SMS via Twilio, email via ADF/SendGrid). Monorepo: `services/api` (Node/TS backend + the
inbound handler `index.ts`), `apps/web` (Next.js dealer console), `packages/` (shared),
`scripts/` (the eval harness — our safety net), `infra/` (Lightsail/Vercel deploy).
Persistence: JSON files today, Postgres in dual-write shadow. Prod runs in **suggest
mode** (staff approve every draft).

## How to talk to Joe (communication style — Joe, 2026-07-06)
Joe runs the dealership and is **not a programmer**. Explain everything in plain English,
as if to a smart teenager with zero coding experience:
- Lead with what it means for the business / the agent / his day — not the code.
- No jargon without an instant plain-words translation, e.g. "the parser (the piece that
  reads what the customer meant)" or "CDP (the remote-control connection to Chrome)".
- Prefer everyday phrasing: "the form stays hidden until both dates are filled in," not
  "the selector resolved but failed the visibility check."
- Analogies are good. Short sentences are good.
- File paths, function names, and technical detail go AFTER the plain-English version —
  as supporting detail, never as the explanation itself.
- When Joe has to make a decision, state the choice in plain terms, what each option
  means for him, and your recommendation.
This changes HOW you explain, not WHAT you do — every engineering rule in this file and
AGENTS.md still applies at full strictness.

## The non-negotiables (full detail in AGENTS.md)
1. **Comprehend, never regex.** Customer intent is read by typed LLM parsers
   (`requestStructuredJson` + `*_JSON_SCHEMA`, strict structured outputs), never by
   keyword/regex. Fix a miss with parser few-shots + a replay fixture, not a new regex.
2. **Deterministic only for** compliance/safety gates, structured extraction, side effects
   (close/cadence/todo/state), and invariant guards.
3. **Migrate-vs-keep = the fail-direction test.** A regex whose removal makes us fail
   toward replying / not-closing / doing the side-effect is a safety gate → KEEP it. One
   whose removal makes us fail toward a wrong/silent answer is comprehension → move it to
   the parser. "Keep" is a valid answer; never over-migrate.
4. **Route decisions are centralized + pure.** Cluster precedence lives in
   `services/api/src/domain/routeStateReducer.ts` (e.g. `decideSchedulingTurn`,
   `decideFinancePricingTurn`), applied in
   BOTH `/webhooks/twilio` and `/conversations/:id/regenerate`, pinned by a decision-table
   eval. Don't add inline `parser||regex` precedence gates.
5. **Parser-first in both paths.** Live and regenerate must stay in sync.

## Current direction — the de-tangle program
Goal: untangle inline `parser||regex` in `index.ts` and shrink the ~10 LLM
round-trips/turn. Per cluster, in order: **centralize the route decision → burn down
fail-safe regex fallbacks (ratchet `twilio_comprehension_debt:eval`, currently 35) →
consolidate parsers (shadow-compared)**. Endgame = one `TurnUnderstanding` pass — see
`docs/comprehension_consolidation_plan.md`. Done: scheduling cluster; finance/pricing
pricing-continuation centralized (`decideFinancePricingTurn`, both paths), early-return
guards annotated by fail-direction, AND the regen follow-up trigger aligned to the parser
signal (`resolveFinanceFollowUpContinuation`, both paths, `3332efe8`) — finance/pricing
burn-down candidates were adversarially reclassified KEEP (6/17 architecture map), so the
cluster is effectively de-tangled. **De-tangle status (6/22 loop):** `isNoTradeResponseText`
is already migrated to the trade-qualifier parser (the ratchet was over-counting it via a
stale comment — now comment-aware, 36→35); `isAffordabilityRideConfidenceObjectionText` was
adversarially re-classified **KEEP** (it feeds the fail-unsafe `shouldSuppressDispositionCloseout`
guard — a parsered false negative would wrongfully close a live lead). The cheap fail-safe-regex
burndown is now exhausted: the ratchet sits at/near its **KEEP-floor (35)**. Most of the 35 are
load-bearing KEEPs (safety/side-effect/state gates) or structured-extraction helpers (e.g.
`isTouringRequestText` = model detection feeding a payment calc), which AGENTS.md allows as
deterministic. Further ratchet reduction now requires real **approve-first** work, NOT auto-merge
regex-picking: the ~4 "needs-fixtures" MIGRATE candidates (6/17 map) as typed parsers + replay
fixtures, and trade-cluster route-decision centralization in `routeStateReducer`. The
parser-consolidation round-trip slice is **CUT OVER LIVE on the SMS lane as of 7/14** (PR #204
`a9443b53`, Joe-approved after a 12-day shadow soak: 2,413 records, 99.4% decision-scoped
agreement): `parseUnifiedSemanticSlotsMergedWithLLM` carries the semantic+trade-payoff+
trade-target jobs in ONE call inside the shared wrapper `parseUnifiedSemanticSlotsWithLLM`
(both live + regen paths funnel through it → two-path parity for free), guarded by
`applyMergedWatchRelevanceGuard` (blanks an over-attached watch model the customer didn't
name this turn; eval-pinned). Live behind 3 box flags (`LLM_UNIFIED_SLOT_MERGED_LIVE` +
`LLM_UNIFIED_SLOT_PARSER_ENABLED` + `LLM_UNIFIED_SLOT_ROUTER_ENABLED`); kill switch = zero
them + `npm run deploy:api`. The live shadow comparison was **deliberately burned 7/15**
(PR #209 — verdict banked; a quiet shadow log is correct, NOT a bug). Still on legacy:
the **email/SendGrid lane** (calls `parseSemanticSlotsWithLLM` directly) — its cutover is
the next milestone (**Tier 2 approve-first**, after ~2 clean canary weeks from 7/14), with
the kept `diffUnifiedSlotParse` comparator + the banked shadow corpus as the acceptance
harness. Until then the legacy 3-call path + mirrored legacy prompts + the
`unified_slots_merged_shadow:eval` tripwire stay — the legacy path IS the kill switch;
never burn it while it's the revert.

**Consolidation is evidence-scoped, NOT a big-bang rewrite (880-turn judged backfill).**
The consolidated pass's gross disagreement (~25%) is ~80% LLM *over-attachment* (a thread
model glued onto turns that don't need one — "Thanks Joe" → Breakout); the real net win is
**~5% of turns, concentrated in MODEL resolution** (slang/shorthand: "21 SGS", "tri glides").
So:
- **Any consolidation ships behind a relevance guard** (`passesModelRelevanceGuard`,
  `turnUnderstandingAuthority.ts`) — never act on a model the customer didn't reference this
  turn, or you trade det-misses for a worse over-attachment failure mode.
- Phase 2 is scoped to the **model-resolution slice**: STEP 1 resolver dark (`b8d8b61b`),
  STEP 2 live cutover (`871b306d`, flag `TURN_UNDERSTANDING_MODEL_AUTHORITY=1`) — **canary
  active** (watch `answer_correctness` `owned_bike_offered`=0). The broad taxonomy/clarify/
  slot-fill rewrite is RULED OUT (sub-5% ceiling); gate cutovers on customer-facing
  correctness, not shadow-disagreement.
Make it evidence-led. A core-comprehension cutover is **Tier 2** under the autonomous-loop
auto-patch contract (AGENTS.md "Autonomous Self-Healing Loop") = approve-first: open a PR +
notify, never auto-merge. Eval-gated **Tier 1** work (additive parser fixtures, fail-safe
reconcile heals, behavior-preserving de-tangle refactors) may auto-merge once its category
has graduated — see `docs/autonomous_coding_loop.md`. When unsure which tier, it's Tier 2.

## Before you ship
- Gates (must be green): `(cd services/api && node ../../node_modules/typescript/bin/tsc -p
  tsconfig.json --noEmit)` and `npm run ci:eval`. Every behavior change needs a
  deterministic eval wired into `ci:eval`.
- `npm run ci:eval` needs `OPENAI_API_KEY` (LLM-backed evals). It lives in the gitignored
  `.env` (and `services/api/.env`) — load it before running the gate, e.g.
  `set -a; source .env; set +a`. Never print or commit the key; `.env` stays untracked.
- New customer state/route → typed parser + replay fixture + decision-table eval, in both paths.
- Stage only files you changed (never `git add -A`). Commit trailer:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Push to `main` and `npm run deploy:api` are PRE-AUTHORIZED (Joe, 2026-06-15; supersedes
  the old "confirm every push" rule): once both gates above are green, push and deploy
  eval-gated work without asking each time. Still required: `git fetch` first; do the work
  on a branch off `main`; and if another author's commit is unpushed locally, note it in
  your summary (surface it, don't block on it). (This is the SUPERVISED-session rule — you,
  working with Joe. The UNSUPERVISED self-healing loop is narrower: it auto-merges only
  graduated **Tier 1** changes and escalates **Tier 2** — AGENTS.md "Autonomous Self-Healing
  Loop" + `docs/autonomous_coding_loop.md`. A behavioral cutover is Tier 2 in either mode.)
- **DEPLOY THE API ONLY VIA `npm run deploy:api` — NEVER `bash scripts/deploy_api_lightsail.sh`
  raw (footgun, hit 2026-06-16).** The npm script passes
  `--profile infra/deploy/americanharley.api.env(.example)`, which sets the dealer's repo dir
  (`/home/ubuntu/leadrider-api/americanharley`), `DEPLOY_DATA_DIR` (the americanharley store),
  the runtime `DEPLOY_ENV_FILE`, and the safety rails (`DEPLOY_EXPECTED_DATA_DIR`,
  `DEPLOY_MIN_CONVERSATIONS`, `DEPLOY_REQUIRED_CONVERSATION_TEXT`). Run the script **without a
  profile** and it silently defaults to the BASE data dir (`/home/ubuntu/throttleiq-runtime/data`)
  and `pm2 restart --update-env` repoints the LIVE americanharley API at the wrong store (it
  served the base 471-conv store instead of the 562-conv one until restored from
  `~/.pm2/dump.pm2.bak`). The americanharley API runs from `/home/ubuntu/leadrider-api/americanharley`
  (NOT `/home/ubuntu/throttleiq`, which is the base checkout). See the `deploy-api-needs-profile-flag`
  memory for the recovery runbook.
- **Web deploys (`npm run deploy:web` / `deploy_web_lightsail.sh`) change Next.js Server Action
  IDs.** Any console tab open from before the deploy will fail regenerate/actions with "Failed to
  find Server Action" until the user HARD-REFRESHES (Cmd/Ctrl+Shift+R). Tell the user to refresh
  after a web deploy; the API is unaffected. Only redeploy web when a web change actually ships.

## Where to look, by task
- **Customer messaging / routing / parsers (backend):** `AGENTS.md` (parser-first, route
  centralization, fallback policy, fail-direction) + `services/api/src/domain/` +
  `services/api/src/index.ts`.
- **Frontend / dealer console:** `apps/web` + `AGENTS.md` UI guardrails (contrast; icons
  come from the shared `UiIcon` line-art set, never emoji).
- **Evals / safety net:** `scripts/*_eval.ts`, the `ci:eval` chain in `package.json`.
- **Deploy / ops / the autonomous loop:** `infra/`, `scripts/deploy_api_lightsail.sh`,
  `docs/autonomous_coding_loop.md`.
