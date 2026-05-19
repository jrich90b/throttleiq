import { promises as fs } from "node:fs";
import path from "node:path";

type AutomationRun = {
  id: string;
  name: string;
  source: "codex" | "feedback_loop" | "manual" | "other";
  status: "running" | "completed" | "failed" | "needs_approval" | "approved" | "declined";
  summary: string;
  startedAt: string;
  finishedAt?: string;
  approvalRequired: boolean;
  approvalReason?: string;
  commitHash?: string;
  pullRequestUrl?: string;
  deployUrl?: string;
  logPath?: string;
  changedFiles?: string[];
  createdAt: string;
  updatedAt: string;
};

function arg(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find(item => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function dataPath(file: string) {
  const dir = process.env.DATA_DIR?.trim() || path.resolve(process.cwd(), "data");
  return path.join(dir, file);
}

function parseChangedFiles(raw?: string) {
  if (!raw) return undefined;
  return raw
    .split(/\n|,/)
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 100);
}

async function readExisting(filePath: string): Promise<AutomationRun[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(row => row && typeof row.id === "string") : [];
  } catch {
    return [];
  }
}

async function main() {
  const filePath = process.env.AUTOMATION_RUNS_PATH || dataPath("automation_runs.json");
  const status = (arg("status") || process.env.AUTOMATION_RUN_STATUS || "completed") as AutomationRun["status"];
  const startedAt = arg("started-at") || process.env.AUTOMATION_RUN_STARTED_AT || new Date().toISOString();
  const finishedAt = arg("finished-at") || process.env.AUTOMATION_RUN_FINISHED_AT || new Date().toISOString();
  const approvalRequired =
    arg("approval-required") === "1" ||
    process.env.AUTOMATION_RUN_APPROVAL_REQUIRED === "1" ||
    status === "needs_approval";
  const now = new Date().toISOString();
  const run: AutomationRun = {
    id: `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name: arg("name") || process.env.AUTOMATION_RUN_NAME || "Automation run",
    source: ((arg("source") || process.env.AUTOMATION_RUN_SOURCE || "other") as AutomationRun["source"]) || "other",
    status,
    summary: arg("summary") || process.env.AUTOMATION_RUN_SUMMARY || "Automation run completed.",
    startedAt,
    finishedAt,
    approvalRequired,
    approvalReason: arg("approval-reason") || process.env.AUTOMATION_RUN_APPROVAL_REASON || undefined,
    commitHash: arg("commit") || process.env.AUTOMATION_RUN_COMMIT || undefined,
    pullRequestUrl: arg("pr-url") || process.env.AUTOMATION_RUN_PR_URL || undefined,
    deployUrl: arg("deploy-url") || process.env.AUTOMATION_RUN_DEPLOY_URL || undefined,
    logPath: arg("log-path") || process.env.AUTOMATION_RUN_LOG_PATH || undefined,
    changedFiles: parseChangedFiles(arg("changed-files") || process.env.AUTOMATION_RUN_CHANGED_FILES),
    createdAt: now,
    updatedAt: now
  };

  const rows = await readExisting(filePath);
  rows.unshift(run);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(rows.slice(0, 1000), null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, run }, null, 2));
}

main().catch(err => {
  console.error(err?.message ?? err);
  process.exit(1);
});
