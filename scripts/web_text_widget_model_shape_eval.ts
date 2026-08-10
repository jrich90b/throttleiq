/**
 * web_text_widget_model_shape:eval — a bike name pulled out of a widget message is a bike name,
 * not the rest of the customer's sentence.
 *
 * THE REPRODUCED MISS. Dalton Magill (+17165741407) wrote, through the Sales widget on 2026-06-17,
 * with no punctuation anywhere in the message:
 *   "I have a buddy interested in the 2013 black street glide was wondering how much you guys are
 *    listing it"
 * The requested-vehicle regex ends a capture at [.!?] or a following "i have/can/will/would". That
 * sentence offers neither, so the capture ran to the end of the message and his record was written
 * with lead.vehicle.model AND conv.inventoryContext.model both set to
 *   "Black Street Glide Was Wondering How Much You Guys Are Listing It"
 * — still the stored value on the live record when this was built. That is draft context the widget
 * ack narrates straight back at the customer, and a model string no inventory lookup or marketing
 * list can ever match. He was answered correctly by a person that evening, so this particular lead
 * came to no harm; the class is what is fixed here.
 *
 * Same family as the "Outright" phantom that #626 fixed for Beverly Hennig (+17169839279): the
 * deterministic extractor confidently mints a bike out of ordinary words. #626 fixed it by letting
 * the typed parser's SELL-side verdict win. This fixes the other half — the shape of the slot
 * itself, on the buy side, where there is no sell-side verdict to appeal to.
 *
 * THE BOUND, AND WHY SIX. Measured against every WEB TEXT WIDGET inbound in the live store
 * (30 messages, 2026-08-09): every legitimate free-text capture is 1-3 words ("Wide Glide",
 * "Iron 1200", "Klock Werks Windshield"); the single run-on is 12. Nothing lands in between, so the
 * bound sits in the middle of a wide measured gap rather than on a cliff edge. Six is twice the
 * largest real capture and half the run-on.
 *
 * WHAT IS PINNED. All of it by EXECUTION against the real corpus — a source-text assertion could
 * not tell any of these apart:
 *   (a) Dalton's REAL body yields no requested vehicle, and the SAME sentence trimmed to a
 *       model-shaped phrase still does. That pairing is the point: it proves the bound is what
 *       rejects the run-on, not the regex quietly having stopped matching.
 *   (b) The whole 30-message corpus still produces its slot table exactly
 *       (scripts/fixtures/web_text_widget_vehicle_slots.json). Eight requested vehicles and four
 *       trades survive unchanged; only Dalton's run-on is dropped.
 *   (c) The boundary itself: six words in, seven words out.
 *   (d) The trade slot is bounded too — both slots run through the one helper.
 *
 * The golden table is a REGRESSION pin, not an endorsement. Four of the eight survivors are still
 * poor ("Motorcycles", "Or New Trike", "Harley Factory Racing", and Beverly's "Outright", which the
 * #626 referee drops downstream). They are short, so this bound is not the tool for them, and
 * widening it to catch them would trade a measured fix for a guess.
 *
 * Run: npx tsx scripts/web_text_widget_model_shape_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  extractWebTextWidgetSalesVehicleContext,
  buildWebTextWidgetInboundBody
} from "../services/api/src/domain/webTextWidget.ts";

const failures: string[] = [];
const check = (id: string, fn: () => void) => {
  try {
    fn();
  } catch (err) {
    failures.push(`${id}: ${(err as Error).message}`);
  }
};

type Slots = {
  requestedVehicle: { year?: string; model?: string; color?: string; condition?: string } | null;
  tradeVehicle: { year?: string; model?: string; color?: string; condition?: string } | null;
  sellOption: string | null;
};

const fixture = JSON.parse(
  fs.readFileSync(path.resolve("scripts/fixtures/web_text_widget_vehicle_slots.json"), "utf8")
) as { rows: { lead: string; body: string; expected: Slots }[] };

const slotsOf = (body: string): Slots => {
  const ctx = extractWebTextWidgetSalesVehicleContext(body);
  return {
    requestedVehicle: ctx?.requestedVehicle ?? null,
    tradeVehicle: ctx?.tradeVehicle ?? null,
    sellOption: ctx?.sellOption ?? null
  };
};

/** A widget body in the shape the live intake builds, so these cases exercise the real reader. */
const widgetBody = (message: string, pageTitle = "Harley-Davidson Motorcycles For Sale Near Buffalo, NY.") =>
  buildWebTextWidgetInboundBody({
    department: "Sales",
    name: "Test Customer",
    pageTitle,
    pageUrl: "https://example.test/inventory",
    message
  });

// ---------------------------------------------------------------------------
// (a) The reproduced miss, and its control.
// ---------------------------------------------------------------------------

const DALTON = fixture.rows.find(r => r.lead.includes("7165741407"));

check("daltons_real_body_is_in_the_corpus", () => {
  assert.ok(DALTON, "the +17165741407 widget body is missing from the fixture");
  assert.match(
    DALTON!.body,
    /was wondering how much you guys are listing it/i,
    "the fixture no longer carries the run-on sentence this eval exists for"
  );
  assert.ok(
    !/[.!?]/.test(DALTON!.body.split(/\nMessage:\s*/i)[1] ?? ""),
    "the run-on depends on the message having no sentence-ending punctuation"
  );
});

