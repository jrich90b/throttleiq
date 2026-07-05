# Context-Fidelity Detector — spec

**Status:** proposal (approve-first; nothing built yet). Author: agent-watch follow-up, 2026-06-20.
**One line:** a single typed LLM scorer that asks *"does this reply address THIS turn's actual
intent/frame — not a stale, over-attached, fabricated, or wrong-lead-type one?"*, wired into both
the runtime draft gate and the offline agent-watch audit, so "answering out of context" is caught
reliably and the next sweepstakes-class bug is found automatically.

## 1. The problem (with this-session evidence)
"Answering out of context" = the reply adopts a frame the current turn doesn't warrant. Real prod
cases (americanharley, fresh data):
- **Wrong lead-type:** a *national-sweepstakes* signup got *"Thanks for your inquiry about the 2026
  Heritage Classic. If you'd like to stop in…"* — a sales/bike frame on a contest entry.
  (Fixed manually in the sweepstakes PR; the point is it was found by hand, not by a detector.)
- **Over-attachment:** `owned_bike_offered` — agent offered an *Ultra Limited* when the customer
  was talking *Road Glide* (a model not referenced this turn).
- **Stale frame / re-ask:** `requested_day_reasked` — customer named a day ("see you Monday",
  "off tomorrow", "the June 20th event") and the agent re-asked "what day works?" (fixed in
  `42e93079` / `f958ecbe`; the recent-window rate is now 0 — but only because someone wrote a
  class-specific fix).

## 2. Why today's net misses it
Two layers exist; both have a gap for this class.

- **Runtime draft-quality judge** (`judgeDraftQualityWithLLM`, llmDraft.ts): has the right *seed* —
  `intent_ok` = "does the draft ADDRESS what the customer asked/needs this turn?". But it's a single
  **binary**, acted on only for the high-confidence **hold** class (`DRAFT_QUALITY_HOLD_CLASS_ONLY=1`
  live), and it reads the **same truncated context the generator did** — so a fluent reply that's
  wrong *because* the anchor fell out of the window, or a model was over-attached, can pass both.
- **Offline audits** (`answer_correctness`, `intent_handled`): catch only **named** classes
  (`requested_day_reasked`, `owned_bike_offered`). A *novel* out-of-context class (sweepstakes→bike)
  has no check, so it never surfaces — it took reading raw prod conversations to find.
- **The regenerate boundary:** self-heal re-rolls the LLM, but regenerate runs the **same code**. A
  routing/lead-type bug regenerates to the same wrong reply; the judge can only **hold** it. The real
  fix is always a code change (manual or agent-watch-authored) + then regenerate to release the hold.

So: clear cases get held; subtle/novel ones slip, and discovery is manual.

## 3. Design — one scorer, two consumers

### 3.1 The scorer (`scoreContextFidelityWithLLM`)
A typed parser-first LLM scorer (`requestStructuredJson` + strict `CONTEXT_FIDELITY_JSON_SCHEMA`,
on-by-default flag), given: **this-turn inbound**, the **conversation context**, the **draft reply**,
and — critically — the **persisted anchor facts** (resolved model/year under discussion, appointment
state, lead classification/lead-type, active watch, dialogState). It returns sub-axes (not a binary),
so we can distinguish failure modes and steer fixes:

```
CONTEXT_FIDELITY_JSON_SCHEMA = {
  addresses_this_turn:          boolean,   // responds to what the customer actually said this turn
  referenced_entities_present:  boolean,   // every model/appt the reply asserts was referenced this
                                           //   turn OR is the established thread subject
  frame: enum [ "matches", "over_attached_model", "stale_intent",
                "wrong_lead_type", "fabricated", "dropped_anchor", "other" ],
  unsupported_assertion:        string,    // the specific out-of-context claim, if any
  verdict: enum [ "faithful", "out_of_context" ],
  severity: enum [ "minor", "major" ],
  confidence:                   number,
  steering:                     string     // one instruction to re-draft faithfully (feeds self-heal)
}
```

**Load-bearing design detail:** the scorer must be given **more context than the generator had** —
specifically the *persisted anchor/state* (the model of record, the lead-type, the appointment) —
not just the last-20-message window. That is what lets it catch **anchor-drop** (the generator forgot
the subject because it truncated) and **over-attachment** (the generator glued on a model the customer
didn't reference). A judge that only sees the same window shares the same blind spot.

### 3.2 Consumer A — runtime (EXTEND the existing judge; no new round-trip)
Do **not** add an 11th LLM call per turn (CLAUDE.md is trying to *shrink* round-trips). Instead **fold
the context-fidelity sub-axes into `judgeDraftQualityWithLLM`'s existing schema** (it already sees
inbound + draft + context; we add `addresses_this_turn` / `frame` / `unsupported_assertion` and feed
it the anchor facts). A `verdict=out_of_context, severity=major, confidence≥θ` becomes a **hold reason
with `steering`** → the existing self-heal regenerates with that steering → re-judge → ship-healed or
hold. Generalizes the binary `intent_ok` into a typed, steerable signal.

