"use client";

import { useEffect, useMemo, useState } from "react";

type DealerSetupStepStatus = "pending" | "in_progress" | "blocked" | "done";
type DealerSetupChecklistStatus = "pending" | "working" | "blocked" | "ready" | "optional";

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
type ActiveClient = {
  id: string;
  dealerName: string;
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

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function statusClass(value: string) {
  if (value === "done" || value === "ready" || value === "live") return "is-ready";
  if (value === "blocked") return "is-blocked";
  if (value === "in_progress") return "is-working";
  return "";
}

function readinessClass(status?: DealerDeployReadiness["status"]) {
  if (status === "live_ready" || status === "ready_to_deploy") return "is-ready";
  if (status === "blocked") return "is-blocked";
  return "is-working";
}

const fallbackDealerSteps: DealerSetupStep[] = [
  { id: "intake", label: "Dealer intake", status: "pending" },
  { id: "agreement", label: "Agreement and pricing", status: "pending" },
  { id: "vercel", label: "Vercel domains", status: "pending" },
  { id: "dns", label: "DNS records", status: "pending" },
  { id: "api", label: "API dealer config", status: "pending" },
  { id: "remote_env", label: "Remote API env", status: "pending" },
  { id: "google", label: "Google mail and calendars", status: "pending" },
  { id: "twilio", label: "Twilio messaging", status: "pending" },
  { id: "sendgrid", label: "SendGrid sender/domain", status: "pending" },
  { id: "meta", label: "Meta connection", status: "pending" },
  { id: "smoke", label: "Smoke test", status: "pending" },
  { id: "handoff", label: "Active client handoff", status: "pending" }
];

function mergedSetupSteps(steps: DealerSetupStep[] = []) {
  const byId = new Map(steps.map(step => [step.id, step]));
  const merged = fallbackDealerSteps.map(step => {
    const existing = byId.get(step.id);
    return existing ? { ...existing, label: step.label } : step;
  });
  const known = new Set(merged.map(step => step.id));
  return merged.concat(steps.filter(step => !known.has(step.id)));
}

function setupStepStatus(setup: DealerSetup, stepId: string): DealerSetupStepStatus {
  return mergedSetupSteps(setup.steps).find(step => step.id === stepId)?.status ?? "pending";
}

function setupStepLabel(setup: DealerSetup, stepId: string) {
  return mergedSetupSteps(setup.steps).find(step => step.id === stepId)?.label ?? stepId;
}

function buildFallbackDeployReadiness(setup: DealerSetup): DealerDeployReadiness {
  const requiredDone = ["vercel", "dns", "remote_env"];
  const requiredStarted = ["api", "google", "twilio", "sendgrid", "meta"];
  const goLiveRequiredDone = ["intake", "agreement", ...requiredDone, ...requiredStarted, "smoke"];
  const missing: string[] = [];
  const blockers: string[] = [];
  const goLiveMissing: string[] = [];
  const warnings: string[] = [];

  for (const stepId of requiredDone) {
    if (setupStepStatus(setup, stepId) !== "done") missing.push(setupStepLabel(setup, stepId));
  }
  for (const stepId of requiredStarted) {
    const status = setupStepStatus(setup, stepId);
    if (status !== "done" && status !== "in_progress") missing.push(setupStepLabel(setup, stepId));
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
    case "agreement":
      return "Prepare the agreement only if it was not already handled in Sales Funnel.";
    case "vercel":
      return "Add the dealer web domain to the LeadRider web project.";
    case "dns":
      return "Generate the DNS records, then enter them where the dealer domain is hosted.";
    case "api":
      return "Prepare the dealer API deployment task and profile.";
    case "remote_env":
      return "Confirm the required server settings and secret values are in place.";
    case "google":
      return "Connect dealer Gmail, support mail, and calendars.";
    case "twilio":
      return "Configure dealer texting, compliance, and message routing.";
    case "sendgrid":
      return "Configure the dealer email sender, domain, and inbound routing.";
    case "meta":
      return "Verify the Meta app, callback, permissions, and app status.";
    case "smoke":
      return "Check the dealer app and API before launch.";
    case "handoff":
      return "Move the live-ready dealer into Active Clients.";
    default:
      return "Work the next setup item.";
  }
}

function canMarkStepComplete(step: DealerSetupStep) {
  return (
    step.status === "in_progress" &&
    ["agreement", "dns", "api", "remote_env", "google", "twilio", "sendgrid", "meta"].includes(step.id)
  );
}

export default function NewDealerClientPage() {
  const [form, setForm] = useState(emptyForm);
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
  const [activeClientBusy, setActiveClientBusy] = useState(false);
  const [stepResult, setStepResult] = useState<StepRunSummary | null>(null);

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
  const hasTechnicalDetails = Boolean(currentApiDeployment || groupedRemoteEnv.length || vercelDomains.length || dnsRecords.length || smokeChecks.length);

  useEffect(() => {
    setApiDeployment(selected?.apiDeployment ?? null);
  }, [selected?.id, selected?.apiDeployment]);

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
      case "agreement":
        return "Start agreement";
      case "vercel":
        return "Add web domain";
      case "dns":
        return "Prepare DNS";
      case "api":
        return "Prepare API";
      case "remote_env":
        return "Prepare server settings";
      case "google":
        return "Start Google setup";
      case "sendgrid":
        return "Start SendGrid setup";
      case "meta":
        return "Start Meta setup";
      case "twilio":
        return "Start texting setup";
      case "smoke":
        return "Run smoke test";
      case "handoff":
        return "Send to Active Clients";
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

  async function createSetupTask(kind: "codex" | "agreement" | "vercel" | "stack" | "api" | "providers" | "texting") {
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
              `Use app URL ${selected.appUrl} and API URL ${selected.apiUrl}.`,
              `Use the clean multi-client API pattern: repo path ${selected.apiDeployment?.repoPath || apiDeployment?.repoPath || `/home/ubuntu/leadrider-api/${selected.slug}`}, env file ${selected.apiDeployment?.envFile || apiDeployment?.envFile || `/home/ubuntu/leadrider-runtime/${selected.slug}/api.env`}, data dir ${selected.apiDeployment?.dataDir || apiDeployment?.dataDir || `/home/ubuntu/leadrider-runtime/${selected.slug}/data`}, PM2 process ${selected.apiDeployment?.pm2Process || apiDeployment?.pm2Process || `leadrider-api-${selected.slug}`}.`,
              `Deploy profile: ${selected.apiDeployment?.deployProfileLocalPath || apiDeployment?.deployProfileLocalPath || `infra/deploy/${selected.slug}.api.env`}.`,
              "Prepare dealer profile/config, routing defaults, owner/calendar placeholders, domain/callback settings, env requirements, and deploy/smoke-test steps.",
              "Do not overwrite existing clients or shared American Harley paths."
            ].join("\n")
        : kind === "providers"
          ? `Create provider setup tasks for ${selected.dealerName}. Cover Google Workspace/Gmail/calendar, Twilio messaging/phone, SendGrid sender/domain, Meta app/callback, Sentry, Linear, Slack, and OpenAI usage logging. Separate steps that Codex can do from steps needing human login, billing, OAuth consent, phone verification, or credentials.`
        : kind === "texting"
          ? `Create the texting setup plan for ${selected.dealerName}. Cover Twilio number selection or porting, A2P/10DLC brand/campaign registration, opt-in and STOP/HELP compliance language, inbound/outbound routing, salesperson ownership, support escalation, campaign safeguards, and smoke tests. Separate what Codex can prepare from anything requiring human login, billing, consent, carrier verification, or credentials.`
        : kind === "stack"
          ? `Create the full tech-stack setup plan for ${selected.dealerName}. Include Vercel app domains, DNS records, API dealer profile/config, Google Workspace/Gmail/calendar, Twilio phone/messaging, SendGrid sender/domain, OpenAI usage logging, Meta app/callback, Sentry, Linear, Slack alerts, smoke tests, and handoff steps. Identify which steps can be automated now and which require human login, billing, verification, OAuth consent, or credentials.`
        : kind === "vercel"
          ? `Prepare Vercel deployment steps for ${selected.dealerName}. Target app URL: ${selected.appUrl}. Target API URL: ${selected.apiUrl}. List required Vercel project/domain/env changes and DNS records. Do not make external changes without approval.`
          : `Run dealer setup review for ${selected.dealerName}. Check onboarding blockers across Vercel, DNS, API dealer config, Google, Twilio, SendGrid, Meta, agreement, and smoke testing. Return the next action list.`;
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
      setNotice("DNS checklist generated for the dealer app and API domains.");
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
      setNotice("Remote API env template copied. Fill secret values only on the server.");
    } catch {
      setNotice("Could not copy the remote API env template from this browser.");
    }
  }

  async function runSmokeTest() {
    if (!selected) return;
    setActionBusy(true);
    try {
      const resp = await fetch(`/api/dealer-setups/${encodeURIComponent(selected.id)}/smoke-test`, { method: "POST" });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Smoke test could not be run.");
      setSmokeChecks(Array.isArray(data.checks) ? data.checks : []);
      if (data.setup) setSetups(current => current.map(row => (row.id === data.setup.id ? data.setup : row)));
      setNotice(data.passed ? "Launch smoke test passed." : "Launch smoke test found a blocker.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Smoke test could not be run.");
    } finally {
      setActionBusy(false);
    }
  }

  async function pushToActiveClient(): Promise<boolean> {
    if (!selected) return false;
    if (!selectedReadiness?.canPushToActiveClient) {
      setNotice(selectedReadiness?.summary || "Setup is not live-ready yet.");
      return false;
    }
    setActiveClientBusy(true);
    try {
      const resp = await fetch(`/api/dealer-setups/${encodeURIComponent(selected.id)}/active-client`, { method: "POST" });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Active client could not be created.");
      const client = data.client as ActiveClient;
      setNotice(`${client.dealerName} is ready in Active Clients with setup, agreement, contact, and billing fields prefilled.`);
      return true;
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Active client could not be created.");
      return false;
    } finally {
      setActiveClientBusy(false);
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
      setNotice("Vercel domains added or confirmed. DNS may still need to be pointed and verified.");
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
          <a href="/command/personal-email">Personal Email</a>
          <a href="/command/clients">Active Clients</a>
          <a href="/command/clients/new" className="is-active">Dealer Setup</a>
          <a href="/command/users">Users</a>
          <a href="/command">Agreements</a>
          <a href="/command">Billing</a>
          <a href="/command">Connectors</a>
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
              <span className={`lr-ceo-status-pill ${statusClass(currentStep.status)}`}>{currentStep.status.replace(/_/g, " ")}</span>
              <button type="button" onClick={runGuidedStep} disabled={busy || taskBusy || actionBusy || vercelBusy || activeClientBusy}>
                {guidedStepButtonLabel(currentStep)}
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
                Subdomain slug
                <input value={form.slug} onChange={event => updateField("slug", event.target.value)} placeholder="americanharley" />
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
                Generate agreement draft on create
              </label>
              <label>
                Notes
                <textarea value={form.notes} onChange={event => updateField("notes", event.target.value)} placeholder="Special routing, owners, calendar notes, pricing assumptions..." />
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
                    <p>Open the current start-to-finish deployment manual generated from this setup record.</p>
                  </div>
                  <div>
                    <a className="lr-ceo-secondary-btn" href={`${manualBaseHref}?format=html`} target="_blank" rel="noreferrer">
                      Open manual
                    </a>
                    <a className="lr-ceo-secondary-btn" href={`${manualBaseHref}?format=markdown&download=1`}>
                      Download
                    </a>
                  </div>
                </section>
                <div className="lr-ceo-progress">
                  <span style={{ width: `${completion}%` }} />
                </div>
                <dl className="lr-ceo-facts">
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
                <div className="lr-ceo-setup-steps">
                  {selectedSteps.map(step => (
                    <div key={step.id} className={`lr-ceo-setup-step ${currentStep?.id === step.id ? "is-current" : ""}`}>
                      <span className={statusClass(step.status)}>{step.status.replace(/_/g, " ")}</span>
                      <div>
                        <strong>{step.label}</strong>
                      </div>
                      {currentStep?.id === step.id ? <em>Current</em> : <em />}
                    </div>
                  ))}
                </div>
                {hasTechnicalDetails ? (
                  <details className="lr-ceo-technical-details">
                    <summary>Technical details</summary>
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
                        <div className="lr-ceo-deploy-profile">
                          <span>Profile</span>
                          <pre>{currentApiDeployment.profileText}</pre>
                          <button type="button" className="lr-ceo-secondary-btn" onClick={copyApiDeployProfile}>
                            Copy profile
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
