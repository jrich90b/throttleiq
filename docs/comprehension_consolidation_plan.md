# Comprehension Consolidation Plan

**Author:** generated 2026-06-13 · **Status:** proposed · **Owner:** Joe

## The problem, stated precisely

Every recurring agent miss this week failed in the same layer: a **deterministic
regex/lexicon trying to comprehend messy human language**, in turn 1–3, not a
long-context drift.

| Customer | What they said | What broke | Layer |
|---|---|---|---|
| Chuck Bailey | "Street Gide Limited" | typo + multi-model dedupe | model extraction (regex) |
| Dominik Roehre | "June 20th event, that day" | date parser only knew weekdays | date extraction (regex) |
| Al Davis | "Afternoon would be great" | day-part didn't carry prior day | scheduling (regex) |
| Todd Herian | "my current ultra limited" | owned bike read as request, then **anchored** in stored state | model extraction + state poisoning |
| (multiple) | "around 10am" | approximate round-hour dropped | time parser (regex) |

Two structural faults, both fixable by one architectural move:

1. **Comprehension is done with the wrong tool.** Pattern-matching cannot keep
   up with the infinite variety of human phrasing. We add a regex per customer
   phrasing — "patch forever."
2. **Comprehension is duplicated across many handlers.** `findMentionedModels`,
   `parseRequestedDayTime`, the availability selector, the test-ride selector
   each re-derive intent independently (Todd's "two doorways"). Fix one, another
   stays wrong.

A third, related fault — **premature anchoring**: a bad early extraction gets
saved into `conv.inventoryContext` and poisons later turns (Todd's regenerate
still said "Ultra Limited" because the poisoned state outlived the code fix).

## The move

**Consolidate turn-comprehension into ONE typed LLM "turn understanding" pass
that runs once per inbound and is the single authority every downstream handler
reads. Keep deterministic for actions, compliance, and grading.**

- LLMs handle "roadglide", "around 10am", "my current ultra limited" natively —
  the exact variety regexes can't. One robust understanding step replaces a
  dozen brittle extractors.
- One authority kills the "two doorways" — there is no second extractor to
  disagree.
- The understanding object is re-derived from the full turn each time and is
  confidence-tagged, so stored state is re-validated, not blindly trusted
  (the anti-anchoring principle).

### What the pass outputs (the single source of truth)

A typed, schema-validated object per inbound turn (via the existing
`requestStructuredJson` + named `*_JSON_SCHEMA` + few-shot contract):

```
TurnUnderstanding {
  requestedModels:   [{ family, trim|null, confidence }]   // what they WANT
  ownedOrTradeModel: { family, trim|null } | null          // what they HAVE  (Todd)
  requestedSchedule: { dayLabel, timeText, window, isCommitment, isEvent } | null  // Chuck/Dominik/Al
  primaryIntent:     test_ride | pricing | availability | scheduling | trade | service | smalltalk | optout | ...
  flags:             { isOptOut, isWrongNumber, isComparison, askedForPhotos, ... }
  confidence:        0..1
}
```

### What STAYS deterministic (explicitly — this is half the design)

- **Actions:** booking the calendar slot, creating todos, sending SMS.
- **Compliance & safety:** opt-out/STOP handling, suppression, no-guessing
  prices, the draft-state invariants.
- **Grading:** the entire eval harness, correctness/latency/actions audits,
  release gate. These must stay deterministic to be trustworthy.

The LLM decides *what the customer means*; deterministic code decides *what we
do and whether we're allowed to*.

## Why this is safe to attempt (the de-risking argument)

We do **not** rip out 50 handlers. The safety net we built this week — 670 evals,
the answer-correctness grade, the latency grade, shadow replay, the release gate —
is exactly what makes a measured migration possible. Each step is graded; a
regression shows up the next morning, not in a customer's thread.

## Phased rollout (each phase independently shippable & reversible)

### Phase 0 — Build the understanding pass (no behavior change)
- `parseTurnUnderstandingWithLLM` in `llmDraft.ts`: schema + few-shots seeded
  with every production miss (Chuck, Dominik, Al, Todd, around-10am) verbatim.
- Eval `turn_understanding:eval` (LLM-live, key in repo `.env`) pinning each
  fixture's correct output.
- **Gate:** `npm run ci:eval`. Ships dark (function exists, nobody calls it).

### Phase 1 — Shadow mode (still no behavior change)
- Run the pass on every live inbound *alongside* the existing extractors. Log
  to `reports/turn_understanding_shadow/` where the LLM and the deterministic
  extractors disagree. (Same pattern as `inbound_shadow_replay` and the PG
  dual-write shadow.)
- The disagreement log becomes free, real-traffic test data and the precision
  measurement. Run ~1 week. **No customer impact.**

### Phase 2 — Authority for ONE decision (measured cutover)
- Make `TurnUnderstanding.requestedModels` / `ownedOrTradeModel` the authority
  for model selection in the availability + test-ride paths, with the
  deterministic extractor as fallback only when LLM confidence < threshold.
- Retire `conv.inventoryContext.model` blind-trust: re-validate it against the
  current turn's understanding (anti-anchoring). 
- Measure via `answer_correctness:audit` (`owned_bike_offered` must stay 0) and
  latency grade. Kill switch env flag to revert to deterministic.

### Phase 3 — Migrate remaining decisions one at a time
- Schedule (Chuck/Dominik/Al), then primary-intent routing, then the rest —
  each its own PR, each gated by the correctness + replay grades, each retiring
  one deterministic extractor only after it proves out in shadow.

## Cost & latency budget
- One extra LLM call per inbound: ~1s, a few cents. Agent draft latency is ~30s
  today with budget to spare; effective latency is staff-gated, not model-gated.
- System prompt is cacheable. `gpt-5-mini`-class model with
  `optionalReasoning` + adequate `max_output_tokens` (the empty-output trap).
- Kill switch: `TURN_UNDERSTANDING_ENABLED=0` reverts to today's extractors.

## Honest scope & timing vs June 30
- **This is NOT a June-30 blocker.** The showcase runs on the current patched
  system, which works. This is the **robustness-for-scale** project (dealer #2,
  #3 — where you can't hand-patch every phrasing).
- **Phase 0–1 can start now and run safely in parallel** — they change no
  customer-facing behavior, only add a shadow log. Phase 2–3 (the actual
  cutover) is post-showcase.
- Rough effort: Phase 0 ~2–3 focused days; Phase 1 ~1 week of shadow soak;
  Phase 2 ~2–3 days; Phase 3 incremental.

## Success criteria
- `owned_bike_offered` and `requested_day_reasked` trend to zero and *stay*
  there without per-phrasing patches.
- New customer phrasings ("roadglide", "around 10", "my current X") are handled
  on first contact — no new regex required.
- The deterministic extractor count goes DOWN over time, not up.
