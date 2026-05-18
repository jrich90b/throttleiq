import { promises as fs } from "node:fs";
import * as path from "node:path";
import { dataPath } from "./dataDir.js";

export type OpsAnomalyType =
  | "routing"
  | "task_inbox"
  | "cadence"
  | "inventory"
  | "integration"
  | "ui"
  | "tone"
  | "other";

export type OpsAnomalySeverity = "info" | "warning" | "error";

export type OpsAnomaly = {
  id: string;
  type: OpsAnomalyType;
  severity: OpsAnomalySeverity;
  title: string;
  note?: string;
  createdAt: string;
  status: "open" | "triaged" | "closed";
  reporter?: {
    id?: string;
    name?: string;
    email?: string;
    role?: string;
  };
  context?: {
    dealerId?: string | null;
    dealerName?: string | null;
    convId?: string | null;
    leadKey?: string | null;
    leadName?: string | null;
    taskId?: string | null;
    taskReason?: string | null;
    taskSummary?: string | null;
    routeBucket?: string | null;
    routeCta?: string | null;
    pageUrl?: string | null;
    section?: string | null;
  };
  external?: {
    incidentResult?: {
      sentryEventId?: string;
      slackSent?: boolean;
      linearIssueId?: string;
      deduped?: boolean;
    };
  };
};

const STORE_PATH = process.env.OPS_ANOMALIES_PATH || dataPath("ops_anomalies.json");
const MAX_ROWS = Number(process.env.OPS_ANOMALIES_MAX_ROWS ?? "2000");

let loaded = false;
let rows: OpsAnomaly[] = [];
let saveTimer: NodeJS.Timeout | null = null;

export async function listOpsAnomalies(limit = 200): Promise<OpsAnomaly[]> {
  await ensureLoaded();
  const bounded = Math.max(1, Math.min(1000, Math.floor(limit)));
  return [...rows]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, bounded);
}

export async function addOpsAnomaly(input: Omit<OpsAnomaly, "id" | "createdAt" | "status">): Promise<OpsAnomaly> {
  await ensureLoaded();
  const now = new Date().toISOString();
  const anomaly: OpsAnomaly = {
    ...input,
    id: `ops_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
    status: "open"
  };
  rows.unshift(anomaly);
  const maxRows = Number.isFinite(MAX_ROWS) && MAX_ROWS > 0 ? Math.floor(MAX_ROWS) : 2000;
  if (rows.length > maxRows) rows = rows.slice(0, maxRows);
  scheduleSave();
  return anomaly;
}

export async function updateOpsAnomalyExternal(
  id: string,
  external: NonNullable<OpsAnomaly["external"]>
): Promise<OpsAnomaly | null> {
  await ensureLoaded();
  const anomaly = rows.find(row => row.id === id);
  if (!anomaly) return null;
  anomaly.external = { ...(anomaly.external ?? {}), ...external };
  scheduleSave();
  return anomaly;
}

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    rows = Array.isArray(parsed) ? parsed.filter(isOpsAnomaly) : [];
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

function isOpsAnomaly(row: any): row is OpsAnomaly {
  return !!row && typeof row === "object" && typeof row.id === "string" && typeof row.createdAt === "string";
}
