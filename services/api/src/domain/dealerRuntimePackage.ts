import { createHash } from "node:crypto";
import type { DealerProfile } from "./dealerProfile.js";
import { buildDealerDeploymentManual } from "./dealerDeploymentManual.js";
import type { DealerSetup } from "./dealerSetupStore.js";

export type DealerRuntimePackageFile = {
  path: string;
  content: string;
  mode?: number;
  description: string;
  sha256: string;
};

export type DealerRuntimePackageManifest = {
  packageVersion: number;
  generatedAt: string;
  source: {
    dealerSetupsPath?: string;
    dealerSetupId: string;
    commandUrl: string;
  };
  dealer: {
    dealerName: string;
    legalName?: string;
    dbaName?: string;
    slug: string;
    setupStatus: string;
    deployReadiness: DealerSetup["deployReadiness"];
  };
  runtime: {
    routingMode: DealerSetup["routingMode"];
    appUrl: string;
    apiUrl: string;
    apiHostname?: string;
    webHostname?: string;
    repoPath?: string;
    dataDir?: string;
    envFile?: string;
    dealerProfilePath?: string;
    pm2Process?: string;
    localPort?: number;
    internalBaseUrl?: string;
    healthUrl?: string;
    proxyPathPrefix?: string;
    proxyTarget?: string;
    nginxPreviewPath?: string;
    deployProfileLocalPath?: string;
  };
  commands: {
    verifyPackage: string;
    deployDryRun?: string;
    smoke: string;
  };
  approvalStops: string[];
  files: Array<{
    path: string;
    description: string;
    sha256: string;
  }>;
};

export type DealerRuntimePackage = {
  packageDir: string;
  slug: string;
  generatedAt: string;
  manifest: DealerRuntimePackageManifest;
  files: DealerRuntimePackageFile[];
};

export type DealerRuntimePackageVerification = {
  ok: boolean;
  failures: string[];
  warnings: string[];
};

type BuildFileInput = Omit<DealerRuntimePackageFile, "sha256">;

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "OpenAI API key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "SendGrid API key", pattern: /\bSG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "private key block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/ },
  {
    name: "non-empty secret env value",
    pattern: /^(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|SENDGRID_API_KEY|TWILIO_AUTH_TOKEN|GOOGLE_CLIENT_SECRET|META_APP_SECRET|LINEAR_API_KEY|AUTOMATION_RUN_WRITE_TOKEN|MDF_PORTAL_RUNNER_TOKEN)=\S+/m
  }
];

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function withChecksum(file: BuildFileInput): DealerRuntimePackageFile {
  return { ...file, sha256: sha256(file.content) };
}

function prettyJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function cleanBase(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function noteLine(notes: string | undefined, label: string) {
  if (!notes) return "";
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return notes.match(new RegExp(`^${escaped}:\\s*(.+)$`, "im"))?.[1]?.trim() || "";
}

function parseAddress(value: string | undefined): DealerProfile["address"] | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const parts = raw.split(",").map(part => part.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  const stateZip = parts[2] || "";
  const stateZipMatch = stateZip.match(/^([A-Za-z]{2})\s+(.+)$/);
  return {
    line1: parts[0],
    city: parts[1],
    state: stateZipMatch?.[1]?.toUpperCase() || undefined,
    zip: stateZipMatch?.[2] || undefined
  };
}

function inferAgentName(setup: DealerSetup) {
  const identity = `${setup.slug} ${setup.dealerName}`.toLowerCase();
  if (identity.includes("americanharley") || identity.includes("american harley")) return "Brooke";
  return "Sales Team";
}

function buildDealerProfile(setup: DealerSetup, generatedAt: string): DealerProfile & Record<string, unknown> {
  const config = setup.dealerConfig;
  const tone = config?.profile.tone || noteLine(setup.notes, "Tone") || "Warm, direct, helpful dealership assistant.";
  const rules = config?.profile.rules?.length ? config.profile.rules : [
    "Verify inventory, pricing, financing, compliance, and availability before making firm commitments.",
    "Keep dealer-specific wording in this profile instead of global reply code.",
    "Customer-facing replies must publish through the parser/router/orchestrator/publisher path."
  ];
  const inventoryUrl = config?.inventory.exportUrl || noteLine(setup.notes, "Inventory/export URL");
  const profile: DealerProfile & Record<string, unknown> = {
    dealerName: setup.dealerName,
    agentName: inferAgentName(setup),
    crmProvider: setup.crmProvider,
    website: setup.website,
    address: parseAddress(setup.dealerAddress),
    usedInventoryUrl: inventoryUrl || undefined,
    preownedInventoryUrl: inventoryUrl || undefined,
    policies: {
      setupSource: {
        dealerSetupId: setup.id,
        dealerSlug: setup.slug,
        generatedAt,
        reviewRequired: true
      },
      compliance: {
        privacyPolicy: "Verify dealer-approved privacy policy URL before launch.",
        smsConsent: "Verify opt-in source and dealer-approved SMS consent language before launch.",
        tcpaWording: "Verify dealer-approved TCPA wording before launch.",
        stopHelpLanguage: "Reply STOP to opt out. Reply HELP for help. Message and data rates may apply."
      },
      launchRules: rules
    },
    voice: {
      tone,
      reviewRequired: true
    },
    webSearch: {
      referenceUrls: setup.website ? [setup.website] : []
    }
  };
  return Object.fromEntries(Object.entries(profile).filter(([, value]) => value !== undefined)) as DealerProfile & Record<string, unknown>;
}

function buildVercelEnvTemplate(setup: DealerSetup) {
  return [
    "# Dealer web app environment.",
    "# Add these to the dealer Vercel project only after the domains/API runtime are approved.",
    `API_BASE_URL=${cleanBase(setup.apiUrl)}`,
    `NEXT_PUBLIC_API_BASE_URL=${cleanBase(setup.apiUrl)}`,
    `NEXT_PUBLIC_APP_BASE_URL=${cleanBase(setup.appUrl)}`,
    `NEXT_PUBLIC_DEALER_SLUG=${setup.slug}`,
    `NEXT_PUBLIC_TENANT_ROUTING_MODE=${setup.routingMode}`,
    ""
  ].join("\n");
}

function buildSmokeScript(setup: DealerSetup) {
  const appUrl = cleanBase(setup.appUrl);
  const apiUrl = cleanBase(setup.apiUrl);
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    `APP_URL="${appUrl}"`,
    `API_URL="${apiUrl}"`,
    "",
    "echo \"Checking web app: $APP_URL\"",
    "curl -fsS \"$APP_URL\" >/dev/null",
    "",
    "echo \"Checking API health: $API_URL/health\"",
    "curl -fsS \"$API_URL/health\"",
    "echo",
    "",
    "echo \"Smoke check passed.\"",
    ""
  ].join("\n");
}

function buildApprovalStops() {
  return [
    "# Human Approval Stops",
    "",
    "This package is generated locally and does not authorize production changes.",
    "",
    "Stop for explicit human approval before:",
    "",
    "- DNS record creation or edits",
    "- Vercel project/domain/env changes",
    "- API deploys or PM2 changes",
    "- Twilio number purchases, webhook changes, A2P/10DLC, or SMS compliance submissions",
    "- SendGrid sender/domain verification, inbound parse changes, or API key creation",
    "- Google OAuth consent, credential creation, token creation, login, or MFA",
    "- CRM/vendor portal edits, export changes, or credentialed scraping",
    "- Legal, privacy, TCPA, SMS consent, STOP/HELP, or launch approvals",
    "- Any customer-facing send, inbound reply route change, or production data mutation",
    ""
  ].join("\n");
}

