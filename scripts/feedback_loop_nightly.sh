#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DATA_DIR="${DATA_DIR:-/home/ubuntu/throttleiq-runtime/data}"
CONVERSATIONS_DB_PATH="${CONVERSATIONS_DB_PATH:-$DATA_DIR/conversations.json}"
REPORT_ROOT="${REPORT_ROOT:-/home/ubuntu/throttleiq-runtime/reports}"
CHANGED_MESSAGES_PATH="${CHANGED_MESSAGES_PATH:-$REPORT_ROOT/changed_messages_all.json}"
EDIT_FEEDBACK_OUT_DIR="${EDIT_FEEDBACK_OUT_DIR:-$REPORT_ROOT/edit_feedback}"
LOG_DIR="${LOG_DIR:-$REPORT_ROOT/feedback_loop_logs}"

mkdir -p "$REPORT_ROOT" "$EDIT_FEEDBACK_OUT_DIR" "$LOG_DIR"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
AUDIT_JSON="$LOG_DIR/conversation_audit_$TS.json"
MINE_LOG="$LOG_DIR/edit_feedback_mine_$TS.log"
RUN_LOG="$LOG_DIR/feedback_loop_$TS.log"

{
  echo "[feedback-loop] started at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "[feedback-loop] DATA_DIR=$DATA_DIR"
  echo "[feedback-loop] CONVERSATIONS_DB_PATH=$CONVERSATIONS_DB_PATH"
  echo "[feedback-loop] CHANGED_MESSAGES_PATH=$CHANGED_MESSAGES_PATH"
  echo "[feedback-loop] EDIT_FEEDBACK_OUT_DIR=$EDIT_FEEDBACK_OUT_DIR"

  export DATA_DIR CONVERSATIONS_DB_PATH CHANGED_MESSAGES_PATH EDIT_FEEDBACK_OUT_DIR

  echo "[feedback-loop] step=export_changed_messages"
  npm run export:changed_messages

  echo "[feedback-loop] step=conversation_audit -> $AUDIT_JSON"
  npm run conversation:audit > "$AUDIT_JSON"

  echo "[feedback-loop] step=edit_feedback_mine -> $MINE_LOG"
  npm run edit_feedback:mine | tee "$MINE_LOG"

  if [[ -n "${FEEDBACK_REPORT_EMAIL_TO:-}" && -n "${SENDGRID_API_KEY:-}" ]]; then
    echo "[feedback-loop] step=email_report -> ${FEEDBACK_REPORT_EMAIL_TO}"
    FEEDBACK_REPORT_AUDIT_PATH="$AUDIT_JSON" \
    FEEDBACK_REPORT_MINE_LOG_PATH="$MINE_LOG" \
    npm run edit_feedback:email
  else
    echo "[feedback-loop] step=email_report skipped (missing FEEDBACK_REPORT_EMAIL_TO or SENDGRID_API_KEY)"
  fi

  echo "[feedback-loop] completed at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} | tee "$RUN_LOG"

