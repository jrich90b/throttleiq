import type { Conversation, Message } from "./conversationStore.js";
import { dayKey } from "./schedulerConfig.js";
import { localPartsToUtcDate } from "./schedulerEngine.js";

type LeadTypeFilter = "all" | "new" | "used" | "walk_in";
type LeadScopeFilter = "online_only" | "include_walkins" | "walkin_only";

type BusinessHoursConfig = {
  timezone: string;
  businessHours: Record<string, { open: string | null; close: string | null }>;
};
const FALLBACK_TIMEZONE = "America/New_York";

export type KpiFilters = {
  from?: string;
  to?: string;
  source?: string;
  ownerId?: string;
  leadType?: LeadTypeFilter;
  leadScope?: LeadScopeFilter;
};

export type KpiTotals = {
  leadVolume: number;
  respondedCount: number;
  responseRatePct: number;
  avgFirstResponseMinutes: number | null;
  medianFirstResponseMinutes: number | null;
  callCount: number;
  callRatePct: number;
  avgTimeToCallMinutes: number | null;
  medianTimeToCallMinutes: number | null;
  appointmentCount: number;
  appointmentRatePct: number;
  soldCount: number;
  soldCloseRatePct: number;
  closedCount: number;
  closeRatePct: number;
  avgTimeToCloseDays: number | null;
  medianTimeToCloseDays: number | null;
  closeRate30dPct: number;
  closeRate60dPct: number;
  closeRate90dPct: number;
  closeRate120dPct: number;
};

export type KpiSourceRow = {
  source: string;
  leadCount: number;
  responseRatePct: number;
  appointmentRatePct: number;
  callRatePct: number;
  soldCloseRatePct: number;
};

export type KpiTrendRow = {
  day: string;
  leadCount: number;
  respondedCount: number;
  responseRatePct: number;
  appointmentCount: number;
  callCount: number;
  soldCount: number;
};

export type KpiBikeRow = {
  motorcycle: string;
  count: number;
  newCount: number;
  usedCount: number;
};

export type KpiCallDetailRow = {
  convId: string;
  leadKey: string;
  leadName: string;
  leadPhone: string;
  source: string;
  ownerId: string;
  ownerName: string;
  firstInboundAt: string | null;
  firstCallAt: string | null;
  timeToCallMinutes: number | null;
};

export type KpiOverview = {
  applied: {
    from: string;
    to: string;
    source: string;
    ownerId: string;
    leadType: LeadTypeFilter;
    leadScope: LeadScopeFilter;
  };
  totals: KpiTotals;
  bySource: KpiSourceRow[];
  topMotorcycles: KpiBikeRow[];
  trend: KpiTrendRow[];
  callDetails: KpiCallDetailRow[];
};

export type KpiOverviewOptions = {
  businessHours?: BusinessHoursConfig | null;
};

type LeadStatsRow = {
  convId: string;
  leadKey: string;
  leadName: string;
  leadPhone: string;
  source: string;
  ownerId: string;
  ownerName: string;
  firstInboundAt: string | null;
  firstCallAt: string | null;
  motorcycle: string;
  createdAtMs: number;
  responded: boolean;
  responseMinutes: number | null;
  called: boolean;
  timeToCallMinutes: number | null;
  appointment: boolean;
  closed: boolean;
  sold: boolean;
  timeToCloseDays: number | null;
  soldWithin30: boolean;
  soldWithin60: boolean;
  soldWithin90: boolean;
  soldWithin120: boolean;
  condition: "new" | "used" | "unknown";
};

function toMs(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeTimeZone(raw: string | null | undefined): string {
  const tz = String(raw ?? "").trim() || FALLBACK_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    return FALLBACK_TIMEZONE;
  }
}

function parseHm(raw: string | null | undefined): { h: number; m: number } | null {
  const txt = String(raw ?? "").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(txt);
  if (!m) return null;
  const h = Number(m[1]);
  const mins = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mins)) return null;
  if (h < 0 || h > 23 || mins < 0 || mins > 59) return null;
  return { h, m: mins };
}

function getZonedParts(date: Date, timeZone: string) {
  const safeTz = normalizeTimeZone(timeZone);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = fmt.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute)
  };
}

function startOfLocalDayMs(ms: number, cfg: BusinessHoursConfig): number {
  const local = getZonedParts(new Date(ms), cfg.timezone);
  return localPartsToUtcDate(cfg.timezone, {
    year: local.year,
    month: local.month,
    day: local.day,
    hour24: 0,
    minute: 0
  }).getTime();
}

