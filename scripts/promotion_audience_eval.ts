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

if (failures > 0) {
  console.error(`promotion_audience:eval FAILED (${failures} case(s))`);
  process.exit(1);
}
console.log(`promotion_audience:eval OK (${CASES.length + 1} cases)`);
