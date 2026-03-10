import fs from "node:fs";
import { dataPath } from "./dataDir.js";

export type LeadChannel = "sms" | "email" | "facebook_messenger" | "phone" | "task";
export type LeadBucket =
  | "inventory_interest"
  | "finance_prequal"
  | "trade_in_sell"
  | "test_ride"
  | "service"
  | "event_promo"
  | "general_inquiry"
  | "callback_request"
  | "in_store";

export type LeadCTA =
  | "check_availability"
  | "request_details"
  | "request_a_quote"
  | "schedule_test_ride"
  | "hdfs_coa"
  | "prequalify"
  | "value_my_trade"
  | "sell_my_bike"
  | "service_request"
  | "event_rsvp"
  | "sweepstakes"
  | "contact_us"
  | "callback"
  | "unknown";

type LeadTone = "short_conversational" | "professional_privacy_forward" | "neutral";

type RuleMatch = {
  equals?: string[];
  prefix?: string[];
  sourceIds?: number[];
};

type LeadRule = {
  name: string;
  match: RuleMatch;
  bucket: LeadBucket;
  cta: LeadCTA;
  tone: LeadTone;
  primary_channel?: LeadChannel;
  channel_overrides?: {
    fallback_order?: LeadChannel[];
  };
  appointment_close?: {
    priority: "high" | "normal" | "low";
    provide_two_time_options?: boolean;
    call_first?: boolean;
  };
  data_quality_flags?: string[];
  missing_data_prompts?: {
    missingPhoneEmail?: string;
    missingStock?: string;
  };
};

type LeadSourceCatalogEntry = {
  leadType?: string;
  sourceType?: string;
  source?: string;
  sourceId?: number;
};

const CHANNEL_RESOLUTION = {
  preferred_order: ["sms", "email", "facebook_messenger"] as LeadChannel[],
  fallback_if_missing_contact: "create_task",
  create_task_reason_codes: ["missing_phone_email", "facebook_only_lead", "crm_missing_fields"]
};

type CatalogIndex = {
  entries: LeadSourceCatalogEntry[];
  byId: Map<number, LeadSourceCatalogEntry>;
  bySource: Map<string, LeadSourceCatalogEntry>;
};

let catalogCache: CatalogIndex | null = null;

function loadCatalog(): CatalogIndex {
  if (catalogCache) return catalogCache;

  const entries: LeadSourceCatalogEntry[] = [];
  const byId = new Map<number, LeadSourceCatalogEntry>();
  const bySource = new Map<string, LeadSourceCatalogEntry>();

  const files = ["lead_sources/hdmc.json"];
  let crm = process.env.CRM_PROVIDER?.trim().toLowerCase();
  if (!crm) {
    try {
      const profilePath = dataPath("dealer_profile.json");
      if (fs.existsSync(profilePath)) {
        const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
        const fromProfile = String(profile?.crmProvider ?? "").trim().toLowerCase();
        if (fromProfile) crm = fromProfile;
      }
    } catch {
      // ignore dealer profile read errors
    }
  }
  if (crm) files.push(`lead_sources/${crm}.json`);

  for (const rel of files) {
    const fullPath = dataPath(rel);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const raw = fs.readFileSync(fullPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) continue;
      for (const entry of parsed) {
        if (!entry || typeof entry !== "object") continue;
        const sourceId =
          typeof entry.sourceId === "number"
            ? entry.sourceId
            : Number.isFinite(Number(entry.sourceId))
            ? Number(entry.sourceId)
            : undefined;
        const source = typeof entry.source === "string" ? entry.source : undefined;
        const normalizedSource = source?.trim() ? source.trim().toLowerCase() : undefined;
        const leadEntry: LeadSourceCatalogEntry = {
          leadType: typeof entry.leadType === "string" ? entry.leadType : undefined,
          sourceType: typeof entry.sourceType === "string" ? entry.sourceType : undefined,
          source,
          sourceId
        };
        entries.push(leadEntry);
        if (sourceId != null && !Number.isNaN(sourceId) && !byId.has(sourceId)) {
          byId.set(sourceId, leadEntry);
        }
        if (normalizedSource && !bySource.has(normalizedSource)) {
          bySource.set(normalizedSource, leadEntry);
        }
      }
    } catch {
      // ignore malformed catalog entries
    }
  }

  catalogCache = { entries, byId, bySource };
  return catalogCache;
}

