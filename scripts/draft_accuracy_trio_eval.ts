/**
 * Draft-accuracy trio — three production misses your staff hand-corrected before sending.
 * All three are "the draft asserts something that isn't true", not comprehension bugs.
 *
 *  1. WALK-IN RECAP claimed the visit was "today". The lead carries no visit date (only when the rep
 *     LOGGED the note), and reps log late — Larry Godzich (#11695) + Mike Zimmerman (#11697) were both
 *     logged Mon 2026-07-27 for a Saturday visit, and Scott rewrote "stopping in today" →
 *     "chatting on SAturday". Copy is now day-neutral.
 *  2. CREDIT-APP ACK promised finance would reach out "shortly" after close. christopher killian
 *     (#11649) + Roger McCleskey (#11650) both landed ~4:45pm Saturday (3pm close) and staff deleted
 *     "shortly" from both, 22s apart; David Boos (#11687) landed 11:21pm Friday and Joe rewrote it to
 *     "tomorrow when the dealership opens". Now resolved from the dealer's real hours — and because
 *     American H-D is CLOSED SUNDAY, a naive "tomorrow" would be its own bug.
 *  3. DOUBLE SELF-INTRO. Jason Marshall (+17165230421, 2026-07-29) opened "it's Alexandra over at
 *     American H-D" then added "I'm Alexandra, nice to meet you". The existing dedupe only knows the
 *     old "this is {agent} at {dealer}" form.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "eval-no-live-key";

const {
  buildStaffFollowUpTimingPhrase,
  isDealershipOpenAt,
  nextOpenDayOffset,
  localClockParts
} = await import("../services/api/src/domain/staffFollowUpTiming.ts");
const { normalizeSalesToneBase } = await import("../services/api/src/domain/tone.ts");

// American H-D's real configured hours: Mon-Fri 9-6, Sat 9-3, NO Sunday.
const AH_HOURS = {
  monday: { open: "09:00", close: "18:00" },
  tuesday: { open: "09:00", close: "18:00" },
  wednesday: { open: "09:00", close: "18:00" },
  thursday: { open: "09:00", close: "18:00" },
  friday: { open: "09:00", close: "18:00" },
  saturday: { open: "09:00", close: "15:00" }
} as const;

const SUN = 0, MON = 1, FRI = 5, SAT = 6;
const at = (h: number, m = 0) => h * 60 + m;
const phrase = (dayIndex: number, minutes: number, hours: any = AH_HOURS) =>
  buildStaffFollowUpTimingPhrase({ hours, dayIndex, minutesSinceMidnight: minutes });

// ---- (1) open hours keep "shortly" — the guard against over-correcting into permanent hedging.
assert.equal(phrase(MON, at(10)), "shortly", "Monday 10am (open) still promises shortly");
assert.equal(phrase(SAT, at(11)), "shortly", "Saturday 11am (open) still promises shortly");
assert.equal(phrase(MON, at(8)), "shortly", "before open, but we open LATER TODAY — still same-day");
assert.equal(
  phrase(MON, at(17, 59)),
  "shortly",
  "one minute before close is still open — no premature hedge"
);

// ---- (2) the reproduced production misses.
assert.equal(
  phrase(SAT, at(16, 45)),
  "when we open Monday",
  "christopher/Roger: ~4:45pm SATURDAY is past the 3pm close, and Sunday is CLOSED — never 'tomorrow'"
);
assert.equal(
  phrase(SAT, at(19, 42)),
  "when we open Monday",
  "the 7:42pm Saturday send staff stripped 'shortly' from"
);
assert.equal(
  phrase(FRI, at(23, 21)),
  "when we open tomorrow",
  "David Boos: 11:21pm Friday → Saturday IS an open day, so 'tomorrow' is correct here"
);
assert.equal(phrase(SUN, at(12)), "when we open tomorrow", "Sunday (closed all day) → Monday is tomorrow");
assert.equal(phrase(MON, at(22)), "when we open tomorrow", "Monday night → Tuesday");

// ---- (3) fail-safe: unknown/blank hours keep today's wording rather than invent a schedule.
assert.equal(phrase(SAT, at(20), {}), "shortly", "no configured hours → fail safe to the status quo");
assert.equal(phrase(SAT, at(20), null), "shortly", "null hours → fail safe");
assert.equal(
  phrase(SAT, at(20), { saturday: { open: "bogus", close: "??" } }),
  "shortly",
  "unparseable hours → fail safe, never a guessed day"
);

// ---- helpers behave.
assert.equal(isDealershipOpenAt({ hours: AH_HOURS, dayIndex: SUN, minutesSinceMidnight: at(12) }), false);
assert.equal(isDealershipOpenAt({ hours: AH_HOURS, dayIndex: SAT, minutesSinceMidnight: at(14) }), true);
assert.equal(nextOpenDayOffset({ hours: AH_HOURS, dayIndex: SAT, minutesSinceMidnight: at(20) }), 2, "Sat night → Mon");
const parts = localClockParts(new Date("2026-07-18T20:45:00.000Z"), "America/New_York");
assert.equal(parts.dayIndex, SAT, "2026-07-18 16:45 ET is a Saturday");
assert.equal(parts.minutesSinceMidnight, at(16, 45), "UTC→ET conversion lands at 4:45pm");

// ---- (4) walk-in recap never claims a day.
const sendgridSource = await fs.readFile(path.resolve("services/api/src/routes/sendgridInbound.ts"), "utf8");
const tailFn = sendgridSource.match(
  /function buildTrafficLogProWalkInTail\(args: \{[\s\S]*?\n\}\n\nfunction walkInTailHasOwnAcknowledgement/
)?.[0];
assert.ok(tailFn, "found the walk-in recap tail builder");
for (const claim of ["stopping in today", "coming in today", "your time today", "sitting down with me today"]) {
  assert.ok(
    !tailFn!.includes(claim),
    `walk-in recap must not assert WHEN the visit happened (found "${claim}") — the lead has no visit date`
  );
}
assert.ok(tailFn!.includes("Thanks for stopping in -"), "day-neutral walk-in wording is in place");

// ---- (5) both paths resolve the timing phrase (live ADF intake + regenerate), so they can't drift.
const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
for (const [label, src] of [["live ADF intake", sendgridSource], ["regenerate", apiSource]] as const) {
  assert.match(
    src,
    /resolveStaffFollowUpTimingPhrase\(\)/,
    `${label} must resolve the finance follow-up timing from real hours`
  );
}
for (const [label, src] of [["live ADF intake", sendgridSource], ["regenerate", apiSource]] as const) {
  const acks = (src.match(/finance team (?:will )?reach out shortly/g) ?? []).length;
  assert.equal(acks, 0, `${label} must not hardcode "reach out shortly" on a credit-app ack`);
}

// ---- (6) the double self-intro is stripped; the content after it survives.
const jason =
  "Hey Jason, it's Alexandra over at American H-D. Gotcha — I'll have our sales team check the " +
  "build timeline and when we can expect it to arrive. I'm Alexandra, nice to meet you, I'll " +
  "confirm details and text you back as soon as they land.";
const jasonOut = normalizeSalesToneBase(jason);
assert.equal(
  (jasonOut.match(/Alexandra/g) ?? []).length,
  1,
  "the agent introduces itself exactly once"
);
assert.ok(!/nice to meet you/i.test(jasonOut), "the tacked-on pleasantry goes with the repeat intro");
assert.ok(
  /confirm details and text you back/.test(jasonOut),
  "REAL CONTENT after the repeat intro must survive (never delete to end-of-sentence)"
);
assert.ok(jasonOut.startsWith("Hey Jason, it's Alexandra over at American H-D."), "the FIRST intro is kept intact");

// The old form still dedupes, and a single intro is untouched.
assert.equal(
  (normalizeSalesToneBase(
    "Hi Larry — this is Scott at American Harley-Davidson. Thanks for stopping in. This is Scott at American Harley-Davidson."
  ).match(/[Tt]his is Scott/g) ?? []).length,
  1,
  "the pre-existing this-is-{agent}-at-{dealer} dedupe still works"
);
const single = "Hey Mark, it's Alexandra over at American Harley. Harley doesn't make the Fat Bob new anymore.";
assert.equal(normalizeSalesToneBase(single), single, "a single intro is left exactly as-is");

// Over-correction guards: don't eat ordinary sentences that merely start with it's/I'm.
for (const safe of [
  "It's a great bike and I'm happy to help — it's still in stock.",
  "Hey Dana, it's Alexandra over at American H-D. It's the last one on the floor.",
  "Hey Sam, it's Alexandra over at American H-D. It's Scott you'll be meeting for the test ride."
]) {
  assert.equal(normalizeSalesToneBase(safe), safe, `must not rewrite: ${safe}`);
}

console.log("PASS draft accuracy trio — walk-in day claim, after-hours finance timing, double self-intro");