function buildReadme(setup: DealerSetup, packageDir: string) {
  const deployment = setup.apiDeployment;
  const profilePath = `deploy/${setup.slug}.api.env`;
  const apiProfilePath = deployment?.deployProfileLocalPath || `infra/deploy/${setup.slug}.api.env`;
  return [
    `# ${setup.dealerName} Runtime Config Package`,
    "",
    "This package was generated from Command Dealer Setup. It is an offline handoff artifact only. It does not deploy code, change DNS, submit vendor forms, create credentials, or send customer-facing messages.",
    "",
    "## Files",
    "",
    "- `manifest.json`: package contents, checksums, runtime paths, and approval stops",
    "- `config/dealer-config.json`: normalized dealer config standard",
    "- `config/dealer_profile.json`: dealer runtime profile for `DEALER_PROFILE_PATH`",
    `- \`${profilePath}\`: Lightsail API deploy profile with no secrets`,
    `- \`${deployment?.nginxPreviewPath || `deploy/${setup.slug}.nginx.conf.preview`}\`: human-review nginx route preview; do not apply automatically`,
    "- `env/remote-api.env.template`: remote API env template; fill secrets directly on the server",
    "- `env/vercel.env.template`: Vercel env values for the dealer web project",
    "- `manual/deployment-manual.md`: dealer deployment manual",
    "- `checks/approval-stops.md`: actions that require human approval",
    "- `scripts/smoke-test.sh`: public web/API health smoke check",
    "",
    "## Local Verification",
    "",
    "Run these from the repo root:",
    "",
    "```bash",
    `npm run dealer:config:verify -- --slug ${setup.slug} --package ${packageDir}`,
    `npm run dealer:runtime-isolation:eval -- --sandbox ${setup.slug}`,
    `npm run dealer:smoke -- --dealer ${setup.slug} --routing-mode ${setup.routingMode}`,
    "```",
    "",
    "## Deployment Preparation",
    "",
    "After human approval, copy the generated deploy profile into the repo deploy profile location:",
    "",
    "```bash",
    `cp ${packageDir}/${profilePath} ${apiProfilePath}`,
    `npm run deploy:api -- --profile ${apiProfilePath} --dry-run`,
    "```",
    "",
    "The dry run checks local and remote readiness without changing the server. A real deploy still requires explicit approval.",
    "",
    "## Remote Runtime Files",
    "",
    `Remote API env target: \`${deployment?.envFile || "not generated"}\``,
    `Remote dealer profile target: \`${deployment?.dataDir ? `${deployment.dataDir}/dealer_profile.json` : "not generated"}\``,
    `Remote API local port: \`${deployment?.localPort ?? "not generated"}\``,
    `Proxy path prefix: \`${deployment?.proxyPathPrefix || "not generated"}\``,
    `Proxy target: \`${deployment?.proxyTarget || "not generated"}\``,
    `Tenant routing mode: \`${setup.routingMode}\``,
    "",
    "Fill real secret values only on the server or in the vendor system that owns them. Do not commit API keys, Twilio tokens, SendGrid keys, Google credentials, OAuth tokens, or vendor credentials.",
    ""
  ].join("\n");
}

function buildManifest(setup: DealerSetup, packageDir: string, generatedAt: string, files: DealerRuntimePackageFile[]): DealerRuntimePackageManifest {
  const deployment = setup.apiDeployment;
  return {
    packageVersion: 1,
    generatedAt,
    source: {
      dealerSetupsPath: process.env.DEALER_SETUPS_PATH,
      dealerSetupId: setup.id,
      commandUrl: setup.commandUrl
    },
    dealer: {
      dealerName: setup.dealerName,
      legalName: setup.legalName,
      dbaName: setup.dbaName,
      slug: setup.slug,
      setupStatus: setup.status,
      deployReadiness: setup.deployReadiness
    },
    runtime: {
      routingMode: setup.routingMode,
      appUrl: setup.appUrl,
      apiUrl: setup.apiUrl,
      apiHostname: deployment?.apiHostname,
      webHostname: deployment?.webHostname,
      repoPath: deployment?.repoPath,
      dataDir: deployment?.dataDir,
      envFile: deployment?.envFile,
      dealerProfilePath: deployment?.dataDir ? `${deployment.dataDir}/dealer_profile.json` : undefined,
      pm2Process: deployment?.pm2Process,
      localPort: deployment?.localPort,
      internalBaseUrl: deployment?.internalBaseUrl,
      healthUrl: deployment?.healthUrl,
      proxyPathPrefix: deployment?.proxyPathPrefix,
      proxyTarget: deployment?.proxyTarget,
      nginxPreviewPath: deployment?.nginxPreviewPath,
      deployProfileLocalPath: deployment?.deployProfileLocalPath
    },
    commands: {
      verifyPackage: `npm run dealer:config:verify -- --slug ${setup.slug} --package ${packageDir}`,
      deployDryRun: deployment ? `npm run deploy:api -- --profile ${deployment.deployProfileLocalPath} --dry-run` : undefined,
      smoke: `npm run dealer:smoke -- --dealer ${setup.slug} --routing-mode ${setup.routingMode}`
    },
    approvalStops: [
      "DNS changes",
      "Vercel project/domain/env changes",
      "API deploys or PM2 changes",
      "Twilio number, webhook, A2P/10DLC, or compliance changes",
      "SendGrid sender/domain/inbound parse/API key changes",
      "Google OAuth, credential, token, login, or MFA changes",
      "CRM/vendor settings or credentialed portal changes",
      "Legal, privacy, TCPA, SMS consent, STOP/HELP, or production launch approvals",
      "Customer-facing sends or production data mutations"
    ],
    files: files.map(file => ({
      path: file.path,
      description: file.description,
      sha256: file.sha256
    }))
  };
}

