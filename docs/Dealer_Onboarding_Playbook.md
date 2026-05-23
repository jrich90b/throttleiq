**Dealer Onboarding Playbook (Detailed)**

**Purpose**
This playbook walks a non‑technical operator through setting up a new dealer instance of ThrottleIQ end‑to‑end. It covers every per‑dealer variable you need to set, how to set it, and how to validate it.

**What Changes Per Dealer**
1. Twilio credentials and phone number.
2. SendGrid API key and sender authentication.
3. Google OAuth credentials and calendar IDs.
4. Dealer profile fields (name, agent, phone, website, email signature, logo).
5. Inventory feed URLs.
6. CRM provider credentials and CRM lead source overlays.
7. Lead source rules and website provider selection.
8. Web and API hostnames.
9. Data directory path (if you separate instances).

---

**Step 0: Gather the Required Accounts and Access**
1. Server access (SSH key) for the dealer instance.
2. Domain and DNS access (or ability to request DNS changes from the website provider).
3. Twilio account with a phone number for SMS.
4. SendGrid account and API key.
5. Google Cloud project with OAuth credentials.
6. CRM credentials (for Playwright automation, if enabled).
7. Dealer inventory feed URL.
8. Vercel team access for the web app.

---

**Recommended Hosting Pattern**

Use a split deployment:

1. Dealer web app on Vercel.
2. Dealer API on the dealer server or Lightsail instance.
3. Dealer UI hostname:
   `https://<dealer-slug>.leadrider.ai`
4. Dealer API hostname:
   `https://api.<dealer-slug>.leadrider.ai`

American Harley initial client example:

```text
Web: https://americanharley.leadrider.ai
API: https://api.americanharley.leadrider.ai
Vercel project: leadrider-web
API host: Lightsail
```

DNS should keep the API pointed at the API server and point only the web UI hostname at Vercel:

```text
<dealer-slug>.leadrider.ai      A      76.76.21.21
api.<dealer-slug>.leadrider.ai  A      <dealer-api-server-ip>
```

Do not move the API DNS record to Vercel unless the API has been explicitly moved off the server.

For the current multi-client deployment path and guarded API deploy command, see:

```text
docs/multi_client_deployment.md
```

---

**Step 1: Provision the API Server**
1. SSH into the server.
2. Confirm Node, npm, and PM2 are installed.
3. If missing, install Node 20 and PM2.

Commands:
```bash
node -v
npm -v
pm2 -v
```

---

**Step 2: Clone and Install the API Repo**
1. Clone or update the repo.
2. Install dependencies.

Commands:
```bash
cd /home/ubuntu
if [ ! -d throttleiq ]; then
  git clone https://github.com/jrich90b/throttleiq.git
fi
cd /home/ubuntu/throttleiq
npm install
```

---

**Step 2A: Connect the Dealer Web App in Vercel**

Use Vercel for the dealer UI. Keep API deployment separate unless intentionally changing the architecture.

1. Create or reuse the Vercel project for the web app.
2. Set the project root directory to:
   `apps/web`
3. Add the dealer domain:
   `<dealer-slug>.leadrider.ai`
4. Add Vercel environment variables for Production:

```text
API_BASE_URL=https://api.<dealer-slug>.leadrider.ai
NEXT_PUBLIC_API_BASE_URL=https://api.<dealer-slug>.leadrider.ai
```

5. Deploy production.
6. In DNS, point the dealer web hostname to Vercel:

```text
<dealer-slug>.leadrider.ai  A  76.76.21.21
```

7. Validate:

```bash
dig +short <dealer-slug>.leadrider.ai A
curl -fsS https://<dealer-slug>.leadrider.ai >/dev/null && echo web-ok
```

Expected:

```text
76.76.21.21
web-ok
```

---

**Step 3: Create Runtime Data Directory**
ThrottleIQ uses a runtime data directory that must be writable by the API.

Commands:
```bash
sudo mkdir -p /home/ubuntu/throttleiq-runtime/data
sudo mkdir -p /home/ubuntu/throttleiq-runtime/data/lead_sources
sudo mkdir -p /home/ubuntu/throttleiq-runtime/data/uploads
sudo chown -R ubuntu:ubuntu /home/ubuntu/throttleiq-runtime
```

