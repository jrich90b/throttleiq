import { promises as fs } from "node:fs";
import { dataPath } from "./dataDir.js";

export type CampaignChannel = "sms" | "email" | "both";
export type CampaignStatus = "draft" | "generated";
export type CampaignBuildMode = "design_from_scratch" | "web_search_design";
export type CampaignAssetTarget =
  | "sms"
  | "email"
  | "facebook_post"
  | "instagram_post"
  | "instagram_story"
  | "web_banner";
export type CampaignTag =
  | "sales"
  | "parts"
  | "apparel"
  | "service"
  | "financing"
  | "national_campaign"
  | "dealer_event";

export type CampaignSourceHit = {
  title?: string;
  snippet?: string;
  url?: string;
  domain?: string;
};

export type CampaignGeneratedAsset = {
  id?: string;
  target: CampaignAssetTarget;
  label?: string;
  url: string;
  mimeType?: string;
  width?: number;
  height?: number;
  bytes?: number;
  createdAt?: string;
};

export type CampaignEntry = {
  id: string;
  name: string;
  status: CampaignStatus;
  buildMode: CampaignBuildMode;
  channel: CampaignChannel;
  tags: CampaignTag[];
  assetTargets?: CampaignAssetTarget[];
  prompt?: string;
  description?: string;
  inspirationImageUrls?: string[];
  assetImageUrls?: string[];
  briefDocumentUrls?: string[];
  smsBody?: string;
  emailSubject?: string;
  emailBodyText?: string;
  emailBodyHtml?: string;
  finalImageUrl?: string;
  generatedAssets?: CampaignGeneratedAsset[];
  sourceHits?: CampaignSourceHit[];
  metadata?: Record<string, unknown>;
  createdByUserId?: string;
  createdByUserName?: string;
  generatedBy?: "nano_banana" | "llm_fallback" | "template";
  createdAt: string;
  updatedAt: string;
};

const DB_PATH = process.env.CAMPAIGNS_DB_PATH
  ? String(process.env.CAMPAIGNS_DB_PATH)
  : dataPath("campaigns.json");

const campaigns = new Map<string, CampaignEntry>();
let saveTimer: NodeJS.Timeout | null = null;

const CAMPAIGN_ASSET_TARGET_SET = new Set<CampaignAssetTarget>([
  "sms",
  "email",
  "facebook_post",
  "instagram_post",
  "instagram_story",
  "web_banner"
]);

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  return `camp_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

async function saveToDisk() {
  const payload = {
    version: 1,
    savedAt: nowIso(),
    campaigns: Array.from(campaigns.values())
  };
  const tmp = `${DB_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmp, DB_PATH);
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveToDisk();
  }, 200);
}

function normalizeChannel(raw: unknown): CampaignChannel {
  const value = String(raw ?? "").trim();
  return value === "sms" || value === "email" || value === "both" ? value : "both";
}

function uniqTags(tags?: CampaignTag[]): CampaignTag[] {
  return Array.from(new Set((tags ?? []).filter(Boolean)));
}

function uniqUrls(urls?: string[]): string[] {
  return Array.from(
    new Set(
      (urls ?? [])
        .map(v => String(v ?? "").trim())
        .filter(Boolean)
    )
  );
}

function defaultAssetTargetsForChannel(channel: CampaignChannel): CampaignAssetTarget[] {
  if (channel === "sms") return ["sms"];
  if (channel === "email") return ["email"];
  return ["sms", "email"];
}

function normalizeAssetTargets(raw: unknown, fallbackChannel: CampaignChannel): CampaignAssetTarget[] {
  const values = Array.isArray(raw)
    ? raw
        .map(v => String(v ?? "").trim())
        .filter(v => CAMPAIGN_ASSET_TARGET_SET.has(v as CampaignAssetTarget))
    : [];
  const uniq = Array.from(new Set(values)) as CampaignAssetTarget[];
  return uniq.length ? uniq : defaultAssetTargetsForChannel(fallbackChannel);
}

