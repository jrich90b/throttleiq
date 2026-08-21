/**
 * THE APPOINTMENTS REPORT — who set it, and did the customer show up?
 *
 * Joe, 2026-08-21: *"I need the ability to run a report on who set the appointment and if they
 * showed or not."* It is a commission question, so the standard for this file is not "produces a
 * plausible table" — it is "never silently credits or docks a salesperson."
 *
 * WHY THIS IS NOT THE KPI OVERVIEW, which already counts appointments and shows-rate.
 * `kpiAnalytics.leadMatchesFilters` applies `from`/`to` to the LEAD-CREATION date, so "August" there
 * means "leads that arrived in August" — a different question, and useless for a pay period. This
 * report keys the range on `appointment.whenIso`, the day the customer was actually due in.
 *
 * WHAT IT REUSES RATHER THAN REIMPLEMENTS. `resolveAppointmentAttendance` and
 * `inferAppointmentSetter` both live in `kpiAnalytics.ts` and are imported here. That is deliberate:
 * a second private copy of a matcher is exactly how the watch engine ended up pinned to its own
 * duplicate while the live path drifted. One reader, one answer.
 *
 * ── THE HONEST LIMIT, measured across all 74 appointments in the store on 2026-08-21 ───────────
 * The system does NOT always know WHICH human set an appointment, and no amount of reporting can
 * invent it. `appointment.bookedBy` is written by one referee (`applyAppointmentAttribution`) down
 * two lanes:
 *   - EXPLICIT — a signed-in user booked through the console. Carries `userId` + `userName`.
 *     Measured: 15 of 74, and every one of them names the person.
 *   - INFERRED — the booking was recognised from the thread (a text confirmation, a phone log).
 *     Carries `{ actor, channel, inferred: true }` and DELIBERATELY no person, because the
 *     confirmation lands on the shared dealership number and the system genuinely cannot tell who
 *     handled it. Measured: 21 of 74 (11 by SMS, 8 by phone, 2 manual).
 * Another 17 are pre-attribution legacy records carrying only `confirmedBy`.
 *
 * So `setterName` is `null` for roughly half of history, and this module reports that as its own
 * category — `staff_unattributed` — rather than guessing, blanking it, or folding it into whoever
 * owns the calendar. A commission sheet that quietly attributed those to the calendar owner would
 * be wrong 2 times in 15 by direct measurement (Joe set an appointment on Stone's calendar on 7/03;
 * Scott set one on Giovanni's on 7/08), and wrong in an invisible direction the rest of the time.
 *
 * FAIL DIRECTION, stated once and enforced by the eval: every uncertainty in this file resolves
 * toward VISIBLE and UNPAID, never toward silently-credited. An outcome nobody recorded is
 * `not_logged`, not `showed`. A setter nobody recorded is `staff_unattributed`, not the calendar
 * owner. A contradictory record is flagged `conflict`, not quietly picked.
 */
import type { Conversation } from "./conversationStore.js";
import {
  inferAppointmentSetter,
  leadDisplayName,
  resolveAppointmentAttendance,
  type AppointmentAttendance
} from "./kpiAnalytics.js";

export type AppointmentSetterKind =
  /** The agent booked it. */
  | "ai"
  /** The customer booked themselves through the public booking page. */
  | "customer"
  /** A signed-in staff member booked it in the console — we know exactly who. */
  | "staff_named"
  /** A human booked it, but the system never recorded which one (text/phone/legacy). */
  | "staff_unattributed"
  | "unknown";

