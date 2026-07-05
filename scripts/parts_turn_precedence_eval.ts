/**
 * Parts-turn precedence eval (pure, no LLM).
 *
 * Pins the fix for mid-thread parts inquiries getting answered with the incoming-inventory recital
 * ("I'll keep this tied to the {model} trade and let you know when it's here") instead of a parts
 * handoff — Nicholas Braun sent 5 part numbers and got the recital. The fix (dark behind
 * PARTS_TURN_PRECEDENCE_ENABLED): a SPECIFIC parts signal defers the pending-incoming handler so the
 * accessory decision owns the turn, in BOTH paths.
 *
 * HARD CONSTRAINT (Joe): creating a parts task must NOT change conv.leadOwner.
 *
 * Layers:
 *   1. hasPartsInquirySignal — part-# OR (accessory noun + intent verb); a bare incoming-ack never matches.
 *   2. shouldHandlePendingIncomingInventoryTurn defers when partsInquiry=true.
 *   3. addTodo (the parts-task primitive) never mutates conv.leadOwner.
 *   4. dark by default + both-path source guard.
 *
 * Run: npx tsx scripts/parts_turn_precedence_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  hasPartsInquirySignal,
  shouldHandlePendingIncomingInventoryTurn,
  partsTurnPrecedenceEnabled
} from "../services/api/src/domain/pendingIncomingInventory.ts";
import { addTodo } from "../services/api/src/domain/conversationStore.ts";

// --- 1) hasPartsInquirySignal: Nicholas-class parts turns true; incoming-acks false ---
const PARTS_TRUE = [
  "Looking for the mustache engine guard #49000140, or the normal guard #49000148 in chrome",
  "Swing arm saddle bag part # 90201568 in the authentic brown",
  "Rack - #50300124 Sissy Bar - #52300018",
  "Looking for the quarter fairing kit that's the same color it's saying part # 57001615EYO online",
  "How much to add a chrome sissy bar?",
  "Do you have a windshield in stock for it?"
];
const PARTS_FALSE = [
  "Ok great!",
  "sounds good, let me know when it's here",
  "yes please text me when the bike arrives",
  "Tuesday around 11am works",
  "any word on delivery of the super glide?",
  "Perfect thank you man"
];
for (const t of PARTS_TRUE) assert.equal(hasPartsInquirySignal(t), true, `should be a parts signal: ${t}`);
for (const t of PARTS_FALSE) assert.equal(hasPartsInquirySignal(t), false, `should NOT be a parts signal: ${t}`);

// --- 2) shouldHandlePendingIncomingInventoryTurn defers on a parts inquiry ---
const pendingConv = { pendingIncomingInventory: { status: "pending" } } as any;
assert.equal(
  shouldHandlePendingIncomingInventoryTurn({ conv: pendingConv, inboundText: "Yes, please text me when it arrives", lastOutboundText: "" }),
  true,
  "a genuine incoming-ack is still handled"
);
assert.equal(
  shouldHandlePendingIncomingInventoryTurn({ conv: pendingConv, inboundText: "engine guard #49000140 in chrome", lastOutboundText: "", partsInquiry: true }),
  false,
  "a parts inquiry defers the incoming-inventory handler"
);
assert.equal(
  shouldHandlePendingIncomingInventoryTurn({ conv: { pendingIncomingInventory: null } as any, inboundText: "let me know when it's here" }),
  false,
  "no pending context → not handled"
);

// --- 3) HARD CONSTRAINT: making a parts task does NOT change conv.leadOwner ---
const conv: any = { id: "c1", leadKey: "+15555550000", leadOwner: { id: "u-stone", name: "Stone Giuga" }, messages: [], todos: [] };
const ownerBefore = JSON.stringify(conv.leadOwner);
addTodo(conv, "parts", "Parts: check stock/pricing on engine guard #49000140", "msg1");
addTodo(conv, "other", "Accessory pricing request (saddlebag): part # 90201568", "msg2");
assert.equal(JSON.stringify(conv.leadOwner), ownerBefore, "creating a parts/accessory task must NOT change conv.leadOwner");

// --- 4) dark by default + both-path source guard ---
delete process.env.PARTS_TURN_PRECEDENCE_ENABLED;
assert.equal(partsTurnPrecedenceEnabled(), false, "ships DARK — flag off by default");
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.ok(/hasPartsInquirySignal\(/.test(index), "index.ts uses hasPartsInquirySignal");
assert.ok(/partsTurnPrecedenceEnabled\(/.test(index), "index.ts gates on the dark flag");
assert.ok(/partsTurnDefer/.test(index) && /regenPartsTurnDefer/.test(index), "both live + regen paths compute the parts defer (route-parity)");
assert.ok(/partsInquiry:\s*(parts|regenParts)TurnDefer/.test(index), "the defer is passed into shouldHandlePendingIncomingInventoryTurn");

console.log("PASS parts-turn precedence — parts signal (Nicholas class) defers the incoming-inventory recital, incoming-acks unaffected, leadOwner preserved on parts-task creation, dark + both paths.");
