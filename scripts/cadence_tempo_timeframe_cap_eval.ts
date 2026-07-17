/**
 * Cadence tempo timeframe-cap eval (2026-07-16, Joe ruling — anomaly-review #2).
 *
 * A lead whose STRUCTURED purchase timeframe is 4+ months (or years) out should keep the gentle
 * long_term tempo ([30,90,180]) even once they ENGAGE (test ride / visit / reply) — the generic
 * engagement bump in the cadence tick was upgrading kind -> "engaged" (the aggressive 13-step ramp)
 * on any inbound / agent context, ignoring the customer's own stated timeline. Zachary (+17169013675)
 * said "4-6 Months", test-rode a Low Rider S, then got the full engaged-buyer press + promo + event
 * blast. Two layers, both fail-direction SAFE (only ever REDUCE / defer proactive touches):
 *  (1) prevent-upgrade — the tick + regen `engagedKind` skip the engaged bump when the timeframe caps,
 *  (2) reconcile heal — `realignOverEagerEngagedCadence` downshifts an already-upgraded engaged cadence
 *      to a fresh long_term nurture (RE-ANCHOR to stepIndex 0, not a raw kind swap, because ENGAGED
 *      walks 13 offsets and LONG_TERM only 3).
 * The timeframe->tempo boundary has ONE source of truth: `cadenceTempoCappedToLongTerm` reuses
 * `resolveInitialAdfCadencePlan`'s long_term branch.
 *
 * Run: npx tsx scripts/cadence_tempo_timeframe_cap_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH || path.join(os.tmpdir(), `tempo-cap-eval-${Date.now()}.json`);
const { cadenceTempoCappedToLongTerm, realignOverEagerEngagedCadence, upsertConversationByLeadKey } =
  await import("../services/api/src/domain/conversationStore.ts");

const TZ = "America/New_York";
const NOW = new Date("2026-07-16T15:00:00.000Z");
let n = 0;

// --- 1) Pure predicate: which timeframes cap the tempo to long_term. ---
assert.equal(cadenceTempoCappedToLongTerm({ purchaseTimeframe: "4-6 Months", purchaseTimeframeMonthsStart: 4 }), true, "4-6mo caps");
assert.equal(cadenceTempoCappedToLongTerm({ purchaseTimeframe: "7-12 Months", purchaseTimeframeMonthsStart: 7 }), true, "7-12mo caps");
assert.equal(cadenceTempoCappedToLongTerm({ purchaseTimeframe: "1-3 Years" }), true, "multi-year caps");
assert.equal(cadenceTempoCappedToLongTerm({ purchaseTimeframe: "0-3 Months", purchaseTimeframeMonthsStart: 0 }), false, "0-3mo does NOT cap (hot buyer)");
assert.equal(cadenceTempoCappedToLongTerm({ purchaseTimeframe: null, purchaseTimeframeMonthsStart: null }), false, "unknown timeframe does NOT cap");
assert.equal(cadenceTempoCappedToLongTerm({ purchaseTimeframe: "Not interested at this time" }), false, "not-interested resolves to suppress, not a tempo cap");
assert.equal(cadenceTempoCappedToLongTerm(null), false, "null lead => not capped");
n += 7;

// A 4+ month lead already bumped to the engaged tempo — the Zachary case.
const mk = (key: string, over: any = {}) => {
  const c: any = upsertConversationByLeadKey(key, "suggest");
  c.lead = { purchaseTimeframe: "4-6 Months", purchaseTimeframeMonthsStart: 4, ...(over.lead ?? {}) };
  c.followUpCadence = {
    status: "active",
    kind: "engaged",
    anchorAt: "2026-07-10T10:30:00.000Z",
    nextDueAt: "2026-07-17T13:00:00.000Z",
    stepIndex: 5,
    contextTag: "test_ride",
    ...(over.followUpCadence ?? {})
  };
  c.messages = over.messages ?? [{ direction: "in", provider: "twilio", body: "took the test ride", at: "2026-07-10T23:13:00.000Z" }];
  Object.assign(c, over.conv ?? {});
  return c;
};

// --- 2) POSITIVE: the Zachary case downshifts to a fresh long_term nurture. ---
const zachary = mk("+15550000001");
assert.equal(realignOverEagerEngagedCadence(zachary, TZ, NOW), true, "4-6mo engaged lead => capped to long_term");
assert.equal(zachary.followUpCadence.kind, "long_term", "kind flipped to long_term");
assert.equal(zachary.followUpCadence.stepIndex, 0, "RE-ANCHORED from the top (no 13->3 offset overflow)");
// LONG_TERM_DAY_OFFSETS[0] === 30 — the next touch is a month out, not days.
assert.ok(Date.parse(zachary.followUpCadence.nextDueAt) > Date.parse("2026-08-10T00:00:00Z"), "next touch is ~30 days out, gentler");
n += 4;

// --- 3) NEGATIVES: never downshift a genuine near-term or otherwise-held lead. ---
assert.equal(
  realignOverEagerEngagedCadence(mk("+15550000002", { lead: { purchaseTimeframe: "0-3 Months", purchaseTimeframeMonthsStart: 0 } }), TZ, NOW),
  false,
  "a near-term (0-3mo) engaged buyer stays engaged"
);
assert.equal(
  realignOverEagerEngagedCadence(mk("+15550000003", { lead: { purchaseTimeframe: null, purchaseTimeframeMonthsStart: null } }), TZ, NOW),
  false,
  "unknown timeframe stays engaged (no cap)"
);
assert.equal(
  realignOverEagerEngagedCadence(mk("+15550000004", { followUpCadence: { kind: "standard" } }), TZ, NOW),
  false,
  "a standard cadence is out of scope (only engaged bumps)"
);
assert.equal(
  realignOverEagerEngagedCadence(mk("+15550000005", { followUpCadence: { kind: "long_term" } }), TZ, NOW),
  false,
  "an already-long_term cadence is left alone"
);
assert.equal(
  realignOverEagerEngagedCadence(mk("+15550000006", { conv: { closedReason: "sold" } }), TZ, NOW),
  false,
  "closed/sold => left alone"
);
assert.equal(
  realignOverEagerEngagedCadence(mk("+15550000007", { conv: { followUp: { mode: "manual_handoff" } } }), TZ, NOW),
  false,
  "manual_handoff => left alone"
);
assert.equal(
  realignOverEagerEngagedCadence(mk("+15550000008", { conv: { appointment: { bookedEventId: "evt1" } } }), TZ, NOW),
  false,
  "already booked => left alone"
);
assert.equal(
  realignOverEagerEngagedCadence(mk("+15550000009", { conv: { inventoryWatch: { model: "Low Rider S" } } }), TZ, NOW),
  false,
  "inventory-watch lead => left alone"
);
n += 8;

// --- 4) Source guard: the cap is applied in BOTH the live tick and the regenerate path, and the
// reconcile runs the heal. ---
const api = fs.readFileSync("services/api/src/index.ts", "utf8");
const store = fs.readFileSync("services/api/src/domain/conversationStore.ts", "utf8");
assert.match(api, /const cadenceTempoCapped = cadenceTempoCappedToLongTerm\(conv\.lead\)/, "live tick computes the cap");
assert.match(api, /!cadenceTempoCapped &&[\s\S]{0,160}cadence\.kind = "engaged"/, "live tick prevent-upgrade guards the engaged bump");
assert.match(api, /!cadenceTempoCappedToLongTerm\(conv\.lead\) &&[\s\S]{0,120}engagement\?\.at/, "regen engagedKind respects the cap (route parity)");
assert.match(api, /realignOverEagerEngagedCadence\(conv, cfg\.timezone, now\)/, "reconcile runs the heal");
assert.match(api, /engaged_cadence_capped_to_long_term/, "route outcome recorded");
assert.match(store, /export function cadenceTempoCappedToLongTerm/, "predicate exported from the store");
assert.match(store, /export function realignOverEagerEngagedCadence/, "heal exported from the store");
n += 7;

console.log(`PASS cadence tempo timeframe-cap eval (${n} assertions)`);
