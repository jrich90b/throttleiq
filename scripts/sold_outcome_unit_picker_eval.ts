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

// --- 4) The CRM & Calendar Updates panel (8/3 wiring triage, theme A1). ---
// The questions panel offers the same "Sold" and used to record NOTHING: the backend mapped it to
// a bare archive (no conv.sale — the funnel scored the delivered bike LOST), and the frontend
// chained a follow-up input for "hold" only.

const questionDone = region("async function markQuestionDone(q: QuestionItem)", 1600);
assert.ok(
  /outcome === "sold"/.test(questionDone) && /openSoldModal\(/.test(questionDone),
  "markQuestionDone must chain a 'sold' outcome to openSoldModal — the CRM & Calendar Updates " +
    "panel is a third door to 'sold' and needs the same unit picker"
);
assert.ok(
  /openHoldModal\(/.test(questionDone),
  "the pre-existing 'hold' chain in markQuestionDone must survive"
);

// Backend: the mapping + the stub logic live in conversationStore (evaluable, and index.ts is at
// its size-ratchet ceiling); the endpoint arm just composes housekeeping + the referee'd helper.
const { deriveAttendanceOutcomeAction, applyUnitLessSoldSaleStub } = await import(
  "../services/api/src/domain/conversationStore.ts"
);
assert.equal(
  deriveAttendanceOutcomeAction("sold", null),
  "archive_sold",
  "a sold outcome must map to archive_sold, not the bare archive that recorded no sale"
);
assert.equal(
  deriveAttendanceOutcomeAction("sold", "resume"),
  "resume",
  "an explicit followUpAction must still win over the outcome-derived one"
);
assert.equal(
  deriveAttendanceOutcomeAction("no_show", null),
  "pause_next_business_day",
  "Joe 2026-07-02: a no-show re-engages the next business day — the lift must not lose this"
);

// The helper stamps a refereed unit-less stub and never overwrites a real sale.
const stubConv: any = { id: "t", leadKey: "t", mode: "suggest", messages: [] };
const stubDecision = applyUnitLessSoldSaleStub(stubConv, { nowIso: "2026-08-03T16:00:00.000Z" });
assert.equal(stubConv.sale?.soldAt, "2026-08-03T16:00:00.000Z", "the stub must stamp sale.soldAt");
assert.equal(stubConv.closedReason, "sold", "the referee's final closedReason is 'sold'");
assert.equal(stubConv.sale?.stockId, undefined, "no unit may be invented");
assert.equal(stubDecision?.releaseHold, false, "unit-less: never release a hold nobody matched");
const keepSale: any = {
  id: "t2",
  leadKey: "t2",
  mode: "suggest",
  messages: [],
  sale: { soldAt: "2026-07-01T00:00:00.000Z", stockId: "S13-25" }
};
assert.equal(
  applyUnitLessSoldSaleStub(keepSale, { nowIso: "2026-08-03T16:00:00.000Z" }),
  null,
  "an already-recorded sale must never be overwritten by the stub"
);
assert.equal(keepSale.sale.stockId, "S13-25", "the real unit survives");

// And the endpoint arm actually calls the helper (the wiring, not just the policy).
const API_PATH = "services/api/src/index.ts";
const api = fs.readFileSync(API_PATH, "utf8");
const archiveSoldStart = api.indexOf('if (action === "archive_sold") {');
assert.notEqual(archiveSoldStart, -1, "the archive_sold action arm must exist");
const archiveSoldArm = api.slice(archiveSoldStart, archiveSoldStart + 700);
assert.ok(
  /applyUnitLessSoldSaleStub\(conv,/.test(archiveSoldArm),
  "archive_sold must stamp the sale via applyUnitLessSoldSaleStub (the referee'd helper)"
);
assert.ok(
  /deriveAttendanceOutcomeAction\(outcome, followUpAction\)/.test(api),
  "the questions endpoint must derive its action through deriveAttendanceOutcomeAction"
);

// --- 5) Re-open confirms before erasing a recorded sale (theme A4). ---
// The server erases conv.sale on reopen; Delete has a confirm, this destroys a closed-won record
// just as permanently. Gated on a sale existing so archived non-sale threads stay one click.
const reopenFn = region("async function reopenConv()", 1200);
assert.ok(
  /window\.confirm\(/.test(reopenFn),
  "reopenConv must confirm before the server erases the recorded sale"
);
assert.ok(
  /sale\?\.soldAt/.test(reopenFn),
  "the reopen confirm must be gated on a sale actually existing — a non-sale reopen stays one click"
);

console.log("PASS sold_outcome_unit_picker_eval — 30 checks");
