/**
 * Service-scheduling defer eval (2026-06-25).
 *
 * A sticky service-classified lead (bucket=service / service_handoff) was getting "I'll have SERVICE
 * check availability for 1:00 PM and follow up" when the customer simply ANSWERED a dealer-initiated
 * visit-time check-in (Scott → Bobby Kindred: "what time you planned on coming in this afternoon?" →
 * customer "What is Good 1 or 2"). The service-scheduling handoff (index.ts) was claiming the turn
 * before the centralized scheduling cluster. Fix: `isServiceDepartmentSchedulingRequest` defers when
 * our OWN last outbound was a (non-service) visit-time check-in — the scheduling cluster owns a visit
 * confirmation. `isDealerVisitTimeCheckInText` is the pure text predicate (reads the dealer framing).
 *
 * 2026-08-02 (Edward Trouse +17166281539): the deferral used to decide COMPREHENSION off a keyword —
 * it asked whether OUR check-in contained the literal word "service". A post-sale sticker repair
 * ("let me know when you want to bring it in and we can put a new sticker on the bike") never says
 * it, so the customer's "Probably around 4pm" was booked as a SALES appointment. The predicate now
 * lives in `isDealerVisitTimeCheckInWithoutServiceText` and the two service-handoff sites hand it to
 * `decideServiceSchedulingHandoffTurn`, where a CONFIDENT service_visit parse can outrank it. Bobby's
 * deferral remains the default everywhere else, so this eval pins both halves.
 *
 * Run: npx tsx scripts/service_scheduling_defer_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { isDealerVisitTimeCheckInText, isDealerVisitTimeCheckInWithoutServiceText } from "../services/api/src/domain/workflowRegressionGuards.ts";
import { decideServiceSchedulingHandoffTurn } from "../services/api/src/domain/routeStateReducer.ts";

let n = 0;
const T = (cond: boolean, msg: string) => { assert.equal(cond, true, msg); n++; };

// --- POSITIVE: dealer-initiated visit/arrival-time check-ins. ---
T(isDealerVisitTimeCheckInText("Good Morning Bobby! Just wanted to check in to see what time you planned on coming in this afternoon? Let me know, thanks!"), "Bobby's real prompt: what time ... coming in");
T(isDealerVisitTimeCheckInText("What time are you coming in today?"), "what time are you coming in");
T(isDealerVisitTimeCheckInText("when are you planning to stop by?"), "when ... stop by");
T(isDealerVisitTimeCheckInText("What time works for you?"), "what time works");
T(isDealerVisitTimeCheckInText("what time should we expect you?"), "what time should we expect you");
T(isDealerVisitTimeCheckInText("When will you be here?"), "when will you be here");

// --- NEGATIVE: not a visit-time check-in. ---
T(isDealerVisitTimeCheckInText("It's a 2026 Road Glide in Vivid Black.") === false, "a vehicle fact is not a check-in");
T(isDealerVisitTimeCheckInText("Thanks for coming in today!") === false, "a past-visit thank-you is not a check-in");
T(isDealerVisitTimeCheckInText("I'll have service check availability and follow up.") === false, "our own service deflection is not a check-in");
T(isDealerVisitTimeCheckInText("") === false, "empty");
T(isDealerVisitTimeCheckInText("Do you have a bike preference, or are you still comparing models?") === false, "a model question is not a check-in");

// --- Behaviour of the moved predicate (2026-08-02): same two conditions as the old inline test. ---
T(isDealerVisitTimeCheckInWithoutServiceText("What time on this coming Tuesday works best?"), "Edward's check-in: a check-in that never says service");
T(isDealerVisitTimeCheckInWithoutServiceText("What time works for you for the service appointment?") === false, "a check-in that DOES name service is not deferred");
T(isDealerVisitTimeCheckInWithoutServiceText("It's a 2026 Road Glide in Vivid Black.") === false, "a vehicle fact is not a check-in");

// --- Call-site wiring: isServiceDepartmentSchedulingRequest defers on a non-service visit check-in. ---
const api = fs.readFileSync("services/api/src/index.ts", "utf8");
// The predicate moved into workflowRegressionGuards so the hard-gate callers and the two
// referee callers can never drift apart; the DEFER ITSELF is unchanged (still `return false`,
// still applied unless a caller explicitly opts out).
assert.match(
  api,
  /const isDealerVisitTimeCheckInWithoutService = \(conv: any\): boolean =>\s*\n?\s*isDealerVisitTimeCheckInWithoutServiceText\(String\(getLastNonVoiceOutbound\(conv\)\?\.body \?\? ""\)\)/,
  "index.ts reads the check-in off OUR last non-voice outbound"
);
assert.match(
  api,
  /if \(\(opts\?\.applyVisitCheckInDeferral \?\? true\) && isDealerVisitTimeCheckInWithoutService\(conv\)\) return false;/,
  "defer returns false by default (let the scheduling cluster handle it)"
);
// And it sits inside isServiceDepartmentSchedulingRequest (so every caller — live, regen, the auto-book
// guard, the cadence guards — shares the corrected definition).
assert.match(
  api,
  /function isServiceDepartmentSchedulingRequest\([\s\S]*?isDealerVisitTimeCheckInWithoutService\(conv\)/,
  "the defer lives inside isServiceDepartmentSchedulingRequest"
);
// Bobby's protection survives the move: with no confident service_visit parse, a visit-time
// check-in still routes the turn AWAY from the service handoff — now decided in the referee.
assert.equal(
  decideServiceSchedulingHandoffTurn({
    serviceContextHint: true,
    customerNamedServiceThisTurn: false,
    parserPurpose: "unknown",
    parserConfidence: 0.4,
    confidenceMin: 0.6,
    dealerVisitTimeCheckIn: true
  }).route,
  "defer_to_scheduling_cluster",
  "Bobby Kindred: a bare time answering our check-in still defers"
);
n += 4;

console.log(`PASS service-scheduling defer eval (${n} assertions)`);
