#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Deploy the LeadRider API to an always-on server such as Lightsail.

Usage:
  scripts/deploy_api_lightsail.sh --profile infra/deploy/americanharley.api.env

Common options:
  --profile PATH              Load deploy settings from a shell env file.
  --host USER@HOST            SSH target. Default: ubuntu@api.leadrider.ai
  --repo-url URL              Git repo URL. Default: https://github.com/jrich90b/throttleiq.git
  --repo PATH                 Remote repo path. Default: /home/ubuntu/throttleiq
  --branch BRANCH             Git branch to deploy. Default: main
  --data-dir PATH             Runtime DATA_DIR to back up before deploy.
  --env-file PATH             Remote API .env file to load into PM2.
  --pm2 NAME                  PM2 process name. Default: throttleiq-api
  --api-port PORT             Local API port for this dealer PM2 process.
  --health-url URL            Public API health URL to check after restart.
  --allow-dirty-remote        Allow deploying over a dirty remote worktree.
  --replace-pm2               Replace the PM2 process so it runs from this repo path.
  --skip-local-checks         Skip local API typecheck before SSH deploy.
  --backup-retention-days N   Keep ONE runtime backup per calendar day for N days. Default: 730
                              (Joe's ruling 2026-08-19: two years of history, one snapshot a day).
  --health-attempts N         Number of post-restart health attempts. Default: 15.
  --dry-run                   Check local/remote readiness without changing server.

Environment variable equivalents:
  DEPLOY_HOST, DEPLOY_REPO, DEPLOY_BRANCH, DEPLOY_DATA_DIR,
  DEPLOY_REPO_URL, DEPLOY_ENV_FILE, DEPLOY_PM2_PROCESS, DEPLOY_HEALTH_URL,
  DEPLOY_API_PORT, DEPLOY_ALLOW_DIRTY_REMOTE, DEPLOY_REPLACE_PM2,
  DEPLOY_SKIP_LOCAL_CHECKS, DEPLOY_BACKUP_RETENTION_DAYS, DEPLOY_BACKUP_EXTRA_ROOTS, DEPLOY_HEALTH_ATTEMPTS,
  DEPLOY_EXPECTED_DATA_DIR, DEPLOY_MIN_CONVERSATIONS, DEPLOY_REQUIRED_CONVERSATION_TEXT,
  DEPLOY_DRY_RUN
USAGE
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
profile=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      profile="${2:-}"
      shift 2
      ;;
    --host)
      DEPLOY_HOST="${2:-}"
      shift 2
      ;;
    --repo)
      DEPLOY_REPO="${2:-}"
      shift 2
      ;;
    --repo-url)
      DEPLOY_REPO_URL="${2:-}"
      shift 2
      ;;
    --branch)
      DEPLOY_BRANCH="${2:-}"
      shift 2
      ;;
    --data-dir)
      DEPLOY_DATA_DIR="${2:-}"
      shift 2
      ;;
    --env-file)
      DEPLOY_ENV_FILE="${2:-}"
      shift 2
      ;;
    --pm2)
      DEPLOY_PM2_PROCESS="${2:-}"
      shift 2
      ;;
    --api-port)
      DEPLOY_API_PORT="${2:-}"
      shift 2
      ;;
    --health-url)
      DEPLOY_HEALTH_URL="${2:-}"
      shift 2
      ;;
    --allow-dirty-remote)
      DEPLOY_ALLOW_DIRTY_REMOTE=1
      shift
      ;;
    --replace-pm2)
      DEPLOY_REPLACE_PM2=1
      shift
      ;;
    --skip-local-checks)
      DEPLOY_SKIP_LOCAL_CHECKS=1
      shift
      ;;
    --backup-retention-days)
      DEPLOY_BACKUP_RETENTION_DAYS="${2:-}"
      shift 2
      ;;
    --health-attempts)
      DEPLOY_HEALTH_ATTEMPTS="${2:-}"
      shift 2
      ;;
    --dry-run)
      DEPLOY_DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -n "$profile" ]]; then
  if [[ ! -f "$profile" ]]; then
    echo "Profile not found: $profile" >&2
    exit 2
  fi
  # shellcheck disable=SC1090
  source "$profile"
fi

