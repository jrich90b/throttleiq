import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { dataPath } from "./dataDir.js";

export type SchedulerConfig = {
  enabled?: boolean;
  interval_seconds?: number;
  start_hour_local?: number;
  end_hour_local?: number;
  timezone: string;
  assignmentMode?: "preferred" | "round_robin";
  preferredSalespeople: string[];
  salespeople: { id: string; name: string; calendarId: string }[];
  businessHours: Record<string, { open: string | null; close: string | null }>;
  bookingWindows: {
    weekday: { earliestStart: string; latestStart: string };
    saturday: { earliestStart: string; latestStart: string };
  };
  minLeadTimeHours: number;
  minGapBetweenAppointmentsMinutes: number;
  appointmentTypes: Record<string, { durationMinutes: number; colorId?: string }>;
  /**
   * Dealer holidays / one-off closures as local "YYYY-MM-DD" dates (dealer timezone).
   * A date here is treated as fully closed regardless of its weekday business hours, so the
   * scheduler never offers or books a slot on it (e.g. July 4 falls on an open Saturday but
   * the dealer is closed). Slot generation and the exact-slot check both honor this via
   * getOpenClose returning {open:null, close:null} for these dates.
   */
  closedDates?: string[];
  availabilityBlocks?: Record<
    string,
    Array<{
      id: string;
      title: string;
      rrule: string;
      start?: string;
      end?: string;
      days?: string[];
    }>
  >;
};

type SchedulerConfigRaw = {
  enabled?: boolean;
  interval_seconds?: number;
  start_hour_local?: number;
  end_hour_local?: number;
  timezone?: string;
  assignmentMode?: "preferred" | "round_robin";
  preferredSalespeople?: string[];
  salespeople?: { id: string; name: string; calendarId: string }[];
  businessHours?: Record<string, { open: string | null; close: string | null }>;
  bookingWindows?: {
    weekday: { earliestStart: string; latestStart: string };
    saturday: { earliestStart: string; latestStart: string };
  };
  minLeadTimeHours?: number;
  minGapBetweenAppointmentsMinutes?: number;
  appointmentTypes?: Record<string, { durationMinutes: number; colorId?: string }>;
  closedDates?: string[];
  availabilityBlocks?: Record<
    string,
    Array<{
      id: string;
      title: string;
      rrule: string;
      start?: string;
      end?: string;
      days?: string[];
    }>
  >;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PATH = dataPath("scheduler_config.json");

let cached: SchedulerConfig | null = null;
let rrCounter = 0;

export async function getSchedulerConfig(): Promise<SchedulerConfig> {
  if (cached) return cached;
  let parsed: SchedulerConfigRaw = {};
  try {
    const raw = await fs.readFile(process.env.SCHEDULER_CONFIG_PATH ?? DEFAULT_PATH, "utf8");
    parsed = JSON.parse(raw) as SchedulerConfigRaw;
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn("⚠️ Failed to load scheduler config:", err?.message ?? err);
    }
  }
  cached = {
    timezone: parsed.timezone ?? "America/New_York",
    assignmentMode: parsed.assignmentMode ?? "preferred",
    preferredSalespeople: parsed.preferredSalespeople ?? [],
    salespeople: parsed.salespeople ?? [],
    businessHours: parsed.businessHours ?? {},
    bookingWindows: parsed.bookingWindows ?? {
      weekday: { earliestStart: "09:30", latestStart: "17:00" },
      saturday: { earliestStart: "09:30", latestStart: "14:00" }
    },
    minLeadTimeHours: parsed.minLeadTimeHours ?? 4,
    minGapBetweenAppointmentsMinutes: parsed.minGapBetweenAppointmentsMinutes ?? 60,
    appointmentTypes: parsed.appointmentTypes ?? { inventory_visit: { durationMinutes: 60 } },
    closedDates: parsed.closedDates ?? [],
    availabilityBlocks: parsed.availabilityBlocks ?? {},
    ...parsed
  };
  return cached;
}

export async function saveSchedulerConfig(next: SchedulerConfigRaw): Promise<SchedulerConfig> {
  const filePath = process.env.SCHEDULER_CONFIG_PATH ?? DEFAULT_PATH;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(next ?? {}, null, 2), "utf8");
  cached = null;
  return await getSchedulerConfig();
}

export function dayKey(date: Date, timeZone: string): string {
  return date.toLocaleDateString("en-US", { weekday: "long", timeZone }).toLowerCase(); // "tuesday"
}

/* ------------------------------------------------------------------------------------------------
 * Business hours: ONE system of record.
 *
 * The console has TWO screens that both say "Business hours". Scheduler settings writes
 * `scheduler_config.businessHours` — the only hours ANY customer-facing answer reads
 * (formatBusinessHoursForReply, formatHoursRange, the draft prompt's `dealerHoursToday`) and the
 * only hours the booking engine offers slots from. Settings -> dealer profile writes
 * `dealer_profile.hours`, which the backend reads NOWHERE except its own save merge. So hours typed
 * into the dealer-profile screen save, persist, and render back — and the agent goes on quoting the
 * other file. That is Joe's "she keeps losing the hours" (2026-08-15): nothing is lost, it just
 * never reaches the agent.
 *
 * Measured on the live store the same day, both stores written by the same person from the same
 * two screens: dealer_profile.hours.monday.close = "06:00" (closes nine hours before it opens),
 * scheduler_config.businessHours.monday.close = "18:00". Same intent, two save paths — the console's
 * `normalizeBusinessHours` applies a 12-hour repair to a close that lands before its open, and it
 * was wired into the scheduler save ONLY. The profile save stored the raw pick.
 *
 * These three functions make the dealer-profile screen write through to the system of record, with
 * the repair on the server so it no longer depends on which console screen (or API caller) is used.
 * ---------------------------------------------------------------------------------------------- */