check("the_run_on_no_longer_mints_a_bike", () => {
  const slots = slotsOf(DALTON!.body);
  assert.equal(
    slots.requestedVehicle,
    null,
    `the run-on is still being stored as a bike: ${JSON.stringify(slots.requestedVehicle)}`
  );
});

check("the_same_sentence_shaped_like_a_model_still_extracts", () => {
  // The CONTROL for the case above. Same lead-in, same lack of punctuation, same regex — only the
  // length differs. If this stops extracting, the bound is over-reaching (or the regex broke) and
  // the assertion above would pass for the wrong reason.
  // "Black" stays in the model because the regex offers its colour alternative BEFORE the year and
  // Dalton wrote them the other way round ("2013 black street glide"). That bleed is pre-existing
  // and cosmetic, and pinning the real value here keeps this control honest rather than aspirational.
  const slots = slotsOf(widgetBody("I have a buddy interested in the 2013 black street glide"));
  assert.equal(slots.requestedVehicle?.model, "Black Street Glide", JSON.stringify(slots.requestedVehicle));
  assert.equal(slots.requestedVehicle?.year, "2013");
});

// ---------------------------------------------------------------------------
// (b) The whole real corpus still produces its slot table.
// ---------------------------------------------------------------------------

check("the_live_widget_corpus_is_unchanged", () => {
  assert.equal(fixture.rows.length, 30, `expected the captured 30-message corpus, got ${fixture.rows.length}`);
  const drift: string[] = [];
  for (const row of fixture.rows) {
    const got = slotsOf(row.body);
    if (JSON.stringify(got) !== JSON.stringify(row.expected)) {
      drift.push(`${row.lead}: expected ${JSON.stringify(row.expected)}, got ${JSON.stringify(got)}`);
    }
  }
  assert.deepEqual(drift, [], `the slot table moved on ${drift.length} real widget lead(s)`);
});

check("the_corpus_still_carries_the_slots_worth_keeping", () => {
  // Guards the assertion above against a fixture that quietly emptied out: an all-null table would
  // match an extractor that had stopped working entirely.
  const requested = fixture.rows.filter(r => r.expected.requestedVehicle).length;
  const trades = fixture.rows.filter(r => r.expected.tradeVehicle).length;
  assert.equal(requested, 8, `expected 8 surviving requested vehicles, fixture has ${requested}`);
  assert.equal(trades, 4, `expected 4 surviving trade vehicles, fixture has ${trades}`);
});

// ---------------------------------------------------------------------------
// (c) The boundary.
// ---------------------------------------------------------------------------

check("six_words_is_in_and_seven_is_out", () => {
  const six = slotsOf(widgetBody("Looking for a Road Glide Special Anniversary Limited Edition."));
  assert.equal(
    six.requestedVehicle?.model,
    "Road Glide Special Anniversary Limited Edition",
    `a six-word model must survive: ${JSON.stringify(six.requestedVehicle)}`
  );

  const seven = slotsOf(widgetBody("Looking for a Road Glide Special Anniversary Limited Edition Custom."));
  assert.equal(
    seven.requestedVehicle,
    null,
    `a seven-word capture must be rejected: ${JSON.stringify(seven.requestedVehicle)}`
  );
});

// ---------------------------------------------------------------------------
// (d) The trade slot goes through the same helper.
// ---------------------------------------------------------------------------

check("a_real_trade_still_extracts", () => {
  const slots = slotsOf(widgetBody("I want to buy the 2000 wide glide. I have a 2025 road king special to trade"));
  assert.equal(slots.tradeVehicle?.model, "Road King Special", JSON.stringify(slots.tradeVehicle));
});

check("a_run_on_trade_is_bounded_too", () => {
  const slots = slotsOf(
    widgetBody("I have a 2025 road king special sitting in my garage under a cover most of the year")
  );
  assert.equal(
    slots.tradeVehicle,
    null,
    `the trade slot took a whole clause as a model: ${JSON.stringify(slots.tradeVehicle)}`
  );
});

// ---------------------------------------------------------------------------
// (e) The bound belongs to the free-text reader only.
// ---------------------------------------------------------------------------

check("the_bound_is_scoped_to_the_free_text_reader", () => {
  const src = fs.readFileSync("services/api/src/domain/webTextWidget.ts", "utf8");
  // EXPECTED COUNT: exactly one place applies the bound — parseVehicleFromMatch, the helper both
  // free-text slots share. A second occurrence would mean the page-title reader (whose catalog
  // titles are legitimately long, e.g. "Ultra Limited Peace Officer / Firefighter / Shrine Special
  // Edition") had been bounded too.
  const applied = src.split("MAX_FREE_TEXT_MODEL_WORDS").length - 1;
  assert.equal(applied, 2, `expected the bound declared once and applied once, found ${applied} mentions`);
  const titleReader = src.slice(src.indexOf("function extractVehicleFromWidgetPageTitle"));
  const titleBody = titleReader.slice(0, titleReader.indexOf("\n}\n"));
  assert.ok(
    !titleBody.includes("MAX_FREE_TEXT_MODEL_WORDS"),
    "the page-title reader must not be word-bounded — catalog titles are legitimately long"
  );
});

if (failures.length) {
  console.error(`web_text_widget_model_shape:eval FAILED (${failures.length})`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(
  `web_text_widget_model_shape:eval PASS (${fixture.rows.length} real widget bodies + 8 execution checks)`
);
