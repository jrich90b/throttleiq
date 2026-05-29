import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { listDealerSetups } from "../services/api/src/domain/dealerSetupStore.js";

type RuntimeShape = {
  slug: string;
  routingMode: string;
  appUrl: string;
  apiUrl: string;
  apiHostname: string;
  repoPath: string;
  dataDir: string;
  envFile: string;
  pm2Process: string;
  localPort: string;
  healthUrl: string;
  proxyPathPrefix: string;
  proxyTarget: string;
  dealerProfilePath: string;
};

function argValue(name: string) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || "";
  const prefix = `${name}=`;
  return process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length) || "";
}

function configureDefaultStorePath() {
  if (process.env.DEALER_SETUPS_PATH?.trim()) return process.env.DEALER_SETUPS_PATH;
  const cwd = process.cwd();
  const isApiWorkspace = cwd.endsWith(path.join("services", "api"));
  const storePath = isApiWorkspace
    ? path.resolve(cwd, "data/dealer_setups.json")
    : path.resolve(cwd, "services/api/data/dealer_setups.json");
  process.env.DEALER_SETUPS_PATH = storePath;
  return storePath;
}

async function readDeployProfile(filePath: string) {
  const raw = await fs.readFile(filePath, "utf8");
  const entries = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    entries.set(key, rest.join("=").trim());
  }
  return entries;
}

