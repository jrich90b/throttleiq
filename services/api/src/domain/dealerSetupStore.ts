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

export type DealerApiDeployment = {
  repoUrl: string;
  repoPath: string;
  envFile: string;
  dataDir: string;
  pm2Process: string;
  healthUrl: string;
  deployProfileLocalPath: string;
  deployCommand: string;
  webHostname: string;
  apiHostname: string;
  dnsRecords: Array<{
    type: "A" | "CNAME";
    name: string;
    value: string;
    purpose: string;
  }>;
  profileText: string;
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
  legalName?: string;
  dbaName?: string;
  dealerAddress?: string;
  website?: string;
  crmProvider?: string;
  leadVolume?: string;
  plan?: string;
  setupFee?: string;
  monthlyFee?: string;
  includedUsage?: string;
  overageTerms?: string;
  contractTerm?: string;
  billingStart?: string;
  notes?: string;
  steps: DealerSetupStep[];
  apiDeployment?: DealerApiDeployment;
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

function safeHostname(url: string, fallback: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return fallback;
  }
}

export function buildDealerApiDeployment(setup: Pick<DealerSetup, "slug" | "appUrl" | "apiUrl">): DealerApiDeployment {
  const clean = slugify(setup.slug || "newdealer") || "newdealer";
  const repoUrl = String(process.env.LEADRIDER_DEPLOY_REPO_URL ?? "https://github.com/jrich90b/throttleiq.git").trim();
  const apiAddress = String(process.env.LEADRIDER_API_STATIC_IP ?? "44.194.249.46").trim();
  const repoPath = `/home/ubuntu/leadrider-api/${clean}`;
  const runtimeRoot = `/home/ubuntu/leadrider-runtime/${clean}`;
  const pm2Process = `leadrider-api-${clean}`.slice(0, 80);
  const healthUrl = `${setup.apiUrl.replace(/\/$/, "")}/health`;
  const deployProfileLocalPath = `infra/deploy/${clean}.api.env`;
  const webHostname = safeHostname(setup.appUrl, `${clean}.leadrider.ai`);
  const apiHostname = safeHostname(setup.apiUrl, `api.${clean}.leadrider.ai`);
  const profileLines = [
    `DEPLOY_HOST=ubuntu@api.leadrider.ai`,
    `DEPLOY_REPO_URL=${repoUrl}`,
    `DEPLOY_REPO=${repoPath}`,
    `DEPLOY_BRANCH=main`,
    `DEPLOY_DATA_DIR=${runtimeRoot}/data`,
    `DEPLOY_ENV_FILE=${runtimeRoot}/api.env`,
    `DEPLOY_PM2_PROCESS=${pm2Process}`,
    `DEPLOY_HEALTH_URL=${healthUrl}`,
    `DEPLOY_REPLACE_PM2=1`,
    `DEPLOY_ALLOW_DIRTY_REMOTE=0`
  ];
  return {
    repoUrl,
    repoPath,
    envFile: `${runtimeRoot}/api.env`,
    dataDir: `${runtimeRoot}/data`,
    pm2Process,
    healthUrl,
    deployProfileLocalPath,
    deployCommand: `npm run deploy:api -- --profile ${deployProfileLocalPath}`,
    webHostname,
    apiHostname,
    dnsRecords: [
      {
        type: "CNAME",
        name: webHostname,
        value: "cname.vercel-dns.com",
        purpose: "Dealer web app on Vercel"
      },
      {
        type: "A",
        name: apiHostname,
        value: apiAddress,
        purpose: "Dealer API on Lightsail"
      }
    ],
    profileText: `${profileLines.join("\n")}\n`
  };
}

function withGeneratedFields(setup: DealerSetup): DealerSetup {
  return {
    ...setup,
    apiDeployment: buildDealerApiDeployment(setup)
  };
}

export async function listDealerSetups(limit = 100): Promise<DealerSetup[]> {
  await ensureLoaded();
  const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
  return [...rows]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, bounded)
    .map(withGeneratedFields);
}

export async function getDealerSetup(id: string): Promise<DealerSetup | null> {
  await ensureLoaded();
  const setup = rows.find(row => row.id === id) ?? null;
  return setup ? withGeneratedFields(setup) : null;
}

export async function addDealerSetup(input: {
  dealerName: string;
  slug?: string;
  owner?: string;
  primaryContact?: string;
  legalName?: string;
  dbaName?: string;
  dealerAddress?: string;
  website?: string;
  crmProvider?: string;
  leadVolume?: string;
  plan?: string;
  setupFee?: string;
  monthlyFee?: string;
  includedUsage?: string;
  overageTerms?: string;
  contractTerm?: string;
  billingStart?: string;
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
    legalName: input.legalName?.replace(/\s+/g, " ").trim().slice(0, 200) || undefined,
    dbaName: input.dbaName?.replace(/\s+/g, " ").trim().slice(0, 200) || undefined,
    dealerAddress: input.dealerAddress?.trim().slice(0, 400) || undefined,
    website: input.website?.trim().slice(0, 240) || undefined,
    crmProvider: input.crmProvider?.replace(/\s+/g, " ").trim().slice(0, 120) || undefined,
    leadVolume: input.leadVolume?.replace(/\s+/g, " ").trim().slice(0, 80) || undefined,
    plan: input.plan?.replace(/\s+/g, " ").trim().slice(0, 80) || undefined,
    setupFee: input.setupFee?.replace(/\s+/g, " ").trim().slice(0, 80) || undefined,
    monthlyFee: input.monthlyFee?.replace(/\s+/g, " ").trim().slice(0, 80) || undefined,
    includedUsage: input.includedUsage?.replace(/\s+/g, " ").trim().slice(0, 240) || undefined,
    overageTerms: input.overageTerms?.replace(/\s+/g, " ").trim().slice(0, 240) || undefined,
    contractTerm: input.contractTerm?.replace(/\s+/g, " ").trim().slice(0, 120) || undefined,
    billingStart: input.billingStart?.replace(/\s+/g, " ").trim().slice(0, 120) || undefined,
    notes: input.notes?.trim().slice(0, 2000) || undefined,
    steps: defaultSteps(),
    createdAt: now,
    updatedAt: now
  };
  rows.unshift(setup);
  const maxRows = Number.isFinite(MAX_ROWS) && MAX_ROWS > 0 ? Math.floor(MAX_ROWS) : 500;
  if (rows.length > maxRows) rows = rows.slice(0, maxRows);
  scheduleSave();
  return withGeneratedFields(setup);
}

export async function updateDealerSetup(
  id: string,
  patch: Partial<
    Pick<
      DealerSetup,
      | "stage"
      | "status"
      | "owner"
      | "primaryContact"
      | "legalName"
      | "dbaName"
      | "dealerAddress"
      | "website"
      | "crmProvider"
      | "leadVolume"
      | "plan"
      | "setupFee"
      | "monthlyFee"
      | "includedUsage"
      | "overageTerms"
      | "contractTerm"
      | "billingStart"
      | "notes"
    >
  > & {
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
  for (const key of [
    "owner",
    "primaryContact",
    "legalName",
    "dbaName",
    "dealerAddress",
    "website",
    "crmProvider",
    "leadVolume",
    "plan",
    "setupFee",
    "monthlyFee",
    "includedUsage",
    "overageTerms",
    "contractTerm",
    "billingStart",
    "notes"
  ] as const) {
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
  return withGeneratedFields(setup);
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
