/**
 * Appointment-status stale-past-day eval (2026-07-08).
 *
 * When a customer asks about their appointment status and the ONLY booked appointment on record is
 * for a calendar day that has already passed, the agent must NOT assert it as current ("I'm showing
 * your appointment for Fri, Jul 3, 1:00 PM" said on Jul 7). It must instead acknowledge the slot has
 * passed, offer to set up a new time, and hand the thread to staff (review todo + manual handoff).
 * Operator-reported 4× on +17167506588 (s R Gurajala): a Jul-3 appointment was parroted back days
 * later instead of rebooking, so the customer walked away thinking he was still set.
 *
 * The reply builder reads scheduler config + the todo store, so it can't run end-to-end in CI; this
 * pins (1) the centralized pure decision (isStaleBookedAppointmentDay) and (2) the shared-helper
 * wiring via source guards — the same approach the calendar-/IO-heavy scheduling evals use. The
 * reply builder is a single shared function called by BOTH the live and regen paths, so route-parity
 * is structural.
 *
 * Run: npx tsx scripts/appointment_status_stale_past_day_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { isStaleBookedAppointmentDay } from "../services/api/src/domain/routeStateReducer.ts";

// --- 1) Pure decision table (America/New_York, "now" = Tue Jul 7 2026, 1:00 PM EDT). ---
const NOW_MS = Date.parse("2026-07-07T17:00:00Z"); // 2026-07-07 13:00 America/New_York
const tz = "America/New_York";
const stale = (whenIso: string | null | undefined) =>
  isStaleBookedAppointmentDay({ whenIso, nowMs: NOW_MS, timeZone: tz });

assert.equal(stale("2026-07-03T17:00:00Z"), true, "prior calendar day (Fri Jul 3) => stale, don't assert as current");
assert.equal(
  stale("2026-07-07T13:00:00Z"),
  false,
  "same calendar day, earlier clock time (Jul 7 9:00 AM) => NOT stale — same-day status is still correct"
);
assert.equal(stale("2026-07-10T17:00:00Z"), false, "future day (Jul 10) => not stale, keep the real upcoming appointment");
assert.equal(stale("2026-07-07T21:00:00Z"), false, "same day, later today (Jul 7 5:00 PM) => not stale");
// Timezone correctness: a late-evening-EDT appointment is 02:00Z NEXT day — must bucket on LOCAL day,
// so an appointment that is still "today" in New York is not mis-flagged as past.
assert.equal(
  isStaleBookedAppointmentDay({ whenIso: "2026-07-08T02:00:00Z", nowMs: NOW_MS, timeZone: tz }),
  false,
  "2026-07-08T02:00Z is Jul 7 22:00 EDT (still today local) => not stale (guards against naive UTC compare)"
);
// Fail-direction: unusable input keeps the existing reply (never suppress a real appointment).
assert.equal(stale(""), false, "empty whenIso => not stale (fail-safe: keep existing reply)");
assert.equal(stale(null), false, "null whenIso => not stale");
assert.equal(stale("not-a-date"), false, "unparseable whenIso => not stale (fail-safe)");

// --- 2) Shared reply-builder wiring (both paths, via the single shared function). ---
const api = fs.readFileSync("services/api/src/index.ts", "utf8");

assert.match(api, /\n  isStaleBookedAppointmentDay,/, "index.ts imports the pure guard from routeStateReducer");
assert.match(
  api,
  /isStaleBookedAppointmentDay\(\{\s*whenIso,\s*nowMs: Date\.now\(\),\s*timeZone\s*\}\)/,
  "the reply builder calls the guard with the booked whenIso + now + dealer timezone"
);
// The stale branch offers to rebook and hands the thread to staff (review todo + manual handoff) —
// it does NOT assert the slot as current.
assert.match(api, /has already passed — want me to set up a new time to come in\?/, "stale branch offers to rebook");
assert.match(
  api,
  /isStaleBookedAppointmentDay\(\{[\s\S]*?addAppointmentStatusReviewTodo\(conv, inboundText[\s\S]*?setFollowUpMode\(conv, "manual_handoff", "appointment_status_confirm"\)/,
  "stale branch leaves a staff review todo + flips to manual handoff (fail-safe)"
);
// The stale guard must run BEFORE the assert-current return, or the past slot leaks through first.
const staleIdx = api.indexOf("has already passed — want me to set up a new time");
const assertCurrentIdx = api.indexOf("I’m showing your appointment for ${whenText}${staffSuffix}.");
assert.ok(staleIdx > 0 && assertCurrentIdx > 0, "both the stale branch and the assert-current return exist");
assert.ok(staleIdx < assertCurrentIdx, "the stale-past-day guard runs BEFORE the assert-current status reply");

// --- 3) Both paths use the SAME shared reply builder (route-parity is structural). ---
const builderRefs = api.match(/buildAppointmentStatusQuestionReply\(/g) ?? [];
assert.ok(
  builderRefs.length >= 3,
  `the reply builder must be the single shared function (1 def + live + regen); found ${builderRefs.length} refs`
);

console.log("PASS appointment-status stale-past-day eval (decision + shared reply-builder wiring + both paths)");
