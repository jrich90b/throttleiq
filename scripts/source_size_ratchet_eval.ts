/**
 * Source-size ratchet (Joe, 2026-08-01).
 *
 * `services/api/src/index.ts` is 71,520 lines and has grown ~2,000 lines/week
 * (46,167 on 5/15 → 64,952 on 7/1 → 71,520 on 8/1). Nothing has ever removed from it.
 *
 * That size is not itself a customer-facing defect, but it is what makes each new defect slower
 * to FIND — the 2026-08-01 finance-declined bug (PR #398) took a timestamp-by-timestamp trace to
 * spot, because several places in that one file write `followUpCadence` and nothing referees them.
 * The dealer-#2 north star ([[north-star-readiness-bar]]) makes engineering velocity a real
 * constraint, so the growth needs a floor under it before it compounds further.
 *
 * This is deliberately a CEILING, not a cleanup. It does not shrink anything and it does not
 * block any feature — it blocks a feature from being bolted onto the pile when a domain module
 * would do. Same mechanism as `twilio_comprehension_debt:eval`, which drove the regex debt to its
 * KEEP-floor: make the number visible, fail the build if it grows, and let it ratchet DOWN only.
 *
 * TO LOWER A CEILING: move code out into `services/api/src/domain/<name>.ts` (198 modules live
 * there today — that is the pattern that is already working), then lower the number here and say
 * what moved.
 *
 * TO RAISE ONE: don't. If a change genuinely cannot fit, that is the signal the code belongs in
 * its own module. Raising the ceiling to land a change defeats the entire guard.
 *
 * FAIL DIRECTION: a file that cannot be read fails CLOSED (the eval errors) rather than passing
 * silently — a ratchet that quietly stops measuring is worse than no ratchet.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

type Ceiling = {
  file: string;
  /** Max lines. RATCHET DOWN ONLY. */
  max: number;
  /** Why this file is watched. */
  note: string;
};