DEPLOY_HOST="${DEPLOY_HOST:-ubuntu@api.leadrider.ai}"
DEPLOY_REPO_URL="${DEPLOY_REPO_URL:-https://github.com/jrich90b/throttleiq.git}"
DEPLOY_REPO="${DEPLOY_REPO:-/home/ubuntu/throttleiq}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
DEPLOY_DATA_DIR="${DEPLOY_DATA_DIR:-/home/ubuntu/throttleiq-runtime/data}"
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-$DEPLOY_REPO/services/api/.env}"
DEPLOY_PM2_PROCESS="${DEPLOY_PM2_PROCESS:-throttleiq-api}"
DEPLOY_WORKER_PM2_PROCESS="${DEPLOY_WORKER_PM2_PROCESS:-}"
DEPLOY_RESTART_WORKER="${DEPLOY_RESTART_WORKER:-1}"
DEPLOY_API_PORT="${DEPLOY_API_PORT:-}"
DEPLOY_HEALTH_URL="${DEPLOY_HEALTH_URL:-https://api.leadrider.ai/health}"
DEPLOY_ALLOW_DIRTY_REMOTE="${DEPLOY_ALLOW_DIRTY_REMOTE:-0}"
DEPLOY_REPLACE_PM2="${DEPLOY_REPLACE_PM2:-0}"
DEPLOY_SKIP_LOCAL_CHECKS="${DEPLOY_SKIP_LOCAL_CHECKS:-0}"
DEPLOY_BACKUP_RETENTION_DAYS="${DEPLOY_BACKUP_RETENTION_DAYS:-730}"
DEPLOY_BACKUP_EXTRA_ROOTS="${DEPLOY_BACKUP_EXTRA_ROOTS:-}"
# Post-restart health budget. MEASURED 2026-08-20: this API takes ~65s to serve after a restart
# (it loads 879 conversations from a 13.5 MB store before it listens), and the old budget was 15
# attempts x 3s = 45s. So BOTH deploys that day printed "API health check failed after deploy" and
# exited 23 on a deploy that was healthy seconds later. A false failure is worse than a slow true
# one: it invites someone to revert a good deploy, and it trains everyone to stop reading deploy
# output. 80 x 3s = a ~4 minute window, ~3.7x the measured boot. A genuinely dead build still fails,
# just four minutes later.
DEPLOY_HEALTH_ATTEMPTS="${DEPLOY_HEALTH_ATTEMPTS:-80}"
DEPLOY_HEALTH_RETRY_SLEEP_SECONDS="${DEPLOY_HEALTH_RETRY_SLEEP_SECONDS:-3}"
DEPLOY_EXPECTED_DATA_DIR="${DEPLOY_EXPECTED_DATA_DIR:-}"
DEPLOY_MIN_CONVERSATIONS="${DEPLOY_MIN_CONVERSATIONS:-}"
DEPLOY_REQUIRED_CONVERSATION_TEXT="${DEPLOY_REQUIRED_CONVERSATION_TEXT:-}"
# Build mode: "local" builds dist on the operator machine and rsyncs the
# artifact (the 2GB Lightsail box swap-thrashed into a 14-minute outage
# building tsc in place on 2026-06-11). "remote" builds on the server with a
# capped, niced heap - only for first-time provisioning or bigger hosts.
DEPLOY_BUILD_MODE="${DEPLOY_BUILD_MODE:-local}"
DEPLOY_REMOTE_BUILD_HEAP_MB="${DEPLOY_REMOTE_BUILD_HEAP_MB:-1408}"
DEPLOY_DRY_RUN="${DEPLOY_DRY_RUN:-0}"

