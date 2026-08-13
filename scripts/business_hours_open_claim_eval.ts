/**
 * "THAT DAY AT 5:00 PM IS DURING OPEN HOURS" — a claim nobody checked (+17169902571, 2026-08-12).
 *
 * John Zimmerman had just been told to name a time to stop in, and asked:
 *
 *   "Okay Joe what time are you guys open Intill 5pm ?"
 *
 * The agent drafted:
 *
 *   "Our hours this week are Mon-Fri 9:00 AM-6:00 PM, Sat 9:00 AM-3:00 PM. that day at 5:00 PM is
 *    during open hours, but I still need to check appointment availability before locking it in."
 *
 * Staff deleted the second sentence and sent the first. Joe filed it: "the agent should have just
 * answered when we are open instead of this".
 *
 * THREE defects in one sentence, all in the same missing check:
 *   1. He named no day, so the label fell back to the literal string "that day" — a dangling
 *      reference that also starts a sentence in lower case, mid-message.
 *   2. Nothing was verified. The tail was emitted because a TIME TOKEN existed, not because we
 *      are open then. Executed against the live config, "are you open saturday at 5pm?" produces
 *      "Saturday at 5:00 PM is during open hours" while the hours invariant says FALSE — Saturday
 *      shuts at 3. On the very Saturday named one sentence earlier.
 *   3. Sunday has no entry in businessHours at all, and the claim was made for it too.
 *
 * WHY A NEW PREDICATE RATHER THAN THE EXISTING ONE. `mayStateTimeAsWorkable` answers "could this
 * time work?", so its documented fail direction is to STATE on anything unknown — an absent day is
 * unknown rather than closed, and a floating time is judged against ANY open day. Right for an
 * echo, wrong for an assertion: 5:00 PM passes that bar (Mon-Fri close at 6) which is exactly why
 * the live turn slipped through. `mayClaimTimeIsDuringOpenHours` refuses unless the day is
 * RESOLVED, has a POSITIVELY KNOWN window, and the time lands inside it — and delegates that last
 * test to the same invariant, so one window comparison still governs both.
 *
 * FAIL DIRECTION: a refusal removes a claim. It can never assert a closure and can never mute the
 * agent — the hours line still answers the question, which is byte-for-byte what staff sent.
 *
 * Part 4 pins the WIRING, because tsc cannot prove either door still asks the guard.
 *
 * Run: npx tsx scripts/business_hours_open_claim_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { mayClaimTimeIsDuringOpenHours, mayStateTokenAsWorkable } = await import(
  "../services/api/src/domain/businessHoursGuard.ts"
);
const { resolveRequestedDay, decorateBusinessHoursReply, formatBusinessHoursProposalTime } =
  await import("../services/api/src/domain/inboundPipeline.ts");
const { extractTimeToken } = await import("../services/api/src/domain/legacyRegexFallback.ts");

let n = 0;
const ok = (cond: boolean, msg: string) => {
  assert.equal(cond, true, msg);
  n++;
};

// The store's real business hours, read off the live scheduler config on 2026-08-13. Saturday
// closing three hours earlier than the rest of the week is what makes the claim wrong.
const HOURS: Record<string, { open: string; close: string }> = {
  monday: { open: "09:00", close: "18:00" },
  tuesday: { open: "09:00", close: "18:00" },
  wednesday: { open: "09:00", close: "18:00" },
  thursday: { open: "09:00", close: "18:00" },
  friday: { open: "09:00", close: "18:00" },
  saturday: { open: "09:00", close: "15:00" }
  // no sunday key — the dealership is closed
};

// The tail the doors append when the claim IS substantiated. Unchanged copy; only when it may be
// said has changed.
const TAIL_MARK = "is during open hours";

// Reproduce a door: resolve the day the way the base hours reply does, then ask the guard.
function mayClaim(text: string, todayKey = "wednesday", tomorrowKey = "thursday") {
  const day = resolveRequestedDay({ text, todayKey, tomorrowKey });
  const timeToken = extractTimeToken(text);
  return {
    day,
    timeToken,
    allowed: mayClaimTimeIsDuringOpenHours({ dayKey: day.day, timeToken, businessHours: HOURS })
  };
}

// ---------------------------------------------------------------------------
// PART 1 — the reported turn
// ---------------------------------------------------------------------------

const JOHN = "Okay Joe what time are you guys open Intill 5pm ?";
const john = mayClaim(JOHN);

// The pieces that made the old sentence: a readable time and no day whatsoever.
ok(john.timeToken === "5:00pm", `time token read ${john.timeToken}, expected 5:00pm`);
ok(john.day.day === null, `no day was named, resolver returned ${john.day.day}`);
ok(john.day.label === null, "a turn naming no day has no day label to print");

// THE REGRESSION. Before the fix this claim was made, labelled "that day".
ok(!john.allowed, "a turn that names no day must not claim a time is during open hours");

// And the reason it slipped past the pre-existing invariant: 5:00 PM is inside SOME day's window,
// so the echo-grade guard was happy. Pinning this keeps the two predicates from being merged back.
ok(
  mayStateTokenAsWorkable("5:00pm", HOURS, null) === true,
  "the echo guard accepts a floating 5:00 PM — which is why a stricter claim guard exists"
);

// What the customer now reads is the hours line alone, exactly what staff sent by hand.
const baseLine = "Our hours this week are Mon-Fri 9:00 AM-6:00 PM, Sat 9:00 AM-3:00 PM.";
const delivered = john.allowed ? `${baseLine} ...${TAIL_MARK}...` : baseLine;
ok(delivered === baseLine, `the reply should be the hours line alone, got ${JSON.stringify(delivered)}`);
ok(!delivered.includes("that day"), "the dangling 'that day' label must never come back");
ok(!delivered.includes(TAIL_MARK), "no unsubstantiated open-hours claim");

// ---------------------------------------------------------------------------
// PART 2 — the claim is FALSE, not merely unverified
// ---------------------------------------------------------------------------

// Saturday shuts at 3. Today's code said "Saturday at 5:00 PM is during open hours".
const sat5 = mayClaim("are you open saturday at 5pm?");
ok(sat5.day.day === "saturday" && sat5.day.label === "Saturday", `resolved ${sat5.day.day}`);
ok(sat5.timeToken === "5:00pm", `time token read ${sat5.timeToken}`);
ok(!sat5.allowed, "5:00 PM on a Saturday is after close — the claim is false and must not be made");
// The echo guard agrees here, so this half is the plain invariant finally being consulted.
ok(mayStateTokenAsWorkable("5:00pm", HOURS, "saturday") === false, "Saturday 5:00 PM is shut");

// A day with no entry at all is not a day we can claim to be open on.
const sun = mayClaim("you open sunday at 11am?");
ok(sun.day.day === "sunday", `resolved ${sun.day.day}`);
ok(!sun.allowed, "Sunday has no hours entry — we cannot claim to be open");
// Deliberate divergence from the echo guard, whose fail direction is unknown-means-statable. If
// this ever reads true, the two predicates have been collapsed and Sunday claims come back.
ok(
  mayStateTokenAsWorkable("11:00am", HOURS, "sunday") === true,
  "the echo guard treats an absent day as unknown — the claim guard must not inherit that"
);

// Exactly at close is outside: 3:00 PM on a Saturday is the moment we shut.
ok(!mayClaim("saturday at 3pm?").allowed, "3:00 PM Saturday is closing time, not open time");
ok(mayClaim("saturday at 2:30pm?").allowed, "2:30 PM Saturday is inside the window");

// ---------------------------------------------------------------------------
// PART 3 — the turns that were right stay right
// ---------------------------------------------------------------------------

for (const [text, expectDay, expectLabel] of [
  ["are you open saturday at 1pm?", "saturday", "Saturday"],
  ["can I come monday at 4pm?", "monday", "Monday"],
  ["open friday at 9:30am?", "friday", "Friday"]
] as const) {
  const r = mayClaim(text);
  ok(r.day.day === expectDay, `${JSON.stringify(text)} resolved ${r.day.day}`);
  ok(r.allowed, `${JSON.stringify(text)} is inside the window and must still be claimed`);
  // The label comes from the resolution, so the sentence can never name a different day.
  const tail = `${r.day.label} at ${formatBusinessHoursProposalTime(r.timeToken!)} ${TAIL_MARK}`;
  ok(tail.startsWith(expectLabel), `tail named the wrong day: ${tail}`);
  ok(
    r.day.label!.toLowerCase() === r.day.day,
    `label ${r.day.label} does not name the day checked (${r.day.day})`
  );
}

// "tomorrow" resolves to a real day and is judged on THAT day's hours, not on any day's.
const tomorrowSat = mayClaim("are you open tomorrow at 5pm?", "friday", "saturday");
ok(tomorrowSat.day.day === "saturday", `tomorrow resolved ${tomorrowSat.day.day}`);
ok(!tomorrowSat.allowed, "tomorrow is Saturday, which shuts at 3 — no claim");
const tomorrowMon = mayClaim("are you open tomorrow at 5pm?", "sunday", "monday");
ok(tomorrowMon.day.day === "monday" && tomorrowMon.allowed, "tomorrow is Monday, open until 6");

// An unreadable or ambiguous time is never claimed. "1:30" with no meridiem could be either half
// of the day, and the guard hands ambiguity back rather than guessing.
ok(
  !mayClaimTimeIsDuringOpenHours({ dayKey: "monday", timeToken: "1:30", businessHours: HOURS }),
  "an ambiguous bare 1:30 must not be claimed as open"
);
ok(
  !mayClaimTimeIsDuringOpenHours({ dayKey: "monday", timeToken: null, businessHours: HOURS }),
  "no time token means there is nothing to claim"
);
// A missing config cannot substantiate a claim either — but note this only ever REMOVES the tail;
// the hours line itself is built elsewhere and still answers the customer.
ok(
  !mayClaimTimeIsDuringOpenHours({ dayKey: "monday", timeToken: "4:00pm", businessHours: null }),
  "no hours config means no substantiated claim"
);

// ---------------------------------------------------------------------------
// PART 4 — the OTHER hours door, and the wiring
// ---------------------------------------------------------------------------

// decorateBusinessHoursReply is the sibling door. It said "That time is during open hours" without
// naming a day at all — 2 of the 3 occurrences of this tail in the live store came from it.
const base = "Our hours this week are Mon-Fri 9:00 AM-6:00 PM, Sat 9:00 AM-3:00 PM.";
const withTime = { hasScheduleTimeSignal: true } as any;

const refused = decorateBusinessHoursReply({
  baseReply: base,
  decision: withTime,
  canInviteSchedule: true,
  mayClaimOpenHours: false
});
ok(!refused.includes(TAIL_MARK), "a refused claim must not appear in the sibling door's reply");
ok(
  refused.includes("what time works best"),
  "refusing the claim falls through to the invitation, so the reply still advances"
);

const claimed = decorateBusinessHoursReply({
  baseReply: base,
  decision: withTime,
  canInviteSchedule: true,
  mayClaimOpenHours: true
});
ok(claimed.includes(TAIL_MARK), "a substantiated claim is still made, wording unchanged");

// Callers that pass nothing keep today's behaviour — the flag is additive.
const legacy = decorateBusinessHoursReply({
  baseReply: base,
  decision: withTime,
  canInviteSchedule: true
});
ok(legacy.includes(TAIL_MARK), "omitting the flag must not change existing callers");

// The gates that already existed are untouched by the new flag.
ok(
  decorateBusinessHoursReply({
    baseReply: base,
    decision: withTime,
    canInviteSchedule: false,
    mayClaimOpenHours: true
  }) === base,
  "a lead we may not invite still gets the bare hours line"
);
ok(
  decorateBusinessHoursReply({
    baseReply: "We're closed on Sunday.",
    decision: withTime,
    canInviteSchedule: true,
    mayClaimOpenHours: true
  }) === "We're closed on Sunday.",
  "a closed-day reply is never decorated"
);

const here = path.dirname(fileURLToPath(import.meta.url));
const indexSrc = fs.readFileSync(path.join(here, "../services/api/src/index.ts"), "utf8");
const guardSrc = fs.readFileSync(
  path.join(here, "../services/api/src/domain/businessHoursGuard.ts"),
  "utf8"
);

// BOTH doors must be guarded, and they are guarded in different places: the pipeline door passes
// the verdict down as a flag, the live tail door composes inside the guard module. Counting one
// site would let the other come back unprotected, so each is pinned where it lives.
ok(
  indexSrc.includes("mayClaimOpenHours: mayClaimTimeIsDuringOpenHours"),
  "the pipeline door no longer passes the guard's verdict to decorateBusinessHoursReply"
);
ok(
  indexSrc.includes("businessHoursOpenClaimTail"),
  "the live hours door no longer routes its tail through the guarded builder"
);
ok(
  guardSrc.includes("mayClaimTimeIsDuringOpenHours"),
  "the tail builder no longer consults the claim guard"
);
// The tail prints the label that came WITH the day the guard checked, so it can never name a
// different one, and the dangling placeholder is gone for good.
ok(
  guardSrc.includes("${args.dayLabel} at ${args.timeLabel} is during open hours"),
  "the tail no longer labels the day from the same resolution the guard checked"
);
ok(
  !indexSrc.includes("const dayLabel = day ? day.replace"),
  "the hours tail still falls back to a placeholder day label when no day was named"
);
// The tail door must hand over the SAME resolution the base reply used — two resolvers on one
// turn is the divergence #627 removed from the weekday label.
ok(
  indexSrc.includes("dayKey: requestedDay.day") && indexSrc.includes("dayLabel: requestedDay.label"),
  "the tail door is resolving its own day again instead of sharing the base reply's resolution"
);
// The tail door resolves its day with the SAME resolver as the base reply — a second private
// resolver here is the divergence #627 removed from the weekday label.
ok(
  !indexSrc.includes("const day = parseDayOfWeek(text)?.day;"),
  "the hours tail is resolving its own day again instead of sharing the base reply's resolution"
);

console.log(`business_hours_open_claim:eval OK (${n} assertions)`);
