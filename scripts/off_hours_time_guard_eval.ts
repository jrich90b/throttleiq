/**
 * off_hours_time_guard:eval — never tell a customer a time works when the store is shut.
 *
 * FOUR MESSAGES THAT ACTUALLY WENT OUT (americanharley, verified in the store):
 *   +17169822561  "around 1-2pm"        -> "Sounds good. 1:00 AM can work."
 *   +17165155413  "the 9th after 1:30"  -> "Sounds good. 1:30 AM can work."
 *   +18153294306  "...it's a 2022!"     -> "tomorrow at 8:22 PM works."   (MODEL YEAR read as 20:22)
 * Three different comprehension bugs. All three are now fixed IN THE PARSERS — probed against
 * current code, "after 1:30" resolves to 13:30, "1-2pm" keeps its meridiem, and "2022" no longer
 * parses as a time. Those specific messages are stale echoes and this eval does NOT re-assert them.
 *
 * WHAT THIS PINS is the thing none of those fixes gave us: nothing ever CHECKED the hours before
 * asserting a time. The class outlives every point fix, and it is reachable today with no parser
 * bug at all — an ordinary "how about 8pm?" produced
 *   "Got it - 8:00 PM can work. Which day were you thinking?"      (store closes at 6)
 *   "Saturday 8:00 PM should work. Want me to lock that in?"       (Saturday closes at 3)
 * The second is worse than the first: it offers to BOOK the impossible time.
 *
 * DETERMINISTIC ON PURPOSE (AGENTS.md "deterministic only for ... invariant guards"): opening hours
 * are a dealer fact, not a reading of the customer. No intent the customer could have makes 8:00 PM
 * a time the store is open. The guard never decides what they meant — it only refuses to ASSERT
 * something impossible.
 *
 * FAIL DIRECTION, and most of the checks below exist to hold it: the guard says NO only when it
 * POSITIVELY knows the store is shut. Unparseable time, ambiguous time, missing hours config,
 * a day with no entry — all return "state it". A guard that fails closed would mute the agent or
 * emit false "we're closed" replies on any config hiccup, which is worse than the echo it prevents.
 */
import assert from "node:assert/strict";

const {
  mayStateTimeAsWorkable,
  mayStateTokenAsWorkable,
  parseTimeTokenToClock,
  statableTimeReply,
  widestOpenWindow,
  formatBusinessHoursForReply
} = await import("../services/api/src/domain/businessHoursGuard.ts");

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks += 1;
};

// The real americanharley config: Mon-Fri 9-6, Sat 9-3, CLOSED Sunday (absent entirely).
const HOURS = {
  monday: { open: "09:00", close: "18:00" },
  tuesday: { open: "09:00", close: "18:00" },
  wednesday: { open: "09:00", close: "18:00" },
  thursday: { open: "09:00", close: "18:00" },
  friday: { open: "09:00", close: "18:00" },
  saturday: { open: "09:00", close: "15:00" }
};

// ---------------------------------------------------------------------------
// 1. THE PRODUCTION SHAPE, no day named. A floating time is impossible only when it is outside
//    EVERY open day — that is the honest bar when the customer hasn't picked a day yet.
// ---------------------------------------------------------------------------
for (const [token, statable, why] of [
  ["8:00pm", false, "the store closes at 6 every day"],
  ["8pm", false, "same, written without minutes"],
  ["7:00am", false, "before opening on every day"],
  ["1:00am", false, "the +17169822561 message"],
  ["6:30am", false, "before opening"],
  ["11:59pm", false, "midnight-ish"],
  ["2:00pm", true, "mid-afternoon, open every day"],
  ["9:00am", true, "opening minute is open"],
  ["5:30pm", true, "open Mon-Fri even though Saturday has closed"],
  ["2:30pm", true, "open"]
] as const) {
  ok(
    mayStateTokenAsWorkable(token, HOURS, null) === statable,
    `no-day "${token}" should be ${statable ? "statable" : "refused"} — ${why}`
  );
}

// 5:30 PM is the load-bearing one for the ANY-open-day rule: shut on Saturday, open Mon-Fri.
ok(
  mayStateTokenAsWorkable("5:30pm", HOURS, null) === true &&
    mayStateTokenAsWorkable("5:30pm", HOURS, "saturday") === false,
  "a time open on some days but not Saturday is statable while floating, refused once Saturday is named"
);

// ---------------------------------------------------------------------------
// 2. WITH A DAY NAMED — the "want me to lock that in?" turn, where being wrong books nothing but
//    promises everything.
// ---------------------------------------------------------------------------
for (const [token, dayKey, statable] of [
  ["8:00pm", "saturday", false],
  ["4:00pm", "saturday", false], // Saturday closes at 3
  ["2:00pm", "saturday", true],
  ["4:00pm", "tuesday", true], // same clock time, open on a weekday
  ["5:59pm", "tuesday", true],
  ["6:00pm", "tuesday", false], // closing minute is NOT open
  ["9:00am", "monday", true],
  ["8:59am", "monday", false]
] as const) {
  ok(
    mayStateTokenAsWorkable(token, HOURS, dayKey) === statable,
    `${dayKey} "${token}" should be ${statable ? "statable" : "refused"}`
  );
}

// Sunday is absent from the config entirely => UNKNOWN, not closed. The closed-day copy is a
// separate, already-working path; this guard must not start asserting "we're closed" on its own.
ok(
  mayStateTokenAsWorkable("2:00pm", HOURS, "sunday") === true,
  "a day with NO entry is unknown, not closed — the guard must not invent a closure"
);
// But a day that EXISTS and carries no usable window IS closed.
ok(
  mayStateTokenAsWorkable("2:00pm", { ...HOURS, sunday: { open: null, close: null } }, "sunday") === false,
  "a day present in the config with no open window must refuse"
);