export type AppointmentReportRow = {
  convId: string;
  leadKey: string;
  customer: string;
  customerPhone: string;
  /** UTC instant the appointment is due; the range filter keys on this. */
  whenIso: string | null;
  /**
   * Dealership-local time, DERIVED from `whenIso` — never the stored `whenText`/`whenLocal`.
   *
   * Caught by the first run against real data: Edward Trouse's appointment is stored with
   * `whenIso` 2026-08-04T20:00Z and `whenLocal` "Mon, Jul 27, 4:00 PM". The display string is
   * written when the booking is made and is NOT rewritten on a reschedule, so it can name a date
   * eight days off the real one. `whenIso` is the field that matched the Google Calendar on every
   * August appointment, so it is the only one this report will show.
   */
  whenLocal: string;
  appointmentType: string;
  setterKind: AppointmentSetterKind;
  /** Named person when known, else null — NEVER a guess. */
  setterName: string | null;
  /** How the booking reached us ("AI by SMS", "Human by phone", …). */
  setterChannelLabel: string;
  /** Whose calendar it landed on. Not the same question as who set it. */
  bookedWith: string | null;
  attendance: AppointmentAttendance["state"];
  outcomeStatus: string;
  /** True when the record contradicts itself; surfaced rather than resolved. */
  conflict: boolean;
};

export type AppointmentGroupRow = {
  key: string;
  label: string;
  booked: number;
  showed: number;
  noShow: number;
  cancelled: number;
  notLogged: number;
  upcoming: number;
  /** Of the appointments already GRADED, what share showed. Null when nothing is graded yet. */
  showRatePct: number | null;
};

export type AppointmentReport = {
  applied: { from: string; to: string };
  totals: {
    booked: number;
    showed: number;
    noShow: number;
    cancelled: number;
    notLogged: number;
    upcoming: number;
    showRatePct: number | null;
    conflicts: number;
  };
  bySetter: AppointmentGroupRow[];
  byBookedWith: AppointmentGroupRow[];
  rows: AppointmentReportRow[];
};

const SETTER_KIND_LABEL: Record<AppointmentSetterKind, string> = {
  ai: "AI agent",
  customer: "Customer self-booked",
  staff_named: "Staff",
  staff_unattributed: "Staff — name not recorded",
  unknown: "Unknown"
};

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function toMs(raw: string | null | undefined): number | null {
  const ms = Date.parse(text(raw));
  return Number.isFinite(ms) ? ms : null;
}

const FALLBACK_TIMEZONE = "America/New_York";

