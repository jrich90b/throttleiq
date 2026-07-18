# Student-parser distillation pilot — results & when to revisit

**Date:** 2026-07-18 · **Verdict:** concept proven end-to-end; first student **not good enough to deploy**; revisit after the data flywheel fattens (~weeks).

## What we set out to test
Can we fine-tune a small "student" model on our own captured parser traffic (the distillation
flywheel) that matches or beats the frontier "teacher" on reading customer intent — specifically
the **bike/model resolution** cases (slang/shorthand like "21 SGS", "tri glides")? Piloted on ONE
parser: `inventory_entity_parser` (reads which motorcycle a customer means).

## What we built (all reusable)
- `scripts/build_student_parser_dataset.ts` — turns the flywheel JSONL into an OpenAI-style
  fine-tune set for one parser, with a deterministic held-out eval split and a `--balance` option
  (downsamples the over-represented "no-bike/none" class in the training split only).
- `scripts/score_student_parser.ts` — offline scorecard: runs the held-out set through the served
  model, compares field-by-field to the teacher, breaks out the model-resolution subset, and dumps
  disagreements for spot-check. Robust JSON extraction (handles trailing/`<think>` tokens).
- Trained model on Fireworks: `accounts/integrations-7v5ec8g/models/ie-parser-qwen3-4b-v1`
  (base `qwen3-4b`, LoRA, 356-example balanced slim train set, 317K training tokens).

## Results (172 held-out examples, 0 errors)
- **Exact match (all 15 fields == teacher): 57.6%**
- **"No bike" subset (106): student also said none — 99.1%** (excellent on the easy majority)
- **Model-resolution subset (66 — the ones that matter):**
  - target_type matches teacher: 34.8%
  - model string matches teacher: 43.9%
  - **target_type + model + year all correct: 33.3%** ← the bar; too low
- Per-field agreement: year_min/max 98%, color 96%, trim 98%, prices 98–100%, condition 96% (strong);
  target_type 74%, model 74%, is_availability_question 76%, year 81% (weak — the decision fields).

The disagreements are clear student **misses**, not teacher errors: e.g. structured leads that say
`Model: Street Bob` / `Model: Sportster 883` → teacher extracts the model, student returned nothing.
No evidence the student beats the teacher on slang; the evidence is it's worse at model extraction.

## Why (and why it's fixable but not free)
Deliberately cheap first pass: small 4B model, one run, default hyperparameters, and — the real
cause — **thin data on the hard cases.** Of ~796 unique captured examples, ~69% were "none" and only
~272 named a model; the tricky slang/color/alternate classes were in the single digits. The student
got great at what it saw a lot of ("none") and stayed weak at what it barely saw (model extraction).

## What OpenAI/Fireworks friction taught us (for the go/no-go)
- **OpenAI self-serve fine-tuning is discontinued** for our org — switched to Fireworks.
- Fireworks: training is cheap (<$1) and easy; **serving is the burden** — a fine-tuned LoRA needs a
  dedicated GPU (bills ~$3–7/hr while up), and **deploys must be run by a human** (firectl blocks AI
  agents from mutating commands by design; REST can't trigger the required live-merge). Teardown
  needs `?ignoreChecks=true` after the model has served traffic.
- Net: productionizing a home-trained parser carries real ongoing ops cost, on top of the accuracy gap.

## Recommendation
**Do not invest further right now.** Keep the flywheel running (free; it banks ~150–250 new unique
model examples/day). **Revisit in a few weeks** when there's 5–10× more model-resolution data, and
retrain (consider a larger base model + light tuning). If it clears ~90%+ on the model subset in the
offline scorecard, then — and only then — weigh the serving cost for a shadow/cutover. Until then,
the frontier-model parsers stay as-is.

## Resume instructions (one command each)
1. Rebuild dataset: `npx tsx scripts/build_student_parser_dataset.ts --in <flywheel dir> --schema inventory_entity_parser --out <dir> --variant slim --balance`
2. Upload + fine-tune on Fireworks (dataset create → signed-URL upload → SFT job); base `qwen3-4b`.
3. Deploy (HUMAN, fresh terminal): `firectl create deployment accounts/<acct>/models/<model> --accelerator-type NVIDIA_H100_80GB --wait`
4. Score: `FIREWORKS_API_KEY=... npx tsx scripts/score_student_parser.ts --eval <dir>/eval.jsonl --model "<model>#<deployment>"`
5. Teardown: `DELETE .../deployments/<id>?ignoreChecks=true`

Total pilot spend: ~$5–7 of the $50 Fireworks credit.
