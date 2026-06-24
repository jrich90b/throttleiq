# Closed-loop feedback: thumbs-down → redraft → (aggregated) parser-first fix

**Goal (Joe, 2026-06-24):** a rep hits 👎 on a generated reply and the system (a) re-drafts the
reply immediately, and (b) over time patches the underlying code — **while honoring the de-tangle
program** (comprehend-never-regex, route decisions centralized + pure, parser-first in both paths,
every behavior change eval-gated, and **core-comprehension cutovers are approve-first**).

The loop has two halves with very different automation ceilings. The split is deliberate, not a gap.

```
👎 (rating + reason)
   │
   ├─ Phase 1  immediate steered RE-DRAFT into the console box   [AUTO, safe — suggest mode]
   │
   └─ Phase 2  classify + aggregate the 👎 signal                [AUTO, shadow]
                   │  (tone? wrong-intent? fabrication? one-off?)
                   ▼
      Phase 3  when a CLASS crosses threshold → auto-author a
               parser-first fix PR (few-shots + replay fixture +
               decision-table eval, both paths)                  [AUTO-DRAFTED]
                   │
                   ▼
               human reviews + MERGES  ──► deploy ──► next regenerate is correct
                                                       (loop closes — the draft-held-bridge pattern)
```

## Phase 1 — immediate redraft (SHIPPED 2026-06-24)
On a thumbs-DOWN of a still-pending `draft_ai` draft, regenerate the reply with the rep's reason as
**steering** and publish it as a fresh pending draft (supersedes the down-rated one). A human still
hits Send (suggest mode).

- Pure gate: `decideFeedbackRedraftTurn` + `buildFeedbackRedraftSteering` (`routeStateReducer.ts`).
- Wiring: `POST /conversations/:id/messages/:messageId/feedback` → `maybeRedraftOnNegativeFeedback`
  → `generateDraftWithLLM({…, steering})` → `saveOperatorDraft` (never sends).
- Flag: `FEEDBACK_DOWN_REDRAFT_ENABLED` (kill switch). Eval: `feedback_redraft:eval`.
- This is the **generation/voice layer** the de-tangle program already allows the LLM to own — NOT a
  routing change. Fail-safe: any miss/error leaves the original draft untouched.
- Follow-up hardening (1.1): route the redraft through the full draft-quality / context-fidelity
  gate (it's auto-generated text), and pass richer context (inventory/appointment) like the
  orchestrator's `draftCtx`. Today it reuses lead/history/classification/dealer-profile + steering.

## Phase 2 — classify + aggregate (shadow; NOT built)
A thumbs-down is a **weak signal** (our data: ~43% of human takeovers were real errors), so n=1 must
never patch code. Build the signal pipeline first, report-only:

- **Capture richer 👎:** the endpoint already stores `reason` + `note`. Add a small structured
  `reason` taxonomy in the console (tone, pushy, wrong-intent, missed-the-ask, fabrication, other).
- **Negative-feedback report** (sibling of `scripts/draft_held_report.ts`): collect down-rated
  drafts + inbound + reason across the store. This is the same high-signal input the **draft-held
  bridge** already turns into diagnoses — extend it from "held drafts" to "thumbs-down drafts."
- **Triage classifier** maps each 👎 onto the de-tangle comprehension-vs-deterministic split:
  - *tone / voice* → Phase 1 redraft (+ candidate voice few-shot via the gold-corpus harvester); **never a routing change**.
  - *wrong-intent / out-of-context / wrong route* → a **parser/route** fix (Phase 3), parser-first.
  - *fabrication / unsafe* → already a HELD case (draft-quality gate) → existing bridge.
  - *one-off / rep-preference* → record only; do not act.
- **Aggregate:** group by failure mode; only a CLASS crossing a threshold (multiple conversations,
  same mode) becomes a fix candidate. Reuse `feedback_loop_nightly.sh` cadence.
- Output: a shadow report ("what we WOULD propose") so we calibrate precision before any PR fires.

## Phase 3 — auto-authored parser-first fix PRs (approve-first; NOT built)
For a confident, aggregated **comprehension** class, auto-author the fix the de-tangle way and open a
PR — never auto-merge:

- Reuse the **`agent-watch`** skill (it already authors parser-first fix PRs and never deploys
  comprehension changes). Input = the Phase 2 aggregated class instead of the nightly audit.
- The fix is **parser few-shots + a replay fixture + a decision-table eval, in BOTH paths** — never
  a new regex (comprehend-never-regex; fail-direction test for any migrate-vs-keep).
- A human reviews + merges; deploy; the next regenerate produces the correct draft; the held/stale
  draft releases — the loop **closes** exactly like the existing draft-held bridge.

### Why the merge stays human (the law, quoted)
`CLAUDE.md`: *"any core-comprehension cutover is approve-first (open a PR, don't auto-build it)"*;
fixes = parser few-shots + replay fixtures, **not** a new regex; every behavior change needs a
deterministic eval in `ci:eval`; ship only when tsc + `ci:eval` are green. Auto-merging LLM-written
comprehension changes into a live customer-messaging system would betray the entire de-tangle safety
stance. So the loop is **auto-diagnose + auto-PR + auto-eval-gate; human merges** — still closed,
with the one gate the program requires.

## Metrics (add alongside Phase 1)
- **Redraft acceptance:** did the rep SEND the redraft (or edit-then-send) vs discard? — the direct
  quality signal for Phase 1.
- **👎 rate trend** per intent/cluster — should fall as Phase-3 fixes land.
- **Time-to-fix:** 👎-class detected → PR merged → 👎 rate for that class drops.
