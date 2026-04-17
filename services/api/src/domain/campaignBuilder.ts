import { promises as fs } from "node:fs";
import * as path from "node:path";
import OpenAI from "openai";
import type {
  CampaignBuildMode,
  CampaignChannel,
  CampaignEntry,
  CampaignSourceHit,
  CampaignTag
} from "./campaignStore.js";
import type { DealerProfile } from "./dealerProfile.js";
import { getDataDir } from "./dataDir.js";
import { searchGoogleCse } from "./webFallback.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TAG_SEARCH_HINTS: Record<CampaignTag, string> = {
  sales: "motorcycle deals pricing inventory",
  parts: "motorcycle parts accessories specials",
  apparel: "motorcycle riding gear apparel promotion",
  service: "motorcycle service maintenance offer",
  financing: "motorcycle financing specials APR customer cash",
  national_campaign: "manufacturer national motorcycle campaign",
  dealer_event: "motorcycle dealer event open house demo day"
};

const TAG_LABELS: Record<CampaignTag, string> = {
  sales: "Sales",
  parts: "Parts",
  apparel: "Apparel",
  service: "Service",
  financing: "Financing",
  national_campaign: "National Campaign",
  dealer_event: "Dealer Event"
};

const FINANCE_TRADE_TERMS_RE =
  /\b(financ(?:e|ing|ed)?|apr|credit|payment|cash\s*back|customer\s*cash|trade(?:\s|-)?in|value\s+your\s+trade)\b/i;
const TRADE_ONLY_TERMS_RE =
  /\b(value\s*(?:your|my)\s*trade|trade(?:\s*-\s*in|\s+in)?|trade\s+value|trade\s+appraisal|appraisal|sell\s+my\s+bike|cash\s+offer)\b/i;
const PARTS_APPAREL_TERMS_RE =
  /\b(parts?|accessor(?:y|ies)|gear|apparel|helmet|jacket|gloves?|riding\s+gear|motorclothes?)\b/i;
const SERVICE_TERMS_RE =
  /\b(service|maintenance|repair|shop|oil\s*change|inspection|diagnostic|tires?|brakes?)\b/i;

export type GenerateCampaignInput = {
  name: string;
  buildMode: CampaignBuildMode;
  channel: CampaignChannel;
  tags: CampaignTag[];
  prompt?: string;
  description?: string;
  inspirationImageUrls?: string[];
  assetImageUrls?: string[];
  briefDocumentUrls?: string[];
  dealerProfile?: DealerProfile | null;
};

export type GenerateCampaignOutput = {
  status: "generated";
  inspirationImageUrls?: string[];
  smsBody?: string;
  emailSubject?: string;
  emailBodyText?: string;
  emailBodyHtml?: string;
  sourceHits: CampaignSourceHit[];
  generatedBy: CampaignEntry["generatedBy"];
  metadata: Record<string, unknown>;
};

type DealerBrandContext = {
  websiteUrl?: string;
  title?: string;
  description?: string;
  logoImageUrls?: string[];
  imageUrls?: string[];
};

type GooglePlacePhotoResult = {
  placeId?: string;
  source?: "profile_place_id" | "text_search";
  photoUrls: string[];
  error?: string;
};

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeUrls(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map(v => normalizeText(v))
        .filter(Boolean)
    )
  );
}

function normalizeHttpUrl(raw: string | null | undefined, base?: string): string {
  const value = normalizeText(raw);
  if (!value) return "";
  try {
    return base ? new URL(value, base).toString() : new URL(value).toString();
  } catch {
    return "";
  }
}

