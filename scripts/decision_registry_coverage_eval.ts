/**
 * decision_registry_coverage:eval — stop the equivalence harness going quietly blind.
 *
 * WHY THIS EXISTS. `decision_equivalence.ts` is what lets an un-stacking ship without a human
 * reading the diff: it replays the live corpus through old and new code and compares what the agent
 * DECIDED. That verdict is only ever as strong as the REGISTRY behind it — a decision nobody sampled
 * is a decision the harness will happily report "IDENTICAL" about while it silently changed.
 *
 * On 2026-08-01 the registry sampled 8 decisions out of 55 referees in `routeStateReducer.ts`. That
 * is fine as long as it is a CONSCIOUS 8. The failure mode is drift: someone adds referee #56, the
 * harness never learns about it, and six months later "IDENTICAL over 1,782 decisions" reads like
 * whole-system proof when it covers a shrinking fraction of the system.
 *
 * WHAT THIS ENFORCES. Every exported `decide*`/`resolve*` in the reducer must be EITHER
 *   (a) sampled — named in some registry entry's `covers`, or
 *   (b) listed below in NOT_PROJECTABLE, with a reason.
 * Anything in neither fails the build. It does not demand coverage; it demands a decision.
 *
 * WHY `covers` IS DECLARED, NOT INFERRED. Detecting which reducer functions a sample calls by
 * reflection would pass whenever a sample early-returns before reaching its call (most do, on most
 * conversations) — a check that green-lights itself is worse than none.
 *
 * FAIL DIRECTION: unreadable source, an empty referee list, or an empty registry all FAIL CLOSED.
 * A coverage check that measured nothing would launder exactly the blindness it exists to catch.
 *
 * Run: npx tsx scripts/decision_registry_coverage_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildDecisionRegistry } from "../services/api/src/domain/decisionFingerprint.ts";

const REDUCER = "services/api/src/domain/routeStateReducer.ts";

/**
 * Referees that CANNOT be projected from stored conversation state, with the reason. Un-stacking
 * targets STATE arbitration, so a decision driven by this turn's customer text is genuinely out of
 * scope — but it has to be SAID, not assumed.
 *
 * TO REMOVE ONE: if you can pin its turn-derived inputs at fixed probe values and vary only stored
 * state (see the PROBE technique in decisionFingerprint.ts), sample it instead and delete it here.
 * That is how this list should shrink over time.
 */
const NOT_PROJECTABLE: Record<string, string> = {};

const TURN_TEXT_REASON =
  "reads THIS TURN's customer text / parser output — not derivable from the stored conversation";
