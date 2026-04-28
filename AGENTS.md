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
7) Keep parser few-shot examples updated for newly observed production misses (live inbound and regenerate parity cases).

## ADF Inquiry Priority
- For initial ADF response drafting, specific customer inquiry intent must win over generic “learn more” phrasing.
- Generic availability line (`I saw you wanted to learn more about ...`) should be used only when inquiry intent is non-specific.
- Regenerate route parity: apply the same rule in `/conversations/:id/regenerate` for `sendgrid_adf` turns.
- Test-ride inquiry copy must stay explicit in both initial email draft paths (`sendgridInbound` + shared `index.ts` fallback): use “stop in for a test ride...” wording (not generic “check out the bike...” text).
- ADF inquiry extraction must prefer multiline `Your inquiry:` blocks over first-line captures so payloads like `Hello, ... Do you have it in stock?` do not collapse to only `Hello`.
- When selecting `effectiveInquiry` from parsed/comment fallbacks, prefer substantive non-metadata text over greeting-only fragments.
- ADF preferred-contact parser must recognize both phrasing variants:
  - `Preferred contact method: ...`
  - `Preferred method of contact - ...`
  so HDMC comment formats correctly set `lead.preferredContactMethod` for routing/UI.
- ADF classification is parser-first: when routing parser intent is accepted, map intent before legacy bucket/CTA heuristics:
  - `availability` -> `inventory_interest/check_availability`
  - `pricing_payments` -> `inventory_interest/request_a_quote`
  - `scheduling` -> `test_ride/schedule_test_ride`
  - `callback` -> `general_inquiry/contact_us`
- Department-intent priority for initial ADF classification:
  - `parts` / `apparel` / `service` intent (from parser or explicit text) must be evaluated before generic availability heuristics like “in stock”.
  - This prevents part-number and gear inquiries from being misrouted as inventory-availability sales leads.
- Keep deterministic source overrides (for example forced walk-in/test-ride/trade source rules) after parser mapping.

## Channel Layout Guardrail
- Outbound drafting must remain channel-specific:
  - SMS drafts should use compact SMS layout (trimmed spacing, no email-style greeting blocks unless explicitly authored).
  - Email drafts should be normalized to email layout (greeting + paragraph spacing) before storage/send.
  - Email marketing sends must use an unsubscribe link (high-contrast link/button) instead of SMS-style `Reply STOP` footer copy.
  - Public unsubscribe path `/public/marketing/unsubscribe` must add recipient email to suppression so future marketing sends skip that contact.
- Campaign Studio Email HTML should include visual media when campaign image inputs are present:
  - include the selected/primary campaign image as hero when available,
  - include additional reference/design images as secondary visuals,
  - normalize `/uploads/...` image paths to absolute `PUBLIC_BASE_URL` links for external inbox rendering.
  - keep a full marketing-email structure (branded header, subject hero block, section cards, primary CTA, utility CTA grid, and branded footer/contact row) instead of image-only layout.
  - Email HTML generation is LLM-first and should be designed from scratch per campaign context (not forced into one rigid static layout).
  - enforce a required branded header logo row even when LLM HTML omits it.
  - enforce non-cropping image rendering (`object-fit: contain`, `height:auto`) so campaign visuals are fully visible.
  - for Email output target, do not silently fall back to deterministic template HTML when LLM HTML generation fails; return an explicit generation error so users can retry.
  - trade-language guardrails must not overwrite an existing LLM-generated `emailBodyHtml` with deterministic template HTML; preserve LLM HTML and only synthesize template HTML when HTML is missing.
  - Email generation reliability: run copy JSON and HTML layout as separate LLM concerns; if copy pass HTML is missing/invalid/incomplete, run a dedicated HTML-only rescue pass and accept only complete renderable HTML (no plain-text pseudo-HTML).
- Campaign Studio Email locker UX should stay campaign-based (not per-file picking):
  - allow selecting multiple locker campaigns and hydrate prompt/details plus brief/reference/design context into the current email generation input.
  - keep context hydration deterministic and replace-style so users can clearly switch/stack campaign contexts.
- Email generation is now isolated behind a dedicated Email Builder flow:
  - use `/campaigns/email/generate` (and web `/email-builder`) for all campaign email HTML generation,
  - do not generate Email via the legacy `/campaigns/generate` route (it should return a redirect/error to Email Builder),
  - keep Campaign Studio focused on non-email assets (`sms`, social, web banner, flyer) to prevent stale mixed-path behavior.
- Email prompt recursion guardrail:
  - strip any appended email-context scaffolding (`[Reference Campaign Context]`, `Email locker context (required)`, `Block N`, prompt-detail metadata lines) from stored prompt/description before reusing it in Email Builder.
  - never persist merged locker context back into base campaign `prompt`/`description`.
  - deterministic email section copy should prefer per-campaign `description/prompt/summary` and use generated global email text only as last-resort fallback, to avoid cross-campaign copy bleed.
- Campaign Studio Email HTML branding should keep a dealer-branded top row with dealer logo (`dealer_profile.logoUrl`) and a right-side dealer website link when available.
- Email HTML normalization must forcibly replace any generated header block with the required dealer header block so campaign creative images can never occupy the header logo slot.
- Apply the same email-layout normalization in:
  - initial ADF email draft builders,
  - regenerate email draft publishing,
  - manual email send path,
  - any direct `conv.emailDraft` assignment path.

## UI Contrast Guardrail
- Any inline light-surface action panel (for example Task Inbox reassign inline card) must include the `data-actions-menu` hook so form controls inherit enforced high-contrast white-surface styling in dark theme.
- Sold/closed update modal (`Mark unit sold`) should keep high-contrast text + form controls on white surfaces (labels/helper text/actions) so dark-theme overlays remain readable.

## Sold Close UX
- In web sold-close flow (`submitSold` in `apps/web/src/app/page.tsx`), apply immediate optimistic state update/close on successful save and defer full list reload briefly.
- Purpose:
  - avoid stale immediate reloads that make sold state appear unsaved until manual refresh.

## Contacts Groups UX Guardrail
- In Contacts, keep group-open actions explicit and separate:
  - `Add to Contacts` creates/saves contact records only.
  - `Add to Group` (when a group is open) adds an existing contact to that group via searchable single-contact picker.
- `Add to Contacts` is visible only in `All Contacts` view; hide it when a specific group is open.

## Staff SMS Links
- Internal staff SMS prompts that request appointment/finance outcomes should include a clickable staff inbox conversation URL (`section=inbox&convId=...`) so salespeople can open the exact thread directly from text.

## Lead Reassignment
- Reassigning lead owner should also cascade open non-department task owners (`call`, `note`, `other`, follow-up/reminder/appointment task classes) for that conversation so Task Inbox ownership and filters stay aligned with the new lead owner.
- Keep department todos (`service` / `parts` / `apparel`) with department ownership during lead-owner reassignment.

## Finance Docs Attachment Handling
- Treat iOS/Twilio attachment placeholder inbound texts (for example `Open attachment`) as media-bearing for finance-doc state updates and doc-receipt replies, so the assistant does not ask customers to resend documents they already attached.

## Watch Parser Few-Shot Coverage
- Keep watch parser few-shot examples current for real inbound shorthand/slang patterns seen in production (for example `lmk`, `23 lrs`, `fxlrs`) so human-mode and AI-mode watch intent set reliably.

## Walk-In Inquiry Context
- Traffic Log Pro / walk-in ADF inquiry comments are salesperson-authored context notes and should be treated as operational context, not direct customer chat turns.
- Explicit watch phrasing in walk-in comments (including “watching for ...”) should create/refresh inventory watch state even if matching inventory currently exists.
- When a watch clause is present alongside other context, extract watch attributes (year range/condition/color/trim) from the watch clause first to avoid contamination from unrelated in-stock details in the same note.
- Build the walk-in acknowledgement message after watch-state overrides are applied so watch intent wording always wins over in-stock phrasing when both are present.
- Traffic Log Pro step tags (`Step 1` ... `Step 9`) should influence walk-in draft tone, but the concrete follow-up topic should be derived from salesperson-entered context text (not hardcoded to a fixed topic).
- Avoid duplicate acknowledgement phrasing in walk-in drafts: if the selected tail already begins with a thank-you/acknowledgement, skip the default "Thanks for stopping in..." sentence.
- Treat source labels like `Walk In` / `Walk-In` as walk-in lead sources for initial ADF routing (same walk-in guardrail behavior as Traffic Log Pro source labels).
- Canonical walk-in marker: set `dialogState.name = walk_in_active` on initial walk-in routing, and allow `inferWalkIn(...)` / regenerate guards to treat that state as walk-in context.
- Traffic Log Pro / walk-in source handling must be sticky across follow-up ADF updates (not just first touch): keep classification on `in_store/contact_us` and block finance/prequal auto-ack hijacks from context words like “credit union”.
- Owner assignment guardrail for walk-ins: for generic `Walk In` source labels, do not trust `vendor.contact.name` as owner fallback unless salesperson is explicitly present in inquiry/comment text (forwarded ADF emails can contaminate vendor contact name).
- Traffic Log Pro exception for owner fallback: when vendor contact matches a known manager/salesperson user, allow that owner mapping so forwarded TLP ADF notes can retain the intended salesperson/manager owner.
- Cross-department owner realignment: if an existing conversation is owned by a department role (`service`/`parts`/`apparel`) and a new non-department ADF (sales/trade/inventory/in_store/general) arrives, auto-reassign owner back to a salesperson (prefer vendor contact name when it matches a salesperson).
- Rider-to-rider finance source detection should match broader variants (`rider to rider`, `rider 2 rider`, `r2r`) across lead source/inquiry/comment/body so marketplace finance-inquiry leads do not miss deterministic routing.
- Preferred-contact `phone` guardrail: in live/AI mode, still suppress auto text/email; in Suggest mode, still create a draft for staff review so the thread does not appear stuck with no draft.
- Initial ADF agent identity rule: default intro identity comes from dealer profile `agentName`; do not override with `leadOwner` unless there is explicit manual sender/takeover context.

