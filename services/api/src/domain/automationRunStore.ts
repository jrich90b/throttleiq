import { promises as fs } from "node:fs";
import * as path from "node:path";
import { dataPath } from "./dataDir.js";

export type AutomationRunStatus = "running" | "completed" | "failed" | "needs_approval" | "approved" | "declined";

export type AutomationRun = {
  id: string;
  name: string;
  source: "codex" | "feedback_loop" | "manual" | "other";
  status: AutomationRunStatus;
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
  approvedBy?: {
    id?: string;
    name?: string;
    email?: string;
    at: string;
  };
};

const STORE_PATH = process.env.AUTOMATION_RUNS_PATH || dataPath("automation_runs.json");
const MAX_ROWS = Number(process.env.AUTOMATION_RUNS_MAX_ROWS ?? "1000");

let loaded = false;
let rows: AutomationRun[] = [];
let saveTimer: NodeJS.Timeout | null = null;

export async function listAutomationRuns(limit = 100): Promise<AutomationRun[]> {
  await ensureLoaded();
  const bounded = Math.max(1, Math.min(1000, Math.floor(limit)));
  return [...rows]
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .slice(0, bounded);
}

export async function addAutomationRun(
  input: Omit<AutomationRun, "id" | "createdAt" | "updatedAt">
): Promise<AutomationRun> {
  await ensureLoaded();
  const now = new Date().toISOString();
  const run: AutomationRun = {
    ...input,
    id: `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
    updatedAt: now
  };
  rows.unshift(run);
  const maxRows = Number.isFinite(MAX_ROWS) && MAX_ROWS > 0 ? Math.floor(MAX_ROWS) : 1000;
  if (rows.length > maxRows) rows = rows.slice(0, maxRows);
  scheduleSave();
  return run;
}

export async function updateAutomationRunStatus(
  id: string,
  status: AutomationRunStatus,
  approvedBy?: AutomationRun["approvedBy"]
): Promise<AutomationRun | null> {
  await ensureLoaded();
  const run = rows.find(row => row.id === id);
  if (!run) return null;
  run.status = status;
  run.updatedAt = new Date().toISOString();
  if (approvedBy) run.approvedBy = approvedBy;
  scheduleSave();
  return run;
}

function isAutomationRun(row: any): row is AutomationRun {
  return !!row && typeof row === "object" && typeof row.id === "string" && typeof row.startedAt === "string";
}

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    rows = Array.isArray(parsed) ? parsed.filter(isAutomationRun) : [];
  } catch {
    rows = [];
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveNow();
  }, 200);
}

async function saveNow() {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, `${JSON.stringify(rows, null, 2)}\n`);
}