function buildPackageFileInputs(setup: DealerSetup, packageDir: string, generatedAt: string): BuildFileInput[] {
  const profilePath = `deploy/${setup.slug}.api.env`;
  return [
    {
      path: "README.md",
      content: buildReadme(setup, packageDir),
      description: "Operator runbook for using the package safely."
    },
    {
      path: "config/dealer-config.json",
      content: prettyJson(setup.dealerConfig ?? {}),
      description: "Normalized dealer config standard generated from setup data."
    },
    {
      path: "config/dealer_profile.json",
      content: prettyJson(buildDealerProfile(setup, generatedAt)),
      description: "Runtime dealer profile for DEALER_PROFILE_PATH."
    },
    {
      path: profilePath,
      content: setup.apiDeployment?.profileText ?? "",
      description: "Lightsail API deploy profile. Contains runtime paths, not secrets."
    },
    {
      path: setup.apiDeployment?.nginxPreviewPath || `deploy/${setup.slug}.nginx.conf.preview`,
      content: setup.apiDeployment?.nginxPreview ?? "",
      description: "Human-review nginx route preview for the dealer API runtime. Not applied automatically."
    },
    {
      path: "env/remote-api.env.template",
      content: setup.remoteEnvTemplate ?? "",
      description: "Remote API env template. Secret values are intentionally blank."
    },
    {
      path: "env/vercel.env.template",
      content: buildVercelEnvTemplate(setup),
      description: "Vercel env template for the dealer web app."
    },
    {
      path: "manual/deployment-manual.md",
      content: buildDealerDeploymentManual(setup, "markdown").body,
      description: "Dealer deployment manual."
    },
    {
      path: "checks/approval-stops.md",
      content: buildApprovalStops(),
      description: "Actions that require explicit human approval."
    },
    {
      path: "scripts/smoke-test.sh",
      content: buildSmokeScript(setup),
      mode: 0o755,
      description: "Public web and API health smoke test."
    }
  ];
}

export function buildDealerRuntimePackage(setup: DealerSetup, opts: { packageDir?: string; generatedAt?: string } = {}): DealerRuntimePackage {
  const packageDir = opts.packageDir || `reports/dealer-setup/${setup.slug}/runtime-config-package`;
  const generatedAt = opts.generatedAt || new Date().toISOString();
  const files = buildPackageFileInputs(setup, packageDir, generatedAt).map(withChecksum);
  const manifest = buildManifest(setup, packageDir, generatedAt, files);
  const manifestFile = withChecksum({
    path: "manifest.json",
    content: prettyJson(manifest),
    description: "Package manifest and checksums."
  });
  return {
    packageDir,
    slug: setup.slug,
    generatedAt,
    manifest,
    files: [...files, manifestFile]
  };
}

function parseJsonFile(files: Map<string, DealerRuntimePackageFile>, rel: string, failures: string[]) {
  try {
    const file = files.get(rel);
    if (!file) {
      failures.push(`Missing file: ${rel}`);
      return null;
    }
    return JSON.parse(file.content);
  } catch {
    failures.push(`Invalid JSON file: ${rel}`);
    return null;
  }
}

function readEnv(content: string) {
  const entries = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    entries.set(key, rest.join("=").trim());
  }
  return entries;
}

function clean(value: string | undefined) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

function requireEnv(env: Map<string, string>, key: string, expected: string, failures: string[], fileLabel: string) {
  const actual = env.get(key) ?? "";
  if (clean(actual) !== clean(expected)) {
    failures.push(`${fileLabel} ${key} mismatch: expected "${expected}", got "${actual}"`);
  }
}

