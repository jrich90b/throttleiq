/**
 * Post-sale placeholder-model eval (deterministic — no LLM).
 *
 * Pins that ADF placeholder vehicles ("Harley-Davidson Full Line", "Other") can never leak
 * into post-sale check-in copy. Origin: Kody (+17163975098, 2026-07) bought a bike from a
 * Traffic Log Pro ADF whose Vehicle field was the placeholder "Harley-Davidson Full Line";
 * the post-sale check-in texted "Thanks again for coming to see us for your Full Line."
 *
 * resolvePostSaleModelLabel (postSaleCadence.ts) screens every candidate (sale.label,
 * joined sale fields, lead.vehicle.model, description) through isPlaceholderModel — the
 * same invariant helper every other placeholder surface uses — both raw and after display
 * normalization, falling back to the generic "bike" (the established rendering for unknown
 * models, Joe 2026-06-21). Fail direction is SAFE: a false-positive placeholder call only
 * softens copy to "your bike"; a false negative is the junk-leak bug itself.
 */
import assert from "node:assert/strict";
import {
  resolvePostSaleModelLabel,
  postSaleAccessoryOrEnjoyMessage
} from "../services/api/src/domain/postSaleCadence.ts";

// Mimics the shape of index.ts's normalizeModelForPostSale for the paths that matter here:
// strips years + the make prefix, collapses whitespace. This is exactly why the raw-only
// screen was insufficient — "Harley-Davidson Full Line" normalizes to a plausible-looking
// "Full Line", so the post-normalize screen must also run.
const normalize = (raw: string) =>
  raw
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/\bharley[-\s]?davidson\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

// --- The exact production shape (+17163975098): every candidate is the placeholder ---
const kody = {
  sale: {
    soldAt: "2026-07-17T19:45:38.861Z",
    soldByName: "Scott Hartrich",
    label: "2026 Harley-Davidson Harley-Davidson Full Line"
  },
  lead: {
    vehicle: {
      make: "Harley-Davidson",
      year: "2026",
      model: "Harley-Davidson Full Line",
      description: "Harley-Davidson Full Line",
      condition: "new_model_interest"
    }
  }
};
assert.equal(
  resolvePostSaleModelLabel(kody, normalize),
  "bike",
  "TLP 'Full Line' placeholder ADF => generic 'bike', never the placeholder"
);

// The check-in templates built from that label must never contain the junk.
const bikeModel = resolvePostSaleModelLabel(kody, normalize);
const templates = [
  `Hi Kody — this is Scott at American Harley-Davidson. Thanks again for coming to see us for your ${bikeModel}. If you need anything, just let me know.`,
  `Hi Kody — this is Scott at American Harley-Davidson. Congrats on your ${bikeModel}! If you need anything, just let me know.`,
  postSaleAccessoryOrEnjoyMessage({
    firstName: "Kody",
    repName: "Scott",
    dealerName: "American Harley-Davidson",
    bikeModel,
    isNewBike: false
  }),
  `Hi Kody — Scott at American Harley-Davidson. Happy 1-year anniversary with your ${bikeModel}. If you’re ever thinking about trading in, let me know.`
];
for (const t of templates) {
  assert.ok(!/full\s*line/i.test(t), `post-sale template must not contain 'Full Line': ${t}`);
  assert.ok(!/\byour Other\b|\bthe Other\b/.test(t), `post-sale template must not contain 'Other': ${t}`);
}

// --- Other placeholder families ---
assert.equal(
  resolvePostSaleModelLabel({ sale: { label: "Harley-Davidson Other" } }, normalize),
  "bike",
  "'Harley-Davidson Other' => bike"
);
assert.equal(
  resolvePostSaleModelLabel({ lead: { vehicle: { model: "Other" } } }, normalize),
  "bike",
  "bare 'Other' lead vehicle => bike"
);
assert.equal(
  resolvePostSaleModelLabel({ sale: { label: "2025 Harley-Davidson" } }, normalize),
  "bike",
  "make-only label (normalizes to empty) => bike"
);
assert.equal(resolvePostSaleModelLabel({}, normalize), "bike", "no candidates at all => bike");

// --- Placeholder sale label must NOT mask a real model further down the candidate list ---
assert.equal(
  resolvePostSaleModelLabel(
    {
      sale: { label: "Harley-Davidson Full Line" },
      lead: { vehicle: { model: "Road Glide" } }
    },
    normalize
  ),
  "Road Glide",
  "placeholder sale label falls through to the real lead vehicle model"
);

// --- Real labels pass through unchanged (behavior preserved from the inline resolver) ---
assert.equal(
  resolvePostSaleModelLabel({ sale: { label: "2025 Harley-Davidson Street Glide" } }, normalize),
  "Street Glide",
  "real sale label => normalized model"
);
assert.equal(
  resolvePostSaleModelLabel(
    { sale: { year: 2024, make: "Harley-Davidson", model: "Low Rider S" } },
    normalize
  ),
  "Low Rider S",
  "joined sale fields => normalized model"
);
assert.equal(
  resolvePostSaleModelLabel({ lead: { vehicle: { model: "Fat Boy" } } }, normalize),
  "Fat Boy",
  "lead vehicle model fallback => model"
);

console.log("post_sale_model_placeholder_eval: PASS");
