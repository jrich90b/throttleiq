# First-Touch Ack Auto-Send — Spec (dark-by-default, flag-gated)

**Status:** STEP 1 SHIPPED DARK (pure decision + eval + shadow hook). STEP 2 (live
customer-send wiring) is approve-first and not built. Flip is Joe's call.
**Author:** agent-quality session, 2026-06-15.

> Decomposed like Phase-2 model-authority (`turnUnderstandingAuthority.ts`): land the
> pure decision foundation dark first (STEP 1), do the live customer-send wiring as a
> separate, focused, reviewed pass (STEP 2). The send path lives inside a ~6k-line ADF
> handler over a non-trivial async-delivery model — it earns its own change.
**Why:** Latency is the biggest real-world quality lever. The agent *drafts* in ~30s, but the
customer-facing **effective** latency (inbound → first SENT reply) is ~186 min median because
suggest-mode holds every draft for human approval (`scripts/response_latency_audit.ts`: the
`agentDraft` vs `effective` split). A new lead who texts in and hears nothing for 3 hours is the
single most-fixable defect. This feature auto-sends ONLY the first-touch acknowledgement — the
part that is already deterministic and Agent-Voice-Charter-clean — so a brand-new lead gets an
instant, human-quality "got you" while the substantive reply and the rest of cadence stay
staff-approved exactly as today.

## Scope (deliberately narrow)

Auto-send fires for a turn **only if ALL** hold:
1. **First touch:** `isInitialAdf` (provider `sendgrid_adf`, no prior outbound) for ADF, or the
   equivalent first-outbound predicate on a brand-new Twilio/web inbound (no outbound yet in thread).
2. **Deterministic reply:** the reply is built by the deterministic intro/ack path
   (`buildAgentIntro` / `applyInitialAdfPrefix` in `agentVoice.ts` + `sendgridInbound.ts`), NOT by
   the LLM composer (`generateDraftWithLLM`). If the first reply carries substantive inquiry content
   that needed the LLM (specific availability/pricing/scheduling answer per the ADF Inquiry Priority
   rule), it is OUT of scope → stays a staff draft.
3. **All pre-send compliance gates pass** (see below). Any failure → fall back to today's behavior
   (hold as `draft_ai` draft). Fail-safe direction = never auto-send when unsure.

Everything else — every non-first turn, every LLM-composed reply, every cadence follow-up — is
unchanged and still staff-approved. This is additive: it converts the one reply that is already a
deterministic template from "held draft" to "sent immediately," nothing more.

## Where it plugs in (function anchors, not line numbers — they drift)

- **Send/draft gate (SMS):** the suggest-vs-send branch in the live Twilio publish path
  (`publishLiveTwilioReply`, `index.ts`) — today: `mode === suggest` → `appendOutbound(..,"draft_ai")`;
  `autopilot` → `sendTwilioOutboundSmsOrMms(..)` + `appendOutbound(..,"twilio")`. The autopilot
  delivery infra already exists (`getSystemMode`, `isAsyncTwilioAutopilotDeliveryEnabled`,
  `isAsyncTwilioSuggestOnly`).
- **Send/draft gate (email/ADF):** `publishEarlyAdfSmsDraft` / `publishAdfEmailDraft` in
  `sendgridInbound.ts` (currently always draft in suggest mode).
- **First-touch predicate:** `isInitialAdf` / `hasOutboundBeforeInbound` in `sendgridInbound.ts`.
- **Deterministic intro:** `buildAgentIntro`, `buildAgentIntroPhrase`, `applyInitialAdfPrefix`.
- **Compliance pre-send (MUST all wrap the auto-send):**
  - `isSuppressed(phone)` (`suppressionStore.ts`) — opt-out/STOP list.
  - `contactPreference === "call_only"` / `isCallOnlyText` — phone-only → call todo, no send.
  - `isTwilioHandledStopKeyword` / `isOptOut` — STOP handling.
  - `applyDraftStateInvariants` (`draftStateInvariants.ts`) — quality/safety guards; must return `allow`.
  - `ensureInitialSmsOptOutFooter` — first SMS must carry the STOP footer.

## STEP 1 — SHIPPED DARK (this change)

Per the route-centralization law, the auto-send eligibility is a **pure function**, not an inline
`if` scattered across paths:

