# Hardcoded-Override Triage — 2026-08-06

Follow-up to PR #573 ("Dealer transaction policy: a direct request beats a background
mention", merged `75b8827`). That PR fixed one route where a keyword fallback **faked its
own confidence score** (0.76, hand-picked over the 0.74 accept bar) and **asserted the
customer "explicitly asked"** for something they never asked — letting a keyword scan that
never read the sentence beat the LLM parser that did. The PR recommended a codebase-wide
sweep for the same trick. This document is that sweep.

**How it ran:** 5 parallel search agents (one per code region, all NUL-byte-aware — see
Coverage), then 9 independent adversarial verifiers whose only job was to *refute* each
flagged finding by re-reading the code. 62 unique sites triaged; several sites were found
by two searchers and confirmed by two separate verifiers. **0 findings were refuted.**
Line numbers below are as of `main@119992a`; helper names are the durable anchors.

---

## The plain-English verdict

The trick from PR #573 is alive in **three more customer-facing places**, plus one
structural cousin:

1. **First-time-rider route** — the worst one. The backup keyword scanner counts *any
   question mark* as "they explicitly asked," stamps a fake 76% score over the 74% bar,
   and the real reader is **never allowed to say "this isn't a new-rider question" — at
   any certainty**. On the email lane, its fake decision actively **switches off a real
   price question** — the exact harm #573 fixed. Two hand-duplicated copies of the code
   (SMS lane + email lane).
