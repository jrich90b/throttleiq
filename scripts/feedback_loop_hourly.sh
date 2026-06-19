#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DATA_DIR="${DATA_DIR:-/home/ubuntu/throttleiq-runtime/data}"
CONVERSATIONS_DB_PATH="${CONVERSATIONS_DB_PATH:-$DATA_DIR/conversations.json}"
REPORT_ROOT="${REPORT_ROOT:-/home/ubuntu/throttleiq-runtime/reports}"
LANGUAGE_CORPUS_OUT_DIR="${LANGUAGE_CORPUS_OUT_DIR:-$REPORT_ROOT/language_corpus}"
VOICE_FEEDBACK_OUT_DIR="${VOICE_FEEDBACK_OUT_DIR:-$REPORT_ROOT/voice_feedback}"
DETERMINISTIC_TONE_RULES_PATH="${DETERMINISTIC_TONE_RULES_PATH:-$DATA_DIR/deterministic_tone_rules.json}"
MANUAL_REPLY_EXAMPLES_PATH="${MANUAL_REPLY_EXAMPLES_PATH:-$DATA_DIR/manual_reply_examples.json}"
AGENT_MANAGER_OUT_DIR="${AGENT_MANAGER_OUT_DIR:-$REPORT_ROOT/agent_manager}"
LOG_DIR="${LOG_DIR:-$REPORT_ROOT/feedback_loop_logs}"
FEEDBACK_LOOP_ENV_PATH="${FEEDBACK_LOOP_ENV_PATH:-/home/ubuntu/throttleiq-runtime/.feedback_loop.env}"

FAST_LOOP_SINCE_HOURS="${FAST_LOOP_SINCE_HOURS:-2}"
LANGUAGE_CORPUS_SINCE_HOURS="${LANGUAGE_CORPUS_SINCE_HOURS:-$FAST_LOOP_SINCE_HOURS}"
FAST_LOOP_RUN_LANGUAGE_SEED_EVAL="${FAST_LOOP_RUN_LANGUAGE_SEED_EVAL:-1}"
FAST_LOOP_ROLLBACK_ON_EVAL_FAIL="${FAST_LOOP_ROLLBACK_ON_EVAL_FAIL:-1}"

# Conservative by default; can be tuned lower for more aggressive adaptation.
DETERMINISTIC_RULE_PROMOTE_MIN_COUNT="${DETERMINISTIC_RULE_PROMOTE_MIN_COUNT:-${FAST_LOOP_DETERMINISTIC_RULE_PROMOTE_MIN_COUNT:-2}}"
MANUAL_REPLY_PROMOTE_MIN_COUNT="${MANUAL_REPLY_PROMOTE_MIN_COUNT:-${FAST_LOOP_MANUAL_REPLY_PROMOTE_MIN_COUNT:-1}}"
MANUAL_REPLY_PROMOTE_MAX_PER_INTENT="${MANUAL_REPLY_PROMOTE_MAX_PER_INTENT:-${FAST_LOOP_MANUAL_REPLY_MAX_PER_INTENT:-6}}"

LOCK_DIR="${LOCK_DIR:-$REPORT_ROOT/feedback_loop_hourly.lock}"