function localDayOffsetMs(ms: number, cfg: BusinessHoursConfig, days: number): number {
  const local = getZonedParts(new Date(ms), cfg.timezone);
  const d = new Date(Date.UTC(local.year, local.month - 1, local.day + days));
  return localPartsToUtcDate(cfg.timezone, {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour24: 0,
    minute: 0
  }).getTime();
}

function getBusinessWindowMs(dayMs: number, cfg: BusinessHoursConfig): { openMs: number; closeMs: number } | null {
  const dayDate = new Date(dayMs);
  const safeTz = normalizeTimeZone(cfg.timezone);
  const key = dayKey(dayDate, safeTz);
  const hours = cfg.businessHours?.[key];
  if (!hours?.open || !hours?.close) return null;
  const openHm = parseHm(hours.open);
  const closeHm = parseHm(hours.close);
  if (!openHm || !closeHm) return null;
  const local = getZonedParts(dayDate, cfg.timezone);
  const openMs = localPartsToUtcDate(safeTz, {
    year: local.year,
    month: local.month,
    day: local.day,
    hour24: openHm.h,
    minute: openHm.m
  }).getTime();
  const closeMs = localPartsToUtcDate(safeTz, {
    year: local.year,
    month: local.month,
    day: local.day,
    hour24: closeHm.h,
    minute: closeHm.m
  }).getTime();
  if (!(closeMs > openMs)) return null;
  return { openMs, closeMs };
}

function nextBusinessOpenMs(fromMs: number, cfg: BusinessHoursConfig): number | null {
  const baseDay = startOfLocalDayMs(fromMs, cfg);
  for (let i = 0; i < 14; i++) {
    const dayMs = localDayOffsetMs(baseDay, cfg, i);
    const window = getBusinessWindowMs(dayMs, cfg);
    if (!window) continue;
    if (fromMs <= window.openMs) return window.openMs;
    if (fromMs > window.openMs && fromMs < window.closeMs) return fromMs;
  }
  return null;
}

function elapsedBusinessMinutes(startMs: number, endMs: number, cfg: BusinessHoursConfig | null | undefined): number {
  if (!(endMs > startMs)) return 0;
  if (!cfg || !cfg.businessHours || !Object.keys(cfg.businessHours).length) {
    return (endMs - startMs) / (1000 * 60);
  }
  const safeCfg: BusinessHoursConfig = {
    timezone: normalizeTimeZone(cfg.timezone),
    businessHours: cfg.businessHours
  };

  let cursor = nextBusinessOpenMs(startMs, safeCfg);
  if (cursor == null || cursor >= endMs) return 0;
  let totalMs = 0;

  for (let guard = 0; guard < 5000 && cursor < endMs; guard++) {
    const dayMs = startOfLocalDayMs(cursor, safeCfg);
    const window = getBusinessWindowMs(dayMs, safeCfg);
    if (!window || cursor >= window.closeMs) {
      const next = nextBusinessOpenMs(cursor + 60_000, safeCfg);
      if (next == null || next <= cursor) break;
      cursor = next;
      continue;
    }
    if (cursor < window.openMs) cursor = window.openMs;
    if (cursor >= endMs) break;
    const segmentEnd = Math.min(endMs, window.closeMs);
    if (segmentEnd > cursor) totalMs += segmentEnd - cursor;
    if (segmentEnd >= endMs) break;
    const next = nextBusinessOpenMs(window.closeMs + 60_000, safeCfg);
    if (next == null || next <= segmentEnd) break;
    cursor = next;
  }

  return totalMs / (1000 * 60);
}