function hostname(value: string) {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

function profileRuntime(slug: string, profile: Map<string, string>): RuntimeShape {
  const dataDir = profile.get("DEPLOY_DATA_DIR") || "";
  const apiUrl = (profile.get("DEPLOY_HEALTH_URL") || "").replace(/\/health\/?$/, "");
  return {
    slug,
    routingMode: "subdomain",
    appUrl: `https://${slug}.leadrider.ai`,
    apiUrl,
    apiHostname: hostname(apiUrl),
    repoPath: profile.get("DEPLOY_REPO") || "",
    dataDir,
    envFile: profile.get("DEPLOY_ENV_FILE") || "",
    pm2Process: profile.get("DEPLOY_PM2_PROCESS") || "",
    localPort: profile.get("DEPLOY_API_PORT") || "3001",
    healthUrl: profile.get("DEPLOY_HEALTH_URL") || "",
    proxyPathPrefix: profile.get("DEPLOY_PROXY_PATH_PREFIX") || "/",
    proxyTarget: profile.get("DEPLOY_PROXY_TARGET") || "http://127.0.0.1:3001",
    dealerProfilePath: `${dataDir.replace(/\/$/, "")}/dealer_profile.json`
  };
}

function setupRuntime(
  setup: Awaited<ReturnType<typeof listDealerSetups>>[number],
  buildDealerApiDeployment: (setup: any) => any
): RuntimeShape {
  const deployment = buildDealerApiDeployment(setup);
  return {
    slug: setup.slug,
    routingMode: setup.routingMode || "subdomain",
    appUrl: setup.appUrl,
    apiUrl: setup.apiUrl,
    apiHostname: deployment.apiHostname,
    repoPath: deployment.repoPath,
    dataDir: deployment.dataDir,
    envFile: deployment.envFile,
    pm2Process: deployment.pm2Process,
    localPort: String(deployment.localPort),
    healthUrl: deployment.healthUrl,
    proxyPathPrefix: deployment.proxyPathPrefix,
    proxyTarget: deployment.proxyTarget,
    dealerProfilePath: `${deployment.dataDir.replace(/\/$/, "")}/dealer_profile.json`
  };
}

function same(a: string, b: string) {
  return a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");
}

function isNestedShared(a: string, b: string) {
  const left = a.trim().replace(/\/+$/, "");
  const right = b.trim().replace(/\/+$/, "");
  return !!left && !!right && (left.startsWith(`${right}/`) || right.startsWith(`${left}/`));
}

function checkDistinct(field: keyof RuntimeShape, left: RuntimeShape, right: RuntimeShape, failures: string[]) {
  const a = String(left[field] ?? "");
  const b = String(right[field] ?? "");
  if (!a || !b) failures.push(`${field} is missing: ${left.slug}="${a}" ${right.slug}="${b}"`);
  if (same(a, b)) failures.push(`${field} is shared by ${left.slug} and ${right.slug}: ${a}`);
}

function assertRuntimeIsolation(prod: RuntimeShape, sandbox: RuntimeShape) {
  const failures: string[] = [];
  for (const field of ["slug", "appUrl", "apiUrl", "apiHostname", "repoPath", "dataDir", "envFile", "pm2Process", "localPort", "healthUrl", "dealerProfilePath"] as const) {
    checkDistinct(field, prod, sandbox, failures);
  }
  for (const field of ["dataDir", "envFile", "dealerProfilePath"] as const) {
    if (isNestedShared(prod[field], sandbox[field])) {
      failures.push(`${field} is nested/shared between ${prod.slug} and ${sandbox.slug}: ${prod[field]} <> ${sandbox[field]}`);
    }
  }
  if (!sandbox.dataDir.includes(sandbox.slug)) failures.push(`sandbox dataDir does not include sandbox slug: ${sandbox.dataDir}`);
  if (!sandbox.envFile.includes(sandbox.slug)) failures.push(`sandbox envFile does not include sandbox slug: ${sandbox.envFile}`);
  if (!sandbox.pm2Process.includes(sandbox.slug)) failures.push(`sandbox PM2 process does not include sandbox slug: ${sandbox.pm2Process}`);
  if (!sandbox.proxyTarget.endsWith(`:${sandbox.localPort}`)) {
    failures.push(`sandbox proxy target does not match local port: ${sandbox.proxyTarget} <> ${sandbox.localPort}`);
  }
  if (sandbox.routingMode === "subdomain" && !sandbox.apiHostname.includes(sandbox.slug)) {
    failures.push(`sandbox API hostname does not include sandbox slug: ${sandbox.apiHostname}`);
  }
  if (sandbox.routingMode === "path" && !sandbox.apiUrl.includes(`/t/${sandbox.slug}`)) {
    failures.push(`path-mode sandbox API URL does not include tenant path: ${sandbox.apiUrl}`);
  }
  if (sandbox.routingMode === "path" && sandbox.proxyPathPrefix !== `/t/${sandbox.slug}`) {
    failures.push(`path-mode sandbox proxy prefix does not include tenant path: ${sandbox.proxyPathPrefix}`);
  }
  if (sandbox.routingMode === "integration_mapping" && !sandbox.appUrl.includes(`/d/${sandbox.slug}`)) {
    failures.push(`integration-mapping sandbox app URL does not include dealer path: ${sandbox.appUrl}`);
  }
  return failures;
}

async function main() {
  const storePath = configureDefaultStorePath();
  const { buildDealerApiDeployment, listDealerSetups } = await import("../services/api/src/domain/dealerSetupStore.js");
  const prodProfilePath = argValue("--prod-profile") || path.resolve(process.cwd(), "infra/deploy/americanharley.api.env.example");
  const sandboxSlug = argValue("--sandbox") || "americanharley-sandbox";
  const prod = profileRuntime("americanharley", await readDeployProfile(prodProfilePath));
  const sandboxSetup = (await listDealerSetups(500)).find(setup => setup.slug === sandboxSlug);
  if (!sandboxSetup) throw new Error(`Sandbox setup "${sandboxSlug}" not found in ${storePath}`);
  const sandbox = setupRuntime(sandboxSetup, buildDealerApiDeployment);
  const failures = assertRuntimeIsolation(prod, sandbox);
  const result = {
    ok: failures.length === 0,
    storePath,
    prodProfilePath,
    prod,
    sandbox,
    failures
  };
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
