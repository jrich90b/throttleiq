import { promises as fs } from "node:fs";
import { dataPath } from "./dataDir.js";

type InventoryNoteEntry = {
  note: string;
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
  return store.notes?.[key]?.note ?? null;
}

export async function listInventoryNotes(): Promise<Record<string, InventoryNoteEntry>> {
  const store = await loadStore();
  return store.notes ?? {};
}

export async function setInventoryNote(opts: { stockId?: string | null; vin?: string | null; note: string }): Promise<void> {
  const key = normalizeKey(opts.stockId, opts.vin);
  if (!key) return;
  const store = await loadStore();
  const note = String(opts.note ?? "").trim();
  if (!note) {
    delete store.notes[key];
    await saveStore(store);
    return;
  }
  store.notes[key] = { note, updatedAt: new Date().toISOString() };
  await saveStore(store);
}
