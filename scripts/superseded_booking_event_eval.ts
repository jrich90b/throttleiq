/**
 * Superseded-booking calendar cancel eval (pure, no LLM, no network — the calendar client is a
 * capture mock).
 *
 * Pins the 8/3 wiring-triage B1: staff rebooked a lead who already had a FUTURE appointment. The
 * manual-outbound inferred-booking block cleared the booked-event pointers ONLY when the existing
 * appointment was PAST, so on a future one the record kept the old event id, the booking helper
 * refused ("already booked"), the teardown wiped the record with a misleading "could not be
 * booked" task — and the OLD event survived on the rep's calendar with no pointer left anywhere
 * to clean it up. The rep sees an appointment for a customer whose record says nothing.
 *
 * The fix: a new booking in that block SUPERSEDES any existing booked event — a still-upcoming
 * one is cancelled on the calendar via cancelSupersededBookedEvent, and the pointers clear so the
 * new time books. The helper takes the client/config GETTERS so every fallible await lives inside
 * its own try: a calendar-auth failure costs only the cancel, never the new booking.
 *
 * Run: npx tsx scripts/superseded_booking_event_eval.ts
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";

const { cancelSupersededBookedEvent } = await import("../services/api/src/domain/googleCalendar.ts");

type PatchCall = { calendarId: string; eventId: string; requestBody: any };

function mockCalendar(calls: PatchCall[], failPatch = false) {
  return {
    events: {
      patch: async (args: PatchCall) => {
        if (failPatch) throw new Error("patch failed");
        calls.push(args);
        return { data: { id: args.eventId } };
      }
    }
  };
}

const CFG = {
  timezone: "America/New_York",
  salespeople: [
    { id: "sp-mike", calendarId: "cal-mike" },
    { id: "sp-sarah", calendarId: "cal-sarah" }
  ]
};

// --- 1) The happy path: resolves the booked rep's calendar and cancels the event. ---
{
  const calls: PatchCall[] = [];
  const ok = await cancelSupersededBookedEvent(
    async () => mockCalendar(calls),
    async () => CFG,
    { bookedEventId: "evt-1", bookedSalespersonId: "sp-mike", matchedSlot: { calendarId: "cal-stale" } }
  );
  assert.equal(ok, true, "a resolvable event cancels");
  assert.equal(calls.length, 1, "exactly one calendar write");
  assert.equal(calls[0].calendarId, "cal-mike", "the booked rep's CONFIGURED calendar wins over matchedSlot");
  assert.equal(calls[0].eventId, "evt-1");
  assert.equal(calls[0].requestBody.status, "cancelled", "the event is cancelled, not deleted or moved");
}

// --- 2) matchedSlot fallback when the rep is gone from config (the B2-adjacent case). ---
{
  const calls: PatchCall[] = [];
  const ok = await cancelSupersededBookedEvent(
    async () => mockCalendar(calls),
    async () => CFG,
    { bookedEventId: "evt-2", bookedSalespersonId: "sp-departed", matchedSlot: { calendarId: "cal-slot" } }
  );
  assert.equal(ok, true);
  assert.equal(calls[0].calendarId, "cal-slot", "a departed rep falls back to the stored slot's calendar");
}

// --- 3) Nothing to cancel: no event id, or no resolvable calendar. ---
assert.equal(
  await cancelSupersededBookedEvent(async () => mockCalendar([]), async () => CFG, { bookedEventId: "" }),
  false,
  "no event id: nothing to cancel"
);
assert.equal(
  await cancelSupersededBookedEvent(async () => mockCalendar([]), async () => ({ salespeople: [] }), {
    bookedEventId: "evt-3",
    bookedSalespersonId: "sp-x"
  }),
  false,
  "no resolvable calendar: refuse rather than guess"
);

// --- 4) THE LOAD-BEARING PROPERTY: no failure may escape — the new booking must never be lost. ---
{
  const rejectingGetter = async () => {
    throw new Error("calendar auth down");
  };
  assert.equal(
    await cancelSupersededBookedEvent(rejectingGetter as any, async () => CFG, { bookedEventId: "evt-4" }),
    false,
    "a client-getter failure returns false, never throws"
  );
  assert.equal(
    await cancelSupersededBookedEvent(async () => mockCalendar([], true), async () => CFG, {
      bookedEventId: "evt-5",
      bookedSalespersonId: "sp-mike"
    }),
    false,
    "a patch failure returns false, never throws"
  );
  assert.equal(
    await cancelSupersededBookedEvent(async () => mockCalendar([]), rejectingGetter as any, {
      bookedEventId: "evt-6"
    }),
    false,
    "a config-getter failure returns false, never throws"
  );
}

// --- 5) Source pin: the manual-outbound block supersedes on ANY booked event, cancels future ones. ---
{
  const api = fs.readFileSync("services/api/src/index.ts", "utf8");
  const start = api.indexOf("if (shouldInferManualAppointment && requested) {");
  assert.notEqual(start, -1, "the manual-outbound inferred-booking block must exist");
  const block = api.slice(start, start + 2400);
  assert.ok(
    /if \(String\(conv\.appointment\.bookedEventId \?\? ""\)\.trim\(\)\) \{/.test(block),
    "the supersede gate must fire on ANY existing booked event — the old past-only gate left a " +
      "future event orphaned on the rep's calendar"
  );
  assert.ok(
    /cancelSupersededBookedEvent\(getAuthedCalendarClient, getSchedulerConfigHot, conv\.appointment\)/.test(block),
    "a still-upcoming superseded event must be cancelled via the helper (getters passed, not results)"
  );
  assert.ok(
    /if \(!existingBookedAppointmentIsPast\) \{/.test(block),
    "only a still-upcoming event pays for a calendar cancel — a past one is history, clear-only"
  );
  assert.ok(
    /bookedSalespersonName = null/.test(block) && /bookedCalendarId = null/.test(block),
    "the clear must keep covering the name/calendar pointers (the B2 stale-pointer family)"
  );
}

console.log("PASS superseded_booking_event_eval — 16 checks");
