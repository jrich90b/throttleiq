import { promises as fs } from "node:fs";
import { dataPath } from "./dataDir.js";

export type InventorySoldItem = {
  id: string;
  stockId?: string;
  vin?: string;
  label?: string;
  leadKey?: string;
  convId?: string;
  note?: string;
  soldAt: string;
  soldById?: string;
  soldByName?: string;
  createdAt: string;
  updatedAt: string;
};

type InventorySoldStore = {
  solds: Record<string, InventorySoldItem>;
  savedAt?: string;
};

const FILE_NAME = "inventory_solds.json";

export function normalizeInventorySoldKey(stockId?: string | null, vin?: string | null): string | null {
  const stock = String(stockId ?? "").trim();
  if (stock) return stock.toLowerCase();
  const v = String(vin ?? "").trim();
  if (v) return v.toLowerCase();
  return null;
}

async function loadStore(): Promise<InventorySoldStore> {
  const filePath = dataPath(FILE_NAME);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      solds: parsed?.solds ?? {},
      savedAt: parsed?.savedAt
    };
  } catch (err: any) {
    if (err?.code === "ENOENT") return { solds: {} };
    throw err;
  }
}

async function saveStore(store: InventorySoldStore): Promise<void> {
  const filePath = dataPath(FILE_NAME);
  const payload = {
    solds: store.solds ?? {},
    savedAt: new Date().toISOString()
  };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
}

export async function listInventorySolds(): Promise<Record<string, InventorySoldItem>> {
  const store = await loadStore();
  return store.solds ?? {};
}

export async function getInventorySold(
  stockId?: string | null,
  vin?: string | null
): Promise<InventorySoldItem | null> {
  const key = normalizeInventorySoldKey(stockId, vin);
  if (!key) return null;
  const store = await loadStore();
  return store.solds?.[key] ?? null;
}

export async function setInventorySold(opts: {
  stockId?: string | null;
  vin?: string | null;
  sold: InventorySoldItem;
}): Promise<void> {
  const key = normalizeInventorySoldKey(opts.stockId, opts.vin);
  if (!key) return;
  const store = await loadStore();
  store.solds[key] = opts.sold;
  await saveStore(store);
}

export async function clearInventorySold(
  stockId?: string | null,
  vin?: string | null
): Promise<void> {
  const key = normalizeInventorySoldKey(stockId, vin);
  if (!key) return;
  const store = await loadStore();
  if (store.solds?.[key]) {
    delete store.solds[key];
    await saveStore(store);
  }
}
