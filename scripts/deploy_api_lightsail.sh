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
  --dry-run                   Check local/remote readiness without changing server.

Environment variable equivalents:
  DEPLOY_HOST, DEPLOY_REPO, DEPLOY_BRANCH, DEPLOY_DATA_DIR,
  DEPLOY_REPO_URL, DEPLOY_ENV_FILE, DEPLOY_PM2_PROCESS, DEPLOY_HEALTH_URL,
  DEPLOY_API_PORT, DEPLOY_ALLOW_DIRTY_REMOTE, DEPLOY_REPLACE_PM2,
  DEPLOY_SKIP_LOCAL_CHECKS, DEPLOY_DRY_RUN
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
DEPLOY_API_PORT="${DEPLOY_API_PORT:-}"
DEPLOY_HEALTH_URL="${DEPLOY_HEALTH_URL:-https://api.leadrider.ai/health}"
DEPLOY_ALLOW_DIRTY_REMOTE="${DEPLOY_ALLOW_DIRTY_REMOTE:-0}"
DEPLOY_REPLACE_PM2="${DEPLOY_REPLACE_PM2:-0}"
DEPLOY_SKIP_LOCAL_CHECKS="${DEPLOY_SKIP_LOCAL_CHECKS:-0}"
DEPLOY_DRY_RUN="${DEPLOY_DRY_RUN:-0}"

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
echo "  replace pm2:$DEPLOY_REPLACE_PM2"
echo

if [[ "$DEPLOY_SKIP_LOCAL_CHECKS" != "1" ]]; then
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
  "DEPLOY_API_PORT=$(shell_quote "$DEPLOY_API_PORT")"
  "DEPLOY_HEALTH_URL=$(shell_quote "$DEPLOY_HEALTH_URL")"
  "DEPLOY_ALLOW_DIRTY_REMOTE=$(shell_quote "$DEPLOY_ALLOW_DIRTY_REMOTE")"
  "DEPLOY_REPLACE_PM2=$(shell_quote "$DEPLOY_REPLACE_PM2")"
  "DEPLOY_DRY_RUN=$(shell_quote "$DEPLOY_DRY_RUN")"
)

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

echo "Updating code with fast-forward pull..."
git pull --ff-only origin "$DEPLOY_BRANCH"

echo "Installing dependencies..."
npm ci

echo "Building API..."
npm --workspace @throttleiq/api run build

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
pm2 save >/dev/null

echo "Checking API health..."
for attempt in 1 2 3 4 5; do
  if curl -fsS "$DEPLOY_HEALTH_URL" >/tmp/leadrider-api-health.json; then
    cat /tmp/leadrider-api-health.json
    echo
    echo "Deploy complete."
    exit 0
  fi
  echo "Health check attempt $attempt failed; retrying..."
  sleep 3
done

echo "API health check failed after deploy." >&2
pm2 status "$DEPLOY_PM2_PROCESS" --no-color || true
pm2 logs "$DEPLOY_PM2_PROCESS" --lines 80 --nostream --no-color || true
exit 23
REMOTE