```
// services/api/src/domain/firstTouchAutoSend.ts
decideFirstTouchAutoSend(input): { send: boolean; reason: string }
//   send=true  iff  enabled && isFirstTouch && isDeterministicReply && !suppressed
//                   && !optedOut && !callOnly && invariantAllow && hasDeliverablePhone
//   send=false otherwise — reason names the first failing gate (fail-safe = hold the draft)
isFirstTouchAckAutoSendEnabled()    // reads FIRST_TOUCH_ACK_AUTOSEND, default OFF
firstTouchAutoSendDebugEnabled()    // reads FIRST_TOUCH_ACK_AUTOSEND_DEBUG
```

- **Eval:** `scripts/first_touch_autosend_eval.ts` (`first_touch_autosend:eval`, `--self-test`, in
  `ci:eval`): dark no-op + the one send case + all 7 fail-safes + parity-by-construction.
- **Shadow hook:** at the deterministic early-ADF SMS opener (`publishEarlyAdfSmsDraft` in
  `sendgridInbound.ts`), behind `FIRST_TOUCH_ACK_AUTOSEND_DEBUG`, logs `wouldSend`/`reason` for each
  first touch — **no send**. Turn the debug flag on for a day to measure how often a flip WOULD fire
  and why, before STEP 2. Zero behavior change with the flag off (the default).

## STEP 2 — live customer-send wiring (NOT built; approve-first)

Convert the shadow decision into a real send at the deterministic opener sites. Required before flip:
- Import the compliance checks into the ADF handler (`isSuppressed(leadKey)`, `isOptOut`) — today
  `sendgridInbound.ts` does NOT import them; the shadow hook stubs `suppressed:false`/`optedOut:false`.
- Validate `leadKey` is a deliverable E.164 phone (ADF leadKey can be an email) — already gated by
  `hasDeliverablePhone`.
- On `decision.send`, send via the proven customer-SMS pattern (twilio client → `messages.create` →
  `appendOutbound(conv, from, to, text, "twilio", sid, mediaUrls)`, with the `isRecentDuplicateOutbound`
  guard) instead of the `draft_ai` append; `from` = dealer Twilio number, `to` = `leadKey`.
- Label which opener call sites are genuinely deterministic (set `isDeterministicReply` true only there;
  `publishAdfDraftForPreferredContact` may carry LLM-composed text → stays draft until each caller is
  audited). When unknown, leave it false (no send).
- Extend the eval with an integration-shaped fixture per wired site.
- Regenerate path is NOT a parity concern: it requires suggest mode and only produces drafts (never sends).

- **Flag (default OFF):** `FIRST_TOUCH_ACK_AUTOSEND` (`=1` to enable). Off = exact no-op.
- Optional dealer-profile gate so it's per-dealer, mirroring other rollout gates.

## Eval (deterministic, wired into ci:eval)

`scripts/first_touch_autosend_eval.ts` (`first_touch_autosend:eval`, `--self-test`, no network):
- flag OFF → `send=false` for every fixture (proves dark = no-op).
- flag ON + first-touch + deterministic intro + clean compliance → `send=true`.
- flag ON but: not first touch / LLM-substantive reply / suppressed / call_only / STOP / invariant
  `allow=false` → `send=false` (each its own fixture). These are the fail-safe guarantees.
- parity fixture: same decision in the Twilio gate and the ADF/email gate.

## Rollout (flip is approve-first)

1. Ship dark (flag off). tsc + ci:eval green. No customer impact.
2. Joe flips `FIRST_TOUCH_ACK_AUTOSEND=1` for americanharley as a canary.
3. Watch, 48–72h: `response_latency:audit` effective-send median should drop sharply for first
   touches; `compliance:audit` must stay **0** sends-after-optout / 0 call_only auto-sends;
   `intent_handled:audit` + voice-charter unaffected (deterministic copy unchanged).
4. Kill switch: set flag back to `0` (instant revert to all-draft).

## Open product decisions for Joe

- **(A) Auto-send the deterministic first reply** (recommended): the existing greeting/ack reply,
  when it's the template path, goes out immediately. Simplest; reuses copy staff already trust.
- **(B) Separate holding ack:** always auto-send a tiny "Hey {name}, it's {agent} at {dealer} —
  got your note, give me a few and I'll get you details" and keep the substantive first reply as a
  staff draft. Guarantees an instant touch on EVERY new lead (even LLM-substantive ones) but adds a
  second outbound message. More coverage, slightly chattier.
- **Channels:** SMS-first (where the 186-min pain is measured), or SMS+email together?