## TLP Delivered Automation
- Playwright delivered-step automation (`tlpMarkDealershipVisitDelivered`) should be resilient to TLP form drift:
  - detail field hydration is best-effort (do not hard-fail entire Step 9 for missing/renamed optional fields),
  - only fail when core delivered transition/submit cannot be completed.
- Internal-question alert for delivered-step failures must include concise step/error detail so production triage can identify whether failure is login, lead-open, delivered-toggle, or submit.

## Feedback Loop Quality Reports
- Tone quality nightly reports should focus on actionable customer turns. Skip non-actionable inbound classes in `scripts/tone_quality_eval.ts`:
  - `voice_transcript` provider rows
  - pure reactions/emoji-to-message rows
  - short ack/no-action rows
  - clear closeout updates with no ask (for example “No need, I already called”)
- Keep these skips explicit and reason-coded in summary output (`skippedReasonCounts`) so report noise is visible but separated from true response-quality misses.
- Language corpus mining now auto-exports feedback-derived few-shot seeds from message feedback ratings:
  - `few_shot_seed_positive_feedback.json` (thumbs-up / what to say),
  - `few_shot_seed_negative_feedback.json` (thumbs-down / what not to say).
- Language corpus mining also exports manual human outbound exemplars:
  - `few_shot_seed_manual_outbound.json` (inbound -> approved manual reply pairs).
- Feedback loop now mines phone-call verbiage artifacts:
  - `voice_feedback_summary.json` (voice transcript/summary volume + outbound provider stats),
  - `voice_feedback_rows.json` (per-call transcript, LLM voice summary, and next customer-facing outbound).
  - Nightly/hourly loops should run `voice_feedback:mine` so call outcomes are visible for orchestration QA (cadence, todos, appointments).
- Voice feedback policy:
  - phone transcript artifacts are orchestration-only (task-trigger/state timing review), not tone/training exemplars.
  - exclude `voice_transcript` / `voice_summary` rows from language-corpus few-shot mining.
  - exclude edit-feedback training rows whose prior inbound provider is `voice_transcript`.
- Deterministic tone rules can now be auto-promoted from mined feedback artifacts:
  - `scripts/deterministic_rules_promote.ts` consumes manual-edit deltas + thumbs-down seeds,
  - writes runtime rules to `DATA_DIR/deterministic_tone_rules.json` (or `DETERMINISTIC_TONE_RULES_PATH`),
  - nightly loop runs this automatically after `language_corpus:mine`.
- Manual reply exemplar promotion:
  - `scripts/manual_outbound_promote.ts` consumes `few_shot_seed_manual_outbound.json`,
  - writes runtime style exemplars to `DATA_DIR/manual_reply_examples.json` (or `MANUAL_REPLY_EXAMPLES_PATH`),
  - nightly loop runs this automatically after deterministic rule promotion.
- Runtime tone normalization (`services/api/src/domain/tone.ts`) loads both `manual` and `auto` override sections from deterministic tone rules, applies rewrite rules, and blocks exact discouraged drafts with a safe fallback.
- Runtime tone normalization also dedupes repeated identity intros (`This is <name> at <dealer>`) so mixed-name double-intro artifacts are collapsed to one identity line across outbound channels.
- State safety lock: outbound state/soft-tag detectors (finance-doc signals, trade-payoff signals, shortlist prompt signals) evaluate pre-deterministic text so promoted tone rules cannot alter dialog/cadence state behavior.
- LLM draft generation (`services/api/src/domain/llmDraft.ts`) may use promoted manual reply exemplars as tone references only; orchestrator/parser routing and state transitions remain authoritative and unchanged.

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
   - Tone guardrail: avoid operational workflow phrasing in customer-facing copy (for example “keep this open”, “switch to update-only”). Use natural, human language like “text me when you’re ready.”

3) **Lead‑type handlers (explicit rules)**
   - Credit apps, demo ride events, room58 standard, meta offer “Other”, etc.
   - Implemented in `services/api/src/routes/sendgridInbound.ts` and `services/api/src/domain/orchestrator.ts`
   - Rider-to-Rider finance inquiry leads are deterministic and policy-gated by dealer profile.

4) **Call‑only preference**
   - If “call only”, block SMS/email auto‑drafts & follow‑up cadence.
   - `contactPreference` = `call_only`

5) **Parser-gated deterministic shortcuts**
   - Twilio deterministic trade-qualifier and media-affirmative shortcuts must not fire when routing parser has an accepted explicit intent override (`pricing_payments`, `scheduling`, `callback`, `availability`).
   - This prevents deterministic shortcut replies from overriding parser-routed intent handling.

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

## Time Parsing Guardrail
- Compact numeric year tokens (for example `2022`, `2026`) must not be interpreted as times (`20:22`, `20:26`) in scheduling/re-generate flows.
- Applies to both legacy time token extraction and `parseRequestedDayTime(...)` compact-time parsing.
- `parseRequestedDayTime(...)` now supports textual dates (for example `May 8`, `May 8th`, `8th May`) in addition to numeric dates.
- When multiple weekday tokens are present (for example `Friday ... or Saturday`), weekday parsing should use the earliest mention in text order rather than fixed weekday priority.

## Appointment Offer Rules (Source of Truth)
- Use suggested slots only if customer asked to schedule.
- Do not confirm unless booked.
- Avoid offering times if “holding_inventory” or “manual_handoff”.
- Test-ride scheduling weather gate:
  - Pass dealer weather status into orchestrator for ADF/email inbound paths.
  - Treat sustained rain as bad weather (in addition to snow/cold) for test-ride slot gating.
  - Rain gate should consider persistent light rain/all-day precipitation probability, not only heavy hourly rain spikes.
  - If weather is bad, do not offer immediate test-ride time slots; offer stop-in + schedule test ride when weather clears.
- Test-ride slot wording:
  - When a suggested slot is on the same local day, format as `Today, h:mm AM/PM` instead of `Sat, Apr 25, ...`.

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
- Trade conversation detection must be sticky across turns: treat prior trade-appraisal outbound context and active trade dialog state as trade context even if lead source/classification is sparse, so regenerate/live scheduling does not fall back to generic inventory timing replies.
- Trade correction follow-up parity:
  - When inbound corrects trade year/model and includes timing intent (for example “can we do tomorrow”), apply closed-day checks before drafting.
  - If requested day is closed, explicitly say `We’re closed on <Day>` and offer alternate slots when available.
  - For trade leads, day/time scheduling intent alone should route through the same trade follow-up helper (even when no explicit `appraisal` keyword is present).
  - Keep this behavior aligned for both live Twilio inbound and `/conversations/:id/regenerate`.

Pricing/Payments policy enforcement (runtime):
- If `pricing_need_model`, always ask which model (and trim/color if known).
- If `pricing_answered`, avoid repeating the exact same pricing reply.
- If `pricing_handoff`/`payments_handoff`, send a manager follow‑up ack.

License/Credit pending follow-up policy (context-note driven):
- When salesperson context notes indicate the customer is waiting on a motorcycle license/permit and plans to run a credit app after that, set cadence context to `license_credit_pending`.
- This path should reset cadence to an engaged delayed check-in (not immediate day-1 pressure) and use license/credit-specific follow-up wording.
- Default delay is controlled by `LICENSE_CREDIT_PENDING_DEFAULT_DAYS` (defaults to 21 days) when no explicit follow-up window is parsed.
- Persistent agent context updates now run the same context-action parser as “add note”, so phrases like “reach out next week” can immediately move cadence due dates.

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

## Campaign Studio Output Targets
- Added flyer output target: `flyer_8_5x11` (default frame `2550x3300` px for 8.5x11 in at 300 DPI).
- Optional env overrides:
  - `CAMPAIGN_FLYER_8_5X11_WIDTH`
  - `CAMPAIGN_FLYER_8_5X11_HEIGHT`
- Flyer outputs are non-social assets:
  - Do not auto-generate social caption for flyer target.
  - In the generated output card, flyer actions are `Print`, `Download`, `Remove` (no send/post queue action).
- Prompt fidelity is now stricter for flyer generation:
  - The API extracts required detail phrases from the prompt/description and injects a required checklist into the image model prompt.
  - For `flyer_8_5x11`, checklist items are treated as mandatory copy details (helps prevent missing items like “flash tattooing”).
- Single-concept image guardrail:
  - Image generations should represent one campaign concept per output (no mixing unrelated campaigns/events/offers into one image).
- Email digest behavior:
  - Email generation may include multi-section updates in a single campaign email (for example upcoming events, current offers, new arrivals) when context supports multiple updates.
  - Campaign email HTML should render sections in a high-contrast newsletter layout (intro + section cards + CTA + references/footer).

## Auth UI Theme
- Login/bootstrap screen now uses the same dark brand theme style direction as the app shell.
- High-contrast controls are required on auth screens:
  - Inputs use bright foreground on dark field with clear orange focus ring.
  - Primary submit uses orange fill with dark text.
  - Errors/success states use readable high-contrast colors.

## SMS Media Uploads
- `/conversations/:id/media` now performs server-side image normalization for MMS:
  - Auto-convert non-MMS-friendly image formats to JPEG when possible.
  - Auto-resize/compress oversized images toward MMS-safe limits before deciding link fallback.
- MMS eligibility for uploaded media is computed from final stored bytes + MIME support, not raw original file size only.
- If an uploaded image still exceeds configured MMS limits after optimization, keep existing link fallback behavior.

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
  - Nightly loader: `scripts/feedback_loop_nightly.sh` now auto-loads `FEEDBACK_LOOP_ENV_PATH` (default `/home/ubuntu/throttleiq-runtime/.feedback_loop.env`) before deciding whether to send report email.
  - Optional: `FEEDBACK_REPORT_ATTACH_FULL=1` (attach full labeled + fixture payloads)
  - Optional: `FEEDBACK_REPORT_ATTACH_ZIP=1` (attach a single `.zip` bundle of report artifacts)
  - Optional: `FEEDBACK_REPORT_ZIP_ONLY=1` (send only the zip attachment, skip individual JSON attachments)
  - Optional: `FEEDBACK_REPORT_ZIP_NAME=feedback_report_custom.zip` (custom zip filename)

