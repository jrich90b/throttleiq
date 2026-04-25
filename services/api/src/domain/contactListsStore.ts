import { promises as fs } from "node:fs";
import { dataPath } from "./dataDir.js";

export type ContactListFilter = {
  condition?: string;
  year?: string;
  make?: string;
  model?: string;
  motorcycleInterest?: string;
};

export type ContactListEntry = {
  id: string;
  name: string;
  source?: "manual" | "csv" | "filter";
  contactIds?: string[];
  filter?: ContactListFilter;
  createdAt: string;
  updatedAt: string;
  lastImportAt?: string;
};

const DB_PATH = process.env.CONTACT_LISTS_DB_PATH
  ? String(process.env.CONTACT_LISTS_DB_PATH)
  : dataPath("contact_lists.json");

const lists = new Map<string, ContactListEntry>();
let saveTimer: NodeJS.Timeout | null = null;

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  return `cl_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

async function saveToDisk() {
  const payload = {
    version: 1,
    savedAt: nowIso(),
    lists: Array.from(lists.values())
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
  }, 200);
}

async function loadFromDisk() {
  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    const parsed = JSON.parse(raw) as { lists?: ContactListEntry[] };
    lists.clear();
    for (const row of parsed?.lists ?? []) {
      if (!row?.id) continue;
      lists.set(row.id, {
        ...row,
        contactIds: Array.isArray(row.contactIds) ? row.contactIds.filter(Boolean) : []
      });
    }
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      await saveToDisk();
    }
  }
}

void loadFromDisk();

function normalizeFilter(filter?: ContactListFilter | null): ContactListFilter | undefined {
  if (!filter) return undefined;
  const condition = String(filter.condition ?? "").trim().toLowerCase();
  const year = String(filter.year ?? "").trim();
  const make = String(filter.make ?? "").trim();
  const model = String(filter.model ?? "").trim();
  const motorcycleInterest = String(filter.motorcycleInterest ?? "").trim();
  const normalized: ContactListFilter = {};
  if (condition) normalized.condition = condition;
  if (year) normalized.year = year;
  if (make) normalized.make = make;
  if (model) normalized.model = model;
  if (motorcycleInterest) normalized.motorcycleInterest = motorcycleInterest;
  if (
    !normalized.condition &&
    !normalized.year &&
    !normalized.make &&
    !normalized.model &&
    !normalized.motorcycleInterest
  ) {
    return undefined;
  }
  return normalized;
}

function uniqIds(input?: string[]): string[] {
  return Array.from(
    new Set((input ?? []).map(v => String(v ?? "").trim()).filter(Boolean))
  );
}

export function listContactLists(): ContactListEntry[] {
  return Array.from(lists.values()).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export function getContactList(id: string): ContactListEntry | null {
  return lists.get(id) ?? null;
}

export function createContactList(input: {
  name: string;
  source?: "manual" | "csv" | "filter";
  contactIds?: string[];
  filter?: ContactListFilter;
}): ContactListEntry {
  const now = nowIso();
  const entry: ContactListEntry = {
    id: makeId(),
    name: String(input.name ?? "").trim() || "Untitled list",
    source: input.source ?? "manual",
    contactIds: uniqIds(input.contactIds),
    filter: normalizeFilter(input.filter),
    createdAt: now,
    updatedAt: now
  };
  lists.set(entry.id, entry);
  scheduleSave();
  return entry;
}

export function updateContactList(
  id: string,
  patch: {
    name?: string;
    source?: "manual" | "csv" | "filter";
    contactIds?: string[];
    filter?: ContactListFilter | null;
    lastImportAt?: string | null;
  }
): ContactListEntry | null {
  const existing = lists.get(id);
  if (!existing) return null;
  const next: ContactListEntry = {
    ...existing,
    name: patch.name != null ? String(patch.name).trim() || existing.name : existing.name,
    source: patch.source ?? existing.source,
    contactIds: patch.contactIds ? uniqIds(patch.contactIds) : existing.contactIds ?? [],
    filter:
      patch.filter !== undefined
        ? normalizeFilter(patch.filter)
        : existing.filter,
    updatedAt: nowIso()
  };
  if (patch.lastImportAt === null) {
    delete next.lastImportAt;
  } else if (patch.lastImportAt) {
    next.lastImportAt = patch.lastImportAt;
  }
  lists.set(id, next);
  scheduleSave();
  return next;
}

export function addContactsToList(id: string, contactIds: string[]): ContactListEntry | null {
  const existing = lists.get(id);
  if (!existing) return null;
  const merged = uniqIds([...(existing.contactIds ?? []), ...contactIds]);
  return updateContactList(id, { contactIds: merged, lastImportAt: nowIso() });
}

export function deleteContactList(id: string): boolean {
  const ok = lists.delete(id);
  if (ok) scheduleSave();
  return ok;
}
