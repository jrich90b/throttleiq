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
   - Rider-to-Rider finance inquiry leads are deterministic and policy-gated by dealer profile.

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
