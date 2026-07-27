import { promises as fs } from "node:fs";
import { dataPath } from "./dataDir.js";

export type InventoryNoteItem = {
  id: string;
  label?: string;
  note: string;
  updatedAt: string;
  expiresAt?: string;
};

type InventoryNoteEntry = {
  notes: InventoryNoteItem[];
  updatedAt: string;
};

type InventoryNotesStore = {
  notes: Record<string, InventoryNoteEntry>;
  savedAt?: string;
};

const FILE_NAME = "inventory_notes.json";

function normalizeKey(stockId?: string | null, vin?: string | null): string | null {
  const stock = (stockId ?? "").trim();
  if (stock) return stock.toLowerCase();
  const v = (vin ?? "").trim();
  if (v) return v.toLowerCase();
  return null;
}

function isExpired(expiresAt?: string): boolean {
  if (!expiresAt) return false;
  // Treat date-only strings as inclusive through that day.
  const today = new Date().toISOString().slice(0, 10);
  return expiresAt < today;
}

async function loadStore(): Promise<InventoryNotesStore> {
  const filePath = dataPath(FILE_NAME);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      notes: parsed?.notes ?? {},
      savedAt: parsed?.savedAt
    };
  } catch (err: any) {
    if (err?.code === "ENOENT") return { notes: {} };
    throw err;
  }
}

export function isInventoryNoteExpired(expiresAt?: string): boolean {
  return isExpired(expiresAt);
}

/**
 * Model/year-scope guard for surfacing a unit's inventory note in customer copy (Joe ruling
 * 2026-07-27). An inventory note (e.g. the "$1,000 trade-in credit" that lives on the 2025
 * Breakout stock) belongs to the UNIT it is listed under — it must only be narrated for that same
 * model+year, never borrowed onto another year's unit when the inventory lookup was broadened
 * across years (findInventoryMatches({year:null}) fallback). A note whose unit year differs from
 * the year we are narrating (the model-label year) is cross-year misattribution and must be
 * dropped. Returns true (surface it) only when the unit's year matches the narrated year, or when
 * no specific year is being claimed. Fail direction: DROP the note (a generic touch) rather than
 * attach a wrong-year offer.
 */
export function inventoryNoteMatchesNarratedYear(
  unitYear: string | null | undefined,
  narratedYear: string | null | undefined
): boolean {
  const narrated = String(narratedYear ?? "").trim();
  if (!narrated) return true; // no year claimed → not a cross-year misattribution
  const unit = String(unitYear ?? "").trim();
  return unit === narrated;
}

async function saveStore(store: InventoryNotesStore): Promise<void> {
  const filePath = dataPath(FILE_NAME);
  const payload = {
    notes: store.notes ?? {},
    savedAt: new Date().toISOString()
  };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
}

export async function getInventoryNote(stockId?: string | null, vin?: string | null): Promise<string | null> {
  const key = normalizeKey(stockId, vin);
  if (!key) return null;
  const store = await loadStore();
  const entry = store.notes?.[key];
  if (!entry?.notes?.length) return null;
  const active = entry.notes.filter(n => !isExpired(n.expiresAt) && n.note?.trim());
  if (!active.length) return null;
  const top = active.slice(0, 2).map(n => n.note.trim());
  if (top.length === 1) return top[0];
  return `${top[0]} and ${top[1]}`;
}

export async function listInventoryNotes(): Promise<Record<string, InventoryNoteEntry>> {
  const store = await loadStore();
  return store.notes ?? {};
}

export async function setInventoryNote(opts: {
  stockId?: string | null;
  vin?: string | null;
  notes: InventoryNoteItem[];
}): Promise<void> {
  const key = normalizeKey(opts.stockId, opts.vin);
  if (!key) return;
  const store = await loadStore();
  const cleaned = (opts.notes ?? [])
    .map(n => ({
      id: n.id,
      label: n.label?.trim() || undefined,
      note: String(n.note ?? "").trim(),
      updatedAt: n.updatedAt || new Date().toISOString(),
      expiresAt: n.expiresAt ? String(n.expiresAt).trim() : undefined
    }))
    .filter(n => n.note);

  if (!cleaned.length) {
    delete store.notes[key];
    await saveStore(store);
    return;
  }
  store.notes[key] = { notes: cleaned, updatedAt: new Date().toISOString() };
  await saveStore(store);
}
