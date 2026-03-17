# LLM vs Deterministic Guardrails (Throttleiq)

This project uses a **hybrid** approach:

- **Deterministic** for high‑risk, consistency‑critical, or compliance‑sensitive flows.
- **LLM (guard‑railed)** for open‑ended inbound replies and nuanced follow‑ups.

## Deterministic (Must‑Keep)
These must remain deterministic to avoid brittle or risky LLM behavior:

1) **Initial ADF reply prefix**
   - Always start with:  
     `Hi {firstName} — Thanks for your inquiry. This is {agentName} at {dealerName}.`
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

## Appointment Offer Rules (Source of Truth)
- Use suggested slots only if customer asked to schedule.
- Do not confirm unless booked.
- Avoid offering times if “holding_inventory” or “manual_handoff”.

## Safe Edit Checklist
When changing responses:

1) Ensure initial ADF prefix is preserved.
2) Follow‑up cadence remains deterministic.
3) LLM rules remain strict (no repeated intros, no premature booking).
4) Hand‑off reasons must not ask for scheduling.

## Key Files
- `services/api/src/routes/sendgridInbound.ts` — ADF handling, deterministic responses, handoffs.
- `services/api/src/index.ts` — follow‑up cadence + email cadence.
- `services/api/src/domain/orchestrator.ts` — routing + LLM gating + scheduling logic.
- `services/api/src/domain/llmDraft.ts` — LLM prompt + strict rules.

## Ops Note
- On the Ubuntu instance, `rg` may not be installed. Use `grep` for on‑box searches.

## Intent Parser Eval (Local)
- Run eval:
  - `export OPENAI_API_KEY="sk-..."`
  - `npm run intent:eval`
- Add a new example:
  - `npm run intent:add -- --text "..." --intent callback|test_ride|availability|none --explicit true|false --id example_id`
  - Optional: `--availability "model=Road Glide;year=2025;color=purple"`, `--history '[{"direction":"out","body":"..."}]'`, `--lead '{"vehicle":{"model":"Street Glide"}}'`
