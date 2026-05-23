import { promises as fs } from "node:fs";
import * as path from "node:path";
import { dataPath } from "./dataDir.js";

export type ActiveClientStatus = "active" | "implementation" | "paused" | "canceled";
export type ActiveClientPaymentMethod = "ach" | "card" | "check" | "wire" | "other";

export type ActiveClientPayment = {
  id: string;
  paidAt: string;
  amount: string;
  method: ActiveClientPaymentMethod;
  reference?: string;
  note?: string;
  createdAt: string;
};

export type ActiveClient = {
  id: string;
  dealerSetupId?: string;
  dealerName: string;
  status: ActiveClientStatus;
  owner?: string;
  primaryContactName?: string;
  primaryContactEmail?: string;
  primaryContactPhone?: string;
  billingContactName?: string;
  billingContactEmail?: string;
  billingContactPhone?: string;
  website?: string;
  appUrl?: string;
  apiUrl?: string;
  apiHealthUrl?: string;
  apiPm2Process?: string;
  apiDataDir?: string;
  apiEnvFile?: string;
  apiDeployProfilePath?: string;
  launchStatus?: string;
  providerStatuses?: string;
  runnerStatus?: string;
  leadVolume?: string;
  dealerLines?: string;
  contractTerm?: string;
  billingStart?: string;
  onboardingThread?: string;
  agreementUrl?: string;
  agreementStatus?: string;
  agreementSignedAt?: string;
  plan?: string;
  monthlyFee?: string;
  setupFee?: string;
  achMandateStatus?: string;
  bankLast4?: string;
  paymentTerms?: string;
  notes?: string;
  payments: ActiveClientPayment[];
  createdAt: string;
  updatedAt: string;
};

const STORE_PATH = process.env.ACTIVE_CLIENTS_PATH || dataPath("active_clients.json");
const MAX_ROWS = Number(process.env.ACTIVE_CLIENTS_MAX_ROWS ?? "1000");

let loaded = false;
let rows: ActiveClient[] = [];
let saveTimer: NodeJS.Timeout | null = null;

export async function listActiveClients(limit = 250): Promise<ActiveClient[]> {
  await ensureLoaded();
  const bounded = Math.max(1, Math.min(1000, Math.floor(limit)));
  return [...rows].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, bounded);
}

export async function getActiveClient(id: string): Promise<ActiveClient | null> {
  await ensureLoaded();
  return rows.find(row => row.id === id) ?? null;
}

