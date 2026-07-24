/**
 * Staff-availability answer decision eval (Joe ruling 2026-07-23, Davey +17164255036).
 *
 * A customer asking "Will Stone be there Saturday?" must get a DIRECT answer, policy PRESUME
 * AVAILABLE: default "yes, <rep> will be here <day>". Only an EXPLICIT day-off block on the rep's
 * calendar flips it to not-in; an unresolvable rep or an unreadable calendar falls to a safe named
 * "let me check with <rep>" handoff. We NEVER guess a no and never invent an absence.
 *
 * `decideStaffAvailabilityAnswer` (routeStateReducer) is the PURE branching behind
 * buildStaffAvailabilityReply (index.ts). `staffDayOffFromSummaries` / `summaryIndicatesStaffDayOff`
 * is the day-off detector over the rep's calendar SUMMARIES (structured extraction of our own data).
 * Both are extracted so the fail-direction is unit-testable WITHOUT booting the server or hitting
 * Google Calendar.
 *
 * Run: npx tsx scripts/staff_availability_answer_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  decideStaffAvailabilityAnswer,
  staffDayOffFromSummaries,
  summaryIndicatesStaffDayOff
} from "../services/api/src/domain/routeStateReducer.ts";

let n = 0;
const dk = (
  over: Partial<{ repResolved: boolean; calendarReadable: boolean; dayOffBlock: boolean }>,
  expected: string,
  msg: string
) => {
  const base = { repResolved: true, calendarReadable: true, dayOffBlock: false };
  const out = decideStaffAvailabilityAnswer({ ...base, ...over });
  assert.equal(out.kind, expected, `${msg} (got ${out.kind})`);
  n++;
};

// --- PRESUME AVAILABLE: the default answer is "yes, he's in". ---
dk({}, "present", "rep resolved + calendar readable + no block => present (presume available)");

// --- Only an EXPLICIT day-off block flips to not-in. ---
dk({ dayOffBlock: true }, "day_off", "explicit day-off block => not-in");

// --- Never guess a no: unresolved rep or unreadable calendar => safe named check-with. ---
dk({ repResolved: false }, "check_with", "rep can't be resolved => check-with handoff (never a guessed no)");
dk({ calendarReadable: false }, "check_with", "calendar unreadable => check-with handoff (never a guessed no)");
dk({ repResolved: false, calendarReadable: false }, "check_with", "both unknown => check-with");
// A day-off flag CANNOT fire when we couldn't read the calendar — repResolved/readable gate first,
// so we never fabricate an absence from a stale/missing read.
dk({ calendarReadable: false, dayOffBlock: true }, "check_with", "no valid read => never day_off, always check-with");
dk({ repResolved: false, dayOffBlock: true }, "check_with", "unresolved rep => never day_off, always check-with");

// --- Day-off summary detector: matches unambiguous day-off phrasing only. ---
const offPhrases = [
  "Day off",
  "Stone - OFF",
  "OFF",
  "Vacation",
  "PTO",
  "Out of office",
  "OOO",
  "Personal day",
  "Sick",
  "Not in today",
  "Not working"
];
for (const p of offPhrases) {
  assert.equal(summaryIndicatesStaffDayOff(p), true, `"${p}" should read as a day-off block`);
  n++;
}

// --- Ordinary busy events / lookalike words are NOT day-off blocks (fail toward present). ---
const notOff = [
  "Test ride - Davey Cash",
  "Sales meeting",
  "Off-site sales event",
  "In the office",
  "Making an offer to a customer",
  "Freedom party setup",
  "",
  "  "
];
for (const p of notOff) {
  assert.equal(summaryIndicatesStaffDayOff(p), false, `"${p}" must NOT read as a day-off block`);
  n++;
}

// A day is a day-off if ANY event on it is a day-off block; a day of ordinary events is not.
assert.equal(
  staffDayOffFromSummaries(["Test ride - Davey", "Stone - Day off", "Lunch"]),
  true,
  "one day-off block among events => day off"
);
assert.equal(
  staffDayOffFromSummaries(["Test ride - Davey", "Sales meeting", "Lunch"]),
  false,
  "no day-off block among ordinary events => presumed working"
);
assert.equal(staffDayOffFromSummaries([]), false, "empty calendar day => presumed working (no block)");
n += 3;

// --- Source guard: index.ts routes the customer-ack action through the shared builder in BOTH
// paths and delegates to the pure decision (not an inline if-chain). ---
const api = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(
  api,
  /const decision = decideStaffAvailabilityAnswer\(\{/,
  "buildStaffAvailabilityReply delegates to the pure decision"
);
assert.match(
  api,
  /if \(action === "staff_availability_question"\) \{/g,
  "staff_availability_question is handled in the customer-ack routing"
);
// Both the live and regen paths call the shared builder (route parity).
assert.equal(
  (api.match(/await buildStaffAvailabilityReply\(\{/g) ?? []).length >= 2,
  true,
  "buildStaffAvailabilityReply is called in BOTH the live and regen paths"
);
n += 3;

// The route reducer maps the ack action to its own kind (Block A), keeping precedence centralized.
const reducer = fs.readFileSync("services/api/src/domain/routeStateReducer.ts", "utf8");
assert.match(
  reducer,
  /case "staff_availability_question":\s*\n\s*\/\/[\s\S]*?return \{ kind: "staff_availability_question", visitCommitment \};/,
  "decideSchedulingTurn Block A returns the staff_availability_question kind"
);
n++;

console.log(`PASS staff-availability answer decision eval (${n} assertions)`);
