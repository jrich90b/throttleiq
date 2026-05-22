import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type AgentTaskStatus = "queued" | "needs_approval" | "running" | "completed" | "failed" | "blocked";

type AgentTask = {
  id: string;
  provider: "codex" | "claude";
  kind: string;
  title: string;
  instructions: string;
  status: AgentTaskStatus;
  updatedAt: string;
  output?: {
    summary?: string;
    links?: string[];
    research?: Record<string, unknown>;
  };
};

type MdfUploadedFile = {
  name: string;
  mimeType?: string;
  size?: number;
  url?: string;
  inferredRole?: string;
};

type MdfClaimEntry = {
  id: string;
  title: string;
  status: string;
  notes?: string;
  packet: {
    claimType?: string;
    activityType?: string;
    confidence?: number;
    descriptionDraft?: string;
    missingFields?: string[];
    requiredDocumentation?: string[];
    uploadedFiles?: MdfUploadedFile[];
    extractedFields?: Record<string, string>;
    eligibility?: {
      status?: string;
      concerns?: string[];
    };
  };
  updatedAt: string;
};

type RunnerOptions = {
  taskId?: string;
  claimId?: string;
  dryRun: boolean;
  list: boolean;
  run: boolean;
  guided: boolean;
  portalUrl: string;
  cdpUrl: string;
  apiBase: string;
  token: string;
  maxSteps: string;
};

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

const claimsPath = process.env.MDF_CLAIMS_DB_PATH?.trim()
  ? path.resolve(process.env.MDF_CLAIMS_DB_PATH.trim())
  : path.join(dataDir, "mdf_claims.json");

const runsDir = path.join(dataDir, "mdf_portal_runs");

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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function parseArgs(argv: string[]): RunnerOptions {
  const out: RunnerOptions = {
    dryRun: false,
    list: false,
    run: false,
    guided: false,
    portalUrl: process.env.MDF_PORTAL_URL?.trim() || "",
    cdpUrl: process.env.MDF_PORTAL_CDP_URL?.trim() || process.env.BROWSER_USE_CDP_URL?.trim() || "",
    apiBase: process.env.MDF_PORTAL_API_BASE_URL?.trim() || "",
    token: process.env.MDF_PORTAL_RUNNER_TOKEN?.trim() || process.env.AUTOMATION_RUN_WRITE_TOKEN?.trim() || "",
    maxSteps: process.env.MDF_BROWSER_USE_MAX_STEPS?.trim() || "35"
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--task-id") {
      out.taskId = next;
      i += 1;
    } else if (arg.startsWith("--task-id=")) {
      out.taskId = arg.slice("--task-id=".length);
    } else if (arg === "--claim-id") {
      out.claimId = next;
      i += 1;
    } else if (arg.startsWith("--claim-id=")) {
      out.claimId = arg.slice("--claim-id=".length);
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
    } else if (arg === "--max-steps") {
      out.maxSteps = next;
      i += 1;
    } else if (arg.startsWith("--max-steps=")) {
      out.maxSteps = arg.slice("--max-steps=".length);
    } else if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg === "--list") {
      out.list = true;
    } else if (arg === "--run") {
      out.run = true;
    } else if (arg === "--guided") {
      out.guided = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return out;
}

