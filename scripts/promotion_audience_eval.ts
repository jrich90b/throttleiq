/**
 * promotion_audience:eval — pins the deterministic promo-suppression gate that
 * keeps bulk promotions away from customers who shouldn't get a sales pitch
 * (just bought / deal on hold / not interested / wrong number), while keeping
 * legitimate audiences (open leads, past-window buyers) reachable.
 *
 * Decision-table eval over evaluatePromotionSuppression (pure, no LLM).
 * Fail direction pinned: a sold signal WITHOUT a date must suppress.
 */
import assert from "node:assert/strict";

const { evaluatePromotionSuppression, DEFAULT_RECENTLY_SOLD_DAYS } = await import(
  "../services/api/src/domain/promotionAudience.ts"
);

const NOW = Date.parse("2026-07-01T12:00:00Z");
const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

type Case = {
  name: string;
  conv: any;
  expectSuppressed: boolean;
  expectReason?: string;
};

const CASES: Case[] = [
  // ── satisfied: the classes that must suppress ────────────────────────────
  {
    name: "sold last week (sale.soldAt) → recently_sold",
    conv: { status: "closed", closedReason: "sold", sale: { soldAt: iso(7 * DAY) } },
    expectSuppressed: true,
    expectReason: "recently_sold"
  },
  {
    name: "sold today → recently_sold",
    conv: { sale: { soldAt: iso(0) } },
    expectSuppressed: true,
    expectReason: "recently_sold"
  },
  {
    name: "post_sale cadence, no explicit soldAt, closedAt recent → recently_sold",
    conv: { status: "closed", closedAt: iso(3 * DAY), followUpCadence: { kind: "post_sale" } },
    expectSuppressed: true,
    expectReason: "recently_sold"
  },
  {
    name: "deal on hold (hold object) → on_hold",
    conv: { status: "open", hold: { stockId: "T22-26", label: "Street Glide 3 Limited" } },
    expectSuppressed: true,
    expectReason: "on_hold"
  },
  {
    name: "cadence paused unit_hold → on_hold",
    conv: { status: "open", followUpCadence: { pauseReason: "unit_hold" } },
    expectSuppressed: true,
    expectReason: "on_hold"
  },
  {
    name: "cadence stopped order_hold → on_hold",
    conv: { status: "open", followUpCadence: { stopReason: "order_hold" } },
    expectSuppressed: true,
    expectReason: "on_hold"
  },
  {
    name: "followUp reason manual_hold → on_hold",
    conv: { status: "open", followUp: { reason: "manual_hold" } },
    expectSuppressed: true,
    expectReason: "on_hold"
  },
  {
    name: "closed not_interested → not_interested",
    conv: { status: "closed", closedReason: "not_interested", closedAt: iso(10 * DAY) },
    expectSuppressed: true,
    expectReason: "not_interested"
  },
  {
    name: "closed opt_out → not_interested",
    conv: { status: "closed", closedReason: "opt_out" },
    expectSuppressed: true,
    expectReason: "not_interested"
  },
  {
    name: "closed wrong_number → wrong_number",
    conv: { status: "closed", closedReason: "wrong_number" },
    expectSuppressed: true,
    expectReason: "wrong_number"
  },

  // ── fail-direction: ambiguity fails toward NOT sending ───────────────────
  {
    name: "sold signal with NO date anywhere → suppress (fail-safe)",
    conv: { status: "closed", closedReason: "sold" },
    expectSuppressed: true,
    expectReason: "recently_sold"
  },

  // ── edges: legitimate audiences stay reachable ───────────────────────────
  {
    name: "open active lead → sendable",
    conv: { status: "open", followUpCadence: { kind: "standard" } },
    expectSuppressed: false
  },
  {
    name: `bought past the ${DEFAULT_RECENTLY_SOLD_DAYS}d window → sendable again`,
    conv: { status: "closed", closedReason: "sold", sale: { soldAt: iso(200 * DAY) } },
    expectSuppressed: false
  },
  {
    name: "closed no_response → still sendable (promos re-engage quiet leads)",
    conv: { status: "closed", closedReason: "no_response" },
    expectSuppressed: false
  },
  {
    name: "cadence paused for a non-hold reason → sendable",
    conv: { status: "open", followUpCadence: { pauseReason: "manual_handoff" } },
    expectSuppressed: false
  },
  {
    name: "null conversation (imported contact, no history) → sendable",
    conv: null,
    expectSuppressed: false
  },

  // ── adversarial: near-miss strings must not confuse the gate ─────────────
  {
    name: "closedReason 'household decision' does NOT match hold/sold",
    conv: { status: "closed", closedReason: "household decision" },
    expectSuppressed: false
  },
  {
    name: "closedReason 'sold' but conversation still open (typo/manual) → suppress via fail-safe only when closed; open+reason-only stays sendable",
    conv: { status: "open", closedReason: "sold" },
    expectSuppressed: false
  },
  {
    name: "custom close 'customer not interested right now' → not_interested",
    conv: { status: "closed", closedReason: "Customer NOT interested right now" },
    expectSuppressed: true,
    expectReason: "not_interested"
  }
];

