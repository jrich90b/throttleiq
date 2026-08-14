/**
 * Inbox appointment pill eval (operator-reported +17165230421, 2026-08-13: "It did make an
 * appointment but just did not show the appointment scheduled tag in the inbox").
 *
 * Booking appointments is the job, and the inbox row could not say who was booked — the pill row
 * described walk-in, call-only, closed/sold, hold, campaign and outcome state, but never a
 * confirmed upcoming visit. Measured on the live store 2026-08-14: 4 open threads carried a
 * confirmed FUTURE appointment (one later that same day) and all 4 also had zero open tasks, so
 * the row rendered no due-chip either.
 *
 * This pins the pure predicate (resolveAppointmentTag) and the InboxSection wiring. The predicate
 * is EXECUTED against the shapes the live store actually holds, not against invented ones — the
 * store's only appointment statuses are "confirmed" (68) and "none" (2).
 *
 * FAIL DIRECTION under test: show nothing rather than something wrong. A missing pill is the
 * status quo; a pill claiming a visit that was cancelled, never confirmed, or already happened
 * would have staff plan their day around it.
 *
 * Run: npx tsx scripts/inbox_appointment_pill_eval.ts
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";
const { resolveAppointmentTag } = await import("../apps/web/src/app/lib/appointmentTag.ts");

let n = 0;
const T = (cond: boolean, msg: string) => {
  assert.equal(cond, true, msg);
  n++;
};

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Pinned clock — the eval must not read the wall clock (a date-relative fixture goes red at
// midnight; see the eval-red-at-midnight lesson).
const now = Date.parse("2026-08-14T12:00:00.000Z");
const at = (msFromNow: number) => new Date(now + msFromNow).toISOString();
const rel = (whenMs: number, nowMs: number) => (whenMs > nowMs ? `in ${Math.round((whenMs - nowMs) / HOUR)}h` : "past");

/** The real shape, copied from the live record for +17165230421 (fields not read are omitted). */
const bookedConv = (over: Record<string, any> = {}, apptOver: Record<string, any> = {}) => ({
  id: "+17165230421",
  dialogState: { name: "schedule_booked" },
  ...over,
  appointment: {
    status: "confirmed",
    whenIso: at(4 * DAY + 8 * HOUR),
    whenText: "Tue, Aug 18, 4:30 PM",
    confirmedBy: "salesperson",
    acknowledged: true,
    bookedBy: { actor: "human", channel: "sms" },
    ...apptOver
  }
});

// --- SHOWS: a confirmed future visit on an open thread is exactly what staff asked for. ---
const future = resolveAppointmentTag(bookedConv(), now, rel);
T(future !== null, "confirmed future appointment: pill shows");
T(String(future?.label ?? "").startsWith("Appointment"), "label leads with Appointment");
T(
  String(future?.title ?? "").includes("Tue, Aug 18, 4:30 PM"),
  "hover title carries the stored whenText, so the exact slot is one hover away"
);
// The relative time is what makes the row scannable — "today" vs "next week" is the whole point.
T(String(future?.label ?? "").includes("in "), "label carries the relative time from the caller's labeller");

// An appointment LATER TODAY is the highest-value case and must show (one of the 4 live rows).
T(resolveAppointmentTag(bookedConv({}, { whenIso: at(3 * HOUR) }), now, rel) !== null, "later today: pill shows");
// One minute out still counts as upcoming.
T(resolveAppointmentTag(bookedConv({}, { whenIso: at(1 * MIN) }), now, rel) !== null, "1 minute out: pill shows");

// A caller with no relative labeller still gets a usable pill (degrade, never crash).
const bare = resolveAppointmentTag(bookedConv(), now);
T(bare?.label === "Appointment", "no relative labeller: bare 'Appointment' label, not a broken string");

// --- HIDES: every branch below is the fail-safe direction (say nothing). ---
T(resolveAppointmentTag(bookedConv({}, { whenIso: at(-1 * MIN) }), now, rel) === null, "1 minute past: hidden");
T(resolveAppointmentTag(bookedConv({}, { whenIso: at(-3 * DAY) }), now, rel) === null, "3 days past: hidden (Outcome pill owns it)");
T(resolveAppointmentTag(bookedConv({ status: "closed" }), now, rel) === null, "closed thread: hidden");
T(resolveAppointmentTag(bookedConv({}, { status: "none" }), now, rel) === null, 'status "none" (2 live rows): hidden');
T(resolveAppointmentTag(bookedConv({}, { status: "cancelled" }), now, rel) === null, "cancelled: hidden");
T(resolveAppointmentTag(bookedConv({}, { status: "" }), now, rel) === null, "blank status: hidden");
T(resolveAppointmentTag(bookedConv({}, { status: "pending_customer_reply" }), now, rel) === null, "an unknown future status reads as NOT booked");
T(resolveAppointmentTag(bookedConv({}, { whenIso: "" }), now, rel) === null, "no whenIso: hidden");
T(resolveAppointmentTag(bookedConv({}, { whenIso: "not-a-date" }), now, rel) === null, "unparseable whenIso: hidden");
T(resolveAppointmentTag({ id: "x" }, now, rel) === null, "no appointment object: hidden");
T(resolveAppointmentTag(null, now, rel) === null, "no conversation: hidden");

// A booked slot with no whenText still shows — the TIME is the load-bearing field, the label is not.
const noText = resolveAppointmentTag(bookedConv({}, { whenText: "" }), now, rel);
T(noText !== null && noText.title === "Appointment booked", "missing whenText: pill shows with a generic title");

// "booked" is accepted alongside "confirmed" so a future writer spelling it that way is not silently dropped.
T(resolveAppointmentTag(bookedConv({}, { status: "booked" }), now, rel) !== null, 'status "booked" also shows');

// --- Wiring: a pure predicate nobody calls is not a fix. ---
const inbox = fs.readFileSync("apps/web/src/app/components/InboxSection.tsx", "utf8");
assert.match(
  inbox,
  /import \{ resolveAppointmentTag \} from "\.\.\/lib\/appointmentTag"/,
  "InboxSection imports the predicate"
);
assert.match(
  inbox,
  /const appointmentTag = resolveAppointmentTag\(c, nowMs, relativeDueLabel\)/,
  "InboxSection resolves the tag per row, against the row's own clock"
);
// Pin that the RENDER is gated on the predicate's result, not on a re-derived inline condition.
assert.ok(
  inbox.includes("{appointmentTag ? (") && inbox.includes("{appointmentTag.label}"),
  "the pill renders only when the predicate returned a tag, and prints the predicate's own label"
);
n += 3;

console.log(`PASS inbox appointment pill eval (${n} assertions)`);