function printHelp() {
  console.log(`MDF portal runner

Usage:
  npm run mdf:portal -- --list
  npm run mdf:portal -- --dry-run --task-id <agent_task_id>
  MDF_PORTAL_URL="https://..." npm run mdf:portal -- --run --task-id <agent_task_id>

Options:
  --list                    Show pending MDF portal tasks.
  --task-id <id>            Run a specific agent task.
  --claim-id <id>           Run the newest task for a specific MDF claim.
  --portal-url <url>        H-D MDF portal URL. Also supported: MDF_PORTAL_URL.
  --cdp-url <url>           Logged-in Chrome CDP URL. Also supported: MDF_PORTAL_CDP_URL.
  --api-base <url>          Optional live API base. Also supported: MDF_PORTAL_API_BASE_URL.
  --token <token>           Optional runner token. Also supported: MDF_PORTAL_RUNNER_TOKEN.
  --guided                  Open a guided checklist fallback instead of browser-use.
  --dry-run                 Build the packet and prompt without opening a browser.
  --run                     Actually start browser-use or guided browser mode.
`);
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function loadTasks(): Promise<AgentTask[]> {
  const rows = await readJson<unknown>(tasksPath, []);
  return Array.isArray(rows) ? rows.filter(isAgentTask) : [];
}

async function saveTasks(tasks: AgentTask[]) {
  await writeJson(tasksPath, tasks);
}

async function loadClaims(): Promise<MdfClaimEntry[]> {
  const payload = await readJson<{ claims?: MdfClaimEntry[] }>(claimsPath, { claims: [] });
  return Array.isArray(payload.claims) ? payload.claims : [];
}

async function loadRemoteBundles(options: RunnerOptions): Promise<{ task: AgentTask; claim: MdfClaimEntry | null }[]> {
  if (!options.token) throw new Error("MDF_PORTAL_RUNNER_TOKEN or --token is required with --api-base.");
  const base = options.apiBase.replace(/\/$/, "");
  const resp = await fetch(`${base}/mdf/portal-runner/tasks?limit=100`, {
    headers: { Authorization: `Bearer ${options.token}` },
    cache: "no-store"
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Could not load remote MDF portal tasks (${resp.status}): ${text.slice(0, 500)}`);
  const data = JSON.parse(text) as { tasks?: { task?: AgentTask; claim?: MdfClaimEntry | null }[] };
  return (Array.isArray(data.tasks) ? data.tasks : []).filter(row => row?.task?.id).map(row => ({
    task: row.task as AgentTask,
    claim: row.claim ?? null
  }));
}

async function updateRemoteTask(
  options: RunnerOptions,
  id: string,
  status: AgentTaskStatus,
  summary: string,
  links: string[] = []
) {
  if (!options.token) throw new Error("MDF_PORTAL_RUNNER_TOKEN or --token is required with --api-base.");
  const base = options.apiBase.replace(/\/$/, "");
  const resp = await fetch(`${base}/mdf/portal-runner/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.token}`
    },
    body: JSON.stringify({ status, summary, links })
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Could not update remote MDF portal task (${resp.status}): ${text.slice(0, 500)}`);
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

function claimIdFromTask(task: AgentTask): string {
  const match = task.instructions.match(/\[mdf-portal:([^\]]+)\]/);
  return match?.[1] ?? "";
}

function pendingMdfTasks(tasks: AgentTask[]) {
  return tasks
    .filter(task => task.kind === "mdf_portal")
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

function chooseTask(tasks: AgentTask[], options: RunnerOptions): AgentTask | null {
  const rows = pendingMdfTasks(tasks);
  if (options.taskId) return rows.find(task => task.id === options.taskId) ?? null;
  if (options.claimId) return rows.find(task => claimIdFromTask(task) === options.claimId) ?? null;
  return (
    rows.find(task => task.status === "needs_approval" || task.status === "queued") ??
    rows[0] ??
    null
  );
}

function updateTask(tasks: AgentTask[], id: string, status: AgentTaskStatus, summary: string, links: string[] = []) {
  const task = tasks.find(row => row.id === id);
  if (!task) return;
  task.status = status;
  task.updatedAt = new Date().toISOString();
  task.output = {
    ...(task.output ?? {}),
    summary,
    links
  };
}

function buildPrompt(task: AgentTask, claim: MdfClaimEntry, options: RunnerOptions): string {
  const fields = claim.packet.extractedFields ?? {};
  const files = claim.packet.uploadedFiles ?? [];
  const missing = claim.packet.missingFields ?? [];
  const docs = claim.packet.requiredDocumentation ?? [];
  const concerns = claim.packet.eligibility?.concerns ?? [];
  const fileLines = files.map(file => {
    const role = file.inferredRole ? ` (${file.inferredRole.replace(/_/g, " ")})` : "";
    return `- ${file.name}${role}${file.url ? `: ${file.url}` : ""}`;
  });

  return [
    "# LeadRider MDF Portal Draft Task",
    "",
    `Task ID: ${task.id}`,
    `MDF claim ID: ${claim.id}`,
    `Title: ${claim.title}`,
    `Claim status: ${claim.status}`,
    `Portal URL: ${options.portalUrl || "not configured"}`,
    "",
    "## Safety Rules",
    "- You may fill the portal draft and upload supporting files.",
    "- Do not click final submit.",
    "- Stop at the final review/save-draft step.",
    "- If login, MFA, uncertain field mapping, missing documentation, or portal errors block the work, stop and report the blocker.",
    "",
    "## Claim Details",
    `- Claim type: ${claim.packet.claimType || "needs review"}`,
    `- Activity type: ${claim.packet.activityType || "needs review"}`,
    `- Confidence: ${Math.round((claim.packet.confidence || 0) * 100)}%`,
    `- Eligibility status: ${claim.packet.eligibility?.status || "needs review"}`,
    "",
    "## Extracted Fields",
    ...Object.entries(fields).map(([key, value]) => `- ${humanizeKey(key)}: ${value || "missing"}`),
    "",
    "## Description Draft",
    claim.packet.descriptionDraft || "missing",
    "",
    "## Required Documentation",
    ...(docs.length ? docs.map(item => `- ${item}`) : ["- none listed"]),
    "",
    "## Uploaded Files",
    ...(fileLines.length ? fileLines : ["- no saved files"]),
    "",
    "## Missing Fields",
    ...(missing.length ? missing.map(item => `- ${item}`) : ["- none flagged"]),
    "",
    "## Eligibility Concerns",
    ...(concerns.length ? concerns.map(item => `- ${item}`) : ["- none flagged"]),
    "",
    "## Dealer Notes",
    claim.notes || "none",
    "",
    "## Original Task Instructions",
    task.instructions
  ].join("\n");
}

function humanizeKey(key: string) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, char => char.toUpperCase());
}