# --- Single-deploy mutex -------------------------------------------------------
# Two routines can deploy the API (the supervised morning routine + the unattended
# loop-runner), possibly on the same machine, and they share the SAME remote target
# (rsync of dist + `pm2 restart`). A concurrent deploy races on the artifact and the
# process restart. Serialize with an atomic mkdir lock (portable — macOS has no
# `flock`); a real deploy aborts cleanly if another holds it. A stale lock whose
# holder PID is gone is reclaimed. Skipped for --dry-run (read-only). Override the
# path with DEPLOY_LOCK_DIR.
DEPLOY_LOCK_DIR="${DEPLOY_LOCK_DIR:-${TMPDIR:-/tmp}/throttleiq-deploy-api.lock}"
acquire_deploy_lock() {
  if mkdir "$DEPLOY_LOCK_DIR" 2>/dev/null; then
    echo "$$" >"$DEPLOY_LOCK_DIR/pid" 2>/dev/null || true
    trap 'rm -rf "$DEPLOY_LOCK_DIR" 2>/dev/null || true' EXIT
    echo "Acquired deploy lock ($DEPLOY_LOCK_DIR)."
    return 0
  fi
  local holder
  holder="$(cat "$DEPLOY_LOCK_DIR/pid" 2>/dev/null || echo "")"
  if [[ -n "$holder" ]] && kill -0 "$holder" 2>/dev/null; then
    echo "ERROR: another API deploy (pid $holder) is already running — lock: $DEPLOY_LOCK_DIR." >&2
    echo "Aborting to avoid a concurrent rsync/pm2 restart race. Wait for it to finish, or if you're certain none is running, remove the lock dir and retry." >&2
    exit 1
  fi
  echo "WARN: reclaiming a stale deploy lock (holder pid ${holder:-unknown} not running)." >&2
  rm -rf "$DEPLOY_LOCK_DIR"
  if ! mkdir "$DEPLOY_LOCK_DIR" 2>/dev/null; then
    echo "ERROR: could not acquire the deploy lock after reclaiming a stale one — another deploy raced in. Aborting." >&2
    exit 1
  fi
  echo "$$" >"$DEPLOY_LOCK_DIR/pid" 2>/dev/null || true
  trap 'rm -rf "$DEPLOY_LOCK_DIR" 2>/dev/null || true' EXIT
  echo "Acquired deploy lock ($DEPLOY_LOCK_DIR) after reclaiming a stale one."
}
if [[ "$DEPLOY_DRY_RUN" != "1" ]]; then
  acquire_deploy_lock
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 2
  }
}

shell_quote() {
  printf "%q" "$1"
}

require_cmd git
require_cmd ssh
require_cmd npm

cd "$repo_root"

echo "LeadRider API deploy"
echo "  host:       $DEPLOY_HOST"
echo "  repo url:   $DEPLOY_REPO_URL"
echo "  branch:     $DEPLOY_BRANCH"
echo "  repo:       $DEPLOY_REPO"
echo "  data dir:   $DEPLOY_DATA_DIR"
echo "  env file:   $DEPLOY_ENV_FILE"
echo "  pm2:        $DEPLOY_PM2_PROCESS"
if [[ -n "$DEPLOY_API_PORT" ]]; then
  echo "  api port:   $DEPLOY_API_PORT"
fi
echo "  health:     $DEPLOY_HEALTH_URL"
echo "  attempts:   $DEPLOY_HEALTH_ATTEMPTS (~$((DEPLOY_HEALTH_ATTEMPTS * DEPLOY_HEALTH_RETRY_SLEEP_SECONDS))s window)"
echo "  replace pm2:$DEPLOY_REPLACE_PM2"
echo "  backups:    one per day for $DEPLOY_BACKUP_RETENTION_DAYS days"
if [[ -n "$DEPLOY_EXPECTED_DATA_DIR" ]]; then
  echo "  expect dir: $DEPLOY_EXPECTED_DATA_DIR"
fi
if [[ -n "$DEPLOY_MIN_CONVERSATIONS" ]]; then
  echo "  min convs:  $DEPLOY_MIN_CONVERSATIONS"
fi
echo

if [[ "$DEPLOY_BUILD_MODE" == "local" ]]; then
  echo "Building API locally (artifact deploy)..."
  npm --workspace @throttleiq/api run build
  # The worker ships its own dist and is the ONLY tick source when WORKER_DRIVEN_TICKS=1.
  # Until 2026-07-31 this script built just the API, so the box ran a 2026-06-10 worker build and
  # three minute-lane jobs (task-escalations, gate-blocker-digest, photo-delivery) were dead.
  echo "Building worker locally (artifact deploy)..."
  npm --workspace @throttleiq/worker run build
  if [[ ! -f "$repo_root/services/worker/dist/index.js" ]]; then
    echo "Local worker build produced no dist/index.js" >&2
    exit 25
  fi
  if [[ ! -f "$repo_root/services/api/dist/index.js" ]]; then
    echo "Local build produced no dist/index.js" >&2
    exit 25
  fi
  if [[ "$DEPLOY_DRY_RUN" != "1" ]]; then
    git fetch origin "$DEPLOY_BRANCH"
    local_head="$(git rev-parse HEAD)"
    origin_head="$(git rev-parse "origin/$DEPLOY_BRANCH")"
    if [[ "$local_head" != "$origin_head" ]]; then
      echo "Local HEAD ($local_head) != origin/$DEPLOY_BRANCH ($origin_head)." >&2
      echo "Artifact deploys ship the LOCAL build for the remote checkout - push/pull first." >&2
      exit 26
    fi
    if [[ -n "$(git status --porcelain services/api services/worker packages 2>/dev/null)" ]]; then
      echo "Local services/api, services/worker or packages tree is dirty; artifact would not match origin/$DEPLOY_BRANCH." >&2
      exit 27
    fi
  fi
