#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="/home/ubuntu/throttleiq"
DATA_DIR="/home/ubuntu/throttleiq-runtime/data"

if [ "${1:-}" = "--data-dir" ] && [ -n "${2:-}" ]; then
  DATA_DIR="$2"
fi

printf "\nDealer Onboarding Bootstrap\n"
printf "Repo: %s\n" "$REPO_ROOT"
printf "Data: %s\n\n" "$DATA_DIR"

if [ ! -d "$REPO_ROOT" ]; then
  echo "ERROR: Repo not found at $REPO_ROOT"
  exit 1
fi

# Create runtime directories
sudo mkdir -p "$DATA_DIR"
sudo mkdir -p "$DATA_DIR/lead_sources"
sudo mkdir -p "$DATA_DIR/uploads"
sudo chown -R ubuntu:ubuntu "$DATA_DIR"

# Copy lead source catalogs if they exist
if [ -f "$REPO_ROOT/services/api/data/lead_sources/hdmc.json" ]; then
  cp -v "$REPO_ROOT/services/api/data/lead_sources/hdmc.json" "$DATA_DIR/lead_sources/hdmc.json"
fi
if [ -f "$REPO_ROOT/services/api/data/lead_sources/tlp.json" ]; then
  cp -v "$REPO_ROOT/services/api/data/lead_sources/tlp.json" "$DATA_DIR/lead_sources/tlp.json"
fi
if [ -f "$REPO_ROOT/services/api/data/lead_sources/room58.json" ]; then
  cp -v "$REPO_ROOT/services/api/data/lead_sources/room58.json" "$DATA_DIR/lead_sources/room58.json"
fi

# Create a blank dealer profile if missing
if [ ! -f "$DATA_DIR/dealer_profile.json" ]; then
  echo "{}" > "$DATA_DIR/dealer_profile.json"
fi

# Create a minimal scheduler config if missing
if [ ! -f "$DATA_DIR/scheduler_config.json" ]; then
  cat <<'JSON' > "$DATA_DIR/scheduler_config.json"
{
  "timezone": "America/New_York",
  "preferredSalespeople": [],
  "salespeople": [],
  "businessHours": {},
  "bookingWindows": {
    "weekday": { "earliestStart": "09:30", "latestStart": "17:00" },
    "saturday": { "earliestStart": "09:30", "latestStart": "14:00" }
  },
  "minLeadTimeHours": 4,
  "minGapBetweenAppointmentsMinutes": 60,
  "appointmentTypes": { "inventory_visit": { "durationMinutes": 60 } }
}
JSON
fi

cat <<'NEXT'

Bootstrap complete.

Next steps:
1) Create /home/ubuntu/throttleiq/services/api/.env and fill dealer values.
2) Load env into PM2 and restart:
   cd /home/ubuntu/throttleiq/services/api
   eval "$(python3 - <<'PY'
import shlex
path="/home/ubuntu/throttleiq/services/api/.env"
for line in open(path):
    line=line.strip()
    if not line or line.startswith("#") or "=" not in line: continue
    k,v=line.split("=",1)
    print(f"export {k}={shlex.quote(v)}")
PY
)"
   pm2 restart /home/ubuntu/throttleiq/ecosystem.config.cjs --update-env

3) Configure Twilio webhook to https://api.<dealer-domain>/webhooks/twilio
4) Configure SendGrid sender authentication.
5) Connect Google Calendar via UI.

NEXT
