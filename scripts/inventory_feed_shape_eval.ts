/**
 * Inventory-feed shape-tolerance eval (dealer portability, 2026-07-30).
 *
 * Pins `parseFeed`'s vendor tolerance and — more importantly — the PRECEDENCE RULE that
 * makes it safe: a canonical child element always wins over an alias, an attribute, or a
 * name/value entry. That rule is the whole reason adding tolerance cannot change how an
 * existing dealer's feed parses. (Complementary evidence, recorded in the PR rather than
 * here: the live 72-row americanharley feed parsed byte-for-byte identically before and
 * after. It is dealer data, so it is not committed as a fixture — which is exactly why the
 * RULE is pinned here instead.)
 *
 * Also pins the DELIBERATE EXCLUSIONS, each of which is a way this could quietly go wrong:
 * a vendor row id must not become a stock number, prose must not become a model, and a
 * body-type must not become the new/used condition. A wrong value is worse than a missing
 * one — it reaches a customer as a confident, false claim.
 *
 * Fixtures are fictional. Element NAMES are shared vendor vocabulary, not dealer facts, so
 * this stays universal-tier safe.
 */
import assert from "node:assert/strict";
import { FEED_FIELD_ALIASES, field, parseFeed, pickFeedRows } from "../services/api/src/domain/inventoryFeed.ts";

type Check = { id: string; ok: boolean; note: string };
const checks: Check[] = [];
const check = (id: string, note: string, fn: () => void) => {
  try {
    fn();
    checks.push({ id, ok: true, note });
  } catch (err) {
    checks.push({ id, ok: false, note: `${note} — ${err instanceof Error ? err.message : String(err)}` });
  }
};

const one = (xml: string) => {
  const rows = parseFeed(xml);
  assert.equal(rows.length, 1, `expected exactly one row, got ${rows.length}`);
  return rows[0] as any;
};

// --- The shape a working feed already has: unchanged. -----------------------
check("canonical_shape_unchanged", "a conventional feed row parses exactly as before", () => {
  const row = one(`<inventory><item>
    <id>684137</id>
    <stocknumber>Z9001</stocknumber><vin>1HD1KRM12PB600001</vin>
    <year>2026</year><make>Harley-Davidson</make><model>Road Glide</model>
    <color>Vivid Black</color><condition>new</condition>
    <url>https://example-dealer.example.com/inventory/12345/road-glide</url>
    <price>28999</price><miles>12</miles>
  </item></inventory>`);
  assert.equal(row.stockId, "Z9001");
  assert.equal(row.vin, "1HD1KRM12PB600001");
  assert.equal(row.year, "2026");
  assert.equal(row.make, "Harley-Davidson");
  assert.equal(row.model, "Road Glide");
  assert.equal(row.color, "Vivid Black");
  assert.equal(row.condition, "new");
  assert.equal(row.price, 28999);
  assert.equal(row.mileage, 12);
});

// --- Precedence: the canonical name always wins. ---------------------------
check("element_beats_alias", "a canonical child element wins over an alias", () => {
  const row = one(`<inventory><item>
    <stocknumber>CANONICAL</stocknumber><stock_number>ALIAS</stock_number>
    <year>2026</year><make>Harley-Davidson</make><model>Road Glide</model>
  </item></inventory>`);
  assert.equal(row.stockId, "CANONICAL", "the established element name must keep winning");
});

check("element_beats_attribute", "a child element wins over an attribute of the same name", () => {
  const row = one(`<inventory><item year="1999">
    <stocknumber>Z9001</stocknumber><year>2026</year>
    <make>Harley-Davidson</make><model>Road Glide</model>
  </item></inventory>`);
  assert.equal(row.year, "2026", "an attribute must never override the child element");
});

check("alias_beats_attribute", "an alias element still wins over an attribute", () => {
  const row = one(`<inventory><item stocknumber="FROM_ATTR">
    <stock_number>FROM_ALIAS</stock_number>
    <year>2026</year><make>Harley-Davidson</make><model>Road Glide</model>
  </item></inventory>`);
  assert.equal(row.stockId, "FROM_ALIAS", "all elements are tried before any attribute");
});

