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
 * Run: npx tsx scripts/service_scheduling_defer_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { isDealerVisitTimeCheckInText } from "../services/api/src/domain/workflowRegressionGuards.ts";

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

// --- Call-site wiring: isServiceDepartmentSchedulingRequest defers on a non-service visit check-in. ---
const api = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(api, /isDealerVisitTimeCheckInText\(lastOutboundBody\) && !\/\\bservice\\b\/i\.test\(lastOutboundBody\)/, "service handoff defers on a NON-service dealer visit check-in");
assert.match(api, /if \(isDealerVisitTimeCheckInText\(lastOutboundBody\) && [^\n]*\) return false;/, "defer returns false (let the scheduling cluster handle it)");
// And it sits inside isServiceDepartmentSchedulingRequest (so every caller — live, regen, the auto-book
// guard, the cadence guards — shares the corrected definition).
assert.match(
  api,
  /function isServiceDepartmentSchedulingRequest\(conv: any, text[\s\S]*?isDealerVisitTimeCheckInText\(lastOutboundBody\)/,
  "the defer lives inside isServiceDepartmentSchedulingRequest"
);
n += 3;

console.log(`PASS service-scheduling defer eval (${n} assertions)`);
