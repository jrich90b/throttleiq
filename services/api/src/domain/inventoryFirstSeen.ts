/**
 * Inventory first-seen map (read-mostly state tracking).
 *
 * The watch-fire cron (processInventoryWatchlist) notifies a customer ONLY when a matching unit is a
 * NEW arrival (a feed key absent from the prior snapshot) — a unit that was already in stock when the
 * watch was created is intentionally NOT fired (Joe's policy: assume they passed on it). The snapshot
 * is key-only with a single `savedAt`, so it cannot tell the watch_fire_miss DETECTOR *when* a unit
 * first appeared. Without that, the detector keeps flagging already-in-stock leads as "never notified"
 * misses even though the cron correctly held off.
 *
 * This map records, per canonical inventory key, the timestamp a unit was FIRST seen in the feed and
 * whether it was a BASELINE unit (present at first reconcile or during an untrusted/bulk-resync sweep
 * — i.e. NOT a genuine arrival the cron would fire on). The detector consults it so a never-notified
 * watch is a miss ONLY when a matching unit genuinely arrived AFTER the watch was created.
 *
 * Keying mirrors the snapshot exactly (`inventorySnapshotKey`) so the first-seen map, the cron's
 * new-arrival diff, and the detector all agree on unit identity. Pure core (`reconcileFirstSeen`) +
 * thin atomic IO (mirrors saveInventorySnapshotFile). Never deletes a key (a unit that blips out of a
 * flaky feed and returns keeps its original firstSeenAt — it is not re-counted as a fresh arrival).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { inventorySnapshotKey } from "./inventoryWatchSnapshot.js";

// Baseline entries (present at first reconcile, or seen during an untrusted/bulk-resync sweep) carry
// the epoch sentinel so the detector's "firstSeenAt > watch.createdAt" test excludes them even if a
// consumer ignores the `baseline` flag.
export const FIRST_SEEN_BASELINE_AT = new Date(0).toISOString();

export type FirstSeenEntry = {
  key: string;
  firstSeenAt: string; // ISO; epoch sentinel for baseline units
  baseline: boolean; // true => seeded baseline / untrusted sweep, NOT a genuine arrival
  stockId?: string;
  vin?: string;
  year?: string;
  model?: string;
  color?: string;
};

export type InventoryFirstSeenMap = {
  savedAt: string;
  entries: Record<string, FirstSeenEntry>;
};

export function emptyFirstSeenMap(): InventoryFirstSeenMap {
  return { savedAt: new Date(0).toISOString(), entries: {} };
}

function entryFromItem(item: any, key: string, firstSeenAt: string, baseline: boolean): FirstSeenEntry {
  return {
    key,
    firstSeenAt,
    baseline,
    stockId: item?.stockId ?? item?.stock ?? item?.stockNumber,
    vin: item?.vin,
    year: item?.year,
    model: item?.model,
    color: item?.color
  };
}

/**
 * Pure: fold the current feed into the prior first-seen map.
 *
 * - First reconcile (`prev` null/empty) => BASELINE: every current unit is recorded with the epoch
 *   sentinel + baseline:true and nothing is reported as an arrival (so existing inventory never reads
 *   as a fresh arrival the cron should have fired).
 * - Otherwise, a feed key absent from `prev` is a fresh key. It is a genuine ARRIVAL only when
 *   `arrivalsTrusted` is true (the cron's scanPlan.allowNotifications — false on untrusted/bulk-resync
 *   sweeps, which are feed artifacts, not real arrivals); otherwise it is recorded as baseline.
 * - Existing entries are preserved verbatim (a baseline unit stays baseline forever; firstSeenAt is
 *   never moved). Keys that vanished from the feed are RETAINED, never deleted.
 */
export function reconcileFirstSeen(args: {
  prev: InventoryFirstSeenMap | null | undefined;
  feedItems: any[];
  arrivalsTrusted: boolean;
  now?: string;
}): { next: InventoryFirstSeenMap; isBaselineSweep: boolean; arrivedKeys: string[] } {
  const now = args.now ?? new Date().toISOString();
  const prevEntries = args.prev?.entries ?? {};
  const isBaselineSweep = Object.keys(prevEntries).length === 0;
  const nextEntries: Record<string, FirstSeenEntry> = { ...prevEntries };
  const arrivedKeys: string[] = [];

  for (const item of args.feedItems ?? []) {
    const key = inventorySnapshotKey(item);
    if (!key) continue;
    if (nextEntries[key]) continue; // already tracked — never move firstSeenAt
    if (isBaselineSweep || !args.arrivalsTrusted) {
      nextEntries[key] = entryFromItem(item, key, FIRST_SEEN_BASELINE_AT, true);
    } else {
      nextEntries[key] = entryFromItem(item, key, now, false);
      arrivedKeys.push(key);
    }
  }

  return { next: { savedAt: now, entries: nextEntries }, isBaselineSweep, arrivedKeys };
}

/** Was this unit a genuine arrival AFTER the given watch was created? (false for baseline/unknown.) */
export function unitArrivedAfter(
  entry: FirstSeenEntry | undefined,
  watchCreatedAt: string | null | undefined
): boolean {
  if (!entry || entry.baseline) return false;
  const seen = Date.parse(entry.firstSeenAt);
  const created = Date.parse(String(watchCreatedAt ?? ""));
  if (!Number.isFinite(seen) || !Number.isFinite(created)) return false;
  return seen > created;
}

export async function loadInventoryFirstSeen(filePath: string): Promise<InventoryFirstSeenMap | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as InventoryFirstSeenMap;
    if (!parsed || typeof parsed !== "object" || !parsed.entries || typeof parsed.entries !== "object") {
      return null;
    }
    return { savedAt: parsed.savedAt || new Date(0).toISOString(), entries: parsed.entries };
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function saveInventoryFirstSeen(filePath: string, map: InventoryFirstSeenMap): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(tmp, `${JSON.stringify(map, null, 2)}\n`, "utf8");
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