function normalizeGeneratedAssets(raw: unknown): CampaignGeneratedAsset[] {
  if (!Array.isArray(raw)) return [];
  const out: CampaignGeneratedAsset[] = [];
  for (const row of raw) {
    const targetRaw = String((row as any)?.target ?? "").trim();
    const url = String((row as any)?.url ?? "").trim();
    if (!CAMPAIGN_ASSET_TARGET_SET.has(targetRaw as CampaignAssetTarget) || !url) continue;
    const widthNum = Number((row as any)?.width);
    const heightNum = Number((row as any)?.height);
    const bytesNum = Number((row as any)?.bytes);
    out.push({
      id: String((row as any)?.id ?? "").trim() || undefined,
      target: targetRaw as CampaignAssetTarget,
      label: String((row as any)?.label ?? "").trim() || undefined,
      url,
      mimeType: String((row as any)?.mimeType ?? "").trim() || undefined,
      width: Number.isFinite(widthNum) && widthNum > 0 ? Math.round(widthNum) : undefined,
      height: Number.isFinite(heightNum) && heightNum > 0 ? Math.round(heightNum) : undefined,
      bytes: Number.isFinite(bytesNum) && bytesNum > 0 ? Math.round(bytesNum) : undefined,
      createdAt: String((row as any)?.createdAt ?? "").trim() || undefined
    });
  }
  return out.slice(0, 24);
}

function normalizeBuildMode(raw: unknown): CampaignBuildMode {
  const mode = String(raw ?? "").trim();
  if (mode === "web_search_design" || mode === "promotion_event_prompt") {
    return "web_search_design";
  }
  return "design_from_scratch";
}

async function loadFromDisk() {
  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    const parsed = JSON.parse(raw) as { campaigns?: CampaignEntry[] };
    campaigns.clear();
    for (const row of parsed?.campaigns ?? []) {
      if (!row?.id) continue;
      const channel = normalizeChannel((row as any)?.channel);
      const generatedAssets = normalizeGeneratedAssets((row as any)?.generatedAssets);
      const normalized: CampaignEntry = {
        ...row,
        channel,
        buildMode: normalizeBuildMode((row as any)?.buildMode),
        tags: uniqTags(Array.isArray((row as any)?.tags) ? ((row as any).tags as CampaignTag[]) : []),
        assetTargets: normalizeAssetTargets((row as any)?.assetTargets, channel),
        inspirationImageUrls: uniqUrls((row as any)?.inspirationImageUrls),
        assetImageUrls: uniqUrls((row as any)?.assetImageUrls),
        briefDocumentUrls: uniqUrls((row as any)?.briefDocumentUrls),
        generatedAssets
      };
      if (!normalized.finalImageUrl && generatedAssets.length) {
        normalized.finalImageUrl = generatedAssets[0]?.url;
      }
      campaigns.set(row.id, normalized);
    }
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      await saveToDisk();
    }
  }
}

void loadFromDisk();

