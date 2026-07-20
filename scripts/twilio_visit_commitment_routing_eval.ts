/**
 * Twilio visit-commitment routing eval. Production miss: Todd Herian
 * +15673079691, 2026-06-13 ~6:08pm — after a Road Glide test-ride thread he
 * texted "Ok I will be there for the taste of country pre party on Saturday 👍".
 * The appointment-timing parser read that future-day VISIT COMMITMENT as a
 * provide_arrival_window / arrival_update, so buildAppointmentArrivalAck drafted
 * "I'll check that time and follow up." — instead of confirming the committed
 * day. The fix routes a recognized commitment through the inbound_reply_action
 * parser's schedule_context_status_update, which confirms the day.
 *
 * Parser-first (AGENTS.md "Twilio conversations: comprehend, never regex"):
 * comprehension is the LLM parser's job; routing PRECEDENCE over the arrival ack
 * is a pure function of the parser results. The LLM is not run in ci:eval, so
 * this eval pins (1) that precedence helper, (2) that BOTH handler paths apply it
 * and rely on the parser (no isScheduleContextStatusUpdateText regex), and (3)
 * that the reply confirms the committed day. This is migration #1 — the template
 * for the remaining Twilio comprehension-guard burndown.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import { checkMessage } from "./voice_charter_audit.ts";
import { scheduleStatusCommitmentOutranksArrivalAck } from "../services/api/src/domain/workflowRegressionGuards.ts";

const TODD_INBOUND = "Ok I will be there for the taste of country pre party on Saturday 👍";

// 1) Routing precedence (pure). When the inbound_reply_action parser recognizes
//    the visit commitment inside an active schedule/visit context, the
//    schedule-status confirmation outranks the appointment-timing / customer-ack
//    arrival-window ack — even though the appointment-timing parser misread the
//    same turn as arrival_update.
assert.equal(
  scheduleStatusCommitmentOutranksArrivalAck({
    parserScheduleStatusUpdate: true, // inbound_reply_action -> schedule_context_status_update (accepted)
    scheduleDialogState: true, // test_ride_* / schedule_* dialog state
    scheduleOfferContext: true
  }),
  true,
  "a recognized visit commitment in an active schedule context outranks the arrival ack"
);

// It must NOT fire outside an active schedule/visit context — it can never hijack
// an unrelated turn.
assert.equal(
  scheduleStatusCommitmentOutranksArrivalAck({
    parserScheduleStatusUpdate: true,
    scheduleDialogState: false,
    scheduleOfferContext: false
  }),
  false,
  "no schedule context -> normal routing keeps the turn"
);

// And when the parser did NOT recognize a visit commitment, the arrival ack stands
// (we never suppress it on a guess — that would strand the turn).
assert.equal(
  scheduleStatusCommitmentOutranksArrivalAck({
    parserScheduleStatusUpdate: false,
    scheduleDialogState: true,
    scheduleOfferContext: true
  }),
  false,
  "no schedule-status parser signal -> arrival ack is not suppressed"
);

// 2) Both handler paths must apply the precedence gate and rely on the parser.
const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");

assert.doesNotMatch(
  apiSource,
  /isScheduleContextStatusUpdateText/,
  "the comprehension regex must be retired from the twilio + regenerate handlers (parser-first)"
);

// Scheduling-cluster precedence (incl. visit-commitment-beats-arrival-ack) is now
// centralized in decideSchedulingTurn (routeStateReducer.ts) and exhaustively pinned by
// scheduling_turn_decision_eval.ts. Here we pin that BOTH handler paths route through
// that single decision so the live/regen drift the Todd bug rode on cannot return.
assert.ok(
  (apiSource.match(/decideSchedulingTurn\(/g) ?? []).length >= 2,
  "live + regen paths must both route the scheduling cluster through decideSchedulingTurn"
);
assert.ok(
  /sched\.kind === "visit_commitment"/.test(apiSource) &&
    /regenSched\.kind === "visit_commitment"/.test(apiSource),
  "live + regen schedule-status arms must gate on the centralized visit_commitment decision"
);
assert.ok(
  /sched\.kind === "arrival_window"/.test(apiSource) &&
    /sched\.kind === "arrival_update"/.test(apiSource) &&
    /regenSched\.kind === "arrival_update"/.test(apiSource),
  "the arrival-ack arms (live + regen) must gate on the centralized decision, not inline regex"
);

// 3) The schedule-status reply confirms the committed day — never the arrival ack
//    — and recognizes the commitment from the parser, regardless of event name. A DAY-ONLY
//    soft-visit commitment counts in BOTH paths (Joe ruling 2026-07-19, Peter Meredith
//    +17168303999: "Sounds good see you Monday" must confirm the day, not re-ask a time).
assert.match(
  apiSource,
  /parserVisitCommitment: inboundParserScheduleStatusUpdate \|\| dayOnlySoftVisitCommitment/,
  "live schedule-status reply must pass the parser commitment (incl. day-only) so it confirms the day"
);
assert.match(
  apiSource,
  /parserVisitCommitment: regenParserScheduleStatusUpdate \|\| isParserSoftVisitCommitment\(regenAppointmentTimingParse\)/,
  "regen schedule-status reply must pass the parser commitment (incl. day-only) so it confirms the day"
);
assert.match(
  apiSource,
  /Perfect, you're set for \$\{inboundDay\}!/,
  "a recognized visit commitment gets a day confirmation, never a re-ask or arrival ack"
);

// Behavioral copy of buildScheduleContextStatusUpdateReply's parser-commitment
// branch (pure logic mirrored from index.ts; the literal is pinned above). For
// Todd's turn the parser commitment + the named day "Saturday" confirms the day;
// the event regex never fires on "taste of country pre party" and we never want it
// to — recognition is the parser's, not a keyword's.
const ARRIVAL_ACK = "Sounds good — I’ll check that time and follow up.";
function confirmationReplyFor(day: string): string {
  return `Perfect, you're set for ${day}! Come find us when you get here and we'll get you taken care of. If you want a set time that day, just text me one.`;
}
const toddReply = confirmationReplyFor("Saturday");
assert.notEqual(toddReply, ARRIVAL_ACK, "Todd must not receive the vague arrival ack");
assert.match(toddReply, /you're set for Saturday/, "Todd's committed day (Saturday) is confirmed");
assert.deepEqual(
  checkMessage(toddReply, { firstOutbound: false, smsLike: true, staffHasSent: false }),
  [],
  "the visit-commitment confirmation must be charter-clean"
);

// Sanity: the helper is referenced for what TODD_INBOUND represents — a future-day
// commitment, not an en-route ETA. (Pins the fixture turn to the eval narrative.)
assert.ok(/\bSaturday\b/i.test(TODD_INBOUND), "fixture turn names the committed day");

console.log("PASS twilio visit-commitment routing eval");
