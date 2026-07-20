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

// (b) Source guard: the 24h reminder loop consults the guard with BOTH signals, before the
// send-window math (so a suppressed conv never even reaches the compose/send branch).
{
  const src = readFileSync("services/api/src/index.ts", "utf8");
  const start = src.indexOf("async function processAppointmentConfirmations()");
  assert.ok(start >= 0, "processAppointmentConfirmations must exist in index.ts");
  const body = src.slice(start, start + 3000);
  assert.match(
    body,
    /shouldSuppressAppointmentConfirmationReminder\(\{/,
    "the 24h reminder loop must consult the suppression guard"
  );
  assert.match(body, /acknowledged: appt\.acknowledged/, "the guard must receive appointment.acknowledged");
  assert.match(body, /humanMode: conv\.mode === "human"/, "the guard must receive the human-takeover signal");
  const guardIdx = body.indexOf("shouldSuppressAppointmentConfirmationReminder");
  const windowIdx = body.indexOf("diffMs > 24 * 60 * 60 * 1000");
  assert.ok(
    guardIdx >= 0 && windowIdx > guardIdx,
    "the suppression guard must run before the send-window check"
  );
}

console.log("appointment_confirmation_reminder_eval passed");
