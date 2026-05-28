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
  provider: "vertex_search" | "known_source";
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

function getProfileReferenceHosts(profile?: DealerProfileLike | null): string[] {
  const dealerHost = getDealerWebsiteHost(profile);
  const referenceHosts = Array.isArray(profile?.webSearch?.referenceUrls)
    ? profile!.webSearch!.referenceUrls!
        .map(v => normalizeReferenceHost(v))
        .filter(Boolean)
    : [];
  return [...new Set([dealerHost, ...referenceHosts].filter(Boolean))];
}

function queryMatchesAny(query: string, pattern: RegExp): boolean {
  return pattern.test(String(query ?? ""));
}

function scoreWebSearchHitSource(args: {
  query: string;
  hit: WebSearchHit;
  profile?: DealerProfileLike | null;
  originalIndex: number;
}): number {
  const parsed = parseHttpUrl(args.hit.url);
  const host = parsed?.hostname.toLowerCase() ?? "";
  const normalizedHost = normalizeHost(host);
  const pathName = parsed?.pathname.toLowerCase() ?? "";
  const query = String(args.query ?? "");
  const title = String(args.hit.title ?? "").toLowerCase();
  const snippet = String(args.hit.snippet ?? "").toLowerCase();
  const urlText = String(args.hit.url ?? "").toLowerCase();
  let score = 0;

  const dealerHost = getDealerWebsiteHost(args.profile);
  const preferredHosts = getProfileReferenceHosts(args.profile).filter(domain => domain !== dealerHost);
  if (dealerHost && (normalizedHost === dealerHost || normalizedHost.endsWith(`.${dealerHost}`))) {
    score += 130;
  } else if (preferredHosts.some(domain => normalizedHost === domain || normalizedHost.endsWith(`.${domain}`))) {
    score += 55;
  }

  if (host === "www.harley-davidson.com" && pathName.startsWith("/us/en/")) score += 95;
  else if (host === "www.harley-davidson.com") score += 75;
  else if (normalizedHost === "harley-davidson.com") score += 65;
  else if (normalizedHost.endsWith(".harley-davidson.com")) score += 20;

  if (/^\/us\/en\/(?:content|tools|customer-service|shop|motorcycles|experiences|about-us)\b/.test(pathName)) {
    score += 22;
  }
  if (/^\/us\/en\/(?:content|tools|customer-service|shop|motorcycles)\b/.test(pathName)) {
    score += 10;
  }
  if (pathName.includes("/us/en/tools/find-a-dealer/")) score -= 25;

  const eventQuery = queryMatchesAny(query, /\b(?:event|events|calendar|schedule|bike night|demo ride|private event)\b/i);
  const financeQuery = queryMatchesAny(query, /\b(?:finance|financing|payment|loan|credit|offer|special)\b/i);
  if (eventQuery && !financeQuery) {
    if (/^\/us\/en\/(?:experiences|content\/event-calendar)\b/.test(pathName)) score += 45;
    if (/^\/us\/en\/tools\/(?:private-party-financing|motorcycle-financing|estimate-payment|offers)\b/.test(pathName)) {
      score -= 65;
    }
  }

  if (normalizedHost === "insurance.harley-davidson.com") {
    score += queryMatchesAny(query, /\b(?:insurance|coverage|claim|policy|quote)\b/i) ? 115 : -45;
  }
  if (normalizedHost === "investor.harley-davidson.com") {
    score += queryMatchesAny(query, /\b(?:investor|stock|earnings|shareholder|financial results)\b/i) ? 5 : -70;
  }
  if (/^(?:news|media)\.harley-davidson\.com$/.test(normalizedHost)) score -= 25;
  if (/^(?:cloud|email|email\d*)\./.test(normalizedHost) || normalizedHost.includes(".email")) score -= 80;
  if (/\/news(?:-details)?\/|\/investor\b|\/resources\/things-to-do-following-motorcycle-accident\b/.test(pathName)) {
    score -= 20;
  }
  if (!snippet.trim()) score -= 18;

  for (const term of queryTerms(query)) {
    if (!term || term.length < 3) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const termPattern = new RegExp(`\\b${escaped}\\b`, "i");
    if (termPattern.test(title)) score += 4;
    if (termPattern.test(urlText)) score += 3;
    if (termPattern.test(snippet)) score += 1;
  }

  return score - args.originalIndex * 0.01;
}

