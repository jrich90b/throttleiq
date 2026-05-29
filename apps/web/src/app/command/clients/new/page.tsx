"use client";

import { useEffect, useMemo, useState } from "react";

type DealerSetupStepStatus = "pending" | "in_progress" | "blocked" | "waiting_on_dealer" | "ready_to_verify" | "done";
type DealerSetupChecklistStatus = "pending" | "working" | "blocked" | "ready" | "optional";
type DealerRoutingMode = "subdomain" | "path" | "integration_mapping";

type DealerLaunchChecklistItem = {
  id: string;
  label: string;
  status: DealerSetupChecklistStatus;
  detail: string;
  stepId?: string;
};

type DealerRemoteEnvItem = {
  key: string;
  label: string;
  category: string;
  required: boolean;
  secret: boolean;
  status: DealerSetupChecklistStatus;
  description: string;
  valueHint?: string;
};

type DealerDeployReadiness = {
  status: "blocked" | "not_ready" | "ready_to_deploy" | "live_ready";
  label: string;
  summary: string;
  canDeployApi: boolean;
  canPushToActiveClient: boolean;
  missing: string[];
  blockers: string[];
  goLiveMissing?: string[];
  warnings: string[];
};

type DealerConfigStandard = Record<string, unknown>;

type DealerSetupStep = {
  id: string;
  label: string;
  status: DealerSetupStepStatus;
  note?: string;
};

type DealerSetup = {
  id: string;
  dealerName: string;
  slug: string;
  routingMode?: DealerRoutingMode;
  commandUrl: string;
  appUrl: string;
  apiUrl: string;
  stage: string;
  status: string;
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
  apiDeployment?: DealerApiDeployment;
  launchChecklist?: DealerLaunchChecklistItem[];
  remoteEnvChecklist?: DealerRemoteEnvItem[];
  remoteEnvTemplate?: string;
  deployReadiness?: DealerDeployReadiness;
  dealerConfig?: DealerConfigStandard;
  steps: DealerSetupStep[];
  updatedAt: string;
};

type VercelDomain = {
  domain: string;
  exists: boolean;
  verified?: boolean;
  error?: string;
};

type DnsRecord = {
  id: string;
  type: string;
  name: string;
  value: string;
  purpose: string;
};

type DealerApiDeployment = {
  routingMode?: DealerRoutingMode;
  routingSummary?: string;
  repoUrl: string;
  repoPath: string;
  envFile: string;
  dataDir: string;
  pm2Process: string;
  localPort?: number;
  internalBaseUrl?: string;
  healthUrl: string;
  proxyPathPrefix?: string;
  proxyTarget?: string;
  proxyNotes?: string[];
  nginxPreviewPath?: string;
  nginxPreview?: string;
  deployProfileLocalPath: string;
  deployCommand: string;
  webHostname: string;
  apiHostname: string;
  dnsRecords: Array<{
    type: string;
    name: string;
    value: string;
    purpose: string;
  }>;
  profileText: string;
};

type SmokeCheck = {
  url: string;
  ok: boolean;
  status: number;
  ms: number;
  error?: string;
};

type DealerRuntimePackageVerification = {
  ok: boolean;
  failures: string[];
  warnings: string[];
};

type DealerRuntimePackageFile = {
  path: string;
  description: string;
  content: string;
  sha256: string;
  mode?: number;
};

type DealerRuntimePackage = {
  packageDir: string;
  slug: string;
  generatedAt: string;
  manifest: Record<string, unknown>;
  files: DealerRuntimePackageFile[];
};

type DealerLaunchDryRunItem = {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  stepId?: string;
};

type DealerLaunchDryRun = {
  status: "blocked" | "review_ready" | "deploy_dry_run_ready" | "launch_ready";
  label: string;
  summary: string;
  ok: boolean;
  canRunDeployDryRun: boolean;
  canRequestProductionApproval: boolean;
  canLaunch: boolean;
  blockers: string[];
  warnings: string[];
  commands: {
    deployDryRun?: string;
    smoke: string;
    packageVerify: string;
  };
  items: DealerLaunchDryRunItem[];
};

type ActiveClient = {
  id: string;
  dealerName: string;
};

type DealerActivationResult = {
  message?: string;
  client?: ActiveClient;
  checks?: SmokeCheck[];
  dryRun?: DealerLaunchDryRun;
  activation?: {
    automated?: string[];
    manualApprovalStillRequired?: string[];
  };
};

type StepRunSummary = {
  message: string;
  nextStep?: string;
  task?: {
    id: string;
    title: string;
    status: string;
    provider: string;
  };
  blocked?: boolean;
};

type AgentTaskKind = "codex" | "agreement" | "vercel" | "stack" | "api" | "providers" | "texting";

type VendorWebsiteLink = {
  id: string;
  label: string;
  href: string;
  detail: string;
  stepId: string;
};

type StepSetupCopyValue = {
  id: string;
  label: string;
  value: string;
  detail: string;
};

type StepVendorGuide = {
  title: string;
  summary: string;
  links: VendorWebsiteLink[];
  copyValues: StepSetupCopyValue[];
  milestones: string[];
  approvalNote: string;
};

const planDefaults = {
  Starter: {
    setupFee: "$1,999",
    monthlyFee: "$999/month",
    includedUsage: "Up to 150 leads/month, 1,000 AI response credits, 1,000 outbound SMS segments/month, standard support.",
    overageTerms: "$2.00 per lead above plan, $0.025 per outbound SMS segment, AI usage above included credits billed at cost plus 20%."
  },
  Growth: {
    setupFee: "$2,999",
    monthlyFee: "$1,499/month",
    includedUsage: "Up to 300 leads/month, 5,000 AI response credits, 5,000 outbound SMS segments/month, email campaigns, support workflow.",
    overageTerms: "$1.50 per lead above plan, $0.025 per outbound SMS segment, AI usage above included credits billed at cost plus 20%."
  },
  Pro: {
    setupFee: "$4,999",
    monthlyFee: "$2,499/month",
    includedUsage: "Up to 750 leads/month, 12,000 AI response credits, 12,000 outbound SMS segments/month, campaigns, support, and setup automation.",
    overageTerms: "$1.00 per lead above plan, $0.022 per outbound SMS segment, AI usage above included credits billed at cost plus 18%."
  },
  Enterprise: {
    setupFee: "Custom",
    monthlyFee: "Custom",
    includedUsage: "Custom lead volume above 750 leads/month, AI response credits, outbound SMS segments, integrations, reporting, and support terms.",
    overageTerms: "Custom usage and overage terms based on dealer volume and connected providers."
  }
} as const;

type PlanName = keyof typeof planDefaults;

type DealerSetupForm = {
  dealerName: string;
  slug: string;
  routingMode: DealerRoutingMode;
  owner: string;
  primaryContact: string;
  legalName: string;
  dbaName: string;
  dealerAddress: string;
  website: string;
  crmProvider: string;
  leadVolume: string;
  plan: string;
  setupFee: string;
  monthlyFee: string;
  includedUsage: string;
  overageTerms: string;
  contractTerm: string;
  billingStart: string;
  generateAgreement: boolean;
  notes: string;
};

const emptyForm: DealerSetupForm = {
  dealerName: "",
  slug: "",
  routingMode: "path",
  owner: "Joe Hartrich",
  primaryContact: "",
  legalName: "",
  dbaName: "",
  dealerAddress: "",
  website: "",
  crmProvider: "",
  leadVolume: "",
  plan: "Growth",
  setupFee: planDefaults.Growth.setupFee,
  monthlyFee: planDefaults.Growth.monthlyFee,
  includedUsage: planDefaults.Growth.includedUsage,
  overageTerms: planDefaults.Growth.overageTerms,
  contractTerm: "12 months",
  billingStart: "",
  generateAgreement: false,
  notes: ""
};

