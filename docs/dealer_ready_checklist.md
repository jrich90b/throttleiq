# Dealer-Ready Checklist (June 30 showcase target)

Status of every day-1 capability at American Harley, with last verified
production evidence. Maintained by the agent-quality workstream; update the
evidence date whenever a capability is re-verified.

| Capability | Status | Last production evidence | Notes |
| --- | --- | --- | --- |
| ADF lead ingestion (Room58, Trade Accelerator, Meta, HD.com, TLP) | WORKING | 2026-06-11 (Meta lead 05:01Z, auto-replied in 7s) | |
| AI SMS drafts + auto-replies | WORKING | 2026-06-11 | Voice charter + template rewrite live 6/11 |
| Email outbound + cadence | WORKING | 2026-06-11 11:20Z | |
| Calendar slot offers | WORKING | 2026-06-10 19:43Z (+15856273860) | |
| Appointment booking/confirmation | WORKING | 2026-06-10 21:39Z confirmed (+17169085647) | |
| Voice call capture (transcripts) | WORKING | 2026-06-10 22:04Z | |
| Voice call summaries | WORKING | 2026-06-13 (report-join bug fixed: withVoiceSummary 0→423 on live data; voice_feedback_join:eval now gates ci:eval) | |
| Traffic Log Pro walk-in ingest | WORKING | 2026-06-09 22:05Z (Perez walk-in). Ingest was never the gap — the REPLY built from it was: the follow-up subject came from a prose span of the staff note, so "the 2021 Road Glide Special we have on the floor with the 131ci engine" became "I'll follow up about the floor with the 131ci engine" (+17165241170, Joe 2026-08-04). Fixed + LIVE 2026-08-04 20:41Z (#531 `d58547e4`): the subject is the parsed model slot, prose discarded; pinned by `walkin_internal_note_topic_guard:eval` | |
| Inventory watches | WORKING | 53 conversations carry watch state; watch LABEL matched whole-word since #406 (2026-08-01) — the bare substring test resolved slang alias `king` inside "loo-king" and confirmed phantom Road King watches on 17% of inbound turns (+17169490089, +16412012540); pinned by `family_watch_clarify:eval` | |
| Deposit / payment requests (Stripe) | WORKING | 2026-06-04 (dealer_payment_requests.json + customer flow) | Re-verify before June 30 |
| DocuSign | UNVERIFIED | last customer mention 2026-04-01; tokens file 2026-05-19 | Probe token validity + a sandbox envelope (open) |
| Postgres dual-write | WORKING | parity clean expected from 6/12 (shadow-leak fix) | Read-flip June 17 |
| Worker dispatcher | WORKING | 2026-07-30 09:17Z tick flip (`WORKER_DRIVEN_TICKS=1`); boot log "in-process background ticks disabled", worker ticking every 60s, 791 conversations post-restart, zero worker errors since 7/07 | Shadowed 6/10-7/30. Rollback: drop the line from api.env + redeploy |

## The machine-readable verdict

This table feeds the **operability** section of the dealer-#2 readiness bar — one of the
five tests Joe confirmed on 2026-07-30 (`docs/policy_charter.md` "North star": funnel,
portability, operability, stranger test, pitch numbers). Alongside this table, operability
also grades the release gate's clean-day streak and zero open P0/P1 in the agent-manager
report. `npm run rollout_readiness:report` joins all five sections and writes one verdict to
`reports/rollout_readiness/latest.json` (+ `latest.md`); the loop digest prints it as a
single line so "how close is dealer #2?" is a number, not a research project. The grader is
pinned fail-CLOSED by `rollout_readiness:eval` — a missing input or an unparseable table
reads NOT_MET, never MET, and a section nobody has measured yet blocks the bar exactly like
a failing one. **Keep the Status column a bare word** (`WORKING` / `SHADOW` / `UNVERIFIED`):
the scorecard grades this table by parsing it.

## Open verification items
1. DocuSign: validate token refresh and send a test envelope before declaring day-1 ready.
2. Stripe deposit flow: one end-to-end re-verification closer to June 30.

## Resolved
- Trade description read as "I'll sell it myself" (2026-08-04, PR #498): a customer deep in a live deal on a 2026 Street Glide — trade valued at $17,125, $650/mo quoted hours later — sent a photo of his own 2019 Street Glide Special and wrote "That's my bike. It's absolutely flawless plus like I said I have the tour pack for it. That's the same color." `parseCustomerDispositionWithLLM` returned `sell_on_own` @0.85 and `applyCustomerDispositionCloseout` ran 7ms later, marking his open arrival-notify task done mid-negotiation; the operator filed "Closed the lead when it was still being worked" 51 minutes later. `conv.status` stayed `"open"`, which is why a status check alone reads this as a phantom. Root cause was comprehension, not a gate: `shouldSuppressDispositionCloseout` and `canApplyDispositionCloseout` both correctly trusted the parse. Fixed parser-first — a disposition rule (describing the bike you are TRADING, its condition/colour/extras, or sending a photo and saying "that's my bike", is presenting a trade, not announcing a private sale; `sell_on_own` requires an explicit "without us" statement) plus EXAMPLE AA pinning the production turn. Every call site funnels through the one shared parser, so both reply paths get it. Pinned in `customer_disposition:eval`: the production turn with its real history, a paraphrase with no verbatim overlap, and a regression guard (selling privately to a neighbour still closes out) so the carve-out cannot bleed into "a customer talking about their own bike never closes". Reproduced 3/3 on current main (`sell_on_own` @0.78–0.88) before building, and verified 3/3 `none` @0.93–0.96 after. Fail direction is safe: the change fails toward NOT closing a live lead. Auto-merged on a clean cross-model review, deployed 2026-08-04 (health OK, 802 conversations post-restart).
- Dept-widget acquisition ask answered, not clarified (2026-07-28, PR #324): a web-text-widget lead tagged to a NON-SALES department who is plainly offering to sell us a bike got the apparel-vs-bike clarify instead of an answer — Lynn Kraus (+17164785613) came through the "Motor Clothes" widget with "Do you guys buy motorcycles? I have a '17 Road King Special with just under 11k miles I'm looking to sell" and was asked to pick a department; worse, the widget-arrival lane never runs the sales orchestration, so no appraisal task and no `trade_cash` state were recorded either — a live used-inventory acquisition lead left no trace, and staff answered it by hand. Root cause: the clarify (Joe ruling 2026-07-26 #4, PR #309) was a TWO-state decision (clarify / plain dept ack) in a THREE-state world; its only input was "is this about a motorcycle?", and the disposition parser's `sell_to_dealer_interest` slot (PR #286) that reads this exact turn at 0.98 was never consulted on this path. Fixed parser-first + centralized: new pure `decideDeptWidgetIntakeTurn` (acquisition > clarify > plain ack, structured slots only) delegating to the existing `decideSellToDealerTurn` for one definition of "acquisition lead"; the shared `resolveDeptWidgetIntakeDecision` helper covers all three sites (widget arrival + live twilio + regen) so two-path parity is free; the widget lane now applies `applySellToDealerAppraisalFromDispositionParse` itself; and all three sites normalize through `extractWebTextWidgetCustomerMessage` (they had been parsing different text — raw message vs. full envelope — a latent parity bug). Acquisition arm is a strict SUBSET of the clarify cohort, so a pure gear ask can never reach it. Production turn pinned in `dept_widget_bike_clarify:eval` (7-row precedence table + LLM coverage on Lynn's exact text + the James Brown regression guard). Found by the autonomous loop's `corpus_replay_regression` feed and reproduced live on current main before building; approve-first PR, merged on Joe's approval, deployed 2026-07-28 (health OK, 785 conversations post-restart).
- ADF department parser: branded collectibles routed to parts (2026-07-02, PR #148): a Room58 web lead asking to buy a poker chip over the phone and have it shipped (Stephanie Blalock +12282200201) was classified `parts` by `parseAdfDepartmentInterestWithLLM` — the draft promised "our parts department"; staff corrected the sent reply to "apparel department". The `apparel` definition covered only wearables, so gift-shop collectibles fell into `parts` ("small item to order"). Fixed parser-first: the apparel definition now annexes branded HD collectibles / gift-shop general merchandise, plus a hard rule (non-wearable branded merch = apparel, NOT parts — parts is strictly components that go ON a bike) and two additive few-shots. Production turn pinned in `adf_department_interest:eval` (8/8 department cases). Found by the autonomous loop's `human_correction_material` feed; approve-first PR, merged on Joe's approval, deployed 2026-07-02 (health OK, 646 conversations post-restart).
- Recommender named-model bow-out (2026-06-28, PR #111): a budget-profile lead who narrowed to a named model class ("road king or street glider") was bowed out of the inventory recommender and looped "Which bike are you looking at so I can run it correctly?" (Tyrone Woods +13179357913; ADF lead vehicle stays "Full Line" so finance can't resolve a unit). Now `resolveVehicleRecommendationReply`'s named-model bow-out is budget-aware via the pure centralized `shouldBowOutRecommenderForNamedModel` — a named model defers to finance UNLESS a budget profile is present and no unit is in play (then the recommender surfaces matching in-stock units). Guarded by `vehicle_recommendation:eval` (decision table + source-wiring guard). Found by the autonomous loop's `human_correction_material` feed; staff had hand-replaced the draft with an in-stock unit.
- Voice summary report join (2026-06-13): `voice_feedback_mine` searched forward-only for each transcript's summary, but the runtime writes the summary before the transcript, so withVoiceSummary read 0 despite 423 summaries. Now keyed on the shared call SID (id-keyed bidirectional); recovers 0→423 on live data. Guarded by `voice_feedback_join:eval` in ci:eval (voice-feedback previously had no eval).

## Sizing note for dealer #2
A 2GB Lightsail instance runs the full stack but can never build it — deploys
are artifact-based (`DEPLOY_BUILD_MODE=local`, the default). See AGENTS.md
"Deploys Build Locally Now".