- Cron setup (daily at 8:15 AM ET):
  - `crontab -e`
  - Add line:
    - `15 8 * * * cd /home/ubuntu/throttleiq && DATA_DIR=/home/ubuntu/throttleiq-runtime/data REPORT_ROOT=/home/ubuntu/throttleiq-runtime/reports FEEDBACK_REPORT_EMAIL_TO=joeh@americanharley-davidson.com FEEDBACK_REPORT_EMAIL_FROM=sales@americanharley-davidson.com npm run feedback:nightly >> /home/ubuntu/throttleiq-runtime/reports/feedback_loop_cron.log 2>&1`

## Fast Learning (Hourly Safe Loop)
- Use the hourly loop for faster tone/example learning while keeping routing/state deterministic:
  - `cd ~/throttleiq`
  - `npm run feedback:hourly`
- Hourly loop (`scripts/feedback_loop_hourly.sh`) runs:
  1) `language_corpus:mine` (recent-window mining)
  2) `deterministic_rules:promote`
  3) `manual_outbound:promote`
  4) `language_seed:eval`
  5) auto-rollback to pre-hourly rule/example files if eval fails (`FAST_LOOP_ROLLBACK_ON_EVAL_FAIL=1`, default on)
- Key env knobs:
  - `FAST_LOOP_SINCE_HOURS` (default `2`)
  - `FAST_LOOP_RUN_LANGUAGE_SEED_EVAL` (default `1`)
  - `FAST_LOOP_ROLLBACK_ON_EVAL_FAIL` (default `1`)
  - `FAST_LOOP_DETERMINISTIC_RULE_PROMOTE_MIN_COUNT` (default `2`)
  - `FAST_LOOP_MANUAL_REPLY_PROMOTE_MIN_COUNT` (default `1`)
  - `FAST_LOOP_MANUAL_REPLY_MAX_PER_INTENT` (default `6`)
- Cron setup (hourly, top of hour):
  - `crontab -e`
  - Add line:
    - `0 * * * * cd /home/ubuntu/throttleiq && DATA_DIR=/home/ubuntu/throttleiq-runtime/data REPORT_ROOT=/home/ubuntu/throttleiq-runtime/reports FAST_LOOP_SINCE_HOURS=2 npm run feedback:hourly >> /home/ubuntu/throttleiq-runtime/reports/feedback_loop_hourly_cron.log 2>&1`

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
  - calendar edit modal uses `.lr-light-modal` (set on `apps/web/src/app/page.tsx`) with dedicated light-surface form/text/button rules in `apps/web/src/app/globals.css` so modal fields/buttons remain legible in dark shell mode

  - removed forced `button` foreground override in `apps/web/src/app/globals.css` so button labels inherit surface contrast (prevents light text on light cards like Contacts rows and Follow-up "Open conversation")
  - calendar header readability on day/week grid (salesperson names + time labels in `bg-gray-50` rows)
  - calendar day-view hourly gridlines use a stronger light-slate divider in `apps/web/src/app/page.tsx` (`linear-gradient` + `backgroundSize` row repeat) so hour rows remain visible on dark backgrounds
  - accent buttons (`bg-[var(--accent)]`) to use dark foreground text
  - chat bubble combinations:
    - inbound: `.bg-gray-100.text-gray-900.border-gray-200`
    - outbound: `.bg-blue-600.text-white.border-blue-600`
  - lead owner labels/chips moved from red to accent orange for inbox list rows and conversation header owner badge (`apps/web/src/app/components/InboxSection.tsx`, `apps/web/src/app/page.tsx`)
  - inbox row hover/readability: conversation rows use dedicated `.lr-inbox-row` hover/keyboard-focus contrast treatment (`apps/web/src/app/components/InboxSection.tsx`, `apps/web/src/app/globals.css`) so hover states no longer wash out text
  - task inbox action callouts (`Action: ...`) now use accent orange instead of red (`apps/web/src/app/components/TaskInboxSection.tsx`)
  - task inbox task-type pills use stronger high-contrast styling; Follow-up now uses solid accent orange with dark text so the badge label remains readable in dark mode (`apps/web/src/app/components/TaskInboxSection.tsx`)
- Campaign Studio preview cards now include aligned per-image action rows inside the same frame as each generated image (`Open`, `Download`, and context-aware `Send`/`Post`); print actions were removed and buttons were restyled to branded dark/orange campaign controls (`apps/web/src/app/page.tsx`, `apps/web/src/app/globals.css`)
- Campaign Studio generated output cards now include per-file `Remove` actions (including single fallback preview card) so managers can delete one output without deleting the whole campaign; removal persists via campaign patch and marks that target back to pending for regenerate (`apps/web/src/app/page.tsx`, `services/api/src/index.ts`)
- Campaign left-rail queue UI now shows only `Send Queue`; `Post Queue` summary/list indicators were removed from the inbox rail to reduce clutter (`apps/web/src/app/page.tsx`)
  - Campaign Studio `Download` now uses a blob-based forced download handler in the web client so cross-origin asset URLs save the file instead of navigating/opening in-browser (`apps/web/src/app/page.tsx`)
- Do not use broad low-level color overrides that force light text on all utility classes (example risk: overriding `.text-gray-900` globally inside `.lr-app-theme` can make inbound bubbles unreadable).

## Voice Call Booking Pivot (Agent Confirmed Time)
- Voice transcript auto-booking is still gated to avoid false bookings, but now supports a safe fallback in `services/api/src/index.ts` (`applyPostCallSummaryActions`):
  - If customer scheduling intent is present and customer day/time was not parseable as exact, the system may use an explicit salesperson commitment line (for example, “I’ll schedule you in for 12”) to recover an exact time.
  - Fallback only applies when there is an agent booking-commitment phrase plus resolvable day + exact time.
  - Route audit markers:
    - `voice_booking_agent_commitment_fallback` when fallback is used
    - `voice_booking_requires_explicit_time` when still blocked

## Inventory Watch Grammar Guardrail
- Added `normalizeInventoryWatchReplyGrammar(...)` in `services/api/src/index.ts` to correct dangling watch-ack phrasing like:
  - `"I’ll text you as soon as I spot."` -> `"I’ll text you as soon as I spot one."`
- Applied in:
  - live Twilio reply path (`/webhooks/twilio`)
  - regenerate reply path (`/conversations/:id/regenerate`)
  - scheduled cadence sends (`processDueFollowUps`)

## Already-Handled Tone Guardrail
- Added `normalizeAlreadyHandledCourtesyTone(...)` in `services/api/src/index.ts`.
- When inbound indicates the customer already handled it (e.g., "no need", "already called/spoke"), rewrite overly casual outputs like:
  - `"Awesome, glad that’s sorted — thanks for the heads up!"`
  to:
  - `"Thanks for letting me know — appreciate the update."`
- Applied in:
  - live Twilio reply path (`/webhooks/twilio`)
  - regenerate reply path (`/conversations/:id/regenerate`)

## Inbox Resilience Guardrail
- Added defensive normalization in `services/api/src/domain/conversationStore.ts` load path:
  - if a malformed conversation row is missing `messages`, coerce it to `[]` during store load.
- Purpose:
  - prevent `/conversations` list rendering from crashing and blanking the Inbox UI due to one bad runtime row.

## Model Detection Boundary Guardrail
- Updated model mention parsing in `services/api/src/index.ts`:
  - `findMentionedModel(...)` / `findMentionedModels(...)` now require phrase-boundary matches in normalized text.
- Purpose:
  - prevent false positives for short numeric model names (for example, `"72"`) from being inferred out of phone numbers or other long digit strings in ADF bodies.

## Reassign Dropdown Contrast Guardrail
- Updated `apps/web/src/app/globals.css` action-menu select styling:
  - force high-contrast dark text on white background for dropdowns rendered inside `[data-actions-menu]`.
  - explicitly set `option` / `optgroup` foreground/background to maintain readability in native dropdown menus.
- Purpose:
  - prevent low-contrast owner/department selections in the Inbox reassign popover on light modal surfaces.

## Users Modal Contrast + Scroll Guardrail
- Updated Settings -> Users edit/add dialog in `apps/web/src/app/page.tsx`:
  - modal panel now uses `.lr-light-modal` so dark-shell input/select overrides do not wash out text on white surfaces.
  - overlay now supports vertical scrolling (`overflow-y-auto`) with top padding and mobile-friendly alignment.
  - modal container now has viewport-capped height and internal scroll (`max-h` + `overflow-y-auto`) so lower fields/actions remain reachable.

## Inbox Actions Popup Contrast Guardrail
- Updated Inbox actions popup wrapper in `apps/web/src/app/components/InboxSection.tsx` to include `.lr-light-modal`.
- Purpose:
  - ensure inline popups like **Edit contact** use high-contrast text/inputs/buttons on white surfaces inside the dark inbox shell.

## Calendar Day-View Time Alignment Guardrail
- Fixed day-view grid alignment in `apps/web/src/app/page.tsx` so event block placement matches visible hour lines.
- Display window now snaps to full-hour boundaries (`open` floored, `close` ceiled) before computing row layout.
- Time-slot labels now render with actual minute component (not forced `:00`), preventing left-column label drift when source hours include half-hour boundaries.
- Result: events like `10:00–11:00` render on the correct hour position in the day grid.

## Legacy New Condition Guardrail
- Some ADF leads can arrive with `condition: new` for older model years that are realistically only used inventory.
- Added ingest-time normalization in `services/api/src/routes/sendgridInbound.ts`:
  - `normalizeLegacyNewLeadCondition(...)` keeps `new` only when inventory evidence supports it; otherwise downgrades to `used`.
  - Uses model/year inventory checks (`findInventoryMatches`) plus year-age fallback (`NEW_CONDITION_MAX_AGE_YEARS`, default `2`).
  - Out-of-stock guardrail: if the dealer currently has zero matching inventory rows for the model, do not auto-downgrade `new -> used` from absence alone.
  - Manufacturer lineup check (Harley first): when inventory has no matching rows, use make-aware model-year lineup data to keep current/near-current models as `new` with higher confidence.
  - Non-sales guardrail: skip legacy `new -> used` normalization for Ride Challenge/promo-style non-sales leads so generic `new/null` fields do not affect those journeys.