function htmlEscape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderGuidedHtml(prompt: string, claim: MdfClaimEntry) {
  const files = claim.packet.uploadedFiles ?? [];
  const fields = claim.packet.extractedFields ?? {};
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>MDF Portal Packet - ${htmlEscape(claim.title)}</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: Inter, Arial, sans-serif; background: #0b111c; color: #eef3ff; }
    main { max-width: 980px; margin: 0 auto; padding: 32px; }
    section { border: 1px solid #253145; background: #111827; border-radius: 12px; padding: 20px; margin: 18px 0; }
    h1, h2 { margin: 0 0 12px; }
    h1 { font-size: 30px; }
    h2 { font-size: 20px; color: #f59e0b; }
    dl { display: grid; grid-template-columns: 220px 1fr; gap: 10px 18px; }
    dt { color: #9ca3af; }
    dd { margin: 0; font-weight: 650; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #050b15; border-radius: 10px; padding: 16px; }
    a { color: #93c5fd; }
    .rule { border-color: #f97316; background: #241508; }
    .badge { display: inline-flex; border-radius: 999px; padding: 5px 10px; background: #263247; color: #cbd5e1; }
  </style>
</head>
<body>
  <main>
    <h1>${htmlEscape(claim.title)}</h1>
    <p><span class="badge">LeadRider MDF portal packet</span></p>
    <section class="rule">
      <h2>Stop Rule</h2>
      <p>Fill the draft and upload files only. Do not final-submit the MDF claim.</p>
    </section>
    <section>
      <h2>Fields</h2>
      <dl>
        ${Object.entries(fields)
          .map(([key, value]) => `<dt>${htmlEscape(humanizeKey(key))}</dt><dd>${htmlEscape(value || "missing")}</dd>`)
          .join("\n")}
      </dl>
    </section>
    <section>
      <h2>Files</h2>
      ${
        files.length
          ? `<ul>${files
              .map(file => `<li>${htmlEscape(file.name)}${file.url ? ` - <a href="${htmlEscape(file.url)}">${htmlEscape(file.url)}</a>` : ""}</li>`)
              .join("")}</ul>`
          : "<p>No saved files.</p>"
      }
    </section>
    <section>
      <h2>Full Runner Prompt</h2>
      <pre>${htmlEscape(prompt)}</pre>
    </section>
  </main>
</body>
</html>`;
}

async function canImportBrowserUse(python: string): Promise<boolean> {
  const result = await runProcess(python, ["-c", "import browser_use"], { quiet: true });
  return result.code === 0;
}

async function runProcess(
  command: string,
  args: string[],
  options: { quiet?: boolean; env?: NodeJS.ProcessEnv } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    let stdout = "";
    let stderr = "";
    if (child.stdout) child.stdout.on("data", chunk => (stdout += String(chunk)));
    if (child.stderr) child.stderr.on("data", chunk => (stderr += String(chunk)));
    child.on("close", code => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", err => resolve({ code: 1, stdout, stderr: String(err) }));
  });
}

async function openGuidedBrowser(htmlPath: string, portalUrl: string): Promise<string> {
  const fileUrl = `file://${htmlPath}`;
  const urls = [portalUrl, fileUrl].filter(Boolean);
  if (!urls.length) throw new Error("No portal URL configured.");

  for (const url of urls) {
    await openUrl(url);
  }
  return "Opened the MDF portal plus the LeadRider packet checklist in the desktop browser.";
}

async function openUrl(url: string) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args =
    process.platform === "darwin"
      ? ["-a", "Google Chrome", url]
      : process.platform === "win32"
        ? ["/c", "start", "", url]
        : [url];
  const result = await runProcess(command, args, { quiet: true });
  if (result.code !== 0 && process.platform === "darwin") {
    const fallback = await runProcess("open", [url], { quiet: true });
    if (fallback.code === 0) return;
    throw new Error(fallback.stderr || result.stderr || `Could not open ${url}`);
  }
  if (result.code !== 0) throw new Error(result.stderr || `Could not open ${url}`);
}

async function runBrowserUse(promptPath: string, resultPath: string, options: RunnerOptions): Promise<{ code: number; summary: string }> {
  const python = process.env.MDF_BROWSER_USE_PYTHON?.trim() || "python3";
  const args = [
    path.join(rootDir, "scripts", "mdf_portal_browser_use.py"),
    "--prompt",
    promptPath,
    "--portal-url",
    options.portalUrl,
    "--result",
    resultPath,
    "--max-steps",
    options.maxSteps
  ];
  if (options.cdpUrl) args.push("--cdp-url", options.cdpUrl);
  const result = await runProcess(python, args);
  const payload = await readJson<{ ok?: boolean; blocked?: boolean; summary?: string; error?: string }>(resultPath, {});
  const summary = payload.summary || result.stderr || result.stdout || "browser-use finished without a summary.";
  if (result.code !== 0 || payload.blocked) return { code: result.code || 2, summary };
  return { code: 0, summary };
}

async function isCdpReachable(cdpUrl: string): Promise<boolean> {
  if (!cdpUrl) return false;
  try {
    const url = new URL("/json/version", cdpUrl);
    return await new Promise(resolve => {
      const req = http.get(url, res => {
        res.resume();
        resolve((res.statusCode ?? 500) < 500);
      });
      req.setTimeout(1500, () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
    });
  } catch {
    return false;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const remoteBundles = options.apiBase ? await loadRemoteBundles(options) : null;
  const tasks = remoteBundles ? remoteBundles.map(row => row.task) : await loadTasks();
  const mdfTasks = pendingMdfTasks(tasks);

  if (options.list) {
    if (!mdfTasks.length) {
      console.log("No MDF portal tasks found.");
      return;
    }
    for (const task of mdfTasks.slice(0, 20)) {
      console.log(`${task.id} | ${task.status} | ${claimIdFromTask(task)} | ${task.title}`);
    }
    return;
  }

  const task = chooseTask(tasks, options);
  if (!task) throw new Error("No MDF portal task found. Create one from the MDF Assistant first.");

  const claimId = claimIdFromTask(task);
  if (!claimId) throw new Error(`Task ${task.id} does not include an MDF claim marker.`);

  const claim = remoteBundles
    ? remoteBundles.find(row => row.task.id === task.id)?.claim ?? null
    : (await loadClaims()).find(row => row.id === claimId) ?? null;
  if (!claim) throw new Error(`MDF claim not found for task ${task.id}: ${claimId}`);

  await mkdir(runsDir, { recursive: true });
  const prompt = buildPrompt(task, claim, options);
  const promptPath = path.join(runsDir, `${task.id}.md`);
  const htmlPath = path.join(runsDir, `${task.id}.html`);
  const resultPath = path.join(runsDir, `${task.id}.result.json`);
  await writeFile(promptPath, prompt, "utf8");
  await writeFile(htmlPath, renderGuidedHtml(prompt, claim), "utf8");

  if (options.dryRun || !options.run) {
    console.log(`Prepared MDF portal packet for ${claim.title}.`);
    console.log(`Task: ${task.id}`);
    console.log(`Claim: ${claim.id}`);
    console.log(`Prompt: ${promptPath}`);
    console.log(`Guided checklist: ${htmlPath}`);
    if (!options.run) console.log("Pass --run to open the portal runner.");
    return;
  }

  if (!options.portalUrl) {
    throw new Error("MDF_PORTAL_URL or --portal-url is required before opening the portal.");
  }

  updateTask(tasks, task.id, "running", "MDF portal runner started.", [promptPath, htmlPath]);
  if (remoteBundles) {
    await updateRemoteTask(options, task.id, "running", "MDF portal runner started.", [promptPath, htmlPath]);
  } else {
    await saveTasks(tasks);
  }

  const python = process.env.MDF_BROWSER_USE_PYTHON?.trim() || "python3";
  const browserUseAvailable = !options.guided && (await canImportBrowserUse(python));
  const cdpOk = options.cdpUrl ? await isCdpReachable(options.cdpUrl) : false;

  if (!browserUseAvailable) {
    const cdpNote =
      options.cdpUrl && !cdpOk
        ? " The configured Chrome CDP URL was not reachable, so the guided fallback opened the normal desktop browser."
        : "";
    const summary = await openGuidedBrowser(htmlPath, options.portalUrl);
    updateTask(
      tasks,
      task.id,
      "needs_approval",
      `${summary}${cdpNote} browser-use is not installed/configured, so this run is guided and still needs manual portal completion. Prompt: ${promptPath}`,
      [promptPath, htmlPath, options.portalUrl]
    );
    if (remoteBundles) {
      await updateRemoteTask(
        options,
        task.id,
        "needs_approval",
        `${summary}${cdpNote} browser-use is not installed/configured, so this run is guided and still needs manual portal completion. Prompt: ${promptPath}`,
        [promptPath, htmlPath, options.portalUrl]
      );
    } else {
      await saveTasks(tasks);
    }
    console.log("Guided MDF portal packet opened.");
    return;
  }

  const result = await runBrowserUse(promptPath, resultPath, options);
  if (result.code === 0) {
    updateTask(
      tasks,
      task.id,
      "needs_approval",
      `browser-use completed the MDF draft run. Review the portal before any final submit.\n\n${result.summary}`,
      [promptPath, resultPath, options.portalUrl]
    );
  } else {
    updateTask(
      tasks,
      task.id,
      "blocked",
      `MDF portal runner blocked before completion.\n\n${result.summary}`,
      [promptPath, resultPath, options.portalUrl]
    );
  }
  if (remoteBundles) {
    const latest = tasks.find(row => row.id === task.id) ?? task;
    await updateRemoteTask(
      options,
      task.id,
      latest.status,
      latest.output?.summary ?? "",
      latest.output?.links ?? []
    );
  } else {
    await saveTasks(tasks);
  }
}

main().catch(err => {
  console.error(err?.message ?? err);
  process.exit(1);
});
