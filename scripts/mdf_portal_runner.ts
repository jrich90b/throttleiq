import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANSIRA_FORM_CONTROLS,
  ansiraFormChangedSummary,
  ansiraMarketingOptionSummary,
  findMissingFormControls,
  marketingActivityOptionIssue
} from "./mdf_portal_preflight.ts";

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
  providedRole?: string;
};

type MdfPortalInvoice = {
  vendorName?: string;
  invoiceDate?: string;
  invoiceNumber?: string;
  amount?: string;
  fileNames?: string[];
  description?: string;
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
    invoices?: MdfPortalInvoice[];
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
  idleOk: boolean;
  portalUrl: string;
  launcherUrl: string;
  recapEntryUrl: string;
  cdpUrl: string;
  apiBase: string;
  token: string;
  maxSteps: string;
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

const claimsPath = process.env.MDF_CLAIMS_DB_PATH?.trim()
  ? path.resolve(process.env.MDF_CLAIMS_DB_PATH.trim())
  : path.join(dataDir, "mdf_claims.json");

const runsDir = path.join(dataDir, "mdf_portal_runs");
const runnerMachinePath = process.env.MDF_PORTAL_RUNNER_MACHINE_PATH?.trim()
  ? path.resolve(process.env.MDF_PORTAL_RUNNER_MACHINE_PATH.trim())
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
    idleOk: false,
    portalUrl: process.env.MDF_HDNET_URL?.trim() || hDNetHomeUrl,
    // Direct SSO launcher for the MDF (Ansira) app — the toolbox > Marketing Development
    // Fund item's real href (discovered 2026-06-17 via CDP). Navigating here SSO's
    // straight into app.ansira.com, bypassing the un-clickable SharePoint toolbox widget
    // and the same-named SharePoint reference page (…/MARKETING-DEVELOPMENT-FUND.aspx).
    // Tenant/app-specific (americanharley); override per dealer via MDF_PORTAL_LAUNCHER_URL.
    launcherUrl:
      process.env.MDF_PORTAL_LAUNCHER_URL?.trim() ||
      "https://launcher.myapps.microsoft.com/api/signin/6fed78a2-dbcb-4685-a0b9-3033ab4a4dd1?tenantId=625f2ee0-190f-4e6f-9cbb-be276a887c4d",
    // The MDF Recap list page (verified 6/17). The recap form at …/claims/create only
    // renders when instantiated via the "Create MDF Recap" button on THIS list page — a
    // direct nav to …/claims/create does not stick. So land here, then click Create.
    recapEntryUrl:
      process.env.MDF_PORTAL_RECAP_ENTRY_URL?.trim() ||
      "https://app.ansira.com/member/reimbursements/claims",
    cdpUrl: process.env.MDF_PORTAL_CDP_URL?.trim() || process.env.BROWSER_USE_CDP_URL?.trim() || "",
    apiBase: process.env.MDF_PORTAL_API_BASE_URL?.trim() || "",
    token: process.env.MDF_PORTAL_RUNNER_TOKEN?.trim() || process.env.AUTOMATION_RUN_WRITE_TOKEN?.trim() || "",
    maxSteps: process.env.MDF_BROWSER_USE_MAX_STEPS?.trim() || "35",
    useSavedChromeLogin: osFlag("MDF_PORTAL_USE_SAVED_CHROME_LOGIN", true)
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
  console.log(`MDF portal runner

Usage:
  npm run mdf:portal -- --list
  npm run mdf:portal -- --dry-run --task-id <agent_task_id>
  npm run mdf:portal -- --run --task-id <agent_task_id>

Options:
  --list                    Show pending MDF portal tasks.
  --task-id <id>            Run a specific agent task.
  --claim-id <id>           Run the newest task for a specific MDF claim.
  --portal-url <url>        H-DNet start URL. Also supported: MDF_HDNET_URL.
  --cdp-url <url>           Logged-in Chrome CDP URL. Also supported: MDF_PORTAL_CDP_URL.
  --api-base <url>          Optional live API base. Also supported: MDF_PORTAL_API_BASE_URL.
  --token <token>           Optional runner token. Also supported: MDF_PORTAL_RUNNER_TOKEN.
  --use-saved-login         Let Chrome saved login/autofill advance H-DNet login when available.
  --no-saved-login          Stop immediately when H-DNet login is required.
  --guided                  Open a guided checklist fallback instead of browser-use.
  --idle-ok                 Exit cleanly when no MDF portal task is available.
  --dry-run                 Build the packet and prompt without opening a browser.
  --run                     Actually start the portal runner or guided browser mode.
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
    headers: {
      Authorization: `Bearer ${options.token}`,
      ...await runnerIdentityHeaders()
    },
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
      Authorization: `Bearer ${options.token}`,
      ...await runnerIdentityHeaders()
    },
    body: JSON.stringify({ status, summary, links })
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Could not update remote MDF portal task (${resp.status}): ${text.slice(0, 500)}`);
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
    if (id) return { id, name: String(parsed.name ?? "").trim() || os.hostname() || "MDF Runner" };
  } catch {
    // Create a stable ID for this installed runner.
  }
  const identity = {
    id: randomUUID(),
    name: os.hostname() || "MDF Runner"
  };
  await mkdir(path.dirname(runnerMachinePath), { recursive: true });
  await writeFile(runnerMachinePath, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
  return identity;
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

function isHNetLoginTask(task: AgentTask): boolean {
  return /\[mdf-login\]/.test(task.instructions);
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
  // RUN ONCE: MDF tasks are created as needs_approval (approval.required); the runner
  // stamps output ("MDF portal runner started.") the moment it begins. Only pick a task
  // that has NOT run yet (no output) — otherwise a completed task stays needs_approval
  // and the daemon re-runs it every tick, clicking "Create MDF Recap" and spawning a NEW
  // draft each time. A task that needs retrying must be re-triggered (a fresh task).
  return (
    rows.find(
      task =>
        (task.status === "needs_approval" || task.status === "queued") &&
        !String(task.output?.summary ?? "").trim()
    ) ?? null
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
  const invoices = invoiceRecordsForClaim(claim);
  const missing = claim.packet.missingFields ?? [];
  const docs = claim.packet.requiredDocumentation ?? [];
  const concerns = claim.packet.eligibility?.concerns ?? [];
  // Map our claim type to the Ansira "Marketing Activity" dropdown option (form fields
  // mapped from the live form 2026-06-17). Year prefix comes from the activity start date.
  const claimTypeLc = String(claim.packet.claimType ?? "").toLowerCase();
  const activityTypeLc = String(claim.packet.activityType ?? "").toLowerCase();
  const activityYear = String(fields.activityStartDate ?? "").slice(0, 4) || new Date().getFullYear().toString();
  const marketingActivity =
    claimTypeLc.includes("event") || activityTypeLc.includes("event")
      ? `${activityYear} Event Claim`
      : claimTypeLc.includes("map") || activityTypeLc.includes("map")
        ? "Minimum Advertised Price (MAP) Only"
        : `${activityYear} Media Claim`;
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
    "- CRITICAL: to save the draft click the **\"Save for Later\"** button. NEVER click **\"Submit\"** — \"Submit\" final-submits the claim. \"Save for Later\" is the only save action you may use.",
    "- Stop after \"Save for Later\" (or at the final review step) and report what was filled.",
    "- If login, MFA, uncertain field mapping, missing documentation, or portal errors block the work, stop and report the blocker.",
    `- PRIMARY ROUTE — do this FIRST: navigate the current tab directly to the MDF SSO launcher URL: ${options.launcherUrl} . This is the H-DNet single sign-on launcher; it lands you in the Ansira MDF app (app.ansira.com). You do NOT need the toolbox.`,
    "- If a tab is ALREADY on `app.ansira.com`, just switch to it — you are already in.",
    "- Do NOT click the SharePoint page link whose URL ends in `MARKETING-DEVELOPMENT-FUND.aspx` — that is a reference/info DOC, not the app. The toolbox header icon (`.avaQuickLinksExtension.headerExtension`) is a non-clickable `<div>` widget; do NOT loop trying to click it.",
    "- ARRIVAL CHECK: once ANY open tab is on `app.ansira.com` and is NOT a sign-in page (e.g. `app.ansira.com/member/...`), you have reached the MDF portal — switch to that tab and work there.",
    "- In the Ansira MDF app, go to the claims / MDF area and click `Create Claim` (or open the matching existing draft for this campaign), then fill the fields below from the packet and upload the listed files. Save as draft or stop at the review step — never final submit.",
    options.useSavedChromeLogin
      ? "- If H-DNet/Microsoft login appears and Chrome has already autofilled saved credentials, you may click Next/Sign in. Do not read, type, copy, reveal, or transmit credentials. Stop for manual login/MFA if autofill is not already present."
      : "- If the browser is not logged into H-DNet, stop on the H-DNet/Microsoft login screen and let the user sign in manually.",
    "- Only a SIGN-IN page (H-DNet/Microsoft, or an Ansira login page asking for credentials) is a stop condition — stop and let the user log in. The logged-in Ansira app (`app.ansira.com/member/...`) is the DESTINATION, not a blocker: do NOT navigate it back to h-dnet.com.",
    "",
    "## Ansira Create-Claim Form — fill these EXACT fields",
    `0a. As soon as any tab is on app.ansira.com (logged in), navigate that tab DIRECTLY to: ${options.recapEntryUrl} (the MDF Recap list page). Do NOT hunt menus, the toolbox, or Orders & Activity.`,
    "0b. On that list page, click the **\"Create MDF Recap\"** button to open the recap form (it lands on …/reimbursements/claims/create). If a tab is already on …/claims/create, just use it.",
    `1. "Marketing Activity *" dropdown (#app-marketing-activity): choose "${marketingActivity}" (the option matching this claim's type and activity year).`,
    "2. Pre-approval radios: select **\"No, continue without a pre-approval\"** (unless a pre-approval ID is provided in the packet — then choose \"Yes\" and enter it).",
    "3. \"Activity Start Date\" (#app-claim-start-date) and \"Activity End Date\" (#app-claim-end-date): use the Activity start/end dates from Extracted Fields below.",
    "4. \"Currency *\" (#app-claim-currency): select USD.",
    `5. "Claim Name *" (#app-claim-name): "${(fields.campaignName || claim.title || "").toString().slice(0, 90)}".`,
    "6. \"Additional Notes\" (#app-additional-notes): paste the Description Draft below.",
    `7. Invoice section — this packet has ${invoices.length} invoice(s); you MUST end with exactly ${invoices.length} invoice row(s) filled. The form starts with row 1 already present. For EACH additional invoice, click "Add Additional Invoice" (id=app-add-invoice) to create a new row, THEN fill that row's Vendor Name, Invoice Date, Invoice Number, Invoice Amount (fields invoices[n][vendor_name|invoice_date|invoice_number|invoice_amount]). Do NOT save with fewer invoice rows than invoices listed below, and verify every row has all four values + its file + its "Invoice" category.`,
    "8. UPLOADS — the packet files are downloaded locally and provided to your upload action. Match each file to the RIGHT control, exactly ONCE (the form re-indexes between steps — before uploading, check what is already attached and do NOT re-upload a file or attach the same file to two controls):",
    "   8a. INVOICE files (the PDFs listed with role=invoice / named in each invoice's 'files=' above): upload each invoice's PDF to THAT invoice row's own Upload File control — invoice #1's PDF on row #1, invoice #2's PDF on row #2. Never put the same PDF on more than one row.",
    "   8b. SUPPORTING documents (the files marked '(supporting only)' above — the .xlsx files): upload these ONLY to the separate \"Supporting Documents\" upload area, never onto an invoice row.",
    "   8c. REQUIRED before saving — each uploaded file has its own CATEGORY dropdown that defaults to \"-- Select --\"; if ANY is left blank the save fails with a database/foreign-key error. Set them by their field NAME (the visible option text is what you select):",
    "       • On EACH invoice row, the dropdown named `invoices[N][files][0][file_category]` (N = the invoice number) → select \"Invoice\". Do this for invoice #1 AND invoice #2 — this is the one most often missed.",
    "       • In the Supporting Documents / additional-files area, each dropdown named `files[N][file_category]` → select \"Supporting Documentation\".",
    "       • Then VERIFY no category dropdown still reads \"-- Select --\" before clicking Save for Later. If the form re-rendered, re-check.",
    "9. \"Claimed Amount\" (#app-claimed-amount): the media amount being claimed — default to the eligible invoice total unless the packet/eligibility notes say otherwise.",
    "10. SAVE THE DRAFT: click **\"Save for Later\"** (id app-draft-submit-btn). Do NOT click \"Submit\". Once you have clicked Save for Later you are DONE — immediately report what was filled/uploaded and what still needs human attention (Missing Fields / Eligibility Concerns below) and STOP. Do NOT keep searching the page for a 'saved' confirmation banner; one may not appear.",
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
    "## Invoices",
    ...(invoices.length
      ? invoices.map((invoice, index) => {
          const bits = [
            `vendor=${invoice.vendorName || "missing"}`,
            `date=${invoice.invoiceDate || "missing"}`,
            `number=${invoice.invoiceNumber || "missing"}`,
            `amount=${invoice.amount || "missing"}`,
            `files=${(invoice.fileNames ?? []).join(", ") || "not matched"}`
          ];
          return `- Invoice ${index + 1}: ${bits.join("; ")}`;
        })
      : ["- no separate invoice records; use extracted fields if present"]),
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
  const invoices = invoiceRecordsForClaim(claim);
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
      <h2>Invoices</h2>
      <ul>
        ${
          invoices.length
            ? invoices
                .map(
                  (invoice, index) =>
                    `<li>Invoice ${index + 1}: ${htmlEscape(invoice.vendorName || "Vendor missing")} / ${htmlEscape(
                      invoice.invoiceDate || "date missing"
                    )} / ${htmlEscape(invoice.invoiceNumber || "number missing")} / ${htmlEscape(
                      invoice.amount || "amount missing"
                    )}<br />Files: ${htmlEscape((invoice.fileNames ?? []).join(", ") || "not matched")}</li>`
                )
                .join("\n")
            : "<li>No separate invoice records found.</li>"
        }
      </ul>
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
  options: { quiet?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise(resolve => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: rootDir,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: options.input ? ["pipe", "pipe", "pipe"] : options.quiet ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    const finish = (code: number, extraStderr = "") => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr: `${stderr}${extraStderr}` });
    };
    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGTERM");
            setTimeout(() => {
              if (!settled) child.kill("SIGKILL");
            }, 3000).unref();
            finish(124, `\nProcess timed out after ${Math.round(options.timeoutMs! / 1000)}s.`);
          }, options.timeoutMs).unref()
        : null;
    let stdout = "";
    let stderr = "";
    if (child.stdout) child.stdout.on("data", chunk => (stdout += String(chunk)));
    if (child.stderr) child.stderr.on("data", chunk => (stderr += String(chunk)));
    if (options.input && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    }
    child.on("close", code => finish(code ?? 1));
    child.on("error", err => finish(1, String(err)));
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

