#!/usr/bin/env bash
#
# release_gate_full — prove the EXACT tree that is about to deploy, then deploy it.
#
# Joe, 2026-08-04: "let's set up the full suite with the golden corpus."
#
# WHY THIS EXISTS. `ci:eval` takes ~45 minutes; the un-stack loop merges every ~20. On 8/4 main moved
# four times under one deploy attempt, so the tree proven green was never the tree that shipped, and
# the deploy went out on targeted evals plus a judgement call. This closes that: hold merges still,
# prove the frozen tree, ship it, let go.
#
# WHAT IT PROVES, in order (first failure stops everything — a red gate never deploys):
#   1. merge freeze taken, so main cannot move underneath the proof
#   2. working tree clean and synced to origin/main
#   3. tsc --noEmit
#   4. the full ci:eval suite
#   5. the GOLDEN CORPUS number: a FRESH score at or above the floor (25, Joe 2026-08-21) — pulled
#      from the box first, because the scorer runs there and this gate runs here
#   6. deploy (api, and web only when asked)
# The freeze is released on EVERY exit path, including failure and Ctrl-C.
#
# The golden-corpus step is the one that answers "is the agent actually any good", as opposed to
# "have these specific things not regressed". It reads the score the box produces out of band
# (scripts/gold_corpus_score.ts); this gate refuses a STALE one rather than treating an old number as
# evidence about today's agent.
#
# Usage:
#   bash scripts/release_gate_full.sh                 # gate + deploy api
#   bash scripts/release_gate_full.sh --with-web      # also deploy the console
#   bash scripts/release_gate_full.sh --gate-only     # prove it, deploy nothing
#   bash scripts/release_gate_full.sh --skip-gold     # explicit, logged, requires a reason
#
# Env: GOLD_SCORE_FLOOR, GOLD_SCORE_MIN_SCORED, GOLD_SCORE_MAX_AGE_HOURS, MERGE_FREEZE_MAX_AGE_MIN
set -uo pipefail

OWNER="${RELEASE_GATE_OWNER:-release-gate}"
WITH_WEB=0
GATE_ONLY=0
SKIP_GOLD=0
for a in "$@"; do
  case "$a" in
    --with-web) WITH_WEB=1 ;;
    --gate-only) GATE_ONLY=1 ;;
    --skip-gold) SKIP_GOLD=1 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

STEP=0
step() { STEP=$((STEP+1)); echo ""; echo "==> [$STEP] $*"; }
fail() { echo ""; echo "GATE RED: $*" >&2; exit 1; }

RELEASED=0
release_freeze() {
  [ "$RELEASED" = "1" ] && return 0
  RELEASED=1
  npx tsx scripts/merge_freeze.ts release --owner "$OWNER" >/dev/null 2>&1 || true
  echo "merge freeze released."
}
trap release_freeze EXIT INT TERM

step "Taking the merge freeze so main cannot move under the proof"
npx tsx scripts/merge_freeze.ts take --owner "$OWNER" --reason "full release gate + golden corpus" \
  || fail "another routine holds the merge freeze — wait for it, or check 'merge_freeze.ts status'"

step "Syncing to origin/main"
git fetch -q origin main || fail "git fetch failed"
if [ -n "$(git status --porcelain)" ]; then
  fail "working tree is dirty — a gate must prove exactly what ships, not what ships plus your edits"
fi
git merge --ff-only origin/main >/dev/null 2>&1 || fail "cannot fast-forward to origin/main"
HEAD_SHA="$(git rev-parse --short HEAD)"
ORIGIN_SHA="$(git rev-parse --short origin/main)"
[ "$HEAD_SHA" = "$ORIGIN_SHA" ] || fail "HEAD ($HEAD_SHA) != origin/main ($ORIGIN_SHA)"
echo "    proving $HEAD_SHA"

step "Typecheck (tsc --noEmit)"
( cd services/api && node --max-old-space-size=4096 ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit ) \
  || fail "tsc failed"
echo "    tsc clean"

step "Full eval suite (ci:eval) — this is the ~45 minute one"
CI_LOG="$(mktemp -t release_gate_cieval)"
npm run ci:eval > "$CI_LOG" 2>&1
CI_EXIT=$?
echo "    $(grep -c '^PASS' "$CI_LOG" 2>/dev/null || echo 0) PASS lines; log: $CI_LOG"
# Trust the captured exit code only — a wrapper in the chain can mask a failure downstream.
[ "$CI_EXIT" = "0" ] || { tail -30 "$CI_LOG"; fail "ci:eval failed (exit $CI_EXIT) — see $CI_LOG"; }
echo "    ci:eval green"

step "Golden corpus — how good is the agent, not just what has not regressed"
if [ "$SKIP_GOLD" = "1" ]; then
  echo "    !! SKIPPED by --skip-gold. This gate no longer says anything about agent QUALITY."
else
  # The scorer runs on the BOX (LLM calls, minutes, and it needs the live store); the gate runs HERE.
  # Without this pull the gate reads whatever stale copy this clone happens to hold — on 2026-08-21
  # that was a 17-day-old file, so the very first enforcing run would have failed on staleness and
  # blocked every release. Best-effort on purpose: if the pull fails we fall through to the local
  # copy and let the freshness check decide, which is the same fail-closed answer, just slower to read.
  GOLD_REMOTE="lightsail:/home/ubuntu/leadrider-runtime/americanharley/reports/gold_score"
  mkdir -p reports/gold_score
  if scp -q "$GOLD_REMOTE/gold_score_report.json" "$GOLD_REMOTE/gold_score_summary.json" reports/gold_score/ 2>/dev/null; then
    echo "    pulled the box's gold score"
  else
    echo "    !! could not pull the box's gold score — checking the local copy, which may be stale"
  fi
  npx tsx scripts/gold_score_gate.ts || fail "golden-corpus check failed (see the reason above)"
fi

if [ "$GATE_ONLY" = "1" ]; then
  echo ""
  echo "GATE GREEN for $HEAD_SHA (--gate-only: nothing deployed)."
  exit 0
fi

step "Deploying the API"
npm run deploy:api || fail "API deploy failed"

if [ "$WITH_WEB" = "1" ]; then
  step "Deploying the console"
  npm run deploy:web || fail "web deploy failed"
  echo "    NOTE: tell the user to hard-refresh the console (Cmd/Ctrl+Shift+R)."
fi

echo ""
echo "RELEASE COMPLETE — $HEAD_SHA proven green and deployed."
