# Walk-In Comment Trigger Cheat Sheet

Use these exact-style notes in the Traffic Log Pro walk-in comment field to trigger deterministic workflows.

## 1) Used Inventory Watch
- Example:
  - `Looking for a used Street Glide, keep an eye out and let me know when one comes in.`
  - `Need a pre-owned Road Glide, watch for 2022-2024.`
- Trigger conditions:
  - Includes `used` or `pre-owned`
  - Includes identifiable model
  - No matching used inventory currently in stock
- Result:
  - Creates inventory watch (`condition: used`)
  - Pauses cadence as `holding_inventory`

## 2) New Inventory Watch
- Example:
  - `Looking for a new Street Glide, let me know when one comes in.`
  - `Watch for a new 2026 Road Glide and reach out when available.`
- Trigger conditions:
  - Includes watch intent phrase (`keep an eye out`, `watch for`, `let me know when`, `notify me when`, `if/when you get`, `reach out when`)
  - New-model intent (`new`, or general looking/want language without used/pre-owned)
  - Includes identifiable model
  - No matching new inventory currently in stock
- Result:
  - Creates inventory watch (`condition: new`)
  - Pauses cadence as `holding_inventory`

## 3) Weather Test-Ride Follow-Up (Cadence Timing)
- Example:
  - `Reach out to schedule a test ride when the weather looks better.`
  - `Check back end of next week for a demo ride if weather improves.`
- Trigger conditions:
  - Includes `test ride` or `demo ride`
  - Includes weather cue (`weather`, `nice day`, `warmer`, etc.)
- Result:
  - Walk-in cadence starts (if not blocked by handoff/watch)
  - Step 0 is weather-timed:
    - If window provided: picks best day in window, reaches out 1-2 days before
    - If no window: waits/rechecks weekly until a nice day appears, then reaches out 1-2 days before

## 4) Deposit / Sold Deterministic Handoff
- Example:
  - `Customer left a deposit on 2026 Street Glide.`
  - `Sold and delivered Road Glide today.`
- Result:
  - Manual handoff
  - Cadence stopped
  - Todo created
  - If sold signal present: conversation closed

## 5) Finance Cosigner Deterministic Handoff
- Example:
  - `Ran credit app, needs cosigner for Street Glide.`
  - `Finance app done, requires co-signer.`
- Result:
  - Finance/approval todo created
  - Manual handoff mode set
  - Cadence stopped

## 6) Test Ride Completed Context
- Example:
  - `Took a test ride on 2026 Street Glide today.`
  - `Demo ride completed on Road Glide.`
- Result:
  - Test-ride dialog state updated
  - Used as structured context for follow-up behavior

## Optional Precision Fields for Watches
Include these in the same comment to enrich watch constraints:
- Year range:
  - `2024-2026`
- Trim:
  - `ST`, `CVO`, `Special`, `Limited`, `Ultra`, `Anniversary`, `blacked-out`, `chrome`
- Color:
  - `black`, `white`, `red`, `blue`, `gray`, `silver`, etc.
- Price range:
  - `under $32k`
  - `between $28k and $34k`
  - `above $25k`

Example full precision comment:
- `Looking for a new 2024-2026 Street Glide ST in black, between $28k and $34k, keep an eye out and let me know when one comes in.`

## Notes
- Watch triggers are blocked if comment also indicates deposit/sold/cosigner handoff.
- Weather cadence logic only applies to test-ride + weather comments.