// Ceilings are set at the CURRENT size — this guard is about stopping growth, not forcing a
// cleanup sprint. Headroom is deliberately zero: the next change either fits or moves out.
//
// Re-baselined 2026-08-01 when the day's eight PRs landed together (71,526 -> 71,671 and
// 16,773 -> 16,827). Those were all written BEFORE this ratchet existed, so they could not have
// been asked to respect it; re-baselining to the merged reality is the honest one-time move.
// This is the ONLY legitimate reason to raise a ceiling, and it should never happen twice —
// from here the numbers go DOWN as the un-stack loop pulls code into domain modules.
const CEILINGS: Ceiling[] = [
  {
    file: "services/api/src/index.ts",
    // 70_242 -> 70_242 held while the watch-fire matcher stopped re-implementing modelMatches
    // (Mike Wolf +17164323990): the engine's private directional test became a call to the shared
    // matcher, and normalizeModelName moved out to domain/inventoryFeed.ts to pay for the comment.
    // 71_671 -> 71_667. First ratchet DOWN: the followUpCadence quiet-window un-stacking replaced
    // four copies of the "hush the cadence after we just reached out" block with calls to
    // applyCadenceQuietWindow (conversationStore) / decideCadenceQuietWindow (routeStateReducer).
    // 71_667 -> 71_617. The appointment-teardown un-stacking: five hand-maintained copies of the
    // "un-book this appointment" field list replaced by applyAppointmentTeardown
    // (conversationStore) / decideAppointmentTeardown (routeStateReducer).
    // 71_604 -> 71_576. The manual-outbound cadence-restart un-stacking: two of the three
    // hand-built "does this lead keep its place in the follow-up sequence?" blocks replaced by
    // applyManualCadenceRestart (conversationStore) / decideManualCadenceRestart (routeStateReducer).
    // The cadence-quality judge's input assembly also moved out: the inline "days since the customer
    // last replied" walk is now daysSinceLastCustomerReply (cadenceQualityFacts.ts), alongside the
    // unit facts the judge is graded against.
    // 71_575 -> 71_467. The cadence repeat-similarity math (stop-word list, tokenizer, sentence
    // extraction, overlap score, near-duplicate test) moved to cadenceRepeatSimilarity.ts so the
    // eval could import the code that actually runs instead of a hand-copy that had already
    // drifted from it (ASCII-only apostrophe stripping: 0.8095 in the copy vs 0.7727 shipped).
    // 71_467 -> 71_461. The scheduling-conflict fix paid for its own wiring and then some:
    // buildFriendlyReachOutClose / buildCustomerDispositionReply / ensureUniqueDispositionReply
    // moved to domain/dispositionReply.ts, and the six inbound-reply-action acceptance helpers
    // moved to domain/inboundReplyActionPrompt.ts next to the parser prompt they gate.
    // NOTE: this PR was authored against a 71_576 ceiling and originally proposed 71_570, which
    // would have RAISED the ceiling by 103 lines and silently undone two reductions merged since.
    // Rebased to the real post-merge count instead (the #418 trap, ROUTINE_CONTRACT rule 3).
    // 71_461 -> 71_460. The appointment-confirm companion fields (status/confirmedBy/acknowledged/
    // reschedule latch) moved behind applyAppointmentConfirmRecord (conversationStore), which asks
    // decideAppointmentConfirmRecord — the two booked lanes here now write one call, not four fields.
    // 71_460 -> 71_456. The wrongful-silence judge's trace shaping (which stage, whether to record)
    // moved to domain/noResponseTrace.ts — so widening the judge's coverage to two more silence
    // terminals still came in NET SMALLER than before it.
    // 71_456 -> 71_455. The cadence-REVIVAL un-stacking: the three inline "is this chase dead
    // enough to throw away?" blocks (health-recovery delay, customer deferral, finance no-contact)
    // replaced by applyCadenceRevival (conversationStore) / decideCadenceRevival
    // (routeStateReducer). Small on paper because the fourth copy lived in sendgridInbound.ts,
    // which this ceiling does not cover — that file lost 5 lines of its own.
    // 71_455 -> 71_448. The SOLD-closeout un-stacking: the two hand-maintained copies of "the lead
    // bought — close the thread and settle the unit hold" (the appointment-outcome path and the
    // console's sold button) replaced by applySoldCloseout (conversationStore) / decideSoldCloseout
    // (routeStateReducer), including the five-line hold-match condition each carried inline.
    // Landed at 71_447 after rebasing onto #440/#442.
    // 71_447 -> 71_439. The burned-cadence-ladder heal did not fit, which is this guard working as
    // designed: both reconcile-tick cadence realign loops (mis-deferred long_term + the new burned
    // ladder) moved to domain/cadenceRealignSweep.ts as one shared walk, so the caller records
    // outcomes instead of hand-rolling the same loop twice. Net -7 WITH the new heal included.
    // REBASE NOTE (ROUTINE_CONTRACT rule 3, the #418 trap): this branch was authored against a
    // 71_443 main and proposed 71_436. #449 (-1) and #450 (+4) merged first, so the honest
    // integrated count is 71_439 — taking 71_436 would have failed the build on merge, and
    // "fixing" that by raising the ceiling later is exactly what this guard exists to stop.
    // 71_439 -> 71_432. The booking-ENDPOINT un-stacking: the three HTTP endpoints that create a
    // calendar event (/scheduler/book, /public/booking/book, /conversations/:id/appointment) each
    // ran their own copy of the same eleven-line "write the confirmed record" field list. All three
    // now call applyAppointmentBookingRecord (conversationStore), which asks
    // decideAppointmentBookingRecord (routeStateReducer). Taken against main's REAL count (71_437),
    // not the ceiling's 2 lines of headroom — a ceiling is a cap, never a budget to spend.
    // 71_432 -> 71_427. The reschedule-latch ARM un-stacking: three inline blocks that each armed
    // `appointment.reschedulePending` on their own preconditions collapse into three one-line calls
    // to applyReschedulePendingLatch (conversationStore), which asks decideReschedulePendingLatch
    // (routeStateReducer). Taken against main's REAL count (71_432), which the ceiling was sitting
    // exactly on — so this slice funded itself.
    // 71_427 -> 71_414. The inventory-availability REOPEN un-stacking: two drifted arms in
    // clearLinkedInventoryAvailabilityConversations plus the stale-hold sweep in
    // processInventoryHolds collapse into three one-line calls to applyInventoryAvailabilityReopen
    // (conversationStore), which asks decideInventoryAvailabilityReopen (routeStateReducer).
    // NOTE: the first draft of this slice put the decide call INLINE in index.ts and the file GREW
    // by 24 lines. The ceiling caught it, which is exactly its job — the fix was to move the writes
    // behind the store wrapper like every previous un-stacking, not to raise the number.
    // 71_414 -> 71_404. The cadence-REPLACEMENT un-stacking: the three inline "mint a whole new
    // followUpCadence over whatever is running" object literals (finance declined, the
    // licence/credit-pending staff note, the manual-outbound seller-photo request) collapse into
    // calls to applyCadenceReplacement (conversationStore), which asks decideCadenceReplacement
    // (routeStateReducer). The fourth site was already in the store.
    // 71_404 -> 71_390. The appointment-ATTRIBUTION un-stacking: `setAppointmentBookedBy`'s
    // six-field normalization and `onAppointmentBooked`'s confirmedBy inference both collapse into
    // calls to applyAppointmentAttribution (conversationStore), which asks
    // decideAppointmentAttribution (routeStateReducer).
    // 71_390 -> 71_386. The LEAD-closeout un-stacking: the two hand-maintained copies of the
    // appointment-outcome "sold" close (the conversation header and the to-do endpoint) each wrote
    // status/closedAt/closedReason inline; both now call applyLeadCloseout (conversationStore),
    // which asks decideLeadCloseout (routeStateReducer). Net -4 after the import line.
    // 71_386 -> 71_373. The arrival-notify task work went the same way rather than landing here:
    // the purpose decision, the comprehended-arrival capture and BOTH state-reconcile heals (dedup
    // + re-date) collapse into applyIncomingInventoryPurposeDecision /
    // applyComprehendedArrivalToPending (pendingIncomingInventory) and
    // healPendingIncomingNotifyTodosAcross (conversationStore). Net -11 INCLUDING the new feature,
    // which is the point: this guard is what turned a +44 patch into a reduction.
    // 71_373 -> 71_360. The inventory-HOLD-record un-stacking: the two hand-maintained copies of
    // "put this bike on hold for this lead" (the appointment-outcome held lane and the console's
    // manual-resolution endpoint) each wrote the same fourteen fields plus the cadence/mode
    // aftermath inline; both now call applyInventoryHoldRecord (conversationStore), which asks
    // decideInventoryHoldRecord (routeStateReducer). Net -13 after the import line.
    // 71_360 -> 71_345. The inventory-watch ARM un-stacking: TEN places each hand-wrote the same
    // "a watch is now set on this lead" block (the plural list + the singular mirror + clearing the
    // pending ask + the dialog state + holding_inventory + stop the chase). Seven of the ten were in
    // this file; they now call applyInventoryWatchArm (conversationStore), which asks
    // decideInventoryWatchArm (routeStateReducer). Net -15 after the import line.
    // 71_345 -> 71_344. The appointment confirm-record slice, second pass: the manual-outbound
    // path stopped asking the referee on the CUSTOMER lane and then overwriting both answers, and
    // the manual booking-parser path's hand-written status/confirmedBy/acknowledged trio became one
    // applyAppointmentConfirmRecord call. A small net line win — the value is that four staff
    // stamps of "this appointment is confirmed" now come from one table.
    // 71_344 -> 71_340. The cadence-quality shadow record's 10-line object literal became a call to
    // buildCadenceQualityShadowRecord (draftQualityGate), which also records what the gate DID with
    // the verdict — so a held touch is no longer indistinguishable from one that went out.
    // REBASE NOTE (ROUTINE_CONTRACT rule 3, the #418 trap): authored against a 71_345 main and
    // proposed 71_341; #505 landed -1 first, so the honest integrated count is 71_340. Taking the
    // pre-rebase number would have silently handed back #505's reduction.
    // 71_340 -> 71_333. The task-inbox money-badge hint moved out: the inline CTA ternary became
    // resolveSalesTopicHint (domain/salesTopicHint.ts), which also expires a pricing hint once we
    // have actually quoted the lead (+17165236994, operator "Pricing was answered but the pricing
    // flag still shows in the inbox").
    // 71_333 -> 71_331. The OPEN-CUSTOMER-TURN fix funded its own wiring: `getLastInboundBody` /
    // `getLastInboundMessage` moved out to domain/openCustomerTurn.ts, next to the open-turn
    // builder they contrast with (the single newest message vs every message still unanswered).
    // Three lines of new wiring at the live/regen/re-draft draft paths, nine lines out — taken at
    // the REAL count, not the ceiling, so the slice funds itself with two to spare.
    // 71_331 -> 71_330. The inventory-watch DISARM un-stacking: four hand-written copies of the
    // "what survives when a watch comes off" block became calls to applyInventoryWatchDisarm.
    // Only -1: the first three lanes gave back 4 lines and the FOURTH (vin_normalize, which the
    // queue could not see until the third was refereed) cost 2 back plus the import. Worth it —
    // an un-refereed fourth copy is what the next hand-rolled fifth one would have been modelled on.
    // REBASE NOTE (ROUTINE_CONTRACT rule 3, the #418 trap): authored against a 71_333 main and
    // proposed 71_332; #511 landed -2 first, so this is re-derived on the INTEGRATED tree.
    // 71_330 -> 71_315. The finance-outcome-NOTIFY un-stacking: the seven places that hand-wrote
    // the business-manager notification record became calls to applyFinanceOutcomeNotifyState.
    // -4 from the wiring itself, and -11 more because main had already fallen below the ceiling —
    // taken at the REAL count on the integrated tree, never at either branch's.
    // 71_315 -> 71_298. The appointment-PROMPT un-stacking: SIX byte-identical copies of the
    // "mark the 24h confirmation ask as sent" block inside processAppointmentConfirmations (one per
    // delivery branch) collapsed to one local `markConfirmationAsked()` over the applier, and the
    // customer's YES/NO record went the same way. Re-derived on the INTEGRATED tree after #524.
    // 71_298 -> 71_271. The watch-RECORD-SHAPE un-stacking: TEN copies of the "how specific is
    // this watch?" ladder and TWO copies of the legacy-singular-vs-list block became calls to
    // applyInventoryWatchExactness / applyInventoryWatchListNormalization.
    // 71_271 -> 71_268. The pending-WATCH-CLEAR un-stacking: both inbound lanes that dropped
    // `inventoryWatchPending` now call applyInventoryWatchPendingClear*, and the per-lane input
    // mapping (parser vocabulary vs intent hints) went out to conversationStore with them, so each
    // call site is two lines. The ceiling caught the first attempt at +16 — the mapping was still
    // sitting in index.ts — which is exactly its job.
    // 71_271 -> 71_257. The "Sounds great!" acceptance arm FUNDED ITSELF and then some: the arm,
    // its two call sites and the lane adapter are new, but the day-scoped slot search and the
    // window-clause / slot-reply helpers moved out to domain/scheduleSlotSearch.ts, next to the
    // next-available search they are siblings of. The ceiling caught the first cut at +83 — all of
    // it still sitting in index.ts — which is exactly its job.
    // 71_271 -> 71_241. The OFF-HOURS time guard funded itself: two reply sites gained an hours
    // check, and `formatBusinessHoursForReply` moved out to domain/businessHoursGuard.ts to sit
    // with the invariant it formats. index.ts was sitting EXACTLY on the ceiling, so the slice had
    // to pay for itself in full.
    // 71_224 -> 71_201. The voicemail follow-up TASK un-stacking: the three arms inside the
    // recording handler's `if (isVoicemail)` block each hand-wrote its own "is there already an
    // open task" scan and its own addTodo call; they now call applyVoicemailFollowUpTask
    // (conversationStore), which asks decideVoicemailFollowUpTask (routeStateReducer). Net -23
    // after the import line, and the referee is where the operator-reported inventory-watch park
    // (+15416478489) now lives instead of a fourth inline condition.
    // REBASE NOTE (ROUTINE_CONTRACT rule 3, the #418 trap): authored against a 71_345 main and
    // proposed 71_322, then 71_310 against a 71_333 main; main has since ratcheted to 71_224, so
    // both earlier numbers would have handed back every reduction between. Re-derived on the
    // INTEGRATED tree — the slice is still worth exactly -23.
    // 71_201 -> 71_199. The post-sale warmth prefix paid for its own import: the inline
    // positivity regex + ternary became hasCustomerPositiveExperience (domain/leadInGuards.ts),
    // next to the two fabricated-frame guards it belongs with.
    // 71_199 -> 71_197. The arrival BACKFILL sweep (dormant pre-#337 records could never learn an
    // arrival, so #486's re-date heal had nothing to act on) went into
    // domain/pendingIncomingArrivalBackfill.ts, and its sweepPendingIncomingNotifyTodos swallowed
    // the heal block index.ts was already carrying. Net -2 WITH the new sweep included.
    // REBASE NOTE (ROUTINE_CONTRACT rule 3, the #418 trap): authored against 71_373 and proposed
    // 71_371, then 71_331, then 71_222, then 71_199 — #503 (-23) and #512 (-2) each landed under it
    // in turn. Every earlier number would have RAISED the ceiling and silently handed back someone
    // else's reduction. Re-derived on the INTEGRATED tree each time; the slice is worth exactly -2.
    // 71_197 -> 71_182. The CONVERSATION-TURN booking un-stacking: seven hand-maintained copies of
    // the same eleven-field "a real calendar event now holds this lead's time" block, in four
    // shapes, replaced by four lanes on the existing applier. The applier pattern paid for its own
    // wiring again — the four new referee knobs live in routeStateReducer, not here.
    // REBASE NOTE: re-derived on the INTEGRATED tree for the THIRD time (#512 then #492 each landed
    // -2 under this branch). The slice is worth -15 every time; the ceiling is not.
    // 71_182 -> 71_147. The committed-return-day cadence line (+17167255404). index.ts was sitting
    // EXACTLY on the ceiling again, so the slice funded itself: `buildWalkInCommentFollowUp` — a
    // 66-line regex ladder over a salesperson's prose, unreachable by any eval down here — moved
    // verbatim to domain/walkInCommentFollowUp.ts. Net -35 after two import lines and the wiring at
    // both the live tick and the regenerate path.
    // REBASE NOTE (ROUTINE_CONTRACT rule 3, the #418 trap): authored against a 71_201 main and
    // proposed 71_166; #541/#543/#544 then ratcheted main to 71_182 underneath it. 71_166 would
    // still have PASSED — the integrated tree is 71_147 — while quietly handing back 19 lines of
    // headroom someone else's un-stacking had just won. A ceiling is a cap, never a budget.
    // 71_147 -> 71_142. The last four customer-risk referees. The slice FUNDED ITSELF: four call
    // sites gained a referee call each, and the write half of the inventory-watch ladder moved out
    // to applyInventoryWatchDefaults (conversationStore), next to the confirmation apply it feeds.
    // The ceiling caught the first cut at +33 — the resolve-and-assign was still expanded inline at
    // all four sites — which is exactly its job. Re-derived on the INTEGRATED tree (main 911aed1b +
    // the return-day gate fix + the rung-burn un-stacking), per ROUTINE_CONTRACT rule 3.
    // 71_147 -> 71_047. The parsed-day authority for the visit-commitment reply (+17167130279).
    // index.ts was sitting EXACTLY on the ceiling for the third time running, so the slice funded
    // itself: the schedule-status reply builder + its day-label extractor moved verbatim to
    // domain/scheduleStatusReply.ts. Net -100 after the one-line import. The extraction is the point, not
    // the payment — two evals were pinning that builder's SOURCE and hand-copying its logic (the
    // copy's weekday list had already drifted to 6 of 20 words), and both now call the real thing.
    // REBASE NOTE (ROUTINE_CONTRACT rule 3, the #418 trap): this branch proposed 71_047, derived
    // against an older main. Main has since ratcheted to 71_142 and the INTEGRATED tree measures
    // 71_042 — so 71_047 would have PASSED while handing back 5 lines someone else's un-stacking
    // had already won. Re-derived on the integrated tree; a ceiling is a cap, never a budget.
    // 71_042 -> 71_025. The Jumpstart 1-on-1 invite (Joe, 2026-08-05) funded itself the same way:
    // `policies.firstTimeRider` was being re-read by hand in FIVE places (three here, two in
    // sendgridInbound.ts), each with its own defaults, so a new capability flag would have had to be
    // added to all five. One `readFirstTimeRiderPolicy` in domain/firstTimeRiderPolicy.ts now serves
    // every caller, and the new invite still lands 12 lines UNDER the old ceiling — the three
    // beginner reply bodies moved to agentVoice too, so `jumpstart_invite:eval` can RUN them
    // instead of grepping for them (a sabotage that appended the invite passed the grep version).
    // 71_030 -> 71_027. The bare-acknowledgement gate (+13105956498, "Found a better offer.
    // Thanks"). index.ts was sitting EXACTLY on the ceiling again, so the slice funded itself
    // twice over: isShortAckText + isEmojiOnlyText moved to domain/bareAcknowledgement.ts, next
    // to the narrower predicate that replaces one of their uses, and isReachOutWhenReadyCloseText
    // moved to domain/dispositionReply.ts beside the goodbye builders whose output it matches.
    // Net -3 with the new human-mode closeout draft included.
    // 71_027 -> 71_026. Persisting the rider-experience read (Joe asked for a list of customers who
    // are not licensed yet). index.ts was sitting EXACTLY on the ceiling AGAIN, so the new state
    // applier went straight into domain/firstTimeRiderPolicy.ts beside the enrollment-record readers
    // it uses, rather than inline. index.ts pays one line for the call and nothing for the import —
    // it already imported from that module — so the slice lands a line UNDER what it started at.
    // 71_026 -> 71_008. The lost-sale closeout acknowledgement (Joe, 2026-08-07) collapsed
    // THREE hand-maintained copies of the closeout reply block into applyDispositionCloseoutAndBuildReply
    // and moved the deterministic fallback scan to domain/customerDispositionFallback.ts; the
    // short-ack sign-off gate (+16076549423) then moved wholesale to shouldEndTurnAsShortAckSignOff
    // in workflowRegressionGuards, so each of its two call sites is one line. Three slices landed in
    // the same window, so this is the REAL post-merge count with all of them applied — re-derived
    // against current main, never carried from any branch (the #418 trap).
    // 71_008 -> 71_007. Ruling 24: the three legacy watch-defaults lanes now pass their own lane's
    // parsed condition instead of `undefined`, which is a same-line edit, and the comment claiming
    // one lane was ALONE in asking the parser stopped being true and went.
    // 71_007 -> 70_896. The enrolled-student class-logistics hand-off arrived +49 OVER, so the slice
    // funded itself and then some: the whole first-time-rider REPLY surface left the handler for
    // domain/firstTimeRiderReply.ts — both builders (buildFirstTimeRiderGuidanceReply,
    // buildInitialAdfFirstTimeRiderGuidanceReply) and the two text guards they read, moved verbatim
    // with nothing but an `export` added, plus the shared asksRiderCourseLogistics predicate and one
    // task constant so neither reply path holds a local of its own (route_parity_guard counts those).
    // Reply COMPOSITION belongs next to the policy it reads, not in the inbound handler.
    // RE-DERIVED 2026-08-08 on rebase (the #418 trap): this branch was proven against a 71_007 main
    // eight commits earlier and proposed 70_889. Both numbers are re-measured against the REBASED
    // tree — the branch's own figures were never carried across.
    // 70_896 -> 70_893. The quiet-thread nudge's cost bound (2026-07-31 incident). The tick's
    // thread selection and its future-dated-todo check moved to domain/humanThreadNudge.ts beside
    // the decision they feed, and the pre-composition gate went with them — so the lane pays one
    // line per call instead of carrying the reasoning inline. The fix lands NET SMALLER.
    // 70_893 -> 70_888. The lead form's own preferred time (+16397209755, "8:00 Pm") now goes through
    // the business-hours invariant guard. index.ts was sitting EXACTLY on the ceiling again, so the
    // slice funded itself: isOpenPreferredTime and formatPreferredTimeForReply were hand-maintained
    // copies in BOTH index.ts and routes/sendgridInbound.ts and moved verbatim into
    // domain/businessHoursGuard.ts beside the invariant that now reads them.
    // 70_888 -> 70_824. The widget seller-vs-buyer slice (+17169839279). The hand-rolled
    // parser-vs-extractor merge inside resolveWebTextWidgetSalesVehicleContext — 24 lines of nested
    // ternaries deciding which reader wins — moved into domain/webTextWidget.ts as
    // mergeWebTextWidgetSalesContext, beside the extractor it arbitrates; the three pure parser-result
    // helpers (accepted / vehicle-to-context / result-to-context) went with it, so an eval can
    // EXECUTE the chain from a raw parse instead of pinning its source text. The slice funded its own
    // two new call-site lines and still lands NET SMALLER.
    // 70_824 -> 70_781. The requested-day slice (+17167857284). index.ts resolved "which day is this
    // turn about?" with one expression and "what do we CALL that day?" with a second, independent
    // one — so it looked up Monday and printed "today". Both now come from resolveRequestedDay in
    // domain/inboundPipeline.ts, which returns the day and its label together; index.ts loses its
    // private 34-line weekday map, and the weather branch that already had the precedence right
    // shares the same referee.
    // 70_781 -> 70_775. The manual-promise owner slice. The two apply branches that decided whether a
    // promise of a person's work pauses the cadence were hand-maintained copies; both now call the
    // pure referee resolveManualPromiseApplyPlan (domain/manualOutboundPromise.ts), so the eval can
    // EXECUTE the whole author difference instead of pinning how far apart two calls sit in the file.
    // 70_775 -> 70_753. The hours-veto slice (+17163975098). The pre-parser keyword branch used to
    // re-run the RAW keyword scan at a SECOND door, so the parser's new veto would have been inert
    // there; both doors now ask the one referee. index.ts was sitting EXACTLY on the ceiling again
    // (+5 for the shared-referee condition), so the slice funded itself: formatTime12h and
    // formatBusinessHoursProposalTime — pure string formatters with no callers outside index.ts —
    // moved verbatim into domain/inboundPipeline.ts beside resolveRequestedDay, the business-hours
    // helper the same module already owns. -22 net, so the slice lands well under what it started at.
    // 70_753 -> 70_751. The held-draft flag lands before closing (Maya +15854782032). All four
    // escalations this backstop ever raised were replayed: the two held in the early afternoon
    // surfaced at 7:52pm and 7:42pm, after a 6pm close, to an empty store. index.ts was sitting
    // EXACTLY on the ceiling again, so the slice funded itself twice over: the escalation SUMMARY
    // moved into domain/heldDraftBackstop.ts beside the marker and the rule that raise it (an eval
    // now asserts the text a rep reads instead of pinning the sweep's source), and dayKeyLocal moved
    // into domain/businessHoursGuard.ts beside the new closing-time helper that answers the same
    // kind of question.
    // 70_751 -> 70_741. Budget-gated-on-financing handoff (Franklin +17164208660; Joe 8/10:
    // "only finance can handle that info"). The slice funded itself: the short-list clarifier —
    // whose budget "hint" is the six-word list that caused the miss — moved verbatim into
    // domain/shortListClarifier.ts with the two model-context lookups injected, and the new
    // handoff's copy + confidence floor sit beside their parser in domain/budgetFinancingDeferral.ts.
    // 70_741 -> 70_620. The macOS runner installer moved to domain/mdfRunnerMacInstaller.ts, beside
    // the Windows sibling that already lived in its own module. Verbatim move, proved by diffing the
    // generated script body against the previous commit (which caught a stray newline that would have
    // pushed the #!/bin/zsh shebang off line 1).
    // 70_620 -> 70_608. The unanswered-watch-alert stop + its close-out (Joseph +17163308822;
    // Joe 8/10 asked for a sign-off that leaves the floor open). Re-derived against current main,
    // NOT carried over from the branch's stale 70_739 (the #418 trap): three watch-state helpers
    // that only ever read/wrote the collectInventoryWatches union — hasActiveInventoryWatch,
    // pauseInventoryWatches, markInventoryWatchOptOut — moved beside it in conversationStore.ts,
    // and the close-out copy lives in agentVoice.ts with the other watch templates, so index.ts
    // pays only for two call sites and still ratchets DOWN.
    // 70_608 -> 70_505. The enough-info hand-off (John Zimmerman +17169902571; Joe 8/10: "the agent
    // has to know when we have enough info and to handoff"). Funded by moving the pure future-timeframe
    // date readers — parseFutureTimeframe + parseRelativeDaysOrWeeks + computeMidWeekFollowUpDate +
    // parseRelativeDurationCount — into domain/futureTimeframe.ts. They were already pure and already
    // took their clock as a parameter, so nothing there reads a wall clock. The readiness RULE is pure
    // too and lives in domain/salesHandoffReadiness.ts; index.ts keeps only the parse call and the
    // side effects it alone owns.
    // 70_505 -> 70_502. The advance-goal + no-repeat slice paid for its 3 lines of wiring by collapsing
    // two multi-line expressions in the same object literal, and banked the difference.
    // 70_502 -> 70_499. The parked-thread nudge bail. index.ts was sitting EXACTLY on the ceiling
    // again, so the slice funded itself: the single-use openFutureTodo local was inlined into the
    // decide call it feeds, and the past-event suppression receipt collapsed onto one line. The
    // parked question itself is answered in conversationStore.ts beside hasActiveInventoryWatch —
    // index.ts pays one line for the call and one for the import name, and still ratchets DOWN.
    // 70_499 -> 70_497. The day-from-context booking slice (+17169902571). index.ts was sitting
    // EXACTLY on the ceiling again, so the slice funded itself twice over: the local
    // manualOutboundAppointmentRequestedPhrase builder moved to domain/manualOutboundAppointment.ts
    // beside the prompt it shapes, and the booking parser's hand-inlined COPY of that same
    // composition (a 7-line day+timeText join) now calls the one helper. index.ts pays one line for
    // the import and keeps only the past-slot invariant guard, which is genuinely its job.
    // 70_497 -> 70_494. The task-inbox de-pile slice (Joe 2026-08-12): the stale-handoff nudge's
    // summary + idle-days computation moved into buildStaleHandoffNudge (conversationStore, beside
    // its recogniser and the new retire decision), which funded the retire sweep index.ts gained
    // inside the same reconcile block the scheduling-leak retire already lived in.
    // 70_494 -> 70_486. The hours open-hours-claim guard (+17169902571). index.ts was sitting
    // EXACTLY on the ceiling again, so the slice funded itself twice: BOTH halves of the hours
    // answer — the base reply and its appointment-context tail — moved into
    // domain/businessHoursGuard.ts beside the invariant the tail now consults, and the sales-lead
    // predicate the schedule-invite gate reads moved next to that gate in domain/inboundPipeline.ts
    // (the handler passes the department in rather than the module deriving it). index.ts keeps
    // only the config fetches, which is genuinely its job.
    // 70_486 -> 70_384. The lead-identity join moved to domain/leadIdentity.ts: index.ts kept two
    // hand-rolled identity readers that treated a lead feed's "Email: n/a" as a real person, which
    // joined 11 unrelated walk-in customers into one identity and let one booking stop four other
    // leads' cadences. `firstNonBlank` went with them — it had no other caller left.
    //
    // RE-DERIVED 2026-08-13 at merge time against current main, not against this branch's base
    // (the #418 trap). Written on a base whose index.ts was larger, this line read 70_459 — but
    // main had already reached 70_411 through later merges, so shipping 70_459 would have handed
    // back 75 lines of headroom this ratchet had already won. 70_384 is the file's ACTUAL size
    // with this change applied, which is what "ceilings are set at the CURRENT size" means.
    // 70_384 -> 70_383. The soft-visit arm's two hand-mirrored precedence blocks (live + regen)
    // replaced by ONE call to resolveSoftVisitTurn (domain/visitCommitmentParser), which wraps the
    // pure referee resolveSoftVisitCommitment (domain/softVisitSignal). A net ratchet DOWN even
    // though the slice ADDED a parser and a referee, because both live in domain modules and the
    // call sites shrank.
    // 70_383 -> 70_379. The reminder/pause arm's direction-blind `wantsReminder` regex left
    // index.ts entirely: the gate is now followUpReminderPauseClaimsTurn (workflowRegressionGuards),
    // which asks the turn's centralized callback route decision before claiming the turn. The
    // local four-line regex helper had no other caller, so the slice funds its own import line.
    // 70_379 -> 70_378. The "keep an eye out" promise slice: the manual-outbound watch cue pair
    // moved to domain/inventoryNotifyPromise.ts, the notify apply lives in conversationStore
    // (applyInventoryNotifyPromiseOutcome), and the watch-condition helper family
    // (normalizeWatchCondition + two siblings) moved to conversationStore beside the watch
    // machinery that uses it — funding the new ~28-line apply call site with one line to spare.
    // 70_378 -> 70_371. The pre-send judge's INPUT assembly moved out to domain/draftJudgeInputs.ts
    // so the web-lead lane can hand the judge the lead record instead of an empty ask. Re-derived on
    // the INTEGRATED tree (ROUTINE_CONTRACT rule 3): authored against a pre-#709 main, and #709
    // landed -1 first, so this is taken against main's REAL 70_378, not the branch's own baseline.
    // 70_371 -> 70_365. `/conversations/:id`'s display shaping (the email draft and the
    // follow-up-hold flag) moved behind resolveConversationDetailDisplay (conversationStore),
    // which is where the email draft is written and where the LIST endpoint already computed the
    // same followUpHold expression. Taken against main's REAL 70_371.
    // 70_365 -> 70_351. The human-mode visit-commitment slice ADDED 25 lines to the handler and
    // still ratcheted down: resolveUpcomingDateFromDayLabel (39 lines of pure day-label date math,
    // both callers already visit-related) moved VERBATIM to domain/softVisitSignal.ts. A date
    // helper was never inbound-handler code. Taken against main's REAL 70_365.
    // 70_351 -> 70_339. `stripNonAdfThanks` moved to domain/agentVoice.ts as
    // `normalizeNonAdfReplySpacing`, MINUS the two dead "Thanks for …" strip rules it carried.
    // Those rules were double-escaped inside a regex literal (`\\s` matches a literal backslash),
    // so they had never fired once — 0 matches in 5,329 agent-authored outbound bodies, all-time.
    // Repairing the escaping is the landmine, not the fix: single-escaped they match 121 of those
    // bodies and empty or gut most of them. Deleted instead, and pinned by
    // non_adf_thanks_strip:eval, which executes the shipped function on verbatim store bodies.
    // 70_339 -> 70_338. The dealer-profile hours write-through. index.ts was sitting EXACTLY on the
    // ceiling again, so the slice funded itself: the four-line `hours:` replace-not-merge expression
    // collapsed to one `hours,` and moved into schedulerConfig.ts as `reconcileDealerProfileHours`,
    // which is where businessHours already lives. Net -1 with the write-through call included.
    // 70_338 -> 70_336. Charter C1.2a on the dealer-ride builders (Rick +17165241170). index.ts was
    // sitting EXACTLY on the ceiling again (+5 for two guarded call sites), so the slice funded
    // itself: the identity SENTENCE moved to buildDealerRideIdentitySentence in domain/agentVoice.ts
    // — beside shouldIntroduceOnAdfTouch, the rule it applies, and in a module index.ts already
    // imports from, so the import costs nothing — and each builder's three-line intro ternary
    // collapsed to one composed template. Net -2 with both new call sites included.
    // 70_336 -> 70_317. Dealer intake email loop (Phase 1 hands-off onboarding) arrived as
    // domain/dealerIntakeMail.ts with one-line wiring, and funded itself by un-stacking the two
    // hand-copied Gmail status endpoint blocks (support/personal) plus the new setup one into
    // buildGmailStatusHandler in domain/googleCalendar.ts. Net -19 with all three call sites,
    // both intake routes, and the poll-loop starter included.
    // 70_317 -> 70_310. The branded public intake form (/public/dealer-intake/:token) arrived as
    // two more dealerIntakeMail.ts handlers + one-line routes, funded by requireManagerAccess:
    // 5 of the 44(!) hand-copied "manager or canViewAllTasks" blocks in the dealer-setups family
    // collapsed into the shared middleware. 39 copies remain as future funding.
    // 70_310 -> 70_296. The vehicle-fact parser-vs-keyword tie-break (+14805441825) moved into
    // domain/vehicleFactQuestionRoute.ts. index.ts pays one line for the import and folds its
    // 8-line inline confident-none block into the fallback factory it already had, so the slice
    // funds itself — and the ADF door (routes/sendgridInbound.ts) drops its duplicate copy of the
    // same guard at the same time. Two doors, one referee.
    // 70_296 -> 70_276. The sold sale-record referee (+17166970787). The ceiling caught this
    // slice at +3 and paid for the better shape: the console-header outcome branch and the
    // todo-outcome branch each carried a byte-identical five-line construction of the
    // appointment-outcome sale record, so BOTH copies moved into `applyAppointmentOutcomeSoldSale`
    // in conversationStore.ts — next to the referee that now arbitrates it, in a module index.ts
    // already imports from. RE-DERIVED against the integrated tree (the #418 trap, hit for the
    // THIRD time on this branch): authored at 70_336 -> 70_316, re-derived to 70_297 after the
    // intake-email slice, and now measured again on top of the vehicle-fact slice. Taking any
    // earlier number would have handed a previous reduction back.
    // 70_276 -> 70_264. Phase 2 dealer DNS plan/apply arrived as domain/dealerDnsApply.ts with
    // two one-line routes, funded by converting 4 more of the hand-copied manager blocks in the
    // dealer-setups family to requireManagerAccess (35 copies remain as future funding).
    // 70_264 -> 70_253. The voice-facts cadence slice: three hand-copied "freshen the facts, then
    // append the line" blocks collapsed into appendVoiceFactsCadenceLine (voiceCadenceFacts), which
    // funded the two new promise-mint sites — and is the same duplication that let the promise
    // follow-through be wired to one author instead of every one.
    // 70_253 -> 70_251. The engagement-bump un-stacking: the inline `cadence.kind = "engaged"`
    // in the cadence tick — one of seven unrefereed writers of that field, and the one that fought
    // the finance-declined heal into a daily-forever loop — is now decideEngagedCadenceBump in
    // routeStateReducer, so the tick states the inputs and the referee owns the rule.
    // 70_251 -> 70_243. The re-engagement carry-over: the SMS path's hand-written "inherit the
    // owner, the lead profile and clear the closed state" block moved into
    // applyPriorJourneyCarryOver (domain/priorJourney.ts) and is now SHARED with the ADF path,
    // which had been carrying leadOwner alone.
    // 70_243 -> 70_242. The returning-customer fact reaches the draft context in one line, funded
    // by folding a three-line memorySummary guard whose every neighbour was already a one-liner.
    // 70_242 -> 70_132. The "Rescheduled" appointment outcome (Joe, 2026-08-18, +17165230421).
    // index.ts was sitting EXACTLY on the ceiling again, so the slice funded itself twice over: the
    // whole appointment-outcome VOCABULARY — the three types, APPOINTMENT_SECONDARY_OPTIONS, both
    // normalizers and both legacy mappings, 120 lines of pure functions with no IO — moved verbatim
    // to domain/appointmentOutcome.ts, where the new answer could be added with an eval able to
    // reach it. Net -110 after the import block and the two dropdown options.
    max: 70_132,
    note: "the inbound handler + most wiring; the file the de-tangle program exists to shrink"
  },
  {
    file: "services/api/src/domain/llmDraft.ts",
    // 16_827 -> 16_825. The cadence-quality judge's inline "Known lead" prompt block became
    // formatCadenceQualityUnitFacts (cadenceQualityFacts.ts), which also carries the purchase.
    // 16_825 -> 16_723. Two extractions land together here: the conversation-state prompt
    // (conversationStateParserPrompt.ts, #436) and the inbound-reply-action JSON schema + its 23
    // few-shots (domain/inboundReplyActionPrompt.ts), so each prompt surface is editable on its own.
    // 16_723 -> 16_654. Every Anthropic request builder in the repo collapsed into ONE caller
    // (domain/anthropicRequest.ts): the open critic's `requestStructuredJsonAnthropic` wrapper and
    // the draft A/B arm's inline fetch both left this file. That is where the claude-opus-5
    // `temperature` 400 was hiding twice over.
    // 16_654 -> 16_597. The draft-quality judge's schema + prompt moved to
    // domain/draftQualityJudgePrompt.ts so the model-comparison backtest can run the EXACT
    // production judgment against challenger models instead of a hand-copy (the PR #432 drift).
    // 16_597 -> 16_491. The walk-in outcome parser's JSON schema, its 17 few-shots and its whole
    // prompt builder moved to domain/walkInInventoryWant.ts, next to the watch-phrase helpers that
    // gate the same decision — so the inventory-want fields Larry Godzich (+17164327329) needed
    // could be added to the prompt surface without touching this file's budget at all.
    // NOTE (rebase, 2026-08-02): PR #438 was authored against a 16_723 ceiling and proposed 16_617.
    // Main had since ratcheted to 16_597, so landing 16_617 verbatim would have RAISED the ceiling
    // and undone two reductions — the #418 trap. Reconciled to the real post-merge count.
    // 16_491 -> 16_476. The walk-in `state` coercion was a 17-line inline ternary chain; it is now
    // coerceWalkInOutcomeState in walkInInventoryWant.ts, set-based like its want sibling. That
    // paid for the three return-visit fields (Ed Szulist +17167255404) with room to spare — this
    // file was sitting EXACTLY on its ceiling, so the slot work had to fund itself.
    // 16_476 -> 16_437. The customer-ack parser's 63 few-shot exemplars moved verbatim to
    // domain/customerAckActionExemplars.ts — a static string corpus with no interpolation and no
    // dependence on the turn, so it was never function-local in anything but position. Same shape
    // as inboundReplyActionPrompt.ts and walkInInventoryWant.ts above: the prompt surface that
    // grows every time we teach the parser a new case now grows on its own budget. That paid for
    // `accept_offer_of_information` (+16076549423) and leaves the ceiling lower than it was.
    // 16_437 -> 16_399. The vehicle-choice confidence parser's static instruction + few-shot block
    // moved the same way, to domain/vehicleChoiceConfidencePrompt.ts behind a builder (a bare
    // exported array breaks llm_parser_contract:eval). That paid for the bare-affirmative rules
    // (+16076549423). Both halves of that lead's fix ship together, so this is the REAL post-merge
    // count with both extractions applied — re-derived here, not carried from either branch.
    // 16_399 -> 16_381. The per-channel rule block and the advance-arm flag helpers moved to
    // domain/draftChannelRules.ts. That surface changes every time we learn something about voice,
    // so it now grows on its own budget — which is what paid for the salesperson arm (Joe, 8/7).
    // 16_381 -> 16_365. The first-time-rider guidance parser's few-shots moved to
    // domain/firstTimeRiderGuidanceExamples.ts, the same split as the five prompt surfaces above,
    // which funded the four enrolled-student exemplars (D6-D9, Maya Iversen +15854782032).
    // RE-DERIVED ON REBASE, and this is exactly why: the branch proposed 16_383 against a 16_399
    // ceiling, but main had since ratcheted to 16_381 — landing the branch's number verbatim would
    // have RAISED the ceiling and undone the draftChannelRules extraction. The #418 trap, live.
    // 16_365 -> 16_312. The other-ask slice (+17167857284). The hours parser's strict JSON schema and
    // its whole prompt moved into domain/businessHoursQuestion.ts — everything about that parse except
    // the API call — and its raw-JSON mapping went to domain/inboundPipeline.ts beside the referee
    // that reads it (which also let the pure decision-table eval EXECUTE the mapping without needing
    // an OPENAI_API_KEY to import llmDraft at all). The slice added a schema field and ~20 prompt
    // lines and still lands 53 under.
    // 16_312 -> 16_158. The routing-decision parser's schema + rules + few-shot corpus moved to
    // domain/routingDecisionParserPrompt.ts, so the prompt that decides how EVERY inbound turn is
    // routed is editable on its own (and the "answering our own question" rule landed there).
    // 16_158 -> 16_154. The hiring demotion gate (its vocabulary regex + the `explicitHiringRequest`
    // decision) moved to domain/conversationStateParserPrompt.ts beside the vendor guard it mirrors,
    // so a pure eval can EXECUTE the decision against recorded parser verdicts with no API key.
    // 16_154 -> 16_124. The staff-outbound appointment parser's state mapping, rules and few-shots
    // moved to domain/manualOutboundAppointment.ts, so the day-from-context rule and its production
    // few-shots are editable — and executable in a pure eval — without an API key.
    // 16_124 -> 16_099. The dept-widget bike-interest parser's strict schema and its whole prompt
    // (rules + worked examples) moved to domain/webWidgetDeptBikeClarify.ts, beside the decision
    // they gate — the walkInInventoryWant.ts shape. That is what paid for the owned-unit rule
    // (Michael McGary +17165502654, Joe 8/12): the prompt surface now grows on its own budget, and
    // a pure eval can EXECUTE the builder and assert the rule survives without an API key.
    // 16_099 -> 16_088. The rider-course "what does the class provide" slice. Adding a field to
    // a parser costs a schema property, a prompt rule and a docstring, so it funded itself by moving
    // FIRST_TIME_RIDER_GUIDANCE_PARSER_JSON_SCHEMA out to firstTimeRiderGuidanceExamples.ts — beside
    // the few-shots, which is the pair that always has to change together.
    // NOTE (rebase, 2026-08-12): this branch was authored against a 16_154 ceiling and proposed
    // 16_140. Main had since ratcheted to 16_099 (#678), so landing 16_140 verbatim would have
    // RAISED the ceiling and undone two reductions — the #418 trap. Re-derived from the real
    // post-rebase count.
    // 16_088 -> 16_086. The priorJourney draft fact: the reasoning lives in domain/priorJourney.ts,
    // so llmDraft carries only the field, the import and the prompt line.
    max: 16_086,
    note: "every parser prompt + JSON schema; second-largest and on the same trajectory"
  }
];