const RULES: LeadRule[] = [
  {
    name: "facebook_raq",
    match: { equals: ["Facebook - RAQ"] },
    bucket: "inventory_interest",
    cta: "check_availability",
    tone: "short_conversational"
  },
  {
    name: "hdfs_coa_online",
    match: { equals: ["HDFS COA Online"], sourceIds: [2852] },
    bucket: "finance_prequal",
    cta: "hdfs_coa",
    tone: "professional_privacy_forward",
    appointment_close: {
      priority: "high",
      provide_two_time_options: true,
      call_first: true
    }
  },
  {
    name: "hdfs_marketplace_apply_credit",
    match: { equals: ["HDFS MARKETPLACE - APPLY FOR CREDIT"], sourceIds: [2883] },
    bucket: "finance_prequal",
    cta: "prequalify",
    tone: "professional_privacy_forward",
    appointment_close: {
      priority: "high",
      provide_two_time_options: true,
      call_first: true
    }
  },
  {
    name: "hdfs_marketplace_prequal",
    match: { equals: ["HDFS MARKETPLACE - PREQUAL"], sourceIds: [2915] },
    bucket: "finance_prequal",
    cta: "prequalify",
    tone: "professional_privacy_forward",
    appointment_close: {
      priority: "high",
      provide_two_time_options: true,
      call_first: true
    }
  },
  {
    name: "hdmc_new_vehicle_prequal",
    match: { equals: ["HDMC NEW VEHICLE - PREQUALIFY"], sourceIds: [2946] },
    bucket: "finance_prequal",
    cta: "prequalify",
    tone: "professional_privacy_forward",
    appointment_close: {
      priority: "high",
      provide_two_time_options: true,
      call_first: true
    }
  },
  {
    name: "dealer_lead_app_prequal",
    match: { equals: ["DEALER LEAD APP - PREQUALIFY"], sourceIds: [2949] },
    bucket: "finance_prequal",
    cta: "prequalify",
    tone: "professional_privacy_forward",
    appointment_close: {
      priority: "high",
      provide_two_time_options: true,
      call_first: true
    }
  },
  {
    name: "dfi_credit_application",
    match: { equals: ["DFI Credit Application"], sourceIds: [2955] },
    bucket: "finance_prequal",
    cta: "prequalify",
    tone: "professional_privacy_forward",
    appointment_close: {
      priority: "high",
      provide_two_time_options: true,
      call_first: true
    }
  },
  {
    name: "dfi_deal_submission",
    match: { equals: ["DFI Deal Submission"], sourceIds: [2956] },
    bucket: "finance_prequal",
    cta: "prequalify",
    tone: "professional_privacy_forward",
    appointment_close: {
      priority: "high",
      provide_two_time_options: true,
      call_first: true
    }
  },
  {
    name: "dfi_callback_request",
    match: { equals: ["DFI Callback Request"], sourceIds: [2957] },
    bucket: "callback_request",
    cta: "callback",
    tone: "professional_privacy_forward"
  },
  {
    name: "hdmc_test_ride_request",
    match: { equals: ["HD.COM ONLINE TEST RIDE REQUEST", "Test Ride Request - H-D.com (Test Ride Booking Form)", "DEALER DEMO RIDE"], sourceIds: [2814, 2864, 2813] },
    bucket: "test_ride",
    cta: "schedule_test_ride",
    tone: "short_conversational"
  },
  {
    name: "hdmc_request_a_quote",
    match: { equals: ["HD.COM REQUEST A QUOTE", "HDMC Google - Request a Quote"], sourceIds: [2862, 2981] },
    bucket: "inventory_interest",
    cta: "request_a_quote",
    tone: "short_conversational"
  },
  {
    name: "hdfs_coa_online",
    match: { equals: ["HDFS COA Online"] },
    bucket: "finance_prequal",
    cta: "hdfs_coa",
    tone: "professional_privacy_forward",
    appointment_close: {
      priority: "high",
      provide_two_time_options: true,
      call_first: false
    }
  },
  {
    name: "autodealers_digital",
    match: {
      equals: ["AutoDealers.Digital - autodealersdigital.com"],
      prefix: ["AutoDealers.Digital"]
    },
    bucket: "inventory_interest",
    cta: "check_availability",
    tone: "short_conversational",
    data_quality_flags: ["often_missing_phone", "often_missing_email", "often_missing_stock"],
    missing_data_prompts: {
      missingPhoneEmail: "Please provide a good phone or email so we can follow up quickly.",
      missingStock: "Can you share the stock number or link for the bike you want?"
    }
  },
  {
    name: "room58_sell_vehicle",
    match: {
      equals: ["Room58 - Sell your vehicle"],
      prefix: ["Room58 - Sell"]
    },
    bucket: "trade_in_sell",
    cta: "sell_my_bike",
    tone: "short_conversational"
  },
  {
    name: "room58_book_test_ride",
    match: { equals: ["Room58 - Book test ride"], sourceIds: [2776] },
    bucket: "test_ride",
    cta: "schedule_test_ride",
    tone: "short_conversational"
  }
];

function normalizeSource(source?: string) {
  return (source ?? "").trim();
}

