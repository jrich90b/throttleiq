// Durable inventory-watch opt-out.
//
// When a customer says "I'm all set, stop alerting me," the watch-opt-out path
// pauses the watch objects that exist at that moment. But pausing alone is NOT
// durable: any later path that creates a fresh `status: "active"` watch for the
// same lead (the held-unit follow-up guard, a re-engagement, an arrival
// re-match) sails right past the notify engines' paused-watch check, and the
// customer who asked us to stop gets pinged again (Mark Scoville, 2026-06-29:
// opted out 5/23, re-alerted 6/4 + 6/26).
//
// The fix is a durable per-conversation flag that the notify engines consult at
// the conversation level — independent of any individual watch's status — plus
// a held-guard early-return so we don't re-create the defeating watch. The flag
// is reversible: an explicit re-subscribe (the customer asking for alerts again,
// surfaced as the `inventory_watch_active` dialog transition) clears it. The ack
// already promises this: "If you want alerts again later, just tell me."
//
// Pure state helpers so the durability invariant is unit-testable
// (inventory_watch_opt_out_durable:eval) without importing the index.ts runtime.

export interface InventoryWatchOptOutState {
  at: string;
  reason: string;
}

export function isInventoryWatchOptedOut(conv: any): boolean {
  return !!conv?.inventoryWatchOptOut;
}

export function setInventoryWatchOptOut(conv: any, reason: string, at?: string): void {
  if (!conv || typeof conv !== "object") return;
  conv.inventoryWatchOptOut = {
    at: at ?? new Date().toISOString(),
    reason: String(reason || "watch_opt_out")
  } satisfies InventoryWatchOptOutState;
}

// Returns true if a flag was actually cleared (used to log re-opt-ins).
export function clearInventoryWatchOptOut(conv: any): boolean {
  if (conv && typeof conv === "object" && conv.inventoryWatchOptOut) {
    delete conv.inventoryWatchOptOut;
    return true;
  }
  return false;
}
