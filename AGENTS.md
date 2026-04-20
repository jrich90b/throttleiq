# LLM vs Deterministic Guardrails (Throttleiq)

This project uses a **hybrid** approach with a **parser-first requirement for new customer states**:

- **Deterministic** for high‑risk, consistency‑critical, or compliance‑sensitive flows.
- **LLM (guard‑railed)** for open‑ended inbound replies and nuanced follow‑ups.

## Parser-First Rule (New States)
When adding a new customer state/disposition, do **not** start with standalone regex routing.

Required order:
1) Add a typed parser schema in `services/api/src/domain/llmDraft.ts`.
2) Add a typed parse result and parser function with confidence output.
3) Add a shared state transition helper in `services/api/src/index.ts`.
4) Apply that helper in **both**:
   - live inbound (`/webhooks/twilio`)
   - regenerate (`/conversations/:id/regenerate`)
5) Keep regex only as fallback when parser is disabled/low-confidence.
6) Add eval fixtures for new state phrases before deployment.

Current parser-first disposition states:
- `customer_sell_on_own`
- `customer_keep_current_bike`
- `customer_stepping_back`

Current parser artifacts:
- Schema: `customer_disposition_parser`
- Parser: `parseCustomerDispositionWithLLM(...)`
- Confidence gate: `LLM_CUSTOMER_DISPOSITION_CONFIDENCE_MIN` (default 0.74)
- Enable flag: `LLM_CUSTOMER_DISPOSITION_PARSER_ENABLED` (default on unless `0`)

## Deterministic (Must‑Keep)
These must remain deterministic to avoid brittle or risky LLM behavior:

1) **Initial ADF reply prefix**
   - Always start with:  
     `Hi {firstName} — This is {agentName} at {dealerName}.`
   - Implemented in `services/api/src/routes/sendgridInbound.ts` (`applyInitialAdfPrefix`).

2) **Follow‑up cadence templates**
   - SMS cadence: `FOLLOW_UP_MESSAGES`
   - Email cadence: `EMAIL_FOLLOW_UP_MESSAGES`
   - Implemented in `services/api/src/index.ts`

3) **Lead‑type handlers (explicit rules)**
   - Credit apps, demo ride events, room58 standard, meta offer “Other”, etc.
   - Implemented in `services/api/src/routes/sendgridInbound.ts` and `services/api/src/domain/orchestrator.ts`

4) **Call‑only preference**
   - If “call only”, block SMS/email auto‑drafts & follow‑up cadence.
   - `contactPreference` = `call_only`

## LLM (Guard‑railed)
Used for inbound replies where nuance is required:

- Regular SMS/email replies **after** the initial ADF response.
- Appointment offers **only if** the customer explicitly asked to schedule/stop in.
- Clarifications, comparisons, inventory availability follow‑ups.

**Guardrails are enforced in `services/api/src/domain/llmDraft.ts`:**
Key hard rules:
- Do **not** offer times unless customer asked.
- Do **not** confirm booking unless `appointment.bookedEventId` exists.
- Do **not** repeat introductions after the first outbound.
- If “call today” and dealer is closed: say closed, call tomorrow.
- If handoff is required, keep to 1–2 sentences and no scheduling.

**Handoff gating in `services/api/src/domain/orchestrator.ts`:**
- Manager/approval/callback/pricing‑after‑attempts now flow through LLM **only** with the handoff guardrail.
- When LLM is disabled, deterministic replies are used.

## NLU Confidence + Clarification (Policy)
We gate LLM intent/booking parsing by confidence and ask a clarification when low confidence:
- Intent parser: `explicit_request && confidence >= LLM_INTENT_CONFIDENCE_MIN` (default 0.75)
- Booking parser: `explicit_request && confidence >= LLM_BOOKING_CONFIDENCE_MIN` (default 0.70)
- If booking confidence is low and there’s no clear day/time signal, ask a single clarification:
  - “Just to confirm — are you looking to set a time to stop in?”
- If callback/test‑ride/availability confidence is low, ask a single clarification:
  - Callback: “Just to confirm — do you want me to have someone call you?”
  - Test ride: “Just to confirm — are you looking to set up a test ride?”
  - Availability: “Just to confirm — are you asking about availability on a bike?”

