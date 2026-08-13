/**
 * THE HOURS ANSWER NAMES THE DAY THE CUSTOMER NAMED (2026-08-09, +17167857284).
 *
 * Ulises is an enrolled Riding Academy student. On Saturday 2026-08-08 at 20:59 he wrote:
 *
 *   "I tried calling American Harley Davidson but its the weekend and they close early today.
 *    I will make it a point to call at 9am on Monday when they open again, is that going to be
 *    too late, will I lose my seat."
 *
 * 100ms later — no LLM ran, this is a pre-parser branch — he was told:
 *
 *   "Our hours today are 9:00 AM-6:00 PM."
 *
 * The store's real hours: Saturday 09:00-15:00, Monday 09:00-18:00. So the branch looked up the
 * RIGHT day (Monday, 9-6) and printed the WRONG label, because the day was resolved by one
 * expression and the label by a second, independent one — `wantsToday` fired on "they close early
 * today", which was him describing why he COULDN'T call, not the day he was asking about. Net
 * effect on a Saturday: we asserted we were open until 6:00 PM when we shut at 3:00 PM.
 *
 * The fix removes the possibility rather than the symptom: `resolveRequestedDay` returns the day
 * AND its label from the same branch, so no caller can look one day up and print another. A named
 * weekday outranks a bare "today"/"tomorrow" — which is what the sibling weather branch in
 * index.ts already did correctly, and what the hours branch now matches.
 *
 * Part 3 pins the WIRING, because tsc cannot prove index.ts still asks the referee.
 *
 * Run: npx tsx scripts/business_hours_requested_day_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { resolveRequestedDay } = await import("../services/api/src/domain/inboundPipeline.ts");

let n = 0;
const ok = (cond: boolean, msg: string) => {
  assert.equal(cond, true, msg);
  n++;
};

// The store's real business hours, read from the live scheduler config on 2026-08-09.
// These are what make the miss customer-visible: Saturday and Monday close three hours apart.
const HOURS: Record<string, { open: string; close: string }> = {
  monday: { open: "09:00", close: "18:00" },
  tuesday: { open: "09:00", close: "18:00" },
  wednesday: { open: "09:00", close: "18:00" },
  thursday: { open: "09:00", close: "18:00" },
  friday: { open: "09:00", close: "18:00" },
  saturday: { open: "09:00", close: "15:00" }
  // no sunday key — the dealership is closed
};

// ---------------------------------------------------------------------------
// PART 1 — the turn that shipped the wrong day
// ---------------------------------------------------------------------------

// Ulises's message, verbatim from the store (including the stray line break).
const ULISES =
  "Hi Alexandra, I tried calling American  Harley Davidson  but its the weekend and \nthey close early today. I will make it a point to call at 9am on Monday when they open again, is that going to be too late, will I lose my seat. Please let me know, thanks";

const ulises = resolveRequestedDay({
  text: ULISES,
  todayKey: "saturday",
  tomorrowKey: "sunday"
});

ok(ulises.day === "monday", `he asked about Monday, resolved ${ulises.day}`);
// THE REGRESSION. Before the fix this read "today" while `day` read "monday".
ok(ulises.label === "Monday", `the reply must call it Monday, called it ${ulises.label}`);
ok(ulises.source === "named_day", `named-day turn resolved as ${ulises.source}`);

// The day we look up and the day we print are the same day. This is the whole invariant, and it
// is asserted on the resolution rather than on a spelling, so any future phrasing still passes.
ok(
  ulises.label!.toLowerCase() === ulises.day,
  `label ${ulises.label} does not name the day looked up (${ulises.day})`
);

// Compose the sentence the way index.ts does and check what the customer actually reads.
const closeOf = (day: string) => HOURS[day]?.close ?? null;
ok(closeOf(ulises.day!) === "18:00", "Monday closes at 6:00 PM");
ok(closeOf("saturday") === "15:00", "Saturday closes at 3:00 PM — the wrong answer he got");
const sentence = `Our hours ${ulises.dayPhrase} are 9:00 AM–6:00 PM.`;
ok(
  sentence === "Our hours on Monday are 9:00 AM–6:00 PM.",
  `assembled sentence was ${JSON.stringify(sentence)}`
);
// The delivered sentence, pinned as the thing that must never come back.
ok(!sentence.includes("today"), "the 6:00 PM window must not be labelled today on a Saturday");

// ---------------------------------------------------------------------------
// PART 2 — the cases that were already right stay right
// ---------------------------------------------------------------------------

// A bare "today" still means today.
const today = resolveRequestedDay({
  text: "what time do you close today?",
  todayKey: "saturday",
  tomorrowKey: "sunday"
});
ok(today.day === "saturday", `bare today resolved ${today.day}`);
ok(today.label === "today" && today.dayPhrase === "today", "bare today is still called today");
ok(today.namedDay === null, "no weekday was named");

// "tonight" is a same-day ask.
const tonight = resolveRequestedDay({
  text: "are you still open tonight",
  todayKey: "friday",
  tomorrowKey: "saturday"
});
ok(tonight.day === "friday" && tonight.label === "today", `tonight resolved ${tonight.day}`);

// "tomorrow" still means tomorrow, and lands on a day we are CLOSED — the fail-safe direction:
// we say we're closed rather than quoting some other day's window.
const tomorrow = resolveRequestedDay({
  text: "are you open tomorrow?",
  todayKey: "saturday",
  tomorrowKey: "sunday"
});
ok(tomorrow.day === "sunday" && tomorrow.label === "tomorrow", `tomorrow resolved ${tomorrow.day}`);
ok(HOURS[tomorrow.day!] === undefined, "Sunday has no hours, so the reply is the closed line");

// A turn naming no day at all resolves to nothing, so the caller falls back to the week line
// instead of asserting a window. Fail direction: vague beats wrong.
const none = resolveRequestedDay({
  text: "hey, are you guys open?",
  todayKey: "saturday",
  tomorrowKey: "sunday"
});
ok(none.day === null && none.label === null && none.source === "none", "no day named ⇒ no day");

// Abbreviations and plurals still resolve.
for (const [text, expected] of [
  ["can I swing by weds afternoon", null], // "weds" is not in the map — must not half-match
  ["I'll come by Tues", "tuesday"],
  ["are you open Sundays", "sunday"],
  ["I'll be there thurs", "thursday"]
] as const) {
  const r = resolveRequestedDay({ text, todayKey: "saturday", tomorrowKey: "sunday" });
  ok(r.namedDay === expected, `${JSON.stringify(text)} → ${r.namedDay}, expected ${expected}`);
}

// The mixed shape that caused the miss, generalised: a named day beats an incidental today/tomorrow
// ANYWHERE in the turn, whichever order they appear in.
for (const text of [
  "you close early today — I'll come Tuesday instead",
  "I'll come Tuesday instead, you close early today",
  "tomorrow is no good, how about Tuesday"
]) {
  const r = resolveRequestedDay({ text, todayKey: "saturday", tomorrowKey: "sunday" });
  ok(r.day === "tuesday", `${JSON.stringify(text)} resolved ${r.day}, expected tuesday`);
  ok(r.label === "Tuesday", `${JSON.stringify(text)} labelled ${r.label}`);
}

// SIBLING PARITY: the weather branch consumes `namedDay` and handles today/tomorrow itself, so
// `namedDay` must stay null for those — otherwise this change silently moves weather too.
ok(today.namedDay === null && tomorrow.namedDay === null, "namedDay is only ever an explicit day");

// ---------------------------------------------------------------------------
// PART 3 — the wiring (tsc cannot prove index.ts still asks the referee)
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const indexSrc = fs.readFileSync(path.join(here, "../services/api/src/index.ts"), "utf8");

// The private copy that could drift is gone: one resolver, not two.
ok(
  !indexSrc.includes("function extractDayRequest"),
  "index.ts still defines its own day extractor — the two-resolver drift can come back"
);
ok(
  indexSrc.includes("resolveRequestedDay"),
  "index.ts no longer asks the referee for the requested day"
);
// 2026-08-13: the hours reply COMPOSITION moved to domain/businessHoursGuard.ts, beside the
// invariant that guards its appointment tail (index.ts was on its size ceiling). This assertion's
// premise is untouched — one resolution feeds both the lookup and the label — so it follows the
// code to its new home rather than being deleted. index.ts must still hand the whole resolution
// over, which the next assertion pins; a caller passing a bare day string could reintroduce the
// split this eval exists to prevent.
const guardSrc = fs.readFileSync(
  path.join(here, "../services/api/src/domain/businessHoursGuard.ts"),
  "utf8"
);
ok(
  guardSrc.includes("Our hours ${dayPhrase} are"),
  "the hours line no longer prints the phrase that came with the day it looked up"
);
ok(
  indexSrc.includes("requestedDay: resolveRequestedDayForText"),
  "index.ts no longer hands the whole day resolution to the reply builder"
);
// The old in-handler composition must not come back alongside the shared one.
ok(
  !indexSrc.includes("Our hours ${requestedDay.dayPhrase} are"),
  "index.ts is composing the hours line again — one builder, or the two can drift apart"
);

console.log(`business_hours_requested_day:eval OK (${n} assertions)`);