function clampPct(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function avg(values: number[]): number | null {
  if (!values.length) return null;
  return Number((values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(2));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const val =
    sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return Number(val.toFixed(2));
}

function firstInbound(messages: Message[]): number | null {
  let best: number | null = null;
  for (const m of messages) {
    if (m.direction !== "in") continue;
    const ms = toMs(m.at);
    if (ms == null) continue;
    if (best == null || ms < best) best = ms;
  }
  return best;
}

function firstOutboundResponse(messages: Message[], inboundAtMs: number | null): number | null {
  let best: number | null = null;
  for (const m of messages) {
    if (m.direction !== "out") continue;
    const provider = String(m.provider ?? "").toLowerCase();
    // "draft_ai" is unsent draft and shouldn't count as response KPI.
    if (provider === "draft_ai") continue;
    const ms = toMs(m.at);
    if (ms == null) continue;
    if (inboundAtMs != null && ms < inboundAtMs) continue;
    if (best == null || ms < best) best = ms;
  }
  return best;
}

function firstCallAttempt(messages: Message[], inboundAtMs: number | null): number | null {
  let best: number | null = null;
  for (const m of messages) {
    if (m.direction !== "out") continue;
    const provider = String(m.provider ?? "").toLowerCase();
    if (provider !== "voice_call") continue;
    const ms = toMs(m.at);
    if (ms == null) continue;
    if (inboundAtMs != null && ms < inboundAtMs) continue;
    if (best == null || ms < best) best = ms;
  }
  return best;
}

function sourceLabel(conv: Conversation): string {
  const src = String(conv.lead?.source ?? "").trim();
  return src || "Unknown";
}

function isWalkIn(conv: Conversation): boolean {
  if (conv.lead?.walkIn) return true;
  return /traffic log pro/i.test(String(conv.lead?.source ?? ""));
}

function normalizeCondition(conv: Conversation): "new" | "used" | "unknown" {
  const raw = String(conv.lead?.vehicle?.condition ?? "").trim().toLowerCase();
  if (raw === "new") return "new";
  if (raw === "used" || raw === "preowned" || raw === "pre-owned") return "used";
  return "unknown";
}

function motorcycleLabel(conv: Conversation): string {
  const year = String(conv.lead?.vehicle?.year ?? "").trim();
  const make = String(conv.lead?.vehicle?.make ?? "").trim();
  const model = String(conv.lead?.vehicle?.model ?? "").trim();
  const trim = String(conv.lead?.vehicle?.trim ?? "").trim();
  const description = String(conv.lead?.vehicle?.description ?? "").trim();
  const core = [year, make, model, trim].filter(Boolean).join(" ").trim();
  if (core) return core.replace(/\s+/g, " ");
  if (description) return description.replace(/\s+/g, " ");
  return "Unknown motorcycle";
}

function leadDisplayName(conv: Conversation): string {
  const first = String(conv.lead?.firstName ?? "").trim();
  const last = String(conv.lead?.lastName ?? "").trim();
  const combined = [first, last].filter(Boolean).join(" ").trim();
  if (combined) return combined;
  const fallback = String((conv.lead as any)?.name ?? "").trim();
  if (fallback) return fallback;
  return String(conv.leadKey ?? conv.id ?? "Unknown lead").trim();
}

function leadMatchesFilters(
  conv: Conversation,
  filters: KpiFilters,
  fromBoundMs: number,
  toBoundMs: number
): boolean {
  const createdMs = toMs(conv.createdAt);
  if (createdMs == null) return false;
  if (createdMs < fromBoundMs || createdMs > toBoundMs) return false;

  const sourceFilter = String(filters.source ?? "all").trim().toLowerCase();
  if (sourceFilter && sourceFilter !== "all") {
    if (sourceLabel(conv).toLowerCase() !== sourceFilter) return false;
  }

  const ownerFilter = String(filters.ownerId ?? "all").trim();
  if (ownerFilter && ownerFilter !== "all") {
    const ownerId = String(conv.leadOwner?.id ?? "").trim();
    if (!ownerId || ownerId !== ownerFilter) return false;
  }

  const leadType = (String(filters.leadType ?? "all").trim().toLowerCase() || "all") as LeadTypeFilter;
  const leadScope = (String(filters.leadScope ?? "include_walkins").trim().toLowerCase() ||
    "include_walkins") as LeadScopeFilter;
  if (leadScope === "online_only" && isWalkIn(conv)) return false;
  if (leadScope === "walkin_only" && !isWalkIn(conv)) return false;
  if (leadType === "walk_in" && !isWalkIn(conv)) return false;
  if (leadType === "new" && normalizeCondition(conv) !== "new") return false;
  if (leadType === "used" && normalizeCondition(conv) !== "used") return false;

  return true;
}

function toLeadStats(conv: Conversation, opts: KpiOverviewOptions): LeadStatsRow {
  const inboundAt = firstInbound(conv.messages);
  const outboundAt = firstOutboundResponse(conv.messages, inboundAt);
  const callAt = firstCallAttempt(conv.messages, inboundAt);
  const createdAt = toMs(conv.createdAt);
  const soldAt = toMs(conv.sale?.soldAt) ?? (conv.closedReason === "sold" ? toMs(conv.closedAt) : null);
  const closedAt = toMs(conv.closedAt);
  const sold = soldAt != null;
  const closed = String(conv.status ?? "").toLowerCase() === "closed";

  const responseMinutes =
    inboundAt != null && outboundAt != null
      ? Math.max(0, elapsedBusinessMinutes(inboundAt, outboundAt, opts.businessHours))
      : null;
  const callMinutes =
    inboundAt != null && callAt != null
      ? Math.max(0, elapsedBusinessMinutes(inboundAt, callAt, opts.businessHours))
      : null;
  const closeDays =
    createdAt != null && soldAt != null ? Math.max(0, (soldAt - createdAt) / (1000 * 60 * 60 * 24)) : null;

  return {
    convId: String(conv.id ?? ""),
    leadKey: String(conv.leadKey ?? conv.id ?? ""),
    leadName: leadDisplayName(conv),
    leadPhone: String(conv.lead?.phone ?? "").trim(),
    source: sourceLabel(conv),
    ownerId: String(conv.leadOwner?.id ?? "").trim(),
    ownerName: String(conv.leadOwner?.name ?? "").trim(),
    firstInboundAt: inboundAt != null ? new Date(inboundAt).toISOString() : null,
    firstCallAt: callAt != null ? new Date(callAt).toISOString() : null,
    motorcycle: motorcycleLabel(conv),
    createdAtMs: createdAt ?? Date.now(),
    responded: outboundAt != null,
    responseMinutes: responseMinutes != null ? Number(responseMinutes.toFixed(2)) : null,
    called: callAt != null,
    timeToCallMinutes: callMinutes != null ? Number(callMinutes.toFixed(2)) : null,
    appointment: String(conv.appointment?.status ?? "").toLowerCase() === "confirmed",
    closed,
    sold,
    timeToCloseDays: closeDays != null ? Number(closeDays.toFixed(2)) : null,
    soldWithin30: closeDays != null && closeDays <= 30,
    soldWithin60: closeDays != null && closeDays <= 60,
    soldWithin90: closeDays != null && closeDays <= 90,
    soldWithin120: closeDays != null && closeDays <= 120,
    condition: normalizeCondition(conv)
  };
}

export function buildKpiOverview(
  conversations: Conversation[],
  filters: KpiFilters = {},
  opts: KpiOverviewOptions = {}
): KpiOverview {
  const now = new Date();
  const toMsRaw = toMs(filters.to) ?? now.getTime();
  const fromMsRaw = toMs(filters.from) ?? toMsRaw - 30 * 24 * 60 * 60 * 1000;
  const fromBoundMs = Math.min(fromMsRaw, toMsRaw);
  const toBoundMs = Math.max(fromMsRaw, toMsRaw);

  const scoped = conversations
    .filter(conv => leadMatchesFilters(conv, filters, fromBoundMs, toBoundMs))
    .map(conv => toLeadStats(conv, opts));

  const leadVolume = scoped.length;
  const responseTimes = scoped.map(r => r.responseMinutes).filter((v): v is number => v != null);
  const callTimes = scoped.map(r => r.timeToCallMinutes).filter((v): v is number => v != null);
  const closeTimes = scoped.map(r => r.timeToCloseDays).filter((v): v is number => v != null);
  const respondedCount = scoped.filter(r => r.responded).length;
  const callCount = scoped.filter(r => r.called).length;
  const appointmentCount = scoped.filter(r => r.appointment).length;
  const soldCount = scoped.filter(r => r.sold).length;
  const closedCount = scoped.filter(r => r.closed).length;

  const totals: KpiTotals = {
    leadVolume,
    respondedCount,
    responseRatePct: clampPct(respondedCount, leadVolume),
    avgFirstResponseMinutes: avg(responseTimes),
    medianFirstResponseMinutes: median(responseTimes),
    callCount,
    callRatePct: clampPct(callCount, leadVolume),
    avgTimeToCallMinutes: avg(callTimes),
    medianTimeToCallMinutes: median(callTimes),
    appointmentCount,
    appointmentRatePct: clampPct(appointmentCount, leadVolume),
    soldCount,
    soldCloseRatePct: clampPct(soldCount, leadVolume),
    closedCount,
    closeRatePct: clampPct(closedCount, leadVolume),
    avgTimeToCloseDays: avg(closeTimes),
    medianTimeToCloseDays: median(closeTimes),
    closeRate30dPct: clampPct(scoped.filter(r => r.soldWithin30).length, leadVolume),
    closeRate60dPct: clampPct(scoped.filter(r => r.soldWithin60).length, leadVolume),
    closeRate90dPct: clampPct(scoped.filter(r => r.soldWithin90).length, leadVolume),
    closeRate120dPct: clampPct(scoped.filter(r => r.soldWithin120).length, leadVolume)
  };

  const sourceMap = new Map<string, LeadStatsRow[]>();
  for (const row of scoped) {
    if (!sourceMap.has(row.source)) sourceMap.set(row.source, []);
    sourceMap.get(row.source)?.push(row);
  }
  const bySource: KpiSourceRow[] = Array.from(sourceMap.entries())
    .map(([source, rows]) => {
      const total = rows.length;
      const responded = rows.filter(r => r.responded).length;
      const appointments = rows.filter(r => r.appointment).length;
      const calls = rows.filter(r => r.called).length;
      const sold = rows.filter(r => r.sold).length;
      return {
        source,
        leadCount: total,
        responseRatePct: clampPct(responded, total),
        appointmentRatePct: clampPct(appointments, total),
        callRatePct: clampPct(calls, total),
        soldCloseRatePct: clampPct(sold, total)
      };
    })
    .sort((a, b) => b.leadCount - a.leadCount || a.source.localeCompare(b.source));

  const bikeMap = new Map<string, { count: number; newCount: number; usedCount: number }>();
  for (const row of scoped) {
    const key = row.motorcycle;
    const current = bikeMap.get(key) ?? { count: 0, newCount: 0, usedCount: 0 };
    current.count += 1;
    if (row.condition === "new") current.newCount += 1;
    if (row.condition === "used") current.usedCount += 1;
    bikeMap.set(key, current);
  }
  const topMotorcycles: KpiBikeRow[] = Array.from(bikeMap.entries())
    .map(([motorcycle, stats]) => ({
      motorcycle,
      count: stats.count,
      newCount: stats.newCount,
      usedCount: stats.usedCount
    }))
    .sort((a, b) => b.count - a.count || a.motorcycle.localeCompare(b.motorcycle))
    .slice(0, 12);

  const dayMap = new Map<string, LeadStatsRow[]>();
  for (const row of scoped) {
    const day = new Date(row.createdAtMs).toISOString().slice(0, 10);
    if (!dayMap.has(day)) dayMap.set(day, []);
    dayMap.get(day)?.push(row);
  }
  const trend: KpiTrendRow[] = Array.from(dayMap.entries())
    .map(([day, rows]) => {
      const leadCount = rows.length;
      const respondedCount = rows.filter(r => r.responded).length;
      const appointmentCount = rows.filter(r => r.appointment).length;
      const callCount = rows.filter(r => r.called).length;
      const soldCount = rows.filter(r => r.sold).length;
      return {
        day,
        leadCount,
        respondedCount,
        responseRatePct: clampPct(respondedCount, leadCount),
        appointmentCount,
        callCount,
        soldCount
      };
    })
    .sort((a, b) => a.day.localeCompare(b.day));

  const callDetails: KpiCallDetailRow[] = scoped
    .filter(row => row.called)
    .map(row => ({
      convId: row.convId,
      leadKey: row.leadKey,
      leadName: row.leadName,
      leadPhone: row.leadPhone,
      source: row.source,
      ownerId: row.ownerId,
      ownerName: row.ownerName,
      firstInboundAt: row.firstInboundAt,
      firstCallAt: row.firstCallAt,
      timeToCallMinutes: row.timeToCallMinutes
    }))
    .sort((a, b) => {
      const aAt = Date.parse(String(a.firstCallAt ?? "")) || 0;
      const bAt = Date.parse(String(b.firstCallAt ?? "")) || 0;
      return bAt - aAt;
    });

  return {
    applied: {
      from: new Date(fromBoundMs).toISOString(),
      to: new Date(toBoundMs).toISOString(),
      source: String(filters.source ?? "all").trim() || "all",
      ownerId: String(filters.ownerId ?? "all").trim() || "all",
      leadType: (String(filters.leadType ?? "all").trim().toLowerCase() || "all") as LeadTypeFilter,
      leadScope:
        (String(filters.leadScope ?? "include_walkins").trim().toLowerCase() ||
          "include_walkins") as LeadScopeFilter
    },
    totals,
    bySource,
    topMotorcycles,
    trend,
    callDetails
  };
}
