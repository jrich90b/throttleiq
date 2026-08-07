/**
 * Console Copilot Phase 2 — marketing-list generation (docs/console_copilot_phase2.md).
 *
 * Pure functions of (store records, suppression predicate, clock). This module PRODUCES
 * lists — nothing here sends, and nothing downstream of it may send automatically.
 *
 * FAIL DIRECTION (the reason the exclusion order below is law): every compliance check
 * fails toward a SMALLER list. Over-excluding costs one marketing touch; under-excluding
 * texts a customer who told us to stop. When in doubt a lead stays OFF the list.
 * Exclusions counted per row, checked in this order:
 *   1. missingContact — no phone (sms) / no email (email)
 *   2. optedOut       — the channel's intake opt-in flag is EXPLICITLY false
 *   3. suppressed     — the phone-level STOP list (sms only; the hardest no)
 *   4. watchOptOut    — the durable "stop alerting me" conversation flag
 */
import type { Conversation } from "./conversationStore.js";
import { isBareTrikeClassRequest, isTrikeClassModel, trikeClassConflict } from "./modelFamily.js";
import { isNonSalesConversation } from "./scoringExclusions.js";

export type MarketingListChannel = "sms" | "email";

export type MarketingListFilters = {
  channel: MarketingListChannel;
  /** Case-insensitive match against watch models/trims, the lead's inquiry vehicle, and
   *  the unit quoted on a call — scoped by `audienceModelMatches`, so a trike never lands in a
   *  two-wheel list (or the reverse) just because one name contains the other. */
  modelQuery?: string | null;
  /** "new" | "used" against the lead vehicle / watch condition. */
  condition?: string | null;
  /** Substring match on the lead source (e.g. "Facebook", "HDFS"). */
  source?: string | null;
  /** Only leads whose last customer reply is within N days. */
  activeWithinDays?: number | null;
  /** Closed leads are re-engagement candidates; default false = open leads only. */
  includeClosed?: boolean;
};

export type MarketingListRow = {
  convId: string;
  leadKey: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  source: string | null;
  modelInterest: string | null;
  lastInboundAt: string | null;
  status: "open" | "closed";
};

export type MarketingListExclusions = {
  missingContact: number;
  optedOut: number;
  suppressed: number;
  watchOptOut: number;
};

export type MarketingListResult = {
  generatedAt: string;
  channel: MarketingListChannel;
  totalConsidered: number;
  rows: MarketingListRow[];
  excluded: MarketingListExclusions;
};

function parseMs(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function lastInboundAt(conv: Conversation): string | null {
  const messages = conv.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.direction !== "in") continue;
    if (msg.provider === "payment_event") continue;
    if (parseMs(msg.at) == null) continue;
    return msg.at;
  }
  return null;
}

/**
 * Does one structured model interest satisfy the audience's model query?
 *
 * Substring alone is not enough. Joe, 2026-08-06: a list for "anyone who inquired about a new
 * Street Glide in the last 90 days" came back carrying **Street Glide 3 Limited** — which is a
 * TRIKE. "street glide" is literally inside that label, so `includes()` said yes. Measured on the
 * live store the same day: **22 of the 97 leads a "street glide" query matched were trikes** (21×
 * Street Glide 3 Limited incl. one CVO, 1× Street Glide Trike). Different bike, different buyer,
 * different pitch.
 *
 * The trike/two-wheel line is already settled DATA (Joe's rule 2026-07-04, `modelFamily`
 * `model_codes_by_family.json`) and the WATCH engine has scoped on it since — this filter simply
 * never asked. Joe, 2026-08-06: "This should probably use the same logic as the watches."
 *
 * Deterministic structured-extraction read (a catalog class lookup), not comprehension: the
 * customer's meaning is already resolved upstream by the copilot parser into `modelQuery`.
 *
 * FAIL DIRECTION — matches this module's law that every filter fails toward a SMALLER list, and
 * cannot over-narrow: `trikeClassConflict` returns true ONLY when BOTH labels resolve to a class,
 * so an unknown label, an unknown query, or a same-class pair all fall through to today's
 * substring behaviour. It can only ever drop a bike that is provably on the far side of the line.
 */
export function audienceModelMatches(
  modelLabel: string | null | undefined,
  modelQuery: string | null | undefined
): boolean {
  const query = String(modelQuery ?? "").trim().toLowerCase();
  if (!query) return true;
  const label = String(modelLabel ?? "");
  // A bare CLASS request is not a name to search for (Joe, 2026-08-06 — the mirror of the Street
  // Glide 3 defect). "anyone interested in a trike" must collect Street Glide 3 Limited, Tri
  // Glide and Freewheeler, and not one of those labels contains the word "trike"; a substring
  // test finds nobody. Only the TRIKE axis gets this lane — see isBareTrikeClassRequest for why a
  // general family lane would re-introduce the very bug this fixes.
  if (isBareTrikeClassRequest(query)) return isTrikeClassModel(label) === true;
  if (!label.toLowerCase().includes(query)) return false;
  return !trikeClassConflict(query, label);
}

