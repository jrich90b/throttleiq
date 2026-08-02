/**
 * cadence_quality_sold_unit:eval — the cadence-quality judge must know what the customer BOUGHT.
 *
 * ORIGIN (live, +17168614216, judged 2026-08-01T14:30:38Z, `suppress` @0.90 — CADENCE_QUALITY_ENFORCE
 * is live, so the touch was actually withheld): the ADF inquiry was a "2024 Street Glide"; the
 * customer bought a "2025 Harley-Davidson Breakout" (`sale.label`). The post-sale check-in said
 * "...for your Breakout" — CORRECT, because resolvePostSaleModelLabel builds the copy from
 * `sale.label`. The judge, handed only the ADF vehicle, called it "inaccurate and mismatched:
 * customer came for a 2024 Street Glide (not a Breakout)" and killed it.
 *
 * A GRADER PHANTOM: the reply was right, the scorer was blind. Fail direction of the bug is
 * SILENCE toward a customer who has just bought a motorcycle.
 *
 * Deterministic (no LLM): the judge stays the typed LLM parser; what is pinned here is the pure
 * fact-assembly it is handed.
 */
import assert from "node:assert/strict";
import {
  formatCadenceQualityUnitFacts,
  resolvePurchasedUnitLabel,
  daysSinceLastCustomerReply
} from "../services/api/src/domain/cadenceQualityFacts.ts";

// --- The production turn: inquiry bike != purchased bike ---
{
  const facts = formatCadenceQualityUnitFacts({
    lead: { vehicle: { model: "Street Glide", description: "Street Glide" }, source: "Traffic Log Pro" },
    sale: { label: "2025 Harley-Davidson Breakout" }
  });
  assert.match(
    facts,
    /ACTUALLY PURCHASED: 2025 Harley-Davidson Breakout/,
    "the judge must be told the unit the customer actually bought (the origin bug: it never was)"
  );
  assert.match(facts, /Street Glide/, "the inquiry vehicle is still shown — it is context, just not authoritative");
  assert.match(
    facts,
    /do not treat that difference as a state mismatch/,
    "the purchase must be marked authoritative, or state_fit re-fails the same way on the same thread"
  );
  assert.ok(
    facts.indexOf("ACTUALLY PURCHASED") > facts.indexOf("INQUIRED about"),
    "purchase comes AFTER the inquiry line so it reads as the correction, not the lead-in"
  );
}

// --- No sale on the thread: shape is unchanged (a pre-sale nurture touch must judge exactly as before) ---
{
  const facts = formatCadenceQualityUnitFacts({
    lead: { vehicle: { model: "Road Glide" }, source: "Dealer Lead App" },
    sale: null
  });
  assert.doesNotMatch(facts, /ACTUALLY PURCHASED/, "no sale => no purchase claim invented");
  assert.equal(facts.split("\n").length, 1, "no sale => a single unit-facts line, as before this change");
  assert.match(facts, /"model":"Road Glide"/, "the inquiry vehicle keeps its long-standing JSON shape");
}

// --- Placeholder screen: a junk ADF vehicle must never be asserted as a purchase ---
// Mirrors post_sale_model_placeholder:eval — the same isPlaceholderModel screen the COPY uses, so
// the judge and the copy can never be built from different units.
for (const junk of ["Harley-Davidson Full Line", "Other", "Full Line"]) {
  assert.equal(
    resolvePurchasedUnitLabel({ label: junk }),
    null,
    `placeholder "${junk}" is not a purchased unit — telling the judge it is would trade one phantom for another`
  );
  assert.doesNotMatch(
    formatCadenceQualityUnitFacts({ lead: null, sale: { label: junk } }),
    /ACTUALLY PURCHASED/,
    `placeholder "${junk}" must not reach the judge as a purchase`
  );
}

// --- Sale with no label falls back to the joined fields (same order the post-sale copy uses) ---
{
  assert.equal(
    resolvePurchasedUnitLabel({ year: "2025", make: "Harley-Davidson", model: "Breakout" }),
    "2025 Harley-Davidson Breakout",
    "a sale recorded as discrete fields still yields the purchased unit"
  );
  assert.equal(resolvePurchasedUnitLabel(null), null, "no sale record => no purchased unit");
  assert.equal(resolvePurchasedUnitLabel({}), null, "an empty sale record => no purchased unit");
}

// --- daysSinceLastCustomerReply: behavior-identical to the inline walk it replaced in index.ts ---
{
  const now = Date.parse("2026-08-01T14:30:00.000Z");
  const conv = {
    messages: [
      { direction: "in", body: "first", at: "2026-07-20T14:30:00.000Z" },
      { direction: "in", body: "later", at: "2026-07-29T14:30:00.000Z" },
      { direction: "out", body: "our reply", at: "2026-07-31T14:30:00.000Z" }
    ]
  };
  assert.equal(daysSinceLastCustomerReply(conv, now), 3, "counts from the LAST inbound, ignoring our own outbound");
  assert.equal(
    daysSinceLastCustomerReply({ messages: [{ direction: "in", body: "", at: "2026-07-29T14:30:00.000Z" }] }, now),
    null,
    "an inbound with no body is not a reply (matches the replaced inline predicate)"
  );
  assert.equal(daysSinceLastCustomerReply({ messages: [] }, now), null, "no inbound => null, not 0");
  assert.equal(daysSinceLastCustomerReply(null, now), null, "no conversation => null");
  assert.equal(
    daysSinceLastCustomerReply({ messages: [{ direction: "in", body: "x", at: "not-a-date" }] }, now),
    null,
    "unparseable timestamp => null (never NaN into the prompt)"
  );
  assert.equal(
    daysSinceLastCustomerReply({ messages: [{ direction: "in", body: "x", at: "2026-08-02T14:30:00.000Z" }] }, now),
    0,
    "a future-stamped inbound floors at 0, never negative"
  );
}

console.log("cadence_quality_sold_unit:eval OK");