function localCampaignUploadPathForUrl(url: string): string {
  const value = normalizeText(url);
  if (!value) return "";
  let pathname = "";
  if (value.startsWith("/uploads/")) {
    pathname = value;
  } else {
    try {
      const parsed = new URL(value);
      pathname = String(parsed.pathname ?? "");
    } catch {
      return "";
    }
  }
  if (!pathname.startsWith("/uploads/")) return "";
  const rel = pathname.replace(/^\/uploads\//, "");
  return path.resolve(getDataDir(), "uploads", rel);
}

function normalizeGooglePlaceId(value: unknown): string {
  const raw = normalizeText(value);
  if (!raw) return "";
  const match = raw.match(/places\/([^/?#]+)/i);
  return match?.[1] ? String(match[1]).trim() : raw;
}

function campaignUploadsDir(): string {
  return path.resolve(getDataDir(), "uploads", "campaigns");
}

function campaignPublicUploadUrl(fileName: string): string {
  const publicBase = normalizeText(process.env.PUBLIC_BASE_URL);
  return publicBase
    ? `${publicBase.replace(/\/$/, "")}/uploads/campaigns/${fileName}`
    : `/uploads/campaigns/${fileName}`;
}

function extensionForImageContentType(contentType: string): string {
  const lower = String(contentType ?? "").toLowerCase();
  if (lower.includes("png")) return ".png";
  if (lower.includes("webp")) return ".webp";
  if (lower.includes("gif")) return ".gif";
  if (lower.includes("bmp")) return ".bmp";
  if (lower.includes("heic")) return ".heic";
  if (lower.includes("heif")) return ".heif";
  if (lower.includes("jpeg") || lower.includes("jpg")) return ".jpg";
  return ".jpg";
}

function parseHostFromUrl(raw: unknown): string {
  const value = normalizeText(raw);
  if (!value) return "";
  try {
    return new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function buildGooglePlaceTextQuery(profile?: DealerProfile | null): string {
  const dealerName = normalizeText(profile?.dealerName);
  const line1 = normalizeText(profile?.address?.line1);
  const city = normalizeText(profile?.address?.city);
  const state = normalizeText(profile?.address?.state);
  const websiteHost = parseHostFromUrl(profile?.website);
  const parts = [dealerName, line1, [city, state].filter(Boolean).join(", "), websiteHost]
    .map(v => normalizeWhitespace(v))
    .filter(Boolean);
  if (!parts.length) return "";
  return parts.join(" ");
}

async function saveCampaignExternalImage(buffer: Buffer, contentType: string, prefix: string): Promise<string | null> {
  if (!buffer.length) return null;
  if (buffer.length > 12 * 1024 * 1024) return null;
  const ext = extensionForImageContentType(contentType);
  const fileName = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
  const dir = campaignUploadsDir();
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), buffer);
    return campaignPublicUploadUrl(fileName);
  } catch {
    return null;
  }
}

async function fetchGooglePlacePhotos(
  profile?: DealerProfile | null,
  opts?: { maxPhotos?: number; timeoutMs?: number; force?: boolean }
): Promise<GooglePlacePhotoResult> {
  const enabled = opts?.force === true || profile?.webSearch?.useGooglePlacePhotos === true;
  if (!enabled) return { photoUrls: [] };
  const apiKey = normalizeText(process.env.GOOGLE_PLACES_API_KEY);
  if (!apiKey) return { photoUrls: [], error: "google_places_api_key_missing" };

  const maxPhotos = Math.max(1, Math.min(8, Number(opts?.maxPhotos ?? process.env.CAMPAIGN_GOOGLE_PLACE_PHOTO_MAX ?? 4)));
  const timeoutMs = Math.max(1200, Number(opts?.timeoutMs ?? process.env.CAMPAIGN_GOOGLE_PLACE_TIMEOUT_MS ?? 3800));
  const photoUrls: string[] = [];
  let placeId = normalizeGooglePlaceId(profile?.webSearch?.googlePlaceId);
  let source: GooglePlacePhotoResult["source"] | undefined = placeId ? "profile_place_id" : undefined;

  const runJsonRequest = async (
    url: string,
    fieldMask: string,
    body?: Record<string, unknown>
  ): Promise<any | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: body ? "POST" : "GET",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
          "x-goog-fieldmask": fieldMask
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
      if (!resp.ok) return null;
      return await resp.json().catch(() => null);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  if (!placeId) {
    const textQuery = buildGooglePlaceTextQuery(profile);
    if (textQuery) {
      const searchPayload = await runJsonRequest(
        "https://places.googleapis.com/v1/places:searchText",
        "places.id,places.name,places.displayName,places.photos.name",
        {
          textQuery,
          maxResultCount: 1
        }
      );
      const candidate = Array.isArray(searchPayload?.places) ? searchPayload.places[0] : null;
      const byName = normalizeGooglePlaceId(candidate?.name);
      const byId = normalizeGooglePlaceId(candidate?.id);
      placeId = byId || byName;
      if (placeId) source = "text_search";
    }
  }

  if (!placeId) return { photoUrls: [], error: "google_place_id_unresolved" };

  const detailsPayload = await runJsonRequest(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
    "id,name,displayName,photos.name"
  );
  const photoNames = Array.isArray(detailsPayload?.photos)
    ? detailsPayload.photos
        .map((row: any) => normalizeText(row?.name))
        .filter(Boolean)
        .slice(0, maxPhotos)
    : [];
  if (!photoNames.length) {
    return { placeId, source, photoUrls: [], error: "google_place_has_no_photos" };
  }

  for (const photoName of photoNames) {
    if (photoUrls.length >= maxPhotos) break;
    const mediaUrl = `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=1600&key=${encodeURIComponent(apiKey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(mediaUrl, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal
      });
      if (!resp.ok) continue;
      const contentType = String(resp.headers.get("content-type") ?? "").toLowerCase();
      if (!contentType.includes("image")) continue;
      const bytes = Buffer.from(await resp.arrayBuffer());
      const saved = await saveCampaignExternalImage(bytes, contentType, "campaign_place");
      if (saved && !photoUrls.includes(saved)) {
        photoUrls.push(saved);
      }
    } catch {
      // ignore single-photo failures
    } finally {
      clearTimeout(timer);
    }
  }

  return { placeId, source, photoUrls };
}

function applyGooglePlaceMetadata(
  output: GenerateCampaignOutput,
  placePhotos: GooglePlacePhotoResult,
  usedPhotoCount: number
): GenerateCampaignOutput {
  return {
    ...output,
    metadata: {
      ...(output.metadata ?? {}),
      googlePlacePhotoCount: usedPhotoCount,
      googlePlacePhotoSource: placePhotos.source ?? null,
      googlePlaceId: placePhotos.placeId ?? null,
      googlePlaceError: placePhotos.error ?? null
    }
  };
}

function normalizeWhitespace(text: string): string {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function tagsSet(tags: CampaignTag[]): Set<CampaignTag> {
  return new Set(tags ?? []);
}

function shouldSuppressFinanceTradeByTags(tags: CampaignTag[]): boolean {
  const set = tagsSet(tags);
  const operationalFocus = set.has("parts") || set.has("apparel") || set.has("service");
  return operationalFocus && !set.has("financing") && !set.has("sales");
}

function hasExplicitTradeRequest(input: GenerateCampaignInput): boolean {
  const joined = normalizeWhitespace(
    [input.name, input.prompt, input.description]
      .map(v => String(v ?? ""))
      .join(" ")
      .toLowerCase()
  );
  if (!joined) return false;
  return TRADE_ONLY_TERMS_RE.test(joined);
}

function shouldSuppressTradeByInput(input: GenerateCampaignInput): boolean {
  return !hasExplicitTradeRequest(input);
}

function textForHit(hit: CampaignSourceHit): string {
  return normalizeWhitespace(
    [hit.title, hit.snippet, hit.url, hit.domain]
      .map(v => String(v ?? ""))
      .join(" ")
      .toLowerCase()
  );
}

function filterSourceHitsByTags(
  sourceHits: CampaignSourceHit[],
  tags: CampaignTag[],
  suppressTradeOnly: boolean
): CampaignSourceHit[] {
  if (!Array.isArray(sourceHits) || !sourceHits.length) return [];
  let rows = sourceHits.slice();

  if (suppressTradeOnly) {
    rows = rows.filter(hit => !TRADE_ONLY_TERMS_RE.test(textForHit(hit)));
  }

  if (shouldSuppressFinanceTradeByTags(tags)) {
    rows = rows.filter(hit => !FINANCE_TRADE_TERMS_RE.test(textForHit(hit)));
  }

  const set = tagsSet(tags);
  const requirePartsApparel = (set.has("parts") || set.has("apparel")) && !set.has("sales") && !set.has("financing");
  const requireService = set.has("service") && !set.has("sales") && !set.has("financing");

  if (requirePartsApparel) {
    const narrowed = rows.filter(hit => PARTS_APPAREL_TERMS_RE.test(textForHit(hit)));
    if (narrowed.length) rows = narrowed;
  } else if (requireService) {
    const narrowed = rows.filter(hit => SERVICE_TERMS_RE.test(textForHit(hit)));
    if (narrowed.length) rows = narrowed;
  }

  return rows;
}

function filterImageUrlsByTags(urls: string[], tags: CampaignTag[], suppressTradeOnly: boolean): string[] {
  let rows = normalizeUrls(urls);
  if (!rows.length) return rows;

  if (suppressTradeOnly) {
    rows = rows.filter(url => !TRADE_ONLY_TERMS_RE.test(String(url ?? "").toLowerCase()));
  }

  const set = tagsSet(tags);
  const blockFinanceTrade = shouldSuppressFinanceTradeByTags(tags);
  if (blockFinanceTrade) {
    rows = rows.filter(url => !FINANCE_TRADE_TERMS_RE.test(String(url ?? "").toLowerCase()));
  }

  const requirePartsApparel = (set.has("parts") || set.has("apparel")) && !set.has("sales") && !set.has("financing");
  const requireService = set.has("service") && !set.has("sales") && !set.has("financing");
  if (requirePartsApparel) {
    const narrowed = rows.filter(url => PARTS_APPAREL_TERMS_RE.test(String(url ?? "").toLowerCase()));
    if (narrowed.length) rows = narrowed;
  } else if (requireService) {
    const narrowed = rows.filter(url => SERVICE_TERMS_RE.test(String(url ?? "").toLowerCase()));
    if (narrowed.length) rows = narrowed;
  }

  return rows;
}

function stripTradeLanguage(text: string): string {
  const raw = String(text ?? "").trim();
  if (!raw) return "";
  const lines = raw
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean);
  const keptLines = lines.filter(line => !TRADE_ONLY_TERMS_RE.test(line));
  let compact = keptLines.join("\n").trim();
  if (!compact && TRADE_ONLY_TERMS_RE.test(raw)) return "";
  if (TRADE_ONLY_TERMS_RE.test(compact)) {
    const sentences = compact
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(Boolean)
      .filter(s => !TRADE_ONLY_TERMS_RE.test(s));
    compact = sentences.join(" ").trim();
  }
  return compact;
}

function applyNoTradeLanguageGuard(
  output: GenerateCampaignOutput,
  dealerNameRaw: string | null | undefined
): GenerateCampaignOutput {
  const dealerName = normalizeText(dealerNameRaw) || "our dealership";
  const smsFallback = `Quick update from ${dealerName}: Reply here and I can share current details.`;
  const emailSubjectFallback = `${dealerName} | Current update`;
  const emailBodyFallback = `Hi there,\n\nQuick update from ${dealerName}. Reply here and I can share current details.`;
  const smsBody = stripTradeLanguage(String(output.smsBody ?? "")) || smsFallback;
  const emailSubject = stripTradeLanguage(String(output.emailSubject ?? "")) || emailSubjectFallback;
  const emailBodyText = stripTradeLanguage(String(output.emailBodyText ?? "")) || emailBodyFallback;
  return {
    ...output,
    smsBody,
    emailSubject,
    emailBodyText,
    emailBodyHtml: textToHtml(emailBodyText, output.sourceHits ?? [])
  };
}

type BriefDocContext = {
  url: string;
  type: "text" | "pdf" | "binary" | "missing";
  excerpt: string;
};

async function readBriefContextFromUrl(url: string): Promise<BriefDocContext> {
  const filePath = localCampaignUploadPathForUrl(url);
  if (!filePath) {
    return {
      url,
      type: "missing",
      excerpt: "File is external; content not extracted. Use URL for reference."
    };
  }
  const ext = path.extname(filePath).toLowerCase();
  try {
    const buffer = await fs.readFile(filePath);
    if (!buffer.length) {
      return { url, type: "missing", excerpt: "File was empty." };
    }
    if (ext === ".pdf") {
      return {
        url,
        type: "pdf",
        excerpt: "PDF uploaded. Use file as promotion/event source of truth."
      };
    }
    const textExt = new Set([
      ".txt",
      ".md",
      ".markdown",
      ".csv",
      ".json",
      ".yaml",
      ".yml",
      ".html",
      ".htm"
    ]);
    if (textExt.has(ext)) {
      const raw = buffer.toString("utf8");
      const excerpt = normalizeWhitespace(raw).slice(0, 900);
      return {
        url,
        type: "text",
        excerpt: excerpt || "Text file uploaded (empty after normalization)."
      };
    }
    return {
      url,
      type: "binary",
      excerpt: "File uploaded. Treat as supporting campaign brief context."
    };
  } catch {
    return {
      url,
      type: "missing",
      excerpt: "Uploaded file could not be read from storage."
    };
  }
}

async function collectBriefContexts(urls: string[]): Promise<BriefDocContext[]> {
  const targets = normalizeUrls(urls).slice(0, 6);
  const out: BriefDocContext[] = [];
  for (const url of targets) {
    out.push(await readBriefContextFromUrl(url));
  }
  return out;
}

function likelyImageUrl(url: string): boolean {
  const value = normalizeText(url).toLowerCase();
  if (!value) return false;
  if (value.startsWith("data:")) return false;
  try {
    const parsed = new URL(value);
    const path = `${parsed.pathname}${parsed.search}`.toLowerCase();
    return /\.(jpg|jpeg|png|webp|gif|bmp|svg)(\?|$)/i.test(path) || /image|img|photo|media/.test(path);
  } catch {
    return false;
  }
}

function extractImageUrlsFromHtml(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  const add = (candidate: string) => {
    const normalized = normalizeHttpUrl(candidate, pageUrl);
    if (!normalized) return;
    if (!likelyImageUrl(normalized)) return;
    if (out.includes(normalized)) return;
    out.push(normalized);
  };

  const patterns = [
    /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image|twitter:image:src)["'][^>]*content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image|twitter:image:src)["'][^>]*>/gi,
    /<link[^>]+rel=["'][^"']*image_src[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>/gi,
    /<img[^>]+src=["']([^"']+)["'][^>]*>/gi
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null = null;
    while ((match = pattern.exec(html))) {
      add(String(match[1] ?? ""));
      if (out.length >= 24) break;
    }
    if (out.length >= 24) break;
  }
  return out;
}

function extractTitleFromHtml(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return normalizeText(match?.[1] ?? "").replace(/\s+/g, " ").trim();
}

function extractMetaFromHtml(html: string, keys: string[]): string {
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(
        `<meta[^>]+(?:name|property)=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`,
        "i"
      ),
      new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`,
        "i"
      )
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      const value = normalizeText(match?.[1] ?? "");
      if (value) return value;
    }
  }
  return "";
}

function pickLogoishImages(urls: string[]): string[] {
  const ranked = urls
    .map(url => {
      const lower = url.toLowerCase();
      const score =
        (lower.includes("logo") ? 5 : 0) +
        (lower.includes("brand") ? 3 : 0) +
        (lower.includes("header") ? 2 : 0) -
        (lower.includes("icon") ? 1 : 0);
      return { url, score };
    })
    .sort((a, b) => b.score - a.score);
  return Array.from(new Set(ranked.map(row => row.url))).slice(0, 4);
}

async function fetchDealerBrandContext(profile?: DealerProfile | null): Promise<DealerBrandContext> {
  const websiteUrl = normalizeHttpUrl(profile?.website ?? "");
  if (!websiteUrl) return {};
  const timeoutMs = Math.max(1000, Number(process.env.CAMPAIGN_BRAND_FETCH_TIMEOUT_MS ?? 2200));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(websiteUrl, {
      method: "GET",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0 (compatible; ThrottleIQCampaignBot/1.0)"
      },
      signal: controller.signal
    });
    const contentType = String(resp.headers.get("content-type") ?? "").toLowerCase();
    if (!resp.ok || !contentType.includes("text/html")) {
      return { websiteUrl };
    }
    const html = await resp.text();
    const title = extractTitleFromHtml(html);
    const description =
      extractMetaFromHtml(html, ["description", "og:description", "twitter:description"]) || undefined;
    const imageUrls = extractImageUrlsFromHtml(html, websiteUrl).slice(0, 10);
    const logoImageUrls = pickLogoishImages(imageUrls);
    return {
      websiteUrl,
      title: title || undefined,
      description,
      logoImageUrls,
      imageUrls
    };
  } catch {
    return { websiteUrl };
  } finally {
    clearTimeout(timer);
  }
}

