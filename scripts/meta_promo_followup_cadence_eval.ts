/**
 * Meta-promo initial-ADF follow-up cadence + owner-task guard.
 *
 * History: H-D Meta Promo Offer ADF leads (Jason +17162801172 Ref 11453,
 * +17163614796) got the opener and then nothing. The live intake fix shaped a
 * timeframe cadence — but the REGEN path still called stopFollowUpCadence +
 * paused_indefinite, silently KILLING the cadence whenever a draft was
 * regenerated (Chad Mayer Ref 11464, 0-3mo buyer, 2026-06-15). Both paths now
 * share applyMetaPromoInitialCadence (route parity), which NEVER stops an active
 * cadence, and a hot 0-3-month Meta lead gets an owner CALL task.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  isNearTermMetaTimeframe,
  applyMetaPromoInitialCadence
} from "../services/api/src/domain/conversationStore.ts";

// ── 1) Near-term (0-3mo) predicate — distinct from "standard" (which is 4-6mo/unsure too)
assert.equal(isNearTermMetaTimeframe({ purchaseTimeframe: "0-3 Months", purchaseTimeframeMonthsStart: 0 }), true);
assert.equal(isNearTermMetaTimeframe({ purchaseTimeframe: "4-6 Months", purchaseTimeframeMonthsStart: 4 }), false);
assert.equal(isNearTermMetaTimeframe({ purchaseTimeframe: "7-12 Months", purchaseTimeframeMonthsStart: 7 }), false);
assert.equal(isNearTermMetaTimeframe({ purchaseTimeframe: "Unsure", purchaseTimeframeMonthsStart: null }), false);
assert.equal(isNearTermMetaTimeframe({ purchaseTimeframe: "I am not interested in purchasing at this time" }), false);
assert.equal(isNearTermMetaTimeframe({ purchaseTimeframe: null, purchaseTimeframeMonthsStart: 2 }), true);

// ── 2) applyMetaPromoInitialCadence — the route-parity behavior
// (a) THE BUG FIX: never stops an already-active cadence (this is what regen did).
{
  const conv: any = {
    lead: { purchaseTimeframe: "0-3 Months", purchaseTimeframeMonthsStart: 0 },
    followUpCadence: { status: "active", kind: "standard", nextDueAt: "2026-06-20T12:00:00.000Z", stepIndex: 1 },
    messages: []
  };
  applyMetaPromoInitialCadence(conv, "America/New_York");
  assert.equal(conv.followUpCadence.status, "active", "must NOT stop an active cadence (regen parity bug)");
  assert.equal(conv.followUpCadence.nextDueAt, "2026-06-20T12:00:00.000Z", "active cadence left untouched");
}
// (b) Jason regression: a fresh near-term lead gets a standard cadence (not silence).
{
  const conv: any = { lead: { purchaseTimeframe: "0-3 Months", purchaseTimeframeMonthsStart: 0 }, messages: [] };
  applyMetaPromoInitialCadence(conv, "America/New_York");
  assert.ok(conv.followUpCadence && conv.followUpCadence.status === "active", "starts a cadence for a near-term Meta lead");
  assert.equal(conv.followUpCadence.kind, "standard", "near-term => standard cadence");
}
// (c) Explicit "not interested" => opener only (paused), no active cadence.
{
  const conv: any = { lead: { purchaseTimeframe: "I am not interested in purchasing at this time" }, messages: [] };
  applyMetaPromoInitialCadence(conv, "America/New_York");
  assert.equal(conv.followUp?.mode, "paused_indefinite", "not-interested => paused_indefinite");
  assert.ok(!conv.followUpCadence || conv.followUpCadence.status !== "active", "no active cadence when not interested");
}
// (d) Booked / manual-handoff leads are left alone.
{
  const conv: any = { lead: { purchaseTimeframe: "0-3 Months", purchaseTimeframeMonthsStart: 0 }, appointment: { bookedEventId: "evt_1" }, messages: [] };
  applyMetaPromoInitialCadence(conv, "America/New_York");
  assert.ok(!conv.followUpCadence || conv.followUpCadence.status !== "active", "booked lead: no cadence override");
}

// ── 3) Both paths wired through the shared helper + owner call task (source guards)
const live = fs.readFileSync(path.resolve("services/api/src/routes/sendgridInbound.ts"), "utf8");
const idx = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");

// LIVE ADF intake: the Meta generic-offer branch applies the centralized cadence + call task.
const liveBranch = live.slice(
  live.indexOf("if (isMetaPromoOffer && isGenericMetaOfferModel(metaOfferRawModel)) {"),
  live.indexOf("if (isMetaPromoOffer && isGenericMetaOfferModel(metaOfferRawModel)) {") + 3000
);
assert.ok(liveBranch.length > 100, "live Meta branch must exist");
assert.match(liveBranch, /applyMetaPromoInitialCadence\(/, "live branch must apply the centralized cadence");
assert.match(liveBranch, /isNearTermMetaTimeframe\(/, "live branch must gate the near-term call task");
assert.match(liveBranch, /addCallTodoIfMissing\(/, "live branch must create the owner call task");

// REGEN: the Meta generic-model branch must NO LONGER stop the cadence, and must apply
// the same helper + call task (route parity).
const regenStart = idx.indexOf('ruleName: "meta_promo_generic_model"');
const regenBranch = idx.slice(regenStart, regenStart + 1200);
assert.ok(regenStart >= 0, "regen Meta branch must exist");
assert.doesNotMatch(
  regenBranch,
  /stopFollowUpCadence\(conv, "meta_promo_generic_model_regen"\)/,
  "regen must NOT stop the follow-up cadence for a generic-model Meta lead (the bug)"
);
assert.match(regenBranch, /applyMetaPromoInitialCadence\(/, "regen must apply the centralized cadence (parity)");
assert.match(regenBranch, /isNearTermMetaTimeframe\(/, "regen must gate the near-term call task");
assert.match(regenBranch, /addCallTodoIfMissing\(/, "regen must create the owner call task (parity)");

console.log("PASS meta promo follow-up cadence + call-task eval");
