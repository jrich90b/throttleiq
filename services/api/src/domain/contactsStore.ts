import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { dataPath } from "./dataDir.js";

export type ContactEntry = {
  id: string;
  leadKey?: string;
  conversationId?: string;
  leadRef?: string;
  leadSource?: string;
  leadSourceId?: number;
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  phone?: string;
  vehicleDescription?: string;
  stockId?: string;
  vin?: string;
  year?: string;
  make?: string;
  vehicle?: string;
  model?: string;
  trim?: string;
  color?: string;
  condition?: string;
  inquiry?: string;
  lastAdfAt?: string;
  lastInboundAt?: string;
  createdAt: string;
  updatedAt: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PATH = dataPath("contacts.json");

const DB_PATH = process.env.CONTACTS_DB_PATH
  ? path.resolve(process.env.CONTACTS_DB_PATH)
  : DEFAULT_PATH;

const contacts = new Map<string, ContactEntry>();
let saveTimer: NodeJS.Timeout | null = null;

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  return `contact_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function normalizePhone(input?: string): string | undefined {
  if (!input) return undefined;
  const raw = String(input).trim();
  if (!raw) return undefined;
  if (raw.startsWith("+")) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw;
}

function normalizeEmail(input?: string): string | undefined {
  if (!input) return undefined;
  const trimmed = String(input).trim().toLowerCase();
  return trimmed || undefined;
}

async function ensureDirForFile(filePath: string) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

async function saveToDisk() {
  await ensureDirForFile(DB_PATH);
  const payload = {
    version: 1,
    savedAt: nowIso(),
    contacts: Array.from(contacts.values())
  };
  const tmp = `${DB_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmp, DB_PATH);
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveToDisk();
  }, 250);
}

async function loadFromDisk() {
  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    const parsed = JSON.parse(raw) as { contacts?: ContactEntry[] };
    contacts.clear();
    for (const c of parsed?.contacts ?? []) {
      if (c?.id) contacts.set(c.id, c);
    }
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      await ensureDirForFile(DB_PATH);
      await saveToDisk();
      return;
    }
  }
}

void loadFromDisk();

function findExisting(email?: string, phone?: string): ContactEntry | null {
  const e = normalizeEmail(email);
  const p = normalizePhone(phone);
  for (const c of contacts.values()) {
    if (p && normalizePhone(c.phone) === p) return c;
    if (e && normalizeEmail(c.email) === e) return c;
  }
  return null;
}

export function listContacts(): ContactEntry[] {
  return Array.from(contacts.values()).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export function upsertContact(input: Partial<ContactEntry>): ContactEntry {
  const existing = findExisting(input.email, input.phone);
  const now = nowIso();
  if (existing) {
    const updated: ContactEntry = {
      ...existing,
      ...input,
      phone: normalizePhone(input.phone ?? existing.phone),
      email: normalizeEmail(input.email ?? existing.email),
      updatedAt: now
    };
    contacts.set(updated.id, updated);
    scheduleSave();
    return updated;
  }

  const created: ContactEntry = {
    id: makeId(),
    leadKey: input.leadKey,
    conversationId: input.conversationId,
    leadRef: input.leadRef,
    leadSource: input.leadSource,
    leadSourceId: input.leadSourceId,
    firstName: input.firstName,
    lastName: input.lastName,
    name: input.name,
    email: normalizeEmail(input.email),
    phone: normalizePhone(input.phone),
    vehicleDescription: input.vehicleDescription,
    stockId: input.stockId,
    vin: input.vin,
    year: input.year,
    make: input.make,
    vehicle: input.vehicle,
    model: input.model,
    trim: input.trim,
    color: input.color,
    condition: input.condition,
    inquiry: input.inquiry,
    lastAdfAt: input.lastAdfAt,
    createdAt: now,
    updatedAt: now
  };
  contacts.set(created.id, created);
  scheduleSave();
  return created;
}

export function updateContact(
  id: string,
  patch: Partial<ContactEntry>
): ContactEntry | null {
  const existing = contacts.get(id);
  if (!existing) return null;
  const now = nowIso();
  const nextPhone = normalizePhone(patch.phone ?? existing.phone);
  const prevPhone = normalizePhone(existing.phone);
  const leadKeyLooksPhone = !!(existing.leadKey && normalizePhone(existing.leadKey));
  let nextLeadKey = existing.leadKey;
  if (patch.phone !== undefined) {
    if (!existing.leadKey || leadKeyLooksPhone || (prevPhone && normalizePhone(existing.leadKey) === prevPhone)) {
      nextLeadKey = nextPhone ?? existing.leadKey;
    }
  }
  const next: ContactEntry = {
    ...existing,
    leadKey: nextLeadKey,
    firstName: patch.firstName ?? existing.firstName,
    lastName: patch.lastName ?? existing.lastName,
    name: patch.name ?? existing.name,
    email: normalizeEmail(patch.email ?? existing.email),
    phone: nextPhone,
    leadSource: patch.leadSource ?? existing.leadSource,
    leadSourceId: patch.leadSourceId ?? existing.leadSourceId,
    leadRef: patch.leadRef ?? existing.leadRef,
    vehicleDescription: patch.vehicleDescription ?? existing.vehicleDescription,
    year: patch.year ?? existing.year,
    make: patch.make ?? existing.make,
    vehicle: patch.vehicle ?? existing.vehicle,
    model: patch.model ?? existing.model,
    trim: patch.trim ?? existing.trim,
    color: patch.color ?? existing.color,
    condition: patch.condition ?? existing.condition,
    inquiry: patch.inquiry ?? existing.inquiry,
    updatedAt: now
  };
  contacts.set(next.id, next);
  scheduleSave();
  return next;
}

export function deleteContact(id: string): boolean {
  const existed = contacts.delete(id);
  if (existed) scheduleSave();
  return existed;
}
