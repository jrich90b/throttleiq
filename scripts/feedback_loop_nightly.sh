#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DATA_DIR="${DATA_DIR:-/home/ubuntu/throttleiq-runtime/data}"
CONVERSATIONS_DB_PATH="${CONVERSATIONS_DB_PATH:-$DATA_DIR/conversations.json}"
REPORT_ROOT="${REPORT_ROOT:-/home/ubuntu/throttleiq-runtime/reports}"
ROUTE_AUDIT_DIR="${ROUTE_AUDIT_DIR:-$REPORT_ROOT/route_audit}"
CHANGED_MESSAGES_PATH="${CHANGED_MESSAGES_PATH:-$REPORT_ROOT/changed_messages_all.json}"
CHANGED_MESSAGES_SINCE_HOURS="${CHANGED_MESSAGES_SINCE_HOURS:-24}"
AUDIT_SINCE_HOURS="${AUDIT_SINCE_HOURS:-24}"
EDIT_FEEDBACK_OUT_DIR="${EDIT_FEEDBACK_OUT_DIR:-$REPORT_ROOT/edit_feedback}"
LANGUAGE_CORPUS_OUT_DIR="${LANGUAGE_CORPUS_OUT_DIR:-$REPORT_ROOT/language_corpus}"
VOICE_FEEDBACK_OUT_DIR="${VOICE_FEEDBACK_OUT_DIR:-$REPORT_ROOT/voice_feedback}"
OUTCOME_QA_OUT_DIR="${OUTCOME_QA_OUT_DIR:-$REPORT_ROOT/outcome_qa}"
VEHICLE_WATCH_QA_OUT_DIR="${VEHICLE_WATCH_QA_OUT_DIR:-$REPORT_ROOT/vehicle_watch_qa}"
INBOUND_SHADOW_OUT_DIR="${INBOUND_SHADOW_OUT_DIR:-$REPORT_ROOT/inbound_shadow}"
DETERMINISTIC_TONE_RULES_PATH="${DETERMINISTIC_TONE_RULES_PATH:-$DATA_DIR/deterministic_tone_rules.json}"
MANUAL_REPLY_EXAMPLES_PATH="${MANUAL_REPLY_EXAMPLES_PATH:-$DATA_DIR/manual_reply_examples.json}"
TONE_QUALITY_OUT_DIR="${TONE_QUALITY_OUT_DIR:-$REPORT_ROOT/tone_quality}"
VOICE_CHARTER_OUT_DIR="${VOICE_CHARTER_OUT_DIR:-$REPORT_ROOT/voice_charter}"
RELEASE_GATE_OUT_DIR="${RELEASE_GATE_OUT_DIR:-$REPORT_ROOT/release_gate}"
AGENT_MANAGER_OUT_DIR="${AGENT_MANAGER_OUT_DIR:-$REPORT_ROOT/agent_manager}"
LOG_DIR="${LOG_DIR:-$REPORT_ROOT/feedback_loop_logs}"
FEEDBACK_LOOP_ENV_PATH="${FEEDBACK_LOOP_ENV_PATH:-/home/ubuntu/throttleiq-runtime/.feedback_loop.env}"
NIGHTLY_ROLLBACK_ON_EVAL_FAIL="${NIGHTLY_ROLLBACK_ON_EVAL_FAIL:-1}"
NIGHTLY_SHADOW_REPLAY_ENABLED="${NIGHTLY_SHADOW_REPLAY_ENABLED:-1}"
NIGHTLY_SHADOW_REPLAY_PROVIDER="${NIGHTLY_SHADOW_REPLAY_PROVIDER:-all}"
NIGHTLY_SHADOW_REPLAY_LIMIT="${NIGHTLY_SHADOW_REPLAY_LIMIT:-12}"
NIGHTLY_SHADOW_REPLAY_SINCE_DAYS="${NIGHTLY_SHADOW_REPLAY_SINCE_DAYS:-1}"
NIGHTLY_SHADOW_REPLAY_MODE_MATRIX="${NIGHTLY_SHADOW_REPLAY_MODE_MATRIX:-1}"
NIGHTLY_SHADOW_REPLAY_ENV_FILE="${NIGHTLY_SHADOW_REPLAY_ENV_FILE:-}"

