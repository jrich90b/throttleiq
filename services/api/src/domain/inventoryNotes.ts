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
  return top.join(" ");
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