elif [[ "$DEPLOY_SKIP_LOCAL_CHECKS" != "1" ]]; then
  echo "Running local API typecheck..."
  npm --workspace @throttleiq/api run build -- --noEmit
fi

remote_env=(
  "DEPLOY_REPO=$(shell_quote "$DEPLOY_REPO")"
  "DEPLOY_REPO_URL=$(shell_quote "$DEPLOY_REPO_URL")"
  "DEPLOY_BRANCH=$(shell_quote "$DEPLOY_BRANCH")"
  "DEPLOY_DATA_DIR=$(shell_quote "$DEPLOY_DATA_DIR")"
  "DEPLOY_ENV_FILE=$(shell_quote "$DEPLOY_ENV_FILE")"
  "DEPLOY_PM2_PROCESS=$(shell_quote "$DEPLOY_PM2_PROCESS")"
  "DEPLOY_WORKER_PM2_PROCESS=$(shell_quote "$DEPLOY_WORKER_PM2_PROCESS")"
  "DEPLOY_RESTART_WORKER=$(shell_quote "$DEPLOY_RESTART_WORKER")"
  "DEPLOY_API_PORT=$(shell_quote "$DEPLOY_API_PORT")"
  "DEPLOY_HEALTH_URL=$(shell_quote "$DEPLOY_HEALTH_URL")"
  "DEPLOY_HEALTH_ATTEMPTS=$(shell_quote "$DEPLOY_HEALTH_ATTEMPTS")"
  "DEPLOY_HEALTH_RETRY_SLEEP_SECONDS=$(shell_quote "$DEPLOY_HEALTH_RETRY_SLEEP_SECONDS")"
  "DEPLOY_ALLOW_DIRTY_REMOTE=$(shell_quote "$DEPLOY_ALLOW_DIRTY_REMOTE")"
  "DEPLOY_REPLACE_PM2=$(shell_quote "$DEPLOY_REPLACE_PM2")"
  "DEPLOY_BACKUP_RETENTION_DAYS=$(shell_quote "$DEPLOY_BACKUP_RETENTION_DAYS")"
  "DEPLOY_BACKUP_EXTRA_ROOTS=$(shell_quote "$DEPLOY_BACKUP_EXTRA_ROOTS")"
  "DEPLOY_EXPECTED_DATA_DIR=$(shell_quote "$DEPLOY_EXPECTED_DATA_DIR")"
  "DEPLOY_MIN_CONVERSATIONS=$(shell_quote "$DEPLOY_MIN_CONVERSATIONS")"
  "DEPLOY_REQUIRED_CONVERSATION_TEXT=$(shell_quote "$DEPLOY_REQUIRED_CONVERSATION_TEXT")"
  "DEPLOY_DRY_RUN=$(shell_quote "$DEPLOY_DRY_RUN")"
  "DEPLOY_BUILD_MODE=$(shell_quote "$DEPLOY_BUILD_MODE")"
  "DEPLOY_REMOTE_BUILD_HEAP_MB=$(shell_quote "$DEPLOY_REMOTE_BUILD_HEAP_MB")"
)

if [[ "$DEPLOY_BUILD_MODE" == "local" && "$DEPLOY_DRY_RUN" != "1" ]]; then
  echo "Uploading dist artifact..."
  if ! rsync -az --delete "$repo_root/services/api/dist/" "$DEPLOY_HOST:$DEPLOY_REPO/services/api/dist/"; then
    echo "Artifact upload failed. For first-time provisioning (no remote repo yet)," >&2
    echo "run once with DEPLOY_BUILD_MODE=remote on a host with enough memory." >&2
    exit 28
  fi
  if ! rsync -az --delete "$repo_root/services/worker/dist/" "$DEPLOY_HOST:$DEPLOY_REPO/services/worker/dist/"; then
    echo "Worker artifact upload failed." >&2
    exit 28
  fi
