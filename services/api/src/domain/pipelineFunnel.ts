/**
 * Pipeline funnel — server-side stage derivation for the open-lead dashboard.
 * Pure functions over conversation state so stages are consistent everywhere
 * and testable without the API.
 */
import type { Conversation } from "./conversationStore.js";
import { hasActiveDealCloseoutBlockers } from "./transitionSafety.js";
import { isFollowUpCadenceHeld } from "./cadenceHoldTtl.js";

export type PipelineStage =
  | "new"
  | "engaged"
  | "quoted"
  | "appointment"
  | "showed"
  | "finance"
  | "won"
  | "lost";

export const PIPELINE_STAGE_ORDER: PipelineStage[] = [
  "new",
  "engaged",
  "quoted",
  "appointment",
  "showed",
  "finance",
  "won",
  "lost"
];

export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  new: "New",
  engaged: "Engaged",
  quoted: "Quoted",
  appointment: "Appointment",
  showed: "Showed",
  finance: "Finance",
  won: "Won",
  lost: "Lost"
};

export type PipelineCard = {
  convId: string;
  name: string;
  owner: string | null;
  source: string | null;
  bike: string | null;
  quotedPrice: number | null;
  stage: PipelineStage;
  lastCustomerAt: string | null;
  daysSinceTouch: number | null;
  nextDueAt: string | null;
  /** True while a hold mode freezes the cadence — nextDueAt must render "on hold", not overdue. */
  followUpHold: boolean;
  appointmentAt: string | null;
  creditActive: boolean;
  atRisk: boolean;
  closedAt: string | null;
};

const CLOSED_DISPLAY_WINDOW_DAYS = 60;
const SHOWED_WINDOW_DAYS = 45;
const AT_RISK_DAYS = 7;

function lastCustomerInboundAt(conv: any): string | null {
  const msgs = Array.isArray(conv?.messages) ? conv.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (
      m?.direction === "in" &&
      (m?.provider === "twilio" || m?.provider === "web_widget") &&
      String(m?.body ?? "").trim()
    ) {
      return String(m?.at ?? "") || null;
    }
  }
  return null;
}

function hasCustomerEngagement(conv: any): boolean {
  return !!lastCustomerInboundAt(conv);
}

function hasQuoteSignal(conv: any): boolean {
  if (Number(conv?.voiceFacts?.quotedPrice ?? 0) > 0) return true;
  const reason = String(conv?.followUp?.reason ?? "");
  if (reason === "manual_quote_delivered") return true;
  const tag = String(conv?.followUpCadence?.contextTag ?? "");
  if (tag === "manual_quote_delivered") return true;
  return false;
}

function bikeLabel(conv: any): string | null {
  const quotedUnit = String(conv?.voiceFacts?.quotedUnit ?? "").trim();
  if (quotedUnit) return quotedUnit;
  const v = conv?.lead?.vehicle ?? {};
  const label = [String(v?.year ?? "").trim(), String(v?.model ?? v?.description ?? "").trim()]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!label || /harley-davidson other/i.test(label)) return null;
  return label.replace(/^harley-davidson\s+/i, "");
}

export function deriveLeadStage(
  conv: any,
  opts: { openTodos?: Array<{ convId?: string; reason?: string; summary?: string }>; nowMs?: number } = {}
): PipelineStage {
  const nowMs = opts.nowMs ?? Date.now();
  if (conv?.status === "closed") {
    return conv?.closedReason === "sold" || conv?.sale?.soldAt ? "won" : "lost";
  }
  if (hasActiveDealCloseoutBlockers(conv, { openTodos: opts.openTodos, nowMs })) return "finance";
  const outcomeAtMs = Date.parse(String(conv?.appointment?.staffNotify?.outcome?.updatedAt ?? ""));
  if (Number.isFinite(outcomeAtMs) && nowMs - outcomeAtMs <= SHOWED_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
    return "showed";
  }
  const apptStatus = String(conv?.appointment?.status ?? "");
  if (apptStatus === "booked" || apptStatus === "confirmed" || apptStatus === "offered") {
    if (apptStatus !== "offered") return "appointment";
  }
  if (hasQuoteSignal(conv)) return "quoted";
  if (hasCustomerEngagement(conv)) return "engaged";
  return "new";
}

