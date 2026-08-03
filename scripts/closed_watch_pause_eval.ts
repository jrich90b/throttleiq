/**
 * Closed-conversation inventory-watch pause eval (2026-06-25).
 *
 * A closed/sold conversation must not keep an ACTIVE inventory watch — a reopen could refire
 * "it's available again!" to a customer who already closed/bought (the outcome auditor found 15 live
 * on 6/25). Fix = a write-time guard in `closeConversation` (pause active watches) + a reconcile-tick
 * catch-all for close paths that don't route through it (e.g. applyOutcomeSold) + the backlog.
 *
 * Pins: closeConversation pauses single + array watches, leaves already-paused alone, and the reconcile
 * heal is wired (source guard). Reversible — watches are paused, never deleted.
 *
 * Run: npx tsx scripts/closed_watch_pause_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH || path.join(os.tmpdir(), `closed-watch-eval-${Date.now()}.json`);
const { closeConversation, applyLeadCloseout, upsertConversationByLeadKey } = await import(
  "../services/api/src/domain/conversationStore.ts"
);

let n = 0;
const ok = (c: boolean, m: string) => { assert.equal(c, true, m); n++; };

// --- closeConversation pauses an active single watch. ---
const c1: any = upsertConversationByLeadKey("+15559000001", "suggest");
c1.inventoryWatch = { status: "active", model: "Road Glide" };
closeConversation(c1, "not_interested");
ok(c1.inventoryWatch.status === "paused", "single active watch is paused on close");
ok(c1.status === "closed", "conversation is closed");

// --- closeConversation pauses every active watch in the array form. ---
const c2: any = upsertConversationByLeadKey("+15559000002", "suggest");
c2.inventoryWatches = [{ status: "active", model: "A" }, { status: "paused", model: "B" }, { status: "active", model: "C" }];
closeConversation(c2, "sold");
ok(c2.inventoryWatches.every((w: any) => w.status === "paused"), "all watches paused on close (array form)");

// --- the bug the outcome auditor found: an ACTIVE single watch alongside a PRESENT (paused) array.
//     "array-if-present-else-single" ignored the single; collectInventoryWatches unions both. ---
const cBoth: any = upsertConversationByLeadKey("+15559000005", "suggest");
cBoth.inventoryWatch = { status: "active", model: "Pan America" }; // legacy single, still active
cBoth.inventoryWatches = [{ status: "paused", model: "old" }]; // array present + paused
closeConversation(cBoth, "opt_out");
ok(cBoth.inventoryWatch.status === "paused", "active SINGLE watch is paused even when a (paused) array is present");

// --- a conv with no watch closes fine (no throw). ---
const c3: any = upsertConversationByLeadKey("+15559000003", "suggest");
closeConversation(c3, "wrong_number");
ok(c3.status === "closed", "close with no watch is a no-op for watches");

// --- the cadence is still stopped (existing behavior preserved). ---
const c4: any = upsertConversationByLeadKey("+15559000004", "suggest");
c4.followUpCadence = { status: "active", kind: "standard", stepIndex: 0, nextDueAt: "2026-07-01T00:00:00Z" };
c4.inventoryWatch = { status: "active", model: "X" };
closeConversation(c4, "archived");
ok(c4.followUpCadence.status === "stopped", "cadence still stopped on close");
ok(c4.inventoryWatch.status === "paused", "and the watch is paused");

// --- Source guard: the reconcile tick heals closed/sold convs with an active watch (catch-all). ---
const api = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(api, /if \(!closed \|\| !hasActiveInventoryWatch\(conv\)\) continue;/, "reconcile gates on closed + active watch");
assert.match(api, /pauseInventoryWatches\(conv\)/, "reconcile pauses the watches");
assert.match(api, /closed_watch_paused/, "route outcome recorded");
const store = fs.readFileSync("services/api/src/domain/conversationStore.ts", "utf8");
// Union both watch fields (the single + the array) — one source of truth so the heal/close/detector agree.
assert.match(store, /export function collectInventoryWatches/, "collectInventoryWatches unions single + array");
n += 4;

// --- the write-time guard, asserted BEHAVIOURALLY ------------------------------------------------
// It now lives in `applyLeadCloseout` (the lead-closeout referee's applier) and `closeConversation`
// asks it. Two source-text pins used to assert it by matching closeConversation's BODY; both broke
// the moment the loop was extracted, even though behavior was provably unchanged (decision
// equivalence IDENTICAL). A pin on where code SITS cannot tell a regression from a refactor — so
// these are behaviour checks now. Same guard, one that survives the next extraction.
const cRef: any = upsertConversationByLeadKey("+15559000006", "suggest");
cRef.inventoryWatch = { status: "active", model: "Sportster S" }; // legacy single
cRef.inventoryWatches = [{ status: "active", model: "Nightster" }, { status: "paused", model: "Iron" }];
applyLeadCloseout(cRef, { nowIso: new Date().toISOString(), lane: "generic_close", reason: "opt_out" });
ok(cRef.inventoryWatch.status === "paused", "the applier pauses the legacy SINGLE watch");
ok(
  cRef.inventoryWatches.every((w: any) => w.status === "paused"),
  "...and every watch in the array — i.e. it enumerates via collectInventoryWatches, not one field"
);
ok(cRef.status === "closed", "and the applier is what stamps the thread closed");

console.log(`PASS closed-conversation watch-pause eval (${n} assertions)`);
