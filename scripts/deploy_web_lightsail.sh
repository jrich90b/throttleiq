#!/usr/bin/env bash
#
# Artifact deploy for the LeadRider web app (apps/web, Next.js) to the Lightsail
# box. Mirrors deploy_api_lightsail.sh's local-build-then-rsync approach so we
# NEVER run `next build` on the prod box (that build is what crushed the box —
# see the build-resource-guard work). The box runs `next start` from .next, so
# we ship a locally-built .next and only fast-forward the source for
# public/, next.config, and package.json.
#
# Safe because: the box checkout must be a clean fast-forward of origin/main
# (no divergence), and web deps must be unchanged (no node_modules rebuild on
# the box). The script aborts if either assumption fails.
#
# Usage:
#   scripts/deploy_web_lightsail.sh                 # defaults to host alias "lightsail"
#   DEPLOY_HOST=lightsail scripts/deploy_web_lightsail.sh
#
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-lightsail}"
DEPLOY_REPO="${DEPLOY_REPO:-/home/ubuntu/throttleiq}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
DEPLOY_PM2_PROCESS="${DEPLOY_PM2_PROCESS:-leadrider-web}"
DEPLOY_WEB_PORT="${DEPLOY_WEB_PORT:-3000}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

echo "==> Preflight: local repo and remote box must agree on the source"
git fetch origin -q
local_head="$(git rev-parse --short HEAD)"
remote_head="$(git rev-parse --short "origin/${DEPLOY_BRANCH}")"
if [[ "$local_head" != "$remote_head" ]]; then
  echo "  ! local HEAD ($local_head) != origin/${DEPLOY_BRANCH} ($remote_head)." >&2
  echo "    Push/pull so the local build matches what the box will check out." >&2
  exit 1
fi

# The box must be a clean fast-forward of origin (no local divergence) and its
# web dependencies must be unchanged since its current commit.
box_head="$(ssh "$DEPLOY_HOST" "cd '$DEPLOY_REPO' && git fetch origin -q && git rev-parse --short HEAD")"
if ! ssh "$DEPLOY_HOST" "cd '$DEPLOY_REPO' && git merge-base --is-ancestor HEAD origin/${DEPLOY_BRANCH}"; then
  echo "  ! box HEAD ($box_head) is NOT an ancestor of origin/${DEPLOY_BRANCH} — diverged. Reconcile first." >&2
  exit 1
fi
if [[ -n "$(ssh "$DEPLOY_HOST" "cd '$DEPLOY_REPO' && git status --porcelain")" ]]; then
  echo "  ! box working tree is dirty — refusing to git pull over local changes." >&2
  exit 1
fi
if ! git diff --quiet "$box_head" "$remote_head" -- apps/web/package.json package-lock.json; then
  echo "  ! web dependencies changed between box ($box_head) and target ($remote_head)." >&2
  echo "    The box node_modules would be stale; run 'npm ci' on the box before deploying." >&2
  exit 1
fi
echo "    local=$local_head  remote=$remote_head  box=$box_head  (fast-forward, deps unchanged)"

echo "==> Building web locally (artifact mode, no on-box build)"
# Build with NEXT_PUBLIC_* left at their defaults to match how the box was built
# (the client uses relative /api; server route handlers read runtime env).
# Uses the default (Turbopack) builder. The landing page font is self-hosted (next/font/local,
# vendored woff2) so the build is HERMETIC — no Google-Fonts fetch — which is what let us drop the
# earlier `--webpack` workaround (Next 16's Turbopack failed that fetch on the deploy host). (2026-06-24)
( cd apps/web && npm run build )
if [[ ! -f apps/web/.next/BUILD_ID ]]; then
  echo "  ! local build produced no apps/web/.next/BUILD_ID" >&2
  exit 1
fi

echo "==> Fast-forwarding box source to origin/${DEPLOY_BRANCH}"
ssh "$DEPLOY_HOST" "cd '$DEPLOY_REPO' && git pull --ff-only origin ${DEPLOY_BRANCH} >/dev/null && git rev-parse --short HEAD"

echo "==> Shipping locally-built .next (excluding webpack cache)"
rsync -az --delete --exclude 'cache/' apps/web/.next/ "$DEPLOY_HOST:$DEPLOY_REPO/apps/web/.next/"

echo "==> Restarting $DEPLOY_PM2_PROCESS"
ssh "$DEPLOY_HOST" "pm2 restart '$DEPLOY_PM2_PROCESS' >/dev/null"

echo "==> Health check"
for attempt in 1 2 3 4 5; do
  code="$(ssh "$DEPLOY_HOST" "curl -s -o /dev/null -w '%{http_code}' http://localhost:${DEPLOY_WEB_PORT}/ || true")"
  if [[ "$code" == "200" || "$code" == "307" || "$code" == "302" ]]; then
    echo "    web responding (HTTP $code)"
    echo "Web deploy complete."
    exit 0
  fi
  echo "    attempt $attempt: HTTP ${code:-none}; retrying..."
  sleep 4
done
echo "  ! web did not return a healthy status after restart — check 'pm2 logs $DEPLOY_PM2_PROCESS'." >&2
exit 1