/** Format the authoritative instant in the dealership's zone, e.g. "Fri, Aug 15, 12:00 PM". */
function formatLocal(whenIso: string | null | undefined, timeZone: string): string {
  const ms = toMs(whenIso);
  if (ms == null) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || FALLBACK_TIMEZONE,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

/**
 * Who set it — person first, category second, and never a guess.
 *
 * The channel label from `inferAppointmentSetter` ("Human by phone") is kept alongside the kind so
 * the report can say *how* an unattributed booking arrived. That is the difference between a row
 * Joe can chase ("a text confirmation on the 15th — who was on the phones?") and a dead end.
 */
export function resolveAppointmentSetter(conv: Conversation): {
  kind: AppointmentSetterKind;
  name: string | null;
  channelLabel: string;
} {
  const appointment = conv.appointment as any;
  const bookedBy = appointment?.bookedBy;
  const inferred = inferAppointmentSetter(conv);
  const actor = text(bookedBy?.actor).toLowerCase();
  const name = text(bookedBy?.userName) || null;

  if (actor === "ai") return { kind: "ai", name: null, channelLabel: inferred.label };
  if (actor === "customer") return { kind: "customer", name: null, channelLabel: inferred.label };
  if (actor === "human") {
    return name
      ? { kind: "staff_named", name, channelLabel: inferred.label }
      : { kind: "staff_unattributed", name: null, channelLabel: inferred.label };
  }

  // No `bookedBy` at all — a pre-attribution record. `confirmedBy` is all we have, and it
  // distinguishes only "the customer did it" (which on this system means the agent drove it) from
  // "a salesperson did it" (which does not say WHICH salesperson).
  const confirmedBy = text(appointment?.confirmedBy).toLowerCase();
  if (confirmedBy === "customer") return { kind: "ai", name: null, channelLabel: inferred.label };
  if (confirmedBy === "salesperson") {
    return { kind: "staff_unattributed", name: null, channelLabel: inferred.label };
  }
  return { kind: "unknown", name: null, channelLabel: inferred.label };
}

/**
 * Whose calendar the appointment sits on. Reported beside the setter, never merged into it — on
 * 2 of the 15 attributed bookings these are different people.
 */
function resolveBookedWith(conv: Conversation): string | null {
  const appointment = conv.appointment as any;
  return (
    text(appointment?.bookedSalespersonName) ||
    text(appointment?.matchedSlot?.salespersonName) ||
    text(appointment?.bookedBy?.userName) ||
    null
  );
}

function groupKeyForSetter(row: AppointmentReportRow): { key: string; label: string } {
  if (row.setterKind === "staff_named" && row.setterName) {
    return { key: `staff:${row.setterName}`, label: row.setterName };
  }
  return { key: row.setterKind, label: SETTER_KIND_LABEL[row.setterKind] };
}

function emptyGroup(key: string, label: string): AppointmentGroupRow {
  return {
    key,
    label,
    booked: 0,
    showed: 0,
    noShow: 0,
    cancelled: 0,
    notLogged: 0,
    upcoming: 0,
    showRatePct: null
  };
}

function tally(group: AppointmentGroupRow, state: AppointmentAttendance["state"]): void {
  group.booked += 1;
  if (state === "showed") group.showed += 1;
  else if (state === "no_show") group.noShow += 1;
  else if (state === "cancelled") group.cancelled += 1;
  else if (state === "upcoming") group.upcoming += 1;
  else group.notLogged += 1;
}

/**
 * Show rate is computed over GRADED appointments only — showed + no-show.
 *
 * Cancellations are excluded because a customer who called ahead to cancel is not a rep failing to
 * get someone through the door, and `not_logged`/`upcoming` are excluded because they are unknown,
 * not zero. Folding either into the denominator would push a rep's number down for something that
 * is not their result — and with roughly one appointment in four ungraded, that is a big enough
 * distortion to change what somebody gets paid.
 */
function finalizeGroup(group: AppointmentGroupRow): AppointmentGroupRow {
  const graded = group.showed + group.noShow;
  group.showRatePct = graded > 0 ? Number(((group.showed / graded) * 100).toFixed(1)) : null;
  return group;
}

function buildRow(conv: Conversation, nowMs: number, timeZone: string): AppointmentReportRow {
  const appointment = conv.appointment as any;
  const attendance = resolveAppointmentAttendance(conv, nowMs);
  const setter = resolveAppointmentSetter(conv);
  return {
    convId: text(conv.id),
    leadKey: text(conv.leadKey ?? conv.id),
    customer: leadDisplayName(conv),
    customerPhone: text(conv.lead?.phone),
    whenIso: text(appointment?.whenIso) || null,
    whenLocal: formatLocal(appointment?.whenIso, timeZone),
    appointmentType: text(appointment?.appointmentType) || text(appointment?.matchedSlot?.appointmentType) || "",
    setterKind: setter.kind,
    setterName: setter.name,
    setterChannelLabel: setter.channelLabel,
    bookedWith: resolveBookedWith(conv),
    attendance: attendance.state,
    outcomeStatus: attendance.outcomeStatus,
    conflict: attendance.conflict
  };
}

/**
 * A conversation is IN the report when it carries a real appointment inside the window.
 *
 * `status: "none"` is excluded (a cleared appointment), and a record with no parseable `whenIso` is
 * excluded because it cannot be placed in a pay period at all — the store holds three such rows
 * (one dated 2012, two blank). They are counted in `skippedUndated` rather than dropped in silence,
 * because a commission report that quietly loses rows is worse than one that admits to them.
 */
export function buildAppointmentReport(
  conversations: Conversation[],
  opts: { from?: string; to?: string; nowMs?: number; timeZone?: string } = {}
): AppointmentReport & { skippedUndated: number } {
  const nowMs = opts.nowMs ?? Date.now();
  const timeZone = text(opts.timeZone) || FALLBACK_TIMEZONE;
  const fromMs = toMs(opts.from) ?? Number.NEGATIVE_INFINITY;
  const toBoundMs = toMs(opts.to) ?? Number.POSITIVE_INFINITY;

  const rows: AppointmentReportRow[] = [];
  let skippedUndated = 0;

  for (const conv of conversations ?? []) {
    const appointment = (conv as any)?.appointment;
    if (!appointment) continue;
    const status = text(appointment.status).toLowerCase();
    if (!status || status === "none") continue;

    const whenMs = toMs(appointment.whenIso);
    if (whenMs == null) {
      skippedUndated += 1;
      continue;
    }
    if (whenMs < fromMs || whenMs > toBoundMs) continue;
    rows.push(buildRow(conv, nowMs, timeZone));
  }

  rows.sort((a, b) => String(a.whenIso ?? "").localeCompare(String(b.whenIso ?? "")));

  const setterGroups = new Map<string, AppointmentGroupRow>();
  const ownerGroups = new Map<string, AppointmentGroupRow>();
  const totals = {
    booked: 0,
    showed: 0,
    noShow: 0,
    cancelled: 0,
    notLogged: 0,
    upcoming: 0,
    showRatePct: null as number | null,
    conflicts: 0
  };

  for (const row of rows) {
    const setterKey = groupKeyForSetter(row);
    if (!setterGroups.has(setterKey.key)) {
      setterGroups.set(setterKey.key, emptyGroup(setterKey.key, setterKey.label));
    }
    tally(setterGroups.get(setterKey.key)!, row.attendance);

    const ownerLabel = row.bookedWith || "(no salesperson on the booking)";
    if (!ownerGroups.has(ownerLabel)) ownerGroups.set(ownerLabel, emptyGroup(ownerLabel, ownerLabel));
    tally(ownerGroups.get(ownerLabel)!, row.attendance);

    totals.booked += 1;
    if (row.attendance === "showed") totals.showed += 1;
    else if (row.attendance === "no_show") totals.noShow += 1;
    else if (row.attendance === "cancelled") totals.cancelled += 1;
    else if (row.attendance === "upcoming") totals.upcoming += 1;
    else totals.notLogged += 1;
    if (row.conflict) totals.conflicts += 1;
  }

  const gradedTotal = totals.showed + totals.noShow;
  totals.showRatePct = gradedTotal > 0 ? Number(((totals.showed / gradedTotal) * 100).toFixed(1)) : null;

  const byCount = (a: AppointmentGroupRow, b: AppointmentGroupRow) =>
    b.booked - a.booked || a.label.localeCompare(b.label);

  return {
    applied: { from: text(opts.from), to: text(opts.to) },
    totals,
    bySetter: [...setterGroups.values()].map(finalizeGroup).sort(byCount),
    byBookedWith: [...ownerGroups.values()].map(finalizeGroup).sort(byCount),
    rows,
    skippedUndated
  };
}

/** CSV for the detail table. Kept server-side so the console and any script emit the same file. */
export function appointmentReportToCsv(report: AppointmentReport): string {
  const header = [
    "Appointment (UTC)",
    "Appointment (local)",
    "Customer",
    "Phone",
    "Type",
    "Set by",
    "Set by (category)",
    "How it was set",
    "Booked with",
    "Result",
    "Outcome note",
    "Conflict"
  ];
  const escape = (value: unknown): string => {
    const raw = String(value ?? "");
    return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
  };
  const lines = [header.join(",")];
  for (const row of report.rows) {
    lines.push(
      [
        row.whenIso ?? "",
        row.whenLocal,
        row.customer,
        row.customerPhone,
        row.appointmentType,
        row.setterName ?? "",
        SETTER_KIND_LABEL[row.setterKind],
        row.setterChannelLabel,
        row.bookedWith ?? "",
        row.attendance,
        row.outcomeStatus,
        row.conflict ? "yes" : ""
      ]
        .map(escape)
        .join(",")
    );
  }
  return lines.join("\n");
}

export { SETTER_KIND_LABEL };
