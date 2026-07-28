# Large-corpus test ("5,000-conversation health run") — spec

**Status:** proposal for Joe's decision (2026-07-28). Not built. No production impact.
**Author:** agent-quality session.

## Goal
A periodic, large-scale run that answers one question: **"is the whole agent healthy right now?"** —
comprehension %, deterministic-trigger coverage %, and anomaly rate — as a single tracked scorecard
that trends over time. This is the sellable-product confidence number for rolling out to more dealers.
It is **NOT** a per-commit gate (too slow/expensive); it is a **nightly / on-demand standing run**.

## The important split (what's feasible on REAL data today)
There are two flavors, and they have very different data situations:

| Flavor | What it is | Real data available NOW |
|---|---|---|
| **Turn-level (5,000 messages)** | 5,000 single customer messages → comprehension + trigger checks | **16,758 real captured message-pairs** (parser-capture) — *already more than 5,000* |
| **Conversation-level (5,000 threads)** | 5,000 full multi-turn threads replayed end-to-end | only **783 real threads / 2,636 turns** today |

**Consequence:** a **5,000-message REAL test is feasible immediately** with zero synthetic data. A
**5,000-CONVERSATION test needs ~4,200 synthetic threads** (or months of accumulation) to reach scale.

## Architecture — reuse what already exists
Almost all the parts are built:
- **`inbound_shadow_replay`** — runs turns through the CURRENT code, **no sends, snapshot store**
  (read-only by construction). This is the safe execution engine.
- **`corpus_replay_flywheel`** — judges each produced draft with the intent-handled LLM judge, diffs
  per-turn vs the previous baseline (regressions pop instantly), emits findings in the anomaly shape.
- **Anomaly detectors** (`conversation_outcome_audit`, etc.) — already score outcomes (wrong close,
  missing task, watch-on-closed, appointment-confirmed-no-event…).
- **Trigger-coverage net** + **intent-comprehension scorecard** — the "did it understand + did the
  action fire" checks, ready to run at corpus scale.
- **Parser-capture** — 16,758 real message-pairs accumulating on the box (the free real corpus).

The large-corpus run = **wire these into one harness**: corpus → shadow-replay → grade (deterministic
checks + judges + anomaly detectors) → one scorecard + baseline diff.

## Grading (how you score thousands without hand-labeling)
Three layers, most-trusted first:
1. **Deterministic assertions** (0% error): expected trigger fired (watch/appointment/task/payment/
   photo)? any fabricated `$` price? opt-out honored? two-path parity held? These are ground truth.
2. **Anomaly detectors** (existing, deterministic-ish): outcome-state consistency over the run.
3. **LLM judges** (existing intent-handled / draft-quality judges): reply correctness/quality. Judges
   have their OWN error rate (~a few %), so this layer is a **trend indicator, not a hard gate** — and
   flagged items get a second, adversarial judge before they count (the pattern the review flow uses).

Release contract mirrors the flywheel's: **GATE = criticals 0 AND regressions 0**; **TREND = pass-rate
≥ 0.85**, watched over time, never blocking.

## Corpus mix (a decision — see below)
- **Real-first (recommended to start):** sample 5,000 from the 16,758 captured real turns → a genuine
  5,000-MESSAGE health run with **zero synthetic risk**, runnable this week.
- **Synthetic top-up (for conversation-level):** an LLM **conversation generator** authors realistic
  multi-turn threads spanning every intent / trigger / slang / edge case, labeled with the expected
  action, to reach 5,000 THREADS. Quality-gated (a human-reviewed seed set + a realism judge) — garbage
  synthetic = garbage confidence, so this is the part that needs care.
- **Blend:** e.g. 60% real turns + 40% synthetic threads, growing the real share as capture accumulates.

## Cadence
- **Nightly:** a **1,000-turn slice** (rotating sample) → fast trend signal, modest cost.
- **Weekly / on-demand:** the **full 5,000** → the headline scorecard + baseline diff.
- **Pre-dealer-rollout:** an on-demand full run as the go/no-go readiness check.
Never in per-commit `ci:eval`.

## Cost (order-of-magnitude — MEASURE on a pilot first)
Model: `gpt-5-mini`. A turn runs several parsers + a reply draft + 1–2 judges. Rough assumption
~8–12 LLM calls/turn, ~1K tokens each ≈ ~10K tokens/turn.
- **5,000-turn run:** ~50M tokens ⇒ **~$30–70 per full run** (blended mini pricing).
- **5,000-conversation run** (~3–4 turns each): **~$120–280 per full run**.
- **Nightly 1,000-turn slice:** **~$6–15/night**.
These are estimates with stated assumptions — the FIRST action is a **200-turn pilot to measure actual
tokens/cost/runtime**, then extrapolate before committing to 5,000.