function secretScan(pkg: DealerRuntimePackage) {
  const findings: Array<{ file: string; type: string }> = [];
  for (const file of pkg.files) {
    for (const item of SECRET_PATTERNS) {
      if (item.pattern.test(file.content)) findings.push({ file: file.path, type: item.name });
    }
  }
  return findings;
}

export function verifyDealerRuntimePackage(setup: DealerSetup, pkg: DealerRuntimePackage): DealerRuntimePackageVerification {
  const failures: string[] = [];
  const warnings: string[] = [];
  const files = new Map(pkg.files.map(file => [file.path, file]));
  const requiredFiles = [
    "README.md",
    "manifest.json",
    "config/dealer-config.json",
    "config/dealer_profile.json",
    `deploy/${setup.slug}.api.env`,
    setup.apiDeployment?.nginxPreviewPath || `deploy/${setup.slug}.nginx.conf.preview`,
    "env/remote-api.env.template",
    "env/vercel.env.template",
    "manual/deployment-manual.md",
    "checks/approval-stops.md",
    "scripts/smoke-test.sh"
  ];
  for (const rel of requiredFiles) {
    if (!files.has(rel)) failures.push(`Missing file: ${rel}`);
  }
  const deployment = setup.apiDeployment;
  if (!deployment) failures.push("Dealer setup is missing generated API deployment.");
  const manifest = parseJsonFile(files, "manifest.json", failures);
  const dealerConfig = parseJsonFile(files, "config/dealer-config.json", failures);
  const dealerProfile = parseJsonFile(files, "config/dealer_profile.json", failures);
  const deployProfile = readEnv(files.get(`deploy/${setup.slug}.api.env`)?.content ?? "");
  const nginxPreview = files.get(deployment?.nginxPreviewPath || `deploy/${setup.slug}.nginx.conf.preview`)?.content ?? "";
  const remoteEnv = readEnv(files.get("env/remote-api.env.template")?.content ?? "");
  const vercelEnv = readEnv(files.get("env/vercel.env.template")?.content ?? "");
  const smokeScript = files.get("scripts/smoke-test.sh")?.content ?? "";
  const approvalStops = files.get("checks/approval-stops.md")?.content ?? "";

  if (manifest?.dealer?.slug !== setup.slug) failures.push("manifest dealer slug does not match setup.");
  if (manifest?.runtime?.dataDir !== deployment?.dataDir) failures.push("manifest dataDir does not match generated deployment.");
  if (manifest?.runtime?.envFile !== deployment?.envFile) failures.push("manifest envFile does not match generated deployment.");
  if (manifest?.runtime?.pm2Process !== deployment?.pm2Process) failures.push("manifest pm2Process does not match generated deployment.");
  if (manifest?.runtime?.localPort !== deployment?.localPort) failures.push("manifest localPort does not match generated deployment.");
  if (manifest?.runtime?.proxyPathPrefix !== deployment?.proxyPathPrefix) failures.push("manifest proxyPathPrefix does not match generated deployment.");
  if (manifest?.runtime?.proxyTarget !== deployment?.proxyTarget) failures.push("manifest proxyTarget does not match generated deployment.");
  if (manifest?.runtime?.nginxPreviewPath !== deployment?.nginxPreviewPath) failures.push("manifest nginxPreviewPath does not match generated deployment.");
  for (const file of Array.isArray(manifest?.files) ? manifest.files : []) {
    const rel = String(file?.path ?? "");
    const expected = String(file?.sha256 ?? "");
    const actualFile = files.get(rel);
    if (!rel || !expected) {
      failures.push("manifest contains a file entry without path or sha256.");
    } else if (!actualFile) {
      failures.push(`manifest references missing file: ${rel}`);
    } else if (actualFile.sha256 !== expected || sha256(actualFile.content) !== expected) {
      failures.push(`manifest checksum mismatch: ${rel}`);
    }
  }
  if (dealerConfig?.identity?.slug !== setup.slug) failures.push("dealer-config identity slug does not match setup.");
  if (dealerConfig?.routing?.dataDir !== deployment?.dataDir) failures.push("dealer-config routing dataDir does not match generated deployment.");
  if (dealerConfig?.routing?.envFile !== deployment?.envFile) failures.push("dealer-config routing envFile does not match generated deployment.");
  if (dealerProfile?.dealerName !== setup.dealerName) failures.push("dealer_profile dealerName does not match setup.");
  if (setup.website && dealerProfile?.website !== setup.website) failures.push("dealer_profile website does not match setup.");
  if (deployment) {
    requireEnv(deployProfile, "DEPLOY_REPO", deployment.repoPath, failures, "deploy profile");
    requireEnv(deployProfile, "DEPLOY_DATA_DIR", deployment.dataDir, failures, "deploy profile");
    requireEnv(deployProfile, "DEPLOY_ENV_FILE", deployment.envFile, failures, "deploy profile");
    requireEnv(deployProfile, "DEPLOY_PM2_PROCESS", deployment.pm2Process, failures, "deploy profile");
    requireEnv(deployProfile, "DEPLOY_API_PORT", String(deployment.localPort), failures, "deploy profile");
    requireEnv(deployProfile, "DEPLOY_HEALTH_URL", deployment.healthUrl, failures, "deploy profile");
    requireEnv(deployProfile, "DEPLOY_PROXY_PATH_PREFIX", deployment.proxyPathPrefix, failures, "deploy profile");
    requireEnv(deployProfile, "DEPLOY_PROXY_TARGET", deployment.proxyTarget, failures, "deploy profile");
    requireEnv(remoteEnv, "PORT", String(deployment.localPort), failures, "remote env template");
    requireEnv(remoteEnv, "DATA_DIR", deployment.dataDir, failures, "remote env template");
    requireEnv(remoteEnv, "DEALER_PROFILE_PATH", `${deployment.dataDir}/dealer_profile.json`, failures, "remote env template");
    if (deployment.routingMode !== "integration_mapping") {
      if (!nginxPreview.includes(String(deployment.localPort))) failures.push("nginx preview does not include dealer local port.");
      if (!nginxPreview.includes(deployment.proxyPathPrefix)) failures.push("nginx preview does not include proxy path prefix.");
    } else if (!nginxPreview.includes("not a standalone nginx-only production route")) {
      warnings.push("Integration-mapping nginx preview should state that a shared tenant router is required.");
    }
  }
  requireEnv(remoteEnv, "DEALER_SLUG", setup.slug, failures, "remote env template");
  requireEnv(remoteEnv, "TENANT_ROUTING_MODE", setup.routingMode, failures, "remote env template");
  requireEnv(remoteEnv, "PUBLIC_BASE_URL", setup.apiUrl, failures, "remote env template");
  requireEnv(remoteEnv, "APP_BASE_URL", setup.appUrl, failures, "remote env template");
  requireEnv(remoteEnv, "API_BASE_URL", setup.apiUrl, failures, "remote env template");
  requireEnv(vercelEnv, "API_BASE_URL", setup.apiUrl, failures, "Vercel env template");
  requireEnv(vercelEnv, "NEXT_PUBLIC_API_BASE_URL", setup.apiUrl, failures, "Vercel env template");
  requireEnv(vercelEnv, "NEXT_PUBLIC_TENANT_ROUTING_MODE", setup.routingMode, failures, "Vercel env template");
  if (!smokeScript.includes(setup.appUrl)) failures.push("smoke-test.sh does not include dealer app URL.");
  if (!smokeScript.includes(setup.apiUrl)) failures.push("smoke-test.sh does not include dealer API URL.");
  for (const phrase of ["DNS", "Vercel", "Twilio", "SendGrid", "Google", "Legal"]) {
    if (!approvalStops.includes(phrase)) failures.push(`approval-stops.md missing ${phrase} stop.`);
  }
  for (const finding of secretScan(pkg)) {
    failures.push(`Potential secret found in ${finding.file}: ${finding.type}`);
  }
  if (setup.status !== "ready" && setup.status !== "live") {
    warnings.push(`Dealer setup status is "${setup.status}". Package is valid for review but not a launch approval.`);
  }
  if (setup.deployReadiness?.status !== "ready_to_deploy" && setup.deployReadiness?.status !== "live_ready") {
    warnings.push(`Deploy readiness is "${setup.deployReadiness?.status ?? "unknown"}". Keep this package in review mode.`);
  }
  return {
    ok: failures.length === 0,
    failures,
    warnings
  };
}
