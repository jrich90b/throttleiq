/**
 * Scheduler closed-date (holiday) eval.
 *
 * The scheduler only knew WEEKLY business hours, so a dealer holiday that lands on an
 * otherwise-open weekday was treated as open. R Gurajala (+17167506588, 2026-06-28) asked
 * for Fri Jul 3 and the scheduler offered "Sat, Jul 4, 9:30 AM / 10:00 AM" as an alternative —
 * July 4 is a normally-open Saturday but the dealer is closed for the holiday.
 *
 * Fix: cfg.closedDates (local YYYY-MM-DD) force getOpenClose -> {open:null,close:null}, which
 * BOTH generateCandidateSlots (alternative offers) and findExactSlotForSalesperson (exact book)
 * already treat as closed. This pins that a closed date is never offered NOR booked, while its
 * weekday siblings stay bookable — and that the guard (not the weekday) is what closes it.
 *
 * Deterministic (pure engine, no LLM / no calendar IO). Run: npx tsx scripts/scheduler_closed_date_eval.ts
 */
import assert from "node:assert/strict";
import {
  generateCandidateSlots,
  findExactSlotForSalesperson
} from "../services/api/src/domain/schedulerEngine.ts";
import type { SchedulerConfig } from "../services/api/src/domain/schedulerConfig.ts";

const TZ = "America/New_York";

function baseConfig(closedDates: string[]): SchedulerConfig {
  return {
    timezone: TZ,
    preferredSalespeople: ["s1"],
    salespeople: [{ id: "s1", name: "Joe", calendarId: "cal1" }],
    businessHours: {
      monday: { open: "09:00", close: "18:00" },
      tuesday: { open: "09:00", close: "18:00" },
      wednesday: { open: "09:00", close: "18:00" },
      thursday: { open: "09:00", close: "18:00" },
      friday: { open: "09:00", close: "18:00" },
      saturday: { open: "09:00", close: "15:00" },
      sunday: { open: null, close: null }
    },
    bookingWindows: {
      weekday: { earliestStart: "09:30", latestStart: "17:00" },
      saturday: { earliestStart: "09:30", latestStart: "14:00" }
    },
    minLeadTimeHours: 4,
    minGapBetweenAppointmentsMinutes: 60,
    appointmentTypes: { inventory_visit: { durationMinutes: 60 } },
    closedDates
  };
}

function localDateKey(iso: string): string {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(iso));
  const m: Record<string, string> = {};
  for (const part of p) if (part.type !== "literal") m[part.type] = part.value;
  return `${m.year}-${m.month}-${m.day}`;
}

function dayEntry(slotsByDay: ReturnType<typeof generateCandidateSlots>, key: string) {
  return slotsByDay.find(d => localDateKey(d.dayStart.toISOString()) === key) ?? null;
}

// --- 1) Alternative offers (the R Gurajala bug): a closed holiday is never generated. ---
// Fixed "now" = Sun Jun 28 2026 (mirrors the live turn); Jul 3 = Fri (open), Jul 4 = Sat (open weekday).
const now = new Date("2026-06-28T12:00:00.000Z");

const closed = generateCandidateSlots(baseConfig(["2026-07-04"]), now, 60, 14);
const openControl = generateCandidateSlots(baseConfig([]), now, 60, 14);

// Friday July 3 is open in BOTH configs (the day the customer actually wanted).
const fri = dayEntry(closed, "2026-07-03");
assert.ok(fri && fri.candidates.length > 0, "Fri Jul 3 stays bookable (open weekday, not a holiday)");

// Saturday July 4: present WITH candidates in the control, ABSENT once marked closed.
const sat4Control = dayEntry(openControl, "2026-07-04");
assert.ok(sat4Control && sat4Control.candidates.length > 0, "control: Jul 4 is an open Saturday (weekday hours make it bookable)");
const sat4Closed = dayEntry(closed, "2026-07-04");
assert.equal(sat4Closed, null, "closedDates: Jul 4 is never generated as an alternative");

// Selectivity: ONLY the listed date drops out — every other day (incl. Fri Jul 3) is untouched.
const closedKeys = new Set(closed.map(d => localDateKey(d.dayStart.toISOString())));
const controlKeys = new Set(openControl.map(d => localDateKey(d.dayStart.toISOString())));
const dropped = [...controlKeys].filter(k => !closedKeys.has(k));
assert.deepEqual(dropped, ["2026-07-04"], "closedDates removes ONLY the listed holiday, no other day");

// --- 2) Exact booking: an exact slot on a closed date is rejected (never books). ---
// findExactSlotForSalesperson uses real `now` for lead time, so use a date ~10 days out
// (clears lead time regardless of when the eval runs) with all weekdays open.
const soon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
const parts = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).formatToParts(soon);
const pm: Record<string, string> = {};
for (const p of parts) if (p.type !== "literal") pm[p.type] = p.value;
const soonKey = `${pm.year}-${pm.month}-${pm.day}`;
const requested = { year: Number(pm.year), month: Number(pm.month), day: Number(pm.day), hour24: 12, minute: 0 };
const allOpen = (closedDates: string[]): SchedulerConfig => ({
  ...baseConfig(closedDates),
  businessHours: {
    monday: { open: "09:00", close: "18:00" },
    tuesday: { open: "09:00", close: "18:00" },
    wednesday: { open: "09:00", close: "18:00" },
    thursday: { open: "09:00", close: "18:00" },
    friday: { open: "09:00", close: "18:00" },
    saturday: { open: "09:00", close: "18:00" },
    sunday: { open: "09:00", close: "18:00" }
  }
});

const bookOpen = findExactSlotForSalesperson(allOpen([]), "s1", "cal1", requested, 60, []);
assert.ok(bookOpen, "control: noon on an open day is bookable");
const bookClosed = findExactSlotForSalesperson(allOpen([soonKey]), "s1", "cal1", requested, 60, []);
assert.equal(bookClosed, null, "closedDates: an exact slot on a closed date is never booked");

console.log("PASS scheduler closed-date (holiday) eval");