- Added watch-time safety in `services/api/src/index.ts`:
  - `inferWatchCondition(...)` now downgrades stale `new` to `used` for older model years, preventing incorrect `new` inventory-watch filters.

## Meta Social Publish Pivot (Campaign Studio)
- Meta connect + publish remains:
  - connect/start: `/integrations/meta/start`
  - status: `/integrations/meta/status`
  - disconnect: `/integrations/meta/disconnect`
  - publish: `/campaigns/:id/publish/facebook` and `/campaigns/:id/publish/instagram`
- Campaign Studio post publish modal now supports per-asset social fields:
  - `linkUrl`, `mentionHandles`, `locationName`, `gifUrl`, `musicCue`, `stickerText`
- Caption policy:
  - non-story posts auto-build a catchy social caption when explicit caption is absent
  - story posts remain captionless (`instagram_story`) by design
  - optional social fields are appended/saved for non-story captions and stored in campaign metadata (`metadata.socialPublishOptions`)
- Keep story exception strict:
  - do not auto-send story captions; use story notes for manual overlays where needed.

## Regenerate UX Guardrail
- Conversation regenerate now avoids silent no-op behavior:
  - hides Regenerate in Calls tab (unsupported context)
  - shows explicit user-facing reason when regenerate is blocked (Suggest mode / Human mode)
  - shows a success toast after a regenerate completes so users can confirm action occurred

## Campaign Edit Mode Strengthening
- Campaign generate now forwards `editFromCurrent` to API explicitly (was UI-only behavior before).
- In edit mode, generation references are narrowed to the current selected output image to reduce prompt dilution.
- API edit-mode prompt now adds hard directives to enforce visible requested changes (not only subtle sky/background tweaks).
- Edit mode now enforces strict reference lock and records `metadata.editFromCurrent` on generated campaign output for traceability.

## Campaign Upload UX + Contrast Pass
- Campaign Studio optional reference materials now use drag-and-drop upload cards (brief files, reference images, design images).
- Each uploaded item is listed with direct remove action (no manual text cleanup required).
- Campaign action controls (`Redo`, `Save Draft`, upload action buttons, remove buttons) were restyled for stronger contrast in dark theme.
- New styling hooks in `apps/web/src/app/globals.css`:
  - `.lr-campaign-dropzone`
  - `.lr-campaign-upload-btn`
  - `.lr-campaign-upload-row`
  - `.lr-campaign-upload-remove`
- Follow-up contrast tweak:
  - white upload cards now force dark text ramps for `.text-gray-500/600/700/800/900`
  - upload-row links are forced blue (`#1d4ed8`) for readable filename contrast on light rows

## Web Banner Size Source of Truth
- Web banner generation dimensions must come from Dealer Profile fields when set:
  - `campaign.webBannerWidth`
  - `campaign.webBannerHeight`
- Do not hardcode a global web banner size in code paths that run per dealer.
- Fallback order for API/web banner sizing:
  1) dealer profile campaign size
  2) legacy profile keys (`webBannerWidth`, `webBannerHeight`) for backward compatibility
  3) env defaults (`CAMPAIGN_WEB_BANNER_WIDTH`, `CAMPAIGN_WEB_BANNER_HEIGHT`)
- Settings UI note:
  - Dealer Profile save flow must not silently write fixed defaults (e.g., `1200x628`) when banner size fields are unset.
  - On load/save, treat legacy top-level keys as valid fallback sources so older dealer profiles retain their configured banner size.
- Resize-fit note:
  - `webBannerFit=auto` should only use `cover` when source/target aspect ratios are close.
  - When aspect ratio mismatch is large (too narrow/tall or too wide), auto must use `contain_blur` to avoid over-cropped, zoomed-looking banners.
  - Dealer profile supports `campaign.webBannerInsetPercent` (0-25) as an optional zoom-out composition control; use only when needed.
  - Default inset fallback is `0%` when dealer profile does not explicitly set `campaign.webBannerInsetPercent` (avoid unintended blur backdrop).
  - Web-banner prompt safe area is vertically conservative (~52% height center safe area + explicit top/bottom headroom) to protect against responsive hero top/bottom crop.
  - Web banner normalization skips neutral-edge trim to avoid unintentional extra crop before banner resizing.

## Rider-to-Rider Finance Inquiry Policy
- Dealer profile toggle:
  - `policies.riderToRiderFinancingEnabled` (managed from Settings -> Dealer Profile -> **Lead Source Policy** card).
  - UI note: the settings menu and dealer-profile editor are manager-only; non-manager users now see a settings-menu hint that policy toggles require manager access.
- Inbound deterministic handling (`services/api/src/routes/sendgridInbound.ts`):
  - Detect lead source/inquiry text containing Rider-to-Rider financing.
  - If enabled: acknowledge inquiry, create approval todo, set manual handoff (`credit_app`), stop cadence.
  - If disabled: explicitly say dealership does not participate in Rider-to-Rider financing and offer similar in-house options.
  - Response also keeps inventory-check language so availability questions are not ignored.
- Regenerate parity (`services/api/src/domain/regenerateSelection.ts`, `services/api/src/index.ts`):
  - Regenerate picker flags Rider-to-Rider ADF turns.
  - Regenerate route applies the same policy-gated deterministic reply path so manual regenerate matches live inbound behavior.

## Send Channel Guardrail
- In `/conversations/:id/send` (`services/api/src/index.ts`), explicit `channel: "sms"` must never be auto-overridden to email by conversation classification.
- Classification channel is no longer used to infer email for manual send.
- Missing-channel fallback now prefers SMS unless email intent is explicit from:
  - destination looks like an email address (non-phone), or
  - email payload hints (`subject`, `attachments`, `skipEmailSignature`, `forceEmail`).
- Web send path (`apps/web/src/app/page.tsx`) now snapshots send channel at click time and passes it through edit-note modal flow so channel cannot drift if tabs are switched before confirming.
- Regenerate/send guard: when `channel` is missing and `draftId` resolves to a pending `draft_ai` message, `/conversations/:id/send` defaults that send to SMS. Explicit `channel: "email"` remains email.
- Email send failures now return `details` from the SendGrid exception; web send alert includes that detail text for faster on-box diagnosis.
- API logs now include structured email failure context for tracing: `convId`, `leadKey`, `to`, `from`, `replyTo`, and `details` for both manual send and follow-up email paths.

## Sender Identity Guardrail
- `resolveConversationAgentName(...)` in `services/api/src/index.ts` now prefers the dealer profile runtime `agentName` fallback for automated sender identity lines.
- Lead-owner name is only used for sender identity when the conversation is a true `manual_takeover` or a walk-in lead (`lead.walkIn=true`).
- Outside of those two cases, owner/preferred-salesperson names are not used for “This is … at …” identity text, keeping identity consistent with Dealer Profile.
- `manualSender.userName` remains highest priority and is still trusted when explicitly set by a real user action.

## Campaign Image Reliability (Reference-Lock)
- Nano Banana request handling in `services/api/src/index.ts` now retries aborted/timeboxed/transient network failures instead of failing the target on first abort.
- Retryable HTTP statuses now include `408/425/429/500/502/503/504` with exponential backoff.
- Default campaign image timeout knobs were increased for strict reference-image runs:
  - `CAMPAIGN_NANO_BANANA_REQUEST_TIMEOUT_MS` default: `90000` (was `45000`)
  - `CAMPAIGN_PER_TARGET_TIMEOUT_MS` default: `240000` (was `120000`)
- Strict reference-lock behavior is unchanged: when reference images are supplied in scratch mode, OpenAI fallback remains blocked to prevent reference drift.

## Campaign Design-Image Inclusion Guardrail
- Campaign Studio generation now treats uploaded **Design images** (logos/badges/overlays) as required brand assets by default.
- In `services/api/src/index.ts`:
  - prompt builder now injects explicit design-asset guardrails when design images are present (including visible logo/badge requirement when logo-like filenames are detected),
  - reference ordering was changed to prioritize design images ahead of inspiration/context references so they are not crowded out by generic photo refs,
  - per-target generate calls pass design-image context into both Nano Banana and OpenAI prompt builders.
- Nano Banana reference-part default limit was increased:
  - `CAMPAIGN_NANO_BANANA_MAX_REFS` default is now `6` (was `4`) to reduce dropped uploaded references in typical multi-image runs.
- Campaign Studio UI helper text now clarifies that design images are treated as required by the generator (`apps/web/src/app/page.tsx`).

## Campaign Generated Copy Visibility
- Campaign generation now persists an auto social caption in metadata when Facebook/Instagram feed targets are selected and no explicit caption is already set (`services/api/src/index.ts`).
- Campaign Studio generated asset cards now show:
  - `Auto caption` directly under Facebook/Instagram generated images.
- SMS output is now text-only in Campaign Studio:
  - no SMS image render target is generated in `/campaigns/generate`,
  - prompt/detail links are enforced into generated `smsBody`,
  - SMS send action is launched from the dedicated SMS draft block (`Send SMS`) instead of an SMS image frame.
- This keeps social copy visible in-image frames while keeping SMS copy in the dedicated draft/send area (`apps/web/src/app/page.tsx`, `services/api/src/index.ts`, `services/api/src/domain/campaignBuilder.ts`).

## Campaign Copy Readability Fix
- Campaign generated-image copy blocks (Auto caption / SMS draft) now use dedicated high-contrast styling classes to avoid dark-theme utility overrides washing out text.
- Added in `apps/web/src/app/page.tsx`:
  - `.lr-campaign-copy-block`
  - `.lr-campaign-copy-label`
  - `.lr-campaign-copy-text`
- Styled in `apps/web/src/app/globals.css` with forced dark text on a light card background for reliable readability in Campaign Studio.

## Cadence Anti-Repetition Guard
- Follow-up cadence no-repeat logic in `services/api/src/index.ts` now blocks **near-duplicate** drafts, not only exact body matches.
- `selectNonRepeatingCadenceMessage(...)` now checks semantic overlap against recent outbound cadence messages (token overlap + repeated long-sentence detection) before accepting a candidate.
- Context and personalization tail lines are now skipped when that line (or near-equivalent sentence) was already used recently, preventing repeated endings like “Hope your ... search is going smoothly.”
- This guard is applied in both:
  - cadence send loop
  - cadence regenerate draft path
