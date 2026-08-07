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
  "decidePostSaleOwnershipTurn",
  "decideWatchScopeTurn",
  "decideAdfDepartmentRoute",
  "decideFinanceProcessQuestionTurn",
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
  "decideWalkInInventoryWatchTurn"
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