function setupToForm(setup: DealerSetup): DealerSetupForm {
  return {
    dealerName: setup.dealerName || "",
    slug: setup.slug || "",
    routingMode: setup.routingMode || "subdomain",
    owner: setup.owner || "",
    primaryContact: setup.primaryContact || "",
    legalName: setup.legalName || "",
    dbaName: setup.dbaName || "",
    dealerAddress: setup.dealerAddress || "",
    website: setup.website || "",
    crmProvider: setup.crmProvider || "",
    leadVolume: setup.leadVolume || "",
    plan: setup.plan || "Growth",
    setupFee: setup.setupFee || "",
    monthlyFee: setup.monthlyFee || "",
    includedUsage: setup.includedUsage || "",
    overageTerms: setup.overageTerms || "",
    contractTerm: setup.contractTerm || "",
    billingStart: setup.billingStart || "",
    generateAgreement: false,
    notes: setup.notes || ""
  };
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function statusClass(value: string) {
  if (value === "done" || value === "ready" || value === "live") return "is-ready";
  if (value === "blocked") return "is-blocked";
  if (value === "in_progress" || value === "waiting_on_dealer" || value === "ready_to_verify") return "is-working";
  return "";
}

function statusLabel(value: string) {
  if (value === "pending") return "not started";
  if (value === "done") return "complete";
  return value.replace(/_/g, " ");
}

function readinessClass(status?: DealerDeployReadiness["status"]) {
  if (status === "live_ready" || status === "ready_to_deploy") return "is-ready";
  if (status === "blocked") return "is-blocked";
  return "is-working";
}

function routingModeLabel(value?: DealerRoutingMode) {
  if (value === "path") return "Shared app/API paths";
  if (value === "integration_mapping") return "Shared provider mapping (future router)";
  return "Separate dealer subdomains";
}

function routingModeDescription(value?: DealerRoutingMode) {
  if (value === "path") return "Use one LeadRider app/API domain and route this dealer by slug paths.";
  if (value === "integration_mapping") return "Future option: resolve the dealer from provider mappings after a shared tenant router is approved.";
  return "Use dedicated dealer web and API subdomains. American Harley stays on this mode.";
}

function isSharedRouting(setup: Pick<DealerSetup, "routingMode"> | null | undefined) {
  return (setup?.routingMode || "subdomain") !== "subdomain";
}

const fallbackDealerSteps: DealerSetupStep[] = [
  { id: "intake", label: "Dealer intake", status: "pending" },
  { id: "domains", label: "Tenant routing and domains", status: "pending" },
  { id: "sendgrid", label: "SendGrid sender/domain", status: "pending" },
  { id: "twilio", label: "Twilio SMS and compliance", status: "pending" },
  { id: "google", label: "Google Calendar and users", status: "pending" },
  { id: "inventory", label: "Inventory/export URL", status: "pending" },
  { id: "crm", label: "CRM/ADF/Twilio routing", status: "pending" },
  { id: "profile", label: "Dealer profile, tone, and features", status: "pending" },
  { id: "remote_env", label: "Server settings checklist", status: "pending" },
  { id: "api", label: "API tenant/runtime setup", status: "pending" },
  { id: "vercel", label: "Vercel frontend setup", status: "pending" },
  { id: "manual", label: "Deployment manual", status: "pending" },
  { id: "smoke", label: "Smoke tests", status: "pending" },
  { id: "launch_gate", label: "Launch gate", status: "pending" },
  { id: "handoff", label: "Production launch and monitoring", status: "pending" }
];

function mergedSetupSteps(steps: DealerSetupStep[] = []) {
  const aliases: Record<string, string> = { dns: "domains", agreement: "intake", meta: "profile" };
  const byId = new Map(steps.map(step => [step.id, step]));
  for (const [oldId, newId] of Object.entries(aliases)) {
    const oldStep = byId.get(oldId);
    if (oldStep && !byId.has(newId)) byId.set(newId, { ...oldStep, id: newId });
  }
  const merged = fallbackDealerSteps.map(step => {
    const existing = byId.get(step.id);
    return existing ? { ...existing, label: step.label } : step;
  });
  const known = new Set(merged.map(step => step.id));
  for (const oldId of Object.keys(aliases)) known.add(oldId);
  return merged.concat(steps.filter(step => !known.has(step.id)));
}

function setupStepStatus(setup: DealerSetup, stepId: string): DealerSetupStepStatus {
  return mergedSetupSteps(setup.steps).find(step => step.id === stepId)?.status ?? "pending";
}

function setupStepLabel(setup: DealerSetup, stepId: string) {
  return mergedSetupSteps(setup.steps).find(step => step.id === stepId)?.label ?? stepId;
}

function buildFallbackDeployReadiness(setup: DealerSetup): DealerDeployReadiness {
  const requiredDone = ["domains", "remote_env"];
  const requiredStarted = ["api", "vercel", "google", "twilio", "sendgrid", "inventory", "crm", "profile", "manual"];
  const goLiveRequiredDone = ["intake", ...requiredDone, ...requiredStarted, "smoke", "launch_gate"];
  const missing: string[] = [];
  const blockers: string[] = [];
  const goLiveMissing: string[] = [];
  const warnings: string[] = [];

  for (const stepId of requiredDone) {
    if (setupStepStatus(setup, stepId) !== "done") missing.push(setupStepLabel(setup, stepId));
  }
  for (const stepId of requiredStarted) {
    const status = setupStepStatus(setup, stepId);
    if (status !== "done" && status !== "in_progress" && status !== "ready_to_verify" && status !== "waiting_on_dealer") {
      missing.push(setupStepLabel(setup, stepId));
    }
  }
  for (const stepId of goLiveRequiredDone) {
    const status = setupStepStatus(setup, stepId);
    if (status === "blocked") blockers.push(setupStepLabel(setup, stepId));
    if (status !== "done") goLiveMissing.push(setupStepLabel(setup, stepId));
  }

  if (setupStepStatus(setup, "smoke") === "pending") warnings.push("Launch smoke test has not run yet.");
  if (goLiveMissing.length) {
    warnings.push(
      `Setup can continue in parallel. Go-live waits on ${goLiveMissing.length} item${goLiveMissing.length === 1 ? "" : "s"}.`
    );
  }
  if (!setup.website) warnings.push("Dealer website is not captured.");
  if (!setup.primaryContact) warnings.push("Primary contact is not captured.");

  const coreBlockers = requiredDone.filter(stepId => setupStepStatus(setup, stepId) === "blocked");
  const canDeployApi = missing.length === 0 && coreBlockers.length === 0;
  const canPushToActiveClient = canDeployApi && goLiveMissing.length === 0 && blockers.length === 0;
  const status = coreBlockers.length
    ? "blocked"
    : canPushToActiveClient
      ? "live_ready"
      : canDeployApi
        ? "ready_to_deploy"
        : "not_ready";
  const label =
    status === "blocked" ? "Blocked" : status === "live_ready" ? "Live-ready" : status === "ready_to_deploy" ? "Ready to deploy" : "Not ready";
  const summary =
    status === "blocked"
      ? `Resolve ${coreBlockers.length} core blocked item${coreBlockers.length === 1 ? "" : "s"} before deployment. Other setup steps can continue.`
      : status === "live_ready"
        ? "Smoke test passed. This dealer can be pushed to Active Clients."
        : status === "ready_to_deploy"
          ? goLiveMissing.length
            ? `Core setup can continue. Go-live is waiting on ${goLiveMissing.length} item${goLiveMissing.length === 1 ? "" : "s"}.`
            : "Required setup is ready. Deploy the API, then run the launch smoke test."
          : missing.length
            ? `Complete ${missing.length} required item${missing.length === 1 ? "" : "s"} before deployment.`
            : "Review setup readiness before deployment.";

  return { status, label, summary, canDeployApi, canPushToActiveClient, missing, blockers, goLiveMissing, warnings };
}

function guidedStepDescription(stepId: string) {
  switch (stepId) {
    case "intake":
      return "Confirm the dealer record has the right website, contact, legal name, plan, and billing terms.";
    case "domains":
      return "Confirm how this dealer will route into LeadRider. Shared routing can move ahead without dealer-specific DNS.";
    case "vercel":
      return "Prepare the dealer website setup and route/domain checklist.";
    case "api":
      return "Prepare the isolated API runtime paths, profile, health check, and rollback notes.";
    case "remote_env":
      return "Confirm the required server settings and secret values are ready.";
    case "google":
      return "Connect dealer Gmail, support mail, and calendars.";
    case "twilio":
      return "Configure dealer texting, compliance, and message routing.";
    case "sendgrid":
      return "Configure the dealer email sender, domain, and inbound routing.";
    case "inventory":
      return "Capture and validate the dealer inventory feed or export URL.";
    case "crm":
      return "Confirm ADF source mappings and how CRM, email, and SMS route into LeadRider.";
    case "profile":
      return "Set the dealer's tone, policy rules, feature flags, and compliance language.";
    case "manual":
      return "Review the dealer deployment manual generated from this setup record.";
    case "smoke":
      return "Check the dealer app and API before launch.";
    case "launch_gate":
      return "Review blockers, remote env, vendor approvals, smoke tests, rollback, and monitoring before launch.";
    case "handoff":
      return "Move the live-ready dealer into Active Clients after production launch approval.";
    default:
      return "Work the next setup item.";
  }
}

function canMarkStepComplete(step: DealerSetupStep) {
  return (
    (step.status === "in_progress" || step.status === "ready_to_verify" || step.status === "waiting_on_dealer") &&
    ["domains", "api", "remote_env", "google", "twilio", "sendgrid", "inventory", "crm", "profile", "vercel", "manual", "launch_gate"].includes(step.id)
  );
}

function safeExternalUrl(value: string | undefined) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withProtocol).toString();
  } catch {
    return "";
  }
}

function hostnameFromUrl(value: string | undefined) {
  const href = safeExternalUrl(value);
  if (!href) return "";
  try {
    return new URL(href).hostname;
  } catch {
    return "";
  }
}

function buildVendorWebsiteLinks(setup: DealerSetup | null): VendorWebsiteLink[] {
  if (!setup) return [];
  const dealerWebsite = safeExternalUrl(setup.website);
  const webHost = hostnameFromUrl(setup.appUrl);
  const apiHost = hostnameFromUrl(setup.apiUrl);
  const shared = isSharedRouting(setup);
  return [
    dealerWebsite
      ? {
          id: "dealer-website",
          label: "Dealer website",
          href: dealerWebsite,
          detail: "Reference public dealer site and contact details.",
          stepId: "intake"
        }
      : null,
    {
      id: "vercel",
      label: "Vercel project",
      href: "https://vercel.com/lead-rider/leadrider-web",
      detail: "Frontend deployments, domains, and environment variables.",
      stepId: "vercel"
    },
    webHost
      ? {
          id: "web-dns-check",
          label: shared ? "Shared web host check" : "Web DNS check",
          href: `https://www.whatsmydns.net/#CNAME/${encodeURIComponent(webHost)}`,
          detail: shared ? "Confirm the shared app host is live." : "Check public web-domain propagation.",
          stepId: "domains"
        }
      : null,
    apiHost
      ? {
          id: "api-dns-check",
          label: shared ? "Shared API host check" : "API DNS check",
          href: `https://www.whatsmydns.net/#A/${encodeURIComponent(apiHost)}`,
          detail: shared ? "Confirm the shared API host is live." : "Check public API-domain propagation.",
          stepId: "domains"
        }
      : null,
    {
      id: "twilio-console",
      label: "Twilio Console",
      href: "https://console.twilio.com/",
      detail: "Phone numbers, messaging, A2P/10DLC, and webhooks.",
      stepId: "twilio"
    },
    {
      id: "sendgrid-sender-auth",
      label: "SendGrid sender auth",
      href: "https://app.sendgrid.com/settings/sender_auth",
      detail: "Sender identity and domain authentication.",
      stepId: "sendgrid"
    },
    {
      id: "sendgrid-inbound",
      label: "SendGrid inbound parse",
      href: "https://app.sendgrid.com/settings/parse",
      detail: "Inbound ADF/email parse routing.",
      stepId: "sendgrid"
    },
    {
      id: "google-cloud",
      label: "Google credentials",
      href: "https://console.cloud.google.com/apis/credentials",
      detail: "OAuth credentials and redirect URI setup.",
      stepId: "google"
    },
    {
      id: "google-calendar",
      label: "Google Calendar",
      href: "https://calendar.google.com/",
      detail: "Calendar/user verification.",
      stepId: "google"
    },
    {
      id: "openai-usage",
      label: "OpenAI usage",
      href: "https://platform.openai.com/usage",
      detail: "Usage review for tenant launch monitoring.",
      stepId: "remote_env"
    }
  ].filter((link): link is VendorWebsiteLink => Boolean(link));
}

function apiPath(setup: DealerSetup, path: string) {
  return `${setup.apiUrl.replace(/\/$/, "")}${path}`;
}

