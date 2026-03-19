import { promises as fs } from "node:fs";
import { dataPath } from "./dataDir.js";

export type InventoryHoldItem = {
  id: string;
  stockId?: string;
  vin?: string;
  label?: string;
  leadKey?: string;
  convId?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
};

type InventoryHoldStore = {
  holds: Record<string, InventoryHoldItem>;
  savedAt?: string;
};

const FILE_NAME = "inventory_holds.json";

export function normalizeInventoryHoldKey(stockId?: string | null, vin?: string | null): string | null {
  const stock = String(stockId ?? "").trim();
  if (stock) return stock.toLowerCase();
  const v = String(vin ?? "").trim();
  if (v) return v.toLowerCase();
  return null;
}

async function loadStore(): Promise<InventoryHoldStore> {
  const filePath = dataPath(FILE_NAME);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      holds: parsed?.holds ?? {},
      savedAt: parsed?.savedAt
    };
  } catch (err: any) {
    if (err?.code === "ENOENT") return { holds: {} };
    throw err;
  }
}

async function saveStore(store: InventoryHoldStore): Promise<void> {
  const filePath = dataPath(FILE_NAME);
  const payload = {
    holds: store.holds ?? {},
    savedAt: new Date().toISOString()
  };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
}

export async function listInventoryHolds(): Promise<Record<string, InventoryHoldItem>> {
  const store = await loadStore();
  return store.holds ?? {};
}

export async function getInventoryHold(
  stockId?: string | null,
  vin?: string | null
): Promise<InventoryHoldItem | null> {
  const key = normalizeInventoryHoldKey(stockId, vin);
  if (!key) return null;
  const store = await loadStore();
  return store.holds?.[key] ?? null;
}

export async function setInventoryHold(opts: {
  stockId?: string | null;
  vin?: string | null;
  hold: InventoryHoldItem;
}): Promise<void> {
  const key = normalizeInventoryHoldKey(opts.stockId, opts.vin);
  if (!key) return;
  const store = await loadStore();
  store.holds[key] = opts.hold;
  await saveStore(store);
}

export async function clearInventoryHold(
  stockId?: string | null,
  vin?: string | null
): Promise<void> {
  const key = normalizeInventoryHoldKey(stockId, vin);
  if (!key) return;
  const store = await loadStore();
  if (store.holds?.[key]) {
    delete store.holds[key];
    await saveStore(store);
  }
}
