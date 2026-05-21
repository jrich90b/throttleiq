import { promises as fs } from "node:fs";
import * as path from "node:path";
import { dataPath } from "./dataDir.js";

export type SalesProspectStage =
  | "new"
  | "contacted"
  | "discovery"
  | "demo_scheduled"
  | "proposal"
  | "agreement_sent"
  | "closed_won"
  | "closed_lost";

export type SalesProspect = {
  id: string;
  dealerName: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  website?: string;
  stage: SalesProspectStage;
  owner?: string;
  leadVolume?: string;
  dealerLines?: string;
  plan?: string;
  expectedMonthly?: string;
  nextStep?: string;
  nextStepAt?: string;
  zoomLink?: string;
  docusignPacketId?: string;
  onboardingEmailThread?: string;
  emailSenderType?: "personal" | "onboarding" | "support";
  emailSenderAddress?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

const STORE_PATH = process.env.SALES_PROSPECTS_PATH || dataPath("sales_prospects.json");
const MAX_ROWS = Number(process.env.SALES_PROSPECTS_MAX_ROWS ?? "1000");

let loaded = false;
let rows: SalesProspect[] = [];
let saveTimer: NodeJS.Timeout | null = null;

export async function listSalesProspects(limit = 250): Promise<SalesProspect[]> {
  await ensureLoaded();
  const bounded = Math.max(1, Math.min(1000, Math.floor(limit)));
  return [...rows].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, bounded);
}

export async function getSalesProspect(id: string): Promise<SalesProspect | null> {
  await ensureLoaded();
  return rows.find(row => row.id === id) ?? null;
}

export async function addSalesProspect(input: Partial<SalesProspect> & { dealerName: string }): Promise<SalesProspect> {
  await ensureLoaded();
  const now = new Date().toISOString();
  const prospect: SalesProspect = {
    id: `prospect_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    dealerName: clean(input.dealerName, 180) || "Dealer",
    contactName: clean(input.contactName, 160),
    contactEmail: clean(input.contactEmail, 180),
    contactPhone: clean(input.contactPhone, 80),
    website: clean(input.website, 240),
    stage: normalizeStage(input.stage) ?? "new",
    owner: clean(input.owner, 120),
    leadVolume: clean(input.leadVolume, 80),
    dealerLines: clean(input.dealerLines, 40),
    plan: clean(input.plan, 80),
    expectedMonthly: clean(input.expectedMonthly, 80),
    nextStep: clean(input.nextStep, 240),
    nextStepAt: clean(input.nextStepAt, 80),
    zoomLink: clean(input.zoomLink, 500),
    docusignPacketId: clean(input.docusignPacketId, 160),
    onboardingEmailThread: clean(input.onboardingEmailThread, 240),
    emailSenderType: normalizeEmailSenderType(input.emailSenderType),
    emailSenderAddress: clean(input.emailSenderAddress, 180),
    notes: clean(input.notes, 3000),
    createdAt: now,
    updatedAt: now
  };
  rows.unshift(prospect);
  const maxRows = Number.isFinite(MAX_ROWS) && MAX_ROWS > 0 ? Math.floor(MAX_ROWS) : 1000;
  if (rows.length > maxRows) rows = rows.slice(0, maxRows);
  scheduleSave();
  return prospect;
}

export async function updateSalesProspect(id: string, patch: Partial<SalesProspect>): Promise<SalesProspect | null> {
  await ensureLoaded();
  const prospect = rows.find(row => row.id === id);
  if (!prospect) return null;
  if (patch.stage) {
    const stage = normalizeStage(patch.stage);
    if (stage) prospect.stage = stage;
  }
  for (const key of [
    "dealerName",
    "contactName",
    "contactEmail",
    "contactPhone",
    "website",
    "owner",
    "leadVolume",
    "dealerLines",
    "plan",
    "expectedMonthly",
    "nextStep",
    "nextStepAt",
    "zoomLink",
    "docusignPacketId",
    "onboardingEmailThread",
    "emailSenderAddress",
    "notes"
  ] as const) {
    if (typeof patch[key] === "string") (prospect as any)[key] = clean(patch[key], key === "notes" ? 3000 : 500);
  }
  if (patch.emailSenderType) {
    const emailSenderType = normalizeEmailSenderType(patch.emailSenderType);
    if (emailSenderType) prospect.emailSenderType = emailSenderType;
  }
  prospect.updatedAt = new Date().toISOString();
  scheduleSave();
  return prospect;
}

const stages: SalesProspectStage[] = [
  "new",
  "contacted",
  "discovery",
  "demo_scheduled",
  "proposal",
  "agreement_sent",
  "closed_won",
  "closed_lost"
];

function normalizeStage(value: unknown): SalesProspectStage | undefined {
  const stage = String(value ?? "").trim().toLowerCase();
  return stages.includes(stage as SalesProspectStage) ? (stage as SalesProspectStage) : undefined;
}

function normalizeEmailSenderType(value: unknown): SalesProspect["emailSenderType"] | undefined {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "personal" || normalized === "onboarding" || normalized === "support") return normalized;
  return undefined;
}

function clean(value: unknown, max: number): string | undefined {
  const text = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  return text || undefined;
}

function isSalesProspect(row: any): row is SalesProspect {
  return !!row && typeof row === "object" && typeof row.id === "string" && typeof row.dealerName === "string";
}

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    rows = Array.isArray(parsed) ? parsed.filter(isSalesProspect) : [];
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
