import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type TlpBrowserUseAction = "log_customer_contact" | "mark_dealership_visit_delivered";

export type TlpBrowserUseLogContactArgs = {
  action: "log_customer_contact";
  leadRef: string;
  phone?: string;
  note: string;
  categoryValue?: string;
  contactedValue?: "YES" | "NO";
};

export type TlpBrowserUseDeliveredArgs = {
  action: "mark_dealership_visit_delivered";
  leadRef: string;
  phone?: string;
  note: string;
  details?: Record<string, unknown>;
};

export type TlpBrowserUseRescueArgs = TlpBrowserUseLogContactArgs | TlpBrowserUseDeliveredArgs;

export type TlpBrowserUseRescueResult = {
  attempted: boolean;
  ok: boolean;
  skipped?: boolean;
  summary: string;
  promptPath?: string;
  resultPath?: string;
  code?: number;
};

function yes(value: unknown): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

export function tlpBrowserUseRescueEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return yes(env.TLP_BROWSER_USE_RESCUE ?? env.TLP_PORTAL_USE_BROWSER_USE);
}

function normalizeLeadRef(value: string): string {
  return String(value ?? "").replace(/[^\w.-]+/g, "_").slice(0, 80) || "unknown";
}

function scriptCandidates(): string[] {
  const explicit = String(process.env.TLP_BROWSER_USE_SCRIPT_PATH ?? "").trim();
  const cwd = process.cwd();
  const roots = [
    process.env.LEADRIDER_REPO_ROOT,
    process.env.REPO_ROOT,
    path.resolve(cwd, "../.."),
    path.resolve(cwd, ".."),
    cwd
  ]
    .filter(Boolean)
    .map(root => String(root));
  return [
    explicit,
    ...roots.map(root => path.join(root, "scripts", "tlp_crm_browser_use.py"))
  ].filter(Boolean);
}

export function resolveTlpBrowserUseScriptPath(): string | null {
  for (const candidate of scriptCandidates()) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function rescueArtifactDir(): string {
  return String(process.env.TLP_BROWSER_USE_ARTIFACT_DIR || process.env.TLP_DEBUG_DIR || "/tmp/tlp-debug").trim();
}

function buildDetailsLines(details: Record<string, unknown> | undefined): string {
  if (!details || typeof details !== "object") return "- none";
  const lines = Object.entries(details)
    .map(([key, value]) => [key, String(value ?? "").trim()] as const)
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `- ${key}: ${value}`);
  return lines.length ? lines.join("\n") : "- none";
}

export function buildTlpBrowserUsePrompt(args: TlpBrowserUseRescueArgs, originalError: unknown): string {
  const original = String((originalError as any)?.message ?? originalError ?? "").replace(/\s+/g, " ").trim();
  const base = process.env.TLP_BASE_URL ?? "https://tlpcrm.com";
  const common = [
    "# LeadRider TLP CRM browser-use rescue",
    "",
    "You are operating inside the dealership CRM portal for an internal CRM side effect.",
    "Use browser-use only to complete the exact structured task below after deterministic Playwright failed.",
    "",
    "Hard rules:",
    "- Do not send SMS, email, chat, or any customer-facing message.",
    "- Do not change any customer record unless the lead ref or phone clearly matches this task.",
    "- If the portal is on login or MFA, stop and report that manual login is needed. Do not type, reveal, read, or copy credentials.",
    "- If saved browser autofill is already present, you may click Next, Continue, Sign in, or Yes to proceed.",
    "- If the matching lead is ambiguous, stop and report ambiguity.",
    "- Save/submit the CRM update only after verifying the matching lead and exact fields.",
    "- Report the final URL, visible confirmation if any, and whether the CRM update was saved.",
    "- End the final answer with RESULT_STATUS: saved only after the CRM update is visibly saved/submitted.",
    "- End with RESULT_STATUS: blocked for login, MFA, missing autofill, ambiguity, or no save confirmation.",
    "- End with RESULT_STATUS: error for unexpected failures.",
    "",
    `TLP portal base URL: ${base}`,
    `Lead ref: ${args.leadRef}`,
    `Phone fallback: ${args.phone || "not provided"}`,
    original ? `Original deterministic failure: ${original}` : "Original deterministic failure: not provided",
    ""
  ];

  if (args.action === "log_customer_contact") {
    return [
      ...common,
      "Task: log a customer contact note.",
      "",
      "Expected CRM action:",
      "1. Open TLP.",
      "2. Find the lead by Lead Ref first; use the phone fallback only if needed.",
      "3. Open the Event Customer Contact / contact log form.",
      `4. Set customer contacted to ${args.contactedValue ?? "YES"}.`,
      `5. Set product/category to ${args.categoryValue ?? "MOTORCYCLES"} if that field is present.`,
      "6. Put this exact internal contact note in the comments field.",
      "7. Save/submit the contact log.",
      "",
      "Exact note:",
      "```",
      args.note,
      "```"
    ].join("\n");
  }

  return [
    ...common,
    "Task: mark dealership visit outcome as delivered/sold.",
    "",
    "Expected CRM action:",
    "1. Open TLP.",
    "2. Find the lead by Lead Ref first; use the phone fallback only if needed.",
    "3. Open the Dealership Visit / visit outcome form.",
    "4. Set the visit/outcome step to Delivered or the equivalent sold/delivered state.",
    "5. Fill available details from the structured details below. Skip unknown optional fields rather than guessing.",
    "6. Put this exact internal note in the comments field if a comments field is present.",
    "7. Save/submit the internal CRM update.",
    "",
    "Structured details:",
    buildDetailsLines(args.details),
    "",
    "Exact note:",
    "```",
    args.note,
    "```"
  ].join("\n");
}