// ---------------------------------------------------------------------------
// 3. FAIL-OPEN. Every one of these must state the time — the guard is a veto on the impossible,
//    never a source of silence.
// ---------------------------------------------------------------------------
for (const [token, hours, dayKey, why] of [
  ["1:30", HOURS, null, "AMBIGUOUS: bare 1:30 could be 1:30 PM, which the parsers now resolve"],
  ["1:30", HOURS, "tuesday", "ambiguous even with a day"],
  ["12:00", HOURS, null, "ambiguous noon/midnight"],
  ["", HOURS, null, "empty token"],
  [null, HOURS, null, "null token"],
  ["banana", HOURS, null, "unparseable"],
  ["25:00", HOURS, null, "impossible clock value is not our call"],
  ["8:00pm", null, null, "NO hours config at all must never mute the agent"],
  ["8:00pm", {}, null, "empty hours config"],
  ["8:00pm", { monday: { open: null, close: null } }, null, "config with no usable window anywhere"],
  ["8:00pm", { monday: { open: "bad", close: "worse" } }, null, "unreadable hours"],
  ["8:00pm", { monday: { open: "18:00", close: "09:00" } }, null, "inverted window is not usable"]
] as const) {
  ok(
    mayStateTokenAsWorkable(token as any, hours as any, dayKey) === true,
    `fail-open: ${why}`
  );
}

// The ambiguity rule is the subtle one — pin the parse directly.
ok(parseTimeTokenToClock("1:30") === null, "a bare 1:30 must be reported ambiguous, never guessed as 01:30");
ok(parseTimeTokenToClock("8:00pm")?.hour24 === 20, "8:00pm is 20:00");
ok(parseTimeTokenToClock("12:00am")?.hour24 === 0, "12:00am is midnight");
ok(parseTimeTokenToClock("12:00pm")?.hour24 === 12, "12:00pm is noon");
ok(parseTimeTokenToClock("13:30")?.hour24 === 13, "an unambiguous 24h value is judged");
ok(parseTimeTokenToClock("9am")?.hour24 === 9, "bare hour with meridiem");

// ---------------------------------------------------------------------------
// 4. THE REPLY. The whole point is what the customer reads.
// ---------------------------------------------------------------------------
{
  const preferred = "Got it — 8:00 PM can work. Which day were you thinking?";
  const swapped = statableTimeReply("8:00pm", HOURS, null, preferred);
  ok(swapped !== preferred, "an off-hours time must not be echoed back as workable");
  ok(!/8:00 PM/.test(swapped), "the impossible time must not survive into the reply");
  ok(/9:00 AM/.test(swapped) && /6:00 PM/.test(swapped), "the replacement must name the real hours");
  ok(/\?$/.test(swapped.trim()), "the replacement must still ask, so the turn keeps moving");

  const kept = statableTimeReply("2:00pm", HOURS, null, "Got it — 2:00 PM can work. Which day were you thinking?");
  ok(/2:00 PM/.test(kept), "an in-hours time must pass through untouched");

  // Fail-open at the reply layer too.
  ok(
    statableTimeReply("1:30", HOURS, null, preferred) === preferred,
    "an ambiguous token must leave the reply alone"
  );
  ok(
    statableTimeReply("8:00pm", null, null, preferred) === preferred,
    "no hours config must leave the reply alone"
  );
}

// ---------------------------------------------------------------------------
// 5. THE MOVED FORMATTER. `formatBusinessHoursForReply` came out of index.ts with the guard; it is
//    customer-facing copy, so pin that the move did not change a character of it.
// ---------------------------------------------------------------------------
{
  const line = formatBusinessHoursForReply(HOURS, "us");
  ok(
    line === "Mon–Fri 9:00 AM–6:00 PM, Sat 9:00 AM–3:00 PM",
    `hours line changed in the move: ${JSON.stringify(line)}`
  );
  ok(formatBusinessHoursForReply(null, "us") === null, "no hours => no line");
  ok(formatBusinessHoursForReply({}, "us") === null, "empty hours => no line");
  const line24 = formatBusinessHoursForReply(HOURS, "gb");
  ok(
    !!line24 && line24.includes("09:00") && !line24.includes("AM"),
    `non-US must stay 24-hour: ${JSON.stringify(line24)}`
  );
}

// ---------------------------------------------------------------------------
// 6. widestOpenWindow — what the replacement copy is built from.
// ---------------------------------------------------------------------------
{
  const w = widestOpenWindow(HOURS);
  ok(w?.open === 9 * 60 && w?.close === 18 * 60, "widest window spans the earliest open to the latest close");
  ok(widestOpenWindow({}) === null, "no usable hours => no window");
  ok(widestOpenWindow(null) === null, "null hours => no window");
}

// ---------------------------------------------------------------------------
// 7. The low-level predicate's own edges.
// ---------------------------------------------------------------------------
ok(mayStateTimeAsWorkable({ hour24: null, businessHours: HOURS }) === true, "null hour is not judged");
ok(mayStateTimeAsWorkable({ hour24: 20, businessHours: HOURS }) === false, "20:00 is shut everywhere");
ok(mayStateTimeAsWorkable({ hour24: 14, businessHours: HOURS }) === true, "14:00 is open");
ok(
  mayStateTimeAsWorkable({ hour24: 14, minute: 30, businessHours: HOURS, dayKey: "SATURDAY" }) === true,
  "day keys must be case-insensitive"
);

console.log(`off_hours_time_guard:eval OK (${checks} checks)`);