fi

ssh "$DEPLOY_HOST" "${remote_env[*]} bash -s" <<'REMOTE'
set -euo pipefail

echo "Checking remote repo..."
if [[ ! -d "$DEPLOY_REPO/.git" ]]; then
  if [[ "$DEPLOY_DRY_RUN" == "1" ]]; then
    echo "Remote repo missing. Dry run would clone $DEPLOY_REPO_URL into $DEPLOY_REPO."
    echo "Dry run complete. No server changes made."
    exit 0
  fi
  echo "Remote repo missing. Cloning $DEPLOY_REPO_URL into $DEPLOY_REPO"
  mkdir -p "$(dirname "$DEPLOY_REPO")"
  git clone --branch "$DEPLOY_BRANCH" "$DEPLOY_REPO_URL" "$DEPLOY_REPO"
fi

cd "$DEPLOY_REPO"
git fetch origin "$DEPLOY_BRANCH"

current_branch="$(git branch --show-current || true)"
if [[ "$current_branch" != "$DEPLOY_BRANCH" ]]; then
  echo "Remote checkout is on '$current_branch'. Switching to '$DEPLOY_BRANCH'."
  git checkout "$DEPLOY_BRANCH"
fi

dirty="$(git status --porcelain --untracked-files=all)"
if [[ -n "$dirty" && "$DEPLOY_ALLOW_DIRTY_REMOTE" != "1" ]]; then
  echo "Remote worktree has uncommitted files. Deployment stopped." >&2
  echo "$dirty" >&2
  echo "" >&2
  echo "Resolve this once by committing, stashing, or moving runtime/generated files out of the repo." >&2
  echo "Use --allow-dirty-remote only for an intentional emergency deploy." >&2
  exit 21
fi

echo "Remote current commit: $(git rev-parse --short HEAD)"
echo "Remote target commit:  $(git rev-parse --short "origin/$DEPLOY_BRANCH")"

if [[ "$DEPLOY_DRY_RUN" == "1" ]]; then
  echo "Dry run complete. No server changes made."
  exit 0
fi

if [[ -n "$DEPLOY_EXPECTED_DATA_DIR" && "$DEPLOY_DATA_DIR" != "$DEPLOY_EXPECTED_DATA_DIR" ]]; then
  echo "Deploy data dir mismatch." >&2
  echo "  expected: $DEPLOY_EXPECTED_DATA_DIR" >&2
  echo "  actual:   $DEPLOY_DATA_DIR" >&2
  exit 24
fi

conversation_count() {
  local store_path="$1"
  node - "$store_path" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
try {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const conversations = Array.isArray(parsed?.conversations)
    ? parsed.conversations
    : Object.values(parsed?.conversations || {});
  console.log(conversations.length);
} catch (error) {
  console.error(error?.message || error);
  process.exit(1);
}
NODE
}

conversation_contains_text() {
  local store_path="$1"
  local needle="$2"
  node - "$store_path" "$needle" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const needle = String(process.argv[3] || "").toLowerCase();
try {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const conversations = Array.isArray(parsed?.conversations)
    ? parsed.conversations
    : Object.values(parsed?.conversations || {});
  const found = conversations.some(conv => JSON.stringify(conv).toLowerCase().includes(needle));
  process.exit(found ? 0 : 1);
} catch (error) {
  console.error(error?.message || error);
  process.exit(1);
}
NODE
}

run_conversation_store_sanity() {
  local label="$1"
  local store_path="$DEPLOY_DATA_DIR/conversations.json"
  if [[ ! -f "$store_path" ]]; then
    if [[ -n "$DEPLOY_MIN_CONVERSATIONS" || -n "$DEPLOY_REQUIRED_CONVERSATION_TEXT" ]]; then
      echo "Conversation sanity failed ($label): missing $store_path" >&2
      return 1
    fi
    return 0
  fi
  local count
  if ! count="$(conversation_count "$store_path")"; then
    echo "Conversation sanity failed ($label): could not read $store_path" >&2
    return 1
  fi
  echo "Conversation sanity ($label): $count conversations in $store_path"
  if [[ -n "$DEPLOY_MIN_CONVERSATIONS" ]]; then
    if [[ ! "$DEPLOY_MIN_CONVERSATIONS" =~ ^[0-9]+$ ]]; then
      echo "Invalid DEPLOY_MIN_CONVERSATIONS: $DEPLOY_MIN_CONVERSATIONS" >&2
      return 1
    fi
    if [[ "$count" -lt "$DEPLOY_MIN_CONVERSATIONS" ]]; then
      echo "Conversation sanity failed ($label): count $count is below $DEPLOY_MIN_CONVERSATIONS" >&2
      return 1
    fi
  fi
  if [[ -n "$DEPLOY_REQUIRED_CONVERSATION_TEXT" ]]; then
    if ! conversation_contains_text "$store_path" "$DEPLOY_REQUIRED_CONVERSATION_TEXT"; then
      echo "Conversation sanity failed ($label): required text not found: $DEPLOY_REQUIRED_CONVERSATION_TEXT" >&2
      return 1
    fi
  fi
  return 0
}