export function buildPipelineCard(
  conv: any,
  opts: { openTodos?: Array<{ convId?: string; reason?: string; summary?: string }>; nowMs?: number } = {}
): PipelineCard {
  const nowMs = opts.nowMs ?? Date.now();
  const stage = deriveLeadStage(conv, opts);
  const lastIn = lastCustomerInboundAt(conv);
  const lastInMs = Date.parse(String(lastIn ?? ""));
  const daysSinceTouch = Number.isFinite(lastInMs)
    ? Math.floor((nowMs - lastInMs) / (24 * 60 * 60 * 1000))
    : null;
  const lead = conv?.lead ?? {};
  const name =
    [String(lead?.firstName ?? "").trim(), String(lead?.lastName ?? "").trim()].filter(Boolean).join(" ") ||
    String(conv?.id ?? "");
  const quoted = Number(conv?.voiceFacts?.quotedPrice ?? 0);
  return {
    convId: String(conv?.id ?? ""),
    name,
    owner: String(conv?.leadOwner?.name ?? "").trim() || null,
    source: String(lead?.source ?? "").trim() || null,
    bike: bikeLabel(conv),
    quotedPrice: quoted > 0 ? quoted : null,
    stage,
    lastCustomerAt: lastIn,
    daysSinceTouch,
    nextDueAt: String(conv?.followUpCadence?.nextDueAt ?? "").trim() || null,
    followUpHold: isFollowUpCadenceHeld(conv?.followUp?.mode, conv?.followUpCadence?.kind),
    appointmentAt: String(conv?.appointment?.matchedSlot?.start ?? conv?.appointment?.start ?? "").trim() || null,
    creditActive: hasActiveDealCloseoutBlockers(conv, { openTodos: opts.openTodos, nowMs }),
    atRisk:
      conv?.status !== "closed" && daysSinceTouch != null && daysSinceTouch >= AT_RISK_DAYS,
    closedAt: String(conv?.closedAt ?? "").trim() || null
  };
}

export function buildPipelineSummary(
  conversations: Conversation[],
  openTodos: Array<{ convId?: string; reason?: string; summary?: string }>,
  nowMs: number = Date.now()
): {
  generatedAt: string;
  stages: Array<{ stage: PipelineStage; label: string; count: number; cards: PipelineCard[] }>;
  totals: { open: number; atRisk: number; financeActive: number; wonRecent: number; lostRecent: number };
} {
  const cards: PipelineCard[] = [];
  for (const conv of conversations ?? []) {
    if (!conv || !(conv as any).id) continue;
    const card = buildPipelineCard(conv, { openTodos, nowMs });
    if (card.stage === "won" || card.stage === "lost") {
      const closedMs = Date.parse(String(card.closedAt ?? ""));
      if (!Number.isFinite(closedMs) || nowMs - closedMs > CLOSED_DISPLAY_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
        continue;
      }
    }
    cards.push(card);
  }
  const byStage = new Map<PipelineStage, PipelineCard[]>();
  for (const stage of PIPELINE_STAGE_ORDER) byStage.set(stage, []);
  for (const card of cards) byStage.get(card.stage)!.push(card);
  for (const stage of PIPELINE_STAGE_ORDER) {
    byStage.get(stage)!.sort((a, b) => {
      // Hottest first: credit-active, then most recent customer touch.
      if (a.creditActive !== b.creditActive) return a.creditActive ? -1 : 1;
      return String(b.lastCustomerAt ?? "").localeCompare(String(a.lastCustomerAt ?? ""));
    });
  }
  const open = cards.filter(c => c.stage !== "won" && c.stage !== "lost");
  return {
    generatedAt: new Date(nowMs).toISOString(),
    stages: PIPELINE_STAGE_ORDER.map(stage => ({
      stage,
      label: PIPELINE_STAGE_LABELS[stage],
      count: byStage.get(stage)!.length,
      cards: byStage.get(stage)!.slice(0, 100)
    })),
    totals: {
      open: open.length,
      atRisk: open.filter(c => c.atRisk).length,
      financeActive: open.filter(c => c.creditActive).length,
      wonRecent: byStage.get("won")!.length,
      lostRecent: byStage.get("lost")!.length
    }
  };
}
