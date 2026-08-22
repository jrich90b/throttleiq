/**
 * appointment_confirmation_reminder:eval (universal, deterministic) — runs inside ci:eval.
 *
 * Joe ruling 2026-07-20 (Peter Meredith +17168303999, the "boomed him" report): the automatic
 * 24-hour "Reply YES to confirm or NO to reschedule" reminder fired after the customer had
 * ALREADY re-confirmed the visit in his own words and while a human was personally working
 * the thread. The reminder must be suppressed when appointment.acknowledged is set (customer
 * confirmed since booking; reset on any rebooking) or when a human owns the thread
 * (mode === "human") — and must still fire for an unacknowledged, bot-owned booking.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { shouldSuppressAppointmentConfirmationReminder } from "../services/api/src/domain/transitionSafety.ts";

// (a) Truth table for the pure guard.
assert.equal(
  shouldSuppressAppointmentConfirmationReminder({ acknowledged: true, humanMode: false }),
  true,
  "customer already acknowledged => suppress (the Peter Meredith case)"
);
assert.equal(
  shouldSuppressAppointmentConfirmationReminder({ acknowledged: false, humanMode: true }),
  true,
  "human owns the thread => suppress (no robotic blast over a live human conversation)"
);
assert.equal(
  shouldSuppressAppointmentConfirmationReminder({ acknowledged: true, humanMode: true }),
  true
);
assert.equal(
  shouldSuppressAppointmentConfirmationReminder({ acknowledged: false, humanMode: false }),
  false,
  "unacknowledged, bot-owned booking => the reminder still fires (fail direction)"
);
assert.equal(
  shouldSuppressAppointmentConfirmationReminder({}),
  false,
  "missing flags => the reminder still fires (never suppress on unknown state)"
);
assert.equal(
  shouldSuppressAppointmentConfirmationReminder({ acknowledged: null, humanMode: null }),
  false,
  "null flags => the reminder still fires"
);

// (b) Source guard: the 24h reminder loop consults C4.4's BOTH signals, before the send-window math.
//
// UPDATED 2026-08-21. This block used to require the loop to call
// `shouldSuppressAppointmentConfirmationReminder` by name and then `continue`. That spelling was the
// whole reason the reminder went silent: suppression was the only lever, so a customer who confirmed
// in their own words got NOTHING — and all six of the store's no-shows had acknowledged. The loop now
// asks `resolveAppointmentReminderVariant` WHICH reminder to send, and that function re-reads C4.4's
// own predicate rather than restating it. The guarantee this file exists for is unchanged and pinned
// below: both of Joe's signals are consulted, before the window math, and C4.4 still owns the rule.
{
  const src = readFileSync("services/api/src/index.ts", "utf8");
  const start = src.indexOf("async function processAppointmentConfirmations()");
  assert.ok(start >= 0, "processAppointmentConfirmations must exist in index.ts");
  const body = src.slice(start, start + 3000);
  assert.match(
    body,
    /resolveAppointmentReminderVariant\(\{/,
    "the 24h reminder loop must consult C4.4's signals to pick a variant"
  );
  assert.match(body, /acknowledged: appt\.acknowledged/, "the decision must receive appointment.acknowledged");
  assert.match(body, /humanMode: conv\.mode === "human"/, "the decision must receive the human-takeover signal");
  const guardIdx = body.indexOf("resolveAppointmentReminderVariant");
  const windowIdx = body.indexOf("diffMs > 24 * 60 * 60 * 1000");
  assert.ok(
    guardIdx >= 0 && windowIdx > guardIdx,
    "the variant decision must run before the send-window check"
  );
  // C4.4 must stay in ONE place: the variant is its predicate re-read, never a second copy of the
  // rule that can drift away from Joe's ruling.
  const transitions = readFileSync("services/api/src/domain/transitionSafety.ts", "utf8");
  assert.match(
    transitions,
    /return shouldSuppressAppointmentConfirmationReminder\(args\) \? "warm_note" : "confirm_ask";/,
    "resolveAppointmentReminderVariant must delegate to C4.4's predicate, not restate it"
  );
}

console.log("appointment_confirmation_reminder_eval passed");