// The packet's uploaded files are remote URLs; browser-use can only attach LOCAL files
// (and only ones in available_file_paths). Download them next to the prompt so the agent
// can upload them. Best-effort: a file that won't download is skipped (the agent reports
// it as still-needed rather than failing the whole run).
async function downloadClaimFiles(claim: any, destDir: string, token?: string): Promise<string[]> {
  const files = Array.isArray(claim?.packet?.uploadedFiles) ? claim.packet.uploadedFiles : [];
  if (!files.length) return [];
  await mkdir(destDir, { recursive: true });
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const out: string[] = [];
  for (const f of files) {
    const url = String(f?.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const name = (String(f?.name ?? "").trim() || `file-${out.length + 1}`).replace(/[^\w.\-]+/g, "_");
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        console.warn(`[mdf] file download HTTP ${res.status} for ${name}`);
        continue;
      }
      const dest = path.join(destDir, name);
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      out.push(dest);
    } catch (err: any) {
      console.warn(`[mdf] file download error for ${name}: ${err?.message ?? err}`);
    }
  }
  return out;
}

async function runBrowserUse(promptPath: string, resultPath: string, options: RunnerOptions, filesDir?: string): Promise<{ code: number; summary: string }> {
  const python = process.env.MDF_BROWSER_USE_PYTHON?.trim() || "python3";
  const args = [
    path.join(rootDir, "scripts", "mdf_portal_browser_use.py"),
    "--prompt",
    promptPath,
    // Start browser-use on the MDF Recap list page (live M365 session auto-SSOs Ansira),
    // so it lands one click from the form — it just clicks "Create MDF Recap". Falls back
    // to the launcher / h-dnet if unset.
    "--portal-url",
    options.recapEntryUrl || options.launcherUrl || options.portalUrl,
    "--result",
    resultPath,
    "--max-steps",
    options.maxSteps
  ];
  if (filesDir) args.push("--files-dir", filesDir);
  if (options.cdpUrl) args.push("--cdp-url", options.cdpUrl);
  const timeoutSeconds = Math.max(60, Number(process.env.MDF_BROWSER_USE_TIMEOUT_SECONDS ?? "600"));
  const result = await runProcess(python, args, { timeoutMs: timeoutSeconds * 1000 });
  const payload = await readJson<{ ok?: boolean; blocked?: boolean; summary?: string; error?: string }>(resultPath, {});
  const summary = payload.summary || result.stderr || result.stdout || "browser-use finished without a summary.";
  if (result.code !== 0 || payload.blocked) return { code: result.code || 2, summary };
  return { code: 0, summary };
}

