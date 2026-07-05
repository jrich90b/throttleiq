# ADR: Don't rebuild the customer runtime on an agent SDK — keep parser-first

- **Date:** 2026-06-20
- **Status:** Accepted
- **Decision owners:** Joe
- **Related:** `comprehension_consolidation_plan.md`, `AGENTS.md` (Route Decision
  Centralization, Parser-First Rule, Fallback Policy), `CLAUDE.md` (de-tangle program)

## Context

The conversation runtime has real, felt complexity: ~10 LLM round-trips per turn,
inline `parser || regex` precedence gates in `services/api/src/index.ts`, and a large
set of typed parsers. The recurring question is whether to adopt an **agent SDK / agent
framework** (model-driven, tool-calling control loop) to manage that complexity.

"Agent SDK" here means the pattern where the LLM is handed a set of tools and decides,
in a loop, which to call next — i.e. **the control flow itself is model-driven**. This is
distinct from "use an LLM for comprehension," which we already do.

## Decision

**Do not move the customer-conversation runtime onto an agent SDK / model-driven tool
loop. Keep the parser-first, centralized-pure-routing, eval-gated architecture.** Use
agent-SDK tooling only where it already fits — the ops/dev side.

## Rationale

1. **It inverts our core invariant.** Route decisions are centralized, **pure, and
   deterministic** (`routeStateReducer.ts`: `decideSchedulingTurn`,
   `decideFinancePricingTurn`), applied identically in `/webhooks/twilio` and
   `/conversations/:id/regenerate`, and pinned by decision-table evals. A model-driven
   tool loop makes control flow non-deterministic by design — the exact failure mode the
   centralization program exists to eliminate (the soil the Todd-Herian bug grew in).

2. **It breaks the safety net.** `ci:eval` + replay fixtures + decision-table evals only
   work because behavior is *pinnable*. You cannot pin an autonomous tool-loop's routing
   with a deterministic decision table. Compliance/safety gates (STOP, suppression, card
   cap, "never confirm a booking without `bookedEventId`") **must** stay deterministic;
   an agent loop adds risk there and buys nothing.

3. **It pushes cost/latency the wrong way.** The stated direction is to *shrink* ~10
   round-trips/turn toward **one `TurnUnderstanding` pass**. Agent loops generally *add*
   round-trips (multi-step tool calling). Wrong vector.

4. **It's the big-bang rewrite we already ruled out.** The consolidation evidence put the
   net win at **~5% of turns, concentrated in model resolution**, and explicitly ruled
   out a broad taxonomy/control-flow rewrite (sub-5% ceiling). Adopting a framework *is*
   that rewrite, with a worse risk profile and a multi-week cost — motion, not progress.

5. **The good idea from that world, we're already taking.** A single structured-output
   call that comprehends the whole turn is exactly `TurnUnderstanding`. We get that
   benefit without importing a framework or its non-determinism.

## What the actual complexity is (and its real cure)

The pain is the **inline `parser || regex` tangle + round-trip count**, not the absence of
a framework. The cure is the de-tangle / consolidation program already in flight:
centralize the route decision per cluster → burn down fail-safe regex fallbacks → collapse
parser sub-calls into one shadow-compared `TurnUnderstanding` pass, shipped behind the
relevance guard (`passesModelRelevanceGuard`). A framework would not touch that tangle.

## Where an agent SDK *does* belong (already adopted)

The **ops/dev tooling** is genuine agent work — multi-step, unknown path, real tool use —
and Claude Code is the agent SDK there. Correct and worth expanding:
- the morning quality routine, agent-watch, the autonomous coding loop
- MDF portal automation, deploy/ops loops

## The one bounded experiment we'd entertain (approve-first)

Let the **drafting/generation layer** use tool calls **for information gathering only** —
check live inventory, pull current pricing, check calendar availability — while routing,
state transitions, and compliance stay deterministic in the reducer. Tools answer "what is
true"; the reducer still decides "what to do." This is contained and reversible. It is
**approve-first** and gated on customer-facing correctness, not a wholesale SDK adoption,
and would not ship without its own evals.

## Consequences

- The runtime stays parser-first; new customer states continue to follow the Parser-First
  Rule (typed parser → centralized decision → both paths → fixtures + decision-table eval).
- Complexity reduction comes from consolidation to one `TurnUnderstanding` pass, not from
  a framework swap.
- Revisit only if a future need appears that is genuinely open-ended/unknown-path on the
  *customer* turn (none today) — and even then, prefer the bounded info-gathering-tools
  experiment over model-driven routing.
