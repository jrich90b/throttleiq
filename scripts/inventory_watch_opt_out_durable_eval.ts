/**
 * Durable inventory-watch opt-out invariant.
 *
 * Pins the fix for the Mark Scoville miss (2026-06-29): a customer who opted out
 * of watch alerts ("I'm all set… I'll reach out when I'm looking again") kept
 * getting new-arrival alerts because opt-out only PAUSED the then-current watch
 * objects — a later auto-created active watch (held-unit guard) sailed past the
 * notify engines' per-watch paused check. The durable flag must:
 *   1. suppress BOTH notify engines at the conversation level, independent of
 *      any individual watch's status, and
 *   2. survive a later watch (re-)creation (the held-guard auto path), and
 *   3. block the held-guard from re-arming the watch, and
 *   4. reverse on an explicit re-subscribe (the inventory_watch_active dialog).
 *
 * The notify engines and the held-guard each consult isInventoryWatchOptedOut;
 * this models those guards against the pure helper so the invariant is pinned
 * without booting the index.ts runtime.
 */
import assert from "node:assert/strict";
import {
  isInventoryWatchOptedOut,
  setInventoryWatchOptOut,
  clearInventoryWatchOptOut
} from "../services/api/src/domain/inventoryWatchOptOut.ts";

// Mirror of the conversation-level guard both notify engines now apply
// (processInventoryWatchlist + notifyInventoryWatchersForAvailableItem): a conv
// is notifiable only if it has an active watch AND has not opted out.
function engineWouldNotify(conv: any): boolean {
  if (conv.status === "closed") return false;
  if (isInventoryWatchOptedOut(conv)) return false;
  const watches = Array.isArray(conv.inventoryWatches) ? conv.inventoryWatches : [];
  return watches.some((w: any) => w && w.status === "active");
}

// Mirror of ensureInventoryWatchForHeldCadence's early-return.
function heldGuardWouldCreate(conv: any): boolean {
  return !isInventoryWatchOptedOut(conv);
}

let failed = 0;
const check = (label: string, cond: boolean) => {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    failed++;
  }
};

// Baseline: active watch, not opted out → engine notifies.
const conv: any = {
  id: "+1",
  status: "open",
  inventoryWatches: [{ model: "Breakout", status: "active" }]
};
check("baseline active watch notifies", engineWouldNotify(conv) === true);
check("baseline held-guard may create", heldGuardWouldCreate(conv) === true);
check("baseline not opted out", isInventoryWatchOptedOut(conv) === false);

// Customer opts out → flag set, engine suppressed even with an active watch.
setInventoryWatchOptOut(conv, "watch_opt_out", "2026-06-29T00:00:00.000Z");
check("opt-out sets the durable flag", isInventoryWatchOptedOut(conv) === true);
check("opt-out records at + reason", conv.inventoryWatchOptOut.at === "2026-06-29T00:00:00.000Z");
check("opt-out reason persisted", conv.inventoryWatchOptOut.reason === "watch_opt_out");
check("opted-out conv is NOT notified", engineWouldNotify(conv) === false);
check("opted-out blocks held-guard creation", heldGuardWouldCreate(conv) === false);

// DURABILITY: a later auto-created ACTIVE watch (the held-guard path that
// re-armed Mark's alerts) must NOT defeat the opt-out.
conv.inventoryWatches.push({ model: "Breakout", status: "active", note: "Created from held-unit follow-up guard." });
check("re-created active watch still suppressed", engineWouldNotify(conv) === false);

// Explicit re-subscribe clears the flag (modeled as the inventory_watch_active
// dialog transition calling clearInventoryWatchOptOut).
const cleared = clearInventoryWatchOptOut(conv);
check("re-opt-in clears the flag", cleared === true);
check("re-opt-in returns not-opted-out", isInventoryWatchOptedOut(conv) === false);
check("re-opt-in restores notification", engineWouldNotify(conv) === true);
check("clear on a non-opted-out conv is a no-op", clearInventoryWatchOptOut(conv) === false);

// Default reason when none supplied.
const conv2: any = { id: "+2", status: "open", inventoryWatches: [] };
setInventoryWatchOptOut(conv2, "");
check("default reason falls back to watch_opt_out", conv2.inventoryWatchOptOut.reason === "watch_opt_out");

// Closed conv is already excluded regardless of opt-out (engine ordering).
const conv3: any = { id: "+3", status: "closed", inventoryWatches: [{ model: "X", status: "active" }] };
check("closed conv not notified", engineWouldNotify(conv3) === false);

if (failed > 0) {
  console.error(`SELF-TEST FAIL: ${failed} inventory-watch durable opt-out check(s) failed`);
  process.exit(1);
}
console.log("PASS inventory-watch durable opt-out eval (suppress-both-engines + durability + held-guard block + re-opt-in)");
