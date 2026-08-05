/**
 * Console Copilot — deterministic insights (Phase 1, docs/console_copilot_phase1.md).
 *
 * Pure functions of (store records, clock). No I/O, no LLM, no writes — the numbers the
 * manager copilot answers from are computed here so they are evalable and explainable.
 * Heat is derived from ALREADY-PARSED state (replies, appointment, watches, tasks), never
 * from re-reading customer text; every score ships with its reasons.
 */
import type { Conversation, TodoTask } from "./conversationStore.js";
import { isNonSalesConversation } from "./scoringExclusions.js";
import { agentOfferedATime } from "./bookingFunnel.js";

export type LeadHeatReason = { key: string; label: string; points: number };

export type LeadHeat = {
  convId: string;
  name: string | null;
  phone: string | null;
  source: string | null;
  score: number;
  temperature: "hot" | "warm" | "cold";
  reasons: LeadHeatReason[];
  lastInboundAt: string | null;
};

export type CopilotSnapshot = {
  generatedAt: string;
  totals: {
    openLeads: number;
    hot: number;
    warm: number;
    openTasks: number;
    overdueTasks: number;
    visitProposedNotConfirmed: number;
    activeWatches: number;
  };
  bySource: { source: string; count: number }[];
  hotLeads: LeadHeat[];
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function parseMs(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function formatAge(ms: number): string {
  if (ms < HOUR_MS) return "<1h";
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)}h`;
  return `${Math.floor(ms / DAY_MS)}d`;
}

/** Last real customer inbound (payment events are system records, not the customer talking). */
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

function activeWatchCount(conv: Conversation): number {
  const all = [conv.inventoryWatch, ...(conv.inventoryWatches ?? [])];
  const seen = new Set<unknown>();
  let count = 0;
  for (const watch of all) {
    if (!watch || seen.has(watch)) continue;
    seen.add(watch);
    if (watch.status !== "paused") count++;
  }
  return count;
}

/** Sold, closed, on-hold, and non-sales threads are never heat candidates. */
function isHeatEligible(conv: Conversation): boolean {
  if (conv.status === "closed") return false;
  if (conv.sale?.soldAt) return false;
  if (conv.hold) return false;
  if (isNonSalesConversation(conv)) return false;
  return true;
}

export function computeLeadHeat(
  conv: Conversation,
  openTodos: TodoTask[],
  nowMs: number
): LeadHeat | null {
  if (!isHeatEligible(conv)) return null;
  // A confirmed visit means the lead is being handled — off the needs-attention list.
  if (conv.appointment?.status === "confirmed") return null;

  const reasons: LeadHeatReason[] = [];
  const inboundAt = lastInboundAt(conv);
  const inboundMs = parseMs(inboundAt);
  if (inboundMs != null && inboundMs <= nowMs) {
    const age = nowMs - inboundMs;
    if (age <= 48 * HOUR_MS) {
      reasons.push({ key: "recent_reply", label: `replied ${formatAge(age)} ago`, points: 40 });
    } else if (age <= 7 * DAY_MS) {
      reasons.push({ key: "reply_this_week", label: `replied ${formatAge(age)} ago`, points: 20 });
    }
  }

  const appt = conv.appointment;
  if (appt?.status === "proposed") {
    reasons.push({ key: "visit_proposed", label: "visit proposed, not confirmed", points: 25 });
  } else if (agentOfferedATime(conv)) {
    reasons.push({ key: "time_offered", label: "we offered a time, nothing booked", points: 15 });
  }

  const watches = activeWatchCount(conv);
  if (watches > 0) {
    reasons.push({
      key: "active_watch",
      label: watches === 1 ? "watching for a unit" : `watching for ${watches} units`,
      points: 15
    });
  }

  const tasks = openTodos.filter(t => t.convId === conv.id && t.status === "open");
  if (tasks.length > 0) {
    reasons.push({
      key: "open_task",
      label: tasks.length === 1 ? "1 open staff task" : `${tasks.length} open staff tasks`,
      points: 10
    });
  }

  const engagementMs = parseMs(conv.engagement?.at);
  if (
    conv.engagement?.source === "call" &&
    engagementMs != null &&
    nowMs - engagementMs <= 14 * DAY_MS
  ) {
    reasons.push({ key: "recent_call", label: "recent phone contact", points: 10 });
  }

  const score = reasons.reduce((sum, r) => sum + r.points, 0);
  return {
    convId: conv.id,
    name: conv.lead?.name ?? null,
    phone: conv.lead?.phone ?? null,
    source: conv.lead?.source ?? null,
    score,
    temperature: score >= 55 ? "hot" : score >= 30 ? "warm" : "cold",
    reasons,
    lastInboundAt: inboundAt
  };
}

export function buildCopilotSnapshot(
  convs: Conversation[],
  todos: TodoTask[],
  nowMs: number,
  opts?: { limit?: number }
): CopilotSnapshot {
  const openTodos = todos.filter(t => t.status === "open");
  const bySource = new Map<string, number>();
  const heats: LeadHeat[] = [];
  let openLeads = 0;
  let visitProposed = 0;
  let watchTotal = 0;

  for (const conv of convs) {
    if (!isHeatEligible(conv)) continue;
    openLeads++;
    const source = (conv.lead?.source ?? "").trim() || "unknown";
    bySource.set(source, (bySource.get(source) ?? 0) + 1);
    if (conv.appointment?.status === "proposed") visitProposed++;
    watchTotal += activeWatchCount(conv);
    const heat = computeLeadHeat(conv, openTodos, nowMs);
    if (heat && heat.score > 0) heats.push(heat);
  }

  heats.sort(
    (a, b) => b.score - a.score || (b.lastInboundAt ?? "").localeCompare(a.lastInboundAt ?? "")
  );

  const overdueTasks = openTodos.filter(t => {
    const due = parseMs(t.dueAt);
    return due != null && due < nowMs;
  }).length;

  const limit = Math.max(1, opts?.limit ?? 15);
  return {
    generatedAt: new Date(nowMs).toISOString(),
    totals: {
      openLeads,
      hot: heats.filter(h => h.temperature === "hot").length,
      warm: heats.filter(h => h.temperature === "warm").length,
      openTasks: openTodos.length,
      overdueTasks,
      visitProposedNotConfirmed: visitProposed,
      activeWatches: watchTotal
    },
    bySource: Array.from(bySource.entries())
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    hotLeads: heats.slice(0, limit)
  };
}

/** Compact grounding text for the ask-LLM. Conversation ids ride in [brackets] so the
 *  model can cite them back as leadRefs without inventing ids. */
export function renderCopilotSnapshotForLLM(snapshot: CopilotSnapshot): string {
  const t = snapshot.totals;
  const lines: string[] = [
    `Store snapshot generated ${snapshot.generatedAt}.`,
    `Open sales leads: ${t.openLeads} (hot ${t.hot}, warm ${t.warm}).`,
    `Staff tasks: ${t.openTasks} open, ${t.overdueTasks} overdue. Visits proposed awaiting confirmation: ${t.visitProposedNotConfirmed}. Active inventory watches: ${t.activeWatches}.`,
    `Leads by source: ${snapshot.bySource.map(s => `${s.source}=${s.count}`).join(", ") || "none"}.`,
    `Top leads needing attention:`
  ];
  snapshot.hotLeads.forEach((h, i) => {
    const who = [h.name, h.phone].filter(Boolean).join(" ") || "unknown lead";
    lines.push(
      `${i + 1}. [${h.convId}] ${who} — ${h.temperature} (${h.score}): ${h.reasons
        .map(r => r.label)
        .join("; ")}`
    );
  });
  if (snapshot.hotLeads.length === 0) lines.push("(none)");
  return lines.join("\n");
}
