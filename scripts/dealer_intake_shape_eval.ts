/**
 * Intake-shape harness eval (2026-07-30).
 *
 * Pins the HARNESS's logic, not any dealer's data — so it is per-dealer-gate safe and runs
 * with no network and no LLM. The thing being protected is the harness's honesty: a
 * shape-variance report that quietly rounds "we didn't parse it" up to "handled" is worse
 * than no report, because it would license onboarding a dealer whose feed we can't read.
 *
 * What it pins:
 *   1. The three real parsers are still reachable and still handle OUR canonical shapes
 *      (a regression here means the harness has gone blind, not that a dealer changed).
 *   2. A known-unsupported shape is reported AS unsupported, with the missing field named.
 *   3. Grading separates a capability GAP from a cross-dealer LEAK, and a leak can never
 *      be counted as a gap (that is the one class that must never be softened).
 *   4. `supported` counts only variants whose required fields all survived — a variant
 *      that threw is unsupported, never skipped.
 *   5. The dealer's-eye rule for product links: "correctly produced no link" is NOT
 *      "handled" when the dealer was supposed to get a link.
 */
import assert from "node:assert/strict";
import {
  gradeIntakeShape,
  runAdfVariants,
  runFeedVariants,
  runLinkVariants,
  type VariantResult
} from "./dealer_intake_shape_test.ts";

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

const adf = runAdfVariants();
const feed = runFeedVariants();
const links = runLinkVariants();
const all = [...adf, ...feed, ...links];
const byId = (rows: VariantResult[], id: string) => {
  const row = rows.find(r => r.id === id);
  if (!row) throw new Error(`variant "${id}" is missing from the suite`);
  return row;
};

// --- 1. The parsers are reachable and still read our own shapes. -------------
check("adf_canonical_parses", "the standard ADF shape still parses end to end", () => {
  const row = byId(adf, "canonical");
  assert.equal(row.supported, true, `canonical ADF must parse: ${row.error ?? row.missingRequired.join(", ")}`);
  for (const field of ["firstName", "email", "phone", "year", "vehicleMake", "vehicleModel"]) {
    assert.ok(
      row.fields.find(f => f.field === field)?.present,
      `${field} should have been extracted from the canonical ADF`
    );
  }
});

check("feed_canonical_parses", "our own feed schema still parses end to end", () => {
  const row = byId(feed, "canonical_inventory_item");
  assert.equal(row.supported, true, `canonical feed must parse: ${row.error ?? row.missingRequired.join(", ")}`);
  for (const field of ["stockId", "year", "make", "model", "color", "price"]) {
    assert.ok(row.fields.find(f => f.field === field)?.present, `${field} should have been extracted`);
  }
});

check("link_canonical_resolves", "our own product-link convention still resolves", () => {
  const row = byId(links, "relative_numeric_path");
  assert.equal(row.supported, true, `our link convention must resolve: ${row.error ?? ""}`);
});

// --- 2. Shapes the feed-tolerance work fixed stay fixed. --------------------
// These three were gaps when this harness was written and are now handled. They are pinned
// as SUPPORTED so the tolerance work in inventoryFeed.parseFeed can't silently regress.
// (Lesson from the run that caught this: the original checks asserted "this shape is
// broken", which made them fail the moment the shape was fixed. Pin the capability, or —
// for the honesty property — pin it against a shape that is unreadable BY CONSTRUCTION.)
check("feed_attribute_style_now_supported", "attribute-style feed fields resolve", () => {
  const row = byId(feed, "attribute_style_fields");
  assert.equal(row.supported, true, `attribute-style fields must resolve: ${row.error ?? row.missingRequired.join(", ")}`);
  for (const field of ["stockId", "year", "make", "model"]) {
    assert.ok(row.fields.find(f => f.field === field)?.present, `${field} should resolve from an attribute`);
  }
});

check("feed_name_value_now_supported", "a generic name/value row resolves", () => {
  const row = byId(feed, "nested_attribute_list");
  assert.equal(row.supported, true, `name/value rows must resolve: ${row.error ?? row.missingRequired.join(", ")}`);
});

check("feed_vehicle_container_now_supported", "<vehicles><vehicle> rows are found", () => {
  const row = byId(feed, "vehicle_element_name");
  assert.equal(row.supported, true, `vehicle-named rows must be found: ${row.error ?? row.missingRequired.join(", ")}`);
});

check("feed_stock_alias_now_supported", "<stock_number> yields the stock number", () => {
  const row = byId(feed, "stock_number_alias");
  assert.equal(row.supported, true, `stock_number must resolve: ${row.error ?? row.missingRequired.join(", ")}`);
});

// --- 2b. The honesty property, pinned against an unreadable-by-construction shape. ---
check("feed_unknown_container_is_reported", "an unrecognized row element reports zero rows, not a silent pass", () => {
  const row = byId(feed, "unknown_container");
  assert.equal(row.supported, false, "a container we don't know must never report as handled");
  assert.match(String(row.error), /no rows/i, "the report must say the container wasn't recognized");
  for (const field of ["stockId", "year", "make", "model"]) {
    assert.ok(row.missingRequired.includes(field), `${field} must be named as missing so the report is actionable`);
  }
});

