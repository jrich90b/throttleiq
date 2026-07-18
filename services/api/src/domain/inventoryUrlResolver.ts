import { fetchHtmlSmart } from "./zenrowsFetch.js";
import { getDealerProfile } from "./dealerProfile.js";

/**
 * Dealer-domain scoping (de-hardcode A2, 2026-07-17): the product-link domain is
 * config, never a hardcoded dealer. Precedence:
 *   1. INVENTORY_SITE_DOMAIN env (bare host or full URL) — explicit override wins.
 *   2. The dealer profile's `website` field (hostname, `www.` stripped).
 * If neither yields a domain, the resolver returns NO links. Fail direction: a
 * misconfigured dealer gets no product link — never another dealer's link.
 */

export type ResolveResult =
  | { ok: true; url: string; sourceListUrl: string }
  | { ok: false; reason: "not_found" | "fetch_failed" };

type CacheEntry = { result: ResolveResult; expiresAt: number };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 2 * 60 * 1000; // 2 minutes

// Legacy all-inventory list bases (pre-multi-dealer). INVENTORY_LIST_URLS overrides;
// otherwise a legacy default is used ONLY when it lives on the dealer's own domain,
// so a second dealer never fetches (or links into) this dealer's list page.
const LEGACY_DEFAULT_LIST_URLS = [
  "https://americanharley-davidson.com/new-harley-davidson-motorcycles-for-sale-buffalo-ny-xnewinventory?condition=all&inventory_list_id=0&sort_column=year&sort_direction=desc"
];

/** Hostname (lowercased, leading `www.` stripped) from a URL or bare domain; null if unparseable. */
export function deriveInventoryDomainHost(input: string | null | undefined): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const host = new URL(candidate).hostname.toLowerCase().replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

/**
 * The dealer domain product links must live on. Env override first, then the
 * dealer profile website (getDealerProfile is lazy + cached). Null = no domain
 * configured; callers must return no links in that case.
 */
export async function getInventorySiteDomain(): Promise<string | null> {
  const fromEnv = deriveInventoryDomainHost(process.env.INVENTORY_SITE_DOMAIN);
  if (fromEnv) return fromEnv;
  const profile = await getDealerProfile().catch(() => null);
  return deriveInventoryDomainHost(profile?.website);
}

function getListUrls(host: string): string[] {
  const env = (process.env.INVENTORY_LIST_URLS ?? "").trim();
  if (env) return env.split(",").map(s => s.trim()).filter(Boolean);
  return LEGACY_DEFAULT_LIST_URLS.filter(u => deriveInventoryDomainHost(u) === host);
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hostPattern(host: string): string {
  return `(?:www\\.)?${escapeForRegex(host)}`;
}

// Relative /inventory/... paths must not be the path portion of ANOTHER host's
// absolute URL (the lookbehind rejects a host character right before the slash),
// or we would glue our domain onto a foreign dealer's path.
const INVENTORY_REL_LINK_RE = /(?<![a-z0-9.-])\/inventory\/\d+\/[^\s"'<>]+/gi;

/** First product-detail URL on the given dealer host (absolute match, or dealer-relative link absolutized). */
export function extractFirstInventoryUrl(html: string, host: string): string | null {
  const absRe = new RegExp(`https?:\\/\\/${hostPattern(host)}\\/inventory\\/\\d+\\/[^\\s"'<>]+`, "ig");
  const abs = html.match(absRe);
  if (abs?.[0]) return abs[0];

  const rel = html.match(INVENTORY_REL_LINK_RE);
  if (rel?.[0]) return `https://${host}${rel[0]}`;

  return null;
}

function extractInventoryUrlContainingStock(html: string, stockLower: string, host: string): string | null {
  const stockPattern = escapeForRegex(stockLower);
  const re = new RegExp(
    `https?:\\/\\/${hostPattern(host)}\\/inventory\\/\\d+\\/[^"\\s<>]*${stockPattern}[^"\\s<>]*`,
    "i"
  );
  const m = html.match(re);
  if (m?.[0]) return m[0];

  const reRel = new RegExp(
    `(?<![a-z0-9.-])\\/inventory\\/\\d+\\/[^"\\s<>]*${stockPattern}[^"\\s<>]*`,
    "i"
  );
  const mRel = html.match(reRel);
  if (mRel?.[0]) return `https://${host}${mRel[0]}`;

  return null;
}

function findNearestInventoryUrl(html: string, stock: string, host: string): string | null {
  const lower = html.toLowerCase();
  const stockLower = stock.toLowerCase();

  let idx = lower.indexOf(stockLower);
  while (idx !== -1) {
    const start = Math.max(0, idx - 4000);
    const end = Math.min(html.length, idx + 4000);
    const window = html.slice(start, end);

    const stockUrl = extractInventoryUrlContainingStock(window, stockLower, host);
    if (stockUrl) return stockUrl;

    const any = extractFirstInventoryUrl(window, host);
    if (any) return any;

    idx = lower.indexOf(stockLower, idx + stockLower.length);
  }

  return null;
}

export async function resolveInventoryUrlByStock(stockId: string): Promise<ResolveResult> {
  const stock = stockId.trim();
  if (!stock) return { ok: false, reason: "not_found" };

  const host = await getInventorySiteDomain();
  if (!host) {
    // Not cached so a later config fix takes effect immediately.
    console.warn(
      "[inventory-url] no dealer inventory domain (INVENTORY_SITE_DOMAIN unset and the dealer profile has no website) — returning no product link"
    );
    return { ok: false, reason: "not_found" };
  }

  const cacheKey = `${host}::${stock}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const stockLower = stock.toLowerCase();
  const listUrls = getListUrls(host);

  for (const base of listUrls) {
    try {
      const u = new URL(base);
      u.searchParams.set("search_text", stock);
      u.searchParams.set("page", "1");
      const searchUrl = u.toString();

      const html = await fetchHtmlSmart(searchUrl, "Inventory URL Resolve");
      if (!html) continue;

      const stockUrl = extractInventoryUrlContainingStock(html, stockLower, host);
      if (stockUrl) {
        const result: ResolveResult = { ok: true, url: stockUrl, sourceListUrl: searchUrl };
        cache.set(cacheKey, { result, expiresAt: Date.now() + TTL_MS });
        return result;
      }

      const near = findNearestInventoryUrl(html, stock, host);
      if (near) {
        const result: ResolveResult = { ok: true, url: near, sourceListUrl: searchUrl };
        cache.set(cacheKey, { result, expiresAt: Date.now() + TTL_MS });
        return result;
      }
    } catch {
    }
  }

  const result: ResolveResult = { ok: false, reason: "not_found" };
  cache.set(cacheKey, { result, expiresAt: Date.now() + TTL_MS });
  return result;
}
