import type { Conversation, PendingIncomingInventory } from "./conversationStore.js";

function compact(text: string | null | undefined): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function lower(text: string | null | undefined): string {
  return compact(text).toLowerCase();
}

function toNumberYear(value: unknown): number | undefined {
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) && n >= 1900 && n <= 2100 ? n : undefined;
}

function cleanModel(raw: string | null | undefined): string {
  let text = compact(raw);
  text = text.replace(/\bharley[-\s]?davidson\b/gi, "").replace(/\bhd\b/gi, "");
  text = text.replace(/\bused\b|\bnew\b/gi, "");
  text = text.replace(/\s+/g, " ").trim();
  if (/^trike\s+freewheeler$/i.test(text)) return "Freewheeler";
  return text;
}

function extractVehicleFromSourceText(raw: string | null | undefined): { year?: number; model?: string } {
  const text = compact(raw);
  const match = text.match(
    /\b((?:19|20)\d{2})\s+([A-Za-z0-9][A-Za-z0-9\s/.-]{2,80}?)(?:\s+(?:we|that|this|is|are|was|were|taking|getting|coming|arriving|on|in)\b|[,.;]|$)/i
  );
  if (!match) return {};
  return {
    year: toNumberYear(match[1]),
    model: cleanModel(match[2])
  };
}

export function hasPendingIncomingInventorySignal(textRaw: string | null | undefined): boolean {
  const text = lower(textRaw);
  if (!text) return false;
  return (
    /\b(?:taking|take|took|getting|get|got|coming|come|came|bringing|bring|brought)\b[\s\S]{0,80}\b(?:in|into|on)\b[\s\S]{0,30}\btrade\b/.test(text) ||
    /\b(?:coming|come|came|incoming|inbound|arriv(?:e|es|ing)|land(?:s|ed|ing)?)\b[\s\S]{0,80}\b(?:trade|pre[-\s]?owned|used)\b/.test(text) ||
    /\b(?:not|isn'?t|ain'?t)\s+(?:here|in|available|ready)\s+yet\b/.test(text) ||
    /\b(?:when|once|as soon as)\b[\s\S]{0,80}\b(?:it|the bike|that bike|trade)\b[\s\S]{0,80}\b(?:gets here|comes in|arrives|is available|is ready)\b/.test(text)
  );
}

export function hasPendingIncomingInventoryContext(
  conv: Pick<Conversation, "pendingIncomingInventory"> | null | undefined
): boolean {
  return String(conv?.pendingIncomingInventory?.status ?? "").toLowerCase() === "pending";
}

export function isPendingIncomingInventoryAcknowledgementText(textRaw: string | null | undefined): boolean {
  const text = lower(textRaw);
  if (!text) return false;
  if (/\b(stop|unsubscribe|wrong number|not interested|do not text|don't text)\b/.test(text)) return false;
  return (
    /\b(?:yes|yep|yeah|yup|ok|okay|sure|sounds good|will do|please|thanks|thank you)\b[\s\S]{0,80}\b(?:let me know|keep me posted|text me|notify me|hit me up)\b/.test(text) ||
    /\b(?:let me know|keep me posted|text me|notify me|hit me up)\b[\s\S]{0,100}\b(?:available|ready|comes in|gets here|arrives|lands|trade)\b/.test(text) ||
    /\b(?:when|once|as soon as)\b[\s\S]{0,80}\b(?:available|ready|comes in|gets here|arrives|lands)\b/.test(text)
  );
}

export function shouldHandlePendingIncomingInventoryTurn(args: {
  conv: Pick<Conversation, "pendingIncomingInventory"> | null | undefined;
  inboundText: string | null | undefined;
  lastOutboundText?: string | null;
}): boolean {
  if (!hasPendingIncomingInventoryContext(args.conv)) return false;
  if (isPendingIncomingInventoryAcknowledgementText(args.inboundText)) return true;
  const combined = `${compact(args.lastOutboundText)} ${compact(args.inboundText)}`;
  return hasPendingIncomingInventorySignal(combined) && isPendingIncomingInventoryAcknowledgementText(combined);
}

export function buildPendingIncomingInventoryFromConversation(args: {
  conv: Pick<Conversation, "lead" | "pendingIncomingInventory">;
  sourceText?: string | null;
  source?: PendingIncomingInventory["source"];
  sourceMessageId?: string | null;
  nowIso?: string;
}): PendingIncomingInventory | null {
  const existing = args.conv.pendingIncomingInventory;
  const leadVehicle = args.conv.lead?.vehicle ?? {};
  const leadInventory = (args.conv.lead as any)?.inventory ?? {};
  const sourceVehicle = extractVehicleFromSourceText(args.sourceText);
  const model = cleanModel(
    existing?.model ||
      leadVehicle.model ||
      leadVehicle.description ||
      leadInventory.model ||
      sourceVehicle.model ||
      ""
  );
  const year = existing?.year ?? toNumberYear(leadVehicle.year ?? leadInventory.year ?? sourceVehicle.year);
  const label = formatPendingIncomingInventoryLabel({
    model,
    year,
    make: existing?.make || compact(leadVehicle.make) || "Harley-Davidson",
    label: existing?.label
  });
  if (!model && !label) return null;
  const nowIso = args.nowIso || new Date().toISOString();
  return {
    model: model || existing?.model,
    year,
    make: existing?.make || compact(leadVehicle.make) || "Harley-Davidson",
    condition: existing?.condition || compact(leadVehicle.condition) || "used",
    label: existing?.label || label,
    note: compact(args.sourceText) || existing?.note,
    source: args.source || existing?.source || "system",
    sourceMessageId: compact(args.sourceMessageId) || existing?.sourceMessageId,
    status: "pending",
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso,
    acknowledgedAt: existing?.acknowledgedAt
  };
}

export function formatPendingIncomingInventoryLabel(
  pending: Pick<PendingIncomingInventory, "label" | "year" | "make" | "model"> | null | undefined
): string {
  const explicit = compact(pending?.label);
  if (explicit) return explicit;
  const year = pending?.year ? String(pending.year) : "";
  const model = cleanModel(pending?.model);
  const make = compact(pending?.make);
  const parts = [year, model || make].filter(Boolean);
  return compact(parts.join(" "));
}

export function buildPendingIncomingInventoryCustomerAck(
  pending: PendingIncomingInventory | null | undefined
): string {
  const label = formatPendingIncomingInventoryLabel(pending) || "that bike";
  return `Ok, will do. I'll keep this tied to the ${label} trade and let you know as soon as it's here and ready to look at.`;
}

export function buildPendingIncomingInventoryTaskSummary(args: {
  pending: PendingIncomingInventory | null | undefined;
  customerName?: string | null;
}): string {
  const label = formatPendingIncomingInventoryLabel(args.pending) || "incoming trade";
  const customer = compact(args.customerName) || "customer";
  return `Notify ${customer} when the ${label} trade arrives or is ready to show.`;
}