function buildStepVendorGuide(setup: DealerSetup, step: DealerSetupStep | null, links: VendorWebsiteLink[], deployment: DealerApiDeployment | null): StepVendorGuide | null {
  if (!step) return null;
  const linkFor = (...stepIds: string[]) => links.filter(link => stepIds.includes(link.stepId));
  const appHost = hostnameFromUrl(setup.appUrl);
  const apiHost = hostnameFromUrl(setup.apiUrl);
  const shared = isSharedRouting(setup);
  const routeLabel = routingModeLabel(setup.routingMode);
  const twilioWebhook = apiPath(setup, "/webhooks/twilio");
  const sendgridInbound = apiPath(setup, "/crm/leads/adf/sendgrid");
  const googleCallback = apiPath(setup, "/integrations/google/callback");
  const commonApproval = "Human approval remains required for vendor submissions, DNS changes, credentials, MFA, billing, legal approval, and production launch.";
  const guide = (
    title: string,
    summary: string,
    stepLinks: VendorWebsiteLink[],
    copyValues: StepSetupCopyValue[],
    milestones: string[],
    approvalNote = commonApproval
  ): StepVendorGuide => ({ title, summary, links: stepLinks, copyValues: copyValues.filter(item => item.value), milestones, approvalNote });

  switch (step.id) {
    case "intake":
      return guide(
        "Dealer intake actions",
        "Confirm the public dealer details and keep the setup record clean before technical work starts.",
        linkFor("intake"),
        [
          { id: "dealer-app-url", label: "Copy LeadRider app URL", value: setup.appUrl, detail: "Save this as the future dealer login URL." },
          { id: "dealer-api-url", label: "Copy API URL", value: setup.apiUrl, detail: "Use this for vendor callback and health-check planning." },
          { id: "dealer-routing", label: "Copy routing mode", value: routeLabel, detail: "Record how this dealer will route into LeadRider." }
        ],
        ["Dealer website checked", "Legal/DBA/contact details captured", "Plan and billing terms reviewed"]
      );
    case "domains":
      return guide(
        shared ? "Tenant routing actions" : "Domain actions",
        shared
          ? "Confirm shared LeadRider hosts and route mapping. No per-dealer DNS is needed for this routing mode."
          : "Open DNS checks and copy the target hostnames while the dealer or DNS owner makes changes.",
        linkFor("domains"),
        [
          { id: "route-mode", label: "Copy routing mode", value: routeLabel, detail: "Use this in setup notes and launch review." },
          { id: "web-host", label: shared ? "Copy shared web host" : "Copy web hostname", value: appHost, detail: shared ? "Confirm this shared host is already configured." : "Use this when requesting or checking the web DNS record." },
          { id: "api-host", label: shared ? "Copy shared API host" : "Copy API hostname", value: apiHost, detail: shared ? "Confirm this shared host is already configured." : "Use this when requesting or checking the API DNS record." },
          { id: "tenant-slug", label: "Copy dealer slug", value: setup.slug, detail: "Stable tenant key for shared routing and vendor mapping." }
        ],
        shared
          ? ["Shared hosts verified", "Dealer slug route confirmed", "Provider mapping identified", "Ready to verify app/API routing"]
          : ["DNS record request sent", "Web domain resolves", "API domain resolves", "Ready to verify in Vercel/API"]
      );
    case "vercel":
      return guide(
        "Vercel actions",
        shared
          ? "Open the Vercel project and confirm the shared app host and dealer slug route."
          : "Open the Vercel project and prepare the frontend domain setup without changing DNS automatically.",
        linkFor("vercel", "domains"),
        [
          { id: "vercel-app", label: "Copy app URL", value: setup.appUrl, detail: "Use this for the Vercel domain check." },
          { id: "vercel-api", label: "Copy API URL", value: setup.apiUrl, detail: "Use this when comparing public environment settings." }
        ],
        shared
          ? ["Project opened", "Shared app host reviewed", "Dealer route checked", "Environment values compared"]
          : ["Project opened", "Domain entries reviewed", "Environment values compared", "DNS verification pending or complete"]
      );
    case "twilio":
      return guide(
        "Twilio actions",
        "Open Twilio after the account owner logs in, then prepare number, compliance, and webhook fields.",
        linkFor("twilio"),
        [
          { id: "twilio-webhook", label: "Copy Twilio webhook URL", value: twilioWebhook, detail: "Paste into the inbound messaging webhook after human login/MFA." },
          { id: "twilio-stop", label: "Copy STOP/HELP language", value: "Reply STOP to opt out. Reply HELP for help.", detail: "Use as the baseline compliance wording for review." }
        ],
        ["Phone number selected or porting started", "Webhook field prepared", "A2P/10DLC submitted or waiting", "STOP/HELP/TCPA wording reviewed"]
      );
    case "sendgrid":
      return guide(
        "SendGrid actions",
        "Open sender authentication and inbound parse setup after the account owner logs in.",
        linkFor("sendgrid"),
        [
          { id: "sendgrid-inbound-url", label: "Copy inbound parse URL", value: sendgridInbound, detail: "Paste into SendGrid inbound parse after human login/MFA." },
          { id: "sendgrid-reply-domain", label: "Copy API base URL", value: setup.apiUrl, detail: "Use when validating reply and inbound routing." }
        ],
        ["Sender/domain auth opened", "DNS records requested", "Inbound parse URL prepared", "Ready to verify email routing"]
      );
    case "google":
      return guide(
        "Google actions",
        "Open Google Cloud or Calendar after the account owner logs in, then prepare OAuth and user checks.",
        linkFor("google"),
        [
          { id: "google-callback", label: "Copy OAuth callback URL", value: googleCallback, detail: "Add as an authorized redirect URI after human login/MFA." },
          { id: "google-calendar-note", label: "Copy calendar check note", value: `${setup.dealerName}: verify sales/support calendar access`, detail: "Use as the setup note for calendar access review." }
        ],
        ["OAuth app selected", "Redirect URI prepared", "Support mail/calendar consent complete", "Users/calendar access verified"]
      );
    case "inventory":
      return guide(
        "Inventory actions",
        "Capture the dealer export URL and verify it can be read before launch.",
        linkFor("intake"),
        [
          { id: "inventory-notes", label: "Copy setup notes", value: setup.notes || "", detail: "Use this if the export URL is recorded in dealer notes." }
        ],
        ["Export URL captured", "Authentication needs identified", "Sample feed reviewed", "Refresh cadence confirmed"]
      );
    case "crm":
      return guide(
        "CRM and routing actions",
        "Prepare the ADF and SMS routing endpoints for the dealer CRM or lead vendor.",
        linkFor("sendgrid", "twilio"),
        [
          { id: "crm-adf-endpoint", label: "Copy ADF endpoint", value: sendgridInbound, detail: "Use for ADF/email lead routing setup." },
          { id: "crm-twilio-webhook", label: "Copy SMS webhook URL", value: twilioWebhook, detail: "Use for Twilio inbound message routing." },
          { id: "crm-provider", label: "Copy CRM/source notes", value: setup.crmProvider || "", detail: "Use as the vendor/source mapping reference." }
        ],
        ["Lead source mapping reviewed", "ADF endpoint prepared", "SMS routing prepared", "Test lead path identified"]
      );
    case "profile":
      return guide(
        "Dealer profile actions",
        "Prepare tone, policy, feature flags, and compliance language before config export.",
        [],
        [
          { id: "profile-notes", label: "Copy profile notes", value: setup.notes || "", detail: "Use this as the source for tone/rules/features." },
          { id: "profile-config", label: "Copy dealer config JSON", value: setup.dealerConfig ? JSON.stringify(setup.dealerConfig, null, 2) : "", detail: "Use after config generation for review." }
        ],
        ["Tone/rules captured", "Compliance wording reviewed", "Features selected", "Dealer config generated"]
      );
    case "remote_env":
      return guide(
        "Server settings actions",
        "Prepare the server-only environment values and usage checks without exposing secrets in Command.",
        linkFor("remote_env"),
        [
          { id: "remote-env-template", label: "Copy env template", value: setup.remoteEnvTemplate || "", detail: "Fill secret values only on the server." },
          { id: "remote-env-api", label: "Copy API URL", value: setup.apiUrl, detail: "Use when checking callback and public base URL settings." }
        ],
        ["Required variables listed", "Secret ownership confirmed", "Server paths reviewed", "Usage monitoring link opened"]
      );
    case "api":
      return guide(
        "API runtime actions",
        `Prepare isolated Lightsail runtime paths for this dealer using ${routeLabel.toLowerCase()}.`,
        [],
        [
          { id: "api-profile", label: "Copy API deploy profile", value: deployment?.profileText || "", detail: "Use for review before any server change." },
          { id: "api-routing", label: "Copy routing summary", value: deployment?.routingSummary || routeLabel, detail: "Use for proxy/router review." },
          { id: "api-nginx-preview", label: "Copy nginx preview", value: deployment?.nginxPreview || "", detail: "Human-review route preview only; do not apply automatically." },
          { id: "api-health", label: "Copy health URL", value: deployment?.healthUrl || apiPath(setup, "/health"), detail: "Use for smoke test and rollback verification." }
        ],
        ["Runtime profile generated", "Dealer data path isolated", "PM2 process and port named", "Proxy route reviewed", "Rollback path reviewed"]
      );
    case "manual":
      return guide(
        "Manual actions",
        "Review the generated launch manual and keep it aligned with the setup record.",
        [],
        [
          { id: "manual-url", label: "Copy manual preview URL", value: `/api/dealer-setups/${encodeURIComponent(setup.id)}/manual?format=html`, detail: "Open or share this internal preview for review." }
        ],
        ["Manual previewed", "Deployment steps checked", "Human approval gates confirmed", "Download saved if needed"]
      );
    case "smoke":
      return guide(
        "Smoke test actions",
        "Run public checks against the dealer web and API endpoints before launch approval.",
        linkFor("domains"),
        [
          { id: "smoke-app", label: "Copy app URL", value: setup.appUrl, detail: "Use for public frontend smoke testing." },
          { id: "smoke-health", label: "Copy API health URL", value: apiPath(setup, "/health"), detail: "Use for public API smoke testing." }
        ],
        ["Frontend reachable", "API health reachable", "Dealer config verifies", "No launch blockers found"]
      );
    case "launch_gate":
      return guide(
        "Launch gate actions",
        "Review all vendor approvals, smoke tests, rollback notes, and monitoring before requesting production approval.",
        links,
        [
          { id: "launch-report", label: "Copy launch check report", value: "", detail: "Run launch check first, then copy the report from advanced/debug." }
        ],
        ["Vendor approvals confirmed", "Smoke tests passed", "Rollback path confirmed", "Production approval requested"]
      );
    default:
      return null;
  }
}

