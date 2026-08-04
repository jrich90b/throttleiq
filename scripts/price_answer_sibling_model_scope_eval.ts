/**
 * price_answer_sibling_model_scope:eval (universal, deterministic) — runs inside ci:eval.
 *
 * Joe, operator-reported 2026-08-03: "the agent gave a range on a road glide that included a CVO
 * road glide st." Reproduced against the live americanharley feed the same day —
 * `findPriceRange({ year: "2026", model: "Road Glide" })` returned $25,999–$44,999, so the
 * customer-facing line read "Prices we have listed for 2026 Road Glide run about $25,999 to
 * $44,999, depending on trim and options." The $44,999 was the CVO Road Glide ST; the Road Glide
 * Limited and the Road Glide 3 trike were in the spread too.
 *
 * Cause: `modelMatches` is deliberately DIRECTIONAL (`candidate.includes(target)`) so an ask for a
 * base model still finds units whose feed name carries extra words. Correct for "do you have one?",
 * wrong for "what does it cost?".
 *
 * Fix: both price readers scope through `unitInScopeForModelPriceAnswer`, which layers the watch
 * engine's OWN sibling test (`unitIsDistinctModelFromWatch`, Joe ruling 2026-06-30) on top of
 * modelMatches — one definition of "is it really that model", shared by the price answer and the
 * watch fire.
 *
 * Behaviour assertions + indexOf ordering only (eval source-pin ratchet).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  unitInScopeForModelPriceAnswer,
  unitIsDistinctModelFromWatch,
  narrowUnitsByColorFinish,
  modelMatches
} from "../services/api/src/domain/inventoryFeed.ts";

// (a) THE REPORTED CASE. Every sibling that inflated Joe's range is out of scope for a base ask.
assert.equal(
  unitInScopeForModelPriceAnswer("CVO Road Glide ST", "Road Glide"),
  false,
  "the CVO Road Glide ST ($44,999) must NOT price a plain Road Glide question — the reported defect"
);
assert.equal(unitInScopeForModelPriceAnswer("Road Glide Limited", "Road Glide"), false, "Road Glide Limited is a distinct model, not a trim");
assert.equal(unitInScopeForModelPriceAnswer("Road Glide Special", "Road Glide"), false, "Road Glide Special is a distinct model, not a trim");
assert.equal(
  unitInScopeForModelPriceAnswer("Road Glide 3", "Road Glide"),
  false,
  "a Road Glide 3 is a TRIKE — a three-wheeler must not price a two-wheeler question"
);
assert.equal(unitInScopeForModelPriceAnswer("Street Glide 3 Limited", "Street Glide"), false, "the trike marker applies to the Street Glide line too");

// (b) The base model still prices itself, and each sibling still prices ITSELF. The guard is
// subtractive scope, not a mute button — a customer who asks about the CVO still gets the CVO.
assert.equal(unitInScopeForModelPriceAnswer("Road Glide", "Road Glide"), true, "a Road Glide unit prices a Road Glide question");
assert.equal(unitInScopeForModelPriceAnswer("CVO Road Glide ST", "CVO Road Glide ST"), true, "asking about the CVO still gets the CVO");
assert.equal(unitInScopeForModelPriceAnswer("Road Glide Limited", "Road Glide Limited"), true, "asking about the Limited still gets the Limited");
assert.equal(unitInScopeForModelPriceAnswer("Road Glide 3", "Road Glide 3"), true, "asking about the trike still gets the trike");
assert.equal(unitInScopeForModelPriceAnswer("Street Glide", "Street Glide"), true, "unrelated line unaffected");

// (c) The trike token is TOKEN-level, so a displacement in a model name is never read as a trike.
assert.equal(unitIsDistinctModelFromWatch("Sportster 883 Low", "Sportster"), false, "883 is a displacement, not the trike marker");
assert.equal(unitIsDistinctModelFromWatch("Iron 1200", "Iron"), false, "1200 is a displacement, not the trike marker");
assert.equal(unitIsDistinctModelFromWatch("Speed 400", "Speed"), false, "400 is a displacement, not the trike marker");
assert.equal(unitIsDistinctModelFromWatch("Road Glide 3", "Road Glide"), true, "a standalone 3 IS the trike marker");

// (d) A no-model ask can never be in scope, and the guard only ever SUBTRACTS from modelMatches —
// it can narrow a quoted range toward the model asked about, never widen one.
assert.equal(unitInScopeForModelPriceAnswer("Road Glide", undefined), false, "no asked model => nothing is in scope");
assert.equal(unitInScopeForModelPriceAnswer(undefined, "Road Glide"), false, "no unit model => not in scope");
const UNITS = ["Road Glide", "Road Glide 3", "Road Glide Limited", "Road Glide Special", "CVO Road Glide ST", "Street Glide", "Street Glide 3 Limited", "Fat Boy", "Low Rider ST", "Ultra Limited", "Heritage Classic", "Iron 1200"];
const ASKS = ["Road Glide", "Street Glide", "CVO Road Glide ST", "Road Glide Limited", "Fat Boy", "Iron"];
for (const ask of ASKS) {
  for (const unit of UNITS) {
    if (unitInScopeForModelPriceAnswer(unit, ask)) {
      assert.equal(modelMatches(unit, ask), true, `scope must be a SUBSET of modelMatches — ${unit} / ${ask}`);
    }
  }
}

// (e) COLOUR / FINISH NARROWING (Joe, 2026-08-03: "what about if there is a color and a finish or
// just a color, can it narrow that down?"). The unit colours below are verbatim live 2026 Road
// Glide feed records — note the $3,400 finish spread inside one colour.
const RG_UNITS = [
  { color: "Purple Abyss Black Trim", price: 30349 },
  { color: "Dark Billiard Gray Chrome Trim", price: 25999 },
  { color: "Vivid Black Black Trim", price: 29899 },
  { color: "Midnight Ember", price: 30999 },
  { color: "Blood Orange Black Trim", price: 30149 },
  { color: "Dark Billiard Gray Black Trim", price: 29399 },
  { color: "Teal Thunder / Vivid Black Black Trim", price: 31199 }
];
const priced = (units: { price: number }[]) => units.map(u => u.price).sort((a, b) => a - b);

assert.deepEqual(
  priced(narrowUnitsByColorFinish(RG_UNITS, { color: null, finish: null })),
  priced(RG_UNITS),
  "no stated colour => the model's honest range, unnarrowed"
);
assert.deepEqual(
  priced(narrowUnitsByColorFinish(RG_UNITS, { color: "Dark Billiard Gray", finish: null })),
  [25999, 29399],
  "a colour alone narrows to that colour's units (both finishes)"
);
assert.deepEqual(
  priced(narrowUnitsByColorFinish(RG_UNITS, { color: "Dark Billiard Gray", finish: "Black Trim" })),
  [29399],
  "colour + finish pins ONE bike — an exact price, not a range"
);
assert.deepEqual(
  priced(narrowUnitsByColorFinish(RG_UNITS, { color: "Dark Billiard Gray", finish: "Chrome Trim" })),
  [25999],
  "the same colour in the other finish is a different bike $3,400 away — the finish must decide it"
);
assert.deepEqual(
  priced(narrowUnitsByColorFinish(RG_UNITS, { color: "Vivid Black", finish: null })),
  [29899, 31199],
  "a colour that appears inside a two-tone name still narrows"
);
// FAIL DIRECTION: a colour we do not stock degrades to the model's range, never to silence.
assert.deepEqual(
  priced(narrowUnitsByColorFinish(RG_UNITS, { color: "Lime Green Sparkle", finish: null })),
  priced(RG_UNITS),
  "a colour we do not stock must fall back to the full range — never an empty price answer"
);
assert.deepEqual(
  priced(narrowUnitsByColorFinish(RG_UNITS, { color: "Dark Billiard Gray", finish: "Titanium Trim" })),
  priced(RG_UNITS),
  "a finish we do not stock falls back too, rather than answering with nothing"
);
// Purely subtractive, and a single unit is never narrowed away.
for (const stated of [{ color: "Vivid Black" }, { color: "chrome" }, { color: null, finish: "Black Trim" }, {}]) {
  const out = narrowUnitsByColorFinish(RG_UNITS, stated as any);
  assert.ok(out.length >= 1 && out.length <= RG_UNITS.length, "narrowing is subtractive and never empties the set");
  for (const u of out) assert.ok(RG_UNITS.includes(u), "narrowing never invents a unit");
}
assert.deepEqual(narrowUnitsByColorFinish([RG_UNITS[0]], { color: "Vivid Black" }), [RG_UNITS[0]], "a lone unit is answered, not filtered away");

// (f) WIRING (ordering, not source text): both feed price readers must scope through the shared
// helper. A reader that still filters on bare modelMatches is the defect all over again.
// Comments are stripped first: an earlier draft of this eval passed a deliberate sabotage because
// the explanatory comment above the filter still carried the helper's name. It now reads CODE only.
const feed = readFileSync("services/api/src/domain/inventoryFeed.ts", "utf8");
const codeOnly = (text: string) =>
  text
    .split("\n")
    .filter(line => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
    .join("\n");
for (const fn of ["export async function findPriceRange", "export async function findInventoryPrice"]) {
  const start = feed.indexOf(fn);
  assert.ok(start > -1, `${fn} must still exist — it is a customer-facing price reader`);
  const after = feed.indexOf("\nexport ", start + 1);
  const body = codeOnly(feed.slice(start, after > -1 ? after : feed.length));
  assert.ok(
    body.includes("unitInScopeForModelPriceAnswer("),
    `${fn} must scope units through unitInScopeForModelPriceAnswer, not bare modelMatches`
  );
  assert.equal(
    body.includes("modelMatches("),
    false,
    `${fn} must not fall back to bare modelMatches — that is the defect (a CVO pricing a base-model ask)`
  );
}

console.log(
  "PASS price_answer_sibling_model_scope eval — a base-model price question no longer quotes its CVO / Limited / Special / trike siblings (+Joe 2026-08-03), each sibling still prices itself, and both feed price readers share the watch engine's one definition of a distinct model"
);
