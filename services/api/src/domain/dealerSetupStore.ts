import { promises as fs } from "node:fs";
import * as path from "node:path";
import { dataPath } from "./dataDir.js";

export type DealerSetupStage = "intake" | "dns" | "vercel" | "api_config" | "connectors" | "agreement" | "live";
export type DealerSetupStatus = "draft" | "in_progress" | "blocked" | "ready" | "live";
export type DealerSetupStepStatus = "pending" | "in_progress" | "blocked" | "done";

export type DealerSetupStep = {
  id: string;
  label: string;
  status: DealerSetupStepStatus;
  note?: string;
};

export type DealerSetup = {
  id: string;
  dealerName: string;
  slug: string;
  commandUrl: string;
  appUrl: string;
  apiUrl: string;
  stage: DealerSetupStage;
  status: DealerSetupStatus;
  owner?: string;
  primaryContact?: string;
  website?: string;
  crmProvider?: string;
  leadVolume?: string;
  notes?: string;
  steps: DealerSetupStep[];
  createdAt: string;
  updatedAt: string;
};

const STORE_PATH = process.env.DEALER_SETUPS_PATH || dataPath("dealer_setups.json");
const MAX_ROWS = Number(process.env.DEALER_SETUPS_MAX_ROWS ?? "500");

let loaded = false;
let rows: DealerSetup[] = [];
let saveTimer: NodeJS.Timeout | null = null;

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function defaultSteps(): DealerSetupStep[] {
  return [
    { id: "intake", label: "Dealer intake complete", status: "pending" },
    { id: "agreement", label: "Agreement and pricing approved", status: "pending" },
    { id: "vercel", label: "Vercel domain/project ready", status: "pending" },
    { id: "dns", label: "DNS records validated", status: "pending" },
    { id: "api", label: "API dealer config created", status: "pending" },
    { id: "google", label: "Google calendars and support mail connected", status: "pending" },
    { id: "twilio", label: "Twilio numbers and messaging configured", status: "pending" },
    { id: "sendgrid", label: "SendGrid sender/domain configured", status: "pending" },
    { id: "meta", label: "Meta app and callback verified", status: "pending" },
    { id: "smoke", label: "Smoke test passed", status: "pending" },
    { id: "handoff", label: "Dealer handoff complete", status: "pending" }
  ];
}

function buildUrls(slug: string) {
  const clean = slug || "newdealer";
  return {
    commandUrl: `https://www.leadrider.ai/command`,
    appUrl: `https://${clean}.leadrider.ai`,
    apiUrl: `https://api.${clean}.leadrider.ai`
  };
}

export async function listDealerSetups(limit = 100): Promise<DealerSetup[]> {
  await ensureLoaded();
  const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
  return [...rows]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, bounded);
}

export async function getDealerSetup(id: string): Promise<DealerSetup | null> {
  await ensureLoaded();
  return rows.find(row => row.id === id) ?? null;
}

export async function addDealerSetup(input: {
  dealerName: string;
  slug?: string;
  owner?: string;
  primaryContact?: string;
  website?: string;
  crmProvider?: string;
  leadVolume?: string;
  notes?: string;
}): Promise<DealerSetup> {
  await ensureLoaded();
  const now = new Date().toISOString();
  const dealerName = input.dealerName.replace(/\s+/g, " ").trim().slice(0, 160);
  const slug = slugify(input.slug || dealerName);
  const urls = buildUrls(slug);
  const setup: DealerSetup = {
    id: `dealer_setup_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    dealerName,
    slug,
    ...urls,
    stage: "intake",
    status: "draft",
    owner: input.owner?.replace(/\s+/g, " ").trim().slice(0, 120) || undefined,
    primaryContact: input.primaryContact?.replace(/\s+/g, " ").trim().slice(0, 160) || undefined,
    website: input.website?.trim().slice(0, 240) || undefined,
    crmProvider: input.crmProvider?.replace(/\s+/g, " ").trim().slice(0, 120) || undefined,
    leadVolume: input.leadVolume?.replace(/\s+/g, " ").trim().slice(0, 80) || undefined,
    notes: input.notes?.trim().slice(0, 2000) || undefined,
    steps: defaultSteps(),
    createdAt: now,
    updatedAt: now
  };
  rows.unshift(setup);
  const maxRows = Number.isFinite(MAX_ROWS) && MAX_ROWS > 0 ? Math.floor(MAX_ROWS) : 500;
  if (rows.length > maxRows) rows = rows.slice(0, maxRows);
  scheduleSave();
  return setup;
}

export async function updateDealerSetup(
  id: string,
  patch: Partial<Pick<DealerSetup, "stage" | "status" | "owner" | "primaryContact" | "website" | "crmProvider" | "leadVolume" | "notes">> & {
    stepId?: string;
    stepStatus?: DealerSetupStepStatus;
    stepNote?: string;
  }
): Promise<DealerSetup | null> {
  await ensureLoaded();
  const setup = rows.find(row => row.id === id);
  if (!setup) return null;
  if (patch.stage) setup.stage = patch.stage;
  if (patch.status) setup.status = patch.status;
  for (const key of ["owner", "primaryContact", "website", "crmProvider", "leadVolume", "notes"] as const) {
    if (typeof patch[key] === "string") (setup as any)[key] = patch[key]?.trim() || undefined;
  }
  if (patch.stepId && patch.stepStatus) {
    const step = setup.steps.find(row => row.id === patch.stepId);
    if (step) {
      step.status = patch.stepStatus;
      if (typeof patch.stepNote === "string") step.note = patch.stepNote.trim().slice(0, 600) || undefined;
    }
  }
  setup.updatedAt = new Date().toISOString();
  scheduleSave();
  return setup;
}

function isDealerSetup(row: any): row is DealerSetup {
  return !!row && typeof row === "object" && typeof row.id === "string" && typeof row.dealerName === "string";
}

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    rows = Array.isArray(parsed) ? parsed.filter(isDealerSetup) : [];
  } catch {
    rows = [];
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveNow();
  }, 200);
}

async function saveNow() {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, `${JSON.stringify(rows, null, 2)}\n`);
}
