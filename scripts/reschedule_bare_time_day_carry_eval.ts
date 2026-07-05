/**
 * Reschedule bare-time day-carry eval.
 *
 * Production fixture: +17167506588 (operator-reported "MANY times" + held live_hold,
 * 2026-06-29). The lead had a no-show on an original booking (appointment.bookedEventId +
 * reschedulePending), so the turn was claimed by the reschedule branch UPSTREAM of
 * decideSchedulingTurn. The agent offered a concrete day+time ("...Friday, July 3. How's
 * 1:00 PM or 2:30 PM?") and the customer accepted with only a time ("1:00 PM works").
 *
 * BUG: when parseRequestedDayTime() found a time but no day, the reschedule branch resolved
 * the DAY from the STALE booked appointment.whenIso (the original Saturday), landed on that
 * day's closed slots, and deflected ("Joe is booked around that time. The closest openings I
 * have are Sat, Jul 4 ...") instead of confirming the offered Friday.
 *
 * FIX (both paths): before any stale-appointment fallback, carry the day from the agent's last
 * concrete outbound offer (applyInferredScheduleDayToTimeOnlyText -> parseRequestedDayTime), so
 * the offered Friday resolves. Fail-safe: when no day can be inferred from the offer, the text
 * is unchanged and the prior behavior stands.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const { parseRequestedDayTime } = await import(
  "../services/api/src/domain/conversationStore.ts"
);

const TZ = "America/New_York";
const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");

// ── Source pins: the day-carry must exist in BOTH reply paths — the live
// /webhooks/twilio reschedule branch AND the /conversations/:id/regenerate gate.
assert.equal(
  (apiSource.match(/\[reschedule-bare-time-day-carry\]/g) ?? []).length,
  2,
  "reschedule bare-time day-carry must be wired in BOTH the live and regen paths"
);
// The live-path fix must run BEFORE the stale-appointment.whenIso fallback (ordering pins the
// fail-direction: offered day wins over the stale booked date).
const carryIdx = apiSource.indexOf("[reschedule-bare-time-day-carry] Customer replied");
const staleFallbackIdx = apiSource.indexOf("if (!requestedReschedule && conv.appointment.whenIso) {");
assert.ok(carryIdx > 0 && staleFallbackIdx > 0, "both reschedule branch markers must exist");
assert.ok(
  carryIdx < staleFallbackIdx,
  "day-carry must precede the stale-appointment.whenIso fallback"
);

// ── Behavioral pins (real exported parseRequestedDayTime + a faithful copy of the offer-day
// inference that applyInferredScheduleDayToTimeOnlyText/inferDayTokenFromRecentTimePrompt use:
// a weekday named in the agent's last offer carries to a bare-time reply).
function inferDayFromOffer(offer: string): string | null {
  const m = String(offer ?? "")
    .toLowerCase()
    .match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  return m ? m[1] : null;
}

const OFFER = "I can line up a time to come by Friday, July 3. How's 1:00 PM or 2:30 PM?";
const REPLY = "1:00 PM works";

const carriedDay = inferDayFromOffer(OFFER);
assert.equal(carriedDay, "friday", "the offered weekday must be inferred from the agent's last offer");

const resolved = parseRequestedDayTime(`${carriedDay} ${REPLY}`, TZ);
assert.ok(resolved, "day-carried bare-time accept must resolve to a concrete day+time");
assert.equal(resolved!.dayOfWeek, "friday", "resolved reschedule day must be the OFFERED Friday");
assert.equal(resolved!.hour24, 13, "1:00 PM must resolve to 13:00");
assert.equal(resolved!.minute, 0);

// The bug: resolving the day from the stale booked Saturday yields Saturday — must differ.
const staleSaturday = parseRequestedDayTime("saturday 1:00 PM", TZ);
assert.equal(staleSaturday!.dayOfWeek, "saturday", "stale-day baseline resolves to Saturday");
assert.notEqual(
  resolved!.dayOfWeek,
  staleSaturday!.dayOfWeek,
  "fix must resolve the offered day, never fall back to the stale booked day"
);

// Bare time with NO inferable day in the offer stays unresolved (fail-safe: no fabricated day).
assert.equal(
  inferDayFromOffer("What time works best for you?"),
  null,
  "no weekday in the offer => no day carried (fall through to prior behavior)"
);
assert.equal(
  parseRequestedDayTime(REPLY, TZ),
  null,
  "a bare time alone (no carried day) must not resolve to a concrete day"
);

console.log("PASS reschedule bare-time day-carry eval");
