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

## Ops Note
- On the Ubuntu instance, `rg` may not be installed. Use `grep` for on‑box searches.

## Intent Parser Eval (Local)
- Run eval:
  - `export OPENAI_API_KEY="sk-..."`
  - `npm run intent:eval`
- Add a new example:
  - `npm run intent:add -- --text "..." --intent callback|test_ride|availability|none --explicit true|false --id example_id`
  - Optional: `--availability "model=Road Glide;year=2025;color=purple"`, `--history '[{"direction":"out","body":"..."}]'`, `--lead '{"vehicle":{"model":"Street Glide"}}'`

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
  - `pm2 restart /home/ubuntu/throttleiq/ecosystem.config.cjs --update-env`
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
