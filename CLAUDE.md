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
   `services/api/src/domain/routeStateReducer.ts` (e.g. `decideSchedulingTurn`), applied in
   BOTH `/webhooks/twilio` and `/conversations/:id/regenerate`, pinned by a decision-table
   eval. Don't add inline `parser||regex` precedence gates.
5. **Parser-first in both paths.** Live and regenerate must stay in sync.

## Current direction — the de-tangle program
Goal: untangle inline `parser||regex` in `index.ts` and shrink the ~10 LLM
round-trips/turn. Per cluster, in order: **centralize the route decision → burn down
fail-safe regex fallbacks (ratchet `twilio_comprehension_debt:eval`, currently 38) →
consolidate parsers (shadow-compared)**. Endgame = one `TurnUnderstanding` pass — see
`docs/comprehension_consolidation_plan.md`. Done: scheduling cluster. Next: finance/pricing.
Do NOT rush parser consolidation — it changes LLM behavior; make it evidence-led.

## Before you ship
- Gates (must be green): `(cd services/api && node ../../node_modules/typescript/bin/tsc -p
  tsconfig.json --noEmit)` and `npm run ci:eval`. Every behavior change needs a
  deterministic eval wired into `ci:eval`.
- New customer state/route → typed parser + replay fixture + decision-table eval, in both paths.
- Stage only files you changed (never `git add -A`). Commit trailer:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Push to `main` + deploy are
  eval-gated; fetch first; confirm the push when another author's commit is unpushed locally.

## Where to look, by task
- **Customer messaging / routing / parsers (backend):** `AGENTS.md` (parser-first, route
  centralization, fallback policy, fail-direction) + `services/api/src/domain/` +
  `services/api/src/index.ts`.
- **Frontend / dealer console:** `apps/web` + `AGENTS.md` UI guardrails (contrast; icons
  come from the shared `UiIcon` line-art set, never emoji).
- **Evals / safety net:** `scripts/*_eval.ts`, the `ci:eval` chain in `package.json`.
- **Deploy / ops / the autonomous loop:** `infra/`, `scripts/deploy_api_lightsail.sh`,
  `docs/autonomous_coding_loop.md`.
