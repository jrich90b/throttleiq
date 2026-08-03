/**
 * Walk-in sold note → real sale record eval (pure, no LLM).
 *
 * Pins the 8/3 wiring-triage P1: a Traffic Log Pro walk-in note saying sold/delivered used to
 * close the lead via closeConversation(conv, "sold_walkin_note") and write NO conv.sale. Both
 * consumers that define "won" read the pair (closedReason === "sold" || sale.soldAt), so a
 * DELIVERED bike scored LOST in the pipeline funnel, and decideCloseoutReversal's sold-sticky
 * missed — a bare "thanks" reopened the completed deal into the working inbox.
 *
 * The fix routes through the sold-closeout REFEREE (applySoldCloseout, unit-less arm): it stamps
 * a sale stub (soldAt + a note pointing staff at Update Lead > Sold) WITHOUT inventing a unit —
 * the note names no bike, and falling back to lead.vehicle is the #470 wrong-bike trap (customer
 * inquired on one bike, bought another) — and re-stamps the final closedReason to "sold".
 *
 * Layers:
 *   1. deriveLeadStage — a sold-walk-in close WITH the sale stub is "won"; without it, "lost"
 *      (the trap, pinned so the premise stays true; the 3 pre-fix live conversations keep the
 *      bare "sold_walkin_note" reason, so that reading matters historically too).
 *   2. decideCloseoutReversal — hasSoldSale makes the thread sticky-closed on a bare ack AND on
 *      a real message; without it the real message reopens (the trap).
 *   3. decideSoldCloseout unit-less arm — closes as "sold" and leaves any hold standing (the
 *      fail-safe this fix leans on: never release a hold for a unit nobody named).
 *   4. Source pin — the hasSoldSignal branch routes through applySoldCloseout (the referee, so
 *      the state-writer ratchet stays flat), never hand-writes conv.sale, and never builds the
 *      sale from lead.vehicle.
 *
 * Run: npx tsx scripts/walkin_sold_sale_record_eval.ts
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";

const { deriveLeadStage } = await import("../services/api/src/domain/pipelineFunnel.ts");
const { decideCloseoutReversal, decideSoldCloseout } = await import(
  "../services/api/src/domain/routeStateReducer.ts"
);

// --- 1) Funnel: the sale stub flips a sold walk-in close from LOST to WON. ---

const NOW = Date.parse("2026-08-03T15:00:00.000Z");
const closedWalkinBase = {
  status: "closed",
  closedAt: "2026-08-01T18:00:00.000Z",
  closedReason: "sold_walkin_note"
};

assert.equal(
  deriveLeadStage({ ...closedWalkinBase, sale: { soldAt: "2026-08-01T18:00:00.000Z" } }, { nowMs: NOW }),
  "won",
  "a sold walk-in close carrying sale.soldAt must count as WON"
);
assert.equal(
  deriveLeadStage({ ...closedWalkinBase }, { nowMs: NOW }),
  "lost",
  "the trap being fixed: closedReason 'sold_walkin_note' with NO sale record reads as LOST — " +
    "if this ever flips without a sale, deriveLeadStage changed and this eval should be revisited"
);

// --- 2) Reversal: the sale stub makes the closed deal sticky. ---

const reversalBase = {
  cause: "customer_inbound",
  isClosed: true,
  closedReason: "sold_walkin_note",
  followUpReason: "sold_walkin_note"
};

for (const bareAck of [true, false]) {
  const withSale = decideCloseoutReversal({ ...reversalBase, hasSoldSale: true, bareAck });
  assert.equal(
    withSale.reopen,
    false,
    `a customer message (bareAck=${bareAck}) on a sold walk-in close WITH a sale must stay closed`
  );
}
const withoutSale = decideCloseoutReversal({ ...reversalBase, hasSoldSale: false, bareAck: false });
assert.equal(
  withoutSale.reopen,
  true,
  "the trap being fixed: without a sale record, a real customer message reopens the completed deal — " +
    "if this ever flips, decideCloseoutReversal changed and this eval should be revisited"
);

// --- 3) The referee's unit-less arm: closes as "sold", never releases an unnamed unit's hold. ---

const unitless = decideSoldCloseout({
  hasSoldUnit: false,
  hold: { key: "u902-24", stockId: "U902-24" },
  soldKey: null,
  holdMatchesSoldUnit: false
});
assert.equal(unitless.closeConversation, true, "the unit-less sold arm must still close the thread");
assert.equal(unitless.closedReason, "sold", "the referee's final closedReason is 'sold'");
assert.equal(
  unitless.releaseHold,
  false,
  "a sold closeout with no unit named must NEVER release a hold — nobody said which bike sold"
);

// --- 4) Source pin: the sold branch routes through the referee, unit-less, no hand-write. ---

const SRC_PATH = "services/api/src/routes/sendgridInbound.ts";
const src = fs.readFileSync(SRC_PATH, "utf8");

const anchor = "if (hasSoldSignal) {";
const start = src.indexOf(anchor);
assert.notEqual(start, -1, `anchor not found in ${SRC_PATH}: ${anchor}`);
// The branch ends where the next walk-in state arm begins.
const endAnchor = "} else if (hasCompletedTestRideSignal) {";
const end = src.indexOf(endAnchor, start);
assert.notEqual(end, -1, `end anchor not found after the sold branch: ${endAnchor}`);
// Negative pins must judge CODE, not the comments explaining the trap — strip line comments.
const branch = src
  .slice(start, end)
  .split("\n")
  .map(line => line.replace(/\/\/.*$/, ""))
  .join("\n");

assert.ok(
  /closeConversation\(conv, "sold_walkin_note"\)/.test(branch),
  "the sold branch must keep closeConversation's housekeeping (todos, cadence, watch pause, save)"
);
assert.ok(
  /applySoldCloseout\(conv,/.test(branch) && /soldAt/.test(branch),
  "the sale must be stamped through applySoldCloseout (the referee) — a hand-written conv.sale " +
    "is the un-refereed-writer disease the 8/3 triage documented"
);
assert.ok(
  !/conv\.sale\s*=/.test(branch),
  "no hand-write of conv.sale in the sold branch — the referee owns that write"
);
assert.ok(
  /!conv\.sale\?\.soldAt/.test(branch),
  "an already-recorded sale must never be overwritten by the walk-in stub"
);
assert.ok(
  /soldKey:\s*null/.test(branch),
  "the walk-in note names no unit — soldKey must be null so the referee's unit-less arm runs"
);
assert.ok(
  !/lead\??\.vehicle|leadVehicle/.test(branch),
  "the sale stub must NEVER be built from lead.vehicle — that is the #470 wrong-bike trap " +
    "(the customer inquired on one bike and bought another)"
);
assert.ok(
  !/stockId|(?<![A-Za-z])vin(?![A-Za-z])/.test(branch),
  "the walk-in note names no unit — the stub must not invent a stockId/vin"
);

console.log("PASS walkin_sold_sale_record_eval — 17 checks");
