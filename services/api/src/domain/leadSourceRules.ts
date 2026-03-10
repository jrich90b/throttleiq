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

const CHANNEL_RESOLUTION = {
  preferred_order: ["sms", "email", "facebook_messenger"] as LeadChannel[],
  fallback_if_missing_contact: "create_task",
  create_task_reason_codes: ["missing_phone_email", "facebook_only_lead", "crm_missing_fields"]
};

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
  }
];

function normalizeSource(source?: string) {
  return (source ?? "").trim();
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
  if (!source) return null;
  return RULES.find(rule => matchesRule(source, rule, sourceId)) ?? null;
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
