function normalizeHttpUrl(raw: string | null | undefined): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const proto = String(parsed.protocol ?? "").toLowerCase();
    if (proto !== "http:" && proto !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function cleanUrlToken(raw: string): string {
  return raw.replace(/[),.;:!?]+$/g, "").trim();
}

function extractPromoUrlFromText(text: string | null | undefined): string | null {
  const source = String(text ?? "");
  if (!source.trim()) return null;
  const urlRegex = /https?:\/\/[^\s<>"'`)\]]+/gi;
  const matches = Array.from(source.matchAll(urlRegex));
  if (!matches.length) return null;
  const promoCueGlobal =
    /\b(promo|promotion|offers?|specials?|incentives?|rebates?|apr|national\s+promotions?)\b/i.test(source);
  for (const match of matches) {
    const token = cleanUrlToken(String(match[0] ?? ""));
    const normalized = normalizeHttpUrl(token);
    if (!normalized) continue;
    const idx = Number(match.index ?? 0);
    const windowStart = Math.max(0, idx - 80);
    const windowEnd = Math.min(source.length, idx + token.length + 80);
    const around = source.slice(windowStart, windowEnd);
    const cueAround =
      /\b(promo|promotion|offers?|specials?|incentives?|rebates?|apr|national\s+promotions?)\b/i.test(around);
    const cueInUrl =
      /\b(promo|promotion|offers?|specials?|incentives?|rebates?|national-promotions?)\b/i.test(normalized);
    if (cueAround || cueInUrl || promoCueGlobal) return normalized;
  }
  return null;
}

type ResolveOffersUrlArgs = {
  dealerProfile?: any;
  conversation?: any;
  leadInquiry?: string | null;
  leadComment?: string | null;
  inboundText?: string | null;
};

export type OffersUrlResolution = {
  profileOffersUrl: string | null;
  promoNoteUrl: string | null;
  preferredUrl: string | null;
};

export function resolveOffersUrl(args: ResolveOffersUrlArgs): OffersUrlResolution {
  const profileOffersUrl = normalizeHttpUrl(args.dealerProfile?.offersUrl);
  const texts: string[] = [
    String(args.leadInquiry ?? ""),
    String(args.leadComment ?? ""),
    String(args.inboundText ?? "")
  ];
  const messages = Array.isArray(args.conversation?.messages) ? args.conversation.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.direction !== "in") continue;
    const body = String(msg?.body ?? "").trim();
    if (!body) continue;
    texts.push(body);
    if (texts.length >= 8) break;
  }
  let promoNoteUrl: string | null = null;
  for (const text of texts) {
    promoNoteUrl = extractPromoUrlFromText(text);
    if (promoNoteUrl) break;
  }
  return {
    profileOffersUrl,
    promoNoteUrl,
    preferredUrl: promoNoteUrl ?? profileOffersUrl
  };
}

export function buildOffersLine(url: string | null | undefined, opts?: { prefix?: string }): string {
  const normalized = normalizeHttpUrl(url);
  if (!normalized) return "";
  const prefix = String(opts?.prefix ?? "Current offers:").trim() || "Current offers:";
  return `${prefix} ${normalized}`;
}

