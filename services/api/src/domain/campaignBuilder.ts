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

type CampaignEmailSection = {
  title: string;
  body: string;
  ctaText?: string;
  ctaUrl?: string;
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

const CAMPAIGN_DETAIL_URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

function extractPromptDetailUrls(input: GenerateCampaignInput): string[] {
  const detailText = [normalizeText(input.prompt), normalizeText(input.description)]
    .filter(Boolean)
    .join("\n");
  if (!detailText) return [];
  const matches = detailText.match(CAMPAIGN_DETAIL_URL_RE) ?? [];
  const normalized = matches
    .map(v => normalizeText(v).replace(/[),.;!?]+$/g, ""))
    .map(v => normalizeHttpUrl(v))
    .filter(Boolean);
  return Array.from(new Set(normalized));
}

function ensureSmsBodyIncludesPromptDetailUrls(
  output: GenerateCampaignOutput,
  requiredUrls: string[]
): GenerateCampaignOutput {
  const urls = Array.from(new Set((requiredUrls ?? []).map(v => normalizeHttpUrl(v)).filter(Boolean)));
  if (!urls.length) return output;
  const currentSms = normalizeText(output.smsBody);
  const existingSmsUrls = new Set(
    (currentSms.match(CAMPAIGN_DETAIL_URL_RE) ?? [])
      .map(v => normalizeText(v).replace(/[),.;!?]+$/g, ""))
      .map(v => normalizeHttpUrl(v))
      .filter(Boolean)
  );
  const missing = urls.filter(url => !existingSmsUrls.has(url));
  if (!missing.length) return output;
  const nextSms = currentSms ? `${currentSms}\n\n${missing.join("\n")}` : missing.join("\n");
  return {
    ...output,
    smsBody: nextSms,
    metadata: {
      ...(output.metadata ?? {}),
      requiredPromptDetailUrls: urls,
      appendedPromptDetailUrls: missing
    }
  };
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
  dealerProfile?: DealerProfile | null
): GenerateCampaignOutput {
  const dealerName = normalizeText(dealerProfile?.dealerName) || "our dealership";
  const smsFallback = `Quick update from ${dealerName}: Reply here and I can share current details.`;
  const emailSubjectFallback = `${dealerName} | Current update`;
  const emailBodyFallback = `Hi there,\n\nQuick update from ${dealerName}. Reply here and I can share current details.`;
  const smsBody = stripTradeLanguage(String(output.smsBody ?? "")) || smsFallback;
  const emailSubject = stripTradeLanguage(String(output.emailSubject ?? "")) || emailSubjectFallback;
  const emailBodyText = stripTradeLanguage(String(output.emailBodyText ?? "")) || emailBodyFallback;
  const existingEmailHtml = String(output.emailBodyHtml ?? "").trim();
  const emailBodyHtml = existingEmailHtml
    ? normalizeGeneratedEmailHtml(existingEmailHtml, {
        dealerName,
        website: dealerProfile?.website,
        logoUrl: dealerProfile?.logoUrl
      })
    : textToHtml(emailBodyText, output.sourceHits ?? [], {
        dealerName,
        emailSubject,
        website: dealerProfile?.website,
        phone: dealerProfile?.phone,
        bookingUrl: dealerProfile?.bookingUrl,
        creditAppUrl: dealerProfile?.creditAppUrl,
        offersUrl: dealerProfile?.offersUrl,
        directionsUrl: dealerProfile?.directionsUrl,
        logoUrl: dealerProfile?.logoUrl,
        imageUrls: normalizeCampaignEmailImageUrls(output.inspirationImageUrls ?? [])
      });
  return {
    ...output,
    smsBody,
    emailSubject,
    emailBodyText,
    emailBodyHtml
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

function extractHtmlFromModelOutput(raw: string): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const jsonLikeHtml = extractEmailHtmlFieldFromJsonLike(text);
  if (isRenderableEmailHtml(jsonLikeHtml)) return jsonLikeHtml;
  const fenced = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return String(fenced[1]).trim();
  if (/<(?:!doctype|html|body|table|div|section|img|p|h1|h2|h3)\b/i.test(text)) return text;
  return "";
}

function decodeEscapedHtmlString(raw: string): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  let out = text;
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
    try {
      const parsed = JSON.parse(out.replace(/^'/, '"').replace(/'$/, '"'));
      if (typeof parsed === "string") out = parsed;
    } catch {
      // keep fallback decoding below
    }
  }
  if (/\\[nrt"\\]/.test(out)) {
    out = out
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return out.trim();
}

function extractEmailHtmlFieldFromJsonLike(raw: string): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const parsed = extractJsonObject(text);
  const parsedField = normalizeText(parsed?.email_body_html);
  if (parsedField) return decodeEscapedHtmlString(parsedField);

  const keyRe = /"email_body_html"\s*:\s*"/i;
  const keyMatch = keyRe.exec(text);
  if (!keyMatch) return "";
  let i = keyMatch.index + keyMatch[0].length;
  let out = "";
  let escaped = false;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      out += `\\${ch}`;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') break;
    out += ch;
  }
  return decodeEscapedHtmlString(out);
}

function hasJsonWrapperLeak(html: string): boolean {
  const head = String(html ?? "").slice(0, 1200).toLowerCase();
  return (
    head.includes('"sms_body"') ||
    head.includes('"email_subject"') ||
    head.includes('"email_body_text"') ||
    head.includes('"email_body_html"')
  );
}

function isRenderableEmailHtml(raw: string): boolean {
  const html = String(raw ?? "").trim();
  if (!html) return false;
  if (!/<\/?[a-z][^>]*>/i.test(html)) return false;
  const structuralSignals = [
    /<html\b/i.test(html),
    /<body\b/i.test(html),
    /<table\b/i.test(html),
    /<tr\b/i.test(html),
    /<td\b/i.test(html),
    /<div\b/i.test(html),
    /<img\b/i.test(html),
    /<a\b/i.test(html)
  ].filter(Boolean).length;
  return structuralSignals >= 2;
}

function extractImageSrcUrlsFromHtml(rawHtml: string): string[] {
  const html = String(rawHtml ?? "");
  if (!html) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<img\b[^>]*\bsrc\s*=\s*(['"])(.*?)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const srcRaw = String(m[2] ?? "")
      .replace(/&amp;/gi, "&")
      .replace(/\\\//g, "/")
      .trim();
    const normalized = normalizeCampaignEmailImageUrl(srcRaw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function isCompleteEmailHtml(raw: string, expectedImageCount = 0, expectedImageUrls: string[] = []): boolean {
  const html = String(raw ?? "").trim();
  if (!isRenderableEmailHtml(html)) return false;
  const lower = html.toLowerCase();
  const tableCount = (lower.match(/<table\b/g) ?? []).length;
  const linkCount = (lower.match(/<a\b/g) ?? []).length;
  const imageCount = (lower.match(/<img\b/g) ?? []).length;
  const plainLen = htmlToPlainText(html).length;
  if (tableCount < 2 || linkCount < 1 || plainLen < 180) return false;
  if (expectedImageCount > 0) {
    const minimumImages = Math.min(3, Math.max(1, expectedImageCount));
    if (imageCount < minimumImages) return false;
  }
  const expected = normalizeCampaignEmailImageUrls(expectedImageUrls);
  if (expected.length > 0) {
    const expectedSet = new Set(expected);
    const renderedSet = new Set(extractImageSrcUrlsFromHtml(html));
    const matchedDistinct = Array.from(renderedSet).filter(url => expectedSet.has(url)).length;
    const minimumDistinctExpected = Math.min(3, Math.max(1, expectedSet.size));
    if (matchedDistinct < minimumDistinctExpected) return false;
  }
  return true;
}

function htmlToPlainText(rawHtml: string): string {
  const html = String(rawHtml ?? "");
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
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

function buildLogoSearchQuery(input: GenerateCampaignInput): string {
  const dealerName = normalizeText(input.dealerProfile?.dealerName);
  const websiteHost = parseHostFromUrl(input.dealerProfile?.website);
  const refHosts = Array.isArray(input.dealerProfile?.webSearch?.referenceUrls)
    ? input.dealerProfile!.webSearch!.referenceUrls!
        .map(v => {
          const parsed = parseHostFromUrl(v);
          if (parsed) return parsed;
          return normalizeText(v).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
        })
        .filter(Boolean)
    : [];
  const hostHint = websiteHost || refHosts[0] || "";
  if (dealerName && hostHint) {
    return `"${dealerName}" logo site:${hostHint}`;
  }
  if (dealerName) {
    return `"${dealerName}" motorcycle dealership logo`;
  }
  if (hostHint) {
    return `site:${hostHint} logo`;
  }
  return "";
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

function normalizeCampaignEmailSections(raw: unknown): CampaignEmailSection[] {
  if (!Array.isArray(raw)) return [];
  const out: CampaignEmailSection[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const title = String((row as any)?.title ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 70);
    const body = String((row as any)?.body ?? "")
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 900);
    if (!title || !body) continue;
    const dedupeKey = `${title.toLowerCase()}::${body.toLowerCase().slice(0, 180)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const ctaText = String((row as any)?.cta_text ?? (row as any)?.ctaText ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    const ctaUrl = normalizeHttpUrl(String((row as any)?.cta_url ?? (row as any)?.ctaUrl ?? ""));
    out.push({
      title,
      body,
      ctaText: ctaText || undefined,
      ctaUrl: ctaUrl || undefined
    });
    if (out.length >= 4) break;
  }
  return out;
}

function deriveCampaignEmailSectionsFromText(text: string): CampaignEmailSection[] {
  const paragraphs = String(text ?? "")
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean);
  if (paragraphs.length <= 1) return [];
  const out: CampaignEmailSection[] = [];
  const seen = new Set<string>();
  for (const rawParagraph of paragraphs.slice(1)) {
    const paragraph = rawParagraph.trim();
    if (!paragraph) continue;
    const headingMatch = paragraph.match(/^([A-Za-z0-9][A-Za-z0-9&/+\-' ]{2,65}):\s*(.+)$/s);
    const title = headingMatch?.[1]?.trim() || "";
    const body = headingMatch?.[2]?.trim() || paragraph;
    const normalizedTitle =
      title ||
      (out.length === 0
        ? "Upcoming Updates"
        : out.length === 1
          ? "Current Offers"
          : out.length === 2
            ? "New Arrivals"
            : `Update ${out.length + 1}`);
    if (!body) continue;
    const key = `${normalizedTitle.toLowerCase()}::${body.toLowerCase().slice(0, 180)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: normalizedTitle.slice(0, 70),
      body: body.slice(0, 900)
    });
    if (out.length >= 4) break;
  }
  return out;
}

function normalizeCampaignEmailImageUrl(raw: string): string {
  const value = normalizeText(raw);
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return normalizeHttpUrl(value);
  const normalizedPath = value.startsWith("/") ? value : value.startsWith("uploads/") ? `/${value}` : "";
  if (!normalizedPath) return "";
  const publicBase = normalizeText(process.env.PUBLIC_BASE_URL).replace(/\/$/, "");
  if (publicBase) return normalizeHttpUrl(normalizedPath, publicBase);
  return normalizedPath;
}

function normalizeCampaignEmailImageUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    const normalized = normalizeCampaignEmailImageUrl(String(row ?? ""));
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= 6) break;
  }
  return out;
}

function inferCampaignImageLabelFromUrl(raw: string): string {
  const normalized = normalizeCampaignEmailImageUrl(raw);
  if (!normalized) return "";
  try {
    const pathname = new URL(normalized).pathname;
    const filename = pathname.split("/").pop() || "";
    return filename
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  } catch {
    const filename = normalized.split("/").pop() || normalized;
    return filename
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  }
}

function appendCssDeclaration(style: string, property: string, value: string): string {
  const raw = String(style ?? "").trim();
  const propRe = new RegExp(`(?:^|;)\\s*${property}\\s*:`, "i");
  if (propRe.test(raw)) return raw;
  const base = raw ? raw.replace(/\s*;+\s*$/, "") + ";" : "";
  return `${base} ${property}:${value};`.trim();
}

function enforceEmailImageStyles(html: string): string {
  if (!html) return "";
  return html.replace(/<img\b([^>]*?)>/gi, (full, attrsRaw) => {
    let attrs = String(attrsRaw ?? "");
    const styleMatch = attrs.match(/\bstyle\s*=\s*(['"])([\s\S]*?)\1/i);
    let style = styleMatch ? String(styleMatch[2] ?? "") : "";
    const srcMatch = attrs.match(/\bsrc\s*=\s*(['"])(.*?)\1/i);
    const altMatch = attrs.match(/\balt\s*=\s*(['"])(.*?)\1/i);
    const src = String(srcMatch?.[2] ?? "").toLowerCase();
    const alt = String(altMatch?.[2] ?? "").toLowerCase();
    const isLogo = src.includes("logo") || alt.includes("logo");
    style = appendCssDeclaration(style, "display", "block");
    style = appendCssDeclaration(style, "max-width", "100%");
    style = appendCssDeclaration(style, "height", "auto");
    if (!isLogo) {
      style = appendCssDeclaration(style, "object-fit", "contain");
      style = appendCssDeclaration(style, "background", "#f3f4f6");
    }
    if (styleMatch) {
      attrs = attrs.replace(styleMatch[0], `style="${escapeHtml(style)}"`);
    } else {
      attrs = `${attrs} style="${escapeHtml(style)}"`;
    }
    return `<img${attrs}>`;
  });
}

function buildRequiredEmailHeaderBlock(opts: {
  dealerName: string;
  website?: string;
  logoUrl?: string;
}): string {
  const dealerName = normalizeText(opts.dealerName) || "Dealership";
  const website = normalizeHttpUrl(opts.website);
  const logoUrl = normalizeCampaignEmailImageUrl(String(opts.logoUrl ?? ""));
  const logoHtml = logoUrl
    ? `<img data-lr-header-logo="1" src="${escapeHtml(logoUrl)}" alt="${escapeHtml(
        dealerName
      )} logo" style="display:block;max-width:180px;max-height:68px;width:auto;height:auto;" />`
    : `<div data-lr-header-logo="1" style="font-size:14px;line-height:20px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#111827;">${escapeHtml(
        dealerName
      )}</div>`;
  const rightLink = website
    ? `<a href="${escapeHtml(
        website
      )}" target="_blank" rel="noopener noreferrer" style="font-size:14px;line-height:18px;font-weight:700;color:#111827;text-decoration:underline;">Find A Dealer →</a>`
    : "";
  return `<table data-lr-required-header="1" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 16px 0;background:#ffffff;border-bottom:1px solid #e5e7eb;">
    <tr>
      <td style="padding:16px 22px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
          <tr>
            <td align="left" valign="middle">${logoHtml}</td>
            <td align="right" valign="middle">${rightLink}</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>`;
}

function normalizeGeneratedEmailHtml(
  raw: string,
  opts: {
    dealerName: string;
    website?: string;
    logoUrl?: string;
  }
): string {
  let html = String(raw ?? "").trim();
  if (!html) return "";
  if (hasJsonWrapperLeak(html)) {
    const extracted = extractEmailHtmlFieldFromJsonLike(html);
    if (isRenderableEmailHtml(extracted)) html = extracted;
  }
  if (!isRenderableEmailHtml(html)) return "";
  html = html.replace(/<script\b[\s\S]*?<\/script>/gi, "");
  html = html.replace(/\son[a-z]+\s*=\s*(["']).*?\1/gi, "");
  html = html.replace(/javascript:/gi, "");
  const hasHtmlTag = /<html[\s>]/i.test(html);
  const hasBodyTag = /<body[\s>]/i.test(html);
  if (!hasHtmlTag) {
    html = `<!doctype html><html><body>${html}</body></html>`;
  } else if (!hasBodyTag) {
    html = html.replace(/<\/head>/i, "</head><body>").replace(/<\/html>/i, "</body></html>");
  }
  const requiredHeader = buildRequiredEmailHeaderBlock(opts);
  if (!/data-lr-required-header/i.test(html)) {
    html = html.replace(/<body[^>]*>/i, match => `${match}${requiredHeader}`);
  }
  html = enforceEmailImageStyles(html);
  return html;
}

function buildTemplateEmailSections(args: {
  sourceHits: CampaignSourceHit[];
  topic: string;
}): CampaignEmailSection[] {
  const sectionsFromSources = args.sourceHits
    .slice(0, 3)
    .map(hit => {
      const title = normalizeText(hit.title).slice(0, 70);
      const snippet = normalizeText(hit.snippet).slice(0, 900);
      if (!title || !snippet) return null;
      return { title, body: snippet } as CampaignEmailSection;
    })
    .filter((row): row is CampaignEmailSection => Boolean(row));
  if (sectionsFromSources.length) return sectionsFromSources;
  const topic = normalizeText(args.topic) || "motorcycle updates";
  return [
    {
      title: "Upcoming Updates",
      body: `We’re sharing quick updates from the dealership this week around ${topic}.`
    },
    {
      title: "Current Offers",
      body: "If you want current pricing or offer details, reply and we’ll send the options that fit what you’re shopping for."
    },
    {
      title: "New Arrivals",
      body: "Tell us the model/year you want and we can send matching in-stock updates as units come in."
    }
  ];
}

function textToHtml(
  text: string,
  sourceHits: CampaignSourceHit[],
  opts?: {
    dealerName?: string;
    emailSubject?: string;
    website?: string;
    phone?: string;
    bookingUrl?: string;
    creditAppUrl?: string;
    offersUrl?: string;
    directionsUrl?: string;
    logoUrl?: string;
    sections?: CampaignEmailSection[];
    imageUrls?: string[];
  }
): string {
  const dealerName = normalizeText(opts?.dealerName) || "Dealership";
  const emailSubject = normalizeText(opts?.emailSubject) || `${dealerName} Update`;
  const website = normalizeHttpUrl(opts?.website);
  const bookingUrl = normalizeHttpUrl(opts?.bookingUrl);
  const creditAppUrl = normalizeHttpUrl(opts?.creditAppUrl);
  const offersUrl = normalizeHttpUrl(opts?.offersUrl);
  const directionsUrl = normalizeHttpUrl(opts?.directionsUrl);
  const logoUrl = normalizeCampaignEmailImageUrl(String(opts?.logoUrl ?? ""));
  const phone = normalizeText(opts?.phone);
  const imageUrls = normalizeCampaignEmailImageUrls(opts?.imageUrls);
  const heroImageUrl = imageUrls[0] || "";
  const stripImageUrls = imageUrls.slice(1, 4);

  const paragraphs = String(text ?? "")
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean);
  const introText = paragraphs[0] || "Here is your latest update.";
  const introHtml = escapeHtml(introText).replace(/\n/g, "<br/>");

  const normalizedSections = normalizeCampaignEmailSections(opts?.sections);
  const derivedSections = deriveCampaignEmailSectionsFromText(text);
  const sections = normalizedSections.length
    ? normalizedSections
    : derivedSections.length
      ? derivedSections
      : [
          {
            title: "What is happening",
            body: paragraphs[1] || introText || "Latest update from the dealership."
          },
          {
            title: "Next step",
            body:
              bookingUrl || website
                ? "Use the button below to book or view full details."
                : "Reply to this email and we will send details right away."
          }
        ];
  const sectionCards = sections
    .map((section, idx) => {
      const title = escapeHtml(section.title);
      const body = escapeHtml(section.body).replace(/\n/g, "<br/>");
      const ctaUrl = normalizeHttpUrl(section.ctaUrl);
      const ctaText = escapeHtml(section.ctaText || "Learn more");
      const sectionImageUrl = imageUrls[idx + 1] || "";
      const sectionImageBlock = sectionImageUrl
        ? `<tr>
             <td style="padding:0 0 10px 0;">
               <img src="${escapeHtml(sectionImageUrl)}" alt="${title}" style="display:block;width:100%;height:220px;max-height:220px;object-fit:contain;border-radius:6px;border:1px solid #d1d5db;background:#f3f4f6;" />
             </td>
           </tr>`
        : "";
      return `
        <tr>
          <td style="padding:0 0 14px 0;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #d1d5db;border-radius:8px;background:#ffffff;">
              ${sectionImageBlock}
              <tr>
                <td style="padding:14px 16px 14px 16px;">
                  <div style="font-size:16px;line-height:22px;font-weight:700;color:#111827;margin:0 0 8px 0;">${title}</div>
                  <div style="font-size:15px;line-height:24px;color:#111827;">${body}</div>
                  ${
                    ctaUrl
                      ? `<div style="margin-top:12px;"><a href="${escapeHtml(ctaUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;line-height:13px;padding:10px 14px;border-radius:6px;">${ctaText}</a></div>`
                      : ""
                  }
                </td>
              </tr>
            </table>
          </td>
        </tr>`;
    })
    .join("");

  const links = sourceHits
    .slice(0, 4)
    .filter(hit => hit.url)
    .map(hit => {
      const label = escapeHtml(hit.title || hit.domain || hit.url || "Reference");
      const href = escapeHtml(hit.url || "");
      return `<li style="margin:0 0 6px 0;"><a href="${href}" target="_blank" rel="noopener noreferrer" style="color:#1d4ed8;text-decoration:underline;">${label}</a></li>`;
    })
    .join("");
  const referencesBlock = links
    ? `<tr><td style="padding:10px 0 0 0;"><div style="font-size:12px;line-height:18px;color:#374151;font-weight:700;margin:0 0 6px 0;">References</div><ul style="margin:0 0 0 18px;padding:0;color:#1f2937;font-size:12px;line-height:18px;">${links}</ul></td></tr>`
    : "";

  const primaryCtaUrl = bookingUrl || website;
  const primaryCtaText = bookingUrl ? "Schedule Now" : website ? "View Website" : "";
  const preheaderText = escapeHtml(
    normalizeText(paragraphs[1] || introText)
      .replace(/\s+/g, " ")
      .slice(0, 140) || `Latest update from ${dealerName}.`
  );
  const utilityLinks = [
    { label: "Motorcycle Lineup", url: website },
    { label: "Test Ride", url: bookingUrl || website },
    { label: "Financing", url: creditAppUrl || website },
    { label: "Current Offers", url: offersUrl || website }
  ].filter(link => Boolean(link.url));
  const utilityRows: string[] = [];
  const utilityCells = utilityLinks.slice(0, 4);
  for (let i = 0; i < utilityCells.length; i += 2) {
    const left = utilityCells[i];
    const right = utilityCells[i + 1];
    const leftCell = left
      ? `<td style="padding:0 6px 8px 0;width:50%;">
           <a href="${escapeHtml(String(left.url ?? ""))}" target="_blank" rel="noopener noreferrer" style="display:block;text-decoration:none;background:#ffffff;border:2px solid #111827;border-radius:6px;color:#111827;font-size:14px;line-height:18px;font-weight:700;text-align:center;padding:12px 10px;">${escapeHtml(left.label)}</a>
         </td>`
      : `<td style="padding:0 6px 8px 0;width:50%;"></td>`;
    const rightCell = right
      ? `<td style="padding:0 0 8px 6px;width:50%;">
           <a href="${escapeHtml(String(right.url ?? ""))}" target="_blank" rel="noopener noreferrer" style="display:block;text-decoration:none;background:#ffffff;border:2px solid #111827;border-radius:6px;color:#111827;font-size:14px;line-height:18px;font-weight:700;text-align:center;padding:12px 10px;">${escapeHtml(right.label)}</a>
         </td>`
      : `<td style="padding:0 0 8px 6px;width:50%;"></td>`;
    utilityRows.push(`<tr>${leftCell}${rightCell}</tr>`);
  }
  const utilityGridBlock =
    utilityLinks.length >= 2
      ? `<tr>
           <td style="padding:8px 0 14px 0;">
             <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
               ${utilityRows.join("")}
             </table>
           </td>
         </tr>`
      : "";
  const contactLineBits = [phone ? `Phone: ${phone}` : "", website ? `Website: ${website}` : ""]
    .filter(Boolean)
    .join(" | ");
  const footerNavBits = [
    website ? `<a href="${escapeHtml(website)}" target="_blank" rel="noopener noreferrer" style="color:#111827;text-decoration:underline;">Website</a>` : "",
    bookingUrl ? `<a href="${escapeHtml(bookingUrl)}" target="_blank" rel="noopener noreferrer" style="color:#111827;text-decoration:underline;">Book</a>` : "",
    creditAppUrl ? `<a href="${escapeHtml(creditAppUrl)}" target="_blank" rel="noopener noreferrer" style="color:#111827;text-decoration:underline;">Financing</a>` : "",
    offersUrl ? `<a href="${escapeHtml(offersUrl)}" target="_blank" rel="noopener noreferrer" style="color:#111827;text-decoration:underline;">Offers</a>` : "",
    directionsUrl ? `<a href="${escapeHtml(directionsUrl)}" target="_blank" rel="noopener noreferrer" style="color:#111827;text-decoration:underline;">Directions</a>` : ""
  ]
    .filter(Boolean)
    .join(" | ");
  const footerBits = [website ? `Website: ${website}` : "", phone ? `Phone: ${phone}` : ""]
    .filter(Boolean)
    .join(" · ");
  const heroImageBlock = heroImageUrl
    ? `<tr>
         <td style="padding:0 0 14px 0;">
           <img src="${escapeHtml(heroImageUrl)}" alt="${escapeHtml(
             dealerName
           )} campaign image" style="display:block;width:100%;height:auto;max-height:360px;object-fit:contain;border-radius:8px;border:1px solid #d1d5db;background:#f3f4f6;" />
         </td>
       </tr>`
    : "";
  const imageStripBlock = stripImageUrls.length
    ? `<tr>
         <td style="padding:0 0 14px 0;">
           <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="table-layout:fixed;">
             <tr>
               ${stripImageUrls
                 .map((url, idx) => {
                   const pad = idx < stripImageUrls.length - 1 ? "padding-right:8px;" : "";
                   return `<td style="${pad}">
                     <img src="${escapeHtml(url)}" alt="Campaign detail image" style="display:block;width:100%;height:132px;max-height:132px;object-fit:contain;border-radius:6px;border:1px solid #d1d5db;background:#f3f4f6;" />
                   </td>`;
                 })
                 .join("")}
             </tr>
           </table>
         </td>
       </tr>`
    : "";
  const brandHeaderLogoBlock = logoUrl
    ? `<img data-lr-header-logo="1" src="${escapeHtml(logoUrl)}" alt="${escapeHtml(
        dealerName
      )} logo" style="display:block;max-width:180px;max-height:68px;width:auto;height:auto;" />`
    : `<div data-lr-header-logo="1" style="font-size:14px;line-height:20px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#111827;">${escapeHtml(
        dealerName
      )}</div>`;
  const topRightWebsiteBlock = website
    ? `<a href="${escapeHtml(
        website
      )}" target="_blank" rel="noopener noreferrer" style="font-size:14px;line-height:18px;font-weight:700;color:#111827;text-decoration:underline;">Find A Dealer →</a>`
    : "";

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f6f6f6;">
    <div style="display:none;font-size:1px;color:#f6f6f6;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheaderText}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f6f6f6;">
      <tr>
        <td align="center" style="padding:22px 12px;">
          <table role="presentation" width="620" cellspacing="0" cellpadding="0" border="0" style="width:620px;max-width:620px;background:#ffffff;border:1px solid #d1d5db;border-radius:10px;overflow:hidden;">
            <tr>
              <td style="padding:16px 22px;border-bottom:1px solid #e5e7eb;background:#ffffff;">
                <table data-lr-required-header="1" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td align="left" valign="middle">${brandHeaderLogoBlock}</td>
                    <td align="right" valign="middle">${topRightWebsiteBlock}</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 22px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding:0 0 8px 0;font-size:11px;line-height:16px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#f97316;">${escapeHtml(
                      dealerName
                    )}</td>
                  </tr>
                  <tr>
                    <td style="padding:0 0 12px 0;font-size:28px;line-height:34px;font-weight:800;color:#111827;">${escapeHtml(
                      emailSubject
                    )}</td>
                  </tr>
                  <tr>
                    <td style="font-size:15px;line-height:24px;color:#111827;padding:0 0 12px 0;">${introHtml}</td>
                  </tr>
                  ${heroImageBlock}
                  ${imageStripBlock}
                  ${sectionCards}
                  ${
                    primaryCtaUrl
                      ? `<tr><td style="padding:6px 0 16px 0;"><a href="${escapeHtml(
                          primaryCtaUrl
                        )}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#f97316;color:#111827;text-decoration:none;font-weight:800;font-size:13px;line-height:13px;padding:12px 16px;border-radius:4px;">${escapeHtml(
                          primaryCtaText
                        )}</a></td></tr>`
                      : ""
                  }
                  ${utilityGridBlock}
                  ${referencesBlock}
                  <tr>
                    <td style="padding:16px 0 0 0;font-size:12px;line-height:18px;color:#4b5563;border-top:1px solid #e5e7eb;">
                      <div style="font-weight:700;color:#111827;">${escapeHtml(dealerName)}</div>
                      ${contactLineBits ? `<div style="margin-top:4px;">${escapeHtml(contactLineBits)}</div>` : ""}
                      ${footerNavBits ? `<div style="margin-top:8px;">${footerNavBits}</div>` : ""}
                      ${footerBits ? `<div style="margin-top:8px;">${escapeHtml(footerBits)}</div>` : ""}
                      <div style="margin-top:8px;color:#6b7280;">Reply STOP to opt out of promotional messages.</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
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
  const emailSections = buildTemplateEmailSections({ sourceHits, topic });
  const emailImageUrls = normalizeCampaignEmailImageUrls([
    ...resolvedInspirationImageUrls,
    ...normalizeUrls(input.assetImageUrls)
  ]);
  const emailBodyText = [
    `Hi there,`,
    ``,
    `Quick update from ${dealerName}.`,
    ``,
    ...emailSections.flatMap(section => [section.title, section.body, ""]),
    sourceHits[0]?.url ? `Reference: ${sourceHits[0].url}` : "Reply and we can send specific options."
  ]
    .filter(Boolean)
    .join("\n");

  return {
    status: "generated",
    inspirationImageUrls: resolvedInspirationImageUrls,
    smsBody,
    emailSubject,
    emailBodyText,
    emailBodyHtml: textToHtml(emailBodyText, sourceHits, {
      dealerName,
      emailSubject,
      website: input.dealerProfile?.website,
      phone: input.dealerProfile?.phone,
      bookingUrl: input.dealerProfile?.bookingUrl,
      creditAppUrl: input.dealerProfile?.creditAppUrl,
      offersUrl: input.dealerProfile?.offersUrl,
      directionsUrl: input.dealerProfile?.directionsUrl,
      logoUrl: input.dealerProfile?.logoUrl,
      sections: emailSections,
      imageUrls: emailImageUrls
    }),
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
  const requiresEmailHtml = args.input.channel !== "sms";
  const dealerName = normalizeText(args.input.dealerProfile?.dealerName) || "the dealership";
  const website = normalizeText(args.input.dealerProfile?.website);
  const phone = normalizeText(args.input.dealerProfile?.phone);
  const bookingUrl = normalizeText(args.input.dealerProfile?.bookingUrl);
  const creditAppUrl = normalizeText(args.input.dealerProfile?.creditAppUrl);
  const offersUrl = normalizeText(args.input.dealerProfile?.offersUrl);
  const directionsUrl = normalizeText(args.input.dealerProfile?.directionsUrl);
  const tags = args.input.tags.map(tag => TAG_LABELS[tag]).join(", ") || "General";
  const channelSupportsEmailDigest = args.input.channel !== "sms";
  const suppressTradeOnly = shouldSuppressTradeByInput(args.input);
  const brandWebsite = normalizeText(args.brandContext?.websiteUrl);
  const brandTitle = normalizeText(args.brandContext?.title);
  const brandDescription = normalizeText(args.brandContext?.description);
  const brandLogoUrls = normalizeUrls(args.brandContext?.logoImageUrls).slice(0, 3);
  const emailImageUrls = normalizeCampaignEmailImageUrls([
    ...args.resolvedInspirationImageUrls,
    ...normalizeUrls(args.input.assetImageUrls)
  ]);
  const briefUrls = normalizeUrls(args.input.briefDocumentUrls).slice(0, 6);
  const imageLibrary = emailImageUrls.length
    ? emailImageUrls
        .map((url, idx) => `${idx + 1}. ${url} | label_hint: ${inferCampaignImageLabelFromUrl(url) || "none"}`)
        .join("\n")
    : "(No campaign images provided)";
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
      email_body_text: { type: "string" },
      email_body_html: { type: "string" },
      email_sections: {
        type: "array",
        minItems: 0,
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "body"],
          properties: {
            title: { type: "string" },
            body: { type: "string" },
            cta_text: { type: "string" },
            cta_url: { type: "string" }
          }
        }
      }
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
    channelSupportsEmailDigest
      ? "For email output, write as a digest with multiple short update blocks (for example upcoming events, current offers, new arrivals) when context supports it."
      : "Keep email output concise and single-topic when only SMS channel is requested.",
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
    `Credit app URL: ${creditAppUrl || "(not provided)"}`,
    `Offers URL: ${offersUrl || "(not provided)"}`,
    `Directions URL: ${directionsUrl || "(not provided)"}`,
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
    "Image library (use these exact URLs only):",
    imageLibrary,
    "",
    "Output requirements:",
    "- sms_body: 1-2 short sentences.",
    "- email_subject: under 75 chars.",
    "- email_body_text: plain text email body with clear CTA.",
    "- email_body_html: optional in this JSON pass.",
    "- email_body_html must be responsive table-based email markup with inline CSS only (no scripts, no external CSS).",
    "- email_body_html must include a branded top header row with the dealer logo and a right-side dealer link.",
    "- For each major content block, pair the most relevant image from the image library. Keep text/image pairing logically matched.",
    "- Use distinct image URLs across sections; do not repeat the same campaign image for every block when multiple images are provided.",
    "- If an image is not relevant to any section, place it in an additional visuals row instead of forcing mismatch.",
    "- All images must render fully visible (no crop). Use object-fit:contain with height:auto and sensible max-height.",
    "- Keep URLs exactly as provided. Do not invent or rewrite image URLs.",
    "- email_sections: optional array of section blocks for digest-style email layout.",
    channelSupportsEmailDigest
      ? "- Prefer 2-4 sections when context provides multiple updates."
      : "- If sections are used, keep to one short section."
  ].join("\n");

  const parseObject = (raw: string): any | null => {
    const parsed = extractJsonObject(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  };

  const generateEmailHtmlRescue = async (seedSubject?: string, seedBodyText?: string): Promise<string> => {
    if (!requiresEmailHtml) return "";
    const rescuePrompt = [
      "Return only HTML for a complete marketing email body.",
      "No markdown fences. No JSON. No explanations.",
      "Start with <!doctype html> and end with </html>.",
      "Do not output plain text outside HTML tags.",
      "Use responsive table-based markup and inline CSS only.",
      "Always include branded top header row with dealer logo at left and dealer link at right.",
      "Use provided campaign/reference images in context-matching sections.",
      "When multiple image URLs are provided, distribute distinct URLs across sections instead of repeating one image.",
      "If image library URLs are present, include each image URL at least once in the body.",
      "Never crop images. Use contain behavior and responsive sizing.",
      "",
      `Dealer: ${dealerName}`,
      `Website: ${website || "(not provided)"}`,
      `Email subject seed: ${seedSubject || "(none)"}`,
      `Email body text seed: ${seedBodyText || "(none)"}`,
      `Prompt: ${normalizeText(args.input.prompt) || "(none)"}`,
      `Description: ${normalizeText(args.input.description) || "(none)"}`,
      "",
      "Brief file excerpts:",
      briefBlock || "(No brief files provided)",
      "",
      "Reference hits:",
      sourceBlock,
      "",
      "Image library (exact URLs, do not rewrite):",
      imageLibrary
    ].join("\n");

    try {
      const rescueResp = await client.responses.create({
        model,
        input: rescuePrompt,
        ...optionalReasoning(model),
        ...optionalTextVerbosity(model),
        ...optionalTemperature(model, 0.2),
        max_output_tokens: 5200
      });
      const htmlRaw = extractHtmlFromModelOutput(rescueResp.output_text ?? "");
      if (!isRenderableEmailHtml(htmlRaw)) return "";
      const normalized = normalizeGeneratedEmailHtml(htmlRaw, {
        dealerName,
        website,
        logoUrl: args.input.dealerProfile?.logoUrl
      });
      if (!isCompleteEmailHtml(normalized, emailImageUrls.length, emailImageUrls)) return "";
      return normalized;
    } catch {
      return "";
    }
  };

  try {
    const parsedResp = await client.responses.parse({
      model,
      input: prompt,
      ...optionalReasoning(model),
      ...optionalTemperature(model, 0.2),
      max_output_tokens: 1800,
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
    if (parsed?.sms_body || parsed?.email_subject || parsed?.email_body_text || parsed?.email_body_html) {
      const smsBody = normalizeText(parsed.sms_body);
      const emailSubject = normalizeText(parsed.email_subject);
      const emailBodyText = normalizeText(parsed.email_body_text);
      const emailBodyHtmlRaw = normalizeText(parsed.email_body_html);
      const emailSections = normalizeCampaignEmailSections(parsed.email_sections);
      let emailBodyHtml = isRenderableEmailHtml(emailBodyHtmlRaw)
        ? normalizeGeneratedEmailHtml(emailBodyHtmlRaw, {
            dealerName,
            website,
            logoUrl: args.input.dealerProfile?.logoUrl
          })
        : undefined;
      if (!isCompleteEmailHtml(emailBodyHtml || "", emailImageUrls.length, emailImageUrls)) {
        emailBodyHtml = undefined;
      }
      if (requiresEmailHtml && !emailBodyHtml) {
        const rescued = await generateEmailHtmlRescue(emailSubject, emailBodyText);
        if (rescued) emailBodyHtml = rescued;
      }
      if (requiresEmailHtml && !emailBodyHtml) {
        return null;
      }
      if (smsBody || emailSubject || emailBodyText || emailBodyHtml) {
        return {
          status: "generated",
          inspirationImageUrls: args.resolvedInspirationImageUrls,
          smsBody: smsBody || undefined,
          emailSubject: emailSubject || undefined,
          emailBodyText: emailBodyText || undefined,
          emailBodyHtml,
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
            emailSectionCount: emailSections.length,
            emailHtmlFromLlm: Boolean(emailBodyHtml),
            emailHtmlRescued: Boolean(emailBodyHtml) && (!emailBodyHtmlRaw || !isRenderableEmailHtml(emailBodyHtmlRaw)),
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
      max_output_tokens: 1800
    });
    const rawHtmlDirect = extractHtmlFromModelOutput(resp.output_text ?? "");
    const parsed = parseObject(resp.output_text ?? "");
    if (parsed?.sms_body || parsed?.email_subject || parsed?.email_body_text || parsed?.email_body_html) {
      const smsBody = normalizeText(parsed.sms_body);
      const emailSubject = normalizeText(parsed.email_subject);
      const emailBodyText = normalizeText(parsed.email_body_text);
      const emailBodyHtmlRaw = normalizeText(parsed.email_body_html);
      const emailSections = normalizeCampaignEmailSections(parsed.email_sections);
      let emailBodyHtml = isRenderableEmailHtml(emailBodyHtmlRaw)
        ? normalizeGeneratedEmailHtml(emailBodyHtmlRaw, {
            dealerName,
            website,
            logoUrl: args.input.dealerProfile?.logoUrl
          })
        : isRenderableEmailHtml(rawHtmlDirect)
          ? normalizeGeneratedEmailHtml(rawHtmlDirect, {
              dealerName,
              website,
              logoUrl: args.input.dealerProfile?.logoUrl
            })
          : undefined;
      if (!isCompleteEmailHtml(emailBodyHtml || "", emailImageUrls.length, emailImageUrls)) {
        emailBodyHtml = undefined;
      }
      if (requiresEmailHtml && !emailBodyHtml) {
        const rescued = await generateEmailHtmlRescue(emailSubject, emailBodyText);
        if (rescued) emailBodyHtml = rescued;
      }
      if (requiresEmailHtml && !emailBodyHtml) {
        return null;
      }
      if (smsBody || emailSubject || emailBodyText || emailBodyHtml) {
        return {
          status: "generated",
          inspirationImageUrls: args.resolvedInspirationImageUrls,
          smsBody: smsBody || undefined,
          emailSubject: emailSubject || undefined,
          emailBodyText: emailBodyText || undefined,
          emailBodyHtml,
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
            emailSectionCount: emailSections.length,
            emailHtmlFromLlm: Boolean(emailBodyHtml),
            emailHtmlRescued:
              Boolean(emailBodyHtml) &&
              (!emailBodyHtmlRaw || !isRenderableEmailHtml(emailBodyHtmlRaw) || !isRenderableEmailHtml(rawHtmlDirect)),
            brandWebsite: brandWebsite || website || null
          }
        };
      }
    }

    if (requiresEmailHtml && isRenderableEmailHtml(rawHtmlDirect)) {
      const emailBodyHtml = normalizeGeneratedEmailHtml(rawHtmlDirect, {
        dealerName,
        website,
        logoUrl: args.input.dealerProfile?.logoUrl
      });
      if (isCompleteEmailHtml(emailBodyHtml, emailImageUrls.length, emailImageUrls)) {
        const emailSubject = `${dealerName} | ${normalizeText(args.input.name || "Update").slice(0, 60)}`;
        const emailBodyText = htmlToPlainText(emailBodyHtml).slice(0, 4000);
        const smsBody = `Quick update from ${dealerName}: Reply and I can share the details.`;
        return {
          status: "generated",
          inspirationImageUrls: args.resolvedInspirationImageUrls,
          smsBody,
          emailSubject,
          emailBodyText,
          emailBodyHtml,
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
            emailSectionCount: 0,
            emailHtmlFromLlm: true,
            emailHtmlRescued: false,
            emailHtmlDirect: true,
            brandWebsite: brandWebsite || website || null
          }
        };
      }
    }

    if (requiresEmailHtml) {
      const rescuedHtml = await generateEmailHtmlRescue();
      if (rescuedHtml) {
        const emailSubject = `${dealerName} | ${normalizeText(args.input.name || "Update").slice(0, 60)}`;
        const emailBodyText = htmlToPlainText(rescuedHtml).slice(0, 4000);
        const smsBody = `Quick update from ${dealerName}: Reply and I can share the details.`;
        return {
          status: "generated",
          inspirationImageUrls: args.resolvedInspirationImageUrls,
          smsBody,
          emailSubject,
          emailBodyText,
          emailBodyHtml: rescuedHtml,
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
            emailSectionCount: 0,
            emailHtmlFromLlm: true,
            emailHtmlRescued: true,
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
  const requiredPromptDetailUrls = extractPromptDetailUrls(input);
  const brandContext = await fetchDealerBrandContext(input.dealerProfile ?? null);
  const briefContexts = await collectBriefContexts(normalizeUrls(input.briefDocumentUrls));
  const shouldRunWebSearch = input.buildMode === "web_search_design";
  const shouldRunLogoSearch = input.buildMode === "design_from_scratch";
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
  const logoSearchQuery = shouldRunLogoSearch ? buildLogoSearchQuery(input) : "";
  const logoSearchResult =
    shouldRunLogoSearch && logoSearchQuery
      ? await searchGoogleCse({
          query: logoSearchQuery,
          profile: input.dealerProfile ?? undefined,
          maxResults: Math.max(2, Math.min(8, Number(process.env.CAMPAIGN_LOGO_SEARCH_MAX_RESULTS ?? 6)))
        })
      : null;
  const sourceHits = filterSourceHitsByTags(toSourceHits(searchResult), input.tags, suppressTradeOnly);
  const logoSourceHits = filterSourceHitsByTags(toSourceHits(logoSearchResult), input.tags, suppressTradeOnly);
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
  const logoBrandInspiration = shouldRunLogoSearch
    ? filterImageUrlsByTags(
        normalizeUrls(brandContext.logoImageUrls).slice(0, Math.max(1, Number(process.env.CAMPAIGN_BRAND_LOGO_MAX ?? 3))),
        input.tags,
        suppressTradeOnly
      )
    : [];
  const logoSearchInspiration = shouldRunLogoSearch
    ? filterImageUrlsByTags(
        await collectImageCandidatesFromHits(logoSourceHits, {
          maxImages: Math.max(1, Math.min(8, Number(process.env.CAMPAIGN_LOGO_IMAGE_MAX ?? 4)))
        }),
        input.tags,
        suppressTradeOnly
      )
    : [];
  const resolvedInspirationImageUrls = userProvidedInspiration.length
    ? Array.from(new Set([...userProvidedInspiration, ...logoBrandInspiration, ...logoSearchInspiration]))
    : Array.from(
        new Set([
          ...placeDiscoveredInspiration,
          ...websiteDiscoveredInspiration,
          ...autoDiscoveredInspiration,
          ...logoBrandInspiration,
          ...logoSearchInspiration
        ])
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
      googlePlaceForcedForDealerEvent: forcePlacePhotos,
      logoSearchQuery: logoSearchQuery || null,
      logoSourceCount: logoSourceHits.length
    };
    const guarded = suppressTradeOnly
      ? applyNoTradeLanguageGuard(withPlacesMeta, input.dealerProfile)
      : withPlacesMeta;
    return ensureSmsBodyIncludesPromptDetailUrls(guarded, requiredPromptDetailUrls);
  }

  const requiresEmailHtml = input.channel !== "sms";
  if (requiresEmailHtml) {
    const fallbackSubject = `${normalizeText(input.dealerProfile?.dealerName) || "Dealership"} | Update`;
    const fallbackSms = `Quick update from ${normalizeText(input.dealerProfile?.dealerName) || "the dealership"}: reply and we can share details.`;
    return {
      status: "generated",
      inspirationImageUrls: resolvedInspirationImageUrls,
      smsBody: fallbackSms,
      emailSubject: fallbackSubject,
      emailBodyText: "",
      emailBodyHtml: "",
      sourceHits,
      generatedBy: "llm_fallback",
      metadata: {
        buildMode: input.buildMode,
        searchQuery,
        sourceCount: sourceHits.length,
        briefDocumentCount: normalizeUrls(input.briefDocumentUrls).length,
        briefExtractedCount: (briefContexts ?? []).filter(row => row.type === "text").length,
        generator: "llm_required_no_template_fallback",
        llmHtmlRequired: true,
        brandWebsite: brandContext?.websiteUrl ?? null
      }
    };
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
    googlePlaceForcedForDealerEvent: forcePlacePhotos,
    logoSearchQuery: logoSearchQuery || null,
    logoSourceCount: logoSourceHits.length
  };
  const guarded = suppressTradeOnly
    ? applyNoTradeLanguageGuard(withPlacesMeta, input.dealerProfile)
    : withPlacesMeta;
  return ensureSmsBodyIncludesPromptDetailUrls(guarded, requiredPromptDetailUrls);
}
