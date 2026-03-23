import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type DealerProfile = {
  dealerName?: string;
  agentName?: string;
  crmProvider?: string;
  websiteProvider?: string;
  fromEmail?: string;
  replyToEmail?: string;
  emailProvider?: "sendgrid" | "smtp";
  emailSignature?: string;
  logoUrl?: string;
  bookingUrl?: string;
  bookingToken?: string;
  address?: { line1?: string; city?: string; state?: string; zip?: string; country?: string };
  phone?: string;
  website?: string;
  directionsUrl?: string;
  hours?: Record<string, any>;
  policies?: Record<string, any>;
  voice?: Record<string, any>;
  followUp?: {
    testRideEnabled?: boolean;
    testRideMonths?: number[];
  };
  weather?: {
    zip?: string;
    latitude?: number;
    longitude?: number;
    coldThresholdF?: number;
    forecastHours?: number;
    pickupRadiusMiles?: number;
  };
  buying?: {
    usedBikesEnabled?: boolean;
  };
  taxRate?: number;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// dealerProfile.ts lives in: services/api/src/domain
// file lives in: services/api/data/dealer_profile.json
const DEFAULT_PATH = path.resolve(__dirname, "../../data/dealer_profile.json");

let cached: DealerProfile | null = null;
let cachedPath: string | null = null;

export async function getDealerProfile(): Promise<DealerProfile | null> {
  const filePath = process.env.DEALER_PROFILE_PATH
    ? path.resolve(process.env.DEALER_PROFILE_PATH)
    : DEFAULT_PATH;

  // Only return cache if it's non-empty AND the path hasn't changed
  if (cached && Object.keys(cached).length > 0 && cachedPath === filePath) {
    return cached;
  }

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as DealerProfile;

    // If file is empty object, treat as missing (do not cache)
    if (!parsed || Object.keys(parsed).length === 0) {
      return {};
    }

    cached = parsed;
    cachedPath = filePath;
    return cached;
  } catch {
    return null;
  }
}

export async function saveDealerProfile(profile: DealerProfile): Promise<DealerProfile> {
  const filePath = process.env.DEALER_PROFILE_PATH
    ? path.resolve(process.env.DEALER_PROFILE_PATH)
    : DEFAULT_PATH;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(profile ?? {}, null, 2), "utf8");
  cached = profile ?? {};
  cachedPath = filePath;
  return cached;
}