2. **Post-sale pickup route** — half-fixed. A *confident* "not this" from the reader is
   respected, but a hedged one (the exact case #573 fixed) still loses to a keyword scan
   with a fake 79% score over the 78% bar. When it fires wrongly it doesn't just send a
   wrong reply — it silently flips the lead to manual handling and **shuts off all
   automatic follow-ups**. Three inline copies, one of which invents "explicitly asked"
   from a question mark.
3. **Test-ride rewrite inside the reader itself** — the sneakiest. Even when the reader
   is *sure* the customer is not asking for a test ride, a history keyword check
   overwrites the answer to "test ride, explicitly requested, ≥95% sure" — *inside* the
   parse function, with no marker. Every log, shadow comparison, and eval sees it as the
   LLM's own reading. That quietly poisons the measurements the consolidation program
   uses for cutover decisions.
4. **Finance policy resolvers** — honest scores, dishonest structure: even when an
   accepted parse says "this is NOT an approval-transfer / loan-term question," the
   keyword fallback can still send the finance-policy template.

**46 of the 62 sites came back clean** (fail-closed `confidence: 0` fallbacks, env-gate
defaults, clamps, staff-context stamps, prompt text, and the already-fixed #573 site).

**Nothing was auto-fixed.** Every fix below changes what customers are told, which is
Tier 2b under the autonomous-loop contract (ask-first: PR + ping Joe, never auto-merge).
Two orphaned-eval discoveries are candidate Tier 1 work.

---

## Scoreboard

| # | Route | Sites (as of `119992a`) | Fabrication | Bar it beats | Verdict |
|---|-------|-------------------------|-------------|--------------|---------|
| 1 | First-time rider | `parseFirstTimeRiderGuidanceFallback` + `resolveFirstTimeRiderGuidanceDecision` — `index.ts:27385-27402` and duplicated `sendgridInbound.ts:1412-1429` | `confidence: 0.76` + `explicitRequest` from keywords **or any `?`** | `LLM_FIRST_TIME_RIDER_GUIDANCE_CONFIDENCE_MIN ?? 0.74` | **CONFIRMED ×2** (2 finders, 2 verifiers) |
| 2 | Post-sale item pickup | fabricated `PurchaseDeliveryLogisticsParse` — live `index.ts:61476-61481`, regen `53969-53974`, human-mode `60867-60872` | `confidence: 0.79`; human-mode adds `explicitRequest: /\?/.test(body)` | `LLM_PURCHASE_DELIVERY_LOGISTICS_CONFIDENCE_MIN ?? 0.78` | **CONFIRMED ×2** |
| 3 | Test-ride rewrite in parser transport | inside `parseIntentWithLLM`, `llmDraft.ts:6679-6701` | rewrites LLM's `none` → `{intent:"test_ride", explicitRequest:true, confidence: Math.max(conf ?? 0, 0.95)}` | `LLM_INTENT_CONFIDENCE_MIN ?? 0.75` (and any plausible retuning) | **CONFIRMED ×2** |
| 4 | Finance approval-transfer / loan-term | `resolveExternalDealerApprovalTransferDecision` (~`index.ts:9853`) + loan-term sibling | none (honest `confidence: 0`) — consumers ignore confidence entirely | structural bypass, no numeric gate | **CONFIRMED** |

---

## Finding 1 — First-time-rider route (highest priority)

**Plain English.** When someone's message trips the new-rider hint words, we ask the AI
reader what they meant. But the accept rule requires the reader to say "yes, new-rider
topic, explicitly asked, ≥74% sure" — **there is no way for the reader's "no" to count**.
Any other answer, including a rock-solid "this is not a new-rider question," hands
control to a keyword scanner that always produces an accepted-looking answer: it marks
"explicitly asked" if the text merely contains a question mark, and stamps a fake 76%
score. Since the scanner only runs when the hint words already matched, it can never come
back empty. Net effect: **on this route, the AI reader is decoration.** And on the email
lane, the fake decision then disables a detected price question (`pricingInquiryIntent =
false`) — a customer asking what a bike costs can get new-rider boilerplate instead of a
price. This is the sibling PR #573 predicted ("its parser can never say none at any
confidence"), now fully mapped — it's live in **both** lanes, with the Riding
Academy / Jumpstart work (Joe's 8/5 rulings, #560) making this lane hotter.

**Mechanism (verified end-to-end, twice).**
- Fallback: `parseFirstTimeRiderGuidanceFallback` returns
  `{ explicitRequest: asksTestRide || asksRiderCourse || asksBeginnerBike || /\?/.test(text), …, confidence: 0.76 }`
  — `index.ts:27385-27393`, near-verbatim twin `sendgridInbound.ts:1412-1420`.
- Accept fn: `isFirstTimeRiderGuidanceParserAccepted` (`transitionSafety.ts:352-361`)
  requires `explicitRequest && intent !== "none" && confidence >= 0.74` — a parser "none"
  is unacceptable **at any confidence** (the prompt even ships a "none" few-shot:
  returning rider @0.82).
- Resolver: `resolveFirstTimeRiderGuidanceDecision` = `accepted ? parsed :
  fallback(text)` — no middle rule; fallback is unconditional and (given the hint
  precondition) never null.
- Consumption: live SMS early-return → `buildFirstTimeRiderGuidanceReply`
  (`index.ts:~61549`), regen SMS (`~55822`), regen ADF (`~55303`), email lane live
  (`sendgridInbound.ts:5040` + the pricing suppression at `5164-5178`).
- Eval gap: `first_time_rider_guidance:eval` exists (`package.json:24`) but is **not in
  the ci:eval chain**, and it pins the parser only — zero coverage of the resolver.

**Fix shape (Tier 2b, ask-first).** Port the #573 reference
(`resolveDealerTransactionPolicySource`, `inboundPipeline.ts`): parser accepted → parser;
a parse with intent "none" → the route does **not** fire and control falls through to
normal routing (verifier correction: not a silent turn-end); fallback only on genuine
hedge or no-parse (parser disabled/error), tagged `source:"fallback", confidence: 0`.
Lift fallback + resolver into **one shared domain module** consumed by both lanes (the
two copies can drift today), and pin with a decision-table precedence eval mirroring
`scripts/dealer_transaction_policy_precedence_eval.ts`. The extraction-only dedup portion
is Tier 1 behavior-preserving prep.

## Finding 2 — Post-sale pickup route

**Plain English.** Messages like "did I leave my keys / can I grab the seat" go through a
reader whose "no" only counts if it's *confident* (≥78%). A hedged "no" — the exact case
#573 fixed — loses to a keyword scan of broad words (keys, seat, exhaust, pipes, grab,
pick up…) carrying a fake 79% score. A wrong fire is expensive: the customer gets a
pickup reply, and the lead is silently switched to `manual_handoff` with the follow-up
cadence (and related cadences) **stopped** — the system goes quiet on a live lead.

**Mechanism (verified end-to-end, twice).**
- Three fabrication copies: live (`index.ts:61476-61481`), regen (`53969-53974`),
  human-mode (`60867-60872`, which fabricates `explicitRequest: /\?/.test(body)` —
  currently latent, nothing reads it in this flow).
- Guard is only `!isPurchaseDeliveryLogisticsParserConfidentNone` (`index.ts:24229-24236`)
  — a "none" below 0.78 does not veto. The fabricated parse then feeds
  `applyPurchaseDeliveryLogisticsDecision` (`24270-24330`): templated reply + todo +
  `dialogState: purchase_delivery` + `manual_handoff` + `stopFollowUpCadence` +
  `stopRelatedCadences`.
- The 0.79 is the *waved-past* variant: never re-compared to the floor (the fallback path
  bypasses `isPurchaseDeliveryLogisticsParserAccepted` entirely); its only reader is
  `recordRouteOutcome`, where it **impersonates parser confidence** in telemetry. Raising
  the env floor above 0.79 would not stop it — silent coupling.
- Verifier discoveries: `purchase_delivery_logistics:eval` exists (`package.json:229`)
  but is **not in the ci:eval chain**; and the sibling deterministic arms
  (logistics-progress, purchase-delivery-timing) share the same hedged-none gap without
  fabricating a parse.

**Fix shape (Tier 2b).** Fold the three copies into one pure resolver on the #573 shape
(any-"none" ends the lane; fallback only on null-parse/hedged-positive; honest
`source:"fallback", confidence:0` so telemetry stops seeing fake parser confidence), plus
a precedence eval. Wiring the orphaned parser eval into ci:eval is Tier 1 (see Hygiene).

## Finding 3 — Test-ride rewrite inside the parser transport

**Plain English.** One heuristic doesn't even wait for the reader to hedge. If recent
chat mentioned a test ride and this message names a bike, the code takes the reader's
answer — even a 99%-confident "this is not a test-ride request" — and **overwrites it**
with "test ride, explicitly requested, at least 95% sure." Because this happens inside
the reading step itself with no marker, every consumer, log, shadow comparison, and eval
believes the AI reader said it. For a program that decides cutovers by measuring what
parsers say (the consolidation plan, `intent_comprehension:eval`), this is contaminated
evidence.

**Mechanism (verified, twice).** `llmDraft.ts:6679-6701`, inside `parseIntentWithLLM`:
fires only on `intent === "none" && !explicitRequest`, triggered by a history regex
(`/test ride|demo ride|…/` over the last turns — **including our own outbound lines**) +
`inferBikeFromText` on this turn, guarded by a hand-maintained negative-keyword list
(price/payment/availability/photos/specs — which misses e.g. "how much" / "cost" /
"out the door"). It transplants and bumps the LLM's confidence — which may have expressed
0.94-confidence-in-NONE (the prompt's own few-shot teaches exactly that) — onto the
opposite verdict. Live SMS, voice, and email all inherit it; **regenerate never calls
this parser** — regen decides the same situation via the centralized
`shouldTreatInboundAsTestRideBikeSelection` in `routeStateReducer.ts` (shared by live
too), so the transport hack is partially redundant with machinery that already exists.

**Fix shape (Tier 2b).** Shadow-log the override's rescue/over-fire rate first; then
migrate: parser "none" stands, the alternate-bike-in-test-ride-context case is owned by
parser few-shots (the prompt guideline already teaches it) + the centralized reducer
decision — never a fabricated parse result. Additive few-shots/fixtures are Tier 1.

## Finding 4 — Finance approval-transfer / loan-term resolvers (medium)

**Plain English.** These fallbacks are honest about their score (0) — but the code that
uses them ignores scores entirely and acts on "non-null." So even when an accepted parse
said "this is NOT an approval-transfer / loan-term question," a keyword match still sends
the finance-policy template. Same family of harm as #573 (finance policy overriding the
reader), much narrower trigger regexes.

**Mechanism (verified).** `resolveExternalDealerApprovalTransferDecision`
(`index.ts:9853-9863`) + the loan-term sibling (`hasLoanTermFinanceQuestionFallbackHint`):
the parser arm returns only on `accepted && intent === "payments" && flag === true`;
every other outcome — including accepted-with-flag-false and confident "none" — falls to
the regex (`workflowRegressionGuards.ts:2162-2176`). Parity holds (shared resolver,
`scope: live|regen`).

**Fix shape.** Add the #573 middle rule: accepted-parse-with-flag-false, or a parse with
intent "none", ends the turn; fallback only on no-parse / below-floor non-none hedge.
Possible **Tier 2a** if a `docs/policy_charter.md` finance-policy rule genuinely covers
it (verifier note: `finance_pricing_turn_decision:eval` pins `decideFinancePricingTurn`,
not these resolvers — they need their own pin); otherwise 2b.

---

## Watch-list (flagged, not yet adversarially verified — verification capped at 9)

Same pattern family, medium severity, next in line for a verify pass (or fold each into
its cluster's fix PR):

- `sendgridInbound.ts:8593` — factory-order intent asserted by bare keyword scan
  (`/order|factory order|build one|…/`), no confidence involved.
- `llmDraft.ts:15423` — `departmentIntent` promoted from the LLM's "none" to
  parts/service/apparel on keyword cues, inside the merged-slot transport.
- `llmDraft.ts:5174` — `explicitRequest = true` flipped after the LLM returned
  `explicit_request=false`, on schedule/book/appointment keyword cues.
- `domain/inboundReplyActionPrompt.ts:204` — precedence-shape gap: fallback permitted
  whenever confidence < floor, no parser-"none"-ends-turn rule.
- `index.ts:9222` — inline hardcoded floor `>= 0.68` on `JourneyIntentParse` instead of
  the tunable env gate.
- (`index.ts:53973` / `60871` — the regen and human-mode copies of Finding 2; already
  covered by its verifier.)

Lower-severity smells worth a look when nearby (appendix of the full run output):
`turnUnderstandingAuthority.ts:94/110` (missing model confidence treated as **1.0** and
passes the floor — this is the live model-authority canary lane),
`conversationOutcomeAudit.ts:859` (missing critic confidence → 1), `index.ts:65779`
(dialog-act gate quietly relaxed 0.04 below its tunable floor), `index.ts:12821` (voice
watch inline floor 0.55 vs the 0.76 semantic-slot env floor), `index.ts:11633`
(`explicitRequest ?? true` default), `index.ts:27141` (deferral fallback consulted
regardless of parser), `index.ts:27053` (pre-fix resolver shape, no fabrication).

## Cleared — 46 sites

Fail-closed fallbacks (`confidence: 0`, honest `source:"fallback"`), configurable
env-gate defaults (`Number(process.env.X ?? 0.76)` — the legitimate pattern), [0,1]
clamps, staff-/manual-context stamps that never touch customer comprehension
(`manualCadenceContext`, `manualQuoteFollowUp`, `index.ts:52328`), LLM-verdict-token
transports (smallTalk/chatter 0.8/0.75 — the LLM did read the sentence), prompt
instruction strings, soft-tag echoes of already-verified parser verdicts, and the fixed
#573 site itself (`dealerTransactionPolicy.ts` — fabrication deliberately retained but
demoted behind `resolveDealerTransactionPolicySource`, CI-pinned by
`dealer_transaction_policy_precedence:eval`).

---

## Coverage & hygiene discoveries

- **`llmDraft.ts` contains a NUL byte** (~offset 913,518, ≈ line 13,968 of 16,450).
  ripgrep and grep-based tools treat the file as binary and **silently stop there** —
  ~2,480 lines were invisible to every previous sweep of that file. All agents in this
  triage used `grep -a`. Recommend locating and removing the byte (likely inside a prompt
  string — verify byte-identical prompt behavior or accept a deliberate change) so tooling
  stops going blind. Until then: always `grep -a` that file (worth an Ops note).
- **Two orphaned evals:** `first_time_rider_guidance:eval` (`package.json:24`) and
  `purchase_delivery_logistics:eval` (`package.json:229`) exist but are absent from the
  417-entry `ci:eval` chain. Check whether that's deliberate (LLM-eval cost?) — if not,
  wiring them in is additive Tier 1 (the chain guard will then lock them in).
- Sweep stats: 5 finders + 9 verifiers (14 agents, ~478 tool calls); 62 unique sites; 16
  actionable; 9 verified (4 distinct clusters, several double-confirmed); **0 refuted**;
  7 medium findings left unverified by the cap (watch-list above). Territories:
  `index.ts` (~71k lines), `llmDraft.ts` (16,450 lines, NUL-safe), `domain/` (244 files),
  `routes/` (10,175 lines), plus a shape-hunt across all of `services/api/src`
  (~40 distinct `LLM_*_CONFIDENCE_MIN` gates inventoried; 52 `*Fallback(` call sites
  enumerated; `Math.max` bumps, `?? 1` defaults, inline floors, spread-overrides).

## Recommended order

1. **Tier 1 / hygiene (small, low-risk):** investigate + wire the two orphaned evals
   into `ci:eval`; remove the `llmDraft.ts` NUL byte; extraction-only dedup of the
   duplicated first-time-rider fallback code.
2. **First-time-rider precedence fix** (Tier 2b PR): the #573 resolver shape in one
   shared domain module, both lanes, decision-table eval. Biggest harm, total override,
   active product surface.
3. **Post-sale pickup precedence fix** (Tier 2b PR): fold 3 copies, any-none veto,
   honest fallback labeling, precedence eval.
4. **Test-ride transport rewrite** (Tier 2b, evidence-first): shadow-log fire rate, then
   migrate to few-shots + the centralized reducer.
5. **Finance resolvers middle rule** (2a with charter citation, else 2b).
6. **Watch-list verification pass** (can ride along with the cluster PRs).

*Full agent output (per-finding verifier reasoning, sweep notes): workflow run
`wf_bdb2efec-11a`, session task `wq0laorkh` — summarized faithfully here; the four
cluster mechanisms were additionally spot-checked by hand against the working tree
before this document was written.*