export default function NewDealerClientPage() {
  const [form, setForm] = useState(emptyForm);
  const [editForm, setEditForm] = useState<DealerSetupForm>(emptyForm);
  const [setups, setSetups] = useState<DealerSetup[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [notice, setNotice] = useState("Create a dealer setup when you are ready to start onboarding.");
  const [busy, setBusy] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);
  const [vercelBusy, setVercelBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [vercelDomains, setVercelDomains] = useState<VercelDomain[]>([]);
  const [dnsRecords, setDnsRecords] = useState<DnsRecord[]>([]);
  const [apiDeployment, setApiDeployment] = useState<DealerApiDeployment | null>(null);
  const [smokeChecks, setSmokeChecks] = useState<SmokeCheck[]>([]);
  const [stepResult, setStepResult] = useState<StepRunSummary | null>(null);
  const [runtimePackage, setRuntimePackage] = useState<DealerRuntimePackage | null>(null);
  const [runtimePackageVerification, setRuntimePackageVerification] = useState<DealerRuntimePackageVerification | null>(null);
  const [runtimePackageBusy, setRuntimePackageBusy] = useState(false);
  const [launchDryRun, setLaunchDryRun] = useState<DealerLaunchDryRun | null>(null);
  const [launchDryRunBusy, setLaunchDryRunBusy] = useState(false);
  const [setupTaskKind, setSetupTaskKind] = useState<AgentTaskKind>("codex");
  const [activateConfirmOpen, setActivateConfirmOpen] = useState(false);
  const [activateBusy, setActivateBusy] = useState(false);
  const [activationResult, setActivationResult] = useState<DealerActivationResult | null>(null);

  const selected = useMemo(() => setups.find(setup => setup.id === selectedId) ?? setups[0] ?? null, [selectedId, setups]);
  const selectedReadiness = useMemo(() => (selected ? selected.deployReadiness ?? buildFallbackDeployReadiness(selected) : null), [selected]);
  const selectedSteps = useMemo(() => (selected ? mergedSetupSteps(selected.steps) : []), [selected]);
  const completion = useMemo(() => {
    if (!selectedSteps.length) return 0;
    return Math.round((selectedSteps.filter(step => step.status === "done").length / selectedSteps.length) * 100);
  }, [selectedSteps]);
  const currentStep = useMemo(() => {
    if (!selectedSteps.length) return null;
    return (
      selectedSteps.find(step => step.status === "pending" && step.id !== "handoff") ??
      selectedSteps.find(step => step.status === "blocked") ??
      selectedSteps.find(step => step.status === "in_progress") ??
      selectedSteps.find(step => step.status === "waiting_on_dealer") ??
      selectedSteps.find(step => step.status === "ready_to_verify") ??
      selectedSteps.find(step => step.status === "pending") ??
      null
    );
  }, [selectedSteps]);
  const currentApiDeployment = apiDeployment ?? selected?.apiDeployment ?? null;
  const manualBaseHref = selected ? `/api/dealer-setups/${encodeURIComponent(selected.id)}/manual` : "";
  const setupStillNeeded = useMemo(() => {
    if (!selectedReadiness) return [];
    return [...selectedReadiness.blockers, ...(selectedReadiness.goLiveMissing ?? []), ...selectedReadiness.missing]
      .filter((item, index, list) => item && list.indexOf(item) === index)
      .slice(0, 5);
  }, [selectedReadiness]);
  const groupedRemoteEnv = useMemo(() => {
    const groups = new Map<string, DealerRemoteEnvItem[]>();
    for (const item of selected?.remoteEnvChecklist ?? []) {
      const group = groups.get(item.category) ?? [];
      group.push(item);
      groups.set(item.category, group);
    }
    return [...groups.entries()];
  }, [selected?.remoteEnvChecklist]);
  const selectedVendorLinks = useMemo(() => buildVendorWebsiteLinks(selected), [selected]);
  const currentStepGuide = useMemo(
    () => (selected ? buildStepVendorGuide(selected, currentStep, selectedVendorLinks, currentApiDeployment) : null),
    [currentApiDeployment, currentStep, selected, selectedVendorLinks]
  );
  const hasTechnicalDetails = Boolean(currentApiDeployment || groupedRemoteEnv.length || vercelDomains.length || dnsRecords.length || smokeChecks.length || runtimePackage || launchDryRun);
  const cleanLaunchCheck = Boolean(launchDryRun?.canLaunch);

  useEffect(() => {
    setApiDeployment(selected?.apiDeployment ?? null);
    setRuntimePackage(null);
    setRuntimePackageVerification(null);
    setLaunchDryRun(null);
    setActivateConfirmOpen(false);
    setActivationResult(null);
    if (selected) setEditForm(setupToForm(selected));
  }, [selected]);

  useEffect(() => {
    let active = true;
    fetch("/api/dealer-setups?limit=50", { cache: "no-store" })
      .then(resp => resp.json())
      .then(data => {
        if (!active) return;
        if (data?.ok && Array.isArray(data.setups)) {
          setSetups(data.setups);
          const requestedSetup = new URLSearchParams(window.location.search).get("setup") || "";
          setSelectedId(current => current || requestedSetup || data.setups[0]?.id || "");
        }
      })
      .catch(() => {
        if (active) setNotice("Dealer setups could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, []);

  function updateField(field: keyof DealerSetupForm, value: string) {
    setForm(current => ({ ...current, [field]: value }));
  }

  function updateEditField(field: keyof DealerSetupForm, value: string) {
    setEditForm(current => ({ ...current, [field]: value }));
  }

  function updatePlan(value: string) {
    const defaults = planDefaults[value as PlanName];
    setForm(current => ({
      ...current,
      plan: value,
      ...(defaults
        ? {
            setupFee: defaults.setupFee,
            monthlyFee: defaults.monthlyFee,
            includedUsage: defaults.includedUsage,
            overageTerms: defaults.overageTerms
          }
        : {})
    }));
  }

  function updateEditPlan(value: string) {
    const defaults = planDefaults[value as PlanName];
    setEditForm(current => ({
      ...current,
      plan: value,
      ...(defaults && !current.monthlyFee && !current.setupFee
        ? {
            setupFee: defaults.setupFee,
            monthlyFee: defaults.monthlyFee,
            includedUsage: defaults.includedUsage,
            overageTerms: defaults.overageTerms
          }
        : {})
    }));
  }

  async function saveSelectedSetup() {
    if (!selected) return;
    setBusy(true);
    try {
      const resp = await fetch(`/api/dealer-setups/${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editForm)
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Dealer setup could not be saved.");
      setSetups(current => current.map(row => (row.id === data.setup.id ? data.setup : row)));
      setEditForm(setupToForm(data.setup));
      setNotice(`${data.setup.dealerName} setup details saved.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Dealer setup could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function createSetup() {
    setBusy(true);
    try {
      const shouldGenerateAgreement = form.generateAgreement;
      const resp = await fetch("/api/dealer-setups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form)
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Dealer setup could not be created.");
      setSetups(current => [data.setup, ...current.filter(row => row.id !== data.setup.id)]);
      setSelectedId(data.setup.id);
      setForm(emptyForm);
      if (shouldGenerateAgreement) {
        await createAgreementTaskForSetup(data.setup);
        setNotice(`Dealer setup created for ${data.setup.dealerName}, and the agreement draft task was created.`);
      } else {
        setNotice(`Dealer setup created for ${data.setup.dealerName}.`);
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Dealer setup could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function createAgreementTaskForSetup(setup: DealerSetup) {
    const facts = [
      `Dealer: ${setup.dealerName}`,
      `Dealer legal name: ${setup.legalName || "not provided"}`,
      `DBA name: ${setup.dbaName || setup.dealerName || "not provided"}`,
      `Dealer address: ${setup.dealerAddress || "not provided"}`,
      `Primary contact: ${setup.primaryContact || "not provided"}`,
      `Website: ${setup.website || "not provided"}`,
      `Tenant routing: ${routingModeLabel(setup.routingMode)}`,
      `Plan: ${setup.plan || "not provided"}`,
      `Setup fee: ${setup.setupFee || "not provided"}`,
      `Monthly fee: ${setup.monthlyFee || "not provided"}`,
      `Included usage: ${setup.includedUsage || setup.leadVolume || "not provided"}`,
      `Overage terms: ${setup.overageTerms || "not provided"}`,
      `Contract term: ${setup.contractTerm || "not provided"}`,
      `Billing start: ${setup.billingStart || "not provided"}`,
      `Notes: ${setup.notes || "none"}`
    ].join("\n");
    const resp = await fetch("/api/agent-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "claude",
        kind: "agreement",
        priority: "high",
        clientName: setup.dealerName,
        title: `Draft ${setup.dealerName} agreement`,
        instructions: [
          "Draft a dealer agreement packet using only the structured facts below for business terms.",
          "Do not invent pricing, usage, contract dates, legal names, signer details, or overage terms that are not provided.",
          "Flag missing fields clearly for human review. Do not send the agreement.",
          "",
          facts
        ].join("\n")
      })
    });
    const data = await resp.json();
    if (!resp.ok || !data?.ok) throw new Error(data?.error || "Agreement task could not be created.");
    return data.task;
  }

  async function updateStep(stepId: string, stepStatus: DealerSetupStepStatus) {
    if (!selected) return;
    setBusy(true);
    try {
      const resp = await fetch(`/api/dealer-setups/${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stepId, stepStatus, status: "in_progress" })
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Setup step could not be updated.");
      setSetups(current => current.map(row => (row.id === data.setup.id ? data.setup : row)));
      setNotice(`${data.setup.dealerName} setup updated.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Setup step could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  function guidedStepButtonLabel(step: DealerSetupStep) {
    if (canMarkStepComplete(step)) return `Mark ${step.label} complete`;
    if (step.status === "blocked") return `Retry ${step.label}`;
    switch (step.id) {
      case "intake":
        return "Mark intake complete";
      case "vercel":
        return "Prepare website";
      case "domains":
        return "Prepare routing";
      case "api":
        return "Prepare API server";
      case "remote_env":
        return "Prepare server settings";
      case "google":
        return "Start Google setup";
      case "sendgrid":
        return "Start SendGrid setup";
      case "twilio":
        return "Start texting setup";
      case "inventory":
        return "Prepare inventory";
      case "crm":
        return "Prepare routing";
      case "profile":
        return "Generate config";
      case "manual":
        return "Review manual";
      case "smoke":
        return "Run smoke test";
      case "launch_gate":
        return "Review launch gate";
      case "handoff":
        return "Launch and monitor";
      default:
        return "Start step";
    }
  }

  async function runGuidedStep() {
    if (!selected || !currentStep) return;
    setActionBusy(true);
    setStepResult(null);
    try {
      const resp = await fetch(`/api/dealer-setups/${encodeURIComponent(selected.id)}/run-step`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stepId: currentStep.id,
          action: canMarkStepComplete(currentStep) ? "complete" : "run"
        })
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Setup step could not be run.");
      if (data.setup) setSetups(current => current.map(row => (row.id === data.setup.id ? data.setup : row)));
      if (Array.isArray(data.domains)) setVercelDomains(data.domains);
      if (Array.isArray(data.records)) setDnsRecords(data.records);
      if (data.deployment) setApiDeployment(data.deployment);
      if (Array.isArray(data.checks)) setSmokeChecks(data.checks);
      const result = {
        message: String(data.message || "Setup step updated."),
        nextStep: typeof data.nextStep === "string" ? data.nextStep : undefined,
        task: data.task,
        blocked: false
      };
      setStepResult(result);
      setNotice(result.message);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Setup step could not be run.";
      setStepResult({ message, blocked: true });
      setNotice(message);
    } finally {
      setActionBusy(false);
    }
  }

  async function createSetupTask(kind: AgentTaskKind) {
    if (!selected) return;
    setTaskBusy(true);
    const instructions =
      kind === "agreement"
        ? [
            "Draft a dealer agreement packet using only the structured facts below for business terms.",
            "Do not invent pricing, usage, contract dates, legal names, signer details, or overage terms that are not provided.",
            "Flag missing fields clearly for human review. Do not send the agreement.",
            "",
            `Dealer: ${selected.dealerName}`,
            `Dealer legal name: ${selected.legalName || "not provided"}`,
            `DBA name: ${selected.dbaName || selected.dealerName || "not provided"}`,
            `Dealer address: ${selected.dealerAddress || "not provided"}`,
            `Primary contact: ${selected.primaryContact || "not provided"}`,
            `Website: ${selected.website || "not provided"}`,
            `Plan: ${selected.plan || "not provided"}`,
            `Setup fee: ${selected.setupFee || "not provided"}`,
            `Monthly fee: ${selected.monthlyFee || "not provided"}`,
            `Included usage: ${selected.includedUsage || selected.leadVolume || "not provided"}`,
            `Overage terms: ${selected.overageTerms || "not provided"}`,
            `Contract term: ${selected.contractTerm || "not provided"}`,
            `Billing start: ${selected.billingStart || "not provided"}`,
            `Notes: ${selected.notes || "none"}`
          ].join("\n")
        : kind === "api"
          ? [
	              `Create the API dealer setup work for ${selected.dealerName}.`,
	              `Tenant routing: ${routingModeLabel(selected.routingMode)}.`,
	              `Use app URL ${selected.appUrl} and API URL ${selected.apiUrl}.`,
              `Use the clean multi-client API pattern: repo path ${selected.apiDeployment?.repoPath || apiDeployment?.repoPath || `/home/ubuntu/leadrider-api/${selected.slug}`}, env file ${selected.apiDeployment?.envFile || apiDeployment?.envFile || `/home/ubuntu/leadrider-runtime/${selected.slug}/api.env`}, data dir ${selected.apiDeployment?.dataDir || apiDeployment?.dataDir || `/home/ubuntu/leadrider-runtime/${selected.slug}/data`}, PM2 process ${selected.apiDeployment?.pm2Process || apiDeployment?.pm2Process || `leadrider-api-${selected.slug}`}, local port ${selected.apiDeployment?.localPort || apiDeployment?.localPort || "from the generated deploy profile"}, proxy path ${selected.apiDeployment?.proxyPathPrefix || apiDeployment?.proxyPathPrefix || "from the generated deploy profile"}, and proxy target ${selected.apiDeployment?.proxyTarget || apiDeployment?.proxyTarget || "from the generated deploy profile"}.`,
              `Deploy profile: ${selected.apiDeployment?.deployProfileLocalPath || apiDeployment?.deployProfileLocalPath || `infra/deploy/${selected.slug}.api.env`}.`,
	              "Prepare dealer profile/config, routing defaults, owner/calendar placeholders, tenant route/callback settings, env requirements, and deploy/smoke-test steps.",
              "Do not overwrite existing clients or shared American Harley paths."
            ].join("\n")
        : kind === "providers"
          ? `Create provider setup tasks for ${selected.dealerName}. Cover Google Workspace/Gmail/calendar, Twilio messaging/phone, SendGrid sender/domain, Sentry, Linear, Slack, OpenAI usage logging, and Meta only if that feature is enabled. Separate steps that Codex can do from steps needing human login, billing, OAuth consent, phone verification, or credentials.`
        : kind === "texting"
          ? `Create the texting setup plan for ${selected.dealerName}. Cover Twilio number selection or porting, A2P/10DLC brand/campaign registration, opt-in and STOP/HELP compliance language, inbound/outbound routing, salesperson ownership, support escalation, campaign safeguards, and smoke tests. Separate what Codex can prepare from anything requiring human login, billing, consent, carrier verification, or credentials.`
	        : kind === "stack"
	          ? `Create the full tech-stack setup plan for ${selected.dealerName}. Tenant routing is ${routingModeLabel(selected.routingMode)}. Include Vercel app routing/domains, DNS records only if needed, API dealer profile/config, Google Workspace/Gmail/calendar, Twilio phone/messaging, SendGrid sender/domain, OpenAI usage logging, optional Meta app/callback if enabled, Sentry, Linear, Slack alerts, smoke tests, and handoff steps. Identify which steps can be automated now and which require human login, billing, verification, OAuth consent, or credentials.`
	        : kind === "vercel"
	          ? `Prepare Vercel deployment steps for ${selected.dealerName}. Tenant routing is ${routingModeLabel(selected.routingMode)}. Target app URL: ${selected.appUrl}. Target API URL: ${selected.apiUrl}. List required Vercel project/domain/env changes and DNS records only if needed. Do not make external changes without approval.`
          : `Run dealer setup review for ${selected.dealerName}. Check onboarding blockers across Vercel, DNS, API dealer config, Google, Twilio, SendGrid, optional Meta only if enabled, agreement, and smoke testing. Return the next action list.`;
    try {
      const resp = await fetch("/api/agent-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: kind === "agreement" ? "claude" : "codex",
          kind: kind === "agreement" ? "agreement" : "dealer_setup",
          priority: "high",
          clientName: selected.dealerName,
          title:
            kind === "agreement"
              ? `Draft ${selected.dealerName} agreement`
              : kind === "api"
                ? `Create ${selected.dealerName} API config task`
              : kind === "texting"
                ? `Plan ${selected.dealerName} texting setup`
              : kind === "providers"
                ? `Create ${selected.dealerName} provider setup tasks`
              : kind === "stack"
                ? `Build ${selected.dealerName} tech-stack setup plan`
              : kind === "vercel"
                ? `Prepare ${selected.dealerName} Vercel setup`
                : `Run ${selected.dealerName} setup review`,
          instructions
        })
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Agent task could not be created.");
      setNotice(`Agent task created: ${data.task.title}.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Agent task could not be created.");
    } finally {
      setTaskBusy(false);
    }
  }

  async function generateDnsChecklist() {
    if (!selected) return;
    setActionBusy(true);
    try {
      const resp = await fetch(`/api/dealer-setups/${encodeURIComponent(selected.id)}/dns/checklist`, { method: "POST" });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "DNS checklist could not be generated.");
      setDnsRecords(Array.isArray(data.records) ? data.records : []);
      if (data.setup) setSetups(current => current.map(row => (row.id === data.setup.id ? data.setup : row)));
      setNotice(isSharedRouting(selected) ? "Tenant routing checklist generated for the shared app/API hosts." : "DNS checklist generated for the dealer app and API domains.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "DNS checklist could not be generated.");
    } finally {
      setActionBusy(false);
    }
  }

  async function generateApiDeployProfile() {
    if (!selected) return;
    setActionBusy(true);
    try {
      const resp = await fetch(`/api/dealer-setups/${encodeURIComponent(selected.id)}/api/deploy-profile`, { method: "POST" });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "API deploy profile could not be generated.");
      if (data.deployment) setApiDeployment(data.deployment);
      if (data.setup) setSetups(current => current.map(row => (row.id === data.setup.id ? data.setup : row)));
      setNotice("API deploy profile generated with the clean checkout, env, data, PM2, and health-check paths.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "API deploy profile could not be generated.");
    } finally {
      setActionBusy(false);
    }
  }

  async function copyApiDeployProfile() {
    if (!currentApiDeployment?.profileText) return;
    try {
      await navigator.clipboard.writeText(currentApiDeployment.profileText);
      setNotice("API deploy profile copied.");
    } catch {
      setNotice("Could not copy the API deploy profile from this browser.");
    }
  }

  async function copyRemoteEnvTemplate() {
    if (!selected?.remoteEnvTemplate) return;
    try {
      await navigator.clipboard.writeText(selected.remoteEnvTemplate);
      setNotice("Server settings template copied. Fill secret values only on the server.");
    } catch {
      setNotice("Could not copy the server settings template from this browser.");
    }
  }

  async function copyDealerConfig() {
    if (!selected?.dealerConfig) return;
    try {
      await navigator.clipboard.writeText(`${JSON.stringify(selected.dealerConfig, null, 2)}\n`);
      setNotice("Dealer config JSON copied.");
    } catch {
      setNotice("Could not copy the dealer config from this browser.");
    }
  }

  async function copySetupValue(label: string, value: string) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value.endsWith("\n") ? value : `${value}\n`);
      setNotice(`${label} copied.`);
    } catch {
      setNotice(`Could not copy ${label.toLowerCase()} from this browser.`);
    }
  }

  async function generateRuntimePackage() {
    if (!selected) return;
    setRuntimePackageBusy(true);
    try {
      const resp = await fetch(`/api/dealer-setups/${encodeURIComponent(selected.id)}/runtime-package`, { method: "POST" });
      const data = await resp.json();
      if (!resp.ok || !data?.package) throw new Error(data?.error || "Launch packet could not be generated.");
      setRuntimePackage(data.package);
      setRuntimePackageVerification(data.verification ?? null);
      const failures = Array.isArray(data.verification?.failures) ? data.verification.failures.length : 0;
      const warnings = Array.isArray(data.verification?.warnings) ? data.verification.warnings.length : 0;
      setNotice(failures ? "Launch packet generated, but verification found blockers." : warnings ? "Launch packet generated for review. It is not a launch approval yet." : "Launch packet generated and verified.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Launch packet could not be generated.");
    } finally {
      setRuntimePackageBusy(false);
    }
  }

  async function copyRuntimeManifest() {
    if (!runtimePackage?.manifest) return;
    try {
      await navigator.clipboard.writeText(`${JSON.stringify(runtimePackage.manifest, null, 2)}\n`);
      setNotice("Launch packet manifest copied.");
    } catch {
      setNotice("Could not copy the launch packet manifest from this browser.");
    }
  }

  function downloadRuntimePackage() {
    if (!runtimePackage) return;
    const filename = `${runtimePackage.slug || selected?.slug || "dealer"}-runtime-config-package.json`;
    const blob = new Blob([`${JSON.stringify(runtimePackage, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setNotice("Launch packet downloaded as JSON.");
  }

  async function runLaunchDryRun() {
    if (!selected) return;
    setLaunchDryRunBusy(true);
    try {
      const resp = await fetch(`/api/dealer-setups/${encodeURIComponent(selected.id)}/launch-dry-run`, { method: "POST" });
      const data = await resp.json();
      if (!resp.ok || !data?.dryRun) throw new Error(data?.error || "Launch check could not be completed.");
      setLaunchDryRun(data.dryRun);
      setNotice(data.dryRun.canLaunch ? "Launch check is clear. Production launch still needs explicit approval." : data.dryRun.summary);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Launch check could not be completed.");
    } finally {
      setLaunchDryRunBusy(false);
    }
  }

  async function copyLaunchDryRun() {
    if (!launchDryRun) return;
    try {
      await navigator.clipboard.writeText(`${JSON.stringify(launchDryRun, null, 2)}\n`);
      setNotice("Launch check report copied.");
    } catch {
      setNotice("Could not copy the launch check report from this browser.");
    }
  }

  async function runSmokeTest(): Promise<boolean> {
    if (!selected) return false;
    setActionBusy(true);
    try {
      const resp = await fetch(`/api/dealer-setups/${encodeURIComponent(selected.id)}/smoke-test`, { method: "POST" });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Smoke test could not be run.");
      setSmokeChecks(Array.isArray(data.checks) ? data.checks : []);
      if (data.setup) setSetups(current => current.map(row => (row.id === data.setup.id ? data.setup : row)));
      setNotice(data.passed ? "Launch smoke test passed." : "Launch smoke test found a blocker.");
      return Boolean(data.passed);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Smoke test could not be run.");
      return false;
    } finally {
      setActionBusy(false);
    }
  }

  async function activateDealer() {
    if (!selected) return;
    if (!cleanLaunchCheck) {
      setNotice("Run a clean launch check before activating this dealer.");
      return;
    }
    setActivateBusy(true);
    setActivationResult(null);
    try {
      const resp = await fetch(`/api/dealer-setups/${encodeURIComponent(selected.id)}/activate`, { method: "POST" });
      const data = await resp.json();
      if (Array.isArray(data?.checks)) setSmokeChecks(data.checks);
      if (data?.dryRun) setLaunchDryRun(data.dryRun);
      if (data?.setup) setSetups(current => current.map(row => (row.id === data.setup.id ? data.setup : row)));
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Dealer could not be activated.");
      setActivationResult(data);
      setActivateConfirmOpen(false);
      setNotice(data.message || `${data.client?.dealerName || selected.dealerName} activated.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Dealer could not be activated.");
    } finally {
      setActivateBusy(false);
    }
  }

  async function checkVercelDomains() {
    if (!selected) return;
    setVercelBusy(true);
    try {
      const resp = await fetch(`/api/dealer-setups/${encodeURIComponent(selected.id)}/vercel`, { cache: "no-store" });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Vercel status could not be checked.");
      setVercelDomains(Array.isArray(data.domains) ? data.domains : []);
      setNotice(data.configured ? "Vercel status checked." : "Vercel token is not configured yet. Add VERCEL_API_TOKEN on the API server to automate domains.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Vercel status could not be checked.");
    } finally {
      setVercelBusy(false);
    }
  }

  async function addVercelDomains() {
    if (!selected) return;
    setVercelBusy(true);
    try {
      const resp = await fetch(`/api/dealer-setups/${encodeURIComponent(selected.id)}/vercel/domains`, { method: "POST" });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Vercel domains could not be added.");
      setVercelDomains(Array.isArray(data.domains) ? data.domains : []);
      if (data.setup) setSetups(current => current.map(row => (row.id === data.setup.id ? data.setup : row)));
      setNotice(isSharedRouting(selected) ? "Shared Vercel host confirmed for dealer routing review." : "Vercel domains added or confirmed. DNS may still need to be pointed and verified.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Vercel domains could not be added.");
    } finally {
      setVercelBusy(false);
    }
  }

  return (
    <main className="lr-ceo-shell">
      <aside className="lr-ceo-sidebar">
        <div className="lr-ceo-brand">
          <div className="lr-ceo-mark">LR</div>
          <div>
            <p className="lr-ceo-kicker">LeadRider</p>
            <h1>Command</h1>
          </div>
        </div>
        <nav className="lr-ceo-nav" aria-label="LeadRider command sections">
          <a href="/command">Command Home</a>
          <a href="/command/sales">Sales Funnel</a>
          <a href="/command/support">Support Agent</a>
          <a href="/command/approvals">Approvals</a>
          <a href="/command/personal-email">Personal Email</a>
          <a href="/command/clients">Active Clients</a>
          <a href="/command/clients/new" className="is-active">Dealer Setup</a>
          <a href="/command/users">Users</a>
          <span className="lr-ceo-nav-disabled">Agreements <small>Coming soon</small></span>
          <span className="lr-ceo-nav-disabled">Billing <small>Coming soon</small></span>
          <span className="lr-ceo-nav-disabled">Connectors <small>Coming soon</small></span>
        </nav>
        <section className="lr-ceo-side-panel">
          <p className="lr-ceo-kicker">Dealer setup</p>
          <strong>{setups.length} setup records</strong>
          <span>{selected ? `${completion}% complete for ${selected.dealerName}` : "No dealer selected"}</span>
        </section>
      </aside>

      <section className="lr-ceo-main">
        <header className="lr-ceo-header">
          <div>
            <p className="lr-ceo-kicker">Client onboarding</p>
            <h2>Dealer Setup</h2>
            <p>Move a won Sales Funnel prospect through one launch checklist, then hand it off to Active Clients.</p>
          </div>
        </header>

        <section className="lr-ceo-notice" aria-live="polite">{notice}</section>

        {selected && currentStep ? (
          <section className="lr-ceo-guided-setup">
            <div>
              <p className="lr-ceo-kicker">Guided setup</p>
              <h3>{currentStep.status === "blocked" ? "Blocked step" : "Next step"}: {currentStep.label}</h3>
              <p>{guidedStepDescription(currentStep.id)}</p>
            </div>
            <div className="lr-ceo-guided-actions">
              <span className={`lr-ceo-status-pill ${statusClass(currentStep.status)}`}>{statusLabel(currentStep.status)}</span>
              <button type="button" onClick={runGuidedStep} disabled={busy || taskBusy || actionBusy || vercelBusy || activateBusy}>
                {guidedStepButtonLabel(currentStep)}
              </button>
              <button type="button" className="lr-ceo-secondary-btn" onClick={() => updateStep(currentStep.id, "waiting_on_dealer")} disabled={busy}>
                Waiting on dealer
              </button>
              <button type="button" className="lr-ceo-secondary-btn" onClick={() => updateStep(currentStep.id, "ready_to_verify")} disabled={busy}>
                Ready to verify
              </button>
              <button type="button" className="lr-ceo-secondary-btn" onClick={() => updateStep(currentStep.id, "blocked")} disabled={busy}>
                Mark blocked
              </button>
            </div>
          </section>
        ) : selected ? (
          <section className="lr-ceo-guided-setup">
            <div>
              <p className="lr-ceo-kicker">Guided setup</p>
              <h3>Setup checklist complete</h3>
              <p>All setup steps are marked complete for this dealer.</p>
            </div>
          </section>
        ) : null}

        {selected && currentStep && currentStepGuide ? (
          <section className="lr-ceo-step-guide-card">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Current step actions</p>
                <h3>{currentStepGuide.title}</h3>
                <p>{currentStepGuide.summary}</p>
              </div>
              <span className={`lr-ceo-status-pill ${statusClass(currentStep.status)}`}>{statusLabel(currentStep.status)}</span>
            </div>
            <div className="lr-ceo-step-guide-actions">
              {currentStepGuide.links.map(link => (
                <a key={link.id} className="lr-ceo-step-action" href={link.href} target="_blank" rel="noreferrer">
                  <strong>{link.label}</strong>
                  <span>{link.detail}</span>
                </a>
              ))}
              {currentStepGuide.copyValues.map(item => (
                <button key={item.id} type="button" className="lr-ceo-step-action" onClick={() => copySetupValue(item.label, item.value)}>
                  <strong>{item.label}</strong>
                  <span>{item.detail}</span>
                </button>
              ))}
	              {currentStep.id === "domains" ? (
	                <>
	                  <button type="button" className="lr-ceo-step-action" onClick={generateDnsChecklist} disabled={actionBusy}>
	                    <strong>{isSharedRouting(selected) ? "Generate routing checklist" : "Generate DNS checklist"}</strong>
	                    <span>{isSharedRouting(selected) ? "Create the shared host and tenant mapping checklist." : "Create the records to send to the DNS owner."}</span>
	                  </button>
	                  <button type="button" className="lr-ceo-step-action" onClick={checkVercelDomains} disabled={vercelBusy}>
	                    <strong>{isSharedRouting(selected) ? "Check shared host" : "Check Vercel domains"}</strong>
	                    <span>{isSharedRouting(selected) ? "Verify whether the shared app host is visible." : "Verify whether the app domains are added and visible."}</span>
	                  </button>
	                </>
	              ) : null}
              {currentStep.id === "vercel" ? (
                <>
	                  <button type="button" className="lr-ceo-step-action" onClick={checkVercelDomains} disabled={vercelBusy}>
	                    <strong>{isSharedRouting(selected) ? "Check shared app host" : "Check domains"}</strong>
	                    <span>{isSharedRouting(selected) ? "Read current Vercel status for the shared app host." : "Read current Vercel domain status."}</span>
	                  </button>
	                  <button type="button" className="lr-ceo-step-action" onClick={addVercelDomains} disabled={vercelBusy}>
	                    <strong>{isSharedRouting(selected) ? "Confirm shared host" : "Add Vercel domains"}</strong>
	                    <span>{isSharedRouting(selected) ? "Explicitly confirm the shared host in Vercel." : "Explicitly add or confirm domains in Vercel."}</span>
	                  </button>
                </>
              ) : null}
              {currentStep.id === "api" ? (
                <>
                  <button type="button" className="lr-ceo-step-action" onClick={generateApiDeployProfile} disabled={actionBusy}>
                    <strong>API deploy profile</strong>
                    <span>Generate isolated Lightsail paths for review.</span>
                  </button>
                  <button type="button" className="lr-ceo-step-action" onClick={generateRuntimePackage} disabled={runtimePackageBusy}>
                    <strong>Launch packet</strong>
                    <span>Build the dealer runtime files for verification.</span>
                  </button>
                </>
              ) : null}
              {currentStep.id === "remote_env" ? (
                <>
                  <button type="button" className="lr-ceo-step-action" onClick={copyRemoteEnvTemplate} disabled={!selected.remoteEnvTemplate}>
                    <strong>Copy env template</strong>
                    <span>Copy server settings without secret values.</span>
                  </button>
                  <button type="button" className="lr-ceo-step-action" onClick={() => createSetupTask("stack")} disabled={taskBusy}>
                    <strong>Create stack task</strong>
                    <span>Hand off remaining server and vendor settings.</span>
                  </button>
                </>
              ) : null}
              {currentStep.id === "twilio" ? (
                <button type="button" className="lr-ceo-step-action" onClick={() => createSetupTask("texting")} disabled={taskBusy}>
                  <strong>Create texting task</strong>
                  <span>Prepare Twilio and compliance work for Codex review.</span>
                </button>
              ) : null}
              {["sendgrid", "google", "inventory", "crm"].includes(currentStep.id) ? (
                <button type="button" className="lr-ceo-step-action" onClick={() => createSetupTask("providers")} disabled={taskBusy}>
                  <strong>Create provider task</strong>
                  <span>Hand off vendor checklist prep without final submissions.</span>
                </button>
              ) : null}
              {currentStep.id === "manual" ? (
                <>
                  <a className="lr-ceo-step-action" href={`${manualBaseHref}?format=html`} target="_blank" rel="noreferrer">
                    <strong>Preview manual</strong>
                    <span>Open the printable deployment manual.</span>
                  </a>
                  <a className="lr-ceo-step-action" href={`${manualBaseHref}?format=markdown&download=1`}>
                    <strong>Download manual</strong>
                    <span>Save a markdown copy for launch review.</span>
                  </a>
                </>
              ) : null}
              {currentStep.id === "smoke" ? (
                <button type="button" className="lr-ceo-step-action" onClick={runSmokeTest} disabled={actionBusy}>
                  <strong>Run smoke test</strong>
                  <span>Check public app and API endpoints.</span>
                </button>
              ) : null}
              {currentStep.id === "launch_gate" ? (
                <>
                  <button type="button" className="lr-ceo-step-action" onClick={runLaunchDryRun} disabled={launchDryRunBusy}>
                    <strong>Run launch check</strong>
                    <span>Review blockers before production approval.</span>
                  </button>
                  {launchDryRun ? (
                    <button type="button" className="lr-ceo-step-action" onClick={copyLaunchDryRun}>
                      <strong>Copy launch report</strong>
                      <span>Copy the latest launch check details.</span>
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
            <div className="lr-ceo-step-guide-milestones">
              {currentStepGuide.milestones.map(item => <span key={item}>{item}</span>)}
            </div>
            <p className="lr-ceo-step-guide-approval">{currentStepGuide.approvalNote}</p>
          </section>
        ) : null}

        {stepResult ? (
          <section className={`lr-ceo-step-result ${stepResult.blocked ? "is-blocked" : "is-ready"}`}>
            <strong>{stepResult.message}</strong>
            {stepResult.nextStep ? <span>{stepResult.nextStep}</span> : null}
            {stepResult.task ? <small>Task: {stepResult.task.title}</small> : null}
          </section>
        ) : null}

        <section className={`lr-ceo-grid ${selected ? "lr-ceo-grid-single" : ""}`}>
          {!selected ? (
          <article className="lr-ceo-panel">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Create setup</p>
                <h3>Dealer intake</h3>
              </div>
            </div>
            <div className="lr-ceo-form-stack">
              <label>
                Dealer name
                <input value={form.dealerName} onChange={event => updateField("dealerName", event.target.value)} placeholder="American Harley-Davidson" />
	              </label>
	              <label>
	                Dealer slug
	                <input value={form.slug} onChange={event => updateField("slug", event.target.value)} placeholder="americanharley" />
	                <span className="lr-ceo-field-note">Stable tenant ID used for routing, reporting, config, and smoke tests.</span>
	              </label>
	              <label>
	                Tenant routing
	                <select value={form.routingMode} onChange={event => updateField("routingMode", event.target.value as DealerRoutingMode)}>
	                  <option value="path">Shared app/API paths</option>
	                  <option value="integration_mapping">Shared provider mapping (future router)</option>
	                  <option value="subdomain">Separate dealer subdomains</option>
	                </select>
	                <span className="lr-ceo-field-note">{routingModeDescription(form.routingMode)}</span>
	              </label>
              <label>
                Owner
                <input value={form.owner} onChange={event => updateField("owner", event.target.value)} />
              </label>
              <label>
                Primary contact
                <input value={form.primaryContact} onChange={event => updateField("primaryContact", event.target.value)} placeholder="Name, email, phone" />
              </label>
              <label>
                Dealer legal name
                <input value={form.legalName} onChange={event => updateField("legalName", event.target.value)} placeholder="Legal entity name" />
              </label>
              <label>
                DBA name
                <input value={form.dbaName} onChange={event => updateField("dbaName", event.target.value)} placeholder="American Harley-Davidson" />
              </label>
              <label>
                Dealer address
                <textarea value={form.dealerAddress} onChange={event => updateField("dealerAddress", event.target.value)} placeholder="Street, city, state, ZIP" />
              </label>
              <label>
                Dealer website
                <input value={form.website} onChange={event => updateField("website", event.target.value)} placeholder="https://..." />
              </label>
              <label>
                CRM / lead source
                <input value={form.crmProvider} onChange={event => updateField("crmProvider", event.target.value)} placeholder="Traffic Log Pro, ADF, ..." />
              </label>
              <label>
                Lead volume
                <input value={form.leadVolume} onChange={event => updateField("leadVolume", event.target.value)} placeholder="300 leads/month" />
              </label>
              <label>
                Plan
                <select value={form.plan} onChange={event => updatePlan(event.target.value)}>
                  <option>Starter</option>
                  <option>Growth</option>
                  <option>Pro</option>
                  <option>Enterprise</option>
                </select>
                <span className="lr-ceo-field-note">Plan fills pricing and usage defaults. You can edit any field below.</span>
              </label>
              <label>
                Setup fee
                <input value={form.setupFee} onChange={event => updateField("setupFee", event.target.value)} placeholder="$2,500" />
              </label>
              <label>
                Monthly fee
                <input value={form.monthlyFee} onChange={event => updateField("monthlyFee", event.target.value)} placeholder="$1,500/month" />
              </label>
              <label>
                Included usage
                <input value={form.includedUsage} onChange={event => updateField("includedUsage", event.target.value)} placeholder="Up to 500 leads/month, standard SMS/email usage" />
              </label>
              <label>
                Overage terms
                <input value={form.overageTerms} onChange={event => updateField("overageTerms", event.target.value)} placeholder="Usage above included tier billed at..." />
              </label>
              <label>
                Contract term
                <input value={form.contractTerm} onChange={event => updateField("contractTerm", event.target.value)} placeholder="12 months" />
              </label>
              <label>
                Billing start
                <input value={form.billingStart} onChange={event => updateField("billingStart", event.target.value)} placeholder="On launch / June 1, 2026" />
              </label>
              <label className="lr-ceo-checkbox-row">
                <input
                  type="checkbox"
                  checked={form.generateAgreement}
                  onChange={event => setForm(current => ({ ...current, generateAgreement: event.target.checked }))}
                />
                Create agreement draft task on create
              </label>
              <label>
                Setup notes
                <textarea value={form.notes} onChange={event => updateField("notes", event.target.value)} placeholder={"Inventory/export URL:\nTone and rules:\nRouting or owner notes:\nKnown blockers:"} />
              </label>
              <button type="button" onClick={createSetup} disabled={busy || !form.dealerName.trim()}>
                Create dealer setup
              </button>
            </div>
          </article>
          ) : null}

          <article className="lr-ceo-panel lr-ceo-panel-wide">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Setup checklist</p>
                <h3>{selected ? selected.dealerName : "No dealer selected"}</h3>
              </div>
              <select value={selected?.id || ""} onChange={event => setSelectedId(event.target.value)}>
                {setups.length ? setups.map(setup => <option key={setup.id} value={setup.id}>{setup.dealerName}</option>) : <option value="">No setups</option>}
              </select>
            </div>

            {selected ? (
              <>
                <section className="lr-ceo-manual-card">
                  <div>
                    <p className="lr-ceo-kicker">Deployment manual</p>
                    <h3>{selected.dealerName} runbook</h3>
                    <p>This manual is generated from the setup record. Preview or download it here, then mark the manual step complete after review.</p>
                  </div>
                  <div>
                    <a className="lr-ceo-secondary-btn" href={`${manualBaseHref}?format=html`} target="_blank" rel="noreferrer">
                      Preview / print
                    </a>
                    <a className="lr-ceo-secondary-btn" href={`${manualBaseHref}?format=markdown&download=1`}>
                      Download
                    </a>
                  </div>
                </section>
                <section className="lr-ceo-edit-card">
                  <div className="lr-ceo-panel-title">
                    <div>
                      <p className="lr-ceo-kicker">Dealer record</p>
                      <h3>Setup details</h3>
                    </div>
                    <button type="button" onClick={saveSelectedSetup} disabled={busy}>
                      Save details
                    </button>
                  </div>
                  <div className="lr-ceo-form-stack">
                    <label>
                      Dealer name
                      <input value={editForm.dealerName} onChange={event => updateEditField("dealerName", event.target.value)} />
	                    </label>
	                    <label>
	                      Dealer slug
	                      <input value={editForm.slug} disabled />
	                      <span className="lr-ceo-field-note">Create a new setup if the slug needs to change.</span>
	                    </label>
	                    <label>
	                      Tenant routing
	                      <select value={editForm.routingMode} onChange={event => updateEditField("routingMode", event.target.value as DealerRoutingMode)}>
	                        <option value="path">Shared app/API paths</option>
	                        <option value="integration_mapping">Shared provider mapping (future router)</option>
	                        <option value="subdomain">Separate dealer subdomains</option>
	                      </select>
	                      <span className="lr-ceo-field-note">{routingModeDescription(editForm.routingMode)}</span>
	                    </label>
                    <label>
                      Owner
                      <input value={editForm.owner} onChange={event => updateEditField("owner", event.target.value)} />
                    </label>
                    <label>
                      Primary contact
                      <input value={editForm.primaryContact} onChange={event => updateEditField("primaryContact", event.target.value)} placeholder="Name, email, phone" />
                    </label>
                    <label>
                      Legal name
                      <input value={editForm.legalName} onChange={event => updateEditField("legalName", event.target.value)} />
                    </label>
                    <label>
                      DBA name
                      <input value={editForm.dbaName} onChange={event => updateEditField("dbaName", event.target.value)} />
                    </label>
                    <label>
                      Dealer address
                      <textarea value={editForm.dealerAddress} onChange={event => updateEditField("dealerAddress", event.target.value)} />
                    </label>
                    <label>
                      Dealer website
                      <input value={editForm.website} onChange={event => updateEditField("website", event.target.value)} placeholder="https://..." />
                    </label>
                    <label>
                      CRM / source mappings
                      <input value={editForm.crmProvider} onChange={event => updateEditField("crmProvider", event.target.value)} placeholder="Traffic Log Pro, ADF, website form..." />
                    </label>
                    <label>
                      Lead volume
                      <input value={editForm.leadVolume} onChange={event => updateEditField("leadVolume", event.target.value)} />
                    </label>
                    <label>
                      Plan
                      <select value={editForm.plan} onChange={event => updateEditPlan(event.target.value)}>
                        <option>Starter</option>
                        <option>Growth</option>
                        <option>Pro</option>
                        <option>Enterprise</option>
                      </select>
                    </label>
                    <label>
                      Setup fee
                      <input value={editForm.setupFee} onChange={event => updateEditField("setupFee", event.target.value)} />
                    </label>
                    <label>
                      Monthly fee
                      <input value={editForm.monthlyFee} onChange={event => updateEditField("monthlyFee", event.target.value)} />
                    </label>
                    <label>
                      Included usage
                      <input value={editForm.includedUsage} onChange={event => updateEditField("includedUsage", event.target.value)} />
                    </label>
                    <label>
                      Overage terms
                      <input value={editForm.overageTerms} onChange={event => updateEditField("overageTerms", event.target.value)} />
                    </label>
                    <label>
                      Contract term
                      <input value={editForm.contractTerm} onChange={event => updateEditField("contractTerm", event.target.value)} />
                    </label>
                    <label>
                      Billing start
                      <input value={editForm.billingStart} onChange={event => updateEditField("billingStart", event.target.value)} />
                    </label>
                    <label>
                      Dealer profile notes
                      <textarea value={editForm.notes} onChange={event => updateEditField("notes", event.target.value)} placeholder={"Inventory/export URL: https://...\nTone: warm, direct, sales-helpful\nRules: no price guessing; manager verifies availability"} />
                    </label>
                  </div>
                </section>
                <div className="lr-ceo-progress">
                  <span style={{ width: `${completion}%` }} />
                </div>
	                <dl className="lr-ceo-facts">
	                  <div><dt>Routing</dt><dd>{routingModeLabel(selected.routingMode)}</dd></div>
	                  <div><dt>App URL</dt><dd>{selected.appUrl}</dd></div>
                  <div><dt>API URL</dt><dd>{selected.apiUrl}</dd></div>
                  <div><dt>Command</dt><dd>{selected.commandUrl}</dd></div>
                  <div><dt>Updated</dt><dd>{formatTime(selected.updatedAt)}</dd></div>
                </dl>
                {selectedReadiness ? (
                  <section className={`lr-ceo-readiness-card ${readinessClass(selectedReadiness.status)}`}>
                    <div>
                      <p className="lr-ceo-kicker">Launch readiness</p>
                      <h3>{selectedReadiness.label}</h3>
                      <p>{selectedReadiness.summary}</p>
                    </div>
                    {setupStillNeeded.length ? (
                      <div className="lr-ceo-readiness-list">
                        <strong>Still needed</strong>
                        {setupStillNeeded.map(item => <span key={item}>{item}</span>)}
                      </div>
                    ) : null}
                  </section>
                ) : null}
                {selectedReadiness?.canDeployApi ? (
                  <section className="lr-ceo-deployment-gate">
                    <div>
                      <p className="lr-ceo-kicker">Deployment gate</p>
                      <h3>{selectedReadiness.canPushToActiveClient ? "Ready for launch approval" : "Ready to test deployment"}</h3>
                      <p>{selectedReadiness.canPushToActiveClient ? "Smoke tests and launch checklist are clear. Production launch still requires human approval." : "Core runtime setup is ready enough for deploy testing. Run the launch check and smoke test before launch."}</p>
                    </div>
                    <div className="lr-ceo-action-row">
                      <button type="button" onClick={runLaunchDryRun} disabled={launchDryRunBusy}>
                        Run launch check
                      </button>
                      <button type="button" className="lr-ceo-secondary-btn" onClick={runSmokeTest} disabled={actionBusy}>
                        Run smoke test
                      </button>
                      {selectedReadiness.canPushToActiveClient ? (
                        <button
                          type="button"
                          className="lr-ceo-secondary-btn"
                          onClick={() => setActivateConfirmOpen(true)}
                          disabled={activateBusy || !cleanLaunchCheck}
                          title={cleanLaunchCheck ? "Open activation confirmation" : "Run a clean launch check first"}
                        >
                          Activate Dealer
                        </button>
                      ) : null}
                    </div>
                    {selectedReadiness.canPushToActiveClient && !cleanLaunchCheck ? (
                      <small>Run launch check first. Activation unlocks only when the launch check is clean.</small>
                    ) : null}
                  </section>
                ) : null}
                {selected && activateConfirmOpen ? (
                  <section className="lr-ceo-activation-card">
                    <div>
                      <p className="lr-ceo-kicker">Activation confirmation</p>
                      <h3>Activate {selected.dealerName}</h3>
                      <p>This records the dealer as launched in Command after the launch check has passed. It does not run DNS, vendor, legal, credential, or Lightsail deploy changes.</p>
                    </div>
                    <div className="lr-ceo-activation-grid">
                      <div>
                        <strong>Will automate</strong>
                        <span>Re-run public app and API smoke tests</span>
                        <span>Create or update the Active Client record</span>
                        <span>Mark production launch and monitoring handoff complete</span>
                      </div>
                      <div>
                        <strong>Still manual approval</strong>
                        <span>DNS changes and vendor submissions</span>
                        <span>Credentials, billing, OAuth, and MFA</span>
                        <span>Legal, TCPA, and privacy approvals</span>
                      </div>
                    </div>
                    <div className="lr-ceo-action-row">
                      <button type="button" onClick={activateDealer} disabled={activateBusy || !cleanLaunchCheck}>
                        Confirm activation
                      </button>
                      <button type="button" className="lr-ceo-secondary-btn" onClick={() => setActivateConfirmOpen(false)} disabled={activateBusy}>
                        Cancel
                      </button>
                    </div>
                  </section>
                ) : null}
                {activationResult ? (
                  <section className="lr-ceo-activation-card is-complete">
                    <div>
                      <p className="lr-ceo-kicker">Activation complete</p>
                      <h3>{activationResult.client?.dealerName || selected.dealerName}</h3>
                      <p>{activationResult.message || "Dealer is ready in Active Clients for post-launch monitoring."}</p>
                    </div>
                    <div className="lr-ceo-activation-grid">
                      <div>
                        <strong>Automated</strong>
                        {(activationResult.activation?.automated ?? ["Active Client handoff completed"]).map(item => <span key={item}>{item}</span>)}
                      </div>
                      <div>
                        <strong>Manual controls preserved</strong>
                        {(activationResult.activation?.manualApprovalStillRequired ?? ["Vendor, legal, DNS, credential, and deploy changes still require approval."]).map(item => <span key={item}>{item}</span>)}
                      </div>
                    </div>
                  </section>
                ) : null}
                {selectedVendorLinks.length ? (
                  <section className="lr-ceo-vendor-card">
                    <div className="lr-ceo-panel-title">
                      <div>
                        <p className="lr-ceo-kicker">Vendor websites</p>
                        <h3>Open setup dashboards</h3>
                        <p>Use these links for human-led setup. They open external sites only; final submissions, DNS changes, credentials, MFA, billing, and legal approvals still require explicit approval.</p>
                      </div>
                    </div>
                    <div className="lr-ceo-vendor-grid">
                      {selectedVendorLinks.map(link => (
                        <a key={link.id} className="lr-ceo-vendor-link" href={link.href} target="_blank" rel="noreferrer">
                          <strong>{link.label}</strong>
                          <span>{link.detail}</span>
                          <small>{setupStepLabel(selected, link.stepId)}</small>
                        </a>
                      ))}
                    </div>
                  </section>
                ) : null}
                {selected.launchChecklist?.length ? (
                  <section className="lr-ceo-launch-card">
                    <div className="lr-ceo-panel-title">
                      <div>
                        <p className="lr-ceo-kicker">Launch checklist</p>
                        <h3>Go-live requirements</h3>
                      </div>
                    </div>
                    <div className="lr-ceo-launch-grid">
                      {selected.launchChecklist.map(item => (
                        <div key={item.id} className={`lr-ceo-launch-item is-${item.status}`}>
                          <span>{statusLabel(item.status)}</span>
                          <strong>{item.label}</strong>
                          <small>{item.detail}</small>
                        </div>
                      ))}
                    </div>
                  </section>
                ) : null}
                <div className="lr-ceo-setup-steps">
                  {selectedSteps.map(step => (
                    <div key={step.id} className={`lr-ceo-setup-step ${currentStep?.id === step.id ? "is-current" : ""}`}>
                      <span className={statusClass(step.status)}>{statusLabel(step.status)}</span>
                      <div>
                        <strong>{step.label}</strong>
                      </div>
                      <div className="lr-ceo-step-actions">
                        {currentStep?.id === step.id ? <em>Current</em> : null}
                        {step.status === "done" ? (
                          <button type="button" className="lr-ceo-secondary-btn" onClick={() => updateStep(step.id, "in_progress")} disabled={busy}>
                            Reopen
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
                {hasTechnicalDetails ? (
                  <details className="lr-ceo-technical-details">
                    <summary>Advanced/debug actions</summary>
                    <div className="lr-ceo-advanced-actions">
                      <section className="lr-ceo-advanced-group">
                        <div>
                          <h4>Create setup task</h4>
                          <small>Use this when work should be handed to Codex or the document runner.</small>
                        </div>
                        <div className="lr-ceo-task-picker">
                          <select value={setupTaskKind} onChange={event => setSetupTaskKind(event.target.value as AgentTaskKind)}>
                            <option value="codex">Setup review</option>
                            <option value="stack">Full setup plan</option>
                            <option value="api">API/server task</option>
                            <option value="vercel">Website/domain task</option>
                            <option value="providers">Provider checklist task</option>
                            <option value="texting">Texting compliance task</option>
                            <option value="agreement">Agreement draft task</option>
                          </select>
                          <button type="button" className="lr-ceo-secondary-btn" onClick={() => createSetupTask(setupTaskKind)} disabled={taskBusy}>
                            Create task
                          </button>
                        </div>
                      </section>
	                      <section className="lr-ceo-advanced-group">
	                        <div>
	                          <h4>Website and routing</h4>
	                          <small>Prepare Vercel, tenant routing, and DNS details when needed. External changes still need human approval.</small>
	                        </div>
	                        <div className="lr-ceo-action-row">
	                          <button type="button" className="lr-ceo-secondary-btn" onClick={checkVercelDomains} disabled={vercelBusy}>
	                            {isSharedRouting(selected) ? "Check shared host" : "Check domains"}
	                          </button>
	                          <button type="button" className="lr-ceo-secondary-btn" onClick={addVercelDomains} disabled={vercelBusy}>
	                            {isSharedRouting(selected) ? "Confirm Vercel host" : "Add Vercel domains"}
	                          </button>
	                          <button type="button" className="lr-ceo-secondary-btn" onClick={generateDnsChecklist} disabled={actionBusy}>
	                            {isSharedRouting(selected) ? "Routing checklist" : "DNS checklist"}
	                          </button>
                        </div>
                      </section>
                      <section className="lr-ceo-advanced-group">
                        <div>
                          <h4>API and server</h4>
                          <small>Generate runtime paths and server profile without touching production.</small>
                        </div>
                        <div className="lr-ceo-action-row">
                          <button type="button" className="lr-ceo-secondary-btn" onClick={generateApiDeployProfile} disabled={actionBusy}>
                            API deploy profile
                          </button>
                          <button type="button" className="lr-ceo-secondary-btn" onClick={generateRuntimePackage} disabled={runtimePackageBusy}>
                            Launch packet
                          </button>
                        </div>
                      </section>
                      <section className="lr-ceo-advanced-group">
                        <div>
                          <h4>Launch verification</h4>
                          <small>Run review-only checks before asking for launch approval.</small>
                        </div>
                        <div className="lr-ceo-action-row">
                          <button type="button" className="lr-ceo-secondary-btn" onClick={runLaunchDryRun} disabled={launchDryRunBusy}>
                            Run launch check
                          </button>
                          <button type="button" className="lr-ceo-secondary-btn" onClick={runSmokeTest} disabled={actionBusy}>
                            Run smoke test
                          </button>
                        </div>
                      </section>
                    </div>
                    {vercelDomains.length ? (
                      <div className="lr-ceo-vercel-status">
                        {vercelDomains.map(domain => (
                          <span key={domain.domain} className={domain.exists && domain.verified ? "is-ready" : domain.error ? "is-blocked" : "is-working"}>
                            {domain.domain}: {domain.error || (domain.exists ? (domain.verified ? "verified" : "pending DNS") : "not added")}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {dnsRecords.length ? (
                      <div className="lr-ceo-dns-records">
                        {dnsRecords.map(record => (
                          <div key={record.id}>
                            <span>{record.type}</span>
                            <strong>{record.name}</strong>
                            <code>{record.value}</code>
                            <small>{record.purpose}</small>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {smokeChecks.length ? (
                      <div className="lr-ceo-vercel-status">
                        {smokeChecks.map(check => (
                          <span key={check.url} className={check.ok ? "is-ready" : "is-blocked"}>
                            {check.url}: {check.status || check.error} ({check.ms}ms)
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {runtimePackage ? (
                      <section className="lr-ceo-runtime-package">
                        <div className="lr-ceo-panel-title">
                          <div>
                            <p className="lr-ceo-kicker">Launch packet</p>
                            <h3>{runtimePackage.slug}</h3>
                            <small>{runtimePackage.files.length} files generated. Review-only until launch is approved.</small>
                          </div>
                          <div className="lr-ceo-action-row">
                            <button type="button" className="lr-ceo-secondary-btn" onClick={copyRuntimeManifest}>
                              Copy manifest
                            </button>
                            <button type="button" className="lr-ceo-secondary-btn" onClick={downloadRuntimePackage}>
                              Download JSON
                            </button>
                          </div>
                        </div>
                        {runtimePackageVerification ? (
                          <div className="lr-ceo-vercel-status">
                            <span className={runtimePackageVerification.ok ? "is-ready" : "is-blocked"}>
                              Verification: {runtimePackageVerification.ok ? "passed" : "blocked"}
                            </span>
                            {runtimePackageVerification.warnings.map(item => (
                              <span key={item} className="is-working">{item}</span>
                            ))}
                            {runtimePackageVerification.failures.map(item => (
                              <span key={item} className="is-blocked">{item}</span>
                            ))}
                          </div>
                        ) : null}
                        <div className="lr-ceo-package-files">
                          {runtimePackage.files.map(file => (
                            <div key={file.path}>
                              <strong>{file.path}</strong>
                              <small>{file.description}</small>
                              <code>{file.sha256.slice(0, 12)}</code>
                            </div>
                          ))}
                        </div>
                      </section>
                    ) : null}
                    {launchDryRun ? (
                      <section className={`lr-ceo-launch-dry-run is-${launchDryRun.status}`}>
                        <div className="lr-ceo-panel-title">
                          <div>
                            <p className="lr-ceo-kicker">Launch check</p>
                            <h3>{launchDryRun.label}</h3>
                            <small>{launchDryRun.summary}</small>
                          </div>
                          <button type="button" className="lr-ceo-secondary-btn" onClick={copyLaunchDryRun}>
                            Copy report
                          </button>
                        </div>
                        <div className="lr-ceo-vercel-status">
                          <span className={launchDryRun.canRunDeployDryRun ? "is-ready" : "is-blocked"}>
                            API test deploy: {launchDryRun.canRunDeployDryRun ? "available" : "blocked"}
                          </span>
                          <span className={launchDryRun.canRequestProductionApproval ? "is-ready" : "is-blocked"}>
                            Production approval: {launchDryRun.canRequestProductionApproval ? "ready to request" : "not ready"}
                          </span>
                          <span className={launchDryRun.canLaunch ? "is-ready" : "is-working"}>
                            Launch: {launchDryRun.canLaunch ? "ready after approval" : "waiting"}
                          </span>
                        </div>
                        <div className="lr-ceo-package-files">
                          {launchDryRun.items.map(item => (
                            <div key={item.id} className={`is-${item.status}`}>
                              <strong>{item.label}</strong>
                              <small>{item.detail}</small>
                              <code>{item.status}</code>
                            </div>
                          ))}
                        </div>
                        <div className="lr-ceo-dry-run-commands">
                          {launchDryRun.commands.deployDryRun ? <code>{launchDryRun.commands.deployDryRun}</code> : null}
                          <code>{launchDryRun.commands.packageVerify}</code>
                          <code>{launchDryRun.commands.smoke}</code>
                        </div>
                      </section>
                    ) : null}
                    {currentApiDeployment ? (
                      <div className="lr-ceo-dns-records">
                        <div>
                          <span>Repo</span>
                          <strong>{currentApiDeployment.repoPath}</strong>
                          <small>{currentApiDeployment.repoUrl}</small>
                        </div>
                        <div>
                          <span>Env</span>
                          <strong>{currentApiDeployment.envFile}</strong>
                          <small>Secrets stay on the server.</small>
                        </div>
                        <div>
                          <span>Data</span>
                          <strong>{currentApiDeployment.dataDir}</strong>
                          <small>Dealer runtime data.</small>
                        </div>
                        <div>
                          <span>PM2</span>
                          <strong>{currentApiDeployment.pm2Process}</strong>
                          <small>{currentApiDeployment.healthUrl}</small>
                        </div>
                        <div>
                          <span>Port</span>
                          <strong>{currentApiDeployment.localPort || "Not generated"}</strong>
                          <small>{currentApiDeployment.internalBaseUrl || "Local API process"}</small>
                        </div>
                        <div>
                          <span>Proxy</span>
                          <strong>{currentApiDeployment.proxyPathPrefix || "/"}</strong>
                          <small>{currentApiDeployment.proxyTarget || "Review generated route."}</small>
                        </div>
                        <div className="lr-ceo-deploy-profile">
                          <span>Profile</span>
                          <pre>{currentApiDeployment.profileText}</pre>
                          <button type="button" className="lr-ceo-secondary-btn" onClick={copyApiDeployProfile}>
                            Copy profile
                          </button>
                        </div>
                        {currentApiDeployment.nginxPreview ? (
                          <div className="lr-ceo-deploy-profile">
                            <span>Nginx preview</span>
                            <pre>{currentApiDeployment.nginxPreview}</pre>
                            <small>Human-review only. Do not apply without approval.</small>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {selected.dealerConfig ? (
                      <div className="lr-ceo-dns-records">
                        <div className="lr-ceo-deploy-profile">
                          <span>Config</span>
                          <pre>{JSON.stringify(selected.dealerConfig, null, 2)}</pre>
                          <button type="button" className="lr-ceo-secondary-btn" onClick={copyDealerConfig}>
                            Copy config
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {groupedRemoteEnv.length ? (
                      <section className="lr-ceo-env-card">
                        <div className="lr-ceo-panel-title">
                          <div>
                            <p className="lr-ceo-kicker">Server settings</p>
                            <h3>Environment checklist</h3>
                          </div>
                          <button type="button" className="lr-ceo-secondary-btn" onClick={copyRemoteEnvTemplate}>
                            Copy env template
                          </button>
                        </div>
                        <div className="lr-ceo-env-groups">
                          {groupedRemoteEnv.map(([category, items]) => (
                            <div key={category} className="lr-ceo-env-group">
                              <h4>{category}</h4>
                              {items.map(item => (
                                <div key={item.key} className={`lr-ceo-env-row is-${item.status}`}>
                                  <span>{item.required ? "Required" : "Optional"}</span>
                                  <div>
                                    <strong>{item.key}</strong>
                                    <small>{item.description}</small>
                                    {item.valueHint && !item.secret ? <code>{item.valueHint}</code> : null}
                                  </div>
                                  <em>{item.secret ? "Secret" : item.status}</em>
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      </section>
                    ) : null}
                  </details>
                ) : null}
              </>
            ) : (
              <p className="lr-ceo-note">Create the first dealer setup to start the onboarding workflow.</p>
            )}
          </article>
        </section>
      </section>
    </main>
  );
}