check("blank_value_does_not_win", "an empty canonical element falls through to a real value", () => {
  const row = one(`<inventory><item>
    <stocknumber>   </stocknumber><stock_number>Z9001</stock_number>
    <year>2026</year><make>Harley-Davidson</make><model>Road Glide</model>
  </item></inventory>`);
  assert.equal(row.stockId, "Z9001", "a blank must not shadow a populated alias");
});

// --- The shapes that used to lose data. -----------------------------------
check("stock_number_alias_resolves", "<stock_number> now yields the stock number", () => {
  const row = one(`<inventory><item>
    <stock_number>Z9001</stock_number>
    <year>2026</year><make>Harley-Davidson</make><model>Road Glide</model>
  </item></inventory>`);
  assert.equal(row.stockId, "Z9001");
});

check("attribute_style_row_resolves", "fields expressed as attributes now resolve", () => {
  const row = one(
    `<inventory><item stocknumber="Z9001" vin="1HD1KRM12PB600001" year="2026" make="Harley-Davidson" model="Road Glide" color="Vivid Black" price="28999" /></inventory>`
  );
  assert.equal(row.stockId, "Z9001");
  assert.equal(row.year, "2026");
  assert.equal(row.make, "Harley-Davidson");
  assert.equal(row.model, "Road Glide");
  assert.equal(row.color, "Vivid Black");
  assert.equal(row.price, 28999);
});

check("name_value_pairs_resolve", "a generic <attribute name=\"...\"> list now resolves", () => {
  const row = one(`<inventory><item>
    <attribute name="stocknumber">Z9001</attribute>
    <attribute name="year">2026</attribute>
    <attribute name="make">Harley-Davidson</attribute>
    <attribute name="model">Road Glide</attribute>
    <attribute name="color">Vivid Black</attribute>
  </item></inventory>`);
  assert.equal(row.stockId, "Z9001");
  assert.equal(row.year, "2026");
  assert.equal(row.model, "Road Glide");
  assert.equal(row.color, "Vivid Black");
});

check("british_colour_resolves", "<colour> now yields a colour", () => {
  const row = one(`<inventory><item>
    <stocknumber>Z9001</stocknumber><year>2026</year><make>Harley-Davidson</make><model>Road Glide</model>
    <colour>Vivid Black</colour>
  </item></inventory>`);
  assert.equal(row.color, "Vivid Black");
});

check("us_color_still_wins_over_colour", "<color> beats <colour> when a feed carries both", () => {
  const row = one(`<inventory><item>
    <stocknumber>Z9001</stocknumber><year>2026</year><make>Harley-Davidson</make><model>Road Glide</model>
    <color>Vivid Black</color><colour>Teal Thunder</colour>
  </item></inventory>`);
  assert.equal(row.color, "Vivid Black");
});

// --- Row containers. ------------------------------------------------------
for (const [id, xml] of [
  ["inventory_item", `<inventory><item><stocknumber>Z1</stocknumber><year>2026</year><make>H-D</make><model>Road Glide</model></item></inventory>`],
  ["items_item", `<items><item><stocknumber>Z1</stocknumber><year>2026</year><make>H-D</make><model>Road Glide</model></item></items>`],
  ["vehicles_vehicle", `<vehicles><vehicle><stocknumber>Z1</stocknumber><year>2026</year><make>H-D</make><model>Road Glide</model></vehicle></vehicles>`],
  ["units_unit", `<units><unit><stocknumber>Z1</stocknumber><year>2026</year><make>H-D</make><model>Road Glide</model></unit></units>`],
  ["listings_listing", `<listings><listing><stocknumber>Z1</stocknumber><year>2026</year><make>H-D</make><model>Road Glide</model></listing></listings>`]
] as const) {
  check(`container:${id}`, `rows named "${id}" are found`, () => {
    const row = one(xml);
    assert.equal(row.stockId, "Z1", "the row must be discovered and parsed");
    assert.equal(row.model, "Road Glide");
  });
}