- Cadence personalization lines now also block weather/riding-condition small-talk tails (e.g., “Hope the weather’s been good for riding...”) to keep follow-up tone focused and consistent.
- Cached cadence personalization lines now pass through the same blocklist; previously generated weather/riding tails are auto-cleared instead of being reused when cache keys remain unchanged.

## Cadence Tone Refresh
- Standard and engaged follow-up SMS template banks were rewritten for a friendlier, more down-to-earth dealer voice (less pushy sales language) while keeping cadence structure and placeholders intact.
- Slot/no-slot variant pools and cadence fallback lines were aligned to the same tone so regenerate and scheduled sends stay consistent.
- Email follow-up template bank was also softened to match the updated SMS tone.

## Manual Outbound Booking Guardrail
- Manual outbound messages now treat scheduling **questions/offers** as offer-only and do not auto-confirm bookings.
- Messages with question-form scheduling language (for example, “would today work at 2:45 or 3:15?”) no longer trigger `manual_outbound_schedule_confirmed`.
- Manual outbound booking confirmation now requires explicit booking statement language (for example, booked/confirmed/all set), not just generic “works”.

## Trade Clarification Guardrail
- Twilio trade clarification flow now supports **model correction** in addition to year correction for sell/trade leads.
- Correction inputs like “It’s a 2013 Harley SuperGlide Custom” now update both:
  - `lead.vehicle.model`
  - `lead.tradeVehicle.model`
- Correction acknowledgement line now appears when either year or model was corrected.
- Initial Room58 sell acknowledgment now prefers `lead.tradeVehicle` year/model for bike label text before falling back to `lead.vehicle`, preventing wrong-year/wrong-model opener copy when ADF includes multiple vehicle contexts.

## Twilio Reaction No-Reply Guardrail
- Twilio inbound reaction-only texts that quote a prior outbound message (for example `👍 to "..."` and iOS-style `Liked "..."`) are now treated as **no-reply signals**.
- Behavior in `/webhooks/twilio` (`services/api/src/index.ts`):
  - inbound is still recorded on the conversation timeline
  - cadence pause-on-inbound still applies
  - no AI draft is generated and no outbound SMS is sent
- This prevents reaction acknowledgements from triggering unnecessary follow-up drafts.

## Inbox Closed/Sold Filter Guardrail
- Sold lead detection in web inbox now normalizes by:
  - `closedReason` (case-insensitive, includes sold token),
  - `sale.soldAt`, and
  - `followUpCadence.kind === "post_sale"` (legacy/edge-data fallback).
- Archive filter now excludes those sold leads consistently, so sold deals do not linger under Archive/closed view when marked sold.
- Sold/Closed status badges in inbox rows and conversation header now use the same normalized sold detection.
- Hold filter now excludes sold leads as well (sold and hold are treated as mutually exclusive in inbox deal filters).
- Filter precedence fix: `status=closed` (non-sold) is now always treated as archived even if legacy hold fields still exist on the record.

## Post-Sale Mode-Agnostic Delivery Guardrail
- In `processDueFollowUps` (`services/api/src/index.ts`), `post_sale` cadence now bypasses suggest/human draft gating and always runs through send/fallback delivery.
- This means sold follow-ups still deliver when a conversation remains in `human` mode or when global mode is `suggest`.
- Non-post-sale cadence behavior is unchanged (still drafts in suggest/human review flows).
- Additional post-sale fix: appointment-booked skip now applies only to non-post-sale cadences.
  - Previously, any sold lead with `appointment.bookedEventId` could be skipped before post-sale send logic.
  - Post-sale cadence now continues and sends even when the original appointment event ID is present.

## Voice Call Owner Guardrail
- Voice call initiation (`POST /conversations/:id/call`) no longer reassigns a lead owner if the conversation is already assigned.
- “Assigned” now means **either** `leadOwner.id` or `leadOwner.name` is present.
- First-caller auto-assignment only occurs when the lead is truly unassigned (no owner id and no owner name).
- Existing behavior to fill in a missing owner name still applies when owner id already exists.

## Sold Card Vehicle Label Guardrail
- Inbox row vehicle text now prefers sold-unit metadata for sold conversations:
  - `sale.label` first,
  - then `sale.year/make/model/trim` (+ color),
  - then `sale.stockId`/`sale.vin`,
  - and only then falls back to original `vehicleDescription`.
- This prevents sold cards from showing stale inbound lead condition/model text (for example, old “New …” labels) after a different pre-owned unit is marked sold.
- API list payload alignment:
  - `listConversations()` now includes `sale` in `/conversations` list rows so inbox cards can access sold-unit metadata without opening detail first.

## Sold Status Detail Modal
- In conversation header, the `Sold` status badge is now clickable and opens a read-only purchased-motorcycle modal.
- The lower status line `Sold` text is also clickable and opens the same modal.
- Modal content uses existing UI styling (white card modal, bordered sections) with higher-contrast text on light backgrounds:
  - dark label/value text for all fields,
  - explicit sold-unit details (`sale.label`, year/make/model/trim/color, stock, VIN, sold-by, sold-at, note),
  - clear fallback notice when sold-unit details are not yet recorded.

## Walk-In Source Anchoring Guardrail
- `inferWalkIn(...)` now anchors walk-in detection to the **first inbound ADF source line**.
- If first-touch ADF source is non-walk-in (for example web/marketplace source), later lead-source updates (such as Dealer Lead App ADF entries) no longer flip the conversation to walk-in.
- Explicit `lead.walkIn=true` still takes priority when a lead is truly created as walk-in.

## Traffic Log Pro Walk-In Routing Guardrail
- Added explicit lead-source rule in `services/api/src/domain/leadSourceRules.ts`:
  - `Traffic Log Pro` => bucket `in_store`, CTA `contact_us`.
- In `services/api/src/routes/sendgridInbound.ts`, initial Traffic Log Pro ADF leads now hard-prioritize walk-in routing:
  - force classification to in-store/contact for initial Traffic Log Pro ADF turns,
  - block credit/prequal routing for that initial walk-in turn even if comments include words like `credit`/`finance`/`credit union`,
  - walk-in responder selection now keys off initial ADF + (Traffic Log Pro source OR `in_store` bucket).
- Effect: walk-in comments are treated as context for the walk-in response logic, not as standalone credit/prequal submissions.

## Hold Status Detail Modal
- In conversation header, the `Hold` status badge is now clickable and opens a read-only hold-unit modal.
- The status line text (`Hold` / `Hold until ...`) is also clickable and opens the same modal.
- Modal styling matches existing UI cards/modals and uses high-contrast label/value text on light backgrounds.
- Modal shows hold metadata when present:
  - `hold.label`, year/make/model/trim/color, stock, VIN,
  - hold-until time, hold type (`Bike on order`), reason, updated timestamp, and notes.

## Mention Handoff Guardrail
- Mention-based handling no longer defaults to third-person handoff copy (`I'll let {name} know`) for simple acknowledgements/signoffs.
- In both Twilio realtime and regenerate mention paths (`services/api/src/index.ts`):
  - if the mentioned name matches the current sender identity, or the inbound is courtesy-only (thanks/signoff with no request), reply stays direct (for example, “You’re welcome — have a great day too.”),
  - handoff phrasing is only used when there is an explicit handoff/callback signal.

## Ride Challenge Cadence Override
- Ride Challenge ADF leads now always get the dedicated long-term reminder cadence anchored to the Ride Challenge schedule (September 15 target, with existing late-season catch-up rules), even when purchase timeframe says “not interested.”
- In `services/api/src/routes/sendgridInbound.ts`:
  - Ride Challenge cadence scheduling was centralized into a reusable helper.
  - Non-initial Ride Challenge ADF updates now still enforce the Ride Challenge long-term reminder.
  - Generic `not_ready_no_timeframe` pause/stop logic is bypassed for Ride Challenge leads so the challenge reminder is not removed.

## DDP Cadence Quality + Timing Alignment
- Follow-up cadence messaging in `services/api/src/index.ts` was refreshed to align with DDP lead-handling guidance:
  - stronger value-forward language (price/payment snapshot, side-by-side compare, incentives, trade support),
  - less repetitive “quick check-in” phrasing,
  - clearer update-only/pause options in later steps.
- Updated template banks:
  - `FOLLOW_UP_MESSAGES`
  - `FOLLOW_UP_VARIANTS_WITH_SLOTS`
  - `FOLLOW_UP_VARIANTS_NO_SLOTS`
  - `FOLLOW_UP_VARIANTS_NO_MODEL_NO_SLOTS`
  - engaged slot/no-slot variant maps
  - `EMAIL_FOLLOW_UP_MESSAGES`
  - cadence fallback helpers (`buildCadenceCheckInFallbacks`, early promo wording)
- Label hygiene:
  - follow-up email cadence now uses resolved cadence model label when available; avoids awkward `Other/full line` style labels in cadence emails.
- Day-offset schedule updated in `services/api/src/domain/conversationStore.ts`:
  - from `[1,2,4,6,8,10,12,14,18,21,27,35,45]`
  - to `[1,2,3,5,7,10,15,21,30,45,60,90,120]`
- Timing accuracy fix (important):
- corrected date math in `computeFollowUpDueAt(...)` and `computePostSaleDueAt(...)` so `day + N` cadence sends land on the intended local calendar day in the configured timezone.

## Finance Down-Payment Parse Guardrail
- Down-payment extraction now normalizes compact punctuation formats before parsing (for example `1000'down`, `1000-down`).
- Applied in both:
  - shared payment budget parser (`services/api/src/index.ts` -> `parseDownPaymentForBudget(...)`)
  - orchestrator payment parser (`services/api/src/domain/orchestrator.ts` -> `parseDownPayment(...)`)
- Purpose:
  - when the customer already gave down payment, do not ask for down again;
  - keep live and regenerate payment follow-up behavior aligned.
- Additional payment-follow-up behavior:
  - when customer provides `term + down` and monthly target is missing, run a ballpark payment calculation immediately when a price anchor is available (inventory unit, lead price, or last outbound price anchor), instead of asking for monthly again.
  - guard against accidental monthly-budget carryover when the same numeric token is clearly a down-payment value.