if [[ -f "$FEEDBACK_LOOP_ENV_PATH" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$FEEDBACK_LOOP_ENV_PATH"
  set +a
fi

mkdir -p "$REPORT_ROOT" "$LANGUAGE_CORPUS_OUT_DIR" "$VOICE_FEEDBACK_OUT_DIR" "$AGENT_MANAGER_OUT_DIR" "$LOG_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[feedback-hourly] skipped: another loop is already running (lock: $LOCK_DIR)"
  exit 0
fi
trap 'rm -rf "$LOCK_DIR"' EXIT

TS="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_LOG="$LOG_DIR/feedback_loop_hourly_$TS.log"
BACKUP_DIR="$LOG_DIR/feedback_loop_hourly_backups_$TS"
mkdir -p "$BACKUP_DIR"

backup_if_exists() {
  local src="$1"
  local dst="$2"
  if [[ -f "$src" ]]; then
    cp "$src" "$dst"
    return 0
  fi
  return 1
}

restore_if_backup_exists() {
  local backup="$1"
  local dest="$2"
  if [[ -f "$backup" ]]; then
    cp "$backup" "$dest"
    return 0
  fi
  return 1
}

{
  echo "[feedback-hourly] started at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "[feedback-hourly] DATA_DIR=$DATA_DIR"
  echo "[feedback-hourly] CONVERSATIONS_DB_PATH=$CONVERSATIONS_DB_PATH"
  echo "[feedback-hourly] REPORT_ROOT=$REPORT_ROOT"
  echo "[feedback-hourly] LANGUAGE_CORPUS_OUT_DIR=$LANGUAGE_CORPUS_OUT_DIR"
  echo "[feedback-hourly] VOICE_FEEDBACK_OUT_DIR=$VOICE_FEEDBACK_OUT_DIR"
  echo "[feedback-hourly] LANGUAGE_CORPUS_SINCE_HOURS=$LANGUAGE_CORPUS_SINCE_HOURS"
  echo "[feedback-hourly] DETERMINISTIC_TONE_RULES_PATH=$DETERMINISTIC_TONE_RULES_PATH"
  echo "[feedback-hourly] MANUAL_REPLY_EXAMPLES_PATH=$MANUAL_REPLY_EXAMPLES_PATH"
  echo "[feedback-hourly] AGENT_MANAGER_OUT_DIR=$AGENT_MANAGER_OUT_DIR"
  echo "[feedback-hourly] DETERMINISTIC_RULE_PROMOTE_MIN_COUNT=$DETERMINISTIC_RULE_PROMOTE_MIN_COUNT"
  echo "[feedback-hourly] MANUAL_REPLY_PROMOTE_MIN_COUNT=$MANUAL_REPLY_PROMOTE_MIN_COUNT"
  echo "[feedback-hourly] MANUAL_REPLY_PROMOTE_MAX_PER_INTENT=$MANUAL_REPLY_PROMOTE_MAX_PER_INTENT"
  echo "[feedback-hourly] FAST_LOOP_RUN_LANGUAGE_SEED_EVAL=$FAST_LOOP_RUN_LANGUAGE_SEED_EVAL"
  echo "[feedback-hourly] FAST_LOOP_ROLLBACK_ON_EVAL_FAIL=$FAST_LOOP_ROLLBACK_ON_EVAL_FAIL"

  # Some scripts still read CONVERSATIONS_PATH (legacy) instead of CONVERSATIONS_DB_PATH.
  CONVERSATIONS_PATH="${CONVERSATIONS_PATH:-$CONVERSATIONS_DB_PATH}"
  export DATA_DIR CONVERSATIONS_DB_PATH CONVERSATIONS_PATH LANGUAGE_CORPUS_OUT_DIR VOICE_FEEDBACK_OUT_DIR DETERMINISTIC_TONE_RULES_PATH MANUAL_REPLY_EXAMPLES_PATH AGENT_MANAGER_OUT_DIR
  export LANGUAGE_CORPUS_SINCE_HOURS DETERMINISTIC_RULE_PROMOTE_MIN_COUNT MANUAL_REPLY_PROMOTE_MIN_COUNT MANUAL_REPLY_PROMOTE_MAX_PER_INTENT

  echo "[feedback-hourly] step=language_corpus_mine"
  npm run language_corpus:mine

  echo "[feedback-hourly] step=voice_feedback_mine"
  VOICE_FEEDBACK_SINCE_HOURS="${FAST_LOOP_SINCE_HOURS}" npm run voice_feedback:mine -- --out-dir "$VOICE_FEEDBACK_OUT_DIR"

  TONE_BACKUP_PATH="$BACKUP_DIR/deterministic_tone_rules.before.json"
  MANUAL_BACKUP_PATH="$BACKUP_DIR/manual_reply_examples.before.json"
  had_tone_backup=0
  had_manual_backup=0
  if backup_if_exists "$DETERMINISTIC_TONE_RULES_PATH" "$TONE_BACKUP_PATH"; then had_tone_backup=1; fi
  if backup_if_exists "$MANUAL_REPLY_EXAMPLES_PATH" "$MANUAL_BACKUP_PATH"; then had_manual_backup=1; fi

  echo "[feedback-hourly] step=deterministic_rules_promote"
  npm run deterministic_rules:promote

  echo "[feedback-hourly] step=manual_outbound_promote"
  npm run manual_outbound:promote

  if [[ "$FAST_LOOP_RUN_LANGUAGE_SEED_EVAL" == "1" ]]; then
    echo "[feedback-hourly] step=language_seed_eval"
    if npm run language_seed:eval; then
      echo "[feedback-hourly] language_seed_eval=pass"
    else
      echo "[feedback-hourly] language_seed_eval=fail"
      if [[ "$FAST_LOOP_ROLLBACK_ON_EVAL_FAIL" == "1" ]]; then
        echo "[feedback-hourly] rollback=started"
        if [[ "$had_tone_backup" == "1" ]]; then
          restore_if_backup_exists "$TONE_BACKUP_PATH" "$DETERMINISTIC_TONE_RULES_PATH" || true
        fi
        if [[ "$had_manual_backup" == "1" ]]; then
          restore_if_backup_exists "$MANUAL_BACKUP_PATH" "$MANUAL_REPLY_EXAMPLES_PATH" || true
        fi
        echo "[feedback-hourly] rollback=completed"
      fi
      exit 1
    fi
  else
    echo "[feedback-hourly] step=language_seed_eval skipped"
  fi

  # --- Behavior audits on the recent window (the hourly miss-detection sweep) -------------------
  # Flags cadence / handoff / task / no-response / wrong-intent misses within ~2h instead of waiting
  # for the nightly. Each step is `|| true` so a single audit failure can NEVER break this loop or the
  # rule-promotion/rollback above. agent_manager:report (next) re-ranks whatever these produce, and the
  # agent-watch routine then diagnoses + patches the code parser-first (approve-first PR).
  ROUTE_AUDIT_DIR="${ROUTE_AUDIT_DIR:-$REPORT_ROOT/route_audit}"
  FOLLOWUP_TASK_AUDIT_JSON="$LOG_DIR/followup_task_consistency_hourly_$TS.json"
  WATCHDOG_JSON="$LOG_DIR/route_watchdog_hourly_$TS.json"
  WATCHDOG_SINCE_MIN=$(( FAST_LOOP_SINCE_HOURS * 60 ))
  export ROUTE_AUDIT_DIR

  # Cost split: the DETERMINISTIC detectors run every hour (free). The LLM-judge audits (intent_handled,
  # outcome_qa) cost per turn, and the live held-gate already flags the worst wrong-intent/fabrication in
  # real time — so run those only every LLM_AUDIT_EVERY_HOURS (default 4). 10# forces base-10 on the hour.
  HOUR_NOW="$(date +%H)"
  RUN_LLM_AUDITS=$(( 10#$HOUR_NOW % ${LLM_AUDIT_EVERY_HOURS:-4} == 0 ? 1 : 0 ))

  echo "[feedback-hourly] step=followup_task_consistency_audit"   # cadence / task / handoff state
  npm run followup_task_consistency:audit -- --conversations "$CONVERSATIONS_DB_PATH" --since-hours "$FAST_LOOP_SINCE_HOURS" --out "$FOLLOWUP_TASK_AUDIT_JSON" || true

  echo "[feedback-hourly] step=stale_handoff_todo_audit"          # handed-off leads going stale
  npm run stale_handoff_todo:audit || true

  if [[ "$RUN_LLM_AUDITS" == "1" ]]; then
    echo "[feedback-hourly] step=intent_handled_audit"            # wrong-intent (the Adam/Douglas class) — LLM, every ${LLM_AUDIT_EVERY_HOURS:-4}h
    INTENT_HANDLED_SINCE_HOURS="$(( ${LLM_AUDIT_EVERY_HOURS:-4} ))" npm run intent_handled:audit || true
  else
    echo "[feedback-hourly] step=intent_handled_audit skipped (LLM audits run every ${LLM_AUDIT_EVERY_HOURS:-4}h)"
  fi

  echo "[feedback-hourly] step=compliance_send_audit"             # opt-out / STOP footer
  npm run compliance:audit || true

  echo "[feedback-hourly] step=task_autoclose_stale_report"       # task completion not marked
  mkdir -p "$REPORT_ROOT/task_autoclose"
  LLM_ENABLED=1 CONVERSATIONS_DB_PATH="$CONVERSATIONS_DB_PATH" npx tsx scripts/task_fulfillment_autoclose_report.ts --limit=200 > "$REPORT_ROOT/task_autoclose/task_autoclose_report.txt" 2>&1 || true

  echo "[feedback-hourly] step=draft_held_report"                 # held drafts (the bridge to the code fix)
  mkdir -p "$REPORT_ROOT/draft_held"
  CONVERSATIONS_DB_PATH="$CONVERSATIONS_DB_PATH" DRAFT_HELD_REPORT_OUT="$REPORT_ROOT/draft_held/draft_held_report.txt" npx tsx scripts/draft_held_report.ts > /dev/null 2>&1 || true

  echo "[feedback-hourly] step=route_watchdog"                    # actionable inbound with no response
  npm run route_watchdog:run -- --conversations "$CONVERSATIONS_DB_PATH" --route-audit-dir "$ROUTE_AUDIT_DIR" --since-min "$WATCHDOG_SINCE_MIN" --out "$WATCHDOG_JSON" || true

  OUTCOME_QA_OUT_DIR="${OUTCOME_QA_OUT_DIR:-$REPORT_ROOT/outcome_qa}"
  BOOKING_FUNNEL_OUT_DIR="${BOOKING_FUNNEL_OUT_DIR:-$REPORT_ROOT/booking_funnel}"
  mkdir -p "$OUTCOME_QA_OUT_DIR" "$BOOKING_FUNNEL_OUT_DIR"
  export OUTCOME_QA_OUT_DIR

  if [[ "$RUN_LLM_AUDITS" == "1" ]]; then
    echo "[feedback-hourly] step=outcome_qa_audit"               # context / outcomes / disposition QA — LLM, every ${LLM_AUDIT_EVERY_HOURS:-4}h
    OUTCOME_QA_SINCE_HOURS="$(( ${LLM_AUDIT_EVERY_HOURS:-4} ))" npm run outcome_qa:audit -- --conversations "$CONVERSATIONS_DB_PATH" --out-dir "$OUTCOME_QA_OUT_DIR" || true
  else
    echo "[feedback-hourly] step=outcome_qa_audit skipped (LLM audits run every ${LLM_AUDIT_EVERY_HOURS:-4}h)"
  fi

  echo "[feedback-hourly] step=booking_funnel_audit"              # appointment bookings (offer->book misses)
  BOOKING_FUNNEL_OUT_DIR="$BOOKING_FUNNEL_OUT_DIR" npx tsx scripts/booking_funnel_audit.ts --since-days 1 --out-dir "$BOOKING_FUNNEL_OUT_DIR" > /dev/null 2>&1 || true

  echo "[feedback-hourly] step=watch_fire_miss_audit"             # active watch + matching unit in stock + not notified
  mkdir -p "$REPORT_ROOT/watch_fire_miss"
  CONVERSATIONS_DB_PATH="$CONVERSATIONS_DB_PATH" WATCH_FIRE_MISS_OUT="$REPORT_ROOT/watch_fire_miss/watch_fire_miss_report.txt" npx tsx scripts/watch_fire_miss_audit.ts > /dev/null 2>&1 || true

  echo "[feedback-hourly] step=cross_lead_leak_audit"             # another customer's contact in the wrong thread
  mkdir -p "$REPORT_ROOT/cross_lead_leak"
  CONVERSATIONS_DB_PATH="$CONVERSATIONS_DB_PATH" CROSS_LEAD_LEAK_OUT="$REPORT_ROOT/cross_lead_leak/cross_lead_leak_report.txt" npx tsx scripts/cross_lead_leak_audit.ts > /dev/null 2>&1 || true

  echo "[feedback-hourly] step=agent_manager_report"
  npm run agent_manager:report

  echo "[feedback-hourly] completed at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} | tee "$RUN_LOG"