check("item_container_wins", "the established <item> container is preferred when both exist", () => {
  const rows = parseFeed(
    `<inventory><item><stocknumber>FROM_ITEM</stocknumber></item><vehicle><stocknumber>FROM_VEHICLE</stocknumber></vehicle></inventory>`
  );
  assert.equal(rows.length, 1);
  assert.equal((rows[0] as any).stockId, "FROM_ITEM", "adding containers must not reorder an existing feed");
});

check("unknown_container_is_empty_not_a_throw", "an unrecognized document yields no rows rather than crashing", () => {
  assert.deepEqual(parseFeed(`<catalog><thing><stocknumber>Z1</stocknumber></thing></catalog>`), []);
  assert.deepEqual(pickFeedRows({}), []);
});

// --- The deliberate exclusions. Each is a wrong-value hazard. -------------
check("vendor_row_id_is_not_a_stock_number", "<id> must never become the stock number", () => {
  const row = one(`<inventory><item>
    <id>684137</id><year>2026</year><make>Harley-Davidson</make><model>Road Glide</model>
  </item></inventory>`);
  assert.equal(row.stockId, undefined, "a vendor row id is not a stock number a customer can use");
  assert.ok(
    !(FEED_FIELD_ALIASES.stockId as readonly string[]).includes("id"),
    "`id` must stay out of the stock-number alias list"
  );
});

check("prose_is_not_a_model", "<title>/<description>/<category> must never become the model", () => {
  const row = one(`<inventory><item>
    <stocknumber>Z9001</stocknumber><year>2026</year><make>Harley-Davidson</make>
    <title>2026 Harley-Davidson Road Glide - Best Price in Town!</title>
    <description>Beautiful bike, must see</description>
    <category>Motorcycles</category>
  </item></inventory>`);
  assert.equal(row.model, undefined, "prose in `model` would corrupt watch/model matching");
  for (const forbidden of ["title", "description", "category"]) {
    assert.ok(
      !(FEED_FIELD_ALIASES.model as readonly string[]).includes(forbidden),
      `${forbidden} must stay out of the model alias list`
    );
  }
});

check("body_type_is_not_the_condition", "<type>/<status>/<certified> must never become new/used", () => {
  const row = one(`<inventory><item>
    <stocknumber>Z9001</stocknumber><year>2026</year><make>Harley-Davidson</make><model>Road Glide</model>
    <type>Motorcycle</type><status>Available</status><certified>0</certified>
  </item></inventory>`);
  assert.equal(row.condition, undefined, 'condition must stay empty rather than read "Motorcycle"');
  for (const forbidden of ["type", "status", "certified"]) {
    assert.ok(
      !(FEED_FIELD_ALIASES.condition as readonly string[]).includes(forbidden),
      `${forbidden} must stay out of the condition alias list`
    );
  }
});

// --- The helper's own contract. ------------------------------------------
check("field_handles_missing_input", "field() tolerates null/non-object rows", () => {
  assert.equal(field(null, "year"), undefined);
  assert.equal(field(undefined, "year"), undefined);
  assert.equal(field("nope" as any, "year"), undefined);
  assert.equal(field({}, "year"), undefined);
});

check("canonical_name_is_first_in_every_alias_list", "each alias list leads with the established name", () => {
  const expectedFirst: Record<string, string> = {
    stockId: "stocknumber",
    vin: "vin",
    year: "year",
    make: "make",
    model: "model",
    condition: "condition",
    url: "url"
  };
  for (const [key, first] of Object.entries(expectedFirst)) {
    const list = (FEED_FIELD_ALIASES as any)[key] as readonly string[];
    assert.equal(list[0], first, `${key} must list "${first}" first or precedence changes for existing feeds`);
  }
});

const failed = checks.filter(c => !c.ok);
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.id} — ${c.note}`);
console.log(`\ninventory_feed_shape:eval — ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  console.error(`\n${failed.length} check(s) failed`);
  process.exit(1);
}