export async function addActiveClient(input: Partial<ActiveClient> & { dealerName: string }): Promise<ActiveClient> {
  await ensureLoaded();
  const now = new Date().toISOString();
  const client: ActiveClient = {
    id: `active_client_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    dealerSetupId: clean(input.dealerSetupId, 140),
    dealerName: clean(input.dealerName, 180) || "Dealer",
    status: normalizeStatus(input.status) ?? "active",
    owner: clean(input.owner, 160),
    primaryContactName: clean(input.primaryContactName, 160),
    primaryContactEmail: clean(input.primaryContactEmail, 180),
    primaryContactPhone: clean(input.primaryContactPhone, 80),
    billingContactName: clean(input.billingContactName, 160),
    billingContactEmail: clean(input.billingContactEmail, 180),
    billingContactPhone: clean(input.billingContactPhone, 80),
    website: clean(input.website, 240),
    appUrl: clean(input.appUrl, 240),
    apiUrl: clean(input.apiUrl, 240),
    apiHealthUrl: clean(input.apiHealthUrl, 240),
    apiPm2Process: clean(input.apiPm2Process, 160),
    apiDataDir: clean(input.apiDataDir, 300),
    apiEnvFile: clean(input.apiEnvFile, 300),
    apiDeployProfilePath: clean(input.apiDeployProfilePath, 240),
    launchStatus: clean(input.launchStatus, 160),
    providerStatuses: clean(input.providerStatuses, 1200),
    runnerStatus: clean(input.runnerStatus, 240),
    leadVolume: clean(input.leadVolume, 80),
    dealerLines: clean(input.dealerLines, 120),
    contractTerm: clean(input.contractTerm, 120),
    billingStart: clean(input.billingStart, 120),
    onboardingThread: clean(input.onboardingThread, 240),
    agreementUrl: clean(input.agreementUrl, 500),
    agreementStatus: clean(input.agreementStatus, 80),
    agreementSignedAt: clean(input.agreementSignedAt, 80),
    plan: clean(input.plan, 80),
    monthlyFee: clean(input.monthlyFee, 80),
    setupFee: clean(input.setupFee, 80),
    achMandateStatus: clean(input.achMandateStatus, 120),
    bankLast4: clean(input.bankLast4, 12),
    paymentTerms: clean(input.paymentTerms, 240),
    notes: clean(input.notes, 3000),
    payments: [],
    createdAt: now,
    updatedAt: now
  };
  rows.unshift(client);
  const maxRows = Number.isFinite(MAX_ROWS) && MAX_ROWS > 0 ? Math.floor(MAX_ROWS) : 1000;
  if (rows.length > maxRows) rows = rows.slice(0, maxRows);
  scheduleSave();
  return client;
}

export async function updateActiveClient(id: string, patch: Partial<ActiveClient>): Promise<ActiveClient | null> {
  await ensureLoaded();
  const client = rows.find(row => row.id === id);
  if (!client) return null;
  if (patch.status) client.status = normalizeStatus(patch.status) ?? client.status;
  for (const key of [
    "dealerSetupId",
    "dealerName",
    "owner",
    "primaryContactName",
    "primaryContactEmail",
    "primaryContactPhone",
    "billingContactName",
    "billingContactEmail",
    "billingContactPhone",
    "website",
    "appUrl",
    "apiUrl",
    "apiHealthUrl",
    "apiPm2Process",
    "apiDataDir",
    "apiEnvFile",
    "apiDeployProfilePath",
    "launchStatus",
    "providerStatuses",
    "runnerStatus",
    "leadVolume",
    "dealerLines",
    "contractTerm",
    "billingStart",
    "onboardingThread",
    "agreementUrl",
    "agreementStatus",
    "agreementSignedAt",
    "plan",
    "monthlyFee",
    "setupFee",
    "achMandateStatus",
    "bankLast4",
    "paymentTerms",
    "notes"
  ] as const) {
    if (typeof patch[key] === "string") {
      const max = key === "notes" ? 3000 : key === "providerStatuses" ? 1200 : 500;
      (client as any)[key] = clean(patch[key], max);
    }
  }
  client.updatedAt = new Date().toISOString();
  scheduleSave();
  return client;
}

export async function addActiveClientPayment(
  clientId: string,
  input: Partial<ActiveClientPayment> & { amount: string; paidAt: string }
): Promise<ActiveClient | null> {
  await ensureLoaded();
  const client = rows.find(row => row.id === clientId);
  if (!client) return null;
  const now = new Date().toISOString();
  client.payments = [
    {
      id: `payment_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      paidAt: clean(input.paidAt, 80) || now.slice(0, 10),
      amount: clean(input.amount, 80) || "$0",
      method: normalizePaymentMethod(input.method) ?? "ach",
      reference: clean(input.reference, 160),
      note: clean(input.note, 500),
      createdAt: now
    },
    ...(Array.isArray(client.payments) ? client.payments : [])
  ];
  client.updatedAt = now;
  scheduleSave();
  return client;
}

const statuses: ActiveClientStatus[] = ["active", "implementation", "paused", "canceled"];
const paymentMethods: ActiveClientPaymentMethod[] = ["ach", "card", "check", "wire", "other"];

function normalizeStatus(value: unknown): ActiveClientStatus | undefined {
  const status = String(value ?? "").trim().toLowerCase();
  return statuses.includes(status as ActiveClientStatus) ? (status as ActiveClientStatus) : undefined;
}

function normalizePaymentMethod(value: unknown): ActiveClientPaymentMethod | undefined {
  const method = String(value ?? "").trim().toLowerCase();
  return paymentMethods.includes(method as ActiveClientPaymentMethod) ? (method as ActiveClientPaymentMethod) : undefined;
}

function clean(value: unknown, max: number): string | undefined {
  const text = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  return text || undefined;
}

function isActiveClient(row: any): row is ActiveClient {
  return !!row && typeof row === "object" && typeof row.id === "string" && typeof row.dealerName === "string";
}

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    rows = Array.isArray(parsed) ? parsed.filter(isActiveClient) : [];
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
