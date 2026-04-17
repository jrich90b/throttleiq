import { promises as fs } from "node:fs";
import { dataPath } from "./dataDir.js";

export type CampaignChannel = "sms" | "email" | "both";
export type CampaignStatus = "draft" | "generated";
export type CampaignBuildMode = "design_from_scratch" | "promotion_event_prompt";
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

export type CampaignEntry = {
  id: string;
  name: string;
  status: CampaignStatus;
  buildMode: CampaignBuildMode;
  channel: CampaignChannel;
  tags: CampaignTag[];
  prompt?: string;
  description?: string;
  inspirationImageUrls?: string[];
  assetImageUrls?: string[];
  smsBody?: string;
  emailSubject?: string;
  emailBodyText?: string;
  emailBodyHtml?: string;
  finalImageUrl?: string;
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

async function loadFromDisk() {
  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    const parsed = JSON.parse(raw) as { campaigns?: CampaignEntry[] };
    campaigns.clear();
    for (const row of parsed?.campaigns ?? []) {
      if (!row?.id) continue;
      campaigns.set(row.id, row);
    }
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      await saveToDisk();
    }
  }
}

void loadFromDisk();

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
  prompt?: string;
  description?: string;
  inspirationImageUrls?: string[];
  assetImageUrls?: string[];
  smsBody?: string;
  emailSubject?: string;
  emailBodyText?: string;
  emailBodyHtml?: string;
  finalImageUrl?: string;
  sourceHits?: CampaignSourceHit[];
  metadata?: Record<string, unknown>;
  createdByUserId?: string;
  createdByUserName?: string;
  generatedBy?: CampaignEntry["generatedBy"];
}): CampaignEntry {
  const now = nowIso();
  const entry: CampaignEntry = {
    id: makeId(),
    name: String(input.name ?? "").trim() || "Untitled campaign",
    status: input.status ?? "draft",
    buildMode: input.buildMode ?? "design_from_scratch",
    channel: input.channel ?? "both",
    tags: uniqTags(input.tags),
    prompt: String(input.prompt ?? "").trim() || undefined,
    description: String(input.description ?? "").trim() || undefined,
    inspirationImageUrls: uniqUrls(input.inspirationImageUrls),
    assetImageUrls: uniqUrls(input.assetImageUrls),
    smsBody: String(input.smsBody ?? "").trim() || undefined,
    emailSubject: String(input.emailSubject ?? "").trim() || undefined,
    emailBodyText: String(input.emailBodyText ?? "").trim() || undefined,
    emailBodyHtml: String(input.emailBodyHtml ?? "").trim() || undefined,
    finalImageUrl: String(input.finalImageUrl ?? "").trim() || undefined,
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
  const next: CampaignEntry = {
    ...existing,
    ...(patch ?? {}),
    name:
      patch?.name !== undefined
        ? String(patch.name ?? "").trim() || existing.name
        : existing.name,
    tags: patch?.tags ? uniqTags(patch.tags as CampaignTag[]) : existing.tags ?? [],
    inspirationImageUrls:
      patch?.inspirationImageUrls !== undefined
        ? uniqUrls(patch.inspirationImageUrls as string[])
        : existing.inspirationImageUrls ?? [],
    assetImageUrls:
      patch?.assetImageUrls !== undefined
        ? uniqUrls(patch.assetImageUrls as string[])
        : existing.assetImageUrls ?? [],
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
        : existing.finalImageUrl,
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
