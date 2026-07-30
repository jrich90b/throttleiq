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

// ---- (2b) SERVICE ADFs get the same hours-aware promise as FINANCE ones (Joe, 2026-07-30).
// Robert Spencer's service ADF (#11708) is stamped 2026-07-30T00:53Z, which is 20:53 WEDNESDAY in
// America/New_York — after the 6pm close, not the small hours (the UTC stamp reads misleadingly).
// The draft still promised service would reach out "shortly". The guard existed and was wired only
// into the finance lane. Thursday is an open day, so the honest phrase is "when we open tomorrow".
{
  const WED = 3;
  const robertLocal = localClockParts(new Date("2026-07-30T00:53:24.510Z"), "America/New_York");
  assert.equal(robertLocal.dayIndex, WED, "the #11708 stamp is Wednesday evening in dealer time, not Thursday");
  assert.equal(
    phrase(robertLocal.dayIndex, robertLocal.minutesSinceMidnight),
    "when we open tomorrow",
    "#11708: 8:53pm Wednesday is past the 6pm close — never 'shortly'"
  );
  assert.equal(phrase(SAT, at(23, 30)), "when we open Monday", "a service ADF at 11:30pm Saturday must not say shortly");
  assert.equal(phrase(SUN, at(2, 15)), "when we open tomorrow", "a 2:15am Sunday service ADF points at Monday");
  // Still open later today => "shortly" remains correct and must NOT be over-corrected into hedging.
  assert.equal(phrase(WED, at(8, 30)), "shortly", "8:30am Wednesday: we open at 9 the same day");

  const sendgridSrc = await fs.readFile(path.join(process.cwd(), "services/api/src/routes/sendgridInbound.ts"), "utf8");
  assert.match(
    sendgridSrc,
    /service department reach out \$\{serviceFollowUpWhen\}/,
    "the service ADF ack must interpolate the hours-aware phrase, not hardcode 'shortly'"
  );
  assert.ok(
    !/service department reach out shortly/.test(sendgridSrc),
    "the hardcoded 'reach out shortly' service promise must be gone"
  );

  // The de-duped service fallback (index.ts) is the other place that promised "shortly", and it is
  // reached from BOTH reply paths — so both callers must supply the phrase or it silently reverts.
  const indexSrc = await fs.readFile(path.join(process.cwd(), "services/api/src/index.ts"), "utf8");
  assert.match(
    indexSrc,
    /in touch \$\{String\(opts\?\.followUpWhen/,
    "the de-duped service fallback must use the caller-supplied phrase"
  );
  assert.equal(
    (indexSrc.match(/followUpWhen: await resolveStaffFollowUpTimingPhrase\(\)/g) ?? []).length,
    2,
    "both applyServicePolicy call sites (live twilio + regenerate) must pass the phrase — two-path parity"
  );
}

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

// ---- (4) businessMinutesBetween — draft staleness measured in OPEN time (Joe ruling 2026-07-30).
//      Wall-clock made the stale-draft P1 permanently unclearable in suggest mode: anything that
//      lands overnight reads 8h+ "waiting" by the morning audit, however fast staff actually are.
{
  const { businessMinutesBetween } = await import("../services/api/src/domain/staffFollowUpTiming.ts");
  // Mon-Fri 9-5, Sat 9-3, closed Sunday. UTC so the fixtures are unambiguous.
  const HOURS = {
    monday: { open: "09:00", close: "17:00" },
    tuesday: { open: "09:00", close: "17:00" },
    wednesday: { open: "09:00", close: "17:00" },
    thursday: { open: "09:00", close: "17:00" },
    friday: { open: "09:00", close: "17:00" },
    saturday: { open: "09:00", close: "15:00" },
    sunday: { open: null, close: null }
  } as any;
  const bm = (fromIso: string, toIso: string, hours: any = HOURS) =>
    businessMinutesBetween({ hours, timeZone: "UTC", fromMs: Date.parse(fromIso), toMs: Date.parse(toIso) });

  // The production case: Robert Spencer's service ADF landed 00:53 Thu, audit ran 08:15 Thu.
  // Wall-clock says 442 minutes "stale"; the dealership had not opened yet.
  assert.equal(bm("2026-07-30T00:53:00Z", "2026-07-30T08:15:00Z"), 0, "overnight wait is not staff being slow");
  assert.ok(
    (Date.parse("2026-07-30T08:15:00Z") - Date.parse("2026-07-30T00:53:00Z")) / 60000 > 30,
    "…even though wall-clock would have flagged it"
  );

  // Real lateness during open hours still counts, so the alarm keeps its teeth.
  assert.equal(bm("2026-07-30T09:00:00Z", "2026-07-30T10:00:00Z"), 60, "an hour of open time counts");
  assert.equal(bm("2026-07-30T08:00:00Z", "2026-07-30T09:31:00Z"), 31, "only the open portion counts");

  // Spans a closed Sunday: Fri 16:50-17:00 (10) + Sat 9-3 (360) + Sun (0) + Mon 9:00-9:10 (10).
  assert.equal(bm("2026-07-31T16:50:00Z", "2026-08-03T09:10:00Z"), 380, "weekend closure is excluded");

  // Degenerate + fail-safe behaviour.
  assert.equal(bm("2026-07-30T10:00:00Z", "2026-07-30T10:00:00Z"), 0, "zero-length span is zero");
  assert.equal(bm("2026-07-30T11:00:00Z", "2026-07-30T10:00:00Z"), 0, "reversed span never goes negative");
  assert.equal(bm("2026-07-30T09:00:00Z", "2026-07-30T10:00:00Z", {}), null, "unconfigured hours => null (caller falls back)");
  assert.equal(bm("2026-08-02T09:00:00Z", "2026-08-02T14:00:00Z"), 0, "a fully closed Sunday is zero, not null");

  // The audit must actually USE business minutes, and must fall back rather than go silent.
  const auditSrc = await fs.readFile(path.join(process.cwd(), "scripts/conversation_audit.ts"), "utf8");
  assert.match(auditSrc, /draftAgeBusinessMinutes/, "the stale-draft rule uses business minutes");
  assert.match(auditSrc, /return wallClockMinutes/, "unconfigured hours fall back to wall-clock, never to silence");
}

console.log("PASS draft accuracy trio — walk-in day claim, after-hours finance timing, double self-intro, business-hours draft staleness");
