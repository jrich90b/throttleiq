import { promises as fs } from "node:fs";
import * as path from "node:path";
import crypto from "node:crypto";
import { dataPath } from "./dataDir.js";

export type TwilioInboundJobStatus = "queued" | "processing" | "completed" | "failed";

export type TwilioInboundJob = {
  id: string;
  status: TwilioInboundJobStatus;
  providerMessageId?: string;
  dedupeKey: string;
  payload: Record<string, string>;
  attempts: number;
  lastError?: string;
  responseStatus?: number;
  responseBody?: string;
  responseBodySnippet?: string;
  deliverResponseViaRest?: boolean;
  deliveredMessageSids?: string[];
  deliveredAt?: string;
  deliveryDryRun?: boolean;
  systemMode?: string;
  receivedAt: string;
  nextAttemptAt?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
};

const STORE_PATH = process.env.TWILIO_INBOUND_JOBS_PATH || dataPath("twilio_inbound_jobs.json");
const MAX_ROWS = Number(process.env.TWILIO_INBOUND_JOBS_MAX_ROWS ?? "1000");

let loaded = false;
let rows: TwilioInboundJob[] = [];
let saveTimer: NodeJS.Timeout | null = null;
let saveSeq = 0;

function normalizePayload(payload: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (typeof value === "string") out[key] = value;
    else if (Array.isArray(value)) out[key] = value.map(v => String(v ?? "")).join(",");
    else if (value != null) out[key] = String(value);
    else out[key] = "";
  }
  return out;
}

export function buildTwilioInboundDedupeKey(payload: Record<string, unknown>): {
  providerMessageId?: string;
  dedupeKey: string;
} {
  const providerMessageId = String(payload.MessageSid ?? payload.SmsSid ?? "").trim() || undefined;
  if (providerMessageId) return { providerMessageId, dedupeKey: `sid:${providerMessageId}` };
  const hashInput = JSON.stringify({
    from: payload.From ?? "",
    to: payload.To ?? "",
    body: payload.Body ?? "",
    numMedia: payload.NumMedia ?? "",
    media0: payload.MediaUrl0 ?? ""
  });
  return {
    dedupeKey: `hash:${crypto.createHash("sha256").update(hashInput).digest("hex").slice(0, 24)}`
  };
}

export async function enqueueTwilioInboundJob(input: {
  payload: Record<string, unknown>;
  receivedAt?: string;
  deliverResponseViaRest?: boolean;
  systemMode?: string;
}): Promise<{ job: TwilioInboundJob; created: boolean }> {
  await ensureLoaded();
  const normalizedPayload = normalizePayload(input.payload);
  const { providerMessageId, dedupeKey } = buildTwilioInboundDedupeKey(normalizedPayload);
  const existing = rows.find(row => row.dedupeKey === dedupeKey);
  if (existing) return { job: existing, created: false };

  const now = new Date().toISOString();
  const job: TwilioInboundJob = {
    id: `twilio_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    status: "queued",
    providerMessageId,
    dedupeKey,
    payload: normalizedPayload,
    attempts: 0,
    deliverResponseViaRest: input.deliverResponseViaRest === true,
    systemMode: input.systemMode,
    receivedAt: input.receivedAt || now,
    createdAt: now,
    updatedAt: now
  };
  rows.unshift(job);
  trimRows();
  scheduleSave();
  return { job, created: true };
}

export async function getTwilioInboundJob(id: string): Promise<TwilioInboundJob | null> {
  await ensureLoaded();
  return rows.find(row => row.id === id) ?? null;
}

export async function listTwilioInboundJobs(limit = 100): Promise<TwilioInboundJob[]> {
  await ensureLoaded();
  const bounded = Math.max(1, Math.min(1000, Math.floor(limit)));
  return [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, bounded);
}

export async function listPendingTwilioInboundJobs(limit = 50): Promise<TwilioInboundJob[]> {
  await ensureLoaded();
  const nowMs = Date.now();
  const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
  return rows
    .filter(row => row.status === "queued" || row.status === "failed")
    .filter(row => !row.nextAttemptAt || Date.parse(row.nextAttemptAt) <= nowMs)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, bounded);
}

export async function updateTwilioInboundJob(
  id: string,
  patch: Partial<Omit<TwilioInboundJob, "id" | "createdAt">>
): Promise<TwilioInboundJob | null> {
  await ensureLoaded();
  const job = rows.find(row => row.id === id);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  trimRows();
  scheduleSave();
  return job;
}

export async function flushTwilioInboundJobs(): Promise<void> {
  if (!loaded) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await saveNow();
}

function isTwilioInboundJob(row: any): row is TwilioInboundJob {
  return (
    !!row &&
    typeof row === "object" &&
    typeof row.id === "string" &&
    typeof row.status === "string" &&
    typeof row.dedupeKey === "string" &&
    typeof row.payload === "object" &&
    typeof row.createdAt === "string"
  );
}

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    rows = Array.isArray(parsed) ? parsed.filter(isTwilioInboundJob) : [];
  } catch {
    rows = [];
  }
}

function trimRows() {
  const maxRows = Number.isFinite(MAX_ROWS) && MAX_ROWS > 0 ? Math.floor(MAX_ROWS) : 1000;
  if (rows.length > maxRows) rows = rows.slice(0, maxRows);
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    // Fire-and-forget, so it must swallow-and-log: an uncaught rejection here is an unhandled
    // promise rejection in the API process, which is how this bug first showed up in the error log.
    void saveNow().catch(err => {
      console.warn("⚠️ twilio inbound job store save failed:", err?.message ?? err);
    });
  }, 100);
  (saveTimer as any).unref?.();
}

/**
 * This is the inbound-SMS job queue, so a lost write is a customer message we may not answer.
 *
 * The debounced `scheduleSave()` timer and an awaited `flushTwilioInboundJobs()` can overlap, and
 * with a FIXED `<file>.tmp` name that overlap loses writes: both open the same temp path, one
 * rename publishes the other's bytes, and the loser fails
 * `ENOENT: ... rename 'twilio_inbound_jobs.json.tmp' -> 'twilio_inbound_jobs.json'` — 25 of those in
 * the production error log as of 2026-08-10. Same defect and same fix as `writeFileTextAtomic` in
 * `storePersistence.ts`: a unique temp name per write, and one write at a time.
 */
let saveChain: Promise<void> = Promise.resolve();

async function saveOnce() {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  const tmpPath = `${STORE_PATH}.${process.pid}.${++saveSeq}.tmp`;
  try {
    await fs.writeFile(tmpPath, `${JSON.stringify(rows, null, 2)}\n`);
    await fs.rename(tmpPath, STORE_PATH);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

async function saveNow() {
  // Chain off the previous save whether it settled ok or not, so one failure cannot strand the rest.
  const run = saveChain.then(
    () => saveOnce(),
    () => saveOnce()
  );
  saveChain = run.then(
    () => {},
    () => {}
  );
  return run;
}