/** Every structured place a model interest can live — never customer prose. */
function modelInterestCandidates(conv: Conversation): string[] {
  const out: string[] = [];
  const vehicle = conv.lead?.vehicle;
  if (vehicle) {
    const label = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (label) out.push(label);
  }
  const watches = [conv.inventoryWatch, ...(conv.inventoryWatches ?? [])];
  const seen = new Set<unknown>();
  for (const watch of watches) {
    if (!watch || seen.has(watch)) continue;
    seen.add(watch);
    const label = [watch.year, watch.make, watch.model, watch.trim].filter(Boolean).join(" ").trim();
    if (label) out.push(label);
  }
  const quoted = (conv as any).voiceFacts?.quotedUnit;
  if (typeof quoted === "string" && quoted.trim()) out.push(quoted.trim());
  return out;
}

function conditionCandidates(conv: Conversation): string[] {
  const out: string[] = [];
  const vehicleCondition = conv.lead?.vehicle?.condition;
  if (typeof vehicleCondition === "string" && vehicleCondition.trim()) out.push(vehicleCondition);
  for (const watch of [conv.inventoryWatch, ...(conv.inventoryWatches ?? [])]) {
    if (watch?.condition) out.push(String(watch.condition));
  }
  return out;
}

function matchesCondition(conv: Conversation, condition: string): boolean {
  const want = condition.trim().toLowerCase();
  if (!want) return true;
  return conditionCandidates(conv).some(c => {
    const have = c.toLowerCase();
    if (want === "used") return have.includes("used") || have.includes("pre-owned") || have.includes("preowned");
    return have.includes(want);
  });
}

export function buildMarketingList(
  convs: Conversation[],
  opts: {
    filters: MarketingListFilters;
    /** Phone-level STOP predicate (suppressionStore.isSuppressed — it normalizes). */
    isPhoneSuppressed: (phone: string) => boolean;
    nowMs: number;
    limit?: number;
  }
): MarketingListResult {
  const { filters, isPhoneSuppressed, nowMs } = opts;
  const excluded: MarketingListExclusions = {
    missingContact: 0,
    optedOut: 0,
    suppressed: 0,
    watchOptOut: 0
  };

  // One row per LEAD, not per conversation — keep the most recently updated thread.
  const byLead = new Map<string, Conversation>();
  for (const conv of convs) {
    if (conv.sale?.soldAt) continue; // sold customers are a different (post-sale) audience
    if (conv.status === "closed" && !filters.includeClosed) continue;
    if (isNonSalesConversation(conv)) continue;
    const key = conv.leadKey || conv.id;
    const prev = byLead.get(key);
    if (!prev || (parseMs(conv.updatedAt) ?? 0) > (parseMs(prev.updatedAt) ?? 0)) {
      byLead.set(key, conv);
    }
  }

  const modelQuery = (filters.modelQuery ?? "").trim().toLowerCase();
  const sourceQuery = (filters.source ?? "").trim().toLowerCase();
  const condition = (filters.condition ?? "").trim();
  const windowDays = filters.activeWithinDays ?? null;

  let totalConsidered = 0;
  const rows: MarketingListRow[] = [];
  for (const conv of byLead.values()) {
    totalConsidered++;

    // ── Audience filters (not compliance — a miss here just narrows the list) ──
    const models = modelInterestCandidates(conv);
    if (modelQuery && !models.some(m => audienceModelMatches(m, modelQuery))) continue;
    if (condition && !matchesCondition(conv, condition)) continue;
    const source = conv.lead?.source ?? null;
    if (sourceQuery && !String(source ?? "").toLowerCase().includes(sourceQuery)) continue;
    const inboundAt = lastInboundAt(conv);
    if (windowDays != null) {
      const inboundMs = parseMs(inboundAt);
      if (inboundMs == null || nowMs - inboundMs > windowDays * 86_400_000) continue;
    }

    // ── Compliance exclusions — order is law (see header). Each row counts ONCE. ──
    const phone = conv.lead?.phone?.trim() || null;
    const email = conv.lead?.email?.trim() || null;
    if (filters.channel === "sms") {
      if (!phone) {
        excluded.missingContact++;
        continue;
      }
      if (conv.lead?.smsOptIn === false) {
        excluded.optedOut++;
        continue;
      }
      if (isPhoneSuppressed(phone)) {
        excluded.suppressed++;
        continue;
      }
    } else {
      if (!email) {
        excluded.missingContact++;
        continue;
      }
      if (conv.lead?.emailOptIn === false) {
        excluded.optedOut++;
        continue;
      }
    }
    if ((conv as any).inventoryWatchOptOut) {
      excluded.watchOptOut++;
      continue;
    }

    rows.push({
      convId: conv.id,
      leadKey: conv.leadKey || conv.id,
      name: conv.lead?.name ?? null,
      phone,
      email,
      source,
      modelInterest: models[0] ?? null,
      lastInboundAt: inboundAt,
      status: conv.status === "closed" ? "closed" : "open"
    });
  }

  rows.sort((a, b) => (b.lastInboundAt ?? "").localeCompare(a.lastInboundAt ?? ""));
  const limit = Math.max(1, opts.limit ?? 500);
  return {
    generatedAt: new Date(nowMs).toISOString(),
    channel: filters.channel,
    totalConsidered,
    rows: rows.slice(0, limit),
    excluded
  };
}
