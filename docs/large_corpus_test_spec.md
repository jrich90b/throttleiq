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

## Open decisions for Joe
1. **Message-level or conversation-level first?** (Message-level is real + feasible now; conversation-
   level needs synthetic.) — *Recommend: message-level real run first, add synthetic threads after.*
2. **Budget per run** you're comfortable with (drives corpus size + cadence). — *Recommend: fund the
   200-turn pilot first (~$3), decide the rest from measured numbers.*
3. **Realness stance:** OK to lean on synthetic conversations to hit 5,000, or keep it mostly real even
   if that means starting smaller and growing? — *Recommend: mostly real now, synthetic as a labeled,
   quality-gated supplement.*
4. **Cadence:** nightly slice + weekly full, or on-demand only?