Env vars:
- `LLM_INTENT_CONFIDENCE_MIN` (default 0.75)
- `LLM_BOOKING_CONFIDENCE_MIN` (default 0.70)
- `LLM_CUSTOMER_DISPOSITION_CONFIDENCE_MIN` (default 0.74)

## Appointment Offer Rules (Source of Truth)
- Use suggested slots only if customer asked to schedule.
- Do not confirm unless booked.
- Avoid offering times if “holding_inventory” or “manual_handoff”.

## Dialog State (Policy)
Dialog state is tracked in `conv.dialogState` to avoid repeats and guide flow:
- Inventory: `inventory_init`, `inventory_watch_prompted`, `inventory_watch_active`, `inventory_answered`
- Scheduling: `clarify_schedule`, `schedule_request`, `schedule_offer_sent`, `schedule_booked`
- Trade‑in: `trade_init`, `trade_cash`, `trade_trade`, `trade_either`
- Pricing/Payments: `pricing_init`, `pricing_need_model`, `pricing_answered`, `pricing_handoff`, `payments_handoff`
- Callback/Call‑Only: `callback_requested`, `callback_handoff`, `call_only`
- Disposition: `customer_sell_on_own`, `customer_keep_current_bike`, `customer_stepping_back`

Initial state is set in `services/api/src/routes/sendgridInbound.ts`. Updates occur in `services/api/src/index.ts`.

Trade‑in policy enforcement (runtime):
- If trade state is set, do not re‑ask cash vs trade.
- When `trade_cash`, offer two concrete times if available; otherwise ask for a stop‑in time.
- When `trade_trade`, ask what model they want to trade into.
- When `trade_either`, ask which direction they prefer.

Pricing/Payments policy enforcement (runtime):
- If `pricing_need_model`, always ask which model (and trim/color if known).
- If `pricing_answered`, avoid repeating the exact same pricing reply.
- If `pricing_handoff`/`payments_handoff`, send a manager follow‑up ack.

Callback/Call‑Only policy enforcement (runtime):
- If callback is requested, respond with a call‑back ack and create a handoff todo.
- If call‑only is requested, set `contactPreference=call_only`, stop cadence, and do not send SMS.

## Safe Edit Checklist
When changing responses:

1) Ensure initial ADF prefix is preserved.
2) Follow‑up cadence remains deterministic.
3) LLM rules remain strict (no repeated intros, no premature booking).
4) Hand‑off reasons must not ask for scheduling.
5) New state/disposition logic is parser-first (schema + shared handler + regen parity + eval), not regex-only.

## Key Files
- `services/api/src/routes/sendgridInbound.ts` — ADF handling, deterministic responses, handoffs.
- `services/api/src/index.ts` — follow‑up cadence + email cadence.
- `services/api/src/domain/orchestrator.ts` — routing + LLM gating + scheduling logic.
- `services/api/src/domain/llmDraft.ts` — LLM prompt + strict rules.
- `services/api/src/domain/tone.ts` — centralized tone normalization for outbound sales language.
- `scripts/*_eval.ts` + `scripts/*_examples.json` — parser evals and regression fixtures.

## Phase 1 Routing Alignment (No Line Number Notes)
- Deterministic availability and finance-priority gating are shared helpers in `services/api/src/index.ts`:
  - `getDeterministicAvailabilitySignals(...)`
  - `hasFinancePrioritySignals(...)`
  - `hasPricingDialogContext(...)`
- These helpers must be used in both:
  - live inbound route (`/webhooks/twilio`)
  - regenerate route (`/conversations/:id/regenerate`)
- When documenting this behavior, reference helper names and route names, not raw line numbers (line numbers drift frequently).

## Ops Note
- On the Ubuntu instance, `rg` may not be installed. Use `grep` for on‑box searches.

## Deferred Feature Notes
- JD Power trade-budget workflow scope is documented in:
  - `docs/JD_Power_Trade_Budget_Implementation.md`
- When resumed, implement parser-first + state machine from that doc (no regex-only flow).