async function runProcess(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise(resolve => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"]
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
    child.stdout?.on("data", chunk => (stdout += String(chunk)));
    child.stderr?.on("data", chunk => (stderr += String(chunk)));
    child.on("close", code => finish(code ?? 1));
    child.on("error", err => finish(1, String(err)));
  });
}

export async function runTlpBrowserUseRescue(
  args: TlpBrowserUseRescueArgs,
  originalError: unknown
): Promise<TlpBrowserUseRescueResult> {
  if (!tlpBrowserUseRescueEnabled()) {
    return { attempted: false, ok: false, skipped: true, summary: "TLP browser-use rescue is disabled." };
  }
  const scriptPath = resolveTlpBrowserUseScriptPath();
  if (!scriptPath) {
    return { attempted: false, ok: false, skipped: true, summary: "TLP browser-use rescue script was not found." };
  }

  const dir = rescueArtifactDir();
  await mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeLeadRef = normalizeLeadRef(args.leadRef);
  const baseName = `tlp_browser_use_${ts}_${args.action}_${safeLeadRef}`;
  const promptPath = path.join(dir, `${baseName}.md`);
  const resultPath = path.join(dir, `${baseName}.json`);
  await writeFile(promptPath, buildTlpBrowserUsePrompt(args, originalError), "utf8");

  const python = String(process.env.TLP_BROWSER_USE_PYTHON || process.env.MDF_BROWSER_USE_PYTHON || "python3").trim();
  const portalUrl = String(process.env.TLP_BROWSER_USE_PORTAL_URL || process.env.TLP_BASE_URL || "https://tlpcrm.com").trim();
  const maxSteps = String(process.env.TLP_BROWSER_USE_MAX_STEPS || "35");
  const cdpUrl = String(process.env.TLP_BROWSER_USE_CDP_URL || process.env.MDF_PORTAL_CDP_URL || "").trim();
  const timeoutSeconds = Math.max(60, Number(process.env.TLP_BROWSER_USE_TIMEOUT_SECONDS || "600"));
  const processArgs = [scriptPath, "--prompt", promptPath, "--portal-url", portalUrl, "--result", resultPath, "--max-steps", maxSteps];
  if (cdpUrl) processArgs.push("--cdp-url", cdpUrl);

  const result = await runProcess(python, processArgs, {
    timeoutMs: timeoutSeconds * 1000,
    env: {
      TLP_BROWSER_USE_MODEL:
        process.env.TLP_BROWSER_USE_MODEL || process.env.MDF_BROWSER_USE_MODEL || process.env.OPENAI_MODEL || "gpt-5"
    }
  });
  let payload: any = null;
  try {
    payload = JSON.parse(await readFile(resultPath, "utf8"));
  } catch {
    payload = null;
  }
  const summary = String(payload?.summary || result.stderr || result.stdout || "browser-use finished without a summary.").trim();
  return {
    attempted: true,
    ok: result.code === 0 && payload?.ok === true && payload?.blocked !== true,
    skipped: false,
    summary,
    promptPath,
    resultPath,
    code: result.code
  };
}
