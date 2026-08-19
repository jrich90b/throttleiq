/**
 * A STORED appointment request keeps the day it was made on — deterministic half.
 *
 * Production fixture: Paul Harrigan +17169467451, 2026-08-17, operator-reported as "This did not
 * seem to book an appointment at 11 today".
 *
 *   12:49Z customer: "I'm off today... can I come out this morning to test ride the 2021 again"
 *   13:55Z rep:      "Hey Paul, what time are you thinking?"
 *   13:56Z customer: "would 11 o'clock be OK?"
 *   13:56Z we mint   `Appointment requested. Requested: 11 o'clock.`
 *   13:58Z rep:      "Ya 11 will work, see you then"   -> nothing booked
 *
 * `parseRequestedDayTime("11 o'clock")` returns null without a day token, so the staff confirm had
 * nothing to resolve. The customer HAD settled the day, two turns earlier.
 *
 * TWO halves, and this file pins the deterministic one:
 *  1. COMPREHENSION — the booking-intent parser carries a day the recent messages already settle.
 *     LLM-backed; its prompt rule and few-shots are asserted here so they cannot be deleted, and
 *     the behaviour itself is graded by booking_intent_day_from_context:eval.
 *  2. INVARIANT — a relative day inside a phrase we STORED counts from when the customer said it,
 *     not from whenever a staff member gets round to confirming. Executed below.
 *
 * Measured on the live store 2026-08-19 (75 "Appointment requested." todos, 54 carrying a phrase):
 *  - 30 phrases do not resolve at all; 9 of those are a bare clock time with the day in the thread.
 *  - 11 phrases carry a relative day word, and one (+17165233086) had been open FIVE DAYS — read
 *    against the wall clock, its "tomorrow" means five days after the customer meant it.
 *
 * FAIL DIRECTION. Both halves fail toward NO booking, which is where this path already failed:
 * a day nobody settled stays empty and unresolvable, and a stale "today" resolves into the PAST
 * where `contextDayResolvedInThePast` refuses it. Nothing here can invent a wrong-day booking.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const { parseRequestedDayTime, readPendingAppointmentRequestPhrase, findPendingAppointmentRequestTodo } =
  await import("../services/api/src/domain/conversationStore.ts");
const { localPartsToUtcDate } = await import("../services/api/src/domain/schedulerEngine.ts");
const { BOOKING_INTENT_EXAMPLES, BOOKING_INTENT_PROMPT_RULES } = await import(
  "../services/api/src/domain/bookingIntentParser.ts"
);

const TZ = "America/New_York";

// ------------------------------------------------------------------ the phrase reader, executed
assert.equal(
  readPendingAppointmentRequestPhrase("Appointment requested. Requested: 11 o'clock."),
  "11 o'clock",
  "the stored phrase comes back out of the summary we composed"
);
assert.equal(
  readPendingAppointmentRequestPhrase("Appointment requested. Requested time: Aug 21, 9:00 AM."),
  "Aug 21, 9:00 AM",
  "the 'Requested time:' spelling reads the same"
);
assert.equal(
  readPendingAppointmentRequestPhrase("Appointment requested."),
  "",
  "a label with no phrase yields nothing to book, not a guess"
);
assert.equal(readPendingAppointmentRequestPhrase(undefined), "");

// ----------------------------------------------------- INVARIANT: a stored relative day is fixed
// +17165233086, William Higgins: minted 2026-08-14, still open. "tomorrow" means 8/15 forever.
const staleCapture = "2026-05-15T19:23:29.749Z"; // +17168701333, "tomorrow noonish"
const atCapture = parseRequestedDayTime("tomorrow noonish", TZ, staleCapture);
assert.ok(atCapture, "a relative day resolves against the instant it was captured");
assert.equal(atCapture!.month, 5);
assert.equal(atCapture!.day, 16, "'tomorrow' said on 5/15 is 5/16, however long the todo sits open");
assert.equal(atCapture!.hour24, 12);

// The same phrase read at a much later moment must NOT drift to that moment's tomorrow.
const drifted = parseRequestedDayTime("tomorrow noonish", TZ, "2026-08-19T14:00:00.000Z");
assert.ok(drifted);
assert.equal(
  `${drifted!.month}-${drifted!.day}`,
  "8-20",
  "sanity: without the capture instant the same phrase means a different day — which is the bug"
);
assert.notDeepEqual(
  { m: atCapture!.month, d: atCapture!.day },
  { m: drifted!.month, d: drifted!.day },
  "the capture instant must actually change the answer, or this parameter is inert"
);

// Defaulting is preserved: no reference, and an unparseable one, both mean "now".
const noRef = parseRequestedDayTime("tomorrow noonish", TZ);
const badRef = parseRequestedDayTime("tomorrow noonish", TZ, "not-a-date");
assert.deepEqual(badRef, noRef, "an unreadable reference falls back to now rather than throwing");
assert.deepEqual(parseRequestedDayTime("tomorrow noonish", TZ, null), noRef);

// A phrase with an EXPLICIT date is unaffected by the reference — nothing relative to rebase.
assert.deepEqual(
  parseRequestedDayTime("may 11 at 9am", TZ, staleCapture),
  parseRequestedDayTime("may 11 at 9am", TZ, "2026-08-19T14:00:00.000Z"),
  "an explicit date means the same day whenever it is read"
);

// ------------------------------------------- the nine live bare-clock requests, all day-less today
// Every one of these resolves to NOTHING as shipped: no day token, so no booking, in silence.
const liveBareClockRequests: { phrase: string; capturedAt: string }[] = [
  { phrase: "9", capturedAt: "2026-04-15T12:24:22.572Z" },
  { phrase: "by 3:45", capturedAt: "2026-04-27T16:00:21.145Z" },
  { phrase: "around 4", capturedAt: "2026-05-18T18:50:34.066Z" },
  { phrase: "9:00 AM", capturedAt: "2026-05-21T03:05:49.396Z" }, // said at 11:05pm local
  { phrase: "beginning at 4:30pm", capturedAt: "2026-05-28T16:55:59.349Z" },
  { phrase: "10:45", capturedAt: "2026-06-12T13:12:27.625Z" },
  { phrase: "around 3 ish", capturedAt: "2026-07-22T18:22:24.318Z" },
  { phrase: "11 o'clock", capturedAt: "2026-08-17T13:56:40.137Z" }, // Paul Harrigan
  { phrase: "around 4:30", capturedAt: "2026-08-19T14:06:19.784Z" }
];
for (const row of liveBareClockRequests) {
  assert.equal(
    parseRequestedDayTime(row.phrase.toLowerCase(), TZ, row.capturedAt),
    null,
    `a bare clock time must stay unbookable on its own: ${row.phrase}`
  );
}

// With the day the parser now carries from the thread, they resolve — and the past-slot invariant
// still refuses the one the customer plainly did not mean for that day.
let resolvedAhead = 0;
let refusedAsPast = 0;
for (const row of liveBareClockRequests) {
  const resolved = parseRequestedDayTime(`today ${row.phrase}`.toLowerCase(), TZ, row.capturedAt);
  assert.ok(resolved, `with the thread's day, "${row.phrase}" must resolve`);
  const slotUtc = localPartsToUtcDate(TZ, resolved!).getTime();
  if (slotUtc < new Date(row.capturedAt).getTime()) refusedAsPast++;
  else resolvedAhead++;
}
assert.equal(
  resolvedAhead,
  8,
  `8 of the 9 live bare-clock requests must land AHEAD of the moment they were said, got ${resolvedAhead}`
);
assert.equal(
  refusedAsPast,
  1,
  "and exactly one — '9:00 AM' said at 11:05pm — must land in the past, where the guard refuses it"
);

// Paul's own turn, named.
const paul = parseRequestedDayTime("today 11 o'clock", TZ, "2026-08-17T13:56:40.137Z");
assert.ok(paul, "Paul Harrigan's request must resolve once the thread's day is carried");
assert.equal(`${paul!.month}/${paul!.day} ${paul!.hour24}:00`, "8/17 11:00");

// ------------------------------------------------------------------- the prompt still says it
const rules = BOOKING_INTENT_PROMPT_RULES.join("\n");
assert.ok(
  rules.includes("already settle which day"),
  "the day-from-context rule must stay in the booking-intent prompt"
);
assert.ok(
  rules.includes("leave requested.day empty rather than guessing"),
  "the bounded half — never guess a day nobody named — must stay in the prompt"
);
const contextExamples = BOOKING_INTENT_EXAMPLES.filter(ex => ex.includes("Recent messages"));
assert.ok(
  contextExamples.length >= 3,
  `the prompt must keep its day-from-context few-shots, found ${contextExamples.length}`
);
assert.ok(
  contextExamples.filter(ex => ex.includes('"day":"today"')).length >= 2,
  "two few-shots must show the day being carried from the thread"
);
assert.ok(
  contextExamples.some(ex => ex.includes('"day":""')),
  "and one must show a bare time with NO settled day staying day-less"
);

// ------------------------------------------------------------------------------- still WIRED
// SKILL trap 2: a correct fix sitting in an unimported module is inert.
const llmDraftSource = await fs.readFile(path.resolve("services/api/src/domain/llmDraft.ts"), "utf8");
assert.ok(
  llmDraftSource.includes("...BOOKING_INTENT_PROMPT_RULES"),
  "the booking-intent prompt must spread the shared rules"
);
assert.ok(
  llmDraftSource.includes("...BOOKING_INTENT_EXAMPLES"),
  "the booking-intent prompt must spread the shared few-shots"
);
// The booking-intent prompt block itself must hold no inline few-shot array — a second copy beside
// the shared one is how the manual-outbound parser's composer silently drifted before #676.
const bookingPromptBlock = llmDraftSource.slice(
  llmDraftSource.indexOf('"You are a scheduling parser for dealership SMS."'),
  llmDraftSource.indexOf('schemaName: "booking_intent_parser"')
);
assert.ok(bookingPromptBlock.length > 0, "the booking-intent prompt block must still be findable");
assert.ok(
  !bookingPromptBlock.includes("const voiceExamples = ["),
  "the old inline few-shot copy must not come back beside the shared one"
);

const indexSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
assert.ok(
  indexSource.includes(
    "parseRequestedDayTime(pendingAppointmentRequestText, schedulerTimezone, pendingAppointmentRequestTodo?.createdAt)"
  ),
  "the pending-request phrase must be resolved against the todo's OWN createdAt, not the wall clock"
);
assert.ok(
  indexSource.includes("findPendingAppointmentRequestTodo(conv.id)"),
  "the staff-send path must find the pending request through the shared selector"
);
assert.ok(
  indexSource.includes("const contextDayResolvedInThePast ="),
  "the past-slot invariant guard must stay in the staff-send path"
);
assert.ok(
  indexSource.includes("!contextDayResolvedInThePast"),
  "the past-slot guard must still gate shouldInferManualAppointment"
);
assert.equal(
  typeof findPendingAppointmentRequestTodo,
  "function",
  "the selector must be exported and callable, not just referenced by name"
);
assert.equal(
  findPendingAppointmentRequestTodo("no-such-conversation"),
  undefined,
  "and it must EXECUTE — an empty store yields no pending request"
);

console.log("pending_appointment_request_day: all checks passed.");
