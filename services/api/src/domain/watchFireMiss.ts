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
import { modelMatches, unitIsDistinctModelFromWatch, distinct883ModelConflict, distinctSportsterModelConflict } from "./inventoryFeed.js";
import { trikeClassConflict } from "./modelFamily.js";
import { inventorySnapshotKey } from "./inventoryWatchSnapshot.js";
import { unitArrivedAfter, type FirstSeenEntry } from "./inventoryFirstSeen.js";

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
  // Cross-FAMILY guard: a trike-class unit is never a match for a two-wheel watch (or vice
  // versa) — "Road Glide 3" is not a "Road Glide" — even when openToOtherTrims. Mirrors the
  // live engine's matcher (index.ts) so the detector never flags these as misses.
  if (trikeClassConflict(item.model, watch.model)) return false;
  // A specific 883 model watch ("Iron 883") is not matched by a different 883 model ("Sportster 883
  // Low") — mirrors the live engine's guard so the detector never flags the (correctly) un-fired
  // wrong-model unit as a miss.
  if (distinct883ModelConflict(item.model, watch.model)) return false;
  // Modern Sportster models (Sportster S / Nightster) — mirror the engine so the detector never flags
  // the correctly-un-fired 883 Low as a miss.
  if (distinctSportsterModelConflict(item.model, watch.model)) return false;
  // A distinct sibling model ("Road Glide Limited" for a "Road Glide" watch) is a
  // separate model, not a match — unless the watch is explicitly open to other trims.
  if (!watch.openToOtherTrims && unitIsDistinctModelFromWatch(item.model, watch.model)) return false;
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
  // Price-band gate — MIRRORS the live engine (index.ts notifyInventoryWatchers matcher, the
  // `if (hasMinPrice || hasMaxPrice)` block). A watch that captured a budget ("used Road Glide,
  // $14-16k") must not match a unit whose price is outside it (Robert Hofmeister $14-16k → new $30k
  // Road Glide). And when the watch is banded, a unit with NO valid price does NOT match: the engine
  // rejects an unpriced unit against a banded watch (it can't confirm the unit is in budget), so such
  // a unit is NOT a miss the engine would ever have fired on — flagging it just cries wolf
  // (+17162264009 7/11: a null-price 2011 Road Glide Custom against a used $14-16k Road Glide watch
  // was a false "high miss"). Engine PARITY is the correct bar for a miss detector; the earlier
  // "unknown price never rejects" fail-safe diverged from the engine and produced those false flags.
  const hasMinPrice = typeof watch.minPrice === "number" && watch.minPrice > 0;
  const hasMaxPrice = typeof watch.maxPrice === "number" && watch.maxPrice > 0;
  if (hasMinPrice || hasMaxPrice) {
    const price = typeof item.price === "number" && Number.isFinite(item.price) && item.price > 0 ? item.price : null;
    if (price == null) return false;
    if (hasMaxPrice && price > (watch.maxPrice as number)) return false;
    if (hasMinPrice && price < (watch.minPrice as number)) return false;
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
  // When provided, a matching unit is a miss candidate ONLY if it genuinely arrived AFTER the watch
  // was created (the cron would have fired). A unit already in stock at watch-creation (baseline) or
  // with no first-seen record is NOT a miss — the cron intentionally holds off (Joe's policy). Omit
  // for the legacy/self-test behavior (no arrival gate).
  firstSeen?: Record<string, FirstSeenEntry>;
}): WatchFireMiss[] {
  const feed = args.feedItems ?? [];
  const firstSeen = args.firstSeen;
  const misses: WatchFireMiss[] = [];
  for (const conv of args.conversations ?? []) {
    if (isClosedOrSold(conv)) continue;
    for (const watch of activeWatches(conv)) {
      const matches = feed.filter(item => {
        if (!inventoryItemMatchesWatch(item, watch)) return false;
        if (!firstSeen) return true; // legacy: no arrival gate
        const key = inventorySnapshotKey(item);
        return !!key && unitArrivedAfter(firstSeen[key], (watch as any).createdAt);
      });
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
        // The customer was already notified about this model. If the unit we notified them about is
        // STILL in stock, that notification still stands — the customer already knows the model is
        // available, so a DIFFERENT same-model unit arriving is not a fresh miss (notify-once by
        // design; +17163308822 & +17165104578 7/11: both notified units were still on the floor, so
        // the mediums were noise). Only surface a medium when the notified unit is GONE (sold/removed)
        // and a new matching one is available — the genuine "the bike we told them about sold, but
        // here's another" case.
        const notifiedStillInStock =
          !!watch.lastNotifiedStockId &&
          feed.some(m => String(m.stockId ?? "") === String(watch.lastNotifiedStockId));
        if (notifiedStillInStock) continue;
        confidence = "medium"; // notified unit gone; a different matching unit is available
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
