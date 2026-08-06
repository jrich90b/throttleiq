/**
 * Conditioned bike reference eval (pure, no LLM).
 *
 * A customer was told, on 2026-08-06:
 *   "I'll have our team check the current price on **the new that bike** and follow up with exact
 *    numbers."
 *
 * `bikeLabel` falls back to the literal words "that bike" when neither year nor model resolved, and
 * both pricing lines glued a condition word and a definite article in front of it. The priced branch
 * had the same defect — "The listed price on the new that bike is $21,495" — so fixing only the
 * deferral line would have left the worse one in place.
 *
 * The rule: the condition and the article only make sense once we can NAME the unit.
 *
 * Run: npx tsx scripts/conditioned_bike_reference_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { formatConditionedBikeReference } from "../services/api/src/domain/orchestrator.ts";

const cases: [string, string, string, string][] = [
  ["new ", "2019 Street Glide", "the new 2019 Street Glide", "named unit keeps the condition and the article"],
  ["used ", "2019 Street Glide", "the used 2019 Street Glide", "same for used"],
  ["", "2019 Street Glide", "the 2019 Street Glide", "no condition on the lead — still a normal reference"],
  ["new ", "that bike", "that bike", "THE BUG: an unnamed unit must not become 'the new that bike'"],
  ["used ", "that bike", "that bike", "same for used"],
  ["", "that bike", "that bike", "unchanged when there is no condition to glue on"],
  ["new ", "", "that bike", "an empty label is an unnamed unit, not 'the new '"],
  ["new ", "   ", "that bike", "whitespace is not a model name"]
];

for (const [prefix, label, want, why] of cases) {
  const got = formatConditionedBikeReference(prefix, label);
  assert.equal(got, want, `formatConditionedBikeReference(${JSON.stringify(prefix)}, ${JSON.stringify(label)}) → ${JSON.stringify(got)}, expected ${JSON.stringify(want)} — ${why}`);
}

// The sentences a customer actually reads.
assert.equal(
  `I'll have our team check the current price on ${formatConditionedBikeReference("new ", "that bike")} and follow up with exact numbers.`,
  "I'll have our team check the current price on that bike and follow up with exact numbers.",
  "the deferral line must read as English"
);
assert.equal(
  `The listed price on ${formatConditionedBikeReference("new ", "that bike")} is $21,495.`,
  "The listed price on that bike is $21,495.",
  "the PRICED line had the same defect — it must be fixed too, not just the deferral"
);

// Neither pricing line may go back to gluing the prefix straight onto the label.
const orchestrator = fs.readFileSync("services/api/src/domain/orchestrator.ts", "utf8");
assert.ok(
  !/\$\{leadConditionPrefix\}\$\{bikeLabel\}/.test(orchestrator),
  "a pricing line is concatenating the condition prefix onto bikeLabel again — route it through formatConditionedBikeReference"
);

console.log(
  `PASS conditioned bike reference eval — ${cases.length} label cases + both customer-facing pricing sentences + no raw concatenation`
);