---

**Step 4: Seed Lead Source Catalogs**
The base catalog is `hdmc.json`. Optional overlays: `tlp.json`, `room58.json`, etc.

Commands:
```bash
cp -v /home/ubuntu/throttleiq/services/api/data/lead_sources/hdmc.json \
  /home/ubuntu/throttleiq-runtime/data/lead_sources/hdmc.json

# Optional overlay examples
cp -v /home/ubuntu/throttleiq/services/api/data/lead_sources/tlp.json \
  /home/ubuntu/throttleiq-runtime/data/lead_sources/tlp.json || true
cp -v /home/ubuntu/throttleiq/services/api/data/lead_sources/room58.json \
  /home/ubuntu/throttleiq-runtime/data/lead_sources/room58.json || true
```

---

**Step 5: Create the API .env File**
The API needs a `.env` file. Use this template and fill in values.

File: `services/api/.env`
```bash
DATA_DIR=/home/ubuntu/throttleiq-runtime/data
SCHEDULER_CONFIG_PATH=/home/ubuntu/throttleiq-runtime/data/scheduler_config.json
PUBLIC_BASE_URL=https://<dealer-slug>.leadrider.ai
APP_BASE_URL=https://<dealer-slug>.leadrider.ai
API_BASE_URL=https://api.<dealer-slug>.leadrider.ai

TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_FROM_NUMBER=+1XXXXXXXXXX

SENDGRID_API_KEY=SG.xxxxxxxxxxxxxxxxxxxxxxxxxxxxx

OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
OPENAI_MODEL=gpt-5-mini
LLM_ENABLED=1

GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxxxxxx
GOOGLE_REDIRECT_URI=https://api.<dealer-domain>/integrations/google/callback

INVENTORY_XML_URL=https://<dealer-site>/inventory/xml?location=XXX
INVENTORY_LIST_URLS=https://<dealer-site>/new-inventory?... (optional)
INVENTORY_MAX_PAGES=15

CRM_PROVIDER=tlp
TLP_BASE_URL=https://tlpcrm.com
TLP_USERNAME=...
TLP_PASSWORD=...
TLP_HEADLESS=true
```

---

**Step 6: Load .env into PM2 and Start API**
PM2 does not automatically read `.env`. You must inject the vars into the PM2 process.

Commands:
```bash
cd /home/ubuntu/throttleiq/services/api

eval "$(
python3 - <<'PY'
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

PID=$(pm2 pid throttleiq-api)
tr '\0' '\n' < /proc/$PID/environ | egrep "TWILIO_|SENDGRID|OPENAI_|GOOGLE_|CRM_PROVIDER|DATA_DIR"
```

Validate the public API:

```bash
curl -fsS https://api.<dealer-slug>.leadrider.ai/health
```

Expected:

```json
{"ok":true}
```

---

**Step 7: Configure Twilio**
1. Buy a Twilio number.
2. Set webhook to:
   `https://api.<dealer-domain>/webhooks/twilio`
3. Validate inbound:

Commands:
```bash
pm2 logs throttleiq-api --lines 200 | grep -i twilio
```

---

**Step 8: Configure SendGrid**
You must authenticate sending.

**Option A: Domain Authentication (best)**
1. SendGrid → Settings → Sender Authentication
2. Authenticate domain or subdomain
3. Ask website provider to add DNS records
4. Wait for “verified”

**Option B: Single Sender Verification (fast)**
1. SendGrid → Verify an Address
2. Verify `sales@dealer.com`

**Set dealer profile email fields**
- From Email
- Reply‑To Email
- Email Signature

---

**Step 9: Configure Google Calendar**
1. Create a Google Cloud OAuth app
2. Set redirect URI to:
   `https://api.<dealer-domain>/integrations/google/callback`
3. Connect in UI (Settings → Scheduling)

**Validate**
```bash
pm2 logs throttleiq-api --lines 200 | grep -i gcal
```

---

**Step 10: Configure Scheduler**
Set in UI:
1. Salespeople + calendar IDs
2. Business hours
3. Appointment types

Validate:
```bash
TOKEN=...  # from sessions.json
curl -s -H "x-auth-token: $TOKEN" http://localhost:3001/scheduler-config
```

---

