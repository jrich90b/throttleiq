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
TONE_QUALITY_OUT_DIR="${TONE_QUALITY_OUT_DIR:-$REPORT_ROOT/tone_quality}"
LOG_DIR="${LOG_DIR:-$REPORT_ROOT/feedback_loop_logs}"

mkdir -p "$REPORT_ROOT" "$EDIT_FEEDBACK_OUT_DIR" "$LANGUAGE_CORPUS_OUT_DIR" "$TONE_QUALITY_OUT_DIR" "$LOG_DIR"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
AUDIT_JSON="$LOG_DIR/conversation_audit_$TS.json"
MINE_LOG="$LOG_DIR/edit_feedback_mine_$TS.log"
RUN_LOG="$LOG_DIR/feedback_loop_$TS.log"
WATCHDOG_JSON="$LOG_DIR/route_watchdog_$TS.json"
REPLAY_LOG="$LOG_DIR/conversation_replay_$TS.log"
ROUTE_STATE_LOG="$LOG_DIR/route_state_$TS.log"

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
  echo "[feedback-loop] TONE_QUALITY_OUT_DIR=$TONE_QUALITY_OUT_DIR"

  export DATA_DIR CONVERSATIONS_DB_PATH ROUTE_AUDIT_DIR CHANGED_MESSAGES_PATH CHANGED_MESSAGES_SINCE_HOURS AUDIT_SINCE_HOURS EDIT_FEEDBACK_OUT_DIR LANGUAGE_CORPUS_OUT_DIR TONE_QUALITY_OUT_DIR

  echo "[feedback-loop] step=export_changed_messages"
  npm run export:changed_messages

  echo "[feedback-loop] step=conversation_audit -> $AUDIT_JSON"
  npm run conversation:audit > "$AUDIT_JSON"

  echo "[feedback-loop] step=edit_feedback_mine -> $MINE_LOG"
  npm run edit_feedback:mine | tee "$MINE_LOG"

  echo "[feedback-loop] step=language_corpus_mine"
  LANGUAGE_CORPUS_SINCE_HOURS="${CHANGED_MESSAGES_SINCE_HOURS}" npm run language_corpus:mine

  echo "[feedback-loop] step=language_seed_eval"
  npm run language_seed:eval

  echo "[feedback-loop] step=tone_quality_eval"
  TONE_QUALITY_SINCE_HOURS="${CHANGED_MESSAGES_SINCE_HOURS}" npm run tone_quality:eval

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

  if [[ -n "${FEEDBACK_REPORT_EMAIL_TO:-}" ]]; then
    echo "[feedback-loop] step=email_report -> ${FEEDBACK_REPORT_EMAIL_TO}"
    FEEDBACK_REPORT_AUDIT_PATH="$AUDIT_JSON" \
    FEEDBACK_REPORT_MINE_LOG_PATH="$MINE_LOG" \
    npm run edit_feedback:email
  else
    echo "[feedback-loop] step=email_report skipped (missing FEEDBACK_REPORT_EMAIL_TO)"
  fi

  echo "[feedback-loop] completed at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} | tee "$RUN_LOG"
