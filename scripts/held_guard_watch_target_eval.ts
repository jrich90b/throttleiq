/**
 * Held-guard inventory-watch TARGET resolution (over-attachment guard).
 *
 * Production fixture: Raysean Mcclinon +15136149740, 2026-07 — the lead expressed
 * a generic "Road Glide"; the held-unit follow-up guard surfaced a held
 * "Road Glide 3 / Iron Horse Metallic" via the DIRECTIONAL model search (not an
 * exact stock#/VIN reference), and the auto-created inventory watch inherited the
 * search-surfaced sibling's model + specific color. That watch later fired a
 * notification for a bike the customer never named.
 *
 * Approach A (Joe, 2026-07-04): the customer's EXPRESSED interest is authoritative.
 * `resolveHeldGuardWatchTarget` only lets the surfaced unit's model/year/color win
 * when the customer referenced that exact unit (stock#/VIN, customerReferencedUnit:
 * true). Otherwise the watch is built from the expressed vehicle and the surfaced
 * unit's attributes are ignored — a base-model watch, never the sibling.
 *
 * This pins both branches so a future refactor can't silently re-introduce the
 * over-attachment. Wired into ci:eval next to cadence_held_unit_model_guard:eval.
 */
import assert from "node:assert/strict";
import { resolveHeldGuardWatchTarget } from "../services/api/src/domain/heldUnitWatchHeal.ts";

// ── The bug: search-surfaced sibling, NOT customer-referenced -> watch the expressed model. ──
// Raysean: expressed "Road Glide", surfaced held "Road Glide 3 / Iron Horse Metallic".
{
  const t = resolveHeldGuardWatchTarget({
    expressed: { model: "Road Glide", year: null, color: null, condition: "new" },
    unit: { model: "Road Glide 3", year: 2026, color: "Iron Horse Metallic", condition: "new" },
    customerReferencedUnit: false
  });
  assert.equal(t.model, "Road Glide", "search-surfaced sibling must not become the watch model");
  assert.equal(t.color, null, "a search-surfaced unit's specific color must never be carried onto an expressed-model watch");
  assert.equal(t.condition, "new", "condition still resolves");
}

// ── The control: customer referenced the EXACT unit (stock#/VIN) -> unit's own fields win. ──
{
  const t = resolveHeldGuardWatchTarget({
    expressed: { model: "Road Glide", year: null, color: null, condition: "new" },
    unit: { model: "Road Glide 3", year: 2026, color: "Iron Horse Metallic", condition: "new" },
    customerReferencedUnit: true
  });
  assert.equal(t.model, "Road Glide 3", "an exact stock#/VIN reference means the customer meant this unit");
  assert.equal(t.color, "Iron Horse Metallic", "the referenced unit's color is honored");
  assert.equal(t.year, 2026, "the referenced unit's year is honored");
}

// ── Not referenced: the expressed color is kept; the surfaced unit's color is dropped. ──
{
  const t = resolveHeldGuardWatchTarget({
    expressed: { model: "Road Glide", color: "Vivid Black" },
    unit: { model: "Road Glide 3", color: "Iron Horse Metallic" },
    customerReferencedUnit: false
  });
  assert.equal(t.model, "Road Glide", "expressed model wins");
  assert.equal(t.color, "Vivid Black", "the customer's expressed color is preserved, not the sibling's");
}

// ── Referenced: unit fields win, but fall back to the expressed vehicle for any GAPS. ──
{
  const t = resolveHeldGuardWatchTarget({
    expressed: { model: "Road Glide", year: 2025, color: "Vivid Black", condition: "new" },
    unit: { model: "Road Glide 3", year: null, color: null, condition: null },
    customerReferencedUnit: true
  });
  assert.equal(t.model, "Road Glide 3", "referenced unit's model wins");
  assert.equal(t.year, 2025, "gap in the referenced unit's year falls back to expressed");
  assert.equal(t.color, "Vivid Black", "gap in the referenced unit's color falls back to expressed");
  assert.equal(t.condition, "new", "gap in condition falls back to expressed");
}

// ── No expressed model + not referenced: fall back to the unit model (better a watch than
//    nothing; downstream model-guard/canonicalize handles specificity). Intended, pinned. ──
{
  const t = resolveHeldGuardWatchTarget({
    expressed: { model: null },
    unit: { model: "Road Glide 3" },
    customerReferencedUnit: false
  });
  assert.equal(t.model, "Road Glide 3", "with no expressed model there is no sibling to over-attach; the unit model is the only basis");
}

// ── Normalization: blank/whitespace strings -> null; string years -> numbers; garbage -> null. ──
{
  const t = resolveHeldGuardWatchTarget({
    expressed: { model: "   ", year: "2026", color: "  " },
    unit: { model: "", year: "not-a-year", color: "" },
    customerReferencedUnit: false
  });
  assert.equal(t.model, null, "whitespace-only model normalizes to null");
  assert.equal(t.year, 2026, "a numeric string year parses to a number");
  assert.equal(t.color, null, "whitespace-only color normalizes to null");
}
{
  const t = resolveHeldGuardWatchTarget({
    expressed: { model: "Road Glide", year: "garbage" },
    unit: null,
    customerReferencedUnit: true
  });
  assert.equal(t.model, "Road Glide", "null unit does not throw");
  assert.equal(t.year, null, "an unparseable year normalizes to null");
}

// ── Null-safety: both sides null -> all-null result, no throw. ──
{
  const t = resolveHeldGuardWatchTarget({ expressed: null, unit: null, customerReferencedUnit: false });
  assert.deepEqual(t, { model: null, year: null, color: null, condition: null }, "null inputs yield an all-null target");
}

console.log("PASS held guard watch target eval");
