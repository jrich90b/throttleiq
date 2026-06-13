/**
 * Cadence held-unit model guard. Production fixture: Rhett Craft +15856048591
 * (Lead Ref 11216), 2026-06-13 — a generic "Road Glide" lead was over-resolved
 * by inventory search to a held "Road Glide 3 in Iron Horse Metallic", and the
 * cadence draft fabricated "you were interested in the 2026 Road Glide 3," the
 * wrong (more-specific) model, steering him off the Road Glide Limited his
 * salesperson was working. A cadence must not claim a held unit whose model is
 * more specific than the lead ever expressed, unless the customer referenced
 * that exact unit (stock#/VIN).
 */
import assert from "node:assert/strict";
import { cadenceHeldUnitModelConsistentWithLead } from "../services/api/src/domain/workflowRegressionGuards.ts";

const consistent = cadenceHeldUnitModelConsistentWithLead;

// The bug: generic "Road Glide" lead, held "Road Glide 3" -> must REJECT.
assert.equal(
  consistent({ unitModel: "Road Glide 3", leadModel: "Road Glide", leadDescription: "Harley-Davidson Road Glide" }),
  false,
  "generic Road Glide lead must not be claimed as a held Road Glide 3"
);

// Other over-specific variants the customer never said -> reject.
assert.equal(consistent({ unitModel: "Road Glide Limited", leadModel: "Road Glide" }), false, "not Road Glide Limited");
assert.equal(consistent({ unitModel: "Road Glide ST", leadModel: "Road Glide" }), false, "not Road Glide ST");
assert.equal(consistent({ unitModel: "Street 750", leadModel: "Street" }), false, "Street is not Street 750");

// Exact model match -> allow.
assert.equal(consistent({ unitModel: "Road Glide", leadModel: "Road Glide" }), true, "exact base model");
assert.equal(consistent({ unitModel: "Road Glide 3", leadModel: "Road Glide 3" }), true, "exact specific model");
assert.equal(
  consistent({ unitModel: "Road Glide", leadModel: "Road Glide Limited" }),
  true,
  "held base unit is within the lead's more-specific interest (no new specificity)"
);

// Customer referenced the exact unit (stock#/VIN) -> allow even if the model label differs.
assert.equal(
  consistent({ unitModel: "Road Glide 3", unitStockId: "U876-22", leadModel: "Road Glide", leadStockId: "U876-22" }),
  true,
  "customer referenced the exact stock# -> they meant this unit"
);
assert.equal(
  consistent({ unitModel: "Road Glide 3", unitVin: "1HD1ABC", leadModel: "Road Glide", leadVin: "1hd1abc" }),
  true,
  "VIN match (case-insensitive) -> they meant this unit"
);

// No expressed model -> never pin a specific unit.
assert.equal(consistent({ unitModel: "Road Glide 3", leadModel: "", leadDescription: "" }), false, "no expressed model");

// No unit model -> nothing to over-claim.
assert.equal(consistent({ unitModel: "", leadModel: "Road Glide" }), true, "no unit model to over-claim");

console.log("PASS cadence held unit model guard eval");
