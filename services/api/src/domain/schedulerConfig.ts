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
  appointmentTypes: Record<string, { durationMinutes: number }>;
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
  appointmentTypes?: Record<string, { durationMinutes: number }>;
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

export function getPreferredSalespeople(cfg: SchedulerConfig): string[] {
  const fallback = cfg.salespeople?.map(s => s.id) ?? [];
  const base = cfg.preferredSalespeople?.length ? cfg.preferredSalespeople : fallback;
  if (cfg.assignmentMode !== "round_robin" || base.length <= 1) return base;
  const start = rrCounter % base.length;
  rrCounter += 1;
  return [...base.slice(start), ...base.slice(0, start)];
}
