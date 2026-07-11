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

// Stuck-task reaper (2026-07-10). An agent task (esp. kind "mdf_portal") whose runner process
// DIED or HUNG leaves the task pinned in "running" forever — nothing transitions it, because a dead
// process can't fail its own task. The mdf_portal_health sweep DETECTS this (stuck >30m) but never
// clears it, so the same orphan re-fires every night (2026-07-10: one 3.5 days old, one 3 weeks old).
//
// Pure selection so it's eval'able and the timeout is legible. FAIL-SAFE by construction: it only ever
// touches status==="running" AND age > a CONSERVATIVE timeout (default 180m — real MDF portal runs are
// minutes, so this can never race a live run), and it only marks the task "failed" (a dead runner's
// task genuinely cannot complete). It never touches queued/needs_approval/completed/failed/blocked.
export const STUCK_AGENT_TASK_TIMEOUT_MIN = Number(process.env.STUCK_AGENT_TASK_TIMEOUT_MIN ?? "180");

export function selectStuckAgentTasks(
  tasks: Array<Pick<AgentTask, "id" | "status" | "updatedAt" | "kind">>,
  opts: { nowMs: number; timeoutMinutes?: number }
): Array<{ id: string; ageMinutes: number }> {
  const timeoutMs = Math.max(1, opts.timeoutMinutes ?? STUCK_AGENT_TASK_TIMEOUT_MIN) * 60 * 1000;
  const out: Array<{ id: string; ageMinutes: number }> = [];
  for (const t of tasks) {
    if (String(t?.status ?? "") !== "running") continue; // only a live-marked task can be a dead runner
    const at = Date.parse(String(t?.updatedAt ?? ""));
    if (!Number.isFinite(at)) continue; // unknown age → leave it (never reap on a guess)
    const ageMs = opts.nowMs - at;
    if (ageMs <= timeoutMs) continue; // still within a plausible run window → keep
    out.push({ id: String(t.id), ageMinutes: Math.round(ageMs / 60000) });
  }
  return out;
}

/**
 * Reap stuck "running" tasks → "failed". Returns the ids it failed. Fail-safe: uses the pure
 * selection above (conservative timeout, running-only). Idempotent — a task it already failed is no
 * longer "running", so a re-run is a no-op.
 */
export async function reapStuckAgentTasks(opts: { nowMs: number; timeoutMinutes?: number } = { nowMs: Date.now() }): Promise<string[]> {
  await ensureLoaded();
  const stuck = selectStuckAgentTasks(rows, opts);
  for (const s of stuck) {
    const task = rows.find(row => row.id === s.id);
    if (!task) continue;
    task.status = "failed";
    task.updatedAt = new Date().toISOString();
    task.output = {
      ...(task.output ?? {}),
      summary: `Auto-failed: stuck in "running" for ${s.ageMinutes}m (runner died/hung, exceeded ${
        opts.timeoutMinutes ?? STUCK_AGENT_TASK_TIMEOUT_MIN
      }m timeout).`
    };
  }
  if (stuck.length) scheduleSave();
  return stuck.map(s => s.id);
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
