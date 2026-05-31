import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type AgentTaskStatus = "queued" | "needs_approval" | "running" | "completed" | "failed" | "blocked";

type AgentTask = {
  id: string;
  kind: string;
  title: string;
  instructions: string;
  status: AgentTaskStatus;
  updatedAt: string;
  output?: {
    summary?: string;
    links?: string[];
  };
};

type HdnetDraftPacket = {
  formKind: "short" | "long";
  formTitle: string;
  formSource: string;
  reason: string;
  fields: Record<string, string>;
  missing: string[];
  warnings: string[];
  detailRows: {
    labor8888: Array<{ row: string; laborCode: string; hours: string; comments: string }>;
    otherLabor: Array<{ row: string; laborCode: string }>;
    otherDetails: Array<{ row: string; type: string; cost: string; comments: string }>;
  };
};

type WarrantyRmaCaseEntry = {
  id: string;
  title: string;
  status: string;
  partNumber: string;
  issueDescription: string;
  claimType?: string;
  customerName?: string;
  vin?: string;
  roNumber?: string;
  hdnetDraftPacket?: HdnetDraftPacket;
  review?: {
    dmsPayloadDraft?: Record<string, string>;
  };
  updatedAt: string;
};

type RunnerOptions = {
  taskId?: string;
  caseId?: string;
  dryRun: boolean;
  list: boolean;
  run: boolean;
  guided: boolean;
  idleOk: boolean;
  portalUrl: string;
  cdpUrl: string;
  apiBase: string;
  token: string;
  useSavedChromeLogin: boolean;
};

const hDNetHomeUrl = "https://h-dnet.com";
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

loadEnvFile(path.join(rootDir, ".env"));
loadEnvFile(path.join(rootDir, "services", "api", ".env"));

const dataDir = process.env.DATA_DIR?.trim()
  ? path.resolve(process.env.DATA_DIR.trim())
  : existsSync(path.join(rootDir, "services", "api", "data"))
    ? path.join(rootDir, "services", "api", "data")
    : path.join(rootDir, "data");

const tasksPath = process.env.AGENT_TASKS_PATH?.trim()
  ? path.resolve(process.env.AGENT_TASKS_PATH.trim())
  : path.join(dataDir, "agent_tasks.json");

const casesPath = process.env.WARRANTY_RMA_DB_PATH?.trim()
  ? path.resolve(process.env.WARRANTY_RMA_DB_PATH.trim())
  : path.join(dataDir, "warranty_rma.json");

const runsDir = path.join(dataDir, "warranty_rma_portal_runs");
const runnerMachinePath =
  process.env.WARRANTY_RMA_PORTAL_RUNNER_MACHINE_PATH?.trim() ||
  process.env.MDF_PORTAL_RUNNER_MACHINE_PATH?.trim()
    ? path.resolve(String(process.env.WARRANTY_RMA_PORTAL_RUNNER_MACHINE_PATH || process.env.MDF_PORTAL_RUNNER_MACHINE_PATH).trim())
    : path.join(os.homedir(), ".leadrider", "mdf-runner-machine.json");

