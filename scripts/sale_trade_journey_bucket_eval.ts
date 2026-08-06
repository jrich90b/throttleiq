/**
 * Decision table for decideSaleTradeJourneyBucket (routeStateReducer).
 *
 * The journey parser's `sale_trade` tag covers BUYING and TRADING with one label ("customer is
 * explicitly shopping again, wants to buy, asks for trade/appraisal value, asks about
 * availability/pricing/test ride for purchase" — llmDraft journey-intent prompt). The ADF inbound
 * route used to read the bare tag as a trade appraisal whenever the customer named no unit, and
 * opened the first touch with "Thanks for using our trade-in estimator on your <bike>".
 *
 * Two reproduced misses in the 2026-08-06 corpus replay, both Room58 "Request details" leads whose
 * structured Trade-In field is a form MIRROR of the bike they are shopping for:
 *   - Beth Bremer  (Ref 11449, +13088830093) "I sold my sportster several years back ... is the
 *     super glide a good option?"  -> trade appraisal pitch, fit question never answered (P1).
 *   - Brandon Drazinski (Ref 11278, +19083008509) "Do you happen to have a PDF brochure ... just
 *     shopping around" -> same trade-estimator opening.
 *
 * This eval EXECUTES the decision (a source-text assertion cannot prove the mapping) and pins the
 * fail direction: with no honest trade evidence, a sale_trade journey lands in the shopping bucket.
 */
import assert from "node:assert/strict";
import {
  decideSaleTradeJourneyBucket,
  type SaleTradeJourneyBucketInput
} from "../services/api/src/domain/routeStateReducer.ts";

const base: SaleTradeJourneyBucketInput = {
  saleTradeIntentFromParser: true,
  inferredBucket: "general_inquiry",
  hasParserBucketCta: false,
  hasStockIntent: false,
  hasStructuredTradeVehicle: false
};

type Row = {
  id: string;
  input: SaleTradeJourneyBucketInput;
  applies: boolean;
  bucket: string | null;
  cta: string | null;
};

const rows: Row[] = [
  // --- THE REGRESSION THIS FIX EXISTS FOR ------------------------------------
  {
    // Beth Bremer: sales journey, no unit named, no trade evidence. Must NOT be a trade lead.
    id: "beth_bremer_fit_question_is_shopping_not_trade",
    input: { ...base },
    applies: true,
    bucket: "inventory_interest",
    cta: "check_availability"
  },
  {
    // Brandon Drazinski: brochure request, "just shopping around". Same shape, same answer.
    id: "brandon_drazinski_brochure_request_is_shopping_not_trade",
    input: { ...base },
    applies: true,
    bucket: "inventory_interest",
    cta: "check_availability"
  },

  // --- A REAL TRADE STILL ROUTES TO TRADE ------------------------------------
  {
    // A structured trade vehicle that SURVIVED isMirroredTradeFieldArtifact is a trade the
    // customer really reported — it keeps the appraisal route.
    id: "structured_trade_vehicle_keeps_trade_route",
    input: { ...base, hasStructuredTradeVehicle: true },
    applies: true,
    bucket: "trade_in_sell",
    cta: "value_my_trade"
  },
  {
    // A named unit is a shopping signal and outranks a trade field: they are asking about a bike.
    id: "stock_intent_outranks_trade_vehicle",
    input: { ...base, hasStockIntent: true, hasStructuredTradeVehicle: true },
    applies: true,
    bucket: "inventory_interest",
    cta: "check_availability"
  },
  {
    id: "stock_intent_without_trade_is_shopping",
    input: { ...base, hasStockIntent: true },
    applies: true,
    bucket: "inventory_interest",
    cta: "check_availability"
  },

  // --- THE FALLBACK NEVER FIRES OUTSIDE ITS OWN LANE -------------------------
  {
    // No parser verdict => the deterministic chain's answer stands untouched.
    id: "no_sale_trade_parser_signal_leaves_bucket_alone",
    input: { ...base, saleTradeIntentFromParser: false },
    applies: false,
    bucket: null,
    cta: null
  },
  {
    // A routing-parser bucket/cta already won; this fallback must not override it.
    id: "parser_bucket_cta_wins",
    input: { ...base, hasParserBucketCta: true },
    applies: false,
    bucket: null,
    cta: null
  },
  {
    // The deterministic chain already routed this lead (parts/service/trade/finance/...). Only a
    // lead that fell all the way through to general_inquiry reaches this fallback.
    id: "explicit_trade_branch_already_decided",
    input: { ...base, inferredBucket: "trade_in_sell" },
    applies: false,
    bucket: null,
    cta: null
  },
  {
    id: "service_branch_already_decided",
    input: { ...base, inferredBucket: "service" },
    applies: false,
    bucket: null,
    cta: null
  }
];

let failures = 0;
for (const row of rows) {
  const got = decideSaleTradeJourneyBucket(row.input);
  try {
    assert.equal(got.applies, row.applies, `${row.id}: applies`);
    assert.equal(got.bucket, row.bucket, `${row.id}: bucket`);
    assert.equal(got.cta, row.cta, `${row.id}: cta`);
    console.log(`PASS ${row.id} -> ${got.applies ? `${got.bucket}/${got.cta}` : "no-op"}`);
  } catch (e: any) {
    failures += 1;
    console.error(`FAIL ${row.id}: ${e?.message ?? e}`);
  }
}

// The bare journey tag must NEVER be sufficient on its own to assert a trade. This is the
// fail-direction invariant, stated independently of the table above so a future edit that widens
// the trade branch has to break it explicitly.
const tradeOutcomes = rows
  .map(row => decideSaleTradeJourneyBucket(row.input))
  .filter(d => d.applies && d.bucket === "trade_in_sell");
for (const [i, row] of rows.entries()) {
  const got = decideSaleTradeJourneyBucket(row.input);
  if (got.applies && got.bucket === "trade_in_sell" && !row.input.hasStructuredTradeVehicle) {
    failures += 1;
    console.error(
      `FAIL fail_direction: row ${i} (${row.id}) routed to trade_in_sell with no structured trade vehicle`
    );
  }
}
if (tradeOutcomes.length === 0) {
  failures += 1;
  console.error("FAIL fail_direction: no row exercises the genuine trade route — the table is blind");
}

// The route must consume the centralized decision, not re-implement the mapping inline.
const routeSource = await (await import("node:fs/promises")).readFile(
  new URL("../services/api/src/routes/sendgridInbound.ts", import.meta.url),
  "utf8"
);
if (!/decideSaleTradeJourneyBucket\(\{/.test(routeSource)) {
  failures += 1;
  console.error("FAIL wiring: sendgridInbound.ts does not call decideSaleTradeJourneyBucket({...})");
}
if (/inferredCta = hasStockIntent \? "check_availability" : "value_my_trade"/.test(routeSource)) {
  failures += 1;
  console.error("FAIL wiring: the inline sale_trade -> value_my_trade fallback is back in the route");
}

if (failures > 0) {
  console.error(`\nsale_trade journey bucket eval FAILED (${failures})`);
  process.exit(1);
}
console.log(`\nsale_trade journey bucket eval PASSED (${rows.length} rows)`);
