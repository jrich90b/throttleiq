export type InventoryWatchDedupItem = {
  stockId?: string | null;
  vin?: string | null;
  url?: string | null;
};

export type InventoryWatchDedupMessage = {
  direction?: string | null;
  provider?: string | null;
  body?: string | null;
  text?: string | null;
  draftStatus?: string | null;
};

export type InventoryWatchDedupConversation = {
  messages?: InventoryWatchDedupMessage[] | null;
};

const WATCH_DEDUP_OUTBOUND_PROVIDERS = new Set(["twilio", "draft_ai", "human", "sendgrid"]);

function normalizeWatchDedupText(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeWatchDedupToken(value: unknown): string {
  return String(value ?? "").toLowerCase().trim().replace(/\/+$/, "");
}

function addUrlTokens(tokens: Set<string>, rawUrl: string): void {
  const normalized = normalizeWatchDedupToken(rawUrl);
  if (!normalized) return;
  tokens.add(normalized);
  try {
    const parsed = new URL(rawUrl);
    const path = normalizeWatchDedupToken(`${parsed.origin}${parsed.pathname}`);
    if (path.length >= 16) tokens.add(path);
    const pathname = normalizeWatchDedupToken(parsed.pathname);
    if (pathname.length >= 12) tokens.add(pathname);
  } catch {
    // Keep the raw normalized URL token above for non-standard values.
  }
}

export function inventoryWatchItemDedupTokens(item: InventoryWatchDedupItem): string[] {
  const tokens = new Set<string>();
  const stockId = normalizeWatchDedupToken(item?.stockId);
  if (stockId.length >= 3) tokens.add(stockId);
  const vin = normalizeWatchDedupToken(item?.vin);
  if (vin.length >= 8) tokens.add(vin);
  const url = String(item?.url ?? "").trim();
  if (url) addUrlTokens(tokens, url);
  return [...tokens].filter(token => token.length >= 3);
}

export function hasPriorInventoryWatchOutboundForItem(
  conv: InventoryWatchDedupConversation,
  item: InventoryWatchDedupItem,
  candidateReply?: string | null
): boolean {
  const messages = Array.isArray(conv?.messages) ? conv.messages : [];
  if (!messages.length) return false;
  const tokens = inventoryWatchItemDedupTokens(item);
  const candidateNorm = normalizeWatchDedupText(candidateReply);

  return messages.some(message => {
    if (message?.direction !== "out") return false;
    if (String(message?.draftStatus ?? "").toLowerCase() === "stale") return false;
    const provider = String(message?.provider ?? "").toLowerCase().trim();
    if (!WATCH_DEDUP_OUTBOUND_PROVIDERS.has(provider)) return false;
    const bodyNorm = normalizeWatchDedupText(message?.body ?? message?.text);
    if (!bodyNorm) return false;
    if (candidateNorm && bodyNorm === candidateNorm) return true;
    return tokens.some(token => bodyNorm.includes(token));
  });
}