## Humanized Cadence Copy Pass
- Follow-up wording in `services/api/src/index.ts` was further adjusted to sound less scripted and less pushy while keeping deterministic cadence behavior unchanged.
- Updated language patterns now favor:
  - conversational check-ins ("just checking in", "no rush"),
  - low-friction asks ("want me to send..."),
  - simpler wording over sales-heavy phrasing ("quick breakdown", "simple compare").
- Updated banks/functions:
  - `FOLLOW_UP_MESSAGES`
  - `FOLLOW_UP_VARIANTS_WITH_SLOTS`
  - `FOLLOW_UP_VARIANTS_NO_SLOTS`
  - `FOLLOW_UP_VARIANTS_NO_MODEL_NO_SLOTS`
  - engaged slot/no-slot maps
  - `EMAIL_FOLLOW_UP_MESSAGES`
  - `buildEarlyCadencePromotionOverride(...)`
  - `buildCadenceCheckInFallbacks(...)`

## Campaign Caption Prompt-Sanitization Guardrail
- Auto caption generation for social posts now strips internal prompt/instruction language and keeps customer-facing copy only.
- Added instruction-signal detection for phrases like “generate campaign,” “output format,” “make sure,” drag/drop UI text, and logo-placement instructions.
- Behavior updates:
  - API (`services/api/src/index.ts`): `campaignAutoSocialCaption(...)` now ignores instruction-like existing captions and rebuilds from sanitized campaign detail.
  - API generate-save path refreshes stale instruction-like `metadata.socialCaption` for feed targets instead of preserving bad prompt text.
  - Web (`apps/web/src/app/page.tsx`): `campaignAutoPublishCaption(...)` and `campaignBuildCatchyCaption(...)` now use the same sanitization logic, so preview cards show customer-facing captions even for older campaigns with stale metadata.

## Campaign RSVP Caption Guardrail
- Social auto captions no longer default to RSVP/“save your spot” language for event posts.
- Default event CTA is now neutral: `Message us for event details.`
- RSVP CTA is only used when the campaign prompt/content explicitly includes RSVP/registration intent keywords (for example: `rsvp`, `register`, `book a spot`, `save your spot`).
- Implemented in both:
  - API caption generator (`services/api/src/index.ts`)
  - Web caption preview fallback (`apps/web/src/app/page.tsx`)

## Cadence Draft Invariant Coverage Tweak
- Expanded inventory-prompt detection in `services/api/src/domain/draftStateInvariants.ts` to include common fallback phrasing:
  - `Happy to check inventory right now...`
  - `specific year, color, or trim`
- This closes a guardrail gap where finance-priority turns could occasionally allow an inventory-style fallback prompt instead of being blocked by `finance_priority_inventory_prompt_guard`.

## Walk-In Owner Guardrail + Parser Latency
- In `services/api/src/routes/sendgridInbound.ts`:
  - added explicit owner parsing support for inbound text labels like `Salesperson:`, `Owner:`, and `Assigned to:`.
  - hardened walk-in owner assignment to avoid using forwarded email vendor/sender names for generic `Walk In` sources unless an explicit salesperson is present (or source is Traffic Log Pro).
  - applied the same owner-fallback guardrail in both initial conversation-owner assignment and walk-in-specific branch to keep behavior consistent.
  - changed ADF parser fan-out (`dialog_act`, `intent`, `journey_intent`, `inventory_entities`, `response_control`, `faq_topic`, `walkin_outcome`) from sequential awaits to parallel execution with per-parser fail-open handling.
- Purpose:
  - prevents owner pollution when ADF emails are forwarded,
  - reduces “AI • thinking” dwell time caused by stacked sequential parser latency.

## Mention Clarification Guardrail (Coworker Names)
- In `services/api/src/index.ts`:
  - ambiguous teammate-name clarification (`Just to confirm — did you mean X or Y?`) now only triggers when the inbound text actually requires person disambiguation for a handoff/callback action.
  - if a message contains actionable non-mention intent (especially scheduling/pickup time updates), mention shortcut handling is bypassed so normal routing handles the request.
  - applied to both live inbound routing and regenerate routing paths.
- Purpose:
  - prevents coworker name mentions in context (for example, “Scott has insurance cards”) from interrupting scheduling flows with unnecessary clarification prompts.

## Parser-First Salesperson Mention Routing
- Salesperson mention handling should be parser-first (LLM) with deterministic regex only as fallback.
- Implemented in `services/api/src/domain/llmDraft.ts` and `services/api/src/index.ts`:
  - new parser: `parseSalespersonMentionWithLLM(...)` classifies mention intent (`handoff_request`, `context_reference`, `none`) and optional `target_first_name`.
  - both live inbound routing and regenerate routing now consult this parser before ambiguous-name clarification or mention handoff shortcut logic.
  - deterministic mention rules remain as fallback when parser confidence is below threshold.
- Default confidence gate:
  - `LLM_SALESPERSON_MENTION_CONFIDENCE_MIN` (default `0.72`).

## Walk-In Owner Detection (TLP XML Source Attr)
- In `services/api/src/routes/sendgridInbound.ts`:
  - `extractLeadMeta(...)` now returns `sourceFromId` from `<id source=\"...\">`.
  - Traffic Log Pro source detection now checks both provider/source label and XML ID source attribute.
  - for initial trusted walk-in routing, if owner was only manager fallback, vendor-contact salesperson can replace manager owner when confidently matched.
- Purpose:
  - for payloads where provider is `Walk In` but XML id source is `Traffic Log Pro`, owner routing can still trust vendor contact salesperson (for example `Scott Hartrich`) instead of falling back to manager.

## ADF Callback To-Do Scheduling (Parser-First + Time Fallback)
- In `services/api/src/routes/sendgridInbound.ts`:
  - callback intent detection is now parser-first with non-service heuristic fallback (when parser confidence does not explicitly route callback),
  - callback time hint extraction now reads explicit time windows from inquiry text (for example `around 1-2pm`),
  - callback schedule builder now supports time-only callback hints (no weekday token) and converts them into timezone-aware `dueAt`/reminder times.
- Behavior:
  - initial ADF leads that ask for a callback window now create/update a `call` to-do with schedule metadata instead of only generic `other` follow-up.
  - service callback flows keep service-owner routing/handoff behavior while using the same normalized callback summary/schedule format.

## Walk-In Routing Guardrail (TLP Transport vs Walk-In Intent)
- In `services/api/src/routes/sendgridInbound.ts`:
  - walk-in routing no longer triggers solely because ADF XML transport metadata says `source=\"Traffic Log Pro\"`.
  - walk-in branch now requires trusted walk-in intent signals (explicit walk-in source label or walk-in/step phrasing in comment/inquiry).
  - owner fallback logic still supports TLP transport metadata for salesperson mapping where appropriate.
- Purpose:
  - prevent standard Room58 / sales ADF leads from being misrouted into walk-in response templates when they are only transported through Traffic Log Pro.

## Timed Callback Request Handling (No Auto-Draft + Timed Call To-Do)
- In `services/api/src/routes/sendgridInbound.ts`:
  - ADF leads (not walk-in flow) with parser-confirmed callback request and resolvable callback time now suppress automatic customer draft creation,
  - system creates a scheduled `call` to-do (`Call requested: <time hint>`) with reminder metadata,
  - conversation is set to manual handoff (`callback_requested`) so cadence does not keep generating follow-up drafts ahead of the requested call window.
- Parser-first policy:
  - callback detection remains parser/router first (`parseIntentWithLLM` + `parseRoutingDecisionWithLLM`), with deterministic fallback only when parser confidence does not provide intent/time.
- Additional behavior:
  - timed callback requests now short-circuit to a to-do-only return path (no customer draft generation),
  - owner notification SMS is sent to lead owner when possible; failures log a `note` to-do for visibility.

## UI Thinking Guardrail (Callback Manual Handoff)
- In `apps/web/src/app/page.tsx`:
  - manual-handoff reason `callback_requested` is treated as no-customer-reply mode for ADF inbound.
- Purpose:
  - prevents misleading persistent `AI • thinking` state when backend intentionally performs callback to-do-only routing.

## Callback Few-Shot Coverage
- Added explicit callback few-shot examples in `services/api/src/domain/llmDraft.ts`:
  - intent parser example for `call me around 1-2pm ... I work night shift`,
  - routing parser example mapping the same pattern to `primary_intent=callback`.
- Purpose:
  - improve parser confidence and consistency on time-window callback requests from ADF leads.

## Offers URL in Profile + Cadence/Initial Usage
- Dealer profile supports a dedicated offers link: `dealerProfile.offersUrl` (UI + API schema).
- Follow-up cadence insertion point:
  - Step 4 (0-based `stepIndex === 3`) is the offers step and now appends `Current offers: <url>` when available.
  - Applied to both SMS and email cadence templates, including cadence regenerate parity.
- Initial ADF offer-link behavior:
  - `Meta Promo Offer` sources include the offers link in the initial outbound draft.
  - Room58 leads include an offers link only when a promo-note URL is present in inquiry/comment text.
  - URL precedence is: promo-note URL (when detected) -> dealer profile `offersUrl`.

## Draft Cleanup Guardrail (Dangling Thanks Fragment)
- In `services/api/src/domain/tone.ts`, deterministic-tone post-processing now repairs dangling acknowledgement fragments before saving drafts/messages.
- Guardrail examples:
  - `thanks for the.` -> `thanks for the update.`
  - `thanks for your.` -> `thanks for your message.`
- Purpose:
  - prevent broken SMS drafts when upstream wording or rewrite rules produce truncated acknowledgement tails.

## Hold Modal Contrast Pass
- In `apps/web/src/app/page.tsx`, the `Mark bike on hold` modal now uses higher-contrast text and controls on white surfaces.
- Updated contrast targets:
  - headings/helper labels/body copy,
  - inventory list row text and selected-row state,
  - held badge visibility,
  - action buttons (`Cancel` + orange primary `Save hold`).

