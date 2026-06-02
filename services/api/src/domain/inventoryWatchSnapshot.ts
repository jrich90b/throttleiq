import { promises as fs } from "node:fs";
import path from "node:path";

export type InventorySnapshotItem = {
  key: string;
  stockId?: string;
  vin?: string;
  year?: string;
  model?: string;
  color?: string;
};

export type InventorySnapshot = {
  savedAt: string;
  items: InventorySnapshotItem[];
};

export type InventorySnapshotLoadStatus = "ok" | "missing" | "invalid" | "empty";

export type InventorySnapshotLoadResult = {
  snapshot: InventorySnapshot;
  trusted: boolean;
  status: InventorySnapshotLoadStatus;
  error?: string;
};

export type InventoryWatchScanPlan = {
  allowNotifications: boolean;
  reason: "ok" | "missing_snapshot" | "invalid_snapshot" | "empty_snapshot" | "bulk_resync";
  newItems: any[];
  previousCount: number;
  currentCount: number;
  newCount: number;
  newRatio: number;
};

export function inventorySnapshotKey(item: any): string | null {
  const directKey = String(item?.stockId ?? item?.stock ?? item?.stockNumber ?? item?.vin ?? "").trim();
  const key = directKey || [item?.year ?? "", item?.model ?? "", item?.color ?? ""].join("|").trim();
  return key ? String(key).toLowerCase() : null;
}

function emptySnapshot(): InventorySnapshot {
  return { savedAt: new Date(0).toISOString(), items: [] };
}

function normalizeSnapshotItems(items: any[]): InventorySnapshotItem[] {
  return items
    .map(item => ({
      key: inventorySnapshotKey(item) ?? "",
      stockId: item?.stockId ?? item?.stock ?? item?.stockNumber,
      vin: item?.vin,
      year: item?.year,
      model: item?.model,
      color: item?.color
    }))
    .filter(item => item.key);
}

export function buildInventorySnapshot(items: any[], savedAt = new Date().toISOString()): InventorySnapshot {
  return {
    savedAt,
    items: normalizeSnapshotItems(items)
  };
}

export function inventoryWatchItemMatchesLastNotifiedStock(
  lastNotifiedStockId: string | null | undefined,
  item: any
): boolean {
  const last = String(lastNotifiedStockId ?? "").trim().toLowerCase();
  if (!last) return false;
  const candidates = [
    inventorySnapshotKey(item),
    item?.stockId,
    item?.stock,
    item?.stockNumber,
    item?.vin
  ]
    .map(value => String(value ?? "").trim().toLowerCase())
    .filter(Boolean);
  return candidates.includes(last);
}

export async function loadInventorySnapshotFile(filePath: string): Promise<InventorySnapshotLoadResult> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as InventorySnapshot;
    if (!Array.isArray(parsed?.items)) {
      return {
        snapshot: emptySnapshot(),
        trusted: false,
        status: "invalid",
        error: "snapshot items are missing"
      };
    }
    const snapshot = {
      savedAt: parsed.savedAt || new Date(0).toISOString(),
      items: normalizeSnapshotItems(parsed.items)
    };
    if (!snapshot.items.length) {
      return { snapshot, trusted: false, status: "empty" };
    }
    return { snapshot, trusted: true, status: "ok" };
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return { snapshot: emptySnapshot(), trusted: false, status: "missing" };
    }
    return {
      snapshot: emptySnapshot(),
      trusted: false,
      status: "invalid",
      error: error?.message ?? String(error)
    };
  }
}

export async function saveInventorySnapshotFile(filePath: string, items: any[]): Promise<void> {
  const payload = buildInventorySnapshot(items);
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function buildInventoryWatchScanPlan(args: {
  snapshotResult: InventorySnapshotLoadResult;
  items: any[];
  bulkNewItemThreshold?: number;
  bulkNewItemRatio?: number;
}): InventoryWatchScanPlan {
  const currentItems = args.items ?? [];
  const currentCount = currentItems.length;
  const previousCount = args.snapshotResult.snapshot.items.length;
  const prevKeys = new Set(args.snapshotResult.snapshot.items.map(item => item.key).filter(Boolean));
  const newItems = currentItems.filter(item => {
    const key = inventorySnapshotKey(item);
    return key && !prevKeys.has(key);
  });
  const newCount = newItems.length;
  const newRatio = currentCount ? newCount / currentCount : 0;

  if (!args.snapshotResult.trusted) {
    const reason =
      args.snapshotResult.status === "missing"
        ? "missing_snapshot"
        : args.snapshotResult.status === "empty"
          ? "empty_snapshot"
          : "invalid_snapshot";
    return { allowNotifications: false, reason, newItems: [], previousCount, currentCount, newCount, newRatio };
  }

  const rawThreshold = Number(args.bulkNewItemThreshold);
  const rawRatio = Number(args.bulkNewItemRatio);
  const threshold = Number.isFinite(rawThreshold) ? Math.max(1, Math.floor(rawThreshold)) : 10;
  const ratio = Number.isFinite(rawRatio) ? Math.max(0, Math.min(1, rawRatio)) : 0.2;
  if (newCount >= threshold && newRatio >= ratio) {
    return { allowNotifications: false, reason: "bulk_resync", newItems: [], previousCount, currentCount, newCount, newRatio };
  }

  return { allowNotifications: true, reason: "ok", newItems, previousCount, currentCount, newCount, newRatio };
}