export function rankWebSearchHitsForQuestion(
  query: string,
  hits: WebSearchHit[],
  profile?: DealerProfileLike | null
): WebSearchHit[] {
  return hits
    .map((hit, originalIndex) => ({
      hit,
      score: scoreWebSearchHitSource({ query, hit, profile, originalIndex }),
      originalIndex
    }))
    .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex)
    .map(item => item.hit);
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
    baggers: ["bagger", "baggers", "king of the baggers", "kotb"],
    calendar: ["calendar", "schedule", "dates", "events"],
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

function extractKnownHarleySection(text: string, query: string): string {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const isBaggersSchedule =
    /\b(?:king\s+of\s+the\s+baggers|baggers|kotb)\b/i.test(query) &&
    /\b(?:schedule|calendar|dates?|when|events?)\b/i.test(query);
  if (isBaggersSchedule) {
    const scheduleSection =
      clean.match(
        /(2026 Harley-Davidson Racing Schedules\s+King of the Baggers\s+[\s\S]{0,900}?)(?=\s+FIM Harley-Davidson Bagger World Cup\b|\s+SUPER HOOLIGAN\b|\s+SuperTwins\b)/
      )?.[1] ??
      clean.match(
        /(King of the Baggers\s+[\s\S]{0,700}?(?:March|April|May|June|July|August|September)[\s\S]{0,900}?)(?=\s+FIM Harley-Davidson Bagger World Cup\b|\s+SUPER HOOLIGAN\b|\s+SuperTwins\b)/
      )?.[1];
    if (scheduleSection) return scheduleSection.trim();
  }

  const isHogMembership =
    /\b(?:h\.?o\.?g\.?|hog|harley owners group|membership)\b/i.test(query) &&
    /\b(?:how much|cost|price|fee|membership|renew)\b/i.test(query);
  if (isHogMembership) {
    const membershipSection =
      clean.match(
        /(Join Harley Owners Group\s+\|\s+\$?\d+\/year[\s\S]{0,900}?)(?=\s+FREQUENTLY ASKED QUESTIONS\b|\s+What is Harley Owners Group\b)/
      )?.[1] ??
      clean.match(
        /(HARLEY OWNERS GROUP\s+[\s\S]{0,500}?\$\d+\/YR[\s\S]{0,900}?)(?=\s+PASSENGER\b|\s+FREE MEMBERSHIP\b)/
      )?.[1];
    if (membershipSection) return membershipSection.trim();
  }

  return "";
}

