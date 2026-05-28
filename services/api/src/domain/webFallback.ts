type DealerProfileLike = {
  website?: string | null;
  webSearch?: {
    referenceUrls?: string[] | null;
    useGooglePlacePhotos?: boolean | null;
    googlePlaceId?: string | null;
  } | null;
};

export type WebSearchHit = {
  title: string;
  snippet: string;
  url: string;
  domain: string;
};

export type WebSearchResult = {
  provider: "vertex_search";
  engine?: string;
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

function normalizeReferenceHost(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const parsed = parseHttpUrl(raw);
  if (parsed?.hostname) return normalizeHost(parsed.hostname);
  return normalizeHost(raw);
}

function getDealerWebsiteHost(profile?: DealerProfileLike | null): string {
  const fromProfile = parseHttpUrl(profile?.website ?? null);
  if (fromProfile?.hostname) return normalizeHost(fromProfile.hostname);
  return "";
}

function getAllowlistedDomains(profile?: DealerProfileLike | null): string[] {
  const fromEnv = parseCsv(process.env.WEB_FALLBACK_ALLOWLIST_DOMAINS);
  const dealerHost = getDealerWebsiteHost(profile);
  const fromProfileRefs = Array.isArray(profile?.webSearch?.referenceUrls)
    ? profile!.webSearch!.referenceUrls!
        .map(v => normalizeReferenceHost(v))
        .filter(Boolean)
    : [];
  const base = dealerHost ? [dealerHost] : [];
  const defaults = ["harley-davidson.com"];
  return [...new Set([...fromEnv, ...base, ...fromProfileRefs, ...defaults])];
}

function domainAllowed(hostname: string, allowlist: string[]): boolean {
  const host = normalizeHost(hostname);
  if (!host) return false;
  if (!allowlist.length) return true;
  return allowlist.some(domain => host === domain || host.endsWith(`.${domain}`));
}

function parseEngineMap(): Record<string, string> {
  const raw = String(process.env.VERTEX_SEARCH_ENGINE_BY_HOST_JSON ?? "").trim();
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

export function resolveVertexSearchEngine(profile?: DealerProfileLike | null): string {
  const mapped = parseEngineMap();
  const dealerHost = getDealerWebsiteHost(profile);
  if (dealerHost && mapped[dealerHost]) return mapped[dealerHost];
  return String(process.env.VERTEX_SEARCH_ENGINE_ID ?? "").trim();
}

function parseVertexSnippet(result: any): string {
  const snippetCandidates = [
    result?.snippet,
    result?.document?.snippet,
    result?.chunk?.content,
    result?.extractiveSegments?.[0]?.content,
    result?.extractiveAnswers?.[0]?.content,
    result?.document?.derivedStructData?.snippet,
    result?.document?.derivedStructData?.description,
    result?.document?.structData?.snippet,
    result?.document?.structData?.description
  ];
  for (const value of snippetCandidates) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function parseVertexTitle(result: any): string {
  const titleCandidates = [
    result?.document?.derivedStructData?.title,
    result?.document?.structData?.title,
    result?.document?.title,
    result?.document?.name,
    result?.title
  ];
  for (const value of titleCandidates) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function parseVertexUrl(result: any): string {
  const urlCandidates = [
    result?.document?.derivedStructData?.link,
    result?.document?.derivedStructData?.url,
    result?.document?.structData?.link,
    result?.document?.structData?.url,
    result?.document?.uri,
    result?.uri,
    result?.link,
    result?.url
  ];
  for (const value of urlCandidates) {
    const text = String(value ?? "").trim();
    if (!text) continue;
    const parsed = parseHttpUrl(text);
    if (parsed?.toString()) return parsed.toString();
  }
  return "";
}

function decodeHtmlEntities(value: string): string {
  return String(value ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => {
      const n = Number.parseInt(code, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    });
}

function htmlToSearchText(html: string): string {
  return decodeHtmlEntities(
    String(html ?? "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function queryTerms(query: string): string[] {
  const aliases: Record<string, string[]> = {
    hog: ["hog", "h.o.g", "h.o.g.", "harley owners group"],
    membership: ["membership", "member"],
    price: ["price", "cost", "fee", "$", "year", "annual"]
  };
  const raw = String(query ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9$]+/g, " ")
    .split(/\s+/)
    .filter(term => term.length >= 3 || term === "$");
  const terms = new Set<string>();
  for (const term of raw) {
    terms.add(term);
    for (const alias of aliases[term] ?? []) terms.add(alias);
  }
  if (/\bhow much|cost|price|fee\b/i.test(query)) terms.add("$");
  return [...terms];
}

function extractRelevantSnippetFromText(text: string, query: string, maxLength = 700): string {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const terms = queryTerms(query);
  const lower = clean.toLowerCase();
  let bestIndex = -1;
  let bestScore = -1;
  for (let i = 0; i < lower.length; i += 250) {
    const window = lower.slice(i, i + 900);
    let score = 0;
    for (const term of terms) {
      if (term && window.includes(term)) score += term === "$" ? 3 : 1;
    }
    if (/\$\s*\d+|\d+\s*\/\s*(?:year|yr)|\d+\s*(?:per|a)\s+year/i.test(window)) score += 3;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  if (bestIndex < 0 || bestScore <= 0) return clean.slice(0, maxLength).trim();
  const start = Math.max(0, bestIndex - 160);
  const snippet = clean.slice(start, start + maxLength).trim();
  return snippet.replace(/^\S{1,20}\s/, "").trim();
}

async function fetchAllowlistedPageSnippet(args: {
  url: string;
  query: string;
  allowlist: string[];
  timeoutMs: number;
}): Promise<string> {
  if (String(process.env.WEB_FALLBACK_FETCH_EMPTY_SNIPPETS ?? "1") === "0") return "";
  const parsed = parseHttpUrl(args.url);
  if (!parsed?.hostname || !domainAllowed(parsed.hostname, args.allowlist)) return "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, args.timeoutMs));
  try {
    const resp = await fetch(parsed.toString(), {
      method: "GET",
      headers: { Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: controller.signal
    });
    if (!resp.ok) return "";
    const contentType = String(resp.headers.get("content-type") ?? "").toLowerCase();
    if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml")) return "";
    const html = await resp.text();
    return extractRelevantSnippetFromText(htmlToSearchText(html), args.query);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function searchVertexSearchLite(args: {
  query: string;
  profile?: DealerProfileLike | null;
  maxResults?: number;
  timeoutMs?: number;
}): Promise<WebSearchResult | null> {
  const query = String(args.query ?? "").trim();
  if (!query) return null;
  const apiKey = String(process.env.VERTEX_SEARCH_API_KEY ?? "").trim();
  if (!apiKey) return null;
  const projectId = String(process.env.VERTEX_SEARCH_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "").trim();
  const engineId = resolveVertexSearchEngine(args.profile);
  if (!projectId || !engineId) return null;
  const location = String(process.env.VERTEX_SEARCH_LOCATION ?? "global").trim() || "global";
  const collection =
    String(process.env.VERTEX_SEARCH_COLLECTION ?? "default_collection").trim() || "default_collection";
  const servingConfig =
    String(process.env.VERTEX_SEARCH_SERVING_CONFIG ?? "default_search").trim() || "default_search";
  const timeoutMs = Math.max(1000, Number(args.timeoutMs ?? process.env.WEB_FALLBACK_TIMEOUT_MS ?? 3500));
  const maxResults = Math.max(
    1,
    Math.min(10, Number(args.maxResults ?? process.env.WEB_FALLBACK_MAX_RESULTS ?? 3))
  );
  const allowlist = getAllowlistedDomains(args.profile);
  const endpoint = new URL(
    `https://discoveryengine.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(
      location
    )}/collections/${encodeURIComponent(collection)}/engines/${encodeURIComponent(
      engineId
    )}/servingConfigs/${encodeURIComponent(servingConfig)}:searchLite`
  );
  endpoint.searchParams.set("key", apiKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(endpoint.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        query,
        pageSize: maxResults,
        userPseudoId: `wf-${Date.now().toString(36)}`
      })
    });
    if (!resp.ok) return null;
    const data: any = await resp.json().catch(() => null);
    const items = Array.isArray(data?.results) ? data.results : [];
    const hits: WebSearchHit[] = [];
    for (const item of items) {
      const url = parseVertexUrl(item);
      const parsed = parseHttpUrl(url);
      if (!parsed?.hostname) continue;
      if (!domainAllowed(parsed.hostname, allowlist)) continue;
      const title = parseVertexTitle(item);
      const vertexSnippet = parseVertexSnippet(item);
      const snippet =
        vertexSnippet ||
        (await fetchAllowlistedPageSnippet({
          url: parsed.toString(),
          query,
          allowlist,
          timeoutMs: Math.min(timeoutMs, Number(process.env.WEB_FALLBACK_PAGE_FETCH_TIMEOUT_MS ?? 2500))
        }));
      hits.push({
        title: title || normalizeHost(parsed.hostname),
        snippet,
        url: parsed.toString(),
        domain: normalizeHost(parsed.hostname)
      });
      if (hits.length >= maxResults) break;
    }
    if (!hits.length) return null;
    return {
      provider: "vertex_search",
      engine: engineId,
      query,
      hits
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function searchGoogleCse(args: {
  query: string;
  profile?: DealerProfileLike | null;
  maxResults?: number;
  timeoutMs?: number;
}): Promise<WebSearchResult | null> {
  if (!isWebFallbackEnabled()) return null;
  // Backward-compatible function name; implementation is Vertex-only.
  return searchVertexSearchLite(args);
}