async function collectImageCandidatesFromHits(
  sourceHits: CampaignSourceHit[],
  opts?: { maxImages?: number; timeoutMs?: number }
): Promise<string[]> {
  const maxImages = Math.max(1, Math.min(12, Number(opts?.maxImages ?? 6)));
  const timeoutMs = Math.max(800, Number(opts?.timeoutMs ?? process.env.CAMPAIGN_IMAGE_FETCH_TIMEOUT_MS ?? 1800));
  const pages = sourceHits
    .map(hit => normalizeHttpUrl(hit.url))
    .filter(Boolean)
    .slice(0, 4);
  if (!pages.length) return [];

  const found: string[] = [];
  for (const pageUrl of pages) {
    if (found.length >= maxImages) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(pageUrl, {
        method: "GET",
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": "Mozilla/5.0 (compatible; ThrottleIQCampaignBot/1.0)"
        },
        signal: controller.signal
      });
      const contentType = String(resp.headers.get("content-type") ?? "").toLowerCase();
      if (!resp.ok || !contentType.includes("text/html")) continue;
      const html = await resp.text();
      const images = extractImageUrlsFromHtml(html, pageUrl);
      for (const imageUrl of images) {
        if (found.includes(imageUrl)) continue;
        found.push(imageUrl);
        if (found.length >= maxImages) break;
      }
    } catch {
      // ignore page fetch errors; continue with other sources
    } finally {
      clearTimeout(timer);
    }
  }
  return found;
}