if ! run_conversation_store_sanity "pre-deploy"; then
  exit 24
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_root="$(dirname "$DEPLOY_DATA_DIR")/backups"
mkdir -p "$backup_root"
if [[ -d "$DEPLOY_DATA_DIR" ]]; then
  backup_path="$backup_root/data-$timestamp.tgz"
  echo "Backing up runtime data to $backup_path"
  set +e
  tar -czf "$backup_path" -C "$(dirname "$DEPLOY_DATA_DIR")" "$(basename "$DEPLOY_DATA_DIR")"
  tar_status=$?
  set -e
  if [[ "$tar_status" -eq 1 && -s "$backup_path" ]]; then
    echo "Runtime data changed during backup; keeping completed live-data backup with warning."
  elif [[ "$tar_status" -ne 0 ]]; then
    echo "Runtime data backup failed with status $tar_status." >&2
    exit "$tar_status"
  fi
else
  echo "Runtime data dir does not exist yet: $DEPLOY_DATA_DIR"
fi

# ── Backup retention: ONE SNAPSHOT PER CALENDAR DAY, kept for DEPLOY_BACKUP_RETENTION_DAYS ──────
#
# JOE'S RULING, 2026-08-19: "2 years" of backup history. The obvious implementation — delete
# anything older than 2 years — frees ZERO bytes, because nothing on the box is that old. Measured
# the same day: all six americanharley tarballs were from that single afternoon, ~1.73 GB each.
#
# The waste is SAME-DAY DUPLICATES. This script snapshots before every deploy and the API deploys
# 8-17x/day, so a keep-newest-N rule (N was 12) holds less than one day of history in ~20 GB and
# throws away every earlier day. Both halves are backwards: too many copies of today, none of last
# week. One-per-day-for-2-years keeps a restore point for EVERY day ever backed up — strictly more
# history than the age rule alone — and freed ~9.9 GB when the policy was written.
#
# Why it matters beyond tidiness: a full disk fails the deploy, and a deploy that dies inside the
# 08:50-08:55Z cron window kills the overnight detector sweeps, whose only symptom is a stale report
# that reads exactly like a quiet store.
#
# FAIL DIRECTION IS KEEP. The day comes from the FILENAME (data-YYYYMMDDTHHMMSSZ.tgz), never mtime,
# so a touched file cannot change which day it belongs to; a name that does not parse is KEPT; the
# newest snapshot of each day is KEPT (it is the state closest to the deploy that followed it); and
# the backup this run just wrote is never a deletion candidate.
prune_backup_root() {
  local root="$1"
  [[ -d "$root" ]] || { echo "  (no backup root at $root - nothing to prune)"; return 0; }

  # The cutoff as a YYYYMMDD stamp, so the comparison is plain string arithmetic on the filename's
  # own day. GNU date first, BSD second - this function must run identically on the Linux box and
  # in the eval on a Mac, or the eval proves nothing (SKILL trap 3).
  local cutoff_day
  cutoff_day="$(date -u -d "-${DEPLOY_BACKUP_RETENTION_DAYS} days" +%Y%m%d 2>/dev/null \
    || date -u -v-"${DEPLOY_BACKUP_RETENTION_DAYS}"d +%Y%m%d 2>/dev/null || echo "")"
  if [[ -z "$cutoff_day" ]]; then
    echo "  WARN: could not compute a retention cutoff - keeping everything in $root." >&2
    return 0
  fi

  # Names sort chronologically, so the LAST name of each day is that day's newest snapshot.
  # awk's associative array keeps this working on bash 3.2 (macOS) as well as 5.x (the box).
  local keepers
  keepers="$(find "$root" -maxdepth 1 -type f -name 'data-*.tgz' -exec basename {} \; \
    | grep -E '^data-[0-9]{8}T[0-9]{6}Z\.tgz$' \
    | sort \
    | awk '{ last[substr($0, 6, 8)] = $0 } END { for (d in last) print last[d] }' \
    | sort)"

  local deleted=0 kept=0 file base day
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    base="$(basename "$file")"
    # An unparseable name is history we cannot reason about - KEEP it.
    grep -qE '^data-[0-9]{8}T[0-9]{6}Z\.tgz$' <<< "$base" || continue
    [[ "$file" == "${backup_path:-}" ]] && continue          # never the snapshot we just wrote
    day="${base:5:8}"
    if ! grep -qxF "$base" <<< "$keepers"; then
      rm -f "$file"; deleted=$((deleted + 1))                # a same-day duplicate
      continue
    fi
    if [[ "$day" < "$cutoff_day" ]]; then
      rm -f "$file"; deleted=$((deleted + 1))                # past the retention horizon
      continue
    fi
    kept=$((kept + 1))
  done < <(find "$root" -maxdepth 1 -type f -name 'data-*.tgz')

  echo "  $root: kept $kept daily snapshot(s), pruned $deleted."
}