function extractRelevantSnippetFromText(text: string, query: string, maxLength = 700): string {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const knownSection = extractKnownHarleySection(clean, query);
  if (knownSection) return knownSection.slice(0, Math.max(maxLength, 1200)).trim();
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
    if (/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i.test(window)) score += 2;
    if (/\b(?:daytona|road america|laguna|mid-ohio|circuit|speedway|raceway)\b/i.test(window)) score += 2;
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

function knownHarleySourceUrls(query: string): string[] {
  if (String(process.env.WEB_FALLBACK_KNOWN_SOURCES_ENABLED ?? "1") === "0") return [];
  const q = String(query ?? "");
  const urls: string[] = [];
  if (
    /\b(?:king\s+of\s+the\s+baggers|baggers|kotb)\b/i.test(q) &&
    /\b(?:schedule|calendar|dates?|when|events?)\b/i.test(q)
  ) {
    urls.push("https://www.harley-davidson.com/us/en/content/event-calendar/king-of-baggers.html");
  }
  if (
    /\b(?:h\.?o\.?g\.?|hog|harley owners group|membership)\b/i.test(q) &&
    /\b(?:how much|cost|price|fee|membership|renew)\b/i.test(q)
  ) {
    urls.push(
      "https://www.harley-davidson.com/us/en/content/hog/membership-benefits.html",
      "https://www.harley-davidson.com/us/en/content/membership.html"
    );
  }
  return [...new Set(urls)];
}

async function searchKnownHarleySources(args: {
  query: string;
  profile?: DealerProfileLike | null;
  maxResults?: number;
  timeoutMs?: number;
}): Promise<WebSearchResult | null> {
  const query = String(args.query ?? "").trim();
  if (!query) return null;
  const urls = knownHarleySourceUrls(query);
  if (!urls.length) return null;
  const allowlist = getAllowlistedDomains(args.profile);
  const timeoutMs = Math.max(1000, Number(args.timeoutMs ?? process.env.WEB_FALLBACK_TIMEOUT_MS ?? 3500));
  const maxResults = Math.max(
    1,
    Math.min(10, Number(args.maxResults ?? process.env.WEB_FALLBACK_MAX_RESULTS ?? 3))
  );
  const hits: WebSearchHit[] = [];
  for (const url of urls) {
    const parsed = parseHttpUrl(url);
    if (!parsed?.hostname || !domainAllowed(parsed.hostname, allowlist)) continue;
    const snippet = await fetchAllowlistedPageSnippet({
      url: parsed.toString(),
      query,
      allowlist,
      timeoutMs: Math.min(timeoutMs, Number(process.env.WEB_FALLBACK_PAGE_FETCH_TIMEOUT_MS ?? 2500))
    });
    if (!snippet) continue;
    hits.push({
      title: parsed.pathname
        .split("/")
        .filter(Boolean)
        .pop()
        ?.replace(/[-_]+/g, " ")
        .replace(/\.html$/i, "") || normalizeHost(parsed.hostname),
      snippet,
      url: parsed.toString(),
      domain: normalizeHost(parsed.hostname)
    });
    if (hits.length >= maxResults) break;
  }
  if (!hits.length) return null;
  return {
    provider: "known_source",
    query,
    hits
  };
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
  const requestResults = Math.max(maxResults, Math.min(10, maxResults * 3));
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
        pageSize: requestResults,
        userPseudoId: `wf-${Date.now().toString(36)}`
      })
    });
    if (!resp.ok) return null;
    const data: any = await resp.json().catch(() => null);
    const items = Array.isArray(data?.results) ? data.results : [];
    const candidateHits: WebSearchHit[] = [];
    for (const item of items) {
      const url = parseVertexUrl(item);
      const parsed = parseHttpUrl(url);
      if (!parsed?.hostname) continue;
      if (!domainAllowed(parsed.hostname, allowlist)) continue;
      const title = parseVertexTitle(item);
      const vertexSnippet = parseVertexSnippet(item);
      candidateHits.push({
        title: title || normalizeHost(parsed.hostname),
        snippet: vertexSnippet,
        url: parsed.toString(),
        domain: normalizeHost(parsed.hostname)
      });
      if (candidateHits.length >= requestResults) break;
    }
    if (!candidateHits.length) return null;
    const rankedHits = rankWebSearchHitsForQuestion(query, candidateHits, args.profile).slice(0, maxResults);
    const hits: WebSearchHit[] = [];
    for (const hit of rankedHits) {
      const snippet =
        hit.snippet ||
        (await fetchAllowlistedPageSnippet({
          url: hit.url,
          query,
          allowlist,
          timeoutMs: Math.min(timeoutMs, Number(process.env.WEB_FALLBACK_PAGE_FETCH_TIMEOUT_MS ?? 2500))
        }));
      hits.push({ ...hit, snippet });
    }
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
  const knownSource = await searchKnownHarleySources(args);
  if (knownSource?.hits?.length) return knownSource;
  // Backward-compatible function name; implementation falls through to Vertex Search.
  return searchVertexSearchLite(args);
}