function safeParseJson(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractJsonObject(raw: string): any | null {
  const direct = safeParseJson(raw);
  if (direct && typeof direct === "object") return direct;
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return safeParseJson(raw.slice(firstBrace, lastBrace + 1));
  }
  return null;
}

function isGpt5Model(model: string): boolean {
  return /^gpt-5/i.test(String(model ?? "").trim());
}

function modelSupportsTemperature(model: string): boolean {
  return !isGpt5Model(model);
}

function optionalTemperature(model: string, temperature: number): Record<string, number> {
  return modelSupportsTemperature(model) ? { temperature } : {};
}

function optionalReasoning(model: string): Record<string, { effort: "minimal" }> {
  return isGpt5Model(model) ? { reasoning: { effort: "minimal" } } : {};
}

function optionalTextVerbosity(model: string): Record<string, { verbosity: "low" }> {
  return isGpt5Model(model) ? { text: { verbosity: "low" } } : {};
}

function toSourceHits(result: Awaited<ReturnType<typeof searchGoogleCse>>): CampaignSourceHit[] {
  if (!result?.hits?.length) return [];
  return result.hits.slice(0, 8).map(hit => ({
    title: normalizeText(hit.title),
    snippet: normalizeText(hit.snippet),
    url: normalizeText(hit.url),
    domain: normalizeText(hit.domain)
  }));
}

