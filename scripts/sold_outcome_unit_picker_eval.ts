/**
 * Sold-outcome unit picker eval (pure, no LLM).
 *
 * Pins the operator-reported miss (Joe Hartrich, manager, 2026-07-31T18:38Z, Charles Desalvo
 * +17168614216): "hit sold from the outcome and it did not let me select a bike".
 *
 * The console has two doors to "sold". The Update-Lead dropdown chains to openSoldModal (the only
 * place that loads /api/inventory and offers a unit list + manual stock/VIN). The two OUTCOME
 * modals chained to a unit picker for exactly one disposition — "hold" — so choosing "sold" there
 * saved with no unit at all, and the backend fell back to conv.lead.vehicle: the bike the customer
 * ASKED about. On this lead that fallback was wrong, not merely blank — he inquired on a 2024
 * Street Glide and bought a 2025 Breakout (stock S13-25). Joe re-did it through the working door
 * 3m26s later.
 *
 * Layers:
 *   1. Source guard — BOTH outcome-save paths chain "sold" to openSoldModal, exactly as they
 *      already chain "hold" to openHoldModal.
 *   2. Seeding guard — openSoldModal resolves soldById off the conversation it opened (an outcome
 *      chain has no closeReason and may target a conv that isn't selectedConv), and must not
 *      clobber a pick the manager already made.
 *   3. Negative pin — the fix adds no new sold WRITER. submitSold stays the single caller that
 *      posts /close with reason "sold" + soldUnit, so the referee path (applySoldCloseout,
 *      setInventorySold, clearInventoryHoldRefs) keeps owning the side effects.
 *
 * Run: npx tsx scripts/sold_outcome_unit_picker_eval.ts
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";

const PAGE_PATH = "apps/web/src/app/page.tsx";
const page = fs.readFileSync(PAGE_PATH, "utf8");

/**
 * Slice a region by anchor. A missing anchor must FAIL, never silently slice from -1 — that is how
 * a source pin turns into a test that asserts nothing (see the ratchet/source-pin incident).
 */
function region(anchor: string, length: number): string {
  const start = page.indexOf(anchor);
  assert.notEqual(start, -1, `anchor not found in ${PAGE_PATH}, the pin would be vacuous: ${anchor}`);
  return page.slice(start, start + length);
}

// --- 1) Both outcome-save paths chain "sold" to the unit picker. ---

const headerSave = region("async function saveAppointmentOutcomeFromHeader()", 1800);
assert.ok(
  /appointmentOutcomeSecondary === "sold"/.test(headerSave),
  "the header Appointment Outcome save must recognise a 'sold' secondary outcome"
);
assert.ok(
  /openSoldModal\(/.test(headerSave),
  "the header Appointment Outcome save must chain 'sold' to openSoldModal so staff can name the unit"
);
assert.ok(
  /openHoldModal\(/.test(headerSave),
  "the pre-existing 'hold' chain must survive — 'sold' is added alongside it, not in place of it"
);

const taskModalSave = region('const shouldOpenHold = appointmentCloseSecondaryOutcome === "hold";', 1600);
assert.ok(
  /appointmentCloseSecondaryOutcome === "sold"/.test(taskModalSave),
  "the Close Demo Ride / appointment task outcome modal must recognise a 'sold' secondary outcome"
);
assert.ok(
  /openSoldModal\(/.test(taskModalSave),
  "the task outcome modal must chain 'sold' to openSoldModal — this is the exact control Joe reported missing"
);
assert.ok(
  /openHoldModal\(/.test(taskModalSave),
  "the pre-existing 'hold' chain must survive in the task outcome modal too"
);

// "sold" is genuinely offered in both disposition lists — if it ever stops being offered, the
// chains above are dead code and this pin should be revisited rather than quietly passing.
assert.ok(
  /DEALER_RIDE_SECONDARY_OPTIONS[\s\S]{0,400}value: "sold"/.test(page),
  "the demo-ride disposition list must still offer 'sold'"
);

// --- 2) openSoldModal seeds soldById off the conv it opened, without clobbering an explicit pick. ---

const soldModalOpener = region("async function openSoldModal(convId: string)", 1800);
assert.ok(
  /setSoldById\(/.test(soldModalOpener),
  "openSoldModal must seed soldById — an outcome chain has no closeReason, so the dropdown's seeding effect never runs"
);
assert.ok(
  /setSoldById\(\s*prev\s*=>\s*prev\s*\|\|/.test(soldModalOpener),
  "seeding must not clobber a soldById the manager already chose in the Update-Lead dropdown"
);
assert.ok(
  /conv\?\.sale\?\.soldById/.test(soldModalOpener),
  "seeding must resolve off the opened conversation (conv), not selectedConv — the task inbox can chain from a different thread"
);

// --- 3) Negative pin: no new sold writer was introduced. ---

const soldCloseCalls = page.match(/reason:\s*"sold"/g) ?? [];
assert.equal(
  soldCloseCalls.length,
  1,
  `exactly one console site may POST /close with reason "sold" (submitSold); found ${soldCloseCalls.length}. ` +
    "Chaining the outcome modals must REUSE that door, not add another sold writer that skips the referee."
);

const submitSold = region("async function submitSold(selection: any)", 2600);
assert.ok(
  /soldUnit/.test(submitSold),
  "submitSold must keep sending the named soldUnit — that payload is the whole point of the picker"
);
assert.ok(
  /Please select a unit or enter a stock\/VIN to mark sold\./.test(submitSold),
  "submitSold must keep refusing a unit-less sale; the outcome path's silent lead.vehicle fallback is the bug being fixed"
);

console.log("PASS sold_outcome_unit_picker_eval — 14 checks");
