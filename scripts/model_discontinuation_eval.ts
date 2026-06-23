/**
 * Model-discontinuation eval (no LLM) — pins the pure decision AND validates the data interface
 * against the real MSRP sheet. 4-pillar shape; iterations are the adversarial pillar.
 * Run: npx tsx scripts/model_discontinuation_eval.ts
 */
import assert from "node:assert/strict";

import { decideModelDiscontinuation, MSRP_MATCH_MIN_SCORE } from "../services/api/src/domain/modelDiscontinuation.ts";
import { findModelInMsrp, MSRP_SHEET_MODEL_YEAR } from "../services/api/src/domain/msrpPriceList.ts";

const YEAR = MSRP_SHEET_MODEL_YEAR; // fresh sheet
type Case = { pillar: 1 | 2 | 3 | 4; id: string; in: any; status: string };
const cases: Case[] = [
  // 1. SATISFIED / keep (must NOT be called discontinued)
  { pillar: 1, id: "in_inventory_wins", in: { inInventory: true, msrpMatchScore: 0, sheetModelYear: YEAR, currentYear: YEAR }, status: "available" }, // carryover stock
  { pillar: 1, id: "current_in_catalog", in: { inInventory: false, msrpMatchScore: 90, sheetModelYear: YEAR, currentYear: YEAR }, status: "current" },
  // 2. THE TARGET: absent from catalog + not in inventory, fresh sheet -> discontinued
  { pillar: 2, id: "fat_bob_discontinued", in: { inInventory: false, msrpMatchScore: 0, sheetModelYear: YEAR, currentYear: YEAR }, status: "discontinued" },
  // 3. EDGES
  { pillar: 3, id: "stale_sheet_unknown", in: { inInventory: false, msrpMatchScore: 0, sheetModelYear: 2026, currentYear: 2029 }, status: "unknown" }, // sheet too old to trust
  { pillar: 3, id: "borderline_match_unknown", in: { inInventory: false, msrpMatchScore: 40, sheetModelYear: YEAR, currentYear: YEAR }, status: "unknown" },
  { pillar: 3, id: "at_threshold_is_current", in: { inInventory: false, msrpMatchScore: MSRP_MATCH_MIN_SCORE, sheetModelYear: YEAR, currentYear: YEAR }, status: "current" },
  // 4. ADVERSARIAL — iterations / don't-false-flag
  { pillar: 4, id: "iteration_low_rider_current", in: { inInventory: false, msrpMatchScore: 80, sheetModelYear: YEAR, currentYear: YEAR }, status: "current" }, // "Low Rider" matched "Low Rider S"
  { pillar: 4, id: "in_stock_but_not_catalog", in: { inInventory: true, msrpMatchScore: 0, sheetModelYear: YEAR, currentYear: YEAR }, status: "available" }
];
const byPillar: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
for (const c of cases) {
  const got = decideModelDiscontinuation(c.in);
  assert.equal(got.status, c.status, `[P${c.pillar} ${c.id}] expected ${c.status}, got ${got.status} (${got.reason})`);
  byPillar[c.pillar]++;
}

// --- Real-data validation against the actual MSRP sheet (the case that started this) ---
const fatBob = await findModelInMsrp("Fat Bob");
const fatBob114 = await findModelInMsrp("Fat Bob 114"); // the exact iteration Mark referenced
const lowRider = await findModelInMsrp("Low Rider"); // a CURRENT model's base name -> must match S/ST
assert.equal(fatBob.matched, false, `Fat Bob must be ABSENT from the 2026 sheet (score ${fatBob.score})`);
assert.equal(fatBob114.matched, false, `Fat Bob 114 must be ABSENT (score ${fatBob114.score})`);
assert.equal(lowRider.matched, true, `Low Rider must MATCH a current iteration (got score ${lowRider.score}, family ${lowRider.family})`);
// end-to-end: Fat Bob, no inventory, fresh sheet -> discontinued; Low Rider -> current
assert.equal(decideModelDiscontinuation({ inInventory: false, msrpMatchScore: fatBob.score, sheetModelYear: YEAR, currentYear: YEAR }).status, "discontinued", "Fat Bob resolves to discontinued");
assert.equal(decideModelDiscontinuation({ inInventory: false, msrpMatchScore: lowRider.score, sheetModelYear: YEAR, currentYear: YEAR }).status, "current", "Low Rider resolves to current (iteration safe)");

console.log(`PASS model-discontinuation — ${cases.length} decision cases (4 pillars: ${byPillar[1]}/${byPillar[2]}/${byPillar[3]}/${byPillar[4]}) + real-sheet validation (Fat Bob absent→discontinued, Low Rider matched→current).`);
