/**
 * test_ride_stock_check_first:eval — a test-ride ADF for a bike we DON'T have must lead with the honest
 * unavailability + a watch offer, NEVER offer/confirm a time (Joe ruling, 2026-07-27).
 *
 * Real miss (Shamsher, +ADF web lead 7/27): "Test ride request for Sportster S, preferred 5:00 pm" →
 * draft "I have Monday, July 27 at 5:00 pm noted. I'll confirm availability and get that lined up. I'm
 * not seeing a 2021 Sportster S in stock..." — offered a TIME first on a bike not in stock, then walked
 * it back. The correct behavior already exists (evaluateTestRideInventoryGate + buildBlockedTestRideInventoryDraft,
 * used by the live orchestrator scheduling path) — this pins that the ADF first-touch/regen path in
 * index.ts routes through the SAME gate instead of the time-first buildTestRidePreferredDateReply.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import { buildBlockedTestRideInventoryDraft } from "../services/api/src/domain/orchestrator.ts";
import { checkMessage } from "./voice_charter_audit.ts";

// ── Behavioral: the blocked draft for a not-in-stock bike leads with unavailability + offers the watch,
//    and NEVER confirms a time.
const draft = buildBlockedTestRideInventoryDraft({
  canOfferTestRide: false,
  reason: "not_in_stock",
  bikeLabel: "2021 Sportster S",
  availableCount: 0,
  inventoryBrowseUrl: "https://example.com/inventory",
  alternateBikeLabel: null,
  alternateInventoryUrl: null
} as any);

assert.ok(/not seeing .*2021 Sportster S .*in stock/i.test(draft), "the draft LEADS with the honest 'not in stock' for the requested bike");
assert.ok(/don['’]?t want to book you on a bike we don['’]?t have/i.test(draft), "the draft explains we won't book a test ride on a bike we don't have");
// Offers the watch as the follow-up (Joe: yes to auto-offer; the watch is the follow-up).
assert.ok(/keep an eye out and text you the moment/i.test(draft) && /want me to/i.test(draft), "the draft OFFERS to watch (text when one lands) as the follow-up");
// NEVER offers/confirms a specific time or claims a booking.
assert.ok(!/\bat \d{1,2}(:\d{2})?\s*(am|pm)\b/i.test(draft), "the blocked draft names NO appointment time");
assert.ok(!/lined up|noted\b|get that lined up|see you (then|at)/i.test(draft), "the blocked draft does NOT confirm/note a time or a booking");
// On-voice (texting-a-friend, no banned phrasing).
const charter = checkMessage(draft, { firstOutbound: true, smsLike: true, staffHasSent: false });
assert.equal(charter.length, 0, `blocked test-ride draft passes the voice charter (${charter.map(v => v.check).join("; ")})`);

// The on-hold variant leads with the hold, still no time.
const holdDraft = buildBlockedTestRideInventoryDraft({
  canOfferTestRide: false, reason: "on_hold", bikeLabel: "2024 Street Glide", availableCount: 0,
  inventoryBrowseUrl: "https://example.com/inventory", alternateBikeLabel: null, alternateInventoryUrl: null
} as any);
assert.ok(/on hold/i.test(holdDraft) && !/\bat \d{1,2}(:\d{2})?\s*(am|pm)\b/i.test(holdDraft), "on-hold draft leads with the hold, names no time");

// ── WIRING (source-grep): the sendgrid_adf ADF first-touch/regen path evaluates the gate and uses the
//    blocked draft when the bike is unavailable — BEFORE the time-first buildTestRidePreferredDateReply.
const indexSrc = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
assert.ok(
  /evaluateTestRideInventoryGate\(\{ lead: conv\.lead, dealerProfile \}\)/.test(indexSrc),
  "the ADF test-ride path evaluates the shared inventory gate"
);
assert.ok(
  /if \(testRideInventoryGate && !testRideInventoryGate\.canOfferTestRide\) \{[\s\S]{0,500}buildBlockedTestRideInventoryDraft\(testRideInventoryGate\)/.test(indexSrc),
  "an unavailable test-ride bike uses buildBlockedTestRideInventoryDraft (not the time-first reply)"
);
// The gate is checked BEFORE buildTestRidePreferredDateReply in the same block (order = stock-check-first).
const gateIdx = indexSrc.indexOf("evaluateTestRideInventoryGate({ lead: conv.lead, dealerProfile })");
const timeReplyIdx = indexSrc.indexOf("buildTestRidePreferredDateReply(conv)");
assert.ok(gateIdx > 0 && timeReplyIdx > gateIdx, "the inventory gate is evaluated BEFORE the time-first test-ride reply (stock-check-first)");

// ── WIRING (source-grep): the PRIMARY generation path is routes/sendgridInbound.ts (the live ADF
//    first-touch + regenerate both flow through it). The out-of-stock reply+watch builder must fire for
//    TEST-RIDE buckets too (was inventory_interest-only → the reported miss), and the time-first reply
//    must be gated on availability (no time on an on-hold bike).
const sgSrc = await fs.readFile(path.resolve("services/api/src/routes/sendgridInbound.ts"), "utf8");
// The unavailable-inventory watch (reply leads with "not in stock" + offers the watch AND sets it) now
// also covers test-ride leads.
assert.ok(
  /inferredBucket === "inventory_interest" \|\|\s*inferredBucket === "test_ride" \|\|\s*inferredCta === "schedule_test_ride"/.test(sgSrc),
  "the unavailable-inventory watch fires for test-ride buckets (not just inventory_interest)"
);
// It's fed by the fail-safe builder (returns null unless genuinely not_found/sold) and, when it fires,
// sets a real watch on the conversation (the follow-up).
assert.ok(/buildInitialAdfUnavailableInventoryWatch\(\{/.test(sgSrc), "the watch builder is invoked");
// WIRING + BEHAVIOUR, not a body pin. The three watch fields used to be written inline right here
// and this line pinned that literal text; the 2026-08-04 arm un-stacking moved them behind
// applyInventoryWatchArm and the pin went red on a refactor that changed nothing. A pin on where
// code SITS cannot tell a regression from a refactor — so: grep that the lane is still wired to the
// arm path, then prove the arm path actually arms.
assert.ok(
  /applyInventoryWatchArm\(conv, \{[\s\S]{0,200}initialAdfUnavailableInventoryWatch\.watch/.test(sgSrc),
  "a firing out-of-stock ADF still routes its watch through the arm referee (the follow-up)"
);
{
  const { applyInventoryWatchArm } = await import("../services/api/src/domain/conversationStore.ts");
  const conv: any = { id: "adf-watch-probe", messages: [], inventoryWatchPending: { year: 2021, askedAt: "x" } };
  const watch = { model: "Street Glide", status: "active", createdAt: "2026-01-01T00:00:00.000Z" };
  applyInventoryWatchArm(conv, { lane: "email_adf_unavailable", watches: [watch as any], nowIso: "2026-01-01T00:00:00.000Z" });
  assert.equal(conv.inventoryWatch?.model, "Street Glide", "the arm path sets the singular watch");
  assert.equal(conv.inventoryWatches?.length, 1, "the arm path sets the watch list");
  assert.equal(conv.inventoryWatchPending, undefined, "the arm path clears the pending which-model ask");
  assert.equal(conv.dialogState?.name, "inventory_watch_active", "the ADF email lane still enters the active-watch dialog state");
}
// The time-first test-ride reply is produced ONLY when the bike is CONFIRMED in stock — never on
// not_found / sold / on_hold / unknown (fail-safe: never promise a ride on a bike we can't confirm).
assert.ok(
  /initialAvailability === "in_stock"[\s\S]{0,120}buildInitialTestRidePreferredDateReply\(conv\)/.test(sgSrc),
  "the time-first test-ride reply fires ONLY when initialAvailability === 'in_stock'"
);
assert.ok(
  !/initialAvailability !== "on_hold"[\s\S]{0,120}buildInitialTestRidePreferredDateReply\(conv\)/.test(sgSrc),
  "the weaker on_hold-only gate is gone (replaced by in-stock-only)"
);

console.log("PASS test_ride_stock_check_first — out-of-stock test-ride ADF leads with unavailability + watch (+ sets it), never a time (both paths)");
