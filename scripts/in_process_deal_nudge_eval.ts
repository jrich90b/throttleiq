/**
 * In-process deal nudge. Merton Kreps (+17165503586, HDFS prequalify, finance
 * deal in process): a deal actively worked by a human should stay silent — the
 * AI cadence must not auto-message — and once it's gone quiet the OWNER (not the
 * customer) gets ONE "nudge?" task to approve. Joe, 2026-06-13.
 */
import assert from "node:assert/strict";
import {
  isInProcessDealLead,
  shouldNudgeInProcessDeal
} from "../services/api/src/domain/conversationStore.ts";

// Wednesday — 3 business days back lands on the prior Friday (skipping the weekend).
const NOW = new Date("2026-06-17T20:00:00Z");
const at = (iso: string) => iso;

// --- isInProcessDealLead: conservative definition ---
const inProc = (reason?: string, mode?: string, kind?: string): any => ({
  followUp: { mode: mode ?? "active", reason },
  followUpCadence: kind ? { kind } : undefined
});
assert.equal(isInProcessDealLead(inProc("finance_no_contact")), true, "finance_no_contact (Merton) is in-process");
assert.equal(isInProcessDealLead(inProc("credit_app")), true, "credit_app is in-process");
assert.equal(isInProcessDealLead(inProc("unit_hold")), true, "a unit held for the buyer is in-process");
assert.equal(isInProcessDealLead(inProc("order_hold")), true, "an on-order hold is in-process");
assert.equal(
  isInProcessDealLead(inProc("inventory_watch", "holding_inventory")),
  false,
  "an inventory WATCH (waiting for stock) is NOT a deal in process — keep its follow-up"
);
assert.equal(isInProcessDealLead(inProc("price_confirm")), false, "price negotiation is NOT silenced");
assert.equal(isInProcessDealLead(inProc("dealer_ride_no_purchase")), false, "test-ride outcome is NOT silenced");
assert.equal(isInProcessDealLead(inProc("finance_no_contact", "active", "post_sale")), false, "post-sale is excluded");

// --- shouldNudgeInProcessDeal ---
function merton(overrides: any = {}): any {
  return {
    followUp: { mode: "active", reason: "finance_no_contact" },
    closedAt: undefined,
    inProcessNudgedAt: undefined,
    messages: [
      { direction: "in", body: "I'm prequalified, working on the deal", at: at("2026-06-12T15:00:00Z") },
      { direction: "out", body: "Great — we'll get it finalized", at: at("2026-06-12T15:05:00Z") }
    ],
    ...overrides
  };
}

assert.equal(shouldNudgeInProcessDeal(merton(), false, NOW), true, "quiet 3 business days -> owner nudge");
assert.equal(shouldNudgeInProcessDeal(merton(), true, NOW), false, "has an open todo already");
assert.equal(
  shouldNudgeInProcessDeal(merton({ inProcessNudgedAt: "2026-06-15T00:00:00Z" }), false, NOW),
  false,
  "already nudged once — never re-nudge"
);
assert.equal(
  shouldNudgeInProcessDeal(merton({ followUp: { mode: "active", reason: "price_confirm" } }), false, NOW),
  false,
  "not an in-process state"
);
assert.equal(
  shouldNudgeInProcessDeal(merton({ closedAt: "2026-06-16T00:00:00Z" }), false, NOW),
  false,
  "closed deal"
);
// Quiet only 1 business day (last activity Tuesday) -> too soon.
assert.equal(
  shouldNudgeInProcessDeal(
    merton({ messages: [{ direction: "in", body: "hi", at: at("2026-06-16T15:00:00Z") }] }),
    false,
    NOW
  ),
  false,
  "only 1 business day quiet -> give staff time"
);
// No customer inbound -> not a real engaged lead.
assert.equal(
  shouldNudgeInProcessDeal(
    merton({ messages: [{ direction: "out", body: "promo", at: at("2026-06-12T15:00:00Z") }] }),
    false,
    NOW
  ),
  false,
  "no customer inbound"
);

// The maintenance pass + route outcome are wired (no auto-send).
import fs from "node:fs";
import path from "node:path";
const indexSrc = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
assert.match(indexSrc, /in_process_silent/, "in-process cadence must be paused (silent)");
assert.match(indexSrc, /in_process_deal_nudge_todo/, "owner nudge todo route outcome must be recorded");

console.log("PASS in process deal nudge eval");
