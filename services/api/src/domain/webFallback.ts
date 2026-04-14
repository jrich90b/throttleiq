type DealerProfileLike = {
  website?: string | null;
  webSearch?: {
    referenceUrls?: string[] | null;
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
      const snippet = parseVertexSnippet(item);
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
