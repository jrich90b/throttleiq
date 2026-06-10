import { dataPath } from "./dataDir.js";
import { readJsonStoreText, writeJsonStoreText } from "./storePersistence.js";

export type AgentTaskProvider = "codex" | "claude";
export type AgentTaskKind =
  | "dealer_setup"
  | "feedback_review"
  | "agreement"
  | "email"
  | "quickbooks"
  | "prospect_research"
  | "mdf_portal"
  | "warranty_rma_portal"
  | "provider_browser"
  | "linear_ticket"
  | "sop"
  | "other";
export type AgentTaskRisk = "low" | "approval_required" | "blocked";
export type AgentTaskStatus = "queued" | "needs_approval" | "running" | "completed" | "failed" | "blocked";

export type AgentTask = {
  id: string;
  provider: AgentTaskProvider;
  kind: AgentTaskKind;
  title: string;
  instructions: string;
  clientName?: string;
  priority: "normal" | "high";
  risk: AgentTaskRisk;
  status: AgentTaskStatus;
  createdAt: string;
  updatedAt: string;
  requestedBy?: {
    id?: string;
    name?: string;
    email?: string;
    role?: string;
  };
  approval?: {
    required: boolean;
    reason?: string;
  };
  output?: {
    summary?: string;
    links?: string[];
    research?: Record<string, unknown>;
  };
};

const STORE_PATH = process.env.AGENT_TASKS_PATH || dataPath("agent_tasks.json");
const MAX_ROWS = Number(process.env.AGENT_TASKS_MAX_ROWS ?? "1000");

let loaded = false;
let rows: AgentTask[] = [];
let saveTimer: NodeJS.Timeout | null = null;

export async function listAgentTasks(limit = 200): Promise<AgentTask[]> {
  await ensureLoaded();
  const bounded = Math.max(1, Math.min(1000, Math.floor(limit)));
  return [...rows]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, bounded);
}

export async function addAgentTask(
  input: Omit<AgentTask, "id" | "createdAt" | "updatedAt" | "status">
): Promise<AgentTask> {
  await ensureLoaded();
  const now = new Date().toISOString();
  const task: AgentTask = {
    ...input,
    id: `agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
    updatedAt: now,
    status: input.risk === "blocked" ? "blocked" : input.approval?.required ? "needs_approval" : "queued"
  };
  rows.unshift(task);
  const maxRows = Number.isFinite(MAX_ROWS) && MAX_ROWS > 0 ? Math.floor(MAX_ROWS) : 1000;
  if (rows.length > maxRows) rows = rows.slice(0, maxRows);
  scheduleSave();
  return task;
}

export async function updateAgentTaskStatus(
  id: string,
  status: AgentTaskStatus,
  output?: AgentTask["output"]
): Promise<AgentTask | null> {
  await ensureLoaded();
  const task = rows.find(row => row.id === id);
  if (!task) return null;
  task.status = status;
  task.updatedAt = new Date().toISOString();
  if (output) task.output = { ...(task.output ?? {}), ...output };
  scheduleSave();
  return task;
}

function isAgentTask(row: any): row is AgentTask {
  return (
    !!row &&
    typeof row === "object" &&
    typeof row.id === "string" &&
    typeof row.createdAt === "string" &&
    (row.provider === "codex" || row.provider === "claude")
  );
}

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await readJsonStoreText({ store: "agent_tasks", filePath: STORE_PATH });
    const parsed = raw == null ? [] : JSON.parse(raw);
    rows = Array.isArray(parsed) ? parsed.filter(isAgentTask) : [];
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
  await writeJsonStoreText({
    store: "agent_tasks",
    filePath: STORE_PATH,
    text: `${JSON.stringify(rows, null, 2)}\n`
  });
}
