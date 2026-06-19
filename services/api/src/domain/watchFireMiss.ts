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

function activeWatches(conv: any): InventoryWatch[] {
  const out: InventoryWatch[] = [];
  const push = (w: InventoryWatch | undefined | null) => {
    if (w && w.model && w.status !== "paused") out.push(w);
  };
  push(conv?.inventoryWatch);
  for (const w of conv?.inventoryWatches ?? []) push(w);
  return out;
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