check("adf_capitalized_is_reported_unsupported", "capitalized ADF elements report as a gap", () => {
  const row = byId(adf, "capitalized_elements");
  assert.equal(row.supported, false, "XML is case-sensitive; this must not report as handled");
  assert.ok(row.missingRequired.length > 0, "the missing fields must be named");
});

// --- 3. A leak is never counted as a gap. ------------------------------------
check("foreign_host_is_refused", "a foreign dealer's inventory URL yields no link", () => {
  const row = byId(links, "foreign_host_inventory_path");
  assert.equal(row.safetyCritical, true, "this variant must be marked safety-critical");
  assert.equal(row.supported, true, `refusing a foreign host is correct behavior: ${row.error ?? ""}`);
  assert.ok(
    !row.fields.find(f => f.field === "productUrl")?.present,
    "no product URL may be built from another dealer's host"
  );
});

check("leak_is_not_a_gap", "a safety-critical failure is counted separately from capability gaps", () => {
  const leak: VariantResult = {
    surface: "product_link",
    id: "synthetic_leak",
    label: "synthetic",
    realWorld: "synthetic",
    supported: false,
    fields: [],
    missingRequired: ["onDealerHost"],
    error: "built a link on a foreign host",
    safetyCritical: true
  };
  const gap: VariantResult = {
    surface: "feed",
    id: "synthetic_gap",
    label: "synthetic",
    realWorld: "synthetic",
    supported: false,
    fields: [],
    missingRequired: ["stockId"]
  };
  const graded = gradeIntakeShape([leak, gap], "2026-07-30T00:00:00.000Z");
  assert.equal(graded.safetyFailures.length, 1, "the leak must land in safetyFailures");
  assert.equal(graded.gaps.length, 1, "the gap must land in gaps");
  assert.equal(graded.gaps[0].id, "synthetic_gap", "a leak must never be filed as a gap");
  assert.equal(graded.safetyFailures[0].id, "synthetic_leak");
  assert.equal(graded.supported, 0);
});

// --- 4. Grading counts only genuine passes. ---------------------------------
check("thrown_variant_is_unsupported", "a variant that threw counts as unsupported, never skipped", () => {
  const thrown: VariantResult = {
    surface: "adf",
    id: "synthetic_throw",
    label: "synthetic",
    realWorld: "synthetic",
    supported: false,
    fields: [],
    missingRequired: ["firstName"],
    error: "kaboom"
  };
  const graded = gradeIntakeShape([thrown], "2026-07-30T00:00:00.000Z");
  assert.equal(graded.total, 1, "it must still be counted in the denominator");
  assert.equal(graded.supported, 0);
  assert.equal(graded.gaps.length, 1);
});

check("surface_totals_add_up", "per-surface counts match the variant list", () => {
  const graded = gradeIntakeShape(all, "2026-07-30T00:00:00.000Z");
  const sum = Object.values(graded.bySurface).reduce((acc, b) => acc + b.total, 0);
  assert.equal(sum, all.length, "every variant must be counted in exactly one surface");
  assert.equal(
    graded.supported + graded.gaps.length + graded.safetyFailures.length,
    all.length,
    "supported + gaps + leaks must account for every variant"
  );
  for (const surface of ["adf", "feed", "product_link"]) {
    assert.ok(graded.bySurface[surface]?.total > 0, `${surface} must have variants`);
  }
});

// --- 5. The dealer's-eye rule for links. ------------------------------------
check("no_link_is_not_handled", "a convention that yields no product link is NOT counted as handled", () => {
  // The flattery this prevents: the code "correctly" returns null for a slug-only URL, but
  // a dealer on that platform gets no links at all — from their seat the feature is broken.
  for (const id of ["slug_only_path", "query_param_id"]) {
    const row = byId(links, id);
    assert.equal(row.supported, false, `${id} yields no link, so it must not read as handled`);
    assert.ok(row.missingRequired.includes("productUrl"), `${id} must name productUrl as missing`);
  }
});

check("gap_carries_plain_language_context", "every gap explains what a real vendor doing this looks like", () => {
  const graded = gradeIntakeShape(all, "2026-07-30T00:00:00.000Z");
  assert.ok(graded.gaps.length > 0, "the suite should currently surface gaps — a zero here means it went blind");
  for (const gap of graded.gaps) {
    assert.ok(
      gap.realWorld && gap.realWorld.length > 20,
      `gap ${gap.id} needs a plain-language realWorld note so the report is readable`
    );
    assert.ok(gap.label && gap.label.length > 5, `gap ${gap.id} needs a human label`);
  }
});

const failed = checks.filter(c => !c.ok);
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.id} — ${c.note}`);
console.log(`\ndealer_intake_shape:eval — ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  console.error(`\n${failed.length} check(s) failed`);
  process.exit(1);
}
