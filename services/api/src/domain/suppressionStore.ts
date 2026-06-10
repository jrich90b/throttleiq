import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { dataPath } from "./dataDir.js";
import { readJsonStoreText, writeJsonStoreText } from "./storePersistence.js";

export type SuppressionEntry = {
  phone: string;
  addedAt: string;
  reason?: string;
  source?: string;
};

const entries = new Map<string, SuppressionEntry>();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PATH = dataPath("suppressions.json");

const DB_PATH = process.env.SUPPRESSIONS_DB_PATH
  ? path.resolve(process.env.SUPPRESSIONS_DB_PATH)
  : DEFAULT_PATH;

function nowIso() {
  return new Date().toISOString();
}

function normalizePhone(input: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  if (raw.startsWith("+")) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw;
}

async function saveToDisk() {
  const payload = {
    version: 1,
    savedAt: nowIso(),
    suppressions: Array.from(entries.values())
  };
  await writeJsonStoreText({
    store: "suppressions",
    filePath: DB_PATH,
    text: JSON.stringify(payload, null, 2)
  });
}

async function loadFromDisk() {
  try {
    const raw = await readJsonStoreText({ store: "suppressions", filePath: DB_PATH });
    if (raw == null) {
      await saveToDisk();
      return;
    }
    const parsed = JSON.parse(raw) as { suppressions?: SuppressionEntry[] };
    entries.clear();
    for (const e of parsed?.suppressions ?? []) {
      if (e?.phone) entries.set(normalizePhone(e.phone), e);
    }
  } catch {
    // keep in-memory state on unexpected errors
  }
}

void loadFromDisk();

export function listSuppressions(): SuppressionEntry[] {
  return Array.from(entries.values());
}

export function isSuppressed(phone: string): boolean {
  const key = normalizePhone(phone);
  return !!(key && entries.has(key));
}

export async function addSuppression(
  phone: string,
  reason?: string,
  source?: string
): Promise<SuppressionEntry | null> {
  const key = normalizePhone(phone);
  if (!key) return null;
  const entry: SuppressionEntry = {
    phone: key,
    addedAt: nowIso(),
    reason,
    source
  };
  entries.set(key, entry);
  await saveToDisk();
  return entry;
}

export async function removeSuppression(phone: string): Promise<boolean> {
  const key = normalizePhone(phone);
  if (!key) return false;
  const existed = entries.delete(key);
  if (existed) await saveToDisk();
  return existed;
}
