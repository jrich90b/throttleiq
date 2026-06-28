/**
 * Watch-fire miss detector (read-only).
 *
 * A customer set up an inventory watch ("let me know when a 2024 Street Glide comes in"), a matching
 * unit is CURRENTLY in stock, and we never notified them. That's a silent miss the rest of the
 * monitoring net didn't catch — Joe's #1 gap. This is a conservative, pure detector: it surfaces
 * CANDIDATES (the agent-watch loop verifies + decides), so it reuses the real model matcher
 * (modelMatches) and errs toward only the high-confidence "active watch, never notified, matching
 * unit available" case. False positives get triaged; the detector never mutates anything.
 */
import type { Conversation, InventoryWatch } from "./conversationStore.js";
import type { InventoryFeedItem } from "./inventoryFeed.js";
import { modelMatches } from "./inventoryFeed.js";

export type WatchFireMiss = {
  convId: string;
  leadKey: string;
  model: string;
  watchYear: string | null;
  matchedStockId: string | null;
  matchedModel: string | null;
  matchedYear: string | null;
  lastNotifiedAt: string | null;
  confidence: "high" | "medium";
  reason: string;
};

function yearOf(item: InventoryFeedItem): number | null {
  const n = Number(String(item.year ?? "").trim());
  return Number.isFinite(n) ? n : null;
}

/** Conservative: model must match; year/condition only constrain when the watch specifies them. */
export function inventoryItemMatchesWatch(item: InventoryFeedItem, watch: InventoryWatch): boolean {
  if (!watch?.model || !modelMatches(item.model, watch.model)) return false;
  const iy = yearOf(item);
  if (typeof watch.year === "number" && watch.year > 0) {
    if (iy !== watch.year) return false;
  } else {
    if (typeof watch.yearMin === "number" && iy != null && iy < watch.yearMin) return false;
    if (typeof watch.yearMax === "number" && iy != null && iy > watch.yearMax) return false;
  }
  if (watch.condition) {
    const want = String(watch.condition).toLowerCase();
    const have = String(item.condition ?? "").toLowerCase();
    // normalize used/pre-owned synonyms; only constrain when both sides are present
    const norm = (s: string) => (/\b(pre[- ]?owned|used|cpo|certified)\b/.test(s) ? "used" : /\bnew\b/.test(s) ? "new" : s);
    if (have && norm(have) !== norm(want)) return false;
  }
  return true;
}

// Same LOGICAL watch (model + year + condition), regardless of object identity — used to drop a stale
// singular `inventoryWatch` that mirrors an `inventoryWatches[]` entry.
function sameWatchIdentity(a: InventoryWatch, b: InventoryWatch): boolean {
  const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
  const cond = (c: unknown) => {
    const s = norm(c);
    return /\b(pre[- ]?owned|used|cpo|certified)\b/.test(s) ? "used" : /\bnew\b/.test(s) ? "new" : s;
  };
  return (
    norm(a.model) === norm(b.model) &&
    String(a.year ?? "") === String(b.year ?? "") &&
    cond(a.condition) === cond(b.condition)
  );
}

// The firing engine (notifyInventoryWatchersForAvailableItem) reads `inventoryWatches[]` when present
// and falls back to the singular `inventoryWatch` ONLY when the array is empty; it records
// lastNotifiedAt/lastNotifiedStockId on the ARRAY entry and never on the singular. So a conversation
// can carry the SAME watch twice — a current array entry (with the notification record) and a stale
// singular copy (without it). Naively unioning both double-counts the stale copy as a phantom "never
// notified" miss (5 of 11 live highs on 2026-06-28 were this). Mirror the engine: take the array as
// canonical and include the singular only when it is a genuinely DISTINCT watch, not a stale mirror.
function activeWatches(conv: any): InventoryWatch[] {
  const arr: InventoryWatch[] = Array.isArray(conv?.inventoryWatches) ? conv.inventoryWatches : [];
  const single: InventoryWatch | undefined = conv?.inventoryWatch ?? undefined;
  const merged: InventoryWatch[] = [...arr];
  if (single && !arr.some(w => w && sameWatchIdentity(w, single))) merged.push(single);
  return merged.filter(w => w && w.model && w.status !== "paused");
}

const isClosedOrSold = (conv: any): boolean =>
  conv?.status === "closed" || !!conv?.closedReason || !!conv?.sale?.soldAt || conv?.closedReason === "sold";

/**
 * Pure detector. For each open conversation's ACTIVE watch, flag it if a matching unit is in the
 * feed and we either never notified (high) or only notified a DIFFERENT stock id (medium).
 */
export function findWatchFireMisses(args: {
  conversations: Conversation[];
  feedItems: InventoryFeedItem[];
}): WatchFireMiss[] {
  const feed = args.feedItems ?? [];
  const misses: WatchFireMiss[] = [];
  for (const conv of args.conversations ?? []) {
    if (isClosedOrSold(conv)) continue;
    for (const watch of activeWatches(conv)) {
      const matches = feed.filter(item => inventoryItemMatchesWatch(item, watch));
      if (!matches.length) continue;
      const lastNotifiedAt = watch.lastNotifiedAt ? String(watch.lastNotifiedAt) : null;
      const notNotifiedMatch =
        matches.find(m => !watch.lastNotifiedStockId || String(m.stockId ?? "") !== String(watch.lastNotifiedStockId)) ??
        null;
      let confidence: "high" | "medium" | null = null;
      let chosen = notNotifiedMatch ?? matches[0];
      if (!lastNotifiedAt) {
        confidence = "high"; // watch set up, unit available, NEVER notified
      } else if (notNotifiedMatch) {
        confidence = "medium"; // a different matching unit arrived than the one we notified
        chosen = notNotifiedMatch;
      }
      if (!confidence) continue;
      misses.push({
        convId: String((conv as any).id ?? ""),
        leadKey: String((conv as any).leadKey ?? ""),
        model: String(watch.model),
        watchYear: watch.year ? String(watch.year) : watch.yearMin || watch.yearMax ? `${watch.yearMin ?? ""}-${watch.yearMax ?? ""}` : null,
        matchedStockId: chosen?.stockId ? String(chosen.stockId) : null,
        matchedModel: chosen?.model ? String(chosen.model) : null,
        matchedYear: chosen?.year ? String(chosen.year) : null,
        lastNotifiedAt,
        confidence,
        reason:
          confidence === "high"
            ? "active watch, matching unit in stock, never notified"
            : "active watch, a different matching unit in stock than the one notified"
      });
    }
  }
  // high-confidence first
  misses.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === "high" ? -1 : 1));
  return misses;
}
