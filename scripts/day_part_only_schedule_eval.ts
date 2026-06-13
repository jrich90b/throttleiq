/**
 * Day-part-only schedule reply eval. Production fixture: Al Davis
 * +17163059906, 2026-06-06 — agent offered "I can have our sales team meet
 * you Saturday. Do mornings or afternoons work better for you?", customer
 * replied "Afternoon would be great", and the booking whiffed twice over:
 * isShortAckNoReplyText matched "great" and dropped the turn silently, and
 * even without that, the bare day-part carried no day token so
 * parseRequestedDayTime returned null and no slots were offered. A bare
 * day-part reply in a schedule context must inherit the day from the most
 * recent outbound offer and resolve to that day's day-part window.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const {
  parseDayPartOnlyScheduleReply,
  extractOfferedScheduleDayFromOutboundText,
  resolveDayPartOnlyScheduleReply,
  isShortAckNoReplyText
} = await import("../services/api/src/domain/workflowRegressionGuards.ts");
const { parseRequestedDayTime } = await import(
  "../services/api/src/domain/conversationStore.ts"
);

const TZ = "America/New_York";

const AL_DAVIS_OUTBOUND =
  "Got it. Weekend works — I can have our sales team meet you Saturday. Do mornings or afternoons work better for you?";
const AL_DAVIS_INBOUND = "Afternoon would be great";

// The silent-drop half of the bug: a day-part reply is scheduling language,
// never a thank-you sign-off.
assert.equal(
  isShortAckNoReplyText(AL_DAVIS_INBOUND),
  false,
  "'Afternoon would be great' must not be swallowed as a no-reply short ack"
);
assert.equal(isShortAckNoReplyText("Thanks again!"), true, "plain thanks still skips");

// Al's literal turn resolves to Saturday afternoon.
for (const dialogState of ["schedule_offer_sent", "schedule_request", "test_ride_offer_sent"]) {
  const resolved = resolveDayPartOnlyScheduleReply({
    inboundText: AL_DAVIS_INBOUND,
    lastOutboundText: AL_DAVIS_OUTBOUND,
    dialogState
  });
  assert.ok(resolved, `Al Davis turn must resolve in dialog state ${dialogState}`);
  assert.equal(resolved!.dayLabel, "Saturday", "day comes from the prior outbound offer");
  assert.equal(resolved!.parse.dayPart, "afternoon");
  assert.equal(resolved!.parse.startHour24, 12, "afternoon window opens at noon");
  assert.equal(resolved!.parse.endHour24, 17, "afternoon window closes at 5pm");
  assert.equal(resolved!.windowLabel, "Saturday afternoon");

  // The requested text must pin a concrete upcoming Saturday at noon.
  const requested = parseRequestedDayTime(resolved!.requestedText, TZ);
  assert.ok(requested, `requestedText '${resolved!.requestedText}' must parse`);
  assert.equal(requested!.dayOfWeek.toLowerCase(), "saturday");
  assert.equal(requested!.hour24, 12);
  assert.equal(requested!.minute, 0);
}

// Outside schedule contexts the resolver stands down.
assert.equal(
  resolveDayPartOnlyScheduleReply({
    inboundText: AL_DAVIS_INBOUND,
    lastOutboundText: AL_DAVIS_OUTBOUND,
    dialogState: "pricing_init"
  }),
  null,
  "day-part resolution only applies in schedule dialog states"
);

// No day in the prior outbound means nothing to inherit.
assert.equal(
  resolveDayPartOnlyScheduleReply({
    inboundText: AL_DAVIS_INBOUND,
    lastOutboundText: "What day and time works best for you to stop in?",
    dialogState: "schedule_offer_sent"
  }),
  null,
  "no offered day in the outbound means no resolution"
);

// Day-part windows.
assert.equal(parseDayPartOnlyScheduleReply("morning works")!.startHour24, 9);
assert.equal(parseDayPartOnlyScheduleReply("morning works")!.endHour24, 12);
assert.equal(parseDayPartOnlyScheduleReply("evening would be best")!.startHour24, 17);
const earlyAfternoon = parseDayPartOnlyScheduleReply("early afternoon would be perfect");
assert.ok(earlyAfternoon, "'early afternoon' must parse");
assert.equal(earlyAfternoon!.variant, "early");
assert.equal(earlyAfternoon!.startHour24, 12);
assert.equal(earlyAfternoon!.endHour24, 14);
const lateMorning = parseDayPartOnlyScheduleReply("late morning is better");
assert.ok(lateMorning, "'late morning' must parse");
assert.equal(lateMorning!.startHour24, 10);
assert.equal(lateMorning!.startMinute, 30);

// A preference cue beats an incidental day-part mention.
assert.equal(
  parseDayPartOnlyScheduleReply("I work mornings so afternoons are better")!.dayPart,
  "afternoon",
  "the preferred day-part wins over the constraint mention"
);

// Shapes the existing parsers already own (or that are ambiguous) decline.
assert.equal(parseDayPartOnlyScheduleReply("Saturday afternoon"), null, "explicit day defers");
assert.equal(parseDayPartOnlyScheduleReply("afternoon around 2"), null, "clock time defers");
assert.equal(parseDayPartOnlyScheduleReply("tonight"), null, "'tonight' pins today, defers");
assert.equal(parseDayPartOnlyScheduleReply("morning or afternoon"), null, "ambiguous declines");
assert.equal(
  parseDayPartOnlyScheduleReply("afternoon doesn't work"),
  null,
  "a rejected day-part is not a request"
);
assert.equal(
  parseDayPartOnlyScheduleReply("what's the price on the afternoon ride"),
  null,
  "competing intent words decline"
);

// Offered-day extraction: concrete days only, schedule-flavored outbounds only.
assert.equal(extractOfferedScheduleDayFromOutboundText(AL_DAVIS_OUTBOUND), "Saturday");
assert.equal(
  extractOfferedScheduleDayFromOutboundText("We can set up a time June 20 if that helps."),
  "June 20"
);
assert.equal(
  extractOfferedScheduleDayFromOutboundText("I can have the team meet you tomorrow."),
  null,
  "'tomorrow' is send-time relative and must not be carried"
);
assert.equal(
  extractOfferedScheduleDayFromOutboundText("We're closed Monday for the holiday."),
  null,
  "a day mention without a schedule cue is not an offer"
);

// Both reply paths must wire the route (AGENTS.md parser-first rule).
const indexSource = await fs.readFile(
  path.resolve("services/api/src/index.ts"),
  "utf8"
);
assert.match(
  indexSource,
  /logRouteOutcome\("day_part_only_schedule_slots"/,
  "live /webhooks/twilio path must offer day-part window slots"
);
assert.match(
  indexSource,
  /logRouteOutcome\("day_part_only_schedule_soft_appointment"/,
  "live path must fall back to a soft appointment, never bounce the question"
);
assert.match(
  indexSource,
  /recordRouteOutcome\("regen", "day_part_only_schedule_slots"/,
  "/conversations/:id/regenerate path must offer day-part window slots"
);
assert.match(
  indexSource,
  /recordRouteOutcome\("regen", "day_part_only_schedule_soft_appointment"/,
  "regenerate path must fall back to a soft appointment, never bounce the question"
);

console.log("PASS day part only schedule eval");