export type BusinessHoursDay = { open: string | null; close: string | null };
export type BusinessHoursMap = Record<string, BusinessHoursDay>;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function timeOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return /^\d{2}:\d{2}$/.test(text) ? text : null;
}

/**
 * Server-side twin of the console's `normalizeBusinessHours`, plus a validity gate.
 *
 * - Keeps only real weekday keys. `dealer_profile.hours` also carries a nested `sales` sub-block
 *   (a second writer with a different shape), which must never be mistaken for a day.
 * - Repairs a close that lands at or before its open by 12 hours: "09:00"-"06:00" -> "09:00"-"18:00".
 *   Someone picked 6 PM from a list that also offers 6 AM.
 * - Drops any day still invalid after the repair, and any half-filled day (one of open/close set).
 *   FAIL DIRECTION: a dropped day propagates NOTHING, so the system of record keeps the value it
 *   already had. Quoting a stale-but-sane range beats quoting a nonsense one.
 * - A day with BOTH sides explicitly null is kept — that is "closed", a real answer, not a gap.
 */
export function normalizeBusinessHoursMap(hours: unknown): BusinessHoursMap {
  const source = hours && typeof hours === "object" ? (hours as Record<string, any>) : {};
  const next: BusinessHoursMap = {};
  for (const day of WEEKDAYS) {
    if (!(day in source)) continue;
    const open = timeOrNull(source[day]?.open);
    let close = timeOrNull(source[day]?.close);
    if (open === null && close === null) {
      next[day] = { open: null, close: null };
      continue;
    }
    if (open === null || close === null) continue;
    if (close <= open) {
      const [h, m] = close.split(":").map(Number);
      const bumped = h + 12;
      if (!Number.isFinite(bumped) || bumped > 23) continue;
      close = `${String(bumped).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
    if (close <= open) continue;
    next[day] = { open, close };
  }
  return next;
}

/**
 * Merge, never replace. `dealer_profile.hours` was the ONE field in the profile save that took the
 * incoming object wholesale while `address`, `policies`, `voice` and `followUp` all spread-merge —
 * so a partial save wiped every day it did not send. That is a second, independent way to "lose the
 * hours", and it is why the nested `sales` block and the top-level days disagree today.
 */
export function mergeDealerProfileHours(current: unknown, incoming: unknown): Record<string, any> {
  const base = current && typeof current === "object" ? (current as Record<string, any>) : {};
  const next = incoming && typeof incoming === "object" ? (incoming as Record<string, any>) : null;
  return next ? { ...base, ...next } : { ...base };
}

/**
 * Propagate ONLY the days this save actually changed into `scheduler_config.businessHours`.
 *
 * Why only the changed days, and not the whole map: both screens are live, and the dealer-profile
 * screen loads its hours from `dealer_profile.hours`. If someone edits hours on the SCHEDULER screen
 * and later hits Save on the profile screen for an unrelated field, the profile screen would post
 * its stale copy. Writing the whole map through would silently overwrite the fresher value; writing
 * only what this request changed cannot. An unrelated profile save is a no-op here.
 *
 * Returns the merged profile hours so the caller stores them too — the profile keeps its own copy
 * (and its `sales` sub-block) untouched; it just stops being the only place the value lands.
 */
export async function reconcileDealerProfileHours(
  current: unknown,
  incoming: unknown
): Promise<Record<string, any>> {
  const merged = mergeDealerProfileHours(current, incoming);
  const before = normalizeBusinessHoursMap(current);
  const after = normalizeBusinessHoursMap(merged);
  const changed: BusinessHoursMap = {};
  for (const [day, val] of Object.entries(after)) {
    const prior = before[day];
    if (prior && prior.open === val.open && prior.close === val.close) continue;
    changed[day] = val;
  }
  if (!Object.keys(changed).length) return merged;
  const cfg = await getSchedulerConfig();
  await saveSchedulerConfig({
    ...(cfg as SchedulerConfigRaw),
    businessHours: { ...(cfg.businessHours ?? {}), ...changed }
  });
  console.log(
    `[dealer-profile] business hours written through to scheduler_config: ${Object.keys(changed).sort().join(", ")}`
  );
  return merged;
}

export function getPreferredSalespeople(cfg: SchedulerConfig): string[] {
  const fallback = cfg.salespeople?.map(s => s.id) ?? [];
  const base = cfg.preferredSalespeople?.length ? cfg.preferredSalespeople : fallback;
  if (cfg.assignmentMode !== "round_robin" || base.length <= 1) return base;
  const start = rrCounter % base.length;
  rrCounter += 1;
  return [...base.slice(start), ...base.slice(0, start)];
}