async function runBrowserHarnessRescue(
  promptPath: string,
  htmlPath: string,
  options: RunnerOptions,
  blockedSummary: string
): Promise<{ code: number; summary: string; links: string[] }> {
  if (!options.cdpUrl) {
    return { code: 2, summary: "browser-harness rescue needs MDF_PORTAL_CDP_URL for the runner browser.", links: [] };
  }

  const defaultBrowserHarness = path.join(os.homedir(), "bin", "browser-harness");
  const browserHarness = process.env.MDF_BROWSER_HARNESS_BIN?.trim() || (existsSync(defaultBrowserHarness) ? defaultBrowserHarness : "browser-harness");
  const htmlUrl = `file://${htmlPath}`;
  const portalUrl = options.portalUrl || hDNetHomeUrl;
  const script = `
import json
import time

portal_url = ${JSON.stringify(portalUrl)}
html_url = ${JSON.stringify(htmlUrl)}
prompt_path = ${JSON.stringify(promptPath)}
blocked_summary = ${JSON.stringify(blockedSummary.slice(0, 1200))}
use_saved_chrome_login = ${options.useSavedChromeLogin ? "True" : "False"}

def safe_js(expr):
    try:
        return js(expr)
    except Exception as exc:
        return {"error": str(exc)}

try:
    tid = new_tab(portal_url)
    cdp("Target.activateTarget", targetId=tid)
    switch_tab(tid)
    wait_for_load()
    time.sleep(2)
    before = page_info()
    text_info = safe_js("""
(() => {
  const text = document.body?.innerText || '';
  return {
    login: /sign in|password|microsoft|enter your email|authenticate/i.test(text) && !/Create Claim/i.test(text),
    hasToolbox: !!document.querySelector('.avaQuickLinksExtension.headerExtension'),
    hasCreateClaim: /Create Claim/i.test(text),
    url: location.href,
    title: document.title
  };
})()
""")
    toolbox_clicked = False
    mdf_clicked = False
    saved_login_clicked = False
    if isinstance(text_info, dict) and text_info.get("login") and use_saved_chrome_login:
        saved_login_clicked = bool(safe_js("""
(() => {
  const autofilled = (selectors) => selectors.some(selector =>
    [...document.querySelectorAll(selector)].some(node => {
      if (node.disabled || node.readOnly) return false;
      try { if (node.matches(':-webkit-autofill')) return true; } catch {}
      return false;
    })
  );
  const click = (labels) => {
    const wanted = new Set(labels.map(label => label.toLowerCase()));
    const nodes = [...document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')];
    const el = nodes.find(node => wanted.has(String(node.textContent || node.getAttribute('aria-label') || node.value || '').trim().toLowerCase()));
    if (!el) return false;
    el.click();
    return true;
  };
  const text = document.body?.innerText || '';
  if (/stay signed in|keep me signed in/i.test(text)) return click(['yes', 'continue']);
  if (autofilled(['input[type="password"]'])) return click(['sign in', 'log in', 'continue', 'submit']);
  if (autofilled(['input[type="email"]', 'input[name="loginfmt"]', 'input[name="username"]', 'input[name="UserName"]'])) return click(['next', 'continue', 'sign in']);
  return false;
})()
"""))
        time.sleep(5)
        text_info = safe_js("""
(() => {
  const text = document.body?.innerText || '';
  return {
    login: /sign in|password|microsoft|enter your email|authenticate/i.test(text) && !/Create Claim/i.test(text),
    hasToolbox: !!document.querySelector('.avaQuickLinksExtension.headerExtension'),
    hasCreateClaim: /Create Claim/i.test(text),
    url: location.href,
    title: document.title
  };
})()
""")
    if isinstance(text_info, dict) and text_info.get("hasToolbox") and not text_info.get("login"):
        toolbox_clicked = bool(safe_js("""
(() => {
  const el = document.querySelector('.avaQuickLinksExtension.headerExtension');
  if (!el) return false;
  el.click();
  return true;
})()
"""))
        time.sleep(2)
        mdf_clicked = bool(safe_js("""
(() => {
  const nodes = [...document.querySelectorAll('a, button, [role="button"], div, span')];
  const el = nodes.find(node => /^\\s*Marketing Development Fund\\s*$/i.test(node.textContent || ''));
  if (!el) return false;
  el.click();
  return true;
})()
"""))
        time.sleep(5)
    packet_tid = new_tab(html_url)
    cdp("Target.activateTarget", targetId=packet_tid)
    switch_tab(packet_tid)
    wait_for_load()
    packet_info = page_info()
    print(json.dumps({
        "ok": True,
        "portalBefore": before,
        "portalProbe": text_info,
        "toolboxClicked": toolbox_clicked,
        "mdfClicked": mdf_clicked,
        "savedLoginClicked": saved_login_clicked,
        "packet": packet_info,
        "promptPath": prompt_path,
        "htmlUrl": html_url,
        "blockedSummary": blocked_summary,
    }))
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc), "htmlUrl": html_url, "promptPath": prompt_path}))
`;

  const timeoutSeconds = Math.max(30, Number(process.env.MDF_BROWSER_HARNESS_TIMEOUT_SECONDS ?? "90"));
  const result = await runProcess(browserHarness, [], {
    quiet: true,
    timeoutMs: timeoutSeconds * 1000,
    input: script,
    env: {
      BU_CDP_URL: options.cdpUrl,
      BH_AGENT_WORKSPACE: path.join(os.homedir(), "Developer", "browser-harness", "agent-workspace")
    }
  });
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  const lastLine = lines[lines.length - 1] ?? "";
  let payload: any = null;
  try {
    payload = lastLine ? JSON.parse(lastLine) : null;
  } catch {
    payload = null;
  }
  if (result.code !== 0 || !payload?.ok) {
    const error = payload?.error || result.stderr || result.stdout || "browser-harness rescue did not return a usable result.";
    return { code: result.code || 2, summary: `browser-harness rescue failed: ${error}`, links: [htmlUrl, promptPath] };
  }
  const probe = payload.portalProbe && typeof payload.portalProbe === "object" ? payload.portalProbe : {};
  const state = probe.login
    ? payload.savedLoginClicked
      ? "The runner tried Chrome saved login/autofill, but the browser is still on the H-DNet/Microsoft login path."
      : "The runner browser is on the H-DNet/Microsoft login path."
    : payload.mdfClicked
      ? "The runner clicked the H-DNet toolbox MDF link and opened the packet checklist."
      : probe.hasToolbox
        ? "The runner opened H-DNet and found the toolbox, but did not confirm the MDF link click."
        : "The runner opened the packet checklist and left H-DNet/Ansira visible for manual recovery.";
  return {
    code: 0,
    summary: [
      "Deterministic MDF portal runner blocked before completion.",
      state,
      "A browser-harness recovery tab opened the LeadRider MDF packet checklist in the same runner Chrome session.",
      "Use the visible packet to finish/save the Ansira draft manually. Do not final-submit without review.",
      "",
      `Original blocker: ${blockedSummary.slice(0, 1200)}`
    ].join("\n"),
    links: [htmlUrl, promptPath, String(probe.url || portalUrl)]
  };
}