## Contact Groups + Campaign Suppression Guardrail
- Contact group filters now support `motorcycleInterest` end-to-end:
  - schema/store update in `services/api/src/domain/contactListsStore.ts`,
  - filter matching in `services/api/src/index.ts` (`contactMatchesListFilter(...)`),
  - UI controls in `apps/web/src/app/page.tsx` (dynamic group rules panel).
- Contacts UI now supports adding a single selected contact into a chosen group directly from contact detail:
  - manager-only `Add to group` control in contact detail pane,
  - persists by patching group `contactIds`.
- Campaign send hard exclusions are now enforced server-side in `/contacts/broadcast`:
  - skip recipients with contact status `suppressed` or `archived` for both SMS and email sends.
- Campaign SMS opt-out compliance:
  - when sending campaign SMS (`campaignId`/campaign context), API auto-appends `Reply STOP to opt out.` unless already present,
  - send dialog now shows explicit footer/suppression note.
- Campaign mass-text branded link rewrite:
  - `/contacts/broadcast` now rewrites sensitive raw URLs in SMS body (direct image asset links and any `*.leadrider.ai` links),
  - removed links are replaced with a branded fallback URL using precedence: request `brandedLinkUrl` -> dealer profile `offersUrl` -> dealer profile `website`,
  - objective: avoid exposing raw JPEG asset URLs and avoid `leadrider.ai` links in customer-facing mass texts.
- STOP behavior remains suppression-backed:
  - STOP replies continue to flow into suppression handling; suppressed contacts are excluded from future campaign sends.

## Test Ride Inventory Gate
- Test-ride scheduling now requires a matching in-stock unit before offering appointment slots.
- Implemented in `services/api/src/domain/orchestrator.ts`:
  - added test-ride inventory gate (`evaluateTestRideInventoryGate(...)`) using model/year + hold/sold filtering,
  - when not in stock, orchestrator now returns a non-scheduling reply with inventory browse link guidance,
  - scheduling slot offers are suppressed in that branch (`requestedTime` cleared, no suggested slots).
- Initial ADF email draft path aligned in `services/api/src/routes/sendgridInbound.ts`:
  - `buildInitialEmailDraft(...)` now honors initial inventory status for test-ride leads,
  - if not in stock, draft instructs customer to choose an in-stock bike from inventory link instead of showing booking CTA.
- Purpose:
  - avoid booking customers on motorcycles not currently available for test ride.

## Campaign Studio Visibility Pass (Single-Concept vs Email Digest)
- In `apps/web/src/app/page.tsx` and `apps/web/src/app/globals.css`:
  - added a high-contrast `Current Output Behavior` banner under Step 2 output selection,
  - banner now explicitly states active-mode behavior:
    - image outputs: one campaign concept per generated asset,
    - email output: multi-section digest layout support,
    - flyer output: print-ready with no social caption.
  - added an `Email digest preview` card block in the email panel that shows section cards derived from the current email draft text.
- Purpose:
  - make backend campaign behavior changes immediately visible in UI and reduce ambiguity about what each output mode will generate.

## Campaign Studio Email Lockers (Asset Locker + Context Locker)
- In `apps/web/src/app/page.tsx` and `apps/web/src/app/globals.css`:
  - when output target is `Email`, UI now shows a dedicated locker panel:
    - `Asset Locker`: reusable generated image assets from active campaigns with one-click `Use` into reference images.
    - `Context Locker`: add one or more reusable campaigns, then apply combined prompt/brief/reference/design context in one action.
  - uploads remain available in existing upload cards (locker is additive, not a replacement).
  - added default email behavior toggle: include the current campaign’s primary generated image in email context by default.
- Purpose:
  - reduce repeated uploads, make cross-campaign reuse obvious, and keep email generation setup clear and low-friction.

## Campaign Studio Email Preview (No JPEG in Email Mode)
- API change in `services/api/src/index.ts`:
  - email target no longer requires generated image assets (`campaignAssetTargetRequiresGeneratedImage` excludes `email`).
  - email target generation status now marks `ready` when subject + body (text/html) are present.
- UI change in `apps/web/src/app/page.tsx` and `apps/web/src/app/globals.css`:
  - `Generated Output` now renders a live HTML preview iframe when active target is `Email`,
  - email mode no longer uses the image/JPEG preview slot in that panel,
  - added `Open Preview` and `Download HTML` actions for quick QA/share.
- Purpose:
  - make email generation strictly HTML-first and remove confusing image-only preview behavior in email mode.

## Email Locker Auto-Merge + Distinct Image Enforcement
- In `apps/web/src/app/page.tsx`:
  - email generate now auto-merges selected `Email Context Campaigns` (locker) into generation payload (prompt context + reference/design images + brief files) without requiring a separate apply click.
  - current campaign primary generated image can be included in email context via the existing toggle (instead of forcing all generated assets).
  - locker row thumbnails use `object-contain` to avoid visual cropping in the selector list.
  - locker-selected campaigns no longer inject `Design images` into Email generation context; locker now contributes prompt/details + reference context while keeping design uploads manual.
  - Email generate now preserves the visible Step 2 URL text fields after save/reload so locker auto-merge does not flood `Reference images`/`Design images` inputs in the UI.
  - Email locker context now contributes a compact, per-campaign reference set (single canonical image per selected campaign) plus explicit campaign-level image/brief lines in prompt context to improve text/image matching and reduce near-duplicate visual spam.
  - Email locker context now picks a single canonical primary image per selected campaign (target-priority based) to reduce duplicate/redundant mixed-style image blocks in generated HTML.
  - In Email mode, explicit user `Reference images` are prioritized ahead of locker context images so start-from-scratch reference anchors remain primary.
  - when user already provides email reference images, locker image contribution is now capped tighter to reduce cross-campaign drift and random placement.
  - email context block now marks locker campaigns as required digest sections so details stay grouped by campaign (instead of blending all campaign text into one generic block).
- In `services/api/src/domain/campaignBuilder.ts`:
  - email HTML completeness validation now checks distinct image URL usage from provided campaign image library (prevents one image being repeated for all sections when multiple images are supplied).
  - LLM/rescue instructions explicitly require distributing distinct provided images across sections.
  - email section schema now supports `image_url` per section; renderer honors section-level image mapping while deduping section image reuse.
  - email HTML validation now requires the primary (first) reference image URL to be present and rejects degenerate repeated-single-image outcomes when multiple references are available.
  - HTML normalization now enforces reference image assignment order on non-logo images (first non-logo image is forced to primary reference URL) and injects a hero image if none exists.
  - HTML normalization now strips `Additional visuals` gallery blocks and removes overflow non-logo image tags once the provided image library is exhausted (prevents repeating one campaign image across random blocks).
  - LLM email instructions now explicitly forbid adding additional-visual strips and require one-time image use per URL (unless only one URL exists).
  - when explicit user reference images are provided, email generation now avoids auto-injecting logo/web-search image discovery so selected references remain the source of truth.
  - LLM instructions now allow varied email layouts per campaign while preserving required header, image mapping, and section-detail fidelity.
- In `services/api/src/index.ts` (`/campaigns/generate`):
  - Email Nano variant URLs are appended after explicit references so the active campaign reference/locker ordering stays primary.
  - Email Nano variant reference input is capped to a focused subset to reduce style drift/noise.
  - optional strict mode `CAMPAIGN_EMAIL_NANO_VARIANTS_STRICT=1` can block Email generation when Nano variants are required but unavailable (prevents silent LLM-only layout runs).
  - when Email uses Nano variants successfully, `generatedBy` is promoted to `nano_banana` and metadata records `emailLayoutGenerator` for traceability.
- Purpose:
  - ensure locker-selected campaigns materially influence output, include active campaign visuals, and improve image variety/fit in generated email layouts.

## Email Nano Variants From Locker Context
- In `services/api/src/index.ts` (`/campaigns/generate`):
  - when `Email` output is requested (and not edit mode), backend now pre-generates fresh Nano Banana visual variants from selected reference/design campaign images before email HTML generation.
  - generated variant URLs are prepended into email inspiration context so LLM email layout can use these newly-sized visuals (not just reusing one existing campaign image).
  - variant generation targets are configurable via env:
    - `CAMPAIGN_EMAIL_NANO_VARIANTS_ENABLED` (default `1`)
    - `CAMPAIGN_EMAIL_NANO_VARIANTS_MAX` (default `3`)
    - `CAMPAIGN_EMAIL_NANO_VARIANT_TARGETS` (default `web_banner,facebook_post,instagram_post`)
  - generation metadata now stores `emailNanoVariantCount` and `emailNanoVariantUrls` for traceability.
- Purpose:
  - improve fit/composition diversity for email campaigns and ensure locker-selected campaigns materially drive new email visuals.

## Email Builder Header + Context Integrity Guard
- In `services/api/src/domain/campaignBuilder.ts`:
  - email HTML normalization now strips competing model-generated header tables that mimic dealer-link headers, so only the required dealer header remains.
  - reference-image reassignment now targets likely content images (not tiny icon/logo/social images), reducing random image swaps in header/footer utility rows.
  - added exported `normalizeCampaignEmailHtml(...)` helper so API routes can force one final normalization pass before save/respond.
- In `services/api/src/index.ts` (`/campaigns/email/generate`):
  - added a final server-side normalization pass using selected context primary image URLs, dealer website, and dealer logo.
  - stopped persisting locker-derived `inspirationImageUrls`, `assetImageUrls`, and `briefDocumentUrls` onto the base campaign record (prevents cross-campaign image pollution on later runs).
  - persist user/base prompt only; store merged email-builder prompt in metadata for traceability.
- Purpose:
  - prevent campaign hero images from leaking into header-logo slots and keep email image/font/content mapping stable across repeated generations.

## Email Builder Compact Dark Shell (Contrast + Width)
- In `services/api/src/domain/campaignBuilder.ts`:
  - email normalization now wraps generated HTML inside a compact centered shell (`~700px` max) to prevent ultra-wide preview/email layouts.
  - required header styling switched to dark high-contrast treatment (white link/text on dark header row).
  - added contrast enforcement pass for common low-contrast dark text colors in generated inline styles.
- In `services/api/src/index.ts` (`/campaigns/email/generate`):
  - added explicit layout directives for dark shell, compact width, and typography mapping fallbacks (serif for vintage blocks, sans for modern blocks).