### 3.3 Consumer B — offline audit (`scripts/context_fidelity_audit.ts`)
A standalone batch (no per-turn cost) that runs the scorer over a recent window of sent + drafted
replies, buckets by `frame`, and writes `reports/context_fidelity/…` like `answer_correctness`. This
becomes an **agent-watch detection input**: new out-of-context classes surface automatically by
`frame=wrong_lead_type` / `over_attached_model` / `stale_intent`, each with the offending turn as a
ready **replay fixture** for a parser-first fix PR. *This is the piece that would have auto-caught the
sweepstakes bug.*

## 4. What it catches (mapped to the failure classes)
| Failure | Signal | Replaces today's |
|---|---|---|
| Over-attached model (Ultra Limited vs Road Glide) | `frame=over_attached_model` / `referenced_entities_present=false` | `passesModelRelevanceGuard` generalized to ALL replies, not just model-authority |
| Wrong lead-type (sweepstakes→bike) | `frame=wrong_lead_type` | *(nothing today — manual discovery)* |
| Stale intent (answers an old turn) | `frame=stale_intent` | output-layer check complementing `reduceStaleStateForInbound` (routing layer) |
| Anchor dropped on a long thread | `frame=dropped_anchor` | *(nothing — needs the scorer to see the persisted anchor)* |
| Re-asking a given day | `addresses_this_turn=false` | regression guard for the shipped `requested_day_reasked` fix |

## 5. Eval (`context_fidelity:eval`, in ci:eval, deterministic)
Self-test the scorer on a golden fixture set (the pattern used by `draft_quality_judge:eval` /
`no_response_judge:eval`): `(inbound, context, anchor, draft) → expected {verdict, frame}`. Seed it
from the **real prod examples found this session** — the sweepstakes bike-pitch (`wrong_lead_type`),
the owned-bike over-attachment (`over_attached_model`), the day-reask cases (`addresses_this_turn=false`)
— plus faithful controls that must score `faithful` (so we measure false-positive rate, which is the
dangerous direction). Universal / dealer-portable.

## 6. Rollout (evidence-led, shadow-first — same discipline as the draft judges)
1. **Build scorer + offline audit; run DARK** over the recent window. Hand-review precision (which
   `out_of_context` flags are real). Tune schema/threshold. *No runtime impact.*
2. **Wire the offline audit into agent-watch detection.** It auto-surfaces classes + replay fixtures.
   *Still no runtime change — this alone upgrades the skills loop* and is the cheapest win.
3. **Runtime axis in SHADOW** (log-only) → backtest precision on sent drafts (target like the
   `draft_judge_backtest`: ~0 false holds) → only then **ENFORCE** (hold/heal on major + high-conf),
   **approve-first**.

**Guardrails (hard):**
- **Precision over recall.** A false `out_of_context` hold suppresses a GOOD reply — worse than a
  miss. Shadow + backtest before any enforcement.
- The scorer **must** receive the persisted anchor/state context (§3.1) or it inherits the generator's
  blind spot.
- Reuse the existing judge call for the runtime axis (no new round-trip).
- Enforcement is a core-comprehension cutover → **approve-first**, gated on customer-facing precision,
  not shadow-disagreement.

## 7. Relationship to existing pieces
- **`passesModelRelevanceGuard`** (live, `TURN_UNDERSTANDING_MODEL_AUTHORITY=1`) is a *special case*
  (model dimension) of this; the scorer generalizes it to all entities/frames at the output layer.
- **`reduceStaleStateForInbound`** handles stale state at the *routing* layer; this is the *output*
  verification — defense in depth, not a replacement.
- **`intent_ok`** in the draft judge is the seed; this makes it typed, multi-axis, and anchor-aware.

## 8. Decisions for Joe
- **Scope of v1:** ship Steps 1–2 (offline detector + agent-watch wiring) first and leave the runtime
  enforce (Step 3) for a later, separately-approved cutover? (Recommended — it upgrades discovery with
  zero runtime risk.)
- **Cost:** confirm folding into the existing draft-quality judge (no extra round-trip) vs a dedicated
  call. (Recommended: fold in.)
- **Severity bar for enforce:** hold only `major`, or also `minor` with high confidence? (Start
  `major`-only.)