if [[ "$DEPLOY_BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ && "$DEPLOY_BACKUP_RETENTION_DAYS" -gt 0 ]]; then
  echo "Pruning runtime backups; keeping ONE per day for $DEPLOY_BACKUP_RETENTION_DAYS days"
  prune_backup_root "$backup_root"
  # The base lane (throttleiq-runtime/backups) is never deployed to, so nothing else would ever
  # prune it — three of its seven tarballs were 23 May and three more 4 June. Joe's ruling covers
  # BOTH roots. Colon-separated; empty by default so a plain run touches only its own root.
  # NOTE the decoy: <dataDir>/backups is a DIFFERENT, harmless directory — do not add it here.
  if [[ -n "${DEPLOY_BACKUP_EXTRA_ROOTS:-}" ]]; then
    while IFS= read -r extra_root; do
      [[ -n "$extra_root" ]] || continue
      [[ "$extra_root" == "$backup_root" ]] && continue
      prune_backup_root "$extra_root"
    done < <(tr ':' '\n' <<< "$DEPLOY_BACKUP_EXTRA_ROOTS")
  fi
fi

echo "Updating code with fast-forward pull..."
git pull --ff-only origin "$DEPLOY_BRANCH"

echo "Installing dependencies..."
npm ci

if [[ "$DEPLOY_BUILD_MODE" == "local" ]]; then
  echo "Artifact mode: using uploaded dist (skipping on-box build)."
  if [[ ! -f "$DEPLOY_REPO/services/api/dist/index.js" ]]; then
    echo "Uploaded dist/index.js missing - aborting before restart." >&2
    exit 29
  fi
else
  echo "Building API on the server (heap ${DEPLOY_REMOTE_BUILD_HEAP_MB}MB, niced)..."
  (cd "$DEPLOY_REPO/services/api" && nice -n 15 node --max-old-space-size="$DEPLOY_REMOTE_BUILD_HEAP_MB" ../../node_modules/typescript/bin/tsc -p tsconfig.json)
fi

# Build the WORKER too. It runs `node dist/index.js`, and this script used to build only the API —
# so every change under services/worker/src silently never took effect. Harmless while the worker
# was a shadow; a live outage the moment WORKER_DRIVEN_TICKS=1 flipped (2026-07-30) and disabled
# the API's in-process ticks, because the worker became the ONLY path. Found 2026-07-31 with the
# worker still running a 2026-06-10 build: it scheduled 4 of the 8 minute-lane tasks, so
# task-escalations, gate-blocker-digest and photo-delivery had been dead for ~24h.
# The worker is small (2 files) so this costs seconds and needs no heap tuning.
if [[ -f "$DEPLOY_REPO/services/worker/tsconfig.json" ]]; then
  echo "Building worker on the server..."
  (cd "$DEPLOY_REPO" && nice -n 15 npm --workspace @throttleiq/worker run build)
fi

if [[ ! -f "$DEPLOY_ENV_FILE" ]]; then
  echo "Remote env file missing: $DEPLOY_ENV_FILE" >&2
  exit 22
fi

echo "Loading API env and restarting PM2..."
eval "$(
python3 - "$DEPLOY_ENV_FILE" <<'PY'
import shlex
import sys

path = sys.argv[1]
for raw in open(path):
    line = raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    key = key.strip()
    if not key:
        continue
    print(f"export {key}={shlex.quote(value)}")
PY
)"
mkdir -p "$DEPLOY_DATA_DIR"
export DATA_DIR="$DEPLOY_DATA_DIR"
export NODE_ENV="${NODE_ENV:-production}"
if [[ -n "$DEPLOY_API_PORT" && -z "${PORT:-}" ]]; then
  export PORT="$DEPLOY_API_PORT"
fi
if [[ -n "${PORT:-}" ]]; then
  echo "API process port: $PORT"
fi

if [[ "$DEPLOY_REPLACE_PM2" == "1" ]] && pm2 describe "$DEPLOY_PM2_PROCESS" >/dev/null 2>&1; then
  echo "Replacing PM2 process so it runs from $DEPLOY_REPO..."
  pm2 delete "$DEPLOY_PM2_PROCESS"
fi

if pm2 describe "$DEPLOY_PM2_PROCESS" >/dev/null 2>&1; then
  pm2 restart "$DEPLOY_PM2_PROCESS" --update-env
else
  pm2 start npm --name "$DEPLOY_PM2_PROCESS" --cwd "$DEPLOY_REPO" -- --workspace @throttleiq/api run start
fi

# Restart the worker so a freshly built dist actually takes effect. Skipped when the process does
# not exist (single-process installs). Never CREATES it — provisioning a worker is a deliberate
# ops step, and quietly starting a second tick source would double every background job.
if [[ "${DEPLOY_RESTART_WORKER:-1}" == "1" && -n "${DEPLOY_WORKER_PM2_PROCESS:-}" ]] &&
  pm2 describe "$DEPLOY_WORKER_PM2_PROCESS" >/dev/null 2>&1; then
  echo "Restarting worker process $DEPLOY_WORKER_PM2_PROCESS..."
  pm2 restart "$DEPLOY_WORKER_PM2_PROCESS" --update-env
fi
pm2 save >/dev/null

echo "Checking API health..."
if [[ ! "$DEPLOY_HEALTH_ATTEMPTS" =~ ^[0-9]+$ || "$DEPLOY_HEALTH_ATTEMPTS" -lt 1 ]]; then
  DEPLOY_HEALTH_ATTEMPTS=80
fi
if [[ ! "$DEPLOY_HEALTH_RETRY_SLEEP_SECONDS" =~ ^[0-9]+$ || "$DEPLOY_HEALTH_RETRY_SLEEP_SECONDS" -lt 1 ]]; then
  DEPLOY_HEALTH_RETRY_SLEEP_SECONDS=3
fi
for ((attempt = 1; attempt <= DEPLOY_HEALTH_ATTEMPTS; attempt += 1)); do
  if curl -fsS "$DEPLOY_HEALTH_URL" >/tmp/leadrider-api-health.json; then
    cat /tmp/leadrider-api-health.json
    echo
    if ! run_conversation_store_sanity "post-restart"; then
      echo "Post-restart data sanity failed. Stopping API to prevent writes against a bad store." >&2
      pm2 stop "$DEPLOY_PM2_PROCESS" || true
      pm2 logs "$DEPLOY_PM2_PROCESS" --lines 80 --nostream --no-color || true
      exit 24
    fi
    echo "Deploy complete."
    exit 0
  fi
  echo "Health check attempt $attempt failed; retrying..."
  sleep "$DEPLOY_HEALTH_RETRY_SLEEP_SECONDS"
done

echo "API health check failed after deploy — waited ~$((DEPLOY_HEALTH_ATTEMPTS * DEPLOY_HEALTH_RETRY_SLEEP_SECONDS))s." >&2
echo "Before treating this as a bad build, CHECK THE PUBLIC HEALTH URL yourself ($DEPLOY_HEALTH_URL):" >&2
echo "a slow boot has produced this message on a deploy that was serving moments later." >&2
pm2 status "$DEPLOY_PM2_PROCESS" --no-color || true
pm2 logs "$DEPLOY_PM2_PROCESS" --lines 80 --nostream --no-color || true
exit 23
REMOTE
