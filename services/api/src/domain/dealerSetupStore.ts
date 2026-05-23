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

export type DealerSetupChecklistStatus = "pending" | "working" | "blocked" | "ready" | "optional";
export type DealerDeployReadinessStatus = "blocked" | "not_ready" | "ready_to_deploy" | "live_ready";

export type DealerLaunchChecklistItem = {
  id: string;
  label: string;
  status: DealerSetupChecklistStatus;
  detail: string;
  stepId?: string;
};

export type DealerRemoteEnvItem = {
  key: string;
  label: string;
  category: string;
  required: boolean;
  secret: boolean;
  status: DealerSetupChecklistStatus;
  description: string;
  valueHint?: string;
};

export type DealerDeployReadiness = {
  status: DealerDeployReadinessStatus;
  label: string;
  summary: string;
  canDeployApi: boolean;
  canPushToActiveClient: boolean;
  missing: string[];
  blockers: string[];
  warnings: string[];
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
  launchChecklist?: DealerLaunchChecklistItem[];
  remoteEnvChecklist?: DealerRemoteEnvItem[];
  remoteEnvTemplate?: string;
  deployReadiness?: DealerDeployReadiness;
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
    { id: "remote_env", label: "Remote API env confirmed", status: "pending" },
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

function mergeDefaultSteps(existing: DealerSetupStep[] | undefined): DealerSetupStep[] {
  const current = Array.isArray(existing) ? existing : [];
  const defaults = defaultSteps();
  const byId = new Map(current.map(step => [step.id, step]));
  return defaults.map(step => byId.get(step.id) ?? step);
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

function stepStatus(setup: Pick<DealerSetup, "steps">, stepId: string): DealerSetupStepStatus {
  return mergeDefaultSteps(setup.steps).find(step => step.id === stepId)?.status ?? "pending";
}

function checklistStatusFromStep(status: DealerSetupStepStatus): DealerSetupChecklistStatus {
  if (status === "done") return "ready";
  if (status === "in_progress") return "working";
  if (status === "blocked") return "blocked";
  return "pending";
}

function stepLabel(setup: Pick<DealerSetup, "steps">, stepId: string): string {
  return mergeDefaultSteps(setup.steps).find(step => step.id === stepId)?.label ?? stepId;
}

function buildDeployReadiness(setup: DealerSetup): DealerDeployReadiness {
  const requiredDone = ["vercel", "dns", "remote_env"];
  const requiredStarted = ["api", "google", "twilio", "sendgrid", "meta"];
  const blockingSteps = [...requiredDone, ...requiredStarted, "smoke"];
  const missing: string[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  for (const stepId of requiredDone) {
    const status = stepStatus(setup, stepId);
    if (status !== "done") missing.push(stepLabel(setup, stepId));
  }

  for (const stepId of requiredStarted) {
    const status = stepStatus(setup, stepId);
    if (status !== "done" && status !== "in_progress") missing.push(stepLabel(setup, stepId));
  }

  for (const stepId of blockingSteps) {
    const status = stepStatus(setup, stepId);
    if (status === "blocked") blockers.push(stepLabel(setup, stepId));
  }

  if (stepStatus(setup, "smoke") === "pending") warnings.push("Launch smoke test has not run yet.");
  if (!setup.website) warnings.push("Dealer website is not captured.");
  if (!setup.primaryContact) warnings.push("Primary contact is not captured.");

  const canDeployApi = missing.length === 0 && blockers.length === 0;
  const canPushToActiveClient = canDeployApi && stepStatus(setup, "smoke") === "done";
  const status: DealerDeployReadinessStatus = blockers.length
    ? "blocked"
    : canPushToActiveClient
      ? "live_ready"
      : canDeployApi
        ? "ready_to_deploy"
        : "not_ready";

  const label =
    status === "blocked"
      ? "Blocked"
      : status === "live_ready"
        ? "Live-ready"
        : status === "ready_to_deploy"
          ? "Ready to deploy"
          : "Not ready";

  const summary =
    status === "blocked"
      ? `Resolve ${blockers.length} blocked setup step${blockers.length === 1 ? "" : "s"} before deployment.`
      : status === "live_ready"
        ? "Smoke test passed. This dealer can be pushed to Active Clients."
        : status === "ready_to_deploy"
          ? "Required setup is ready. Deploy the API, then run the launch smoke test."
          : missing.length
            ? `Complete ${missing.length} required item${missing.length === 1 ? "" : "s"} before deployment.`
            : "Review setup readiness before deployment.";

  return {
    status,
    label,
    summary,
    canDeployApi,
    canPushToActiveClient,
    missing,
    blockers,
    warnings
  };
}

function buildLaunchChecklist(setup: DealerSetup): DealerLaunchChecklistItem[] {
  const deployment = buildDealerApiDeployment(setup);
  const item = (id: string, label: string, stepId: string, detail: string): DealerLaunchChecklistItem => ({
    id,
    label,
    stepId,
    status: checklistStatusFromStep(stepStatus(setup, stepId)),
    detail
  });
  return [
    item("intake", "Dealer intake", "intake", setup.website ? `Website captured: ${setup.website}` : "Dealer website/contact fields still need review."),
    item("agreement", "Agreement", "agreement", "Pricing, term, legal name, signer, and e-sign packet are approved."),
    item("vercel", "Vercel web domain", "vercel", `${deployment.webHostname} is added to the Vercel project and verified.`),
    item("dns", "DNS records", "dns", `Point ${deployment.webHostname} to Vercel and ${deployment.apiHostname} to the API server.`),
    item("api_profile", "API deploy profile", "api", `${deployment.deployProfileLocalPath} uses isolated checkout/env/data/PM2 paths.`),
    item("remote_env", "Remote API env", "remote_env", `Required variables are present in ${deployment.envFile}; secret values stay on the server.`),
    item("google", "Google mail/calendar", "google", "OAuth credentials and support/calendar token paths are configured for this dealer."),
    item("twilio", "Twilio messaging", "twilio", "Phone number, webhook URLs, compliance, and routing are configured."),
    item("sendgrid", "SendGrid email", "sendgrid", "Sender/domain, inbound parse, and reply-to fields are configured."),
    item("meta", "Meta connection", "meta", "App ID/secret, callback URL, permissions, and active app status are verified."),
    item("smoke", "Launch smoke test", "smoke", "Web app, API health, inventory, conversation, and provider routes have been checked."),
    {
      id: "runner",
      label: "Runner computer",
      status: "optional",
      detail: "Needed only for MDF, DMS, or other browser automation. Register one trusted runner computer per dealer."
    },
    item("handoff", "Dealer handoff", "handoff", "Client record is live with URLs, owner, billing, and support details.")
  ];
}

function buildRemoteEnvChecklist(setup: DealerSetup): DealerRemoteEnvItem[] {
  const deployment = buildDealerApiDeployment(setup);
  const remoteEnvStatus = checklistStatusFromStep(stepStatus(setup, "remote_env"));
  const requiredStatus = remoteEnvStatus === "ready" || remoteEnvStatus === "blocked" || remoteEnvStatus === "working"
    ? remoteEnvStatus
    : "pending";
  const required = (
    key: string,
    category: string,
    label: string,
    description: string,
    opts: { secret?: boolean; valueHint?: string } = {}
  ): DealerRemoteEnvItem => ({
    key,
    category,
    label,
    required: true,
    secret: !!opts.secret,
    status: requiredStatus,
    description,
    valueHint: opts.valueHint
  });
  const optional = (
    key: string,
    category: string,
    label: string,
    description: string,
    opts: { secret?: boolean; valueHint?: string } = {}
  ): DealerRemoteEnvItem => ({
    key,
    category,
    label,
    required: false,
    secret: !!opts.secret,
    status: "optional",
    description,
    valueHint: opts.valueHint
  });
  return [
    required("NODE_ENV", "Core", "Production mode", "Run the API in production mode.", { valueHint: "production" }),
    required("DATA_DIR", "Core", "Dealer runtime data", "Dealer-specific JSON stores, uploads, OAuth tokens, and generated state.", {
      valueHint: deployment.dataDir
    }),
    required("PUBLIC_BASE_URL", "Core", "Public API URL", "Public base URL used for callbacks, media links, and webhooks.", {
      valueHint: setup.apiUrl
    }),
    required("APP_BASE_URL", "Core", "Dealer web URL", "Dealer web application URL used in links back to the UI.", {
      valueHint: setup.appUrl
    }),
    required("API_BASE_URL", "Core", "API URL", "Canonical API URL for server-generated links and internal route references.", {
      valueHint: setup.apiUrl
    }),
    required("DEALER_SLUG", "Core", "Dealer slug", "Stable dealer identifier used in logs and usage records.", { valueHint: setup.slug }),
    required("DEALER_PROFILE_PATH", "Core", "Dealer profile path", "Dealer-specific profile config file inside the runtime data directory.", {
      valueHint: `${deployment.dataDir}/dealer_profile.json`
    }),
    required("AUTH_DISABLED", "Core", "Authentication enabled", "Must be false for production dealer workspaces.", { valueHint: "false" }),
    required("OPENAI_API_KEY", "AI", "OpenAI key", "LLM drafting, parsing, campaign generation, and usage logging.", { secret: true }),
    required("LLM_ENABLED", "AI", "LLM enabled", "Enables parser-first draft and routing behavior.", { valueHint: "1" }),
    required("SENDGRID_API_KEY", "Email", "SendGrid key", "Outbound and inbound email handling.", { secret: true }),
    required("SENDGRID_FROM_EMAIL", "Email", "Sender email", "Dealer-approved outbound sender address."),
    optional("SENDGRID_REPLY_TO", "Email", "Reply-to email", "Dealer reply-to address when different from the sender."),
    required("TWILIO_ACCOUNT_SID", "Messaging", "Twilio account", "Dealer messaging account SID.", { secret: true }),
    required("TWILIO_AUTH_TOKEN", "Messaging", "Twilio auth token", "Dealer messaging auth token.", { secret: true }),
    required("TWILIO_PHONE_NUMBER", "Messaging", "Twilio phone", "Primary dealer texting number."),
    optional("TWILIO_FROM_NUMBER", "Messaging", "Twilio from number", "Fallback sender for older inbound/email bridge paths."),
    required("GOOGLE_CLIENT_ID", "Google", "Google OAuth client", "Calendar and Gmail OAuth client ID.", { secret: true }),
    required("GOOGLE_CLIENT_SECRET", "Google", "Google OAuth secret", "Calendar and Gmail OAuth client secret.", { secret: true }),
    required("GOOGLE_REDIRECT_URI", "Google", "Google redirect URI", "OAuth redirect URL for the dealer API.", {
      valueHint: `${setup.apiUrl.replace(/\/$/, "")}/integrations/google/callback`
    }),
    optional("GOOGLE_SUPPORT_MAIL_TOKEN_PATH", "Google", "Support mail token path", "Token file path for support mailbox access.", {
      valueHint: `${deployment.dataDir}/google_support_mail_tokens.json`
    }),
    required("META_APP_ID", "Meta", "Meta app ID", "Meta app used for lead/campaign integration."),
    required("META_APP_SECRET", "Meta", "Meta app secret", "Meta app secret for OAuth callbacks.", { secret: true }),
    required("META_REDIRECT_URI", "Meta", "Meta redirect URI", "Callback URL registered in Meta.", {
      valueHint: `${setup.apiUrl.replace(/\/$/, "")}/integrations/meta/callback`
    }),
    optional("SENTRY_DSN", "Ops", "Sentry DSN", "API error reporting."),
    optional("SLACK_INCIDENT_WEBHOOK_URL", "Ops", "Slack incident webhook", "Incident notifications."),
    optional("LINEAR_API_KEY", "Ops", "Linear key", "Ticket creation for production incidents.", { secret: true }),
    optional("AUTOMATION_RUN_WRITE_TOKEN", "Ops", "Automation token", "Closed-loop automation ingest and runner callbacks.", { secret: true }),
    optional("MDF_PORTAL_RUNNER_TOKEN", "Runner", "MDF runner token", "Required if the dealer uses a managed MDF/browser runner.", { secret: true })
  ];
}

function buildRemoteEnvTemplate(setup: DealerSetup): string {
  return buildRemoteEnvChecklist(setup)
    .map(item => {
      const value = item.secret ? "" : item.valueHint ?? "";
      return [`# ${item.category}: ${item.description}`, `${item.key}=${value}`].join("\n");
    })
    .join("\n\n") + "\n";
}

function withGeneratedFields(setup: DealerSetup): DealerSetup {
  const normalized = {
    ...setup,
    steps: mergeDefaultSteps(setup.steps)
  };
  return {
    ...normalized,
    apiDeployment: buildDealerApiDeployment(normalized),
    launchChecklist: buildLaunchChecklist(normalized),
    remoteEnvChecklist: buildRemoteEnvChecklist(normalized),
    remoteEnvTemplate: buildRemoteEnvTemplate(normalized),
    deployReadiness: buildDeployReadiness(normalized)
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
    } else {
      const defaultStep = defaultSteps().find(row => row.id === patch.stepId);
      if (defaultStep) {
        setup.steps.push({
          ...defaultStep,
          status: patch.stepStatus,
          note: typeof patch.stepNote === "string" ? patch.stepNote.trim().slice(0, 600) || undefined : defaultStep.note
        });
      }
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
