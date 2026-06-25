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
const { closeConversation, upsertConversationByLeadKey } = await import(
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
// And the write-time guard lives in closeConversation.
const store = fs.readFileSync("services/api/src/domain/conversationStore.ts", "utf8");
assert.match(store, /export function closeConversation[\s\S]*?if \(w && w\.status !== "paused"\) w\.status = "paused";/, "closeConversation pauses active watches");
n += 4;

console.log(`PASS closed-conversation watch-pause eval (${n} assertions)`);