function extractedField(claim: MdfClaimEntry, keys: string[]): string {
  const fields = claim.packet.extractedFields ?? {};
  for (const key of keys) {
    const value = String(fields[key] ?? "").trim();
    if (value && !/^missing$/i.test(value)) return value;
  }
  return "";
}

function toUsDate(value: string): string {
  const trimmed = value.trim();
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  const us = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return `${us[1].padStart(2, "0")}/${us[2].padStart(2, "0")}/${us[3]}`;
  return trimmed;
}

function moneyValue(value: string): string {
  const cleaned = value.replace(/[^0-9.]/g, "");
  return cleaned || value.trim();
}

function roleForFile(file: MdfUploadedFile): string {
  return String(file.providedRole || file.inferredRole || "").trim().toLowerCase();
}

function isInvoiceFile(file: MdfUploadedFile): boolean {
  const role = roleForFile(file);
  return role.includes("invoice") || role.includes("receipt") || /invoice|receipt|inv[_\s-]?\d+/i.test(file.name);
}

function normalizeFileName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\w.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMoneyAmount(value: string): number {
  const cleaned = String(value || "").replace(/[^0-9.-]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function moneyFromNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  return value.toFixed(2);
}

function fallbackInvoiceFromFlatFields(claim: MdfClaimEntry): MdfPortalInvoice | null {
  const vendorName = extractedField(claim, ["vendorName", "vendor", "vendor_name"]);
  const invoiceDate = extractedField(claim, ["invoiceDate", "invoice_date"]);
  const invoiceNumber = extractedField(claim, ["invoiceNumber", "invoice_number"]);
  const amount = extractedField(claim, ["spend", "amount", "invoiceAmount", "invoice_amount"]);
  if (!vendorName && !invoiceDate && !invoiceNumber && !amount) return null;
  return { vendorName, invoiceDate, invoiceNumber, amount, fileNames: [], description: "" };
}

function invoiceRecordsForClaim(claim: MdfClaimEntry): MdfPortalInvoice[] {
  const fromPacket = Array.isArray(claim.packet.invoices)
    ? claim.packet.invoices
        .map(row => ({
          vendorName: String(row.vendorName ?? "").trim(),
          invoiceDate: String(row.invoiceDate ?? "").trim(),
          invoiceNumber: String(row.invoiceNumber ?? "").trim(),
          amount: String(row.amount ?? "").trim(),
          fileNames: Array.isArray(row.fileNames) ? row.fileNames.map(name => String(name)).filter(Boolean) : [],
          description: String(row.description ?? "").trim()
        }))
        .filter(row => row.vendorName || row.invoiceDate || row.invoiceNumber || row.amount || row.fileNames.length)
    : [];
  if (fromPacket.length) return fromPacket;
  const fallback = fallbackInvoiceFromFlatFields(claim);
  return fallback ? [fallback] : [];
}

function filesForInvoice(invoice: MdfPortalInvoice, files: MdfUploadedFile[], assignedNames: Set<string>): MdfUploadedFile[] {
  const requested = new Set((invoice.fileNames ?? []).map(normalizeFileName).filter(Boolean));
  const exactMatches = requested.size
    ? files.filter(file => {
        const normalized = normalizeFileName(file.name);
        return requested.has(normalized) || [...requested].some(name => normalized.includes(name) || name.includes(normalized));
      })
    : [];
  const matches = exactMatches.length ? exactMatches : files.filter(file => isInvoiceFile(file) && !assignedNames.has(file.name));
  for (const file of matches) assignedNames.add(file.name);
  return matches;
}

async function downloadPortalFile(file: MdfUploadedFile, dir: string): Promise<string | null> {
  if (!file.url) return null;
  const safeName = file.name.replace(/[^\w.\-() ]+/g, "_").slice(0, 160) || "upload";
  const target = path.join(dir, safeName);
  const resp = await fetch(file.url);
  if (!resp.ok) throw new Error(`Could not download ${file.name}: ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  await writeFile(target, buffer);
  return target;
}

async function fillText(page: any, selector: string, value: string) {
  const locator = page.locator(selector).first();
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ force: true }).catch(() => {});
  await locator.fill("").catch(() => {});
  await locator.fill(value).catch(async () => {
    await locator.evaluate((el: HTMLInputElement | HTMLTextAreaElement, next: string) => {
      el.value = next;
    }, value);
  });
  await locator.evaluate((el: HTMLElement) => {
    for (const name of ["input", "keyup", "change", "blur"]) {
      el.dispatchEvent(new Event(name, { bubbles: true }));
    }
  });
}

async function selectOptionByText(page: any, selector: string, text: string) {
  const value = await page.locator(`${selector} option`, { hasText: text }).first().getAttribute("value");
  if (!value) throw new Error(`Could not find option "${text}" in ${selector}`);
  await page.selectOption(selector, value);
  await page.locator(selector).dispatchEvent("change");
}

async function ensureInvoiceSection(page: any, index: number) {
  if (index <= 1) return;
  const vendorSelector = `input[name="invoices[${index}][vendor_name]"]`;
  if (await page.locator(vendorSelector).count()) return;
  await page.locator("#app-add-invoice").scrollIntoViewIfNeeded();
  await page.locator("#app-add-invoice").click();
  await page.locator(vendorSelector).waitFor({ timeout: 10_000 });
}

async function setInvoiceFileCategories(page: any, invoiceIndex: number) {
  const count = await page.locator(`select[name^="invoices[${invoiceIndex}][files]"][name$="[file_category]"]`).count();
  for (let i = 0; i < count; i += 1) {
    const selector = `select[name="invoices[${invoiceIndex}][files][${i}][file_category]"]`;
    if (await page.locator(selector).count()) {
      await selectOptionByText(page, selector, "Invoice").catch(() => {});
    }
  }
}

async function fillInvoiceSection(page: any, index: number, invoice: MdfPortalInvoice) {
  await ensureInvoiceSection(page, index);
  const vendor = String(invoice.vendorName ?? "").trim();
  const invoiceDate = toUsDate(String(invoice.invoiceDate ?? "").trim());
  const invoiceNumber = String(invoice.invoiceNumber ?? "").trim();
  const amount = moneyValue(String(invoice.amount ?? "").trim());
  if (vendor) await fillText(page, `input[name="invoices[${index}][vendor_name]"]`, vendor);
  if (invoiceDate) await fillText(page, `input[name="invoices[${index}][invoice_date]"]`, invoiceDate);
  if (invoiceNumber) await fillText(page, `input[name="invoices[${index}][invoice_number]"]`, invoiceNumber);
  if (amount) await fillText(page, `input[name="invoices[${index}][invoice_amount]"]`, amount);
}

function portalClaimTypeLabel(claim: MdfClaimEntry): string | null {
  const claimType = String(claim.packet.claimType || "").toLowerCase();
  if (claimType === "media") return "2026 Media Claim";
  if (claimType === "event") return "2026 Event Claim";
  if (claimType === "map_only") return "Minimum Advertised Price (MAP) Only";
  return null;
}

function eventSubType(claim: MdfClaimEntry): string {
  const source = `${claim.packet.activityType || ""} ${claim.title || ""} ${claim.packet.descriptionDraft || ""}`.toLowerCase();
  if (/demo|test\s*ride|ride\s*event/.test(source)) return "Event - Dealer Demo Ride";
  if (/sponsor/.test(source)) return "Event - Sponsorships";
  if (/off[\s-]?site|remote|fair|festival|show|outside/.test(source)) return "Event - Local Off-Site";
  if (/national|corporate/.test(source)) return "Event - National / Corporate Led";
  return "Event - Local On Site";
}

function mediaSubType(claim: MdfClaimEntry): string {
  const source = `${claim.packet.activityType || ""} ${claim.title || ""} ${claim.packet.descriptionDraft || ""}`.toLowerCase();
  if (/email|text|sms/.test(source)) return "MEDIA - Email & Text Marketing Campaigns";
  if (/direct\s*mail|mailer/.test(source)) return "MEDIA - Direct Mail";
  if (/social|facebook|instagram|meta/.test(source)) return "MEDIA - Social Media Advertising";
  if (/google|search|sem/.test(source)) return "MEDIA - Search Engine Marketing";
  if (/billboard|ooh|wrap|transit/.test(source)) return "MEDIA - OOH (Billboards / Transit/ Vehicle Wraps)";
  if (/video|pre[\s-]?roll|ott|ctv/.test(source)) return "MEDIA - Digital Video Ads / Pre-Roll / OLV / OTT / CTV";
  if (/website|trade/.test(source)) return "MEDIA - Website Trade Tools";
  if (/radio/.test(source)) return source.includes("internet") ? "MEDIA - Internet Radio" : "MEDIA - Terrestrial Radio";
  if (/banner|display|mobile/.test(source)) return "MEDIA - Internet Display / Banner Ad / Mobile";
  if (/sign|printed|print|flyer|poster/.test(source)) return "MEDIA - Campaign Signage & Printed Materials";
  return "MEDIA - Magazine / Newspaper Ad";
}

function sanitizeMdfPortalText(value: unknown): string {
  let text = String(value ?? "").trim();
  if (!text) return "";
  text = text
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => {
      if (!line) return false;
      return !/^(missing|missing\/needs review|needs review|required documentation|eligibility concerns?|concerns?|internal note|review note)\s*[:\-]/i.test(line);
    })
    .join("\n");
  text = text.replace(
    /\s+(Missing|Missing\/needs review|Needs review|Required documentation|Eligibility concerns?|Concerns?)\s*:\s*[\s\S]*$/i,
    ""
  );
  return text.trim();
}

async function fillClaimDetails(page: any, claim: MdfClaimEntry) {
  const claimType = String(claim.packet.claimType || "").toLowerCase();
  const fields = claim.packet.extractedFields ?? {};
  const description = sanitizeMdfPortalText(claim.packet.descriptionDraft);

  if (claimType === "media") {
    await selectOptionByText(page, "#activity-sub-detail", mediaSubType(claim));
    await fillText(page, "#activity-summary", description.slice(0, 2000));
    const totalLeads = extractedField(claim, ["totalLeads", "total_leads"]);
    if (totalLeads) await fillText(page, "#cl-budget", totalLeads);
    return;
  }

  if (claimType === "event") {
    await selectOptionByText(page, "#activity-sub-detail", eventSubType(claim));
    const eventName = extractedField(claim, ["eventName", "campaignName", "name"]) || claim.title;
    const eventDescription = description || String(fields.description || fields.eventDescription || "");
    const motorcyclesSold = extractedField(claim, ["motorcyclesSold", "motorcycles_sold", "unitsSold"]);
    const paAlSales = extractedField(claim, ["paAlSales", "pa_al_sales", "partsApparelSales", "partsAndApparelSales"]);
    const attendance = extractedField(claim, ["attendance", "attendees", "eventAttendance"]);
    if (eventName) await fillText(page, "#activity-summary", eventName.slice(0, 500));
    if (eventDescription) await fillText(page, "#brand", eventDescription.slice(0, 2000));
    if (motorcyclesSold) await fillText(page, "#category", motorcyclesSold);
    if (paAlSales) await fillText(page, "#cl-region", moneyValue(paAlSales));
    if (attendance) await fillText(page, "#cl-season", attendance);
  }
}

const ansiraClaimCreateUrl = "https://app.ansira.com/member/reimbursements/claims/create";

async function pageBodyText(page: any): Promise<string> {
  return page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
}

function isLoginPage(text: string): boolean {
  return /sign in|password|microsoft|enter your email|authenticate/i.test(text) && !/Create Claim/i.test(text);
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
          // Some Chromium pages block pseudo-class checks; never inspect the credential value as fallback.
        }
      }
    }
    return false;
  }, selectors).catch(() => false);
}

async function clickLoginAction(page: any, labels: string[]): Promise<boolean> {
  return page.evaluate((buttonLabels: string[]) => {
    const wanted = new Set(buttonLabels.map(label => label.trim().toLowerCase()));
    const candidates = Array.from(
      document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')
    ) as HTMLElement[];
    for (const node of candidates) {
      const text = String(
        node.textContent ||
          node.getAttribute("aria-label") ||
          (node instanceof HTMLInputElement ? node.value : "") ||
          ""
      ).trim().toLowerCase();
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
    if (!isLoginPage(text) && !/login\.microsoftonline\.com/i.test(url)) {
      return { attempted, advanced: attempted };
    }
    const staySignedIn = /stay signed in|keep me signed in/i.test(text);
    const emailReady = await hasChromeAutofilledInput(page, [
      'input[type="email"]',
      'input[name="loginfmt"]',
      'input[name="username"]',
      'input[name="UserName"]'
    ]);
    const passwordReady = await hasChromeAutofilledInput(page, ['input[type="password"]']);
    let clicked = false;
    if (staySignedIn) {
      clicked = await clickLoginAction(page, ["Yes", "Continue"]);
    } else if (passwordReady) {
      clicked = await clickLoginAction(page, ["Sign in", "Log in", "Continue", "Submit"]);
    } else if (emailReady) {
      clicked = await clickLoginAction(page, ["Next", "Continue", "Sign in"]);
    }
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

async function openMdfSsoEntry(page: any, portalUrl: string, options: RunnerOptions): Promise<any> {
  const startUrl = /h-?dnet\.com/i.test(portalUrl || "") ? portalUrl : hDNetHomeUrl;
  await page.goto(startUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });
  await page.waitForTimeout(5000);
  let text = await pageBodyText(page);
  if (isLoginPage(text) || /login\.microsoftonline\.com/i.test(page.url())) {
    await trySavedChromeLogin(page, options);
    text = await pageBodyText(page);
    if (isLoginPage(text) || /login\.microsoftonline\.com/i.test(page.url())) return page;
  }

  const toolbox = page.locator(".avaQuickLinksExtension.headerExtension").first();
  if (!(await toolbox.count())) return page;

  await toolbox.click({ force: true }).catch(() => {});
  await page.waitForTimeout(2000);
  const toolboxPanel = page.locator(".ms-Panel.is-open").first();
  const mdfLink = toolboxPanel
    .locator("a")
    .filter({ hasText: /^Marketing Development Fund$/i })
    .first();
  if (await mdfLink.count()) {
    const popupPromise = page.waitForEvent("popup", { timeout: 8000 }).catch(() => null);
    await mdfLink.click({ force: true }).catch(() => {});
    const popup = await popupPromise;
    const activePage = popup ?? page;
    await activePage.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => {});
    await activePage.waitForTimeout(5000);
    return activePage;
  }
  return page;
}

async function openAnsiraClaimFormThroughHNet(page: any, options: RunnerOptions): Promise<{ page: any; blocker: string | null }> {
  const sessionExpired = (where: string): { page: any; blocker: string } => ({
    page,
    blocker:
      `The MDF runner hit the Ansira/H-DNet sign-in screen (${where}) — the session has expired. ` +
      "Log into h-dnet.com in the runner's dedicated Chrome window, confirm app.ansira.com/member/reimbursements/claims shows the claims list (not a login), then run the portal draft again."
  });
  const onLogin = async (): Promise<boolean> => {
    const url = String(page.url());
    if (/\/auth\/login|login\.microsoftonline\.com/i.test(url)) return true;
    return isLoginPage(await pageBodyText(page));
  };
  const hasForm = async (): Promise<boolean> =>
    (await page.locator("#app-marketing-activity").count().catch(() => 0)) > 0;

  // 1) Go straight to the MDF Recap list. The live M365 session auto-SSOs Ansira — no toolbox.
  await page.goto(options.recapEntryUrl || ansiraClaimCreateUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(4000);
  if (await onLogin()) return sessionExpired("recap list");

  // 2) Click "Create MDF Recap" to instantiate the form (a bare nav to /create does not render it).
  const createBtn = page.getByText(/create\s+mdf\s+recap/i).first();
  if (await createBtn.count().catch(() => 0)) {
    await createBtn.scrollIntoViewIfNeeded().catch(() => {});
    await createBtn.click({ timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(4000);
  }

  // 3) Confirm the create form rendered; one retry via the direct create URL.
  if (!(await hasForm())) {
    await page.goto(ansiraClaimCreateUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(4000);
  }
  if (await onLogin()) return sessionExpired("create form");
  if (!(await hasForm())) {
    return {
      page,
      blocker:
        "The MDF runner reached Ansira but could not open the Create MDF Recap form (no Marketing Activity field found). " +
        "Open the MDF Recap list and click Create MDF Recap manually once, then run the portal draft again."
    };
  }
  return { page, blocker: null };
}

async function runPlaywrightOpenHNet(options: RunnerOptions): Promise<{ code: number; summary: string; links?: string[] }> {
  if (!options.cdpUrl) return { code: 2, summary: "H-DNet login opener needs MDF_PORTAL_CDP_URL for the runner browser." };
  const { chromium } = await import("playwright");
  const browser = await chromium.connectOverCDP(options.cdpUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page =
    context
      .pages()
      .find(openPage => /h-?dnet\.com|login\.microsoftonline\.com/i.test(openPage.url())) ??
    context.pages().find(openPage => openPage.url() === "about:blank" || openPage.url().startsWith("chrome://newtab")) ??
    (await context.newPage());

  await page.bringToFront();
  await page.goto(hDNetHomeUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });
  await page.waitForTimeout(4000);
  let text = await pageBodyText(page);
  const savedLogin = await trySavedChromeLogin(page, options);
  if (savedLogin.attempted) {
    await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    text = await pageBodyText(page);
  }
  const url = page.url();
  await browser.close();

  if (/app\.ansira\.com/i.test(url)) {
    return {
      code: 2,
      summary: "The runner opened an Ansira page instead of H-DNet. Close the Ansira tab and use Open H-DNet login again.",
      links: [url]
    };
  }
  if (isLoginPage(text) || /login\.microsoftonline\.com/i.test(url)) {
    return {
      code: 0,
      summary: options.useSavedChromeLogin
        ? "H-DNet login page is open in the MDF runner browser. Chrome saved login/autofill was tried when available, but password or MFA still needs a person. Finish login there, then click Start portal draft again."
        : "H-DNet login page is open in the MDF runner browser. Enter your password/MFA there, then click Start portal draft again.",
      links: [url]
    };
  }
  return {
    code: 0,
    summary: "H-DNet is open in the MDF runner browser. If you are logged in, click Start portal draft to continue through the toolbox.",
    links: [url]
  };
}

async function runPlaywrightPortalDraft(claim: MdfClaimEntry, options: RunnerOptions): Promise<{ code: number; summary: string; links?: string[] }> {
  if (!options.cdpUrl) return { code: 2, summary: "Playwright portal runner needs MDF_PORTAL_CDP_URL for a logged-in Chrome session." };
  const portalClaimLabel = portalClaimTypeLabel(claim);
  if (!portalClaimLabel || !["media", "event"].includes(String(claim.packet.claimType || "").toLowerCase())) {
    return {
      code: 2,
      summary: `Playwright portal runner currently supports media and event claims. Claim type was "${claim.packet.claimType || "missing"}".`
    };
  }

  const { chromium } = await import("playwright");
  const browser = await chromium.connectOverCDP(options.cdpUrl);
  let page =
    browser
      .contexts()
      .flatMap(context => context.pages())
      .find(openPage => openPage.url().includes("app.ansira.com")) ??
    (await browser.contexts()[0]?.newPage());
  if (!page) throw new Error("No Chrome page available for the MDF portal runner.");

  await page.bringToFront();
  const ansiraResult = await openAnsiraClaimFormThroughHNet(page, options);
  page = ansiraResult.page;
  const loginBlocker = ansiraResult.blocker;
  if (loginBlocker) {
    await browser.close();
    return { code: 2, summary: loginBlocker };
  }

  // Phase-A preflight: confirm the Marketing Activity option the runner needs still exists
  // BEFORE selecting it. A renamed option (most likely a year rollover — "2026 Media Claim"
  // → "2027 Media Claim") would otherwise throw mid-select with a generic error. Read the
  // option texts the same way the runner matches them (visible text), so the check tracks
  // the actual select behavior.
  const activityOptions = await page
    .locator("#app-marketing-activity option")
    .allTextContents()
    .catch(() => [] as string[]);
  const optionIssue = marketingActivityOptionIssue(portalClaimLabel, activityOptions);
  if (optionIssue) {
    await browser.close();
    return { code: 2, summary: ansiraMarketingOptionSummary(optionIssue) };
  }

  await selectOptionByText(page, "#app-marketing-activity", portalClaimLabel);
  await page.waitForTimeout(1500);

  // Preflight: selecting the activity expands the rest of the form. Before we fill
  // anything or save, confirm the controls the filler depends on are present. If
  // Ansira changed the form layout, bail loud and early with ZERO partial state (no
  // draft created) instead of crashing mid-fill or tripping a save-time error. We
  // wait for the bottom-of-form Save button to attach first so a slow render isn't
  // mistaken for a layout change.
  await page.locator("#app-draft-submit-btn").waitFor({ state: "attached", timeout: 20_000 }).catch(() => {});
  const missingControls = await findMissingFormControls(
    ANSIRA_FORM_CONTROLS,
    async selector => (await page.locator(selector).count().catch(() => 0)) > 0
  );
  if (missingControls.length) {
    await browser.close();
    return { code: 2, summary: ansiraFormChangedSummary(missingControls) };
  }

  const startDate = toUsDate(extractedField(claim, ["activityStartDate", "activity_start_date", "startDate"]));
  const endDate = toUsDate(extractedField(claim, ["activityEndDate", "activity_end_date", "endDate"]));
  if (startDate) await fillText(page, "#app-claim-start-date", startDate);
  if (endDate) await fillText(page, "#app-claim-end-date", endDate);
  await page.waitForTimeout(2500);

  const standalone = page.locator("#app-radio-btn-standalone-claim");
  if (await standalone.count()) {
    await standalone.check({ force: true }).catch(async () => {
      await standalone.evaluate((el: HTMLInputElement) => {
        el.checked = true;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
    });
  }

  const invoices = invoiceRecordsForClaim(claim);
  const flatSpend = moneyValue(extractedField(claim, ["spend", "amount", "invoiceAmount", "invoice_amount"]));
  const invoiceTotal = invoices.reduce((sum, invoice) => sum + parseMoneyAmount(String(invoice.amount ?? "")), 0);
  const claimedAmount = moneyFromNumber(invoiceTotal) || flatSpend;

  await fillText(page, "#app-claim-name", claim.title);
  await fillText(page, "#app-additional-notes", "LeadRider draft prepared from uploaded documents. Human review required before final submission.");
  await fillClaimDetails(page, claim);
  for (let i = 0; i < invoices.length; i += 1) {
    await fillInvoiceSection(page, i + 1, invoices[i]);
  }
  if (claimedAmount) {
    await fillText(page, "#app-claimed-amount", claimedAmount);
  }

  const files = claim.packet.uploadedFiles ?? [];
  const assignedInvoiceNames = new Set<string>();
  const invoiceFileGroups = invoices.map(invoice => filesForInvoice(invoice, files, assignedInvoiceNames));
  if (!invoiceFileGroups.length) {
    const invoiceFiles = files.filter(isInvoiceFile);
    if (invoiceFiles.length) invoiceFileGroups.push(invoiceFiles);
    for (const file of invoiceFiles) assignedInvoiceNames.add(file.name);
  }
  const supportFiles = files.filter(file => !assignedInvoiceNames.has(file.name));
  const tempDir = path.join(os.tmpdir(), `leadrider-mdf-${claim.id}-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });
  try {
    const invoicePathGroups = await Promise.all(
      invoiceFileGroups.map(async group => (await Promise.all(group.map(file => downloadPortalFile(file, tempDir)))).filter(Boolean) as string[])
    );
    const supportPaths = (await Promise.all(supportFiles.map(file => downloadPortalFile(file, tempDir)))).filter(Boolean) as string[];
    const fileInputs = await page.locator('input[type="file"][name="files[]"]').all();
    for (let i = 0; i < invoicePathGroups.length; i += 1) {
      const paths = invoicePathGroups[i];
      if (!paths.length || !fileInputs[i]) continue;
      await fileInputs[i].setInputFiles(paths.length === 1 ? paths[0] : paths);
      await page.waitForTimeout(5000);
      await setInvoiceFileCategories(page, i + 1);
    }
    const supportInput = fileInputs[invoicePathGroups.length] ?? fileInputs[1];
    if (supportPaths.length && supportInput) {
      await supportInput.setInputFiles(supportPaths);
      await page.waitForTimeout(8000);
      const supportCategoryCount = await page.locator('select[name^="files["][name$="[file_category]"]').count();
      for (let i = 0; i < supportCategoryCount; i += 1) {
        const selector = `select[name="files[${i}][file_category]"]`;
        if (await page.locator(selector).count()) await selectOptionByText(page, selector, "Supporting Documentation").catch(() => {});
      }
    }

    if (claimedAmount) {
      await fillText(page, "#app-claimed-amount", claimedAmount);
    }

    await page.locator("#app-draft-submit-btn").scrollIntoViewIfNeeded();
    await page.locator("#app-draft-submit-btn").click();
    await page.waitForLoadState("domcontentloaded", { timeout: 45_000 }).catch(() => {});
    await page.waitForTimeout(5000);
    const resultText = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
    const claimId = resultText.match(/Claim ID:\s*([A-Z0-9]+)/i)?.[1] || "";
    const status = resultText.match(/Status:\s*([^\n]+)/i)?.[1]?.trim() || "unknown";
    const saved = /successfully saved|Status:\s*Incomplete/i.test(resultText);
    const summary = [
      saved ? "Ansira MDF draft saved successfully." : "Ansira MDF draft run finished, but save confirmation was not detected.",
      claimId ? `Claim ID: ${claimId}.` : "Claim ID was not detected.",
      `Status: ${status}.`,
      `Filled ${claim.packet.claimType || "media"} claim for ${claim.title}.`,
      `Filled ${Math.max(invoices.length, invoicePathGroups.length)} invoice section(s).`,
      `Uploaded ${invoicePathGroups.flat().length} invoice file(s) and ${supportPaths.length} supporting file(s).`,
      "Did not click final Submit.",
      "Human review still needed before final submission."
    ].join(" ");
    await browser.close();
    return { code: saved ? 0 : 2, summary, links: [page.url()] };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
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

// Single-flight lock: only one --run may drive the shared CDP browser at a time.
// A daemon restart can orphan an in-flight runner (it keeps running) while a new
// daemon spawns fresh runners — multiple agents then fight over the same Chrome
// (observed 2026-06-17: 3 concurrent agents clobbering each other's tabs). This
// cross-process lockfile makes the new runner stand down while another is live.
// A lock whose pid is dead, or older than the stale window, is reclaimed.
const RUN_LOCK_PATH = path.join(os.tmpdir(), "leadrider-mdf-portal-runner.lock");
const RUN_LOCK_STALE_MS = 15 * 60 * 1000;

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM"; // exists but not signalable -> still alive
  }
}