## Data Path Safety (Do Not Wipe Dealer Profile)
- **Source of truth for instance data is runtime storage**, not repo data files.
- API env on Lightsail should use:
  - `DATA_DIR=/home/ubuntu/throttleiq-runtime/data`
  - `DEALER_PROFILE_PATH=/home/ubuntu/throttleiq-runtime/data/dealer_profile.json`
- Never treat `services/api/data/dealer_profile.json` as persistent production state. It can be changed by `git pull`.
- Do not run destructive edits against dealer profile paths unless explicitly requested.
- Before troubleshooting missing profile fields, verify active env from PM2:
  - `PID=$(pm2 pid throttleiq-api); tr '\0' '\n' < /proc/$PID/environ | grep -E '^(DATA_DIR|DEALER_PROFILE_PATH)='`

## Intent Parser Eval (Local)
- Run eval:
  - `export OPENAI_API_KEY="sk-..."`
  - `npm run intent:eval`
- Add a new example:
  - `npm run intent:add -- --text "..." --intent callback|test_ride|availability|none --explicit true|false --id example_id`
  - Optional: `--availability "model=Road Glide;year=2025;color=purple"`, `--history '[{"direction":"out","body":"..."}]'`, `--lead '{"vehicle":{"model":"Street Glide"}}'`

## Feedback Loop Commands (Edited Messages -> Fixtures)
- Mine changed outbound edits into labels + replay fixtures (instance/runtime data):
  - `cd ~/throttleiq`
  - `CHANGED_MESSAGES_PATH=/home/ubuntu/throttleiq-runtime/reports/changed_messages_all.json CONVERSATIONS_PATH=/home/ubuntu/throttleiq-runtime/data/conversations.json EDIT_FEEDBACK_OUT_DIR=/home/ubuntu/throttleiq-runtime/reports/edit_feedback npm run edit_feedback:mine`
- Run audit + mining loop together:
  - `cd ~/throttleiq`
  - `CHANGED_MESSAGES_PATH=/home/ubuntu/throttleiq-runtime/reports/changed_messages_all.json CONVERSATIONS_PATH=/home/ubuntu/throttleiq-runtime/data/conversations.json EDIT_FEEDBACK_OUT_DIR=/home/ubuntu/throttleiq-runtime/reports/edit_feedback npm run edit_feedback:loop`
- Output files:
  - `/home/ubuntu/throttleiq-runtime/reports/edit_feedback/edit_feedback_labeled.json`
  - `/home/ubuntu/throttleiq-runtime/reports/edit_feedback/edit_replay_fixtures.json`
  - `/home/ubuntu/throttleiq-runtime/reports/edit_feedback/edit_replay_fixture_results.json`
  - `/home/ubuntu/throttleiq-runtime/reports/edit_feedback/edit_feedback_summary.json`

## Nightly Automation (Near Hands-Off)
- One-command nightly loop:
  - `cd ~/throttleiq`
  - `npm run feedback:nightly`
- The nightly loop runs:
  1) `export:changed_messages` (auto-builds `changed_messages_all.json` from conversations)
  2) `conversation:audit` (writes JSON audit log)
  3) `edit_feedback:mine` (labels edits + generates replay fixtures/results)
  4) `route_watchdog:run` (stuck-turn + no-response watchdog JSON)
  5) `conversation_replay:eval` + `route_state:eval` (nightly replay/regression checks)
  6) Optional email report (`edit_feedback:email`) if env vars are set

- Route audit persistence (API runtime):
  - `ROUTE_AUDIT_PERSIST=1` (default on)
  - `ROUTE_AUDIT_DIR=/home/ubuntu/throttleiq-runtime/reports/route_audit` (or your runtime report path)

- Run watchdog manually:
  - `cd ~/throttleiq`
  - `DATA_DIR=/home/ubuntu/throttleiq-runtime/data CONVERSATIONS_DB_PATH=/home/ubuntu/throttleiq-runtime/data/conversations.json ROUTE_AUDIT_DIR=/home/ubuntu/throttleiq-runtime/reports/route_audit npm run route_watchdog:run -- --since-min 180 --stuck-older-sec 120 --limit 100`

