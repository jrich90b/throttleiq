# JD Power Trade Budget Plan (Deferred)

Owner intent captured on 2026-04-02:
- Use JD Power valuation API (not manual entry) for trade-in values.
- Customer-provided dollar amount is treated as **max OTD budget**.
- Gather payoff and trade details via parser/state workflow (similar to finance-doc intake), not ad-hoc prompts.
- Resolve target model from ADF first, then conversation turns/history; ask only if still unknown.

## Functional Rules

1. Budget semantics:
- `budgetTargetOtd` is the hard ceiling from customer text (e.g., "$10,000 and my bike").
- Do not propose units above computed OTD fit.

2. Trade valuation source:
- Primary: JD Power API (rough/clean trade-in range, plus whatever intermediate values are returned).
- VIN decode is metadata only; valuation comes from JD Power.

3. Intake state machine:
- `trade_budget_intake`
- `trade_budget_need_model`
- `trade_budget_need_miles`
- `trade_budget_need_condition`
- `trade_budget_need_payoff`
- `trade_budget_ready`

4. Model resolution precedence:
- Current inbound turn
- Recent conversation turns
- ADF lead vehicle
- If unknown, continue budget watch without strict model and ask model in intake flow

5. Output/watch behavior:
- If model known: model + budget constrained watch
- If model unknown: budget watch (broad) + continue intake

## Parser-First Requirements

1. Add schema fields in parser result:
- `budget_target_otd`
- `trade_present`
- `payoff_present`
- `payoff_amount`
- `explicit_intent`
- `confidence`

2. Apply shared state transition helper in:
- live inbound (`/webhooks/twilio`)
- regenerate (`/conversations/:id/regenerate`)

3. Regex allowed only as fallback when parser disabled/low-confidence.

## Data Model (conversation)

Add `tradeBudget` object:
- `status`
- `budgetTargetOtd`
- `resolvedModel`, `resolvedYear`, `modelSource`, `modelConfidence`
- `tradeVehicle` snapshot (year/make/model/trim/miles/condition)
- `payoffAmount`
- `jdPower` payload summary
- `tradeValueMin`, `tradeValueMax`
- `maxBikePriceMin`, `maxBikePriceMax`
- `updatedAt`

## Integration Contract (JD Power)

Implement adapter:
- `getTradeValueEstimate(input) -> { minTradeValue, maxTradeValue, raw }`

Input should support:
- VIN when available
- fallback YMMT + mileage + condition + zip

## Deterministic Math

Given:
- `budgetTargetOtd`
- `tradeValueRange`
- `payoffAmount` (optional)
- dealer tax/fee assumptions

Compute:
- `maxBikePriceRange` under OTD cap

## Testing / Eval

- Add parser fixtures for:
  - affordability defer with trade mention
  - budget + trade + payoff combos
  - ambiguous model cases
- Add state transition tests for each missing-field step.
- Add budget math tests for positive and negative equity.

## Environment (to be added when credentials exist)

- `JDP_API_BASE_URL`
- `JDP_API_KEY` (or OAuth client credentials if required by contract)
- optional valuation config keys per JD docs