for (const fn of [
  // Gated by THIS turn's journey-intent parser verdict plus the availability parser; neither is
  // persisted, so a stored conversation cannot reproduce the inputs that make it fire.
  "decideSaleTradeJourneyBucket",
  // The fourth silencer on +16076549423: keyed to THIS turn's short-ack text and the customer-ack
  // parser's verdict on it, neither of which the stored conversation carries.
  "decideShortAckTurnEnd",
  "resolveTurnPrimaryIntent",
  "decideSchedulingTurn",
  "decideCustomerAckConfirmBooking",
  "decideSchedulingDeferralFollowUpTask",
  "decideStaffAvailabilityAnswer",
  "decideFinancePricingTurn",
  "resolveFinanceFollowUpContinuation",
  "decideVehicleChoiceConfidenceTurn",
  "decideVehicleRecommendationTurn",
  "decideEquipmentClarifyTurn",
  "decidePhotoQuestionTurn",
  "decideVehicleMediaRequestTurn",
  "decideInventoryUnitClarificationTurn",
  "decideFeedbackRedraftTurn",
  "decideDemoRideRedraftGuard",
  "decideFeedbackDiagnosisAction",
  "decideThumbsDownNoteRouting",
  "decideDealStatusCheckTurn",
  "decideWatchOptOutTurn",
  // Driven by THIS turn's acquired-vehicle parse (intent/confidence/vehicle), which is never
  // persisted — a stored conversation cannot reproduce the inputs. Its two STATE inputs
  // (hasActiveWatch, hasPostSaleContext) are projectable, but they only shape the wording and the
  // suppression; the decision itself cannot fire without the turn. Pinned by
  // lost_sale_closeout_ack:eval, which executes it directly.
  "decideLostSaleCloseoutAck",
  "decidePostSaleOwnershipTurn",
  "decideWatchScopeTurn",
  "decideAdfDepartmentRoute",
  // Combines the SAME turn-only ADF department verdict as the route above with one persisted input
  // (conv.departmentLane). The turn half is never stored, so a stored conversation cannot reproduce
  // its inputs. Its decision table is pinned instead by department_lane_persistence:eval, which
  // executes the referee directly across the full prior-lane x this-turn-verdict x release grid.
  "decideDepartmentLaneTurn",
  // Reads the SAME turn-only ADF department verdict as the route above (department + confidence),
  // which is never persisted, so a stored conversation cannot reproduce its inputs. Its decision
  // table is pinned instead by no_subject_web_lead_handoff:eval, which executes it against the
  // parser's measured verdicts.
  "decideNoSubjectWebLeadHandoff",
  // Reads THIS turn's conversation-state parse (departmentIntent + explicitRequest) plus the
  // catalog-lexicon match on the turn's own words; none of it is persisted, so a stored
  // conversation cannot reproduce the inputs. Its decision table is pinned instead by
  // accessory_parts_route:eval, which executes the referee AND the lexicon on the real wording.
  "decideDepartmentRequestTurn",
  "decideFinanceProcessQuestionTurn",
  // Reads THIS turn's bike-scope parse plus live classification/lead state; the parse is never
  // persisted, so a stored conversation cannot reproduce the inputs. Pinned by
  // enough_info_handoff:eval, which executes the table directly.
  "decideSalesHandoffReadiness",
  // Reads THIS turn's budget-gated-on-financing parse (intent + confidence) only; none of it is
  // persisted, so a stored conversation cannot reproduce the inputs. Its decision table is pinned
  // instead by budget_gated_on_financing:eval, which executes it directly.
  "decideBudgetGatedOnFinancingTurn",
  "decideServiceSchedulingHandoffTurn",
  "decideFinanceHardshipTurn",
  "decideIncomingInventoryPurpose",
  "decideNonMotorcycleTradeTurn",
  "decideServiceAppointmentTurn",
  "decideConversationCloseoutTurn",
  "resolveRoutingParserDecision",
  "resolveNoResponsePolicyDecision",
  "decideEventPromoTurn",
  "resolveRideChallengeEventTouch",
  "decideOwnerThreadStepBack",
  "decideTradeQualifierTurn",
  "decideInProcessDealTurn",
  "decideIndefiniteDeferTurn",
  "decideDecideSoonTurn",
  "decideSellToDealerTurn",
  "decideDeptWidgetIntakeTurn",
  "decideNonBuyerSurveyTurn",
  "decideDealerLeadSurveyTurn",
  "decideRidingAcademyTurn",
  "decideJumpstartInviteTurn",
  "resolveRiderExperienceLevel",
  // Its `current` half IS stored (conv.riderExperience), but the half that decides the outcome —
  // `observed` — comes straight from resolveRiderExperienceLevel above, which is listed here
  // because it reads THIS turn's parser output. A referee whose deciding input cannot be rebuilt
  // from a stored conversation cannot be sampled from one. Its decision table is pinned instead by
  // rider_experience_persist:eval, including the never-demote-an-experienced-rider rule.
  "decideRiderExperiencePersist",
  "decideReservationHandoffTurn",
  "decideStockNumberInterestTurn",
  "decidePriceAnswerAnchor",
  "decidePriceObjectionTurn",
  "decideWalkInInventoryWatchTurn",
  // Keyed to THIS turn's widget-sales parser verdict (its intent, and whether IT found a requested
  // vehicle); neither is persisted, so a stored conversation cannot reproduce the inputs. Its
  // decision table is pinned instead by web_text_widget_seller_bucket:eval, which executes it.
  "decideWebTextWidgetSalesClassification"
]) {
  NOT_PROJECTABLE[fn] = TURN_TEXT_REASON;
}

// Driven by the LIVE INVENTORY FEED (is this unit held/sold right now), which is not part of the
// conversation store — so two snapshots taken minutes apart could legitimately differ, which would
// make the harness untrustworthy rather than more thorough.
NOT_PROJECTABLE.decideLeadUnitAvailabilityDisclosure =
  "driven by the live inventory feed, not stored conversation state — sampling it would make the harness non-deterministic";