- Debug API endpoints for persisted route audits (survive API restart):
  - `/debug/route-outcomes/persisted?sinceMin=180&limit=200`
  - `/debug/decision-trace/persisted?sinceMin=180&limit=200`
  - `/debug/route-watchdog?sinceMin=180&olderThanSec=120&limit=100`

- Email env vars (set on instance shell/PM2 environment):
  - `SENDGRID_API_KEY`
  - `FEEDBACK_REPORT_EMAIL_TO` (recipient)
  - `FEEDBACK_REPORT_EMAIL_FROM` (sender; falls back to `NOTIFICATION_FROM_EMAIL`)
  - Optional: `FEEDBACK_REPORT_ATTACH_FULL=1` (attach full labeled + fixture payloads)
  - Optional: `FEEDBACK_REPORT_ATTACH_ZIP=1` (attach a single `.zip` bundle of report artifacts)
  - Optional: `FEEDBACK_REPORT_ZIP_ONLY=1` (send only the zip attachment, skip individual JSON attachments)
  - Optional: `FEEDBACK_REPORT_ZIP_NAME=feedback_report_custom.zip` (custom zip filename)

- Cron setup (daily at 8:15 AM ET):
  - `crontab -e`
  - Add line:
    - `15 8 * * * cd /home/ubuntu/throttleiq && DATA_DIR=/home/ubuntu/throttleiq-runtime/data REPORT_ROOT=/home/ubuntu/throttleiq-runtime/reports FEEDBACK_REPORT_EMAIL_TO=joeh@americanharley-davidson.com FEEDBACK_REPORT_EMAIL_FROM=sales@americanharley-davidson.com npm run feedback:nightly >> /home/ubuntu/throttleiq-runtime/reports/feedback_loop_cron.log 2>&1`

## After Any Code Change (Always Include These)
- Local (push):
  - `cd ~/throttleiq`
  - `git status -sb`
  - `git add <files>`
  - If adding a Next.js route with `[id]` or other brackets, quote the path:
    - `git add "apps/web/src/app/api/conversations/[id]/watch/route.ts"`
  - `git commit -m "..." `
  - `git push`
- Instance (pull/build/restart API):
  - `cd ~/throttleiq`
  - `git pull`
  - `cd services/api`
  - `NODE_OPTIONS="--max-old-space-size=4096" npm run build`
  - `pm2 restart throttleiq-api --update-env`
- If web app changed:
  - `cd ~/throttleiq/apps/web`
  - `npm run build`
  - `pm2 restart leadrider-web --update-env`
- If the web UI still shows "Application error" or stale bundles after a web change:
  - Fully reset the web process to ensure it picks up the new `.next` build:
  - `pm2 delete leadrider-web`
  - `pm2 start "npm run start -- --port 3000" --name leadrider-web --cwd /home/ubuntu/throttleiq/apps/web`
  - `pm2 save`
- If you add a new Next.js API route (e.g., under `apps/web/src/app/api/...`), you must:
  - Commit the route file(s) locally.
  - Pull + rebuild the web app on the instance (otherwise the route 404s).

## UI Contrast Pivot (Web Inbox/Chat)
- High-contrast fixes for dark inbox/chat theme now live in:
  - `apps/web/src/app/globals.css`
- Added targeted overrides for:
  - light-background button states (`bg-gray-50/100`, `bg-white`, `bg-blue-50/100`, `bg-red-50`, `bg-amber-50`)
  - global light-surface readability map so nested gray text flips to dark contrast on:
    - `bg-white`, `bg-gray-50`, `bg-gray-100`, `bg-blue-50`, `bg-blue-100`, `bg-amber-50`, `bg-red-50`
  - calendar header readability on day/week grid (salesperson names + time labels in `bg-gray-50` rows)
  - accent buttons (`bg-[var(--accent)]`) to use dark foreground text
  - chat bubble combinations:
    - inbound: `.bg-gray-100.text-gray-900.border-gray-200`
    - outbound: `.bg-blue-600.text-white.border-blue-600`
- Do not use broad low-level color overrides that force light text on all utility classes (example risk: overriding `.text-gray-900` globally inside `.lr-app-theme` can make inbound bubbles unreadable).
