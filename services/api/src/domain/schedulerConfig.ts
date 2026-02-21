import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type SchedulerConfig = {
  enabled?: boolean;
  interval_seconds?: number;
  start_hour_local?: number;
  end_hour_local?: number;
  timezone: string;
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
};

type SchedulerConfigRaw = {
  enabled?: boolean;
  interval_seconds?: number;
  start_hour_local?: number;
  end_hour_local?: number;
  timezone?: string;
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
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PATH = path.resolve(__dirname, "../../data/scheduler_config.json");

let cached: SchedulerConfig | null = null;

export async function getSchedulerConfig(): Promise<SchedulerConfig> {
  if (cached) return cached;
  const raw = await fs.readFile(process.env.SCHEDULER_CONFIG_PATH ?? DEFAULT_PATH, "utf8");
  const parsed = JSON.parse(raw) as SchedulerConfigRaw;
  cached = {
    timezone: parsed.timezone ?? "America/New_York",
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
    ...parsed
  };
  return cached;
}

export function dayKey(date: Date, timeZone: string): string {
  return date.toLocaleDateString("en-US", { weekday: "long", timeZone }).toLowerCase(); // "tuesday"
}