/**
 * Line count matching `wc -l` (newline-terminated lines), so the number here is the same number a
 * human gets from the shell. A naive `split("\n").length` counts the empty string after a trailing
 * newline and reads one HIGHER, which would silently shift every ceiling by one.
 */
function countLines(text: string): number {
  if (!text) return 0;
  const newlines = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

let failures = 0;

for (const ceiling of CEILINGS) {
  const full = path.resolve(ceiling.file);
  // Fail CLOSED: a missing/unreadable file must not silently pass the ratchet.
  assert.ok(fs.existsSync(full), `source-size ratchet: ${ceiling.file} not found (did it move? update the ratchet)`);
  const lines = countLines(fs.readFileSync(full, "utf8"));
  const delta = lines - ceiling.max;
  if (delta > 0) {
    failures += 1;
    console.error(
      `  FAIL ${ceiling.file}: ${lines} lines, ceiling ${ceiling.max} (+${delta}).\n` +
        `       ${ceiling.note}\n` +
        "       Move the new code into services/api/src/domain/<name>.ts and import it here.\n" +
        "       Do NOT raise the ceiling to land this change — that is the one thing this guard exists to stop."
    );
  } else {
    const slack = -delta;
    console.log(`  ok  ${ceiling.file}: ${lines} / ${ceiling.max} lines (${slack} under)`);
    // A file that has shrunk well below its ceiling should ratchet DOWN, or the guard goes slack
    // and stops constraining anything. Loud, not fatal — lowering the number is a human decision.
    if (slack >= 500) {
      console.log(
        `      NOTE: ${ceiling.file} is ${slack} lines under its ceiling — lower \`max\` to ${lines} ` +
          "so the ratchet keeps its grip."
      );
    }
  }
}

if (failures) {
  console.error(`source_size_ratchet:eval FAILED (${failures} file(s) over ceiling)`);
  process.exit(1);
}
console.log(`source_size_ratchet:eval OK (${CEILINGS.length} ceiling(s) held)`);