if [[ -f "$FEEDBACK_LOOP_ENV_PATH" ]]; then
  # Load dealer/runtime-specific feedback loop env (recipient, sender, optional attachment flags).
  set -a
  # shellcheck disable=SC1090
  source "$FEEDBACK_LOOP_ENV_PATH"
  set +a
fi

mkdir -p "$REPORT_ROOT" "$EDIT_FEEDBACK_OUT_DIR" "$LANGUAGE_CORPUS_OUT_DIR" "$VOICE_FEEDBACK_OUT_DIR" "$OUTCOME_QA_OUT_DIR" "$VEHICLE_WATCH_QA_OUT_DIR" "$INBOUND_SHADOW_OUT_DIR" "$TONE_QUALITY_OUT_DIR" "$VOICE_CHARTER_OUT_DIR" "$RELEASE_GATE_OUT_DIR" "$AGENT_MANAGER_OUT_DIR" "$LOG_DIR"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
AUDIT_JSON="$LOG_DIR/conversation_audit_$TS.json"
FOLLOWUP_TASK_AUDIT_JSON="$LOG_DIR/followup_task_consistency_$TS.json"
MINE_LOG="$LOG_DIR/edit_feedback_mine_$TS.log"
RUN_LOG="$LOG_DIR/feedback_loop_$TS.log"
WATCHDOG_JSON="$LOG_DIR/route_watchdog_$TS.json"
REPLAY_LOG="$LOG_DIR/conversation_replay_$TS.log"
ROUTE_STATE_LOG="$LOG_DIR/route_state_$TS.log"
VEHICLE_WATCH_QA_JSON="$VEHICLE_WATCH_QA_OUT_DIR/vehicle_watch_catalog_report.json"
VEHICLE_WATCH_QA_MD="$VEHICLE_WATCH_QA_OUT_DIR/vehicle_watch_catalog_report.md"
VEHICLE_WATCH_QA_LOG="$LOG_DIR/vehicle_watch_catalog_$TS.log"
INBOUND_SHADOW_RUN_OUT_DIR="$INBOUND_SHADOW_OUT_DIR/$TS"
INBOUND_SHADOW_LOG="$LOG_DIR/inbound_shadow_$TS.log"
BACKUP_DIR="$LOG_DIR/feedback_loop_nightly_backups_$TS"
mkdir -p "$BACKUP_DIR" "$INBOUND_SHADOW_RUN_OUT_DIR"

backup_runtime_file() {
  local src="$1"
  local backup="$2"
  local existed_flag_var="$3"
  if [[ -f "$src" ]]; then
    cp "$src" "$backup"
    printf -v "$existed_flag_var" "1"
    echo "[feedback-loop] backup saved: $src -> $backup"
  else
    printf -v "$existed_flag_var" "0"
    echo "[feedback-loop] backup skipped: $src did not exist before promotion"
  fi
}

restore_runtime_file() {
  local dest="$1"
  local backup="$2"
  local existed_before="$3"
  if [[ "$existed_before" == "1" ]]; then
    if [[ -f "$backup" ]]; then
      cp "$backup" "$dest"
      echo "[feedback-loop] rollback restored: $dest"
    else
      echo "[feedback-loop] rollback warning: missing backup for $dest at $backup"
      return 1
    fi
  else
    rm -f "$dest"
    echo "[feedback-loop] rollback removed newly-created file: $dest"
  fi
}

record_closed_loop_run() {
  local exit_code="$1"
  set +e
  local status="completed"
  local summary="Daily feedback loop completed. Review the attached run log and generated reports for details."
  local approval_required="0"
  local approval_reason=""
  local changed_files=""
  if [[ "$exit_code" != "0" ]]; then
    status="failed"
    summary="Daily feedback loop failed. Review the run log before relying on generated outputs."
  else
    changed_files="$(git status --short 2>/dev/null | sed 's/^...//' | head -100 || true)"
    if [[ -n "$changed_files" ]]; then
      status="needs_approval"
      approval_required="1"
      approval_reason="The feedback loop left repository changes that need review before deployment."
      summary="Daily feedback loop completed and produced changes that need approval."
    fi
  fi
  AUTOMATION_RUN_STATUS="$status" \
    AUTOMATION_RUN_NAME="Daily feedback loop" \
    AUTOMATION_RUN_SOURCE="feedback_loop" \
    AUTOMATION_RUN_SUMMARY="$summary" \
    AUTOMATION_RUN_STARTED_AT="$RUN_STARTED_AT" \
    AUTOMATION_RUN_FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    AUTOMATION_RUN_LOG_PATH="$RUN_LOG" \
    AUTOMATION_RUN_APPROVAL_REQUIRED="$approval_required" \
    AUTOMATION_RUN_APPROVAL_REASON="$approval_reason" \
    AUTOMATION_RUN_CHANGED_FILES="$changed_files" \
    npm run automation_run:record >/dev/null 2>&1 || true
}

