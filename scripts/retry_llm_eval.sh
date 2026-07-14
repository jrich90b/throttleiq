#!/usr/bin/env bash
# Retry-once wrapper for LLM-judged evals (2026-07-13).
#
# LLM-judge evals are stochastic: a single mis-judged case can red the whole ci:eval gate and
# cost a full ~7-minute re-run (it happened twice on 7/13 — task_fulfillment_parser flaked once,
# passed 3/3 standalone). This wrapper retries a FAILED LLM eval exactly ONCE, loudly.
#
# Guardrails (why this doesn't weaken the safety net):
#   - Only LLM-judged evals are routed through this wrapper (package.json). Deterministic evals
#     still fail hard on the first miss.
#   - ONE retry only: a real regression fails twice in a row and still blocks the gate.
#   - Flakes are logged loudly (grep ci:eval logs for "FLAKE"). If the same eval flakes
#     repeatedly, FIX THE EVAL (tighten its judge/few-shots) — do not keep absorbing it.
#
# Usage (package.json): bash scripts/retry_llm_eval.sh env LLM_ENABLED=1 ... npx tsx scripts/foo_eval.ts
set -u

if [ "$#" -eq 0 ]; then
  echo "retry_llm_eval.sh: no command given" >&2
  exit 2
fi

# NOTE: capture $? directly after running the command. `if "$@"; then ...; fi` must NOT be
# used for the exit code — a false if-condition with no else makes the if statement itself
# return 0, which would let a REAL double failure exit green (caught in pre-ship testing).
"$@"
first_exit=$?
if [ "${first_exit}" -eq 0 ]; then
  exit 0
fi

echo ""
echo "FLAKE-RETRY: eval failed once (exit ${first_exit}) — retrying ONCE (LLM judges are stochastic; a real regression fails twice): $*"
echo ""

"$@"
second_exit=$?
if [ "${second_exit}" -eq 0 ]; then
  echo ""
  echo "FLAKE: eval passed on retry — treating as flake, gate stays green: $*"
  echo "FLAKE: if this eval flakes repeatedly, fix the eval (tighten its judge/few-shots) instead of absorbing it."
  exit 0
fi

echo ""
echo "FAIL: eval failed TWICE (exit ${second_exit}) — real failure, gate is red: $*"
exit "${second_exit}"