function acquireRunLock(): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(RUN_LOCK_PATH, "wx"); // atomic exclusive create
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAtMs: Date.now() }));
      closeSync(fd);
      return true;
    } catch (err: any) {
      if (err?.code !== "EEXIST") return true; // unexpected fs error -> fail open (never block all runs)
      try {
        const info = JSON.parse(readFileSync(RUN_LOCK_PATH, "utf8") || "{}");
        const pid = Number(info?.pid);
        const startedAtMs = Number(info?.startedAtMs);
        const alive = isPidAlive(pid);
        const fresh = Number.isFinite(startedAtMs) && Date.now() - startedAtMs < RUN_LOCK_STALE_MS;
        if (alive && fresh) return false; // genuinely held by a live, recent runner
        unlinkSync(RUN_LOCK_PATH); // stale (dead pid or timed out) -> reclaim and retry
      } catch {
        return false; // can't read/parse the lock -> treat as held (don't risk a collision)
      }
    }
  }
  return false;
}

function releaseRunLock(): void {
  try {
    const info = JSON.parse(readFileSync(RUN_LOCK_PATH, "utf8") || "{}");
    if (Number(info?.pid) === process.pid) unlinkSync(RUN_LOCK_PATH);
  } catch {
    /* nothing to release / already gone */
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  // Hold the single-flight lock only for an actual browser run (not list/dry-run).
  const wantsBrowserRun = options.run && !options.dryRun && !options.list;
  if (wantsBrowserRun && !acquireRunLock()) {
    console.log("Another MDF portal runner is already running (single-flight lock held); skipping this run.");
    return;
  }
  try {
    await runMain(options);
  } finally {
    if (wantsBrowserRun) releaseRunLock();
  }
}

async function runMain(options: RunnerOptions) {
  const remoteBundles = options.apiBase ? await loadRemoteBundles(options) : null;
  const tasks = remoteBundles ? remoteBundles.map(row => row.task) : await loadTasks();
  const mdfTasks = pendingMdfTasks(tasks);

  if (options.list) {
    if (!mdfTasks.length) {
      console.log("No MDF portal tasks found.");
      return;
    }
    for (const task of mdfTasks.slice(0, 20)) {
      console.log(`${task.id} | ${task.status} | ${isHNetLoginTask(task) ? "h-dnet-login" : claimIdFromTask(task)} | ${task.title}`);
    }
    return;
  }

  const task = chooseTask(tasks, options);
  if (!task) {
    if (options.idleOk) {
      console.log("No MDF portal task found.");
      return;
    }
    throw new Error("No MDF portal task found. Create one from the MDF Assistant first.");
  }

  if (isHNetLoginTask(task)) {
    if (!options.run) {
      console.log(`Prepared H-DNet login task: ${task.id}`);
      console.log("Pass --run to open H-DNet in the runner browser.");
      return;
    }
    updateTask(tasks, task.id, "running", "Opening H-DNet login in the MDF runner browser.");
    if (remoteBundles) await updateRemoteTask(options, task.id, "running", "Opening H-DNet login in the MDF runner browser.");
    const result = await runPlaywrightOpenHNet(options);
    const status: AgentTaskStatus = result.code === 0 ? "completed" : "blocked";
    updateTask(tasks, task.id, status, result.summary, result.links ?? []);
    if (remoteBundles) {
      await updateRemoteTask(options, task.id, status, result.summary, result.links ?? []);
    } else {
      await saveTasks(tasks);
    }
    console.log(result.summary);
    return;
  }

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

  const cdpOk = options.cdpUrl ? await isCdpReachable(options.cdpUrl) : false;
  const python = process.env.MDF_BROWSER_USE_PYTHON?.trim() || "python3";
  const browserUseInstalled = !options.guided && (await canImportBrowserUse(python));
  const browserUseCloud = osFlag("MDF_BROWSER_USE_CLOUD");
  const allowFreshBrowser = osFlag("MDF_BROWSER_USE_ALLOW_FRESH_BROWSER");
  const browserUseEnabled = osFlag("MDF_PORTAL_USE_BROWSER_USE");
  const browserUseAvailable = browserUseInstalled && (cdpOk || browserUseCloud || allowFreshBrowser);
  const playwrightAvailable = cdpOk && !browserUseEnabled && !options.guided;

  if (!playwrightAvailable && !browserUseAvailable) {
    const cdpNote =
      options.cdpUrl && !cdpOk
        ? " The configured Chrome CDP URL was not reachable, so the guided fallback opened the normal desktop browser."
        : "";
    const browserUseNote =
      browserUseInstalled && !cdpOk && !browserUseCloud && !allowFreshBrowser
        ? " Browser Use is installed, but automatic mode needs MDF_PORTAL_CDP_URL for the logged-in Chrome session."
        : " browser-use is not installed/configured, so this run is guided and still needs manual portal completion.";
    const summary = await openGuidedBrowser(htmlPath, options.portalUrl);
    updateTask(
      tasks,
      task.id,
      "needs_approval",
      `${summary}${cdpNote}${browserUseNote} Prompt: ${promptPath}`,
      [promptPath, htmlPath, options.portalUrl]
    );
    if (remoteBundles) {
      await updateRemoteTask(
        options,
        task.id,
        "needs_approval",
        `${summary}${cdpNote}${browserUseNote} Prompt: ${promptPath}`,
        [promptPath, htmlPath, options.portalUrl]
      );
    } else {
      await saveTasks(tasks);
    }
    console.log("Guided MDF portal packet opened.");
    return;
  }

  // Download the packet's files locally so browser-use can attach them to the form's
  // file inputs (file inputs need local paths; the packet only carries remote URLs).
  const filesDir = path.join(runsDir, `${task.id}-files`);
  const localFiles = await downloadClaimFiles(claim, filesDir, options.token);
  if (localFiles.length) {
    console.log(`Downloaded ${localFiles.length} file(s) for upload: ${localFiles.map(f => path.basename(f)).join(", ")}`);
  }

  let result: { code: number; summary: string; links?: string[] };
  try {
    result = playwrightAvailable
      ? await runPlaywrightPortalDraft(claim, options)
      : await runBrowserUse(promptPath, resultPath, options, localFiles.length ? filesDir : undefined);
  } catch (err: any) {
    result = {
      code: 2,
      summary: `Automatic MDF portal runner failed before completion: ${err?.message ?? err}`
    };
  }
  if (result.code === 0) {
    updateTask(
      tasks,
      task.id,
      "needs_approval",
      `MDF portal draft run completed. Review the portal before any final submit.\n\n${result.summary}`,
      [promptPath, resultPath, options.portalUrl, ...(result.links ?? [])]
    );
  } else {
    const rescueEnabled = !options.guided && osFlag("MDF_PORTAL_USE_BROWSER_HARNESS_RESCUE", true);
    const rescue = rescueEnabled && cdpOk ? await runBrowserHarnessRescue(promptPath, htmlPath, options, result.summary) : null;
    if (rescue?.code === 0) {
      updateTask(
        tasks,
        task.id,
        "needs_approval",
        rescue.summary,
        [promptPath, htmlPath, options.portalUrl, ...(result.links ?? []), ...rescue.links]
      );
    } else {
      const rescueNote = rescue ? `\n\n${rescue.summary}` : "";
    updateTask(
      tasks,
      task.id,
      "blocked",
      `MDF portal runner blocked before completion.\n\n${result.summary}${rescueNote}`,
      [promptPath, resultPath, options.portalUrl, ...(result.links ?? [])]
    );
    }
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

function osFlag(name: string, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

main().catch(err => {
  console.error(err?.message ?? err);
  process.exit(1);
});
