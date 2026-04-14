type DealerProfileLike = {
  website?: string | null;
};

export type WebSearchHit = {
  title: string;
  snippet: string;
  url: string;
  domain: string;
};

export type WebSearchResult = {
  provider: "google_cse";
  cx: string;
  query: string;
  hits: WebSearchHit[];
};

function parseHttpUrl(raw: string | null | undefined): URL | null {
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

function normalizeHost(raw: string | null | undefined): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

function parseCsv(value: string | null | undefined): string[] {
  return String(value ?? "")
    .split(",")
    .map(v => normalizeHost(v))
    .filter(Boolean);
}

function getDealerWebsiteHost(profile?: DealerProfileLike | null): string {
  const fromProfile = parseHttpUrl(profile?.website ?? null);
  if (fromProfile?.hostname) return normalizeHost(fromProfile.hostname);
  return "";
}

function getAllowlistedDomains(profile?: DealerProfileLike | null): string[] {
  const fromEnv = parseCsv(process.env.WEB_FALLBACK_ALLOWLIST_DOMAINS);
  const dealerHost = getDealerWebsiteHost(profile);
  const base = dealerHost ? [dealerHost] : [];
  const defaults = ["harley-davidson.com"];
  return [...new Set([...fromEnv, ...base, ...defaults])];
}

function domainAllowed(hostname: string, allowlist: string[]): boolean {
  const host = normalizeHost(hostname);
  if (!host) return false;
  if (!allowlist.length) return true;
  return allowlist.some(domain => host === domain || host.endsWith(`.${domain}`));
}

function parseCxMap(): Record<string, string> {
  const raw = String(process.env.GOOGLE_CSE_CX_BY_HOST_JSON ?? "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const key = normalizeHost(k);
      const value = String(v ?? "").trim();
      if (key && value) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function isWebFallbackEnabled(): boolean {
  return process.env.WEB_FALLBACK_ENABLED === "1";
}

export function isWebFallbackDraftOnly(): boolean {
  return String(process.env.WEB_FALLBACK_DRAFT_ONLY ?? "1") !== "0";
}

export function isWebFallbackCandidateQuestion(text: string | null | undefined): boolean {
  const value = String(text ?? "").trim();
  if (!value) return false;
  if (value.length < 8) return false;
  if (
    /^(how|what|where|when|why|who|which|can|could|do|does|is|are|will|would)\b/i.test(value)
  ) {
    return true;
  }
  return value.includes("?");
}

export function resolveGoogleCseCx(profile?: DealerProfileLike | null): string {
  const mapped = parseCxMap();
  const dealerHost = getDealerWebsiteHost(profile);
  if (dealerHost && mapped[dealerHost]) return mapped[dealerHost];
  const defaultCx = String(process.env.GOOGLE_CSE_DEFAULT_CX ?? "").trim();
  return defaultCx;
}

export async function searchGoogleCse(args: {
  query: string;
  profile?: DealerProfileLike | null;
  maxResults?: number;
  timeoutMs?: number;
}): Promise<WebSearchResult | null> {
  if (!isWebFallbackEnabled()) return null;
  const query = String(args.query ?? "").trim();
  if (!query) return null;
  const apiKey = String(process.env.GOOGLE_CSE_API_KEY ?? "").trim();
  const cx = resolveGoogleCseCx(args.profile);
  if (!apiKey || !cx) return null;
  const timeoutMs = Math.max(1000, Number(args.timeoutMs ?? process.env.WEB_FALLBACK_TIMEOUT_MS ?? 3500));
  const maxResults = Math.max(
    1,
    Math.min(10, Number(args.maxResults ?? process.env.WEB_FALLBACK_MAX_RESULTS ?? 3))
  );
  const allowlist = getAllowlistedDomains(args.profile);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL("https://www.googleapis.com/customsearch/v1");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("cx", cx);
    url.searchParams.set("q", query);
    url.searchParams.set("num", String(maxResults));
    const resp = await fetch(url.toString(), { signal: controller.signal });
    if (!resp.ok) return null;
    const data: any = await resp.json().catch(() => null);
    const items = Array.isArray(data?.items) ? data.items : [];
    const hits: WebSearchHit[] = [];
    for (const item of items) {
      const link = String(item?.link ?? "").trim();
      const title = String(item?.title ?? "").trim();
      const snippet = String(item?.snippet ?? "").trim();
      const parsed = parseHttpUrl(link);
      if (!parsed?.hostname) continue;
      if (!domainAllowed(parsed.hostname, allowlist)) continue;
      hits.push({
        title,
        snippet,
        url: parsed.toString(),
        domain: normalizeHost(parsed.hostname)
      });
      if (hits.length >= maxResults) break;
    }
    if (!hits.length) return null;
    return {
      provider: "google_cse",
      cx,
      query,
      hits
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

