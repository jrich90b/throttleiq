/**
 * web_text_widget_seller_bucket:eval — a website-widget lead SELLING us their bike is not filed as
 * a buyer asking about stock, and "buy outright?" never mints a bike called "Outright".
 *
 * THE REPRODUCED MISS. Beverly Hennig (+17169839279) wrote, through the Sales widget on 2026-08-05:
 *   "Do you take used Harley's on consignment or buy outright? I have a 2008 Superglide in
 *    excellent condition for sale."
 * Operator note, 8/6: "Someone selling us their bike should not carry an availability tag." Two
 * stored fields were wrong, both still wrong on the live record when this was built:
 *
 *   1. classification {bucket: inventory_interest, cta: check_availability}. The old classifier read
 *      the DEPARTMENT and nothing else, so EVERY Sales widget lead was a buyer before a word of the
 *      message was read. That is not only a console badge: salesTopicHint maps check_availability ->
 *      the "availability" topic hint that goes INTO the draft.
 *   2. lead.vehicle = {model: "Outright"} AND conv.inventoryContext = {model: "Outright"} — a
 *      phantom bike, because the extractor's requested-vehicle regex has a bare `buy` alternative
 *      and "or buy outright?" (the customer asking whether WE buy) parsed as a model name. This one
 *      has teeth: the widget ack fallback narrates conv.inventoryContext.model back at the customer.
 *
 * WHAT IS PINNED. This eval EXECUTES both halves — a source-text assertion could not prove either.
 *   (a) decideWebTextWidgetSalesClassification's decision table, including the fail direction:
 *       anything short of a positive, accepted sell-side parser verdict stays on the BUY side,
 *       because treating a buyer as a seller (not answering the availability question they asked)
 *       is strictly worse than the tag bug this fixes.
 *   (b) mergeWebTextWidgetSalesContext against Beverly's REAL widget body — the extractor still
 *       mints "Outright" (asserted here, so the phantom cannot quietly come back as the ONLY thing
 *       being tested), and the merge drops it because the parser read her as a seller.
 *   (c) the WIRING: both paths (/public/widget/text-us and /conversations/:id/regenerate) pass the
 *       resolved context to webTextWidgetClassification. The ratchet cannot prove wiring, so the
 *       call sites are counted with an expected count.
 *
 * Run: npx tsx scripts/web_text_widget_seller_bucket_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  decideWebTextWidgetSalesClassification,
  type WebTextWidgetSalesClassificationInput
} from "../services/api/src/domain/routeStateReducer.ts";
import {
  extractWebTextWidgetCustomerMessage,
  extractWebTextWidgetSalesVehicleContext,
  mergeWebTextWidgetSalesContext,
  webTextWidgetClassification,
  webTextWidgetParserResultToContext,
  type WebTextWidgetSalesVehicleContext
} from "../services/api/src/domain/webTextWidget.ts";
import type { WebTextWidgetSalesLeadParse } from "../services/api/src/domain/llmDraft.ts";

const failures: string[] = [];
const check = (id: string, fn: () => void) => {
  try {
    fn();
  } catch (err) {
    failures.push(`${id}: ${(err as Error).message}`);
  }
};

// ---------------------------------------------------------------------------
// (a) The decision table.
// ---------------------------------------------------------------------------
type Row = {
  id: string;
  input: WebTextWidgetSalesClassificationInput;
  bucket: string;
  cta: string;
  sellSide: boolean;
};

const rows: Row[] = [
  {
    // THE MISS. Beverly: Sales department, parser read the turn as sell_or_trade, and the PARSER
    // found no bike she wants to buy.
    id: "beverly_seller_is_a_trade_in_lead_not_an_availability_lead",
    input: { department: "sales", parserIntent: "sell_or_trade", parserHasRequestedVehicle: false },
    bucket: "trade_in_sell",
    cta: "value_my_trade",
    sellSide: true
  },
  {
    // FAIL DIRECTION. A sell_or_trade read that ALSO names a bike they want is a buyer with a
    // trade — the buy side, so their availability question still gets answered.
    id: "sell_or_trade_with_a_requested_vehicle_stays_buy_side",
    input: { department: "sales", parserIntent: "sell_or_trade", parserHasRequestedVehicle: true },
    bucket: "inventory_interest",
    cta: "check_availability",
    sellSide: false
  },
  {
    // FAIL DIRECTION. No accepted parser verdict at all (parser off, low confidence, or nothing
    // found) => today's behaviour, unchanged.
    id: "no_parser_verdict_stays_buy_side",
    input: { department: "sales", parserIntent: null, parserHasRequestedVehicle: false },
    bucket: "inventory_interest",
    cta: "check_availability",
    sellSide: false
  },
  {
    id: "buy_inventory_is_buy_side",
    input: { department: "sales", parserIntent: "buy_inventory", parserHasRequestedVehicle: true },
    bucket: "inventory_interest",
    cta: "check_availability",
    sellSide: false
  },
  {
    // A buyer WITH a trade is still a buyer — this is the case the old code got right and the fix
    // must not break.
    id: "buy_inventory_with_trade_is_buy_side",
    input: {
      department: "sales",
      parserIntent: "buy_inventory_with_trade",
      parserHasRequestedVehicle: true
    },
    bucket: "inventory_interest",
    cta: "check_availability",
    sellSide: false
  },
  {
    // A financing question with no bike named is NOT a seller. Only sell_or_trade is.
    id: "finance_question_without_a_bike_is_not_a_seller",
    input: {
      department: "sales",
      parserIntent: "finance_or_payment",
      parserHasRequestedVehicle: false
    },
    bucket: "inventory_interest",
    cta: "check_availability",
    sellSide: false
  },
  {
    id: "general_sales_without_a_bike_is_not_a_seller",
    input: { department: "sales", parserIntent: "general_sales", parserHasRequestedVehicle: false },
    bucket: "inventory_interest",
    cta: "check_availability",
    sellSide: false
  },
  // The three non-sales departments are unchanged by this slice and are pinned so the delegation
  // from webTextWidgetClassification cannot drift into them.
  {
    id: "service_department_unchanged",
    input: { department: "service" },
    bucket: "service",
    cta: "service_request",
    sellSide: false
  },
  {
    id: "parts_department_unchanged",
    input: { department: "parts" },
    bucket: "parts",
    cta: "parts_request",
    sellSide: false
  },
  {
    // Lynn Kraus (+17164785613) came through Motor Clothes to sell us a Road King. The apparel
    // department is NEVER re-read as a sales lead here — that turn belongs to
    // decideDeptWidgetIntakeTurn, and this referee must not grow a second opinion about it.
    id: "apparel_department_unchanged_even_for_a_seller",
    input: { department: "apparel", parserIntent: "sell_or_trade", parserHasRequestedVehicle: false },
    bucket: "apparel",
    cta: "apparel_request",
    sellSide: false
  }
];

for (const row of rows) {
  check(row.id, () => {
    const got = decideWebTextWidgetSalesClassification(row.input);
    assert.equal(got.bucket, row.bucket, `bucket: expected ${row.bucket}, got ${got.bucket}`);
    assert.equal(got.cta, row.cta, `cta: expected ${row.cta}, got ${got.cta}`);
    assert.equal(got.sellSide, row.sellSide, `sellSide: expected ${row.sellSide}, got ${got.sellSide}`);
  });
}

// The referee is TOTAL: every department returns a usable pair, so a caller can never be handed a
// null classification and fall back to something unspecified.
check("referee_is_total", () => {
  for (const department of ["sales", "service", "parts", "apparel"] as const) {
    const got = decideWebTextWidgetSalesClassification({ department });
    assert.ok(got.bucket.length > 0 && got.cta.length > 0, `${department} produced an empty pair`);
  }
});

// ---------------------------------------------------------------------------
// (b) Beverly's REAL widget body, through the real extractor and the real merge.
// ---------------------------------------------------------------------------
const BEVERLY_BODY = [
  "WEB TEXT WIDGET",
  "Department: Sales",
  "Name: Beverly Hennig",
  "Page: Used Harley Davidson for Sale, Buffalo, North Tonawanda NY | American Harley-Davidson®",
  "URL: https://americanharley-davidson.com/used-harley-davidson-motorcycles-for-sale-buffalo-ny-xpreownedinventory",
  "",
  "Message:",
  "Do you take used Harley’s on consignment or buy outright? I have a 2008 Superglide in excellent condition for sale."
].join("\n");

// What the typed parser returned for her turn: sell_or_trade, her 2008 as the trade vehicle, a cash
// sell option (the live record carries lead.sellOption: "cash"), and NO requested vehicle. This is
// the RAW parse, run through the real webTextWidgetParserResultToContext — so the chain from parser
// output to classification is executed end to end. Building the context by hand instead would let
// the fix go inert (the verdict silently stopped being carried) while this eval stayed green: that
// exact sabotage passed before this was tightened.
const BEVERLY_RAW_PARSE: WebTextWidgetSalesLeadParse = {
  intent: "sell_or_trade",
  requestedVehicle: null,
  tradeVehicle: { year: "2008", model: "Superglide", color: "", condition: "used" },
  sellOption: "cash",
  explicitRequest: true,
  confidence: 0.94
};

const BEVERLY_PARSED = webTextWidgetParserResultToContext(BEVERLY_RAW_PARSE);

check("the_parsers_own_verdict_survives_into_the_context", () => {
  assert.ok(BEVERLY_PARSED, "an accepted seller parse produced no context at all");
  assert.equal(
    BEVERLY_PARSED?.parserIntent,
    "sell_or_trade",
    "the parser's intent is not carried into the context — the classification referee is blind"
  );
  assert.ok(!BEVERLY_PARSED?.parserHasRequestedVehicle, "the parser found no bike she wants to buy");
});

// THE CASE THAT DECIDES WHETHER A BUYER IS SAFE. "I want the 2000 Wide Glide, I have a 2025 Road
// King to trade" is a sell_or_trade-flavoured turn that names a bike they want — a BUYER. It stays
// buy-side only because the parser's requested vehicle is carried through; run end to end from the
// raw parse, because building the context by hand cannot see that half go missing.
check("a_buyer_with_a_trade_is_still_a_buyer_end_to_end", () => {
  const context = webTextWidgetParserResultToContext({
    intent: "buy_inventory_with_trade",
    requestedVehicle: { year: "2000", model: "Wide Glide", color: "", condition: "used" },
    tradeVehicle: { year: "2025", model: "Road King Special", color: "", condition: "new" },
    sellOption: "either",
    explicitRequest: true,
    confidence: 0.97
  });
  assert.ok(context, "an accepted buyer-with-trade parse produced no context");
  assert.equal(
    context?.parserHasRequestedVehicle,
    true,
    "the parser's requested vehicle is not carried — a buyer with a trade would read as a seller"
  );
  const classification = webTextWidgetClassification("sales", context);
  assert.equal(classification.bucket, "inventory_interest");
  assert.equal(classification.cta, "check_availability");
});

// The same shape with sell_or_trade: the intent alone must never be enough when they named a bike.
check("sell_or_trade_that_names_a_wanted_bike_is_buy_side_end_to_end", () => {
  const context = webTextWidgetParserResultToContext({
    intent: "sell_or_trade",
    requestedVehicle: { year: "2024", model: "Road Glide", color: "", condition: "used" },
    tradeVehicle: { year: "2015", model: "Sportster", color: "", condition: "used" },
    sellOption: "trade",
    explicitRequest: true,
    confidence: 0.95
  });
  assert.equal(webTextWidgetClassification("sales", context).cta, "check_availability");
});

// A parse below the confidence floor is NOT accepted, so nothing about it can steer the
// classification — the floor is the revert path and must keep holding.
check("a_low_confidence_parse_is_not_accepted", () => {
  const weak = webTextWidgetParserResultToContext({ ...BEVERLY_RAW_PARSE, confidence: 0.4 });
  assert.equal(weak, null, `a 0.4-confidence parse must not produce a context; got ${JSON.stringify(weak)}`);
});

check("extractor_still_mints_the_phantom_so_the_merge_is_what_is_being_tested", () => {
  const extracted = extractWebTextWidgetSalesVehicleContext(BEVERLY_BODY);
  assert.ok(extracted, "the extractor returned nothing for Beverly's message");
  // If this ever stops being true the phantom was fixed somewhere else and the assertion below
  // would start passing for free — which is exactly the sabotage-proof case worth stating.
  assert.equal(
    String(extracted?.requestedVehicle?.model ?? ""),
    "Outright",
    "the extractor no longer mints the phantom; re-scope this eval rather than deleting it"
  );
});

check("beverly_merge_drops_the_phantom_bike", () => {
  const merged = mergeWebTextWidgetSalesContext(
    BEVERLY_PARSED,
    extractWebTextWidgetSalesVehicleContext(BEVERLY_BODY),
    extractWebTextWidgetCustomerMessage(BEVERLY_BODY)
  );
  assert.ok(merged, "the merge returned nothing for Beverly's message");
  assert.equal(
    merged?.requestedVehicle,
    undefined,
    `a seller must carry no requested vehicle; got ${JSON.stringify(merged?.requestedVehicle)}`
  );
  // Her 2008 is still hers, and the sell option survives — the fix removes the phantom, not the
  // things that made her a seller.
  assert.equal(String(merged?.tradeVehicle?.year ?? ""), "2008");
  assert.equal(String(merged?.sellOption ?? ""), "cash");
});

check("beverly_is_classified_as_a_trade_in_lead", () => {
  const merged = mergeWebTextWidgetSalesContext(
    BEVERLY_PARSED,
    extractWebTextWidgetSalesVehicleContext(BEVERLY_BODY),
    extractWebTextWidgetCustomerMessage(BEVERLY_BODY)
  );
  const classification = webTextWidgetClassification("sales", merged);
  assert.equal(classification.bucket, "trade_in_sell");
  assert.equal(classification.cta, "value_my_trade");
});

// A genuine buyer through the same widget is untouched — same body shape, opposite verdict.
const BUYER_BODY = [
  "WEB TEXT WIDGET",
  "Department: Sales",
  "",
  "Message:",
  "Looking at that 2024 Road Glide. Is it still available and what is the price?"
].join("\n");

check("a_real_buyer_keeps_the_requested_vehicle_and_the_availability_cta", () => {
  const merged = mergeWebTextWidgetSalesContext(
    {
      requestedVehicle: { year: "2024", model: "Road Glide" },
      parserIntent: "buy_inventory",
      parserHasRequestedVehicle: true
    },
    extractWebTextWidgetSalesVehicleContext(BUYER_BODY),
    extractWebTextWidgetCustomerMessage(BUYER_BODY)
  );
  assert.ok(merged?.requestedVehicle, "the buyer lost their requested vehicle");
  assert.equal(String(merged?.requestedVehicle?.model ?? ""), "Road Glide");
  const classification = webTextWidgetClassification("sales", merged);
  assert.equal(classification.cta, "check_availability");
});

// With no parser verdict at all the extractor still wins, exactly as before this slice — the
// unaccepted-parse fallback is the revert path and must keep working.
check("without_a_parser_verdict_the_extractor_still_supplies_the_vehicle", () => {
  const merged = mergeWebTextWidgetSalesContext(
    null,
    extractWebTextWidgetSalesVehicleContext(BUYER_BODY),
    extractWebTextWidgetCustomerMessage(BUYER_BODY)
  );
  assert.equal(String(merged?.requestedVehicle?.model ?? ""), "Road Glide");
});

// The department-only call keeps its old meaning for every caller that has no context to give.
check("department_only_call_is_unchanged", () => {
  assert.equal(webTextWidgetClassification("sales").cta, "check_availability");
  assert.equal(webTextWidgetClassification("service").cta, "service_request");
});

// ---------------------------------------------------------------------------
// (c) WIRING — the ratchet cannot prove it, so count the call sites.
// ---------------------------------------------------------------------------
check("both_paths_pass_the_resolved_context_to_the_classifier", () => {
  const src = fs.readFileSync("services/api/src/index.ts", "utf8");
  const live = "webTextWidgetClassification(department, salesVehicleContext)";
  const regen = 'webTextWidgetClassification("sales", regenWebTextWidgetSalesContext)';
  assert.ok(src.includes(live), `the live widget path no longer passes the context: ${live}`);
  assert.ok(src.includes(regen), `the regenerate path no longer passes the context: ${regen}`);
  // EXPECTED COUNT: exactly one context-passing call per path. A third would mean a new writer of
  // this classification appeared without a referee, which is what the contention rules forbid.
  const contextual = src.split(/webTextWidgetClassification\([^)]*,/).length - 1;
  assert.equal(contextual, 2, `expected 2 context-passing call sites, found ${contextual}`);
});

check("the_referee_is_the_single_definition", () => {
  const widget = fs.readFileSync("services/api/src/domain/webTextWidget.ts", "utf8");
  assert.ok(
    widget.includes("decideWebTextWidgetSalesClassification"),
    "webTextWidget.ts no longer delegates to the referee — the department mapping has been forked"
  );
});

if (failures.length) {
  console.error(`web_text_widget_seller_bucket:eval FAILED (${failures.length})`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`web_text_widget_seller_bucket:eval PASS (${rows.length} decision rows + 14 execution checks)`);