- Purpose:
  - cleaner composition in previews/emails, stronger contrast, and better visual pairing between campaign art style and section typography.

## Email Builder Section Spacing Enforcement
- In `services/api/src/domain/campaignBuilder.ts`:
  - normalization now applies explicit inter-section spacing both at heading boundaries and across subsequent content images to keep campaign blocks visually separated.
- In `services/api/src/index.ts` (`/campaigns/email/generate`):
  - added explicit layout directive requiring `~18-24px` vertical spacing between campaign sections.
- Purpose:
  - prevent campaign blocks from visually collapsing together in preview and exported HTML.

## Email Builder Campaign Mapping + Secondary Header Strip
- In `services/api/src/index.ts`:
  - `campaignPrimaryImageForEmailLocker(...)` now ranks candidate images against campaign name/prompt/description tokens (with penalties for logo/icon-like assets) before selecting primary image.
  - this improves per-campaign image-to-copy alignment when campaigns have mixed historical assets.
- In `services/api/src/domain/campaignBuilder.ts`:
  - normalization now strips secondary utility top blocks immediately after the required header when they include small image + dealer-link text (e.g., `Visit us online`) to prevent campaign art from appearing in pseudo-header rows.
- Purpose:
  - keep each campaign’s corresponding visual/font context aligned and prevent base campaign image drift into header-adjacent utility rows.

## Email Builder Save Behavior (Text-Only Edit Sync)
- In `apps/web/src/app/email-builder/page.tsx`:
  - save now preserves existing `Advanced HTML` layout by default (no automatic text-to-HTML conversion).
  - when only `Email draft (text)` changes, save updates text while keeping HTML preview/layout intact; notice clarifies layout was preserved.
- Purpose:
  - avoid accidental conversion of rich email layout into plain text while still allowing text-draft edits to be saved.

## Email Builder Deterministic Regenerate Layout
- In `services/api/src/index.ts` (`/campaigns/email/generate`):
  - added deterministic HTML renderer for Email Builder output so regenerate always lands on the same dark-shell structure with required dealer header.
  - output now enforces one section per selected campaign context block (base + locker selection), with stable per-section image mapping and cross-section dedupe when alternates exist.
  - section typography now follows campaign-style hints (vintage/western -> serif, modern/performance -> sans) to keep copy style aligned with paired creative.
  - added consistent CTA button injection with URL/intent-aware labels (e.g., `Book a test ride`, `View offers`, `Apply for credit`) when applicable.
  - removed dependence on model-produced HTML layout for this route; model text/subject still feed content, but final HTML shell/section structure is deterministic.
- Purpose:
  - eliminate regenerate drift and keep Email Builder output visually consistent run-to-run.

## Email Builder Send + Send Test Wiring
- In `services/api/src/index.ts`:
  - added `POST /campaigns/email/send` (manager auth) to send current Email Builder content through SendGrid.
  - supports both live send and test send via payload flag `test: true` (subject is prefixed with `[TEST]`).
  - uses current editor values (`subject`, `emailBodyText`, `emailBodyHtml`) with campaign fallback and stores last-send metadata on the campaign.
- In `apps/web/src/app/api/campaigns/email/send/route.ts`:
  - added Next API proxy route to forward authenticated requests from web to API.
- In `apps/web/src/app/email-builder/page.tsx`:
  - added `Recipient email + Send Email` action.
  - added separate `Test email + Send Test` action.
  - both actions send directly from the Email Builder screen using the current edited HTML/text draft.
- Purpose:
  - allow direct send workflows from Email Builder without leaving the screen and support safe test sends before live delivery.

## Email Builder Cross-Client Centering + Background Fallbacks
- In `services/api/src/index.ts` (`buildDeterministicEmailBuilderHtml(...)`):
  - switched outer shell to stricter email-safe centering (`<center>`, `align="center"`, fixed container width `640`) for more consistent layout in Gmail and Rackspace/OX.
  - added `bgcolor` fallbacks on body/outer/inner tables and wrapper cells so dark background survives clients that ignore CSS-only backgrounds.
  - converted section spacing to explicit spacer tables (instead of relying on table margins) for better cross-client rendering.
  - reinforced centered media/button rendering via `align="center"` and image width attributes.
- Purpose:
  - keep dark-shell branding and centered layout stable across mailbox clients with different HTML/CSS support.

## Email Builder Copy Sanitization (No JSON/URL Dump Noise)
- In `services/api/src/index.ts` (`buildDeterministicEmailBuilderHtml(...)` and helpers):
  - changed `campaignLockerTextSummary(...)` priority to prefer `description -> prompt -> emailBodyText -> smsBody`.
  - added section-copy sanitizers to remove noisy artifacts before rendering:
    - strips `[object Object]`, JSON key fragments (`sms_body`, `email_subject`, etc.), escaped slash noise, and raw URL dumps.
    - drops duplicate title/dealer headline lines in body copy.
    - rejects short/noisy copy chunks and falls back to cleaner sources.
  - body source selection is now sanitized and ranked per section: summary -> generated base copy -> description -> prompt -> sms.
- Purpose:
  - prevent malformed/plaintext serialization noise from appearing in rendered email body text.

## Email Builder Save Sync (Text Edit Updates Preview)
- In `apps/web/src/app/email-builder/page.tsx`:
  - added client-side deterministic HTML sync helper that updates the first email section body copy from edited `Email draft (text)` when layout HTML was not manually changed.
  - save flow now uses synced HTML payload in this case, so preview updates immediately after Save instead of appearing unchanged.
  - preserves section info/footer lines while replacing main copy text.
- In `services/api/src/index.ts` (`buildDeterministicEmailBuilderHtml(...)`):
  - added section/body/info data markers (`data-lr-email-section`, `data-lr-email-section-body`, `data-lr-email-info`) to make safe text-sync targeting deterministic.
- Purpose:
  - make text-only edits reflect in preview without collapsing layout to plain-text HTML.

## Email Builder Main-Section Copy Isolation
- In `services/api/src/index.ts`:
  - deterministic section body source ranking adjusted so per-campaign details are preferred over stale/global digest text.
  - for base section: `generated -> description -> prompt -> summary -> sms`.
  - for locker sections: `description -> prompt -> summary -> sms`.
  - `campaignLockerTextSummary(...)` now prioritizes `description/prompt` before `emailBodyText`.
- In `apps/web/src/app/email-builder/page.tsx`:
  - text-to-HTML save sync now derives only primary-section copy (strips dealer/header lines, URLs, `[object Object]`, and digest noise) before updating first section body.
  - prevents full multi-campaign draft text from being injected under the hero image.
- Purpose:
  - keep text under the main campaign image aligned to that campaign only, without cross-section spillover artifacts.

## Email Builder Prompt-Instruction Guard + No Draft Text Editor
- In `services/api/src/index.ts`:
  - deterministic section copy sanitizer now drops generation-instruction language (for example `Generate...`, `Use the styling...`) from rendered section text.
  - base-section copy now prioritizes main campaign details (`description -> extracted prompt details -> generated fallback`) before generic digest text.
  - prompt-based section copy now uses extracted detail items (event facts) rather than raw prompt instruction paragraphs.
  - persisted `emailBodyText` for email-builder generation is now derived from deterministic HTML output (plain-text extraction), reducing stale/noisy text carryover.
- In `apps/web/src/app/email-builder/page.tsx`:
  - removed editable `Email draft (text)` panel from Email Builder UI.
  - draft text remains internal/auto-derived for send fallback, but user-facing workflow is now HTML-first to avoid confusion.
- Purpose:
  - prevent prompts from being pasted literally into email body and keep main-campaign detail copy clean and deterministic.

## Scheduling Date-Only Guardrail (Live + Regenerate)
- In `services/api/src/domain/conversationStore.ts`:
  - added `parseRequestedDateOnly(...)` to parse date-only scheduling language (for example `May 7th`, `5/7`, `tomorrow`, weekday names) without requiring a time token.
  - includes rollover handling when user gives month/day without year and that date already passed this year.
- In `services/api/src/index.ts`:
  - deterministic slot-offer flow now applies a scheduling window floor from date-only requests, so offers start on/after the requested date instead of defaulting to same-day openings.
  - regenerate visit-timing quick-path now also resolves date-only requests and uses them in reply phrasing.
  - strengthened `parseFutureTimeframe(...)` month-day parsing to support ordinal day tokens (`May 7th`) and produce exact date anchors.
- Purpose:
  - prevent responses like `I have Mon, Apr 27...` when customer says they are unavailable until a future date, and keep regenerate behavior aligned.

## Scheduling Day-Part Guardrail (Small-Talk Bypass)
- In `services/api/src/domain/orchestrator.ts`:
  - strengthened `hasStrongIntentSignal(...)` to treat day-part scheduling phrases as intentful (for example `does the morning work`, `can we do afternoon`, `evening available`).
  - this prevents short scheduling asks from being misclassified as small-talk and returning generic replies like `Sounds good.`.
- Purpose:
  - keep scheduling-intent turns routed into slot/time handling instead of ack-only small-talk responses.

## Jump Start Experience Routing (Stationary Simulator, Not Road Test Ride)
- In `services/api/src/domain/llmDraft.ts`:
  - added parser/router few-shot guidance so jump-start/riding-academy-prep inquiries route as scheduling stop-ins (not inventory-gated test rides).
- In `services/api/src/routes/sendgridInbound.ts`:
  - added jump-start detection and enforced non-test-ride routing (`general_inquiry/contact_us`) for these ADF leads.
  - prevents test-ride inventory checks and test-ride CTA forcing on jump-start inquiries.
- In `services/api/src/domain/orchestrator.ts`:
  - added jump-start detection and forced appointment type to `inventory_visit`.
  - skips test-ride inventory gate when jump-start language is detected.
- In `services/api/src/index.ts`:
  - added jump-start-aware `effectiveTestRideIntent` handling in live Twilio and voice-call scheduling flows.
  - prevents jump-start turns from setting test-ride state, test-ride appointment type, or inventory-gated test-ride responses.
- Purpose:
  - jump-start messages now offer stop-in times directly (stationary simulator workflow) instead of requiring an in-stock road-test bike selection.