## Phased rollout
1. **Pilot (200 real turns):** wire corpus-capture → shadow-replay → deterministic checks + trigger net
   + judge; produce a scorecard; **measure real cost/runtime**. Proves the harness end-to-end.
2. **5,000-MESSAGE real run** (nightly slice + weekly full) on the captured corpus — no synthetic.
3. **Synthetic conversation generator** (quality-gated) to add conversation-level coverage toward 5,000
   threads.
4. **Rollout gate:** the full run becomes the per-dealer readiness go/no-go.

## Decisions (Joe ruled 2026-07-28) — plan LOCKED
1. **MESSAGES first.** A 5,000-MESSAGE real run on the captured corpus (16,758 real turns) — no synthetic.
   Conversation-level (synthetic threads) is a later add.
2. **Pilot first, then a MONTHLY full run.** Fund the ~200-message pilot to MEASURE actual cost/runtime
   before scaling; the headline 5,000-message scorecard runs MONTHLY.
3. **MOSTLY REAL.** Lean on the captured real corpus; synthetic only later as a labeled, quality-gated
   supplement — never the backbone.
4. **NIGHTLY SLICE + monthly full.** A cheap ~1,000-message nightly slice for the daily trend, plus the
   monthly full 5,000-message run. Never in per-commit ci:eval.

### Build order (from the decisions)
- **STEP 1 (now): the pilot** — `scripts/large_corpus_pilot.ts`: sample N real inbound messages, run the
  live comprehension + trigger-signal checks through the current code, and report a scorecard +
  **measured runtime, LLM-call count, and estimated cost**. This proves the harness and gives the real
  cost number to size the nightly slice / monthly full.
- **STEP 2:** the nightly-slice run (~1,000) + the monthly full 5,000-message scorecard, reusing the
  pilot harness + the corpus-replay judge + the trigger-net checks, emitting a tracked scorecard + baseline diff.
- **STEP 3:** synthetic conversation generator (labeled, quality-gated) for conversation-level coverage.

### Pilot results — MEASURED on 200 real messages (2026-07-28, `npm run large_corpus_pilot`)
- 200/200 parsed OK; **84.5% confident comprehension** (primaryIntent set, conf ≥ 0.7) — a real health number.
- Intent mix: smalltalk 79, scheduling 32, availability 30, other 23, pricing 13, service 8, finance 4, parts 4, test_ride 3, trade 3, opt-out 1.
- **REAL cost $0.75 for 200 msgs = $0.0038/msg**; 70s runtime (0.35s/msg), concurrency 8.
- Extrapolation (comprehension pass only): **nightly 1,000 ≈ $3.76 / ~6 min; monthly 5,000 ≈ $18.79 / ~29 min.**
  The FULL run (comprehension + trigger-net checks + a judge) is ~2–3× → nightly ~$8–11, monthly ~$40–55.
  → Comfortably within a "monthly pilot" budget. Green-light STEP 2 at this cost.

### STEP 2 — BUILT + first real nightly run (2026-07-28, `npm run large_corpus:nightly`)
`scripts/large_corpus_run.ts`: comprehension pass → JUDGE the low-confidence candidates (intent-verdict
LLM judge, capped) so only judge-CONFIRMED misses count → SCORECARD (comprehension %, confirmed-miss
rate, cost, intent mix) written to `reports/large_corpus/` + a BASELINE DIFF vs the prior run
(regression flag). `--mode nightly` (N=1000) / `--mode full` (N=5000). First real 1,000-message run:
**82.5% comprehension confident; 175 low-confidence → judge confirmed only 5 real misses (~4%);
$3.17, 5.5 min** — matches the pilot estimate. The judge cleanly separated real misses from noise. The
5 CONFIRMED misses (the actionable fix queue — verify-first, then parser few-shots):
- "I have both our pay stubs and proof of address" → read `other`, should be **finance** (credit-app docs).
- "How bout 30..." → read `scheduling`, should be **pricing** (price negotiation).
- "Thanks for the follow up that never happened" → read `other`, should be **scheduling/callback**.
- "Hey gm never received pics" → read `parts`, should be **other** (photo follow-up).
- "Liked an image" (tapback) → read `smalltalk`, thread shows **scheduling** (tapback-echo edge).