function loadEnvFile(filePath: string) {
  if (!existsSync(filePath)) return;
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function osFlag(name: string, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

function parseArgs(argv: string[]): RunnerOptions {
  const out: RunnerOptions = {
    dryRun: false,
    list: false,
    run: false,
    guided: false,
    idleOk: false,
    portalUrl:
      process.env.WARRANTY_RMA_HDNET_URL?.trim() ||
      process.env.MDF_HDNET_URL?.trim() ||
      hDNetHomeUrl,
    cdpUrl:
      process.env.WARRANTY_RMA_PORTAL_CDP_URL?.trim() ||
      process.env.MDF_PORTAL_CDP_URL?.trim() ||
      process.env.BROWSER_USE_CDP_URL?.trim() ||
      "",
    apiBase:
      process.env.WARRANTY_RMA_PORTAL_API_BASE_URL?.trim() ||
      process.env.MDF_PORTAL_API_BASE_URL?.trim() ||
      process.env.LEADRIDER_API_BASE_URL?.trim() ||
      "",
    token:
      process.env.WARRANTY_RMA_PORTAL_RUNNER_TOKEN?.trim() ||
      process.env.MDF_PORTAL_RUNNER_TOKEN?.trim() ||
      process.env.AUTOMATION_RUN_WRITE_TOKEN?.trim() ||
      "",
    useSavedChromeLogin: osFlag("WARRANTY_RMA_PORTAL_USE_SAVED_CHROME_LOGIN", osFlag("MDF_PORTAL_USE_SAVED_CHROME_LOGIN", true))
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--task-id") {
      out.taskId = next;
      i += 1;
    } else if (arg.startsWith("--task-id=")) {
      out.taskId = arg.slice("--task-id=".length);
    } else if (arg === "--case-id") {
      out.caseId = next;
      i += 1;
    } else if (arg.startsWith("--case-id=")) {
      out.caseId = arg.slice("--case-id=".length);
    } else if (arg === "--portal-url") {
      out.portalUrl = next;
      i += 1;
    } else if (arg.startsWith("--portal-url=")) {
      out.portalUrl = arg.slice("--portal-url=".length);
    } else if (arg === "--cdp-url") {
      out.cdpUrl = next;
      i += 1;
    } else if (arg.startsWith("--cdp-url=")) {
      out.cdpUrl = arg.slice("--cdp-url=".length);
    } else if (arg === "--api-base") {
      out.apiBase = next;
      i += 1;
    } else if (arg.startsWith("--api-base=")) {
      out.apiBase = arg.slice("--api-base=".length);
    } else if (arg === "--token") {
      out.token = next;
      i += 1;
    } else if (arg.startsWith("--token=")) {
      out.token = arg.slice("--token=".length);
    } else if (arg === "--use-saved-login") {
      out.useSavedChromeLogin = true;
    } else if (arg === "--no-saved-login") {
      out.useSavedChromeLogin = false;
    } else if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg === "--list") {
      out.list = true;
    } else if (arg === "--run") {
      out.run = true;
    } else if (arg === "--guided") {
      out.guided = true;
    } else if (arg === "--idle-ok") {
      out.idleOk = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return out;
}

function printHelp() {
  console.log(`Warranty/RMA H-Dnet portal runner

Usage:
  npm run warranty_rma:portal -- --list
  npm run warranty_rma:portal -- --dry-run --task-id <agent_task_id>
  npm run warranty_rma:portal -- --run --task-id <agent_task_id>

Options:
  --list                    Show warranty/RMA portal tasks.
  --task-id <id>            Run a specific agent task.
  --case-id <id>            Run the newest task for a specific warranty/RMA case.
  --portal-url <url>        H-Dnet start URL. Also supported: WARRANTY_RMA_HDNET_URL.
  --cdp-url <url>           Logged-in Chrome CDP URL. Also supported: WARRANTY_RMA_PORTAL_CDP_URL.
  --api-base <url>          Optional live API base. Also supported: WARRANTY_RMA_PORTAL_API_BASE_URL.
  --token <token>           Optional runner token. Also supported: WARRANTY_RMA_PORTAL_RUNNER_TOKEN.
  --use-saved-login         Let Chrome saved login/autofill advance H-Dnet login when available.
  --no-saved-login          Stop immediately when H-Dnet login is required.
  --guided                  Open the portal and packet checklist without filling fields.
  --idle-ok                 Exit cleanly when no warranty/RMA portal task is available.
  --dry-run                 Build the packet and checklist without opening a browser.
  --run                     Actually start the portal runner or guided browser mode.
`);
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isAgentTask(row: any): row is AgentTask {
  return (
    row &&
    typeof row === "object" &&
    typeof row.id === "string" &&
    typeof row.title === "string" &&
    typeof row.instructions === "string" &&
    typeof row.status === "string"
  );
}

function caseIdFromTask(task: AgentTask): string {
  return task.instructions.match(/\[warranty-rma-portal:([^\]]+)\]/)?.[1] ?? "";
}

async function loadTasks(): Promise<AgentTask[]> {
  const rows = await readJson<unknown>(tasksPath, []);
  return Array.isArray(rows) ? rows.filter(isAgentTask) : [];
}

async function saveTasks(tasks: AgentTask[]) {
  await writeJson(tasksPath, tasks);
}

async function loadCases(): Promise<WarrantyRmaCaseEntry[]> {
  const payload = await readJson<{ cases?: WarrantyRmaCaseEntry[] }>(casesPath, { cases: [] });
  return Array.isArray(payload.cases) ? payload.cases : [];
}

async function runnerIdentityHeaders(): Promise<Record<string, string>> {
  const identity = await loadRunnerMachineIdentity();
  return {
    "x-mdf-runner-machine-id": identity.id,
    "x-mdf-runner-machine-name": identity.name
  };
}

async function loadRunnerMachineIdentity(): Promise<{ id: string; name: string }> {
  try {
    const parsed = JSON.parse(await readFile(runnerMachinePath, "utf8")) as { id?: string; name?: string };
    const id = String(parsed.id ?? "").trim();
    if (id) return { id, name: String(parsed.name ?? "").trim() || os.hostname() || "Portal Runner" };
  } catch {
    // Create a stable ID for this installed runner.
  }
  const identity = { id: randomUUID(), name: os.hostname() || "Portal Runner" };
  await mkdir(path.dirname(runnerMachinePath), { recursive: true });
  await writeFile(runnerMachinePath, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
  return identity;
}

async function loadRemoteBundles(options: RunnerOptions): Promise<{ task: AgentTask; case: WarrantyRmaCaseEntry | null }[]> {
  if (!options.token) throw new Error("WARRANTY_RMA_PORTAL_RUNNER_TOKEN or --token is required with --api-base.");
  const base = options.apiBase.replace(/\/$/, "");
  const resp = await fetch(`${base}/warranty-rma/portal-runner/tasks?limit=100`, {
    headers: {
      Authorization: `Bearer ${options.token}`,
      ...await runnerIdentityHeaders()
    }
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Could not load remote warranty/RMA portal tasks (${resp.status}): ${text.slice(0, 500)}`);
  const parsed = JSON.parse(text) as { tasks?: Array<{ task?: AgentTask; case?: WarrantyRmaCaseEntry | null }> };
  return (parsed.tasks ?? [])
    .filter(row => row.task && isAgentTask(row.task))
    .map(row => ({ task: row.task as AgentTask, case: row.case ?? null }));
}

async function updateRemoteTask(options: RunnerOptions, id: string, status: AgentTaskStatus, summary: string, links: string[] = []) {
  if (!options.token) throw new Error("WARRANTY_RMA_PORTAL_RUNNER_TOKEN or --token is required with --api-base.");
  const base = options.apiBase.replace(/\/$/, "");
  const resp = await fetch(`${base}/warranty-rma/portal-runner/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.token}`,
      ...await runnerIdentityHeaders()
    },
    body: JSON.stringify({ status, summary, links })
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Could not update remote warranty/RMA portal task (${resp.status}): ${text.slice(0, 500)}`);
}

function pendingWarrantyTasks(tasks: AgentTask[]) {
  return tasks
    .filter(task => task.kind === "warranty_rma_portal")
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

function chooseBundle(
  bundles: Array<{ task: AgentTask; case: WarrantyRmaCaseEntry | null }>,
  options: RunnerOptions
) {
  const rows = bundles.filter(row => row.task.kind === "warranty_rma_portal");
  if (options.taskId) return rows.find(row => row.task.id === options.taskId) ?? null;
  if (options.caseId) return rows.find(row => caseIdFromTask(row.task) === options.caseId) ?? null;
  return rows.find(row => row.task.status === "needs_approval" || row.task.status === "queued") ?? null;
}

function updateTask(tasks: AgentTask[], id: string, status: AgentTaskStatus, summary: string, links: string[] = []) {
  const task = tasks.find(row => row.id === id);
  if (!task) return;
  task.status = status;
  task.updatedAt = new Date().toISOString();
  task.output = { ...(task.output ?? {}), summary, links };
}

function packetFieldRows(packet: HdnetDraftPacket): Array<{ name: string; value: string; label: string }> {
  const rows = Object.entries(packet.fields).map(([name, value]) => ({ name, value, label: name }));
  for (const row of packet.detailRows.labor8888) {
    rows.push({ name: `strLaborCode${row.row}`, value: row.laborCode, label: `8888 labor code row ${row.row}` });
    rows.push({ name: `strDtlHours${row.row}`, value: row.hours, label: `8888 labor hours row ${row.row}` });
    rows.push({ name: `strLaborComments${row.row}`, value: row.comments, label: `8888 labor comments row ${row.row}` });
  }
  for (const row of packet.detailRows.otherLabor) {
    rows.push({ name: row.row, value: row.laborCode, label: `Other labor ${row.row}` });
  }
  for (const row of packet.detailRows.otherDetails) {
    rows.push({ name: `strDetailType${row.row}`, value: row.type, label: `Other detail type row ${row.row}` });
    rows.push({ name: `strCost${row.row}`, value: row.cost, label: `Other detail cost row ${row.row}` });
    rows.push({ name: `strComments${row.row}`, value: row.comments, label: `Other detail comments row ${row.row}` });
  }
  return rows.filter(row => String(row.value ?? "").trim());
}

function buildPrompt(task: AgentTask, item: WarrantyRmaCaseEntry): string {
  const packet = item.hdnetDraftPacket;
  const fieldLines = packet
    ? packetFieldRows(packet).map(row => `- ${row.name}: ${row.value}`).join("\n")
    : "- No H-Dnet packet found.";
  return [
    `# Warranty/RMA H-Dnet Portal Packet`,
    "",
    `Task: ${task.title}`,
    `Task ID: ${task.id}`,
    `Case ID: ${item.id}`,
    `Case: ${item.title}`,
    `Part number: ${item.partNumber}`,
    `Claim type: ${item.claimType || item.review?.dmsPayloadDraft?.claimType || "needs review"}`,
    `Form: ${packet?.formTitle || "missing"}`,
    packet?.reason ? `Reason: ${packet.reason}` : "",
    "",
    "## Fields to fill",
    fieldLines,
    "",
    "## Missing items",
    packet?.missing?.length ? packet.missing.map(item => `- ${item}`).join("\n") : "- none flagged",
    "",
    "## Warnings",
    packet?.warnings?.length ? packet.warnings.map(item => `- ${item}`).join("\n") : "- none",
    "",
    "## Final rule",
    "Fill only a draft. Never click final submit."
  ]
    .filter(Boolean)
    .join("\n");
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderGuidedHtml(item: WarrantyRmaCaseEntry): string {
  const packet = item.hdnetDraftPacket;
  const rows = packet ? packetFieldRows(packet) : [];
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Warranty/RMA H-Dnet packet</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #111827; background: #f8fafc; }
    main { max-width: 980px; margin: 0 auto; background: white; border: 1px solid #e5e7eb; border-radius: 12px; padding: 28px; box-shadow: 0 16px 40px rgba(15, 23, 42, 0.08); }
    h1 { margin: 0 0 8px; font-size: 24px; }
    h2 { margin-top: 28px; font-size: 15px; text-transform: uppercase; letter-spacing: .08em; color: #6b7280; }
    table { border-collapse: collapse; width: 100%; margin-top: 12px; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 10px; text-align: left; vertical-align: top; }
    th { background: #f3f4f6; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #4b5563; }
    code { background: #f3f4f6; border-radius: 6px; padding: 2px 5px; }
    .badge { display: inline-block; border-radius: 999px; padding: 4px 10px; background: #ffedd5; color: #9a3412; font-weight: 700; font-size: 12px; }
    .note { border-left: 4px solid #f97316; padding: 12px 16px; background: #fff7ed; }
  </style>
</head>
<body>
  <main>
    <p><span class="badge">LeadRider Warranty/RMA portal packet</span></p>
    <h1>${escapeHtml(item.title)}</h1>
    <p class="note">Open H-Dnet Warranty-Link, choose ${escapeHtml(packet?.formTitle || "the correct warranty claim form")}, fill these fields, and stop before final submit.</p>
    <h2>Case</h2>
    <p><strong>Case ID:</strong> ${escapeHtml(item.id)}<br/><strong>Part:</strong> ${escapeHtml(item.partNumber)}<br/><strong>Issue:</strong> ${escapeHtml(item.issueDescription)}</p>
    <h2>Fields</h2>
    <table>
      <thead><tr><th>Field</th><th>Value</th><th>Label</th></tr></thead>
      <tbody>
        ${rows.map(row => `<tr><td><code>${escapeHtml(row.name)}</code></td><td>${escapeHtml(row.value)}</td><td>${escapeHtml(row.label)}</td></tr>`).join("")}
      </tbody>
    </table>
    <h2>Missing</h2>
    <ul>${(packet?.missing?.length ? packet.missing : ["none flagged"]).map(row => `<li>${escapeHtml(row)}</li>`).join("")}</ul>
    <h2>Warnings</h2>
    <ul>${(packet?.warnings?.length ? packet.warnings : ["none"]).map(row => `<li>${escapeHtml(row)}</li>`).join("")}</ul>
  </main>
</body>
</html>`;
}

async function writeArtifacts(task: AgentTask, item: WarrantyRmaCaseEntry) {
  await mkdir(runsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${stamp}_${task.id}`;
  const promptPath = path.join(runsDir, `${base}.md`);
  const htmlPath = path.join(runsDir, `${base}.html`);
  await writeFile(promptPath, buildPrompt(task, item), "utf8");
  await writeFile(htmlPath, renderGuidedHtml(item), "utf8");
  return { promptPath, htmlPath };
}

function openWithSystem(urls: string[]): Promise<void> {
  const args = process.platform === "darwin" ? urls : urls.length === 1 ? [urls[0]] : urls;
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const finalArgs = process.platform === "win32" ? ["/c", "start", ...urls] : args;
  return new Promise(resolve => {
    const child = spawn(command, finalArgs, { stdio: "ignore", detached: true });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
    child.unref?.();
  });
}

async function openGuidedBrowser(htmlPath: string, portalUrl: string): Promise<string> {
  const fileUrl = `file://${htmlPath}`;
  await openWithSystem([portalUrl, fileUrl].filter(Boolean));
  return "Opened H-Dnet plus the LeadRider warranty/RMA packet checklist. Fill the draft manually and do not final-submit.";
}

async function pageBodyText(page: any): Promise<string> {
  return page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
}

function isLoginPage(text: string): boolean {
  return /sign in|password|microsoft|enter your email|authenticate/i.test(text) && !/warranty|claim|vehicle|part/i.test(text);
}

async function hasChromeAutofilledInput(page: any, selectors: string[]): Promise<boolean> {
  return page.evaluate((inputSelectors: string[]) => {
    for (const selector of inputSelectors) {
      for (const node of Array.from(document.querySelectorAll(selector))) {
        const input = node as HTMLInputElement;
        if (!input || input.disabled || input.readOnly) continue;
        try {
          if (input.matches?.(":-webkit-autofill")) return true;
        } catch {
          // Never inspect credential values as fallback.
        }
      }
    }
    return false;
  }, selectors).catch(() => false);
}

async function clickLoginAction(page: any, labels: string[]): Promise<boolean> {
  return page.evaluate((buttonLabels: string[]) => {
    const wanted = new Set(buttonLabels.map(label => label.trim().toLowerCase()));
    const candidates = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')) as HTMLElement[];
    for (const node of candidates) {
      const text = String(node.textContent || node.getAttribute("aria-label") || (node instanceof HTMLInputElement ? node.value : "") || "")
        .trim()
        .toLowerCase();
      if (!wanted.has(text)) continue;
      node.click();
      return true;
    }
    return false;
  }, labels).catch(() => false);
}

async function trySavedChromeLogin(page: any, options: RunnerOptions): Promise<{ attempted: boolean; advanced: boolean }> {
  if (!options.useSavedChromeLogin) return { attempted: false, advanced: false };
  let attempted = false;
  for (let step = 0; step < 3; step += 1) {
    const text = await pageBodyText(page);
    const url = page.url();
    if (!isLoginPage(text) && !/login\.microsoftonline\.com/i.test(url)) return { attempted, advanced: attempted };
    const staySignedIn = /stay signed in|keep me signed in/i.test(text);
    const emailReady = await hasChromeAutofilledInput(page, [
      'input[type="email"]',
      'input[name="loginfmt"]',
      'input[name="username"]',
      'input[name="UserName"]'
    ]);
    const passwordReady = await hasChromeAutofilledInput(page, ['input[type="password"]']);
    let clicked = false;
    if (staySignedIn) clicked = await clickLoginAction(page, ["Yes", "Continue"]);
    else if (passwordReady) clicked = await clickLoginAction(page, ["Sign in", "Log in", "Continue", "Submit"]);
    else if (emailReady) clicked = await clickLoginAction(page, ["Next", "Continue", "Sign in"]);
    if (!clicked) break;
    attempted = true;
    await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(4000);
  }
  const finalText = await pageBodyText(page);
  return {
    attempted,
    advanced: attempted && !isLoginPage(finalText) && !/login\.microsoftonline\.com/i.test(page.url())
  };
}

async function locatePortalPage(options: RunnerOptions) {
  const { chromium } = await import("playwright");
  const browser = await chromium.connectOverCDP(options.cdpUrl);
  const pages = browser.contexts().flatMap(context => context.pages());
  let page =
    pages.find(openPage => /h-?dnet\.com|inet\.apps\.h-dnet\.com|login\.microsoftonline\.com/i.test(openPage.url())) ??
    pages.find(openPage => openPage.url() === "about:blank" || openPage.url().startsWith("chrome://newtab")) ??
    (await (browser.contexts()[0] ?? (await browser.newContext())).newPage());
  await page.bringToFront();
  if (!/h-?dnet\.com|inet\.apps\.h-dnet\.com|login\.microsoftonline\.com/i.test(page.url())) {
    await page.goto(options.portalUrl || hDNetHomeUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(4000);
  }
  return { browser, page };
}

async function setFormValueByName(page: any, name: string, value: string): Promise<"filled" | "missing" | "disabled"> {
  return page.evaluate(({ fieldName, nextValue }) => {
    const selector = `[name="${fieldName}"], #${fieldName}`;
    const node = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    if (!node) return "missing";
    if ((node as HTMLInputElement).disabled || (node as HTMLInputElement).readOnly) return "disabled";
    if (node instanceof HTMLSelectElement) {
      const wanted = String(nextValue).trim().toLowerCase();
      const option = Array.from(node.options).find(opt => {
        const value = String(opt.value || "").trim().toLowerCase();
        const text = String(opt.textContent || "").trim().toLowerCase();
        return value === wanted || text === wanted || value.includes(wanted) || text.includes(wanted);
      });
      if (option) node.value = option.value;
      else node.value = String(nextValue);
    } else if (node instanceof HTMLInputElement && (node.type === "checkbox" || node.type === "radio")) {
      node.checked = ["1", "true", "yes", "on", node.value.toLowerCase()].includes(String(nextValue).trim().toLowerCase());
    } else {
      node.value = String(nextValue);
    }
    for (const eventName of ["input", "keyup", "change", "blur"]) {
      node.dispatchEvent(new Event(eventName, { bubbles: true }));
    }
    return "filled";
  }, { fieldName: name, nextValue: value }).catch(() => "missing");
}

async function countVisiblePacketFields(page: any, packet: HdnetDraftPacket) {
  const names = packetFieldRows(packet).map(row => row.name);
  return page.evaluate((fieldNames: string[]) => {
    let count = 0;
    for (const name of fieldNames) {
      const node = document.querySelector(`[name="${name}"], #${name}`) as HTMLElement | null;
      if (node) count += 1;
    }
    return count;
  }, names).catch(() => 0);
}

async function runPlaywrightPortalDraft(
  item: WarrantyRmaCaseEntry,
  options: RunnerOptions
): Promise<{ code: number; summary: string; links?: string[] }> {
  if (!options.cdpUrl) {
    return { code: 2, summary: "Warranty/RMA portal runner needs WARRANTY_RMA_PORTAL_CDP_URL for a logged-in Chrome session." };
  }
  const packet = item.hdnetDraftPacket;
  if (!packet) return { code: 2, summary: "Warranty/RMA case does not have an H-Dnet draft packet yet." };

  const { browser, page } = await locatePortalPage(options);
  let text = await pageBodyText(page);
  if (isLoginPage(text) || /login\.microsoftonline\.com/i.test(page.url())) {
    await trySavedChromeLogin(page, options);
    text = await pageBodyText(page);
  }
  if (isLoginPage(text) || /login\.microsoftonline\.com/i.test(page.url())) {
    const url = page.url();
    await browser.close();
    return {
      code: 2,
      summary: options.useSavedChromeLogin
        ? "H-Dnet login is open. Chrome saved login/autofill was tried when available, but manual login or MFA is still required."
        : "H-Dnet login is open. Sign in manually, then rerun the warranty/RMA portal task.",
      links: [url]
    };
  }

  const presentFieldCount = await countVisiblePacketFields(page, packet);
  if (presentFieldCount === 0 || options.guided) {
    const url = page.url();
    await browser.close();
    return {
      code: 2,
      summary:
        `H-Dnet is open, but the runner is not on a recognizable ${packet.formTitle} form. ` +
        "Open Warranty-Link, choose Add New Short/Long Warranty Claim as appropriate, then rerun this task.",
      links: [url]
    };
  }

  const filled: string[] = [];
  const missingSelectors: string[] = [];
  const disabled: string[] = [];
  for (const row of packetFieldRows(packet)) {
    const result = await setFormValueByName(page, row.name, row.value);
    if (result === "filled") filled.push(row.name);
    else if (result === "disabled") disabled.push(row.name);
    else missingSelectors.push(row.name);
  }
  await page.waitForTimeout(1000);
  const url = page.url();
  await browser.close();

  const parts = [
    `Filled ${filled.length} H-Dnet field${filled.length === 1 ? "" : "s"} for ${item.title}.`,
    missingSelectors.length ? `Missing selectors: ${missingSelectors.slice(0, 24).join(", ")}${missingSelectors.length > 24 ? "..." : ""}.` : "No missing selectors from the packet.",
    disabled.length ? `Skipped disabled/read-only fields: ${disabled.join(", ")}.` : "",
    "The runner did not click final submit; review the open H-Dnet draft before saving/submitting."
  ].filter(Boolean);
  return { code: 0, summary: parts.join(" "), links: [url] };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const localTasks = await loadTasks();
  const localCases = await loadCases();
  const bundles = options.apiBase
    ? await loadRemoteBundles(options)
    : pendingWarrantyTasks(localTasks).map(task => ({
        task,
        case: localCases.find(item => item.id === caseIdFromTask(task)) ?? null
      }));

  if (options.list) {
    if (!bundles.length) {
      console.log("No warranty/RMA portal tasks found.");
      return;
    }
    for (const row of bundles) {
      console.log(`${row.task.id} [${row.task.status}] ${row.task.title}${row.case ? ` -> ${row.case.title}` : ""}`);
    }
    return;
  }

  const bundle = chooseBundle(bundles, options);
  if (!bundle) {
    if (options.idleOk) {
      console.log("No warranty/RMA portal task found.");
      return;
    }
    throw new Error("No warranty/RMA portal task found. Create one from Warranty/RMA Workspace first.");
  }
  if (!bundle.case) throw new Error(`Task ${bundle.task.id} does not reference a saved warranty/RMA case.`);

  const artifacts = await writeArtifacts(bundle.task, bundle.case);
  console.log(`Prepared H-Dnet warranty packet for ${bundle.case.title}.`);
  console.log(`Prompt: ${artifacts.promptPath}`);
  console.log(`Checklist: ${artifacts.htmlPath}`);

  if (options.dryRun || !options.run) {
    if (!options.run) console.log("Pass --run to open the portal runner.");
    return;
  }

  updateTask(localTasks, bundle.task.id, "running", "Warranty/RMA portal runner started.", [
    artifacts.promptPath,
    artifacts.htmlPath
  ]);
  if (options.apiBase) {
    await updateRemoteTask(options, bundle.task.id, "running", "Warranty/RMA portal runner started.", [
      artifacts.promptPath,
      artifacts.htmlPath
    ]);
  } else {
    await saveTasks(localTasks);
  }

  const result = options.guided
    ? { code: 2, summary: await openGuidedBrowser(artifacts.htmlPath, options.portalUrl), links: [artifacts.htmlPath, options.portalUrl] }
    : await runPlaywrightPortalDraft(bundle.case, options);

  const nextStatus: AgentTaskStatus = result.code === 0 ? "completed" : "blocked";
  const summary =
    result.code === 0
      ? `Warranty/RMA portal draft run completed. Review H-Dnet before final submit.\n\n${result.summary}`
      : `Warranty/RMA portal runner blocked before completion.\n\n${result.summary}`;
  const links = [artifacts.promptPath, artifacts.htmlPath, ...(result.links ?? [])];
  updateTask(localTasks, bundle.task.id, nextStatus, summary, links);
  if (options.apiBase) await updateRemoteTask(options, bundle.task.id, nextStatus, summary, links);
  else await saveTasks(localTasks);

  if (result.code === 0) console.log("Warranty/RMA portal draft completed.");
  else {
    console.warn(result.summary);
    process.exitCode = result.code;
  }
}

main().catch(err => {
  console.error(err?.message ?? err);
  process.exit(1);
});