export function listCampaigns(): CampaignEntry[] {
  return Array.from(campaigns.values()).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export function getCampaign(id: string): CampaignEntry | null {
  return campaigns.get(id) ?? null;
}

export function createCampaign(input: {
  name: string;
  status?: CampaignStatus;
  buildMode?: CampaignBuildMode;
  channel?: CampaignChannel;
  tags?: CampaignTag[];
  assetTargets?: CampaignAssetTarget[];
  prompt?: string;
  description?: string;
  inspirationImageUrls?: string[];
  assetImageUrls?: string[];
  briefDocumentUrls?: string[];
  smsBody?: string;
  emailSubject?: string;
  emailBodyText?: string;
  emailBodyHtml?: string;
  finalImageUrl?: string;
  generatedAssets?: CampaignGeneratedAsset[];
  sourceHits?: CampaignSourceHit[];
  metadata?: Record<string, unknown>;
  createdByUserId?: string;
  createdByUserName?: string;
  generatedBy?: CampaignEntry["generatedBy"];
}): CampaignEntry {
  const now = nowIso();
  const channel = normalizeChannel(input.channel);
  const generatedAssets = normalizeGeneratedAssets(input.generatedAssets);
  const entry: CampaignEntry = {
    id: makeId(),
    name: String(input.name ?? "").trim() || "Untitled campaign",
    status: input.status ?? "draft",
    buildMode: normalizeBuildMode(input.buildMode),
    channel,
    tags: uniqTags(input.tags),
    assetTargets: normalizeAssetTargets(input.assetTargets, channel),
    prompt: String(input.prompt ?? "").trim() || undefined,
    description: String(input.description ?? "").trim() || undefined,
    inspirationImageUrls: uniqUrls(input.inspirationImageUrls),
    assetImageUrls: uniqUrls(input.assetImageUrls),
    briefDocumentUrls: uniqUrls(input.briefDocumentUrls),
    smsBody: String(input.smsBody ?? "").trim() || undefined,
    emailSubject: String(input.emailSubject ?? "").trim() || undefined,
    emailBodyText: String(input.emailBodyText ?? "").trim() || undefined,
    emailBodyHtml: String(input.emailBodyHtml ?? "").trim() || undefined,
    finalImageUrl: String(input.finalImageUrl ?? "").trim() || generatedAssets[0]?.url || undefined,
    generatedAssets,
    sourceHits: Array.isArray(input.sourceHits) ? input.sourceHits.slice(0, 12) : [],
    metadata:
      input.metadata && typeof input.metadata === "object"
        ? { ...input.metadata }
        : undefined,
    createdByUserId: input.createdByUserId,
    createdByUserName: input.createdByUserName,
    generatedBy: input.generatedBy,
    createdAt: now,
    updatedAt: now
  };
  campaigns.set(entry.id, entry);
  scheduleSave();
  return entry;
}

export function updateCampaign(
  id: string,
  patch: Partial<CampaignEntry>
): CampaignEntry | null {
  const existing = campaigns.get(id);
  if (!existing) return null;
  const channel = patch?.channel !== undefined ? normalizeChannel(patch.channel) : normalizeChannel(existing.channel);
  const generatedAssets =
    patch?.generatedAssets !== undefined
      ? normalizeGeneratedAssets(patch.generatedAssets)
      : normalizeGeneratedAssets(existing.generatedAssets);
  const next: CampaignEntry = {
    ...existing,
    ...(patch ?? {}),
    name:
      patch?.name !== undefined
        ? String(patch.name ?? "").trim() || existing.name
        : existing.name,
    channel,
    tags: patch?.tags ? uniqTags(patch.tags as CampaignTag[]) : existing.tags ?? [],
    buildMode:
      patch?.buildMode !== undefined ? normalizeBuildMode(patch.buildMode) : normalizeBuildMode(existing.buildMode),
    assetTargets:
      patch?.assetTargets !== undefined
        ? normalizeAssetTargets(patch.assetTargets, channel)
        : normalizeAssetTargets(existing.assetTargets, channel),
    inspirationImageUrls:
      patch?.inspirationImageUrls !== undefined
        ? uniqUrls(patch.inspirationImageUrls as string[])
        : existing.inspirationImageUrls ?? [],
    assetImageUrls:
      patch?.assetImageUrls !== undefined
        ? uniqUrls(patch.assetImageUrls as string[])
        : existing.assetImageUrls ?? [],
    briefDocumentUrls:
      patch?.briefDocumentUrls !== undefined
        ? uniqUrls(patch.briefDocumentUrls as string[])
        : existing.briefDocumentUrls ?? [],
    prompt:
      patch?.prompt !== undefined ? String(patch.prompt ?? "").trim() || undefined : existing.prompt,
    description:
      patch?.description !== undefined
        ? String(patch.description ?? "").trim() || undefined
        : existing.description,
    smsBody:
      patch?.smsBody !== undefined ? String(patch.smsBody ?? "").trim() || undefined : existing.smsBody,
    emailSubject:
      patch?.emailSubject !== undefined
        ? String(patch.emailSubject ?? "").trim() || undefined
        : existing.emailSubject,
    emailBodyText:
      patch?.emailBodyText !== undefined
        ? String(patch.emailBodyText ?? "").trim() || undefined
        : existing.emailBodyText,
    emailBodyHtml:
      patch?.emailBodyHtml !== undefined
        ? String(patch.emailBodyHtml ?? "").trim() || undefined
        : existing.emailBodyHtml,
    finalImageUrl:
      patch?.finalImageUrl !== undefined
        ? String(patch.finalImageUrl ?? "").trim() || undefined
        : existing.finalImageUrl || generatedAssets[0]?.url,
    generatedAssets,
    sourceHits:
      patch?.sourceHits !== undefined
        ? (Array.isArray(patch.sourceHits) ? patch.sourceHits.slice(0, 12) : [])
        : existing.sourceHits ?? [],
    updatedAt: nowIso()
  };
  campaigns.set(id, next);
  scheduleSave();
  return next;
}

export function deleteCampaign(id: string): boolean {
  const existed = campaigns.delete(id);
  if (existed) scheduleSave();
  return existed;
}