function buildSearchQuery(input: GenerateCampaignInput): string {
  const parts = [
    normalizeText(input.prompt),
    normalizeText(input.name),
    normalizeText(input.description),
    ...input.tags.map(tag => TAG_SEARCH_HINTS[tag] ?? "")
  ]
    .map(v => v.trim())
    .filter(Boolean);

  let base = parts.join(" ").slice(0, 420).trim();
  const suppressTradeOnly = shouldSuppressTradeByInput(input);
  if (shouldSuppressFinanceTradeByTags(input.tags)) {
    base = `${base} -trade -trade-in -financing -apr -credit -payment -cash`.trim();
  } else if (suppressTradeOnly) {
    base = `${base} -trade -trade-in -"value your trade" -appraisal`.trim();
  }
  if (base) return base;
  if (input.tags.includes("financing")) return "motorcycle financing specials";
  if (input.tags.includes("service")) return "motorcycle service offers";
  if (input.tags.includes("parts")) return "motorcycle parts specials";
  if (input.tags.includes("apparel")) return "motorcycle apparel promotion";
  return "motorcycle dealer promotion";
}

function deriveTopicFromSourceHits(sourceHits: CampaignSourceHit[]): string {
  for (const hit of sourceHits) {
    const title = normalizeText(hit.title);
    if (title && title.length <= 140) return title;
    const snippet = normalizeText(hit.snippet);
    if (snippet) {
      const firstSentence = snippet.split(/[.!?]/)[0]?.trim() || "";
      if (firstSentence) return firstSentence.slice(0, 160);
    }
  }
  return "";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function textToHtml(text: string, sourceHits: CampaignSourceHit[]): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p style="margin:0 0 12px 0;line-height:1.5;">${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
    .join("");
  if (!sourceHits.length) return paragraphs;
  const links = sourceHits
    .slice(0, 4)
    .filter(hit => hit.url)
    .map(hit => {
      const label = escapeHtml(hit.title || hit.domain || hit.url || "Reference");
      const href = escapeHtml(hit.url || "");
      return `<li style="margin:0 0 6px 0;"><a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a></li>`;
    })
    .join("");
  if (!links) return paragraphs;
  return `${paragraphs}<p style="margin:10px 0 6px 0;font-weight:600;">References</p><ul style="margin:0 0 0 18px;padding:0;">${links}</ul>`;
}

function buildTemplateOutput(
  input: GenerateCampaignInput,
  sourceHits: CampaignSourceHit[],
  searchQuery: string,
  resolvedInspirationImageUrls: string[],
  brandContext?: DealerBrandContext,
  briefContexts?: BriefDocContext[]
): GenerateCampaignOutput {
  const dealerName = normalizeText(input.dealerProfile?.dealerName) || "our dealership";
  const tagLabels = input.tags.map(tag => TAG_LABELS[tag]).join(", ") || "General";
  const topic =
    deriveTopicFromSourceHits(sourceHits) ||
    normalizeText(input.prompt) ||
    normalizeText(input.name) ||
    normalizeText(input.description) ||
    "current offers";
  const referenceLine = sourceHits[0]?.url
    ? `You can review details here: ${sourceHits[0].url}`
    : "Reply here and I can share details that fit what you're shopping for.";
  const smsBody = `Quick update from ${dealerName}: ${topic}. ${referenceLine}`;
  const emailSubject = `${dealerName} | ${topic.slice(0, 80)}`;
  const emailBodyText = [
    `Hi there,`,
    ``,
    `Quick campaign update from ${dealerName}.`,
    `${topic}`,
    ``,
    sourceHits[0]?.url ? `Reference: ${sourceHits[0].url}` : "Reply and we can send specific options.",
    ``,
    `Tags: ${tagLabels}`
  ]
    .filter(Boolean)
    .join("\n");

  return {
    status: "generated",
    inspirationImageUrls: resolvedInspirationImageUrls,
    smsBody,
    emailSubject,
    emailBodyText,
    emailBodyHtml: textToHtml(emailBodyText, sourceHits),
    sourceHits,
    generatedBy: "template",
    metadata: {
      buildMode: input.buildMode,
      searchQuery,
      sourceCount: sourceHits.length,
      briefDocumentCount: normalizeUrls(input.briefDocumentUrls).length,
      briefExtractedCount: (briefContexts ?? []).filter(row => row.type === "text").length,
      generator: "template",
      brandWebsite: brandContext?.websiteUrl ?? null
    }
  };
}

async function tryGenerateWithLlm(args: {
  input: GenerateCampaignInput;
  sourceHits: CampaignSourceHit[];
  searchQuery: string;
  resolvedInspirationImageUrls: string[];
  brandContext?: DealerBrandContext;
  briefContexts?: BriefDocContext[];
}): Promise<GenerateCampaignOutput | null> {
  if (process.env.LLM_ENABLED !== "1" || !process.env.OPENAI_API_KEY) return null;
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const dealerName = normalizeText(args.input.dealerProfile?.dealerName) || "the dealership";
  const website = normalizeText(args.input.dealerProfile?.website);
  const phone = normalizeText(args.input.dealerProfile?.phone);
  const bookingUrl = normalizeText(args.input.dealerProfile?.bookingUrl);
  const tags = args.input.tags.map(tag => TAG_LABELS[tag]).join(", ") || "General";
  const suppressTradeOnly = shouldSuppressTradeByInput(args.input);
  const brandWebsite = normalizeText(args.brandContext?.websiteUrl);
  const brandTitle = normalizeText(args.brandContext?.title);
  const brandDescription = normalizeText(args.brandContext?.description);
  const brandLogoUrls = normalizeUrls(args.brandContext?.logoImageUrls).slice(0, 3);
  const briefUrls = normalizeUrls(args.input.briefDocumentUrls).slice(0, 6);
  const briefBlock = (args.briefContexts ?? [])
    .map((doc, idx) => `${idx + 1}. ${doc.url}\nType: ${doc.type}\nExtracted: ${doc.excerpt}`)
    .join("\n\n");
  const sourceBlock = args.sourceHits.length
    ? args.sourceHits
        .slice(0, 6)
        .map((hit, idx) => `${idx + 1}. ${hit.title || hit.domain || "Reference"} | ${hit.url || ""} | ${hit.snippet || ""}`)
        .join("\n")
    : "(No web references were found)";

  const schema: { [key: string]: unknown } = {
    type: "object",
    additionalProperties: false,
    required: ["sms_body", "email_subject", "email_body_text"],
    properties: {
      sms_body: { type: "string" },
      email_subject: { type: "string" },
      email_body_text: { type: "string" }
    }
  };

  const prompt = [
    "You are creating dealership campaign copy for SMS and Email.",
    "Return only JSON that matches the schema.",
    "Tone: dealership-friendly, human, concise, no hypey spam language.",
    "Do not invent promo details not grounded in the provided context/reference list.",
    "When description is empty or generic, derive specifics from the reference hits and dealer website context.",
    "Do not require the user to provide manual description details if references already include them.",
    "If details are uncertain, say programs vary by approval/term and invite reply.",
    shouldSuppressFinanceTradeByTags(args.input.tags)
      ? "Hard guardrail: do NOT mention financing/APR/credit/payments/trade-in/value-your-trade language."
      : suppressTradeOnly
        ? "Hard guardrail: do NOT mention trade/trade-in/value-your-trade/appraisal language."
      : "Hard guardrail: keep copy aligned to selected tags and avoid unrelated offer categories.",
    "No emojis unless explicitly in prompt.",
    "",
    `Dealer: ${dealerName}`,
    `Website: ${website || "(not provided)"}`,
    `Brand website (must align to this): ${brandWebsite || website || "(not provided)"}`,
    `Brand page title: ${brandTitle || "(none)"}`,
    `Brand page description: ${brandDescription || "(none)"}`,
    `Brand logo/hero images: ${brandLogoUrls.join(", ") || "(none)"}`,
    `Phone: ${phone || "(not provided)"}`,
    `Booking URL: ${bookingUrl || "(not provided)"}`,
    `Build mode: ${args.input.buildMode}`,
    `Channel: ${args.input.channel}`,
    `Tags: ${tags}`,
    `Campaign name: ${normalizeText(args.input.name) || "(untitled)"}`,
    `Description (optional): ${normalizeText(args.input.description) || "(none)"}`,
    `Prompt: ${normalizeText(args.input.prompt) || "(none)"}`,
    `Inspiration images: ${normalizeUrls(args.resolvedInspirationImageUrls).join(", ") || "(none)"}`,
    `Asset images: ${normalizeUrls(args.input.assetImageUrls).join(", ") || "(none)"}`,
    `Brief document URLs: ${briefUrls.join(", ") || "(none)"}`,
    `Web search query: ${args.searchQuery}`,
    "",
    "Brief file excerpts:",
    briefBlock || "(No brief files provided)",
    "",
    "Reference hits:",
    sourceBlock,
    "",
    "Output requirements:",
    "- sms_body: 1-2 short sentences.",
    "- email_subject: under 75 chars.",
    "- email_body_text: plain text email body with clear CTA."
  ].join("\n");

  const parseObject = (raw: string): any | null => {
    const parsed = extractJsonObject(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  };

  try {
    const parsedResp = await client.responses.parse({
      model,
      input: prompt,
      ...optionalReasoning(model),
      ...optionalTemperature(model, 0.2),
      max_output_tokens: 700,
      text: {
        format: {
          type: "json_schema",
          name: "campaign_copy",
          schema,
          strict: true
        }
      }
    });
    const parsed = ((parsedResp as any)?.output_parsed as any) || parseObject(parsedResp.output_text ?? "");
    if (parsed?.sms_body || parsed?.email_subject || parsed?.email_body_text) {
      const smsBody = normalizeText(parsed.sms_body);
      const emailSubject = normalizeText(parsed.email_subject);
      const emailBodyText = normalizeText(parsed.email_body_text);
      if (smsBody || emailSubject || emailBodyText) {
        return {
          status: "generated",
          inspirationImageUrls: args.resolvedInspirationImageUrls,
          smsBody: smsBody || undefined,
          emailSubject: emailSubject || undefined,
          emailBodyText: emailBodyText || undefined,
          emailBodyHtml: emailBodyText ? textToHtml(emailBodyText, args.sourceHits) : undefined,
          sourceHits: args.sourceHits,
          generatedBy: "llm_fallback",
          metadata: {
            buildMode: args.input.buildMode,
            searchQuery: args.searchQuery,
            sourceCount: args.sourceHits.length,
            briefDocumentCount: briefUrls.length,
            briefExtractedCount: (args.briefContexts ?? []).filter(row => row.type === "text").length,
            generator: "llm_fallback",
            model,
            brandWebsite: brandWebsite || website || null
          }
        };
      }
    }
  } catch {
    // fall through to compatibility response call below
  }

  try {
    const resp = await client.responses.create({
      model,
      input: prompt,
      ...optionalReasoning(model),
      ...optionalTextVerbosity(model),
      ...optionalTemperature(model, 0.2),
      max_output_tokens: 700
    });
    const parsed = parseObject(resp.output_text ?? "");
    if (parsed?.sms_body || parsed?.email_subject || parsed?.email_body_text) {
      const smsBody = normalizeText(parsed.sms_body);
      const emailSubject = normalizeText(parsed.email_subject);
      const emailBodyText = normalizeText(parsed.email_body_text);
      if (smsBody || emailSubject || emailBodyText) {
        return {
          status: "generated",
          inspirationImageUrls: args.resolvedInspirationImageUrls,
          smsBody: smsBody || undefined,
          emailSubject: emailSubject || undefined,
          emailBodyText: emailBodyText || undefined,
          emailBodyHtml: emailBodyText ? textToHtml(emailBodyText, args.sourceHits) : undefined,
          sourceHits: args.sourceHits,
          generatedBy: "llm_fallback",
          metadata: {
            buildMode: args.input.buildMode,
            searchQuery: args.searchQuery,
            sourceCount: args.sourceHits.length,
            briefDocumentCount: briefUrls.length,
            briefExtractedCount: (args.briefContexts ?? []).filter(row => row.type === "text").length,
            generator: "llm_fallback",
            model,
            brandWebsite: brandWebsite || website || null
          }
        };
      }
    }
  } catch {
    return null;
  }

  return null;
}

export async function generateCampaignContent(input: GenerateCampaignInput): Promise<GenerateCampaignOutput> {
  const suppressTradeOnly = shouldSuppressTradeByInput(input);
  const brandContext = await fetchDealerBrandContext(input.dealerProfile ?? null);
  const briefContexts = await collectBriefContexts(normalizeUrls(input.briefDocumentUrls));
  const shouldRunWebSearch = input.buildMode === "web_search_design";
  const userProvidedInspiration = normalizeUrls(input.inspirationImageUrls);
  const userProvidedAssetImages = normalizeUrls(input.assetImageUrls);
  const hasUserReferenceOverride = userProvidedInspiration.length > 0 || userProvidedAssetImages.length > 0;
  const forcePlacePhotos = input.tags.includes("dealer_event") && !hasUserReferenceOverride;
  const googlePlacePhotos = shouldRunWebSearch
    ? await fetchGooglePlacePhotos(input.dealerProfile ?? null, {
        maxPhotos: Number(process.env.CAMPAIGN_GOOGLE_PLACE_PHOTO_MAX ?? 4),
        force: forcePlacePhotos
      })
    : { photoUrls: [] as string[] };
  const searchQuery = shouldRunWebSearch ? buildSearchQuery(input) : "";
  const searchResult =
    shouldRunWebSearch && searchQuery
      ? await searchGoogleCse({
          query: searchQuery,
          profile: input.dealerProfile ?? undefined,
          maxResults: 6
        })
      : null;
  const sourceHits = filterSourceHitsByTags(toSourceHits(searchResult), input.tags, suppressTradeOnly);
  const placeDiscoveredInspiration = shouldRunWebSearch
    ? filterImageUrlsByTags(googlePlacePhotos.photoUrls, input.tags, suppressTradeOnly)
    : [];
  const websiteDiscoveredInspiration = shouldRunWebSearch
    ? filterImageUrlsByTags(
        normalizeUrls(brandContext.imageUrls).slice(0, Math.max(1, Number(process.env.CAMPAIGN_BRAND_IMAGE_MAX ?? 4))),
        input.tags,
        suppressTradeOnly
      )
    : [];
  const autoDiscoveredInspiration =
    shouldRunWebSearch && !userProvidedInspiration.length
      ? filterImageUrlsByTags(
          await collectImageCandidatesFromHits(sourceHits, {
            maxImages: Number(process.env.CAMPAIGN_AUTO_IMAGE_MAX ?? 6)
          }),
          input.tags,
          suppressTradeOnly
        )
      : [];
  const resolvedInspirationImageUrls = userProvidedInspiration.length
    ? userProvidedInspiration
    : Array.from(
        new Set([...placeDiscoveredInspiration, ...websiteDiscoveredInspiration, ...autoDiscoveredInspiration])
      ).slice(
        0,
        Math.max(1, Number(process.env.CAMPAIGN_FINAL_IMAGE_MAX ?? 6))
      );

  const llm = await tryGenerateWithLlm({
    input,
    sourceHits,
    searchQuery,
    resolvedInspirationImageUrls,
    brandContext,
    briefContexts
  });
  if (llm) {
    const withPlacesMeta = applyGooglePlaceMetadata(
      llm,
      googlePlacePhotos,
      placeDiscoveredInspiration.length
    );
    withPlacesMeta.metadata = {
      ...(withPlacesMeta.metadata ?? {}),
      googlePlaceForcedForDealerEvent: forcePlacePhotos
    };
    return suppressTradeOnly
      ? applyNoTradeLanguageGuard(withPlacesMeta, input.dealerProfile?.dealerName)
      : withPlacesMeta;
  }

  const template = buildTemplateOutput(
    input,
    sourceHits,
    searchQuery,
    resolvedInspirationImageUrls,
    brandContext,
    briefContexts
  );
  const withPlacesMeta = applyGooglePlaceMetadata(
    template,
    googlePlacePhotos,
    placeDiscoveredInspiration.length
  );
  withPlacesMeta.metadata = {
    ...(withPlacesMeta.metadata ?? {}),
    googlePlaceForcedForDealerEvent: forcePlacePhotos
  };
  return suppressTradeOnly
    ? applyNoTradeLanguageGuard(withPlacesMeta, input.dealerProfile?.dealerName)
    : withPlacesMeta;
}
