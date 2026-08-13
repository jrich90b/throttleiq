/**
 * URL handling for a CAMPAIGN broadcast SMS — the white-label rule and its one allowlist.
 *
 * Lifted out of index.ts verbatim (behaviour-preserving) except for `preserveUrls`, which is
 * new. index.ts sits on a size ratchet the de-tangle program exists to drive down, and this is
 * pure, testable logic with no request context, so it belongs here.
 *
 * THE RULE. A dealer's mass text must never carry OUR SaaS domain or OUR upload URLs — those are
 * white-label leaks. Any `*.leadrider.ai` host and any campaign/message image asset is stripped
 * and, when something was removed, the dealer's own branded URL is appended instead.
 */

export function parseHttpUrl(raw: string | undefined | null): URL | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    const proto = String(url.protocol ?? "").toLowerCase();
    if (proto !== "http:" && proto !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

export function normalizeHttpUrl(raw: string | null | undefined): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  try {
    const u = new URL(value);
    const proto = String(u.protocol ?? "").toLowerCase();
    if (proto !== "http:" && proto !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

export function isLeadriderHost(raw: string | undefined | null): boolean {
  const url = parseHttpUrl(raw);
  if (!url) return false;
  return /(^|\.)leadrider\.ai$/i.test(String(url.hostname ?? "").toLowerCase());
}

export const BROADCAST_URL_REGEX = /https?:\/\/[^\s<>"']+/gi;
const URL_TRAILING_PUNCTUATION_REGEX = /[),.;!?]+$/;

export function splitTrailingUrlPunctuation(rawUrl: string): { core: string; trailing: string } {
  let core = String(rawUrl ?? "").trim();
  let trailing = "";
  while (core && URL_TRAILING_PUNCTUATION_REGEX.test(core)) {
    trailing = core.slice(-1) + trailing;
    core = core.slice(0, -1);
  }
  return { core, trailing };
}

export function isLikelyImageAssetUrl(rawUrl: string | null | undefined): boolean {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) return false;
  const pathname = String(parsed.pathname ?? "").toLowerCase();
  if (!pathname) return false;
  if (pathname.includes("/uploads/campaigns/")) return true;
  if (pathname.includes("/uploads/messages/")) return true;
  if (/\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif)$/i.test(pathname)) return true;
  return false;
}

export function rewriteBroadcastSmsBodyForBranding(args: {
  body: string;
  brandedFallbackUrl?: string | null;
  /**
   * The dealer's OWN configured public destination(s) — today `dealerProfile.bookingUrl`. These
   * survive the strip below; everything else on our host still goes.
   *
   * WHY THIS EXISTS. American H-D's configured booking page IS on our domain
   * (`https://americanharley.leadrider.ai/book?token=…`, a DEALER-level token, not a
   * per-customer one), so the blanket rule deleted the single best call-to-action in a promo and
   * left the sentence hanging. Measured on Joe's 2026-08-13 "Pre-Owned Special": the generated
   * body ended "Call (716) 692-7200 or book a visit: <link>" and would have sent as
   * "…or book a visit:" with a generic dealer URL two lines below it.
   *
   * Narrow on purpose: an EXACT match against what the dealer configured. The copy generator
   * cannot widen it by inventing a leadrider.ai URL, so the white-label guarantee is intact.
   */
  preserveUrls?: Array<string | null | undefined>;
}): string {
  const original = String(args.body ?? "").trim();
  if (!original) return "";
  const fallback = normalizeHttpUrl(args.brandedFallbackUrl ?? null);
  const safeFallback = fallback && !isLeadriderHost(fallback) ? fallback : null;
  const preserved = new Set(
    (args.preserveUrls ?? [])
      .map(value => normalizeHttpUrl(value ?? null))
      .filter((value): value is string => !!value)
  );
  let removedSensitiveUrl = false;

  const rewritten = original.replace(BROADCAST_URL_REGEX, raw => {
    const { core, trailing } = splitTrailingUrlPunctuation(raw);
    const normalized = normalizeHttpUrl(core);
    if (!normalized) return raw;
    if (preserved.has(normalized)) return raw;
    const shouldRewrite = isLeadriderHost(normalized) || isLikelyImageAssetUrl(normalized);
    if (!shouldRewrite) return raw;
    removedSensitiveUrl = true;
    return trailing;
  });

  let compact = rewritten
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (removedSensitiveUrl && safeFallback && !compact.includes(safeFallback)) {
    compact = compact ? `${compact}\n\n${safeFallback}` : safeFallback;
  }
  if (!compact && safeFallback) return safeFallback;
  return compact || original;
}