function inferFromCatalog(entry: LeadSourceCatalogEntry): LeadRule | null {
  const source = entry.source ?? "";
  const normalized = source.toLowerCase();

  const mkRule = (bucket: LeadBucket, cta: LeadCTA, tone: LeadTone): LeadRule => ({
    name: `catalog_${entry.sourceId ?? (normalized || "unknown")}`,
    match: { sourceIds: entry.sourceId ? [entry.sourceId] : undefined, equals: source ? [source] : undefined },
    bucket,
    cta,
    tone
  });

  if (/test ride/.test(normalized)) {
    return mkRule("test_ride", "schedule_test_ride", "short_conversational");
  }

  if (/credit|prequal|pre-qual|finance|apply for credit|credit app|coa/.test(normalized)) {
    return mkRule("finance_prequal", /coa/.test(normalized) ? "hdfs_coa" : "prequalify", "professional_privacy_forward");
  }

  if (/sell my bike|sell your bike|sell your vehicle/.test(normalized)) {
    return mkRule("trade_in_sell", "sell_my_bike", "short_conversational");
  }

  if (/value my trade|value your trade|trade[- ]?in|trade\b/.test(normalized)) {
    return mkRule("trade_in_sell", "value_my_trade", "short_conversational");
  }

  if (/service/.test(normalized)) {
    return mkRule("service", "service_request", "short_conversational");
  }

  if (/sweepstakes|sweeps/.test(normalized)) {
    return mkRule("event_promo", "sweepstakes", "short_conversational");
  }

  if (/event|rsvp|demo ride/.test(normalized)) {
    return mkRule("event_promo", "event_rsvp", "short_conversational");
  }

  if (/request a quote|get price|price|quote|estimate payment/.test(normalized)) {
    return mkRule("inventory_interest", "request_a_quote", "short_conversational");
  }

  if (/check availability|request details|request more info|bike finder|inventory/.test(normalized)) {
    return mkRule("inventory_interest", "check_availability", "short_conversational");
  }

  if (/contact|ask a question|general inquiry/.test(normalized)) {
    return mkRule("general_inquiry", "contact_us", "short_conversational");
  }

  return null;
}

function matchesRule(source: string, rule: LeadRule, sourceId?: number | null): boolean {
  const { equals, prefix } = rule.match;
  if (rule.match.sourceIds && sourceId != null) {
    if (rule.match.sourceIds.includes(sourceId)) return true;
  }
  if (equals?.some(v => v.toLowerCase() === source.toLowerCase())) return true;
  if (prefix?.some(v => source.toLowerCase().startsWith(v.toLowerCase()))) return true;
  return false;
}

function findRule(leadSource?: string, sourceId?: number | null): LeadRule | null {
  const source = normalizeSource(leadSource);
  const directRule = RULES.find(rule => matchesRule(source, rule, sourceId)) ?? null;
  if (directRule) return directRule;

  const catalog = loadCatalog();
  if (sourceId != null) {
    const entry = catalog.byId.get(sourceId);
    if (entry) return inferFromCatalog(entry);
  }

  if (source) {
    const entry = catalog.bySource.get(source.toLowerCase());
    if (entry) return inferFromCatalog(entry);
  }

  return null;
}

export function resolveLeadRule(leadSource?: string, sourceId?: number | null): {
  bucket: LeadBucket;
  cta: LeadCTA;
  tone: LeadTone;
  ruleName: string;
} {
  const rule = findRule(leadSource, sourceId);
  if (rule) {
    return { bucket: rule.bucket, cta: rule.cta, tone: rule.tone, ruleName: rule.name };
  }

  return {
    bucket: "general_inquiry",
    cta: "unknown",
    tone: "neutral",
    ruleName: "default"
  };
}

type ChannelOpts = {
  leadSource?: string;
  sourceId?: number | null;
  hasSms?: boolean;
  hasEmail?: boolean;
  hasFacebook?: boolean;
  hasPhone?: boolean;
  primaryChannel?: LeadChannel;
};

function isChannelAvailable(channel: LeadChannel, opts: ChannelOpts): boolean {
  if (channel === "sms") return !!opts.hasSms;
  if (channel === "email") return !!opts.hasEmail;
  if (channel === "facebook_messenger") return !!opts.hasFacebook;
  if (channel === "phone") return !!opts.hasPhone || !!opts.hasSms;
  return true;
}

export function resolveChannel(opts: ChannelOpts): LeadChannel {
  const rule = findRule(opts.leadSource, opts.sourceId);
  const order = rule?.channel_overrides?.fallback_order ?? CHANNEL_RESOLUTION.preferred_order;

  for (const channel of order) {
    if (isChannelAvailable(channel, opts)) return channel;
  }

  return "task";
}

// Dev checks (manual):
// resolveChannel({ leadSource: "Facebook - RAQ", hasSms: true, hasEmail: true, hasFacebook: true }) -> "sms"
// resolveChannel({ leadSource: "Facebook - RAQ", hasSms: false, hasEmail: true, hasFacebook: true }) -> "email"
// resolveChannel({ leadSource: "Facebook - RAQ", hasSms: false, hasEmail: false, hasFacebook: true }) -> "facebook_messenger"