trap 'record_closed_loop_run "$?"' EXIT

{
  echo "[feedback-loop] started at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "[feedback-loop] DATA_DIR=$DATA_DIR"
  echo "[feedback-loop] CONVERSATIONS_DB_PATH=$CONVERSATIONS_DB_PATH"
  echo "[feedback-loop] ROUTE_AUDIT_DIR=$ROUTE_AUDIT_DIR"
  echo "[feedback-loop] CHANGED_MESSAGES_PATH=$CHANGED_MESSAGES_PATH"
  echo "[feedback-loop] CHANGED_MESSAGES_SINCE_HOURS=$CHANGED_MESSAGES_SINCE_HOURS"
  echo "[feedback-loop] AUDIT_SINCE_HOURS=$AUDIT_SINCE_HOURS"
  echo "[feedback-loop] EDIT_FEEDBACK_OUT_DIR=$EDIT_FEEDBACK_OUT_DIR"
  echo "[feedback-loop] LANGUAGE_CORPUS_OUT_DIR=$LANGUAGE_CORPUS_OUT_DIR"
  echo "[feedback-loop] VOICE_FEEDBACK_OUT_DIR=$VOICE_FEEDBACK_OUT_DIR"
  echo "[feedback-loop] OUTCOME_QA_OUT_DIR=$OUTCOME_QA_OUT_DIR"
  echo "[feedback-loop] VEHICLE_WATCH_QA_OUT_DIR=$VEHICLE_WATCH_QA_OUT_DIR"
  echo "[feedback-loop] INBOUND_SHADOW_OUT_DIR=$INBOUND_SHADOW_OUT_DIR"
  echo "[feedback-loop] DETERMINISTIC_TONE_RULES_PATH=$DETERMINISTIC_TONE_RULES_PATH"
  echo "[feedback-loop] MANUAL_REPLY_EXAMPLES_PATH=$MANUAL_REPLY_EXAMPLES_PATH"
  echo "[feedback-loop] TONE_QUALITY_OUT_DIR=$TONE_QUALITY_OUT_DIR"
  echo "[feedback-loop] AGENT_MANAGER_OUT_DIR=$AGENT_MANAGER_OUT_DIR"
  echo "[feedback-loop] FEEDBACK_LOOP_ENV_PATH=$FEEDBACK_LOOP_ENV_PATH"
  echo "[feedback-loop] NIGHTLY_ROLLBACK_ON_EVAL_FAIL=$NIGHTLY_ROLLBACK_ON_EVAL_FAIL"
  echo "[feedback-loop] NIGHTLY_SHADOW_REPLAY_ENABLED=$NIGHTLY_SHADOW_REPLAY_ENABLED"
  echo "[feedback-loop] NIGHTLY_SHADOW_REPLAY_PROVIDER=$NIGHTLY_SHADOW_REPLAY_PROVIDER"
  echo "[feedback-loop] NIGHTLY_SHADOW_REPLAY_LIMIT=$NIGHTLY_SHADOW_REPLAY_LIMIT"
  echo "[feedback-loop] NIGHTLY_SHADOW_REPLAY_SINCE_DAYS=$NIGHTLY_SHADOW_REPLAY_SINCE_DAYS"
  echo "[feedback-loop] NIGHTLY_SHADOW_REPLAY_MODE_MATRIX=$NIGHTLY_SHADOW_REPLAY_MODE_MATRIX"
  echo "[feedback-loop] FEEDBACK_REPORT_EMAIL_TO=${FEEDBACK_REPORT_EMAIL_TO:-}"

  # Some scripts still read CONVERSATIONS_PATH (legacy) instead of CONVERSATIONS_DB_PATH.
  CONVERSATIONS_PATH="${CONVERSATIONS_PATH:-$CONVERSATIONS_DB_PATH}"
  export DATA_DIR CONVERSATIONS_DB_PATH CONVERSATIONS_PATH ROUTE_AUDIT_DIR CHANGED_MESSAGES_PATH CHANGED_MESSAGES_SINCE_HOURS AUDIT_SINCE_HOURS EDIT_FEEDBACK_OUT_DIR LANGUAGE_CORPUS_OUT_DIR VOICE_FEEDBACK_OUT_DIR OUTCOME_QA_OUT_DIR VEHICLE_WATCH_QA_OUT_DIR INBOUND_SHADOW_OUT_DIR DETERMINISTIC_TONE_RULES_PATH MANUAL_REPLY_EXAMPLES_PATH TONE_QUALITY_OUT_DIR VOICE_CHARTER_OUT_DIR RELEASE_GATE_OUT_DIR AGENT_MANAGER_OUT_DIR FOLLOWUP_TASK_AUDIT_JSON

  echo "[feedback-loop] step=export_changed_messages"
  npm run export:changed_messages

  echo "[feedback-loop] step=conversation_audit -> $AUDIT_JSON"
  # Use npm's silent mode so the JSON file stays valid JSON (no npm preamble lines).
  npm run -s conversation:audit > "$AUDIT_JSON"

  echo "[feedback-loop] step=followup_task_consistency_audit -> $FOLLOWUP_TASK_AUDIT_JSON"
  npm run followup_task_consistency:audit -- \
    --conversations "$CONVERSATIONS_DB_PATH" \
    --since-hours "$AUDIT_SINCE_HOURS" \
    --out "$FOLLOWUP_TASK_AUDIT_JSON"

  echo "[feedback-loop] step=edit_feedback_mine -> $MINE_LOG"
  npm run edit_feedback:mine | tee "$MINE_LOG"

  echo "[feedback-loop] step=language_corpus_mine"
  LANGUAGE_CORPUS_SINCE_HOURS="${CHANGED_MESSAGES_SINCE_HOURS}" npm run language_corpus:mine

  echo "[feedback-loop] step=voice_feedback_mine"
  VOICE_FEEDBACK_SINCE_HOURS="${CHANGED_MESSAGES_SINCE_HOURS}" npm run voice_feedback:mine -- --out-dir "$VOICE_FEEDBACK_OUT_DIR"

  echo "[feedback-loop] step=outcome_qa_audit"
  OUTCOME_QA_SINCE_HOURS="${CHANGED_MESSAGES_SINCE_HOURS}" npm run outcome_qa:audit -- \
    --conversations "$CONVERSATIONS_DB_PATH" \
    --out-dir "$OUTCOME_QA_OUT_DIR"

  echo "[feedback-loop] step=inventory_watch_snapshot_guard_eval"
  npm run inventory_watch_snapshot_guard:eval

  echo "[feedback-loop] step=web_text_widget_eval"
  npm run web_text_widget:eval

# NOTE: inbound shadow replay runs LAST (after all scorers/reports) so its
# traffic can never influence same-loop quality readings. Moved 2026-06-11
# after the CONVERSATIONS_DB_PATH leak incident.

  echo "[feedback-loop] step=vehicle_watch_catalog_eval -> $VEHICLE_WATCH_QA_JSON"
  if npm run harley_watch_model_catalog:eval -- \
    --out "$VEHICLE_WATCH_QA_JSON" \
    --markdown "$VEHICLE_WATCH_QA_MD" | tee "$VEHICLE_WATCH_QA_LOG"; then
    echo "[feedback-loop] vehicle_watch_catalog_eval=pass"
  else
    echo "[feedback-loop] vehicle_watch_catalog_eval=fail"
  fi

  # Postgres store-swap shadow gate (docs/postgres_store_swap.md): when a
  # DATABASE_URL is configured, diff the JSON file store against Postgres
  # daily. A mismatch logs pg_parity=fail but does not abort the loop.
  # Intentionally NOT keyed on DATA_BACKEND: loop env must never set a
  # non-file backend (replay/mining steps import the conversation store).
  if [[ -n "${DATABASE_URL:-}" ]]; then
    PG_PARITY_JSON="$REPORT_ROOT/pg_parity/pg_parity_report.json"
    PG_PARITY_LOG="$LOG_DIR/pg_parity_$TS.log"
    echo "[feedback-loop] step=pg_parity -> $PG_PARITY_JSON"
    if npm run pg:parity -- --out "$PG_PARITY_JSON" | tee "$PG_PARITY_LOG"; then
      echo "[feedback-loop] pg_parity=pass"
    else
      echo "[feedback-loop] pg_parity=fail"
    fi
  else
    echo "[feedback-loop] step=pg_parity skipped (DATABASE_URL not set)"
  fi

  TONE_BACKUP_PATH="$BACKUP_DIR/deterministic_tone_rules.before.json"
  MANUAL_BACKUP_PATH="$BACKUP_DIR/manual_reply_examples.before.json"
  had_tone_backup=0
  had_manual_backup=0
  echo "[feedback-loop] step=runtime_promotion_backup -> $BACKUP_DIR"
  backup_runtime_file "$DETERMINISTIC_TONE_RULES_PATH" "$TONE_BACKUP_PATH" had_tone_backup
  backup_runtime_file "$MANUAL_REPLY_EXAMPLES_PATH" "$MANUAL_BACKUP_PATH" had_manual_backup

  echo "[feedback-loop] step=deterministic_rules_promote"
  npm run deterministic_rules:promote

  echo "[feedback-loop] step=language_seed_filter"
  npm run language_seed:filter || true

  echo "[feedback-loop] step=manual_outbound_promote"
  npm run manual_outbound:promote

  echo "[feedback-loop] step=language_seed_eval"
  if npm run language_seed:eval; then
    echo "[feedback-loop] language_seed_eval=pass"
  else
    echo "[feedback-loop] language_seed_eval=fail"
    if [[ "$NIGHTLY_ROLLBACK_ON_EVAL_FAIL" == "1" ]]; then
      echo "[feedback-loop] rollback=started reason=language_seed_eval_failed"
      restore_runtime_file "$DETERMINISTIC_TONE_RULES_PATH" "$TONE_BACKUP_PATH" "$had_tone_backup" || true
      restore_runtime_file "$MANUAL_REPLY_EXAMPLES_PATH" "$MANUAL_BACKUP_PATH" "$had_manual_backup" || true
      echo "[feedback-loop] rollback=completed"
    else
      echo "[feedback-loop] rollback=skipped NIGHTLY_ROLLBACK_ON_EVAL_FAIL=$NIGHTLY_ROLLBACK_ON_EVAL_FAIL"
    fi
    exit 1
  fi

  echo "[feedback-loop] step=tone_quality_eval"
  TONE_QUALITY_SINCE_HOURS="${CHANGED_MESSAGES_SINCE_HOURS}" npm run tone_quality:eval

  echo "[feedback-loop] step=voice_charter_audit"
  VOICE_CHARTER_SINCE_HOURS="${CHANGED_MESSAGES_SINCE_HOURS}" npm run voice_charter:audit || true

  WATCHDOG_SINCE_MIN=$((AUDIT_SINCE_HOURS * 60))
  echo "[feedback-loop] step=route_watchdog -> $WATCHDOG_JSON"
  npm run route_watchdog:run -- \
    --conversations "$CONVERSATIONS_DB_PATH" \
    --route-audit-dir "$ROUTE_AUDIT_DIR" \
    --since-min "$WATCHDOG_SINCE_MIN" \
    --out "$WATCHDOG_JSON"

  echo "[feedback-loop] step=conversation_replay_eval -> $REPLAY_LOG"
  if npm run conversation_replay:eval | tee "$REPLAY_LOG"; then
    echo "[feedback-loop] conversation_replay_eval=pass"
  else
    echo "[feedback-loop] conversation_replay_eval=fail"
  fi

  echo "[feedback-loop] step=route_state_eval -> $ROUTE_STATE_LOG"
  if npm run route_state:eval | tee "$ROUTE_STATE_LOG"; then
    echo "[feedback-loop] route_state_eval=pass"
  else
    echo "[feedback-loop] route_state_eval=fail"
  fi

  echo "[feedback-loop] step=agent_manager_report"
  FOLLOWUP_TASK_AUDIT_PATH="$FOLLOWUP_TASK_AUDIT_JSON" npm run agent_manager:report -- --route-watchdog "$WATCHDOG_JSON"

  echo "[feedback-loop] step=response_latency_audit"
  LATENCY_AUDIT_OUT_DIR="$REPORT_ROOT/response_latency" npm run response_latency:audit -- \
    --store "$CONVERSATIONS_DB_PATH" --since-hours "$AUDIT_SINCE_HOURS" || true

  echo "[feedback-loop] step=agent_actions_audit"
  ACTIONS_AUDIT_OUT_DIR="$REPORT_ROOT/actions_audit" npm run agent_actions:audit -- \
    --store "$CONVERSATIONS_DB_PATH" || true

  echo "[feedback-loop] step=release_gate"
  npm run release_gate:report -- --report-root "$REPORT_ROOT" --route-watchdog "$WATCHDOG_JSON" || true

  if [[ "$NIGHTLY_SHADOW_REPLAY_ENABLED" == "1" ]]; then
    echo "[feedback-loop] step=inbound_shadow_replay -> $INBOUND_SHADOW_RUN_OUT_DIR"
    shadow_args=(
      --
      --data-dir "$DATA_DIR"
      --provider "$NIGHTLY_SHADOW_REPLAY_PROVIDER"
      --limit "$NIGHTLY_SHADOW_REPLAY_LIMIT"
      --since-days "$NIGHTLY_SHADOW_REPLAY_SINCE_DAYS"
      --out-dir "$INBOUND_SHADOW_RUN_OUT_DIR"
    )
    if [[ "$NIGHTLY_SHADOW_REPLAY_MODE_MATRIX" == "1" ]]; then
      shadow_args+=(--mode-matrix)
    fi
    if [[ -n "$NIGHTLY_SHADOW_REPLAY_ENV_FILE" ]]; then
      shadow_args+=(--env-file "$NIGHTLY_SHADOW_REPLAY_ENV_FILE")
    fi
    if npm run inbound_shadow:replay "${shadow_args[@]}" | tee "$INBOUND_SHADOW_LOG"; then
      echo "[feedback-loop] inbound_shadow_replay=pass"
    else
      echo "[feedback-loop] inbound_shadow_replay=fail"
    fi
  else
    echo "[feedback-loop] step=inbound_shadow_replay skipped"
  fi

  if [[ -n "${FEEDBACK_REPORT_EMAIL_TO:-}" || -f "${FEEDBACK_LOOP_ENV_PATH}" ]]; then
    echo "[feedback-loop] step=email_report -> ${FEEDBACK_REPORT_EMAIL_TO}"
    if FEEDBACK_LOOP_ENV_PATH="$FEEDBACK_LOOP_ENV_PATH" \
      FEEDBACK_REPORT_AUDIT_PATH="$AUDIT_JSON" \
      FEEDBACK_REPORT_FOLLOWUP_TASK_AUDIT_PATH="$FOLLOWUP_TASK_AUDIT_JSON" \
      FEEDBACK_REPORT_OUTCOME_QA_PATH="$OUTCOME_QA_OUT_DIR/outcome_qa_report.json" \
      FEEDBACK_REPORT_VEHICLE_WATCH_QA_PATH="$VEHICLE_WATCH_QA_JSON" \
      FEEDBACK_REPORT_INBOUND_SHADOW_DIR="$INBOUND_SHADOW_RUN_OUT_DIR" \
      FEEDBACK_REPORT_MINE_LOG_PATH="$MINE_LOG" \
      npm run edit_feedback:email; then
      echo "[feedback-loop] email_report=sent"
    else
      echo "[feedback-loop] email_report=fail"
    fi
  else
    echo "[feedback-loop] step=email_report skipped (missing FEEDBACK_REPORT_EMAIL_TO)"
  fi

  echo "[feedback-loop] completed at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} | tee "$RUN_LOG"
