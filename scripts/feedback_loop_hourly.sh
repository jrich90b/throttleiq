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

mkdir -p "$REPORT_ROOT" "$LANGUAGE_CORPUS_OUT_DIR" "$VOICE_FEEDBACK_OUT_DIR" "$LOG_DIR"

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
  echo "[feedback-hourly] DETERMINISTIC_RULE_PROMOTE_MIN_COUNT=$DETERMINISTIC_RULE_PROMOTE_MIN_COUNT"
  echo "[feedback-hourly] MANUAL_REPLY_PROMOTE_MIN_COUNT=$MANUAL_REPLY_PROMOTE_MIN_COUNT"
  echo "[feedback-hourly] MANUAL_REPLY_PROMOTE_MAX_PER_INTENT=$MANUAL_REPLY_PROMOTE_MAX_PER_INTENT"
  echo "[feedback-hourly] FAST_LOOP_RUN_LANGUAGE_SEED_EVAL=$FAST_LOOP_RUN_LANGUAGE_SEED_EVAL"
  echo "[feedback-hourly] FAST_LOOP_ROLLBACK_ON_EVAL_FAIL=$FAST_LOOP_ROLLBACK_ON_EVAL_FAIL"

  export DATA_DIR CONVERSATIONS_DB_PATH LANGUAGE_CORPUS_OUT_DIR VOICE_FEEDBACK_OUT_DIR DETERMINISTIC_TONE_RULES_PATH MANUAL_REPLY_EXAMPLES_PATH
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

  echo "[feedback-hourly] completed at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} | tee "$RUN_LOG"