let failures = 0;
for (const c of CASES) {
  const got = evaluatePromotionSuppression(c.conv, { nowMs: NOW });
  try {
    assert.equal(got.suppressed, c.expectSuppressed, `suppressed mismatch (got ${JSON.stringify(got)})`);
    if (c.expectReason) assert.equal(got.reason, c.expectReason, `reason mismatch (got ${JSON.stringify(got)})`);
    console.log(`PASS ${c.name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`FAIL ${c.name}: ${err?.message ?? err}`);
  }
}

// Window override behaves.
{
  const conv = { status: "closed", closedReason: "sold", sale: { soldAt: iso(30 * DAY) } };
  const tight = evaluatePromotionSuppression(conv, { nowMs: NOW, recentlySoldDays: 14 });
  const wide = evaluatePromotionSuppression(conv, { nowMs: NOW, recentlySoldDays: 60 });
  try {
    assert.equal(tight.suppressed, false, "14d window should release a 30d-ago buyer");
    assert.equal(wide.suppressed, true, "60d window should still suppress a 30d-ago buyer");
    console.log("PASS recentlySoldDays override");
  } catch (err: any) {
    failures += 1;
    console.error(`FAIL recentlySoldDays override: ${err?.message ?? err}`);
  }
}

// ── Engagement-based suppression (PROMOTION blasts only): booked appt / active back-and-forth /
//    deal-or-trade in progress. Joe ruling 2026-07-16 — 3 states, 7-day window, event blasts exempt.
const isoFuture = (msAhead: number) => new Date(NOW + msAhead).toISOString();
type EngCase = { name: string; conv: any; suppressed: boolean; reason?: string; days?: number };
const ENGAGED: EngCase[] = [
  // Booked appointment.
  { name: "upcoming confirmed appointment → booked_appointment", conv: { appointment: { status: "confirmed", whenIso: isoFuture(2 * DAY) } }, suppressed: true, reason: "booked_appointment" },
  { name: "booked appointment with no time (fail-safe) → booked_appointment", conv: { appointment: { bookedEventId: "evt_1" } }, suppressed: true, reason: "booked_appointment" },
  { name: "appointment 3d in the PAST (grace expired) → sendable", conv: { appointment: { status: "confirmed", whenIso: iso(3 * DAY) } }, suppressed: false },
  // Active back-and-forth = the CUSTOMER's last inbound, 7-day window.
  { name: "customer replied today → active_conversation", conv: { lastInboundAt: iso(0) }, suppressed: true, reason: "active_conversation" },
  { name: "customer replied 6d ago (inside 7d) → active_conversation", conv: { lastInboundAt: iso(6 * DAY) }, suppressed: true, reason: "active_conversation" },
  { name: "customer replied 8d ago (outside 7d) → sendable", conv: { lastInboundAt: iso(8 * DAY) }, suppressed: false },
  { name: "no customer inbound (we only nudged) → sendable", conv: { status: "open" }, suppressed: false },
  { name: "custom 3d window releases a 6d-ago reply → sendable", conv: { lastInboundAt: iso(6 * DAY) }, days: 3, suppressed: false },
  // Deal or trade in progress.
  { name: "in_process_deal → active_deal", conv: { followUp: { reason: "in_process_deal" } }, suppressed: true, reason: "active_deal" },
  { name: "open trade-in/sell lead → active_deal", conv: { status: "open", classification: { bucket: "trade_in_sell" } }, suppressed: true, reason: "active_deal" },
  { name: "CLOSED trade lead → sendable (not mid-trade)", conv: { status: "closed", classification: { bucket: "trade_in_sell" } }, suppressed: false },
  { name: "plain sales inventory lead → sendable", conv: { status: "open", classification: { bucket: "inventory_interest" }, lastInboundAt: iso(30 * DAY) }, suppressed: false }
];
for (const c of ENGAGED) {
  const got = evaluatePromotionSuppression(c.conv, { nowMs: NOW, suppressEngagedLeads: true, ...(c.days != null ? { activeConversationDays: c.days } : {}) });
  try {
    assert.equal(got.suppressed, c.suppressed, `[promotion] suppressed mismatch (got ${JSON.stringify(got)})`);
    if (c.reason) assert.equal(got.reason, c.reason, `[promotion] reason mismatch (got ${JSON.stringify(got)})`);
    // EVENT blast (suppressEngagedLeads default off) must NOT apply these — an event reaches them.
    const asEvent = evaluatePromotionSuppression(c.conv, { nowMs: NOW });
    if (c.reason) {
      assert.equal(asEvent.suppressed, false, `[event] engaged state "${c.name}" must NOT suppress an event blast (got ${JSON.stringify(asEvent)})`);
    }
    console.log(`PASS engaged: ${c.name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`FAIL engaged: ${c.name}: ${err?.message ?? err}`);
  }
}
// ── EVENT blasts (dealer_event) are invitations, not pitches: they REACH recent buyers, deals on
//    hold, and in-play leads (Joe ruling 2026-07-16 — "i want event blasts to reach sold and hold
//    leads"). Only the do-not-contact states (opted out / wrong number) still bite on an event.
type KindCase = { name: string; conv: any; suppressed: boolean; reason?: string };
const EVENT_OPTS = { nowMs: NOW, suppressDealStates: false, suppressEngagedLeads: false };
const EVENT_CASES: KindCase[] = [
  { name: "event reaches a buyer sold last week", conv: { status: "closed", closedReason: "sold", sale: { soldAt: iso(7 * DAY) } }, suppressed: false },
  { name: "event reaches a buyer sold today", conv: { sale: { soldAt: iso(0) } }, suppressed: false },
  { name: "event reaches a sold lead with no date (no fail-safe on an invite)", conv: { status: "closed", closedReason: "sold" }, suppressed: false },
  { name: "event reaches a deal on hold", conv: { status: "open", hold: { stockId: "T22-26" } }, suppressed: false },
  { name: "event reaches a unit_hold cadence pause", conv: { status: "open", followUpCadence: { pauseReason: "unit_hold" } }, suppressed: false },
  { name: "event reaches an engaged lead (replied today)", conv: { lastInboundAt: iso(0) }, suppressed: false },
  { name: "event reaches a booked appointment", conv: { appointment: { status: "confirmed", whenIso: isoFuture(DAY) } }, suppressed: false },
  { name: "event reaches a trade-in lead", conv: { status: "open", classification: { bucket: "trade_in_sell" } }, suppressed: false },
  // Do-not-contact still wins on an EVENT — these are the suppressed-list equivalents, not "in play".
  { name: "event still skips opted-out", conv: { status: "closed", closedReason: "opt_out" }, suppressed: true, reason: "not_interested" },
  { name: "event still skips not_interested", conv: { status: "closed", closedReason: "not_interested" }, suppressed: true, reason: "not_interested" },
  { name: "event still skips wrong_number", conv: { status: "closed", closedReason: "wrong_number" }, suppressed: true, reason: "wrong_number" }
];
for (const c of EVENT_CASES) {
  const got = evaluatePromotionSuppression(c.conv, EVENT_OPTS);
  try {
    assert.equal(got.suppressed, c.suppressed, `[event] suppressed mismatch (got ${JSON.stringify(got)})`);
    if (c.reason) assert.equal(got.reason, c.reason, `[event] reason mismatch (got ${JSON.stringify(got)})`);
    console.log(`PASS event: ${c.name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`FAIL event: ${c.name}: ${err?.message ?? err}`);
  }
}
// Contrast — the SAME sold/hold leads an event reaches must still be skipped by a PROMOTION.
const PROMO_OPTS = { nowMs: NOW, suppressDealStates: true, suppressEngagedLeads: true };
const PROMO_CASES: KindCase[] = [
  { name: "promotion still skips a buyer sold last week", conv: { status: "closed", closedReason: "sold", sale: { soldAt: iso(7 * DAY) } }, suppressed: true, reason: "recently_sold" },
  { name: "promotion still skips a deal on hold", conv: { status: "open", hold: { stockId: "T22-26" } }, suppressed: true, reason: "on_hold" },
  { name: "promotion skips an engaged lead", conv: { lastInboundAt: iso(0) }, suppressed: true, reason: "active_conversation" }
];
for (const c of PROMO_CASES) {
  const got = evaluatePromotionSuppression(c.conv, PROMO_OPTS);
  try {
    assert.equal(got.suppressed, c.suppressed, `[promotion] suppressed mismatch (got ${JSON.stringify(got)})`);
    if (c.reason) assert.equal(got.reason, c.reason, `[promotion] reason mismatch (got ${JSON.stringify(got)})`);
    console.log(`PASS promotion: ${c.name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`FAIL promotion: ${c.name}: ${err?.message ?? err}`);
  }
}

// Precedence: an engaged lead who is ALSO recently sold still reports the sold reason (existing
// states run first — we never downgrade a hard suppression).
{
  const got = evaluatePromotionSuppression(
    { sale: { soldAt: iso(3 * DAY) }, lastInboundAt: iso(1 * DAY), appointment: { status: "confirmed", whenIso: isoFuture(DAY) } },
    { nowMs: NOW, suppressEngagedLeads: true }
  );
  try {
    assert.equal(got.reason, "recently_sold", `hard suppression must win over engagement (got ${JSON.stringify(got)})`);
    console.log("PASS engaged: sold outranks engagement");
  } catch (err: any) {
    failures += 1;
    console.error(`FAIL engaged precedence: ${err?.message ?? err}`);
  }
}

if (failures > 0) {
  console.error(`promotion_audience:eval FAILED (${failures} case(s))`);
  process.exit(1);
}
console.log(
  `promotion_audience:eval OK (${CASES.length + 1 + ENGAGED.length + EVENT_CASES.length + PROMO_CASES.length + 1} cases)`
);
