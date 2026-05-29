import { buildDealerRuntimePackage, verifyDealerRuntimePackage } from "./dealerRuntimePackage.js";
import type { DealerSetup, DealerSetupStepStatus } from "./dealerSetupStore.js";

export type DealerLaunchDryRunStatus = "blocked" | "review_ready" | "deploy_dry_run_ready" | "launch_ready";
export type DealerLaunchDryRunItemStatus = "pass" | "warn" | "fail";

export type DealerLaunchDryRunItem = {
  id: string;
  label: string;
  status: DealerLaunchDryRunItemStatus;
  detail: string;
  stepId?: string;
};

export type DealerLaunchDryRun = {
  status: DealerLaunchDryRunStatus;
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

function clean(value: string | undefined) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

function stepStatus(setup: DealerSetup, stepId: string): DealerSetupStepStatus {
  return setup.steps.find(step => step.id === stepId)?.status ?? "pending";
}

function statusItem(
  id: string,
  label: string,
  status: DealerLaunchDryRunItemStatus,
  detail: string,
  stepId?: string
): DealerLaunchDryRunItem {
  return { id, label, status, detail, stepId };
}

function itemFromStep(
  setup: DealerSetup,
  stepId: string,
  label: string,
  completeDetail: string,
  warningDetail: string,
  pendingDetail: string
) {
  const status = stepStatus(setup, stepId);
  if (status === "done") return statusItem(stepId, label, "pass", completeDetail, stepId);
  if (status === "blocked") return statusItem(stepId, label, "fail", pendingDetail, stepId);
  if (status === "in_progress" || status === "ready_to_verify" || status === "waiting_on_dealer") {
    return statusItem(stepId, label, "warn", warningDetail, stepId);
  }
  return statusItem(stepId, label, "fail", pendingDetail, stepId);
}

function packageItems(setup: DealerSetup): DealerLaunchDryRunItem[] {
  const runtimePackage = buildDealerRuntimePackage(setup);
  const verification = verifyDealerRuntimePackage(setup, runtimePackage);
  const items: DealerLaunchDryRunItem[] = [
    statusItem(
      "runtime_package",
      "Runtime package",
      verification.ok ? "pass" : "fail",
      verification.ok
        ? `Package verifies with ${runtimePackage.files.length} files and manifest checksums.`
        : verification.failures.slice(0, 3).join("; ") || "Runtime package verification failed."
    )
  ];
  for (const warning of verification.warnings) {
    items.push(statusItem(`runtime_package_warning_${items.length}`, "Runtime package warning", "warn", warning));
  }
  return items;
}

function deployProfileItem(setup: DealerSetup): DealerLaunchDryRunItem {
  const deployment = setup.apiDeployment;
  if (!deployment?.profileText) {
    return statusItem("deploy_profile", "API deploy profile", "fail", "API deploy profile has not been generated.", "api");
  }
  const missing: string[] = [];
  if (!deployment.deployProfileLocalPath) missing.push("local profile path");
  if (!deployment.repoPath) missing.push("repo path");
  if (!deployment.dataDir) missing.push("data dir");
  if (!deployment.envFile) missing.push("env file");
  if (!deployment.pm2Process) missing.push("PM2 process");
  if (!deployment.healthUrl?.endsWith("/health")) missing.push("health URL");
  if (missing.length) {
    return statusItem("deploy_profile", "API deploy profile", "fail", `Missing ${missing.join(", ")}.`, "api");
  }
  return statusItem(
    "deploy_profile",
    "API deploy profile",
    "pass",
    `${deployment.deployProfileLocalPath} targets ${deployment.repoPath}, ${deployment.dataDir}, ${deployment.envFile}, and ${deployment.pm2Process}.`,
    "api"
  );
}

function tenantIsolationItem(setup: DealerSetup): DealerLaunchDryRunItem {
  const deployment = setup.apiDeployment;
  if (!deployment) return statusItem("tenant_isolation", "Tenant isolation", "fail", "API deployment profile is missing.", "api");
  const slug = setup.slug;
  const expectedApi = clean(setup.apiUrl);
  const failures: string[] = [];
  if (!deployment.repoPath.includes(slug)) failures.push("repo path does not include slug");
  if (!deployment.dataDir.includes(slug)) failures.push("data dir does not include slug");
  if (!deployment.envFile.includes(slug)) failures.push("env file does not include slug");
  if (slug !== "americanharley" && !deployment.pm2Process.includes(slug)) failures.push("PM2 process does not include slug");
  if (!clean(deployment.healthUrl).startsWith(`${expectedApi}/health`)) failures.push("health URL does not match API URL");
  if (failures.length) {
    return statusItem("tenant_isolation", "Tenant isolation", "fail", failures.join("; "), "api");
  }
  return statusItem("tenant_isolation", "Tenant isolation", "pass", "Runtime repo, data, env, PM2, and health paths are dealer-specific.", "api");
}

function dnsItem(setup: DealerSetup): DealerLaunchDryRunItem {
  const records = setup.apiDeployment?.dnsRecords ?? [];
  if (records.length < 2) return statusItem("dns_records", "DNS records", "fail", "Web/API DNS records are missing.", "domains");
  const webHost = setup.apiDeployment?.webHostname || "";
  const apiHost = setup.apiDeployment?.apiHostname || "";
  const hasWeb = records.some(record => record.name === webHost && record.type === "CNAME");
  const hasApi = records.some(record => record.name === apiHost && record.type === "A");
  if (!hasWeb || !hasApi) return statusItem("dns_records", "DNS records", "fail", "Generated DNS records do not cover both web and API hostnames.", "domains");
  return statusItem("dns_records", "DNS records", "pass", `${records.length} web/API DNS records are generated.`, "domains");
}

function remoteEnvItem(setup: DealerSetup): DealerLaunchDryRunItem {
  const required = (setup.remoteEnvChecklist ?? []).filter(item => item.required);
  if (!required.length) return statusItem("remote_env_template", "Remote API env", "fail", "Required remote env checklist is missing.", "remote_env");
  const blocked = required.filter(item => item.status === "blocked");
  const pending = required.filter(item => item.status === "pending");
  const working = required.filter(item => item.status === "working");
  if (blocked.length) {
    return statusItem("remote_env_template", "Remote API env", "fail", `${blocked.length} required env item${blocked.length === 1 ? "" : "s"} blocked.`, "remote_env");
  }
  if (pending.length) {
    return statusItem("remote_env_template", "Remote API env", "fail", `${pending.length} required env item${pending.length === 1 ? "" : "s"} not started.`, "remote_env");
  }
  if (working.length || stepStatus(setup, "remote_env") !== "done") {
    return statusItem("remote_env_template", "Remote API env", "warn", "Remote env template is generated, but server values still need confirmation.", "remote_env");
  }
  return statusItem("remote_env_template", "Remote API env", "pass", `${required.length} required env items are confirmed.`, "remote_env");
}

function launchChecklistItems(setup: DealerSetup): DealerLaunchDryRunItem[] {
  const checklist = setup.launchChecklist ?? [];
  if (!checklist.length) return [statusItem("launch_checklist", "Launch checklist", "fail", "Launch checklist is missing.", "launch_gate")];
  const required = checklist.filter(item => item.status !== "optional");
  const blocked = required.filter(item => item.status === "blocked");
  const pending = required.filter(item => item.status === "pending");
  const working = required.filter(item => item.status === "working");
  const items: DealerLaunchDryRunItem[] = [];
  if (blocked.length) items.push(statusItem("launch_checklist_blocked", "Launch checklist", "fail", `${blocked.length} launch checklist item${blocked.length === 1 ? "" : "s"} blocked.`, "launch_gate"));
  if (pending.length) items.push(statusItem("launch_checklist_pending", "Launch checklist", "fail", `${pending.length} launch checklist item${pending.length === 1 ? "" : "s"} not started.`, "launch_gate"));
  if (working.length) items.push(statusItem("launch_checklist_working", "Launch checklist", "warn", `${working.length} launch checklist item${working.length === 1 ? "" : "s"} still in progress.`, "launch_gate"));
  if (!items.length) items.push(statusItem("launch_checklist", "Launch checklist", "pass", `${required.length} required launch checklist items are clear.`, "launch_gate"));
  return items;
}

export function buildDealerLaunchDryRun(setup: DealerSetup): DealerLaunchDryRun {
  const items: DealerLaunchDryRunItem[] = [
    ...packageItems(setup),
    deployProfileItem(setup),
    tenantIsolationItem(setup),
    dnsItem(setup),
    itemFromStep(
      setup,
      "domains",
      "Domain approval",
      "Domain/DNS step is complete.",
      "Domain/DNS work is still waiting or ready to verify.",
      "Domain/DNS step must be completed before deployment approval."
    ),
    itemFromStep(
      setup,
      "vercel",
      "Vercel setup",
      "Vercel frontend setup is complete.",
      "Vercel setup is still waiting or ready to verify.",
      "Vercel setup must be completed before launch."
    ),
    remoteEnvItem(setup),
    itemFromStep(
      setup,
      "twilio",
      "Twilio and SMS compliance",
      "Twilio and SMS compliance step is complete.",
      "Twilio/compliance work is still waiting or ready to verify.",
      "Twilio/compliance step must be completed before customer messaging launch."
    ),
    itemFromStep(
      setup,
      "sendgrid",
      "SendGrid email",
      "SendGrid step is complete.",
      "SendGrid setup is still waiting or ready to verify.",
      "SendGrid step must be completed before email launch."
    ),
    itemFromStep(
      setup,
      "google",
      "Google Calendar/users",
      "Google Calendar/users step is complete.",
      "Google setup is still waiting or ready to verify.",
      "Google Calendar/users step must be completed before launch."
    ),
    itemFromStep(
      setup,
      "inventory",
      "Inventory/export URL",
      "Inventory/export URL step is complete.",
      "Inventory/export URL is still waiting or ready to verify.",
      "Inventory/export URL must be completed before launch."
    ),
    itemFromStep(
      setup,
      "crm",
      "CRM/ADF/Twilio routing",
      "CRM/ADF/Twilio routing step is complete.",
      "CRM/routing is still waiting or ready to verify.",
      "CRM/ADF/Twilio routing must be completed before launch."
    ),
    itemFromStep(
      setup,
      "profile",
      "Dealer profile/rules",
      "Dealer profile, rules, and compliance language are complete.",
      "Dealer profile/rules are still waiting or ready to verify.",
      "Dealer profile/rules must be completed before launch."
    ),
    itemFromStep(
      setup,
      "manual",
      "Deployment manual",
      "Deployment manual is complete.",
      "Deployment manual is still waiting or ready to verify.",
      "Deployment manual must be generated and reviewed before launch."
    ),
    itemFromStep(
      setup,
      "smoke",
      "Smoke tests",
      "Smoke tests are complete.",
      "Smoke tests are still waiting or ready to verify.",
      "Smoke tests must pass before launch."
    ),
    itemFromStep(
      setup,
      "launch_gate",
      "Launch gate",
      "Launch gate is complete.",
      "Launch gate is still waiting or ready to verify.",
      "Launch gate must be approved before launch."
    ),
    ...launchChecklistItems(setup)
  ];

  const blockers = items.filter(item => item.status === "fail").map(item => `${item.label}: ${item.detail}`);
  const warnings = items.filter(item => item.status === "warn").map(item => `${item.label}: ${item.detail}`);
  const canRunDeployDryRun = !blockers.some(blocker => /Runtime package|API deploy profile|Tenant isolation|DNS records|Remote API env/i.test(blocker));
  const canRequestProductionApproval = blockers.length === 0 && setup.deployReadiness?.canDeployApi === true;
  const canLaunch = blockers.length === 0 && warnings.length === 0 && setup.deployReadiness?.canPushToActiveClient === true;
  const status: DealerLaunchDryRunStatus = canLaunch
    ? "launch_ready"
    : canRequestProductionApproval
      ? "deploy_dry_run_ready"
      : blockers.length
        ? "blocked"
        : "review_ready";
  const label =
    status === "launch_ready"
      ? "Launch-ready"
      : status === "deploy_dry_run_ready"
        ? "Ready for deploy dry-run"
        : status === "review_ready"
          ? "Ready for review"
          : "Blocked";
  const summary =
    status === "launch_ready"
      ? "All launch dry-run checks are clear. Production launch still requires explicit human approval."
      : status === "deploy_dry_run_ready"
        ? "Core deploy dry-run checks are clear. Review warnings before requesting production approval."
        : status === "review_ready"
          ? "No hard blockers found, but warnings remain before production approval."
          : `Resolve ${blockers.length} blocker${blockers.length === 1 ? "" : "s"} before deployment approval.`;

  return {
    status,
    label,
    summary,
    ok: blockers.length === 0,
    canRunDeployDryRun,
    canRequestProductionApproval,
    canLaunch,
    blockers,
    warnings,
    commands: {
      deployDryRun: setup.apiDeployment?.deployProfileLocalPath
        ? `npm run deploy:api -- --profile ${setup.apiDeployment.deployProfileLocalPath} --dry-run`
        : undefined,
      smoke: `npm run dealer:smoke -- --dealer ${setup.slug}`,
      packageVerify: `npm run dealer:config:verify -- --slug ${setup.slug}`
    },
    items
  };
}