**Step 11: Configure Dealer Profile**
In UI Settings → Dealer Profile:
1. Dealer name
2. Agent name
3. Phone and website
4. Email signature and logo
5. CRM Provider
6. Website Provider
7. Follow‑up test ride months

---

**Step 12: Inventory Feeds**
Set `INVENTORY_XML_URL` or `INVENTORY_LIST_URLS`.
Validate with:
```bash
curl -s http://localhost:3001/debug/inventory-price?stock=YOUR_STOCK
```

---

**Step 12A: New Model / Family Maintenance (Watch + Matching)**
When a new model year, model name, or family launches:

1. Confirm the inventory feed already contains the new unit(s).
2. If it is only a new model name, no code change is usually needed.
   Matching is inventory-driven and should start working once units are in feed.
3. If it is a new family name, nickname, or slang term, update the model-code catalog:
   `services/api/src/domain/model_codes_by_family.json`
4. Add/update entries under:
   `families` for family-level matching (example: Sportster, Touring, Trike)
   `aliases` for nickname and salesperson/customer phrasing
5. Build and restart API after catalog updates.

Commands:
```bash
cd /home/ubuntu/throttleiq/services/api
NODE_OPTIONS="--max-old-space-size=4096" npm run build
pm2 restart /home/ubuntu/throttleiq/ecosystem.config.cjs --update-env
```

Validate full catalog watch coverage:
```bash
cd /home/ubuntu/throttleiq
DATA_DIR="/home/ubuntu/throttleiq-runtime/data" \
BASE_URL="http://127.0.0.1:3001" \
API_PREFIX="" \
TEST_PHONE="+19995550123" \
npx tsx scripts/watch_catalog_eval.ts
```

Expected:
1. `Pass` equals catalog count.
2. `Fail: 0`.
3. New family phrases resolve to saved watch models/codes.

Operational rule:
1. Keep this catalog current as model years change.
2. Add aliases whenever sales team hears new customer phrasing.
3. Re-run watch catalog eval after every catalog edit.

---

**Step 13: CRM Playwright (if enabled)**
Set CRM credentials and test logging.
Validate:
```bash
pm2 logs throttleiq-api --lines 200 | grep -i "TLP log"
```

---

**Step 14: Validation Checklist**
1. Web UI loads at `https://<dealer-slug>.leadrider.ai`.
2. API health returns OK at `https://api.<dealer-slug>.leadrider.ai/health`.
3. ADF inbound lead shows in UI.
4. Twilio inbound SMS shows in UI.
5. Twilio outbound sends.
6. SendGrid outbound sends.
7. Calendar suggestions appear.
8. Appointment booking works.
9. Lead source classification matches source.
10. Follow‑up cadence behaves per lead type.
11. Report issue creates an operational anomaly.
12. Sentry/Slack/Linear incident test succeeds when enabled.

---

**Troubleshooting Quick Hits**
1. No SMS: verify Twilio webhook and env.
2. No email: verify SendGrid key and sender authentication.
3. No calendar times: verify scheduler config + Google tokens.
4. Lead not showing: verify DATA_DIR path and conversation store.
5. Wrong lead classification: check catalog overlay in runtime.
6. UI loads but API calls fail: verify Vercel `NEXT_PUBLIC_API_BASE_URL`.
7. API health works but UI does not load: verify Vercel domain and DNS A record.
8. API disappeared after web cutover: verify `api.<dealer-slug>.leadrider.ai` still points to the server IP, not Vercel.

---

**Security and Maintenance**
1. Rotate keys regularly.
2. Restrict SSH access.
3. Backup `/home/ubuntu/throttleiq-runtime/data`.
4. Keep SendGrid and Twilio logs.

---

**Scaling Notes**
1. Keep the first dealer isolated: one dealer web hostname, one dealer API hostname, one runtime data directory.
2. Prefer domain authentication per dealer.
3. Use website‑provider subdomain if root DNS not editable.
4. Store dealer‑specific lead source overlays in runtime.
5. Keep per‑dealer inventory feeds.
6. Deploy API changes through `scripts/deploy_api_lightsail.sh` instead of manual server edits.
7. For the next dealer, repeat the checklist instead of changing American Harley records.
8. Move to multi-tenant hosting only after the isolated client flow is stable and documented.