// Cadence VALUE gate: needs the candidate touch's proposed content, which only exists mid-tick.
NOT_PROJECTABLE.decideProactiveCadenceValue =
  "scores a proposed outbound that only exists mid-tick — there is no stored value to project";

// ADF email mirror: compares two MID-TURN draft strings (the SMS body before the lane-ack overrides
// vs the body the turn finally ships). Neither is stored on the conversation, so there is nothing to
// project from a replayed record. Pinned by adf_email_mirrors_final_ack:eval instead.
NOT_PROJECTABLE.decideAdfEmailMirror =
  "compares two mid-turn draft strings; neither is persisted, so there is nothing to project";

// Ride-challenge wrap-up revive: the verdict is a function of WALL-CLOCK time against the event
// window (dormant before it matters, revive inside event+grace, dormant again after) — two harness
// runs straddling 9/15 would legitimately differ, which would make the harness untrustworthy rather
// than more thorough. Its decision table (incl. the convergence guarantee) is pinned by
// ride_challenge_event_cadence:eval, which executes it directly.
NOT_PROJECTABLE.decideRideChallengeWrapUpRevive =
  "verdict depends on wall-clock now vs the 9/15 event window — sampling it would make the harness non-deterministic; table pinned by ride_challenge_event_cadence:eval";

// --- the check ---------------------------------------------------------------------------------

const src = (() => {
  const full = path.resolve(REDUCER);
  assert.ok(fs.existsSync(full), `decision registry coverage: ${REDUCER} not found — the scan is broken`);
  return fs.readFileSync(full, "utf8");
})();

const referees = [...src.matchAll(/^export function ((?:decide|resolve)[A-Za-z0-9_]*)/gm)].map(m => m[1]);
assert.ok(
  referees.length > 0,
  "decision registry coverage: found ZERO referees — the enumeration broke, and an empty scan must never pass"
);

// Build against the real reducer so `covers` reflects what actually shipped.
const reducer = await import("../services/api/src/domain/routeStateReducer.ts");
const registry = buildDecisionRegistry(reducer);
assert.ok(registry.length > 0, "decision registry coverage: the registry is EMPTY — nothing would be compared");

const sampled = new Set<string>();
for (const entry of registry) for (const fn of entry.covers ?? []) sampled.add(fn);
assert.ok(
  sampled.size > 0,
  "decision registry coverage: no registry entry declares `covers` — coverage cannot be verified"
);

// Every declared `covers` name must actually exist, or a typo would silently count as coverage.
const exportedNames = new Set(
  [...src.matchAll(/^export function ([A-Za-z0-9_]*)/gm)].map(m => m[1])
);
const phantom = [...sampled].filter(fn => !exportedNames.has(fn));
assert.deepEqual(
  phantom,
  [],
  `registry declares coverage of function(s) that do not exist in the reducer: ${phantom.join(", ")}`
);

const unclassified = referees.filter(fn => !sampled.has(fn) && !(fn in NOT_PROJECTABLE));
if (unclassified.length) {
  console.error(
    `  FAIL decision registry coverage: ${unclassified.length} referee(s) are neither sampled nor classified:\n` +
      unclassified.map(f => `       - ${f}`).join("\n") +
      "\n       Every decide*/resolve* must be EITHER sampled in buildDecisionRegistry (add it to that\n" +
      "       entry's `covers`) OR listed in NOT_PROJECTABLE with a reason. This does not demand\n" +
      "       coverage — it demands a conscious decision, so the equivalence harness cannot drift\n" +
      "       into proving less and less while still reporting 'IDENTICAL'."
  );
  process.exit(1);
}

// A classification that names a function which no longer exists is stale bookkeeping — it makes the
// covered fraction look better than it is.
const staleClassifications = Object.keys(NOT_PROJECTABLE).filter(fn => !referees.includes(fn));
assert.deepEqual(
  staleClassifications,
  [],
  `NOT_PROJECTABLE names referee(s) that no longer exist (delete them): ${staleClassifications.join(", ")}`
);

const covered = referees.filter(fn => sampled.has(fn));
console.log(
  `decision_registry_coverage:eval OK — ${referees.length} referees: ` +
    `${covered.length} sampled, ${referees.length - covered.length} classified un-projectable, 0 unclassified ` +
    `(${registry.length} registry entries)`
);
