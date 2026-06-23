/**
 * Phantom-visit guard eval (pure, no LLM).
 *
 * Pins the "don't thank for a visit that didn't happen" fix — the biggest out-of-context cluster in
 * prod (19+ convs asserting "thanks again for coming in / for the test ride / coming to see us" on
 * leads with no visit). Four draft builders hardcoded that framing; the fix gates it on
 * customerVisitConfirmed (dark behind PHANTOM_VISIT_GUARD).
 *
 * Layers:
 *   1. customerVisitConfirmed — precise: a SHOWED appointment/ride outcome / walk-in / customer-said-so
 *      is a visit; a sale / credit-app / merely-booked appointment is NOT (the Knighton class).
 *   2. rideOutcomeImpliesVisit — a recorded sold/hold/showed outcome implies a visit; did_not_show does not.
 *   3. Dark by default + source guard — both the live (index.ts) and ADF (sendgridInbound.ts) builders
 *      use the guard + the initial-touch fallback intro.
 *
 * Run: npx tsx scripts/phantom_visit_intro_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  customerVisitConfirmed,
  rideOutcomeImpliesVisit,
  phantomVisitGuardEnabled
} from "../services/api/src/domain/visitFraming.ts";

// --- 1) customerVisitConfirmed decision table ---
const showed = { appointment: { staffNotify: { outcome: { primaryStatus: "showed" } } } };
assert.equal(customerVisitConfirmed(showed), true, "showed appointment outcome → visited");
assert.equal(customerVisitConfirmed({ appointment: { staffNotify: { outcome: { status: "showed_up" } } } }), true, "showed_up status → visited");
assert.equal(customerVisitConfirmed({ lead: { source: "Walk In" } }), true, "walk-in source → visited");
assert.equal(customerVisitConfirmed({ lead: { source: "Traffic Log Pro" } }), true, "TLP source → visited");
assert.equal(customerVisitConfirmed({ dialogState: { name: "walk_in_active" } }), true, "walk_in_active → visited");
assert.equal(customerVisitConfirmed({ messages: [{ direction: "in", body: "I stopped in today, loved it" }] }), true, "customer said they came in → visited");
assert.equal(customerVisitConfirmed({ messages: [{ direction: "in", body: "test rode it yesterday" }] }), true, "customer said test rode → visited");
// THE KNIGHTON CLASS — sold / credit-app / booked but NO physical visit:
assert.equal(customerVisitConfirmed({ sale: { soldAt: "2026-05-31" }, closedReason: "sold" }), false, "sold alone ≠ visited (HDFS online deal)");
assert.equal(customerVisitConfirmed({ followUpCadence: { kind: "post_sale" } }), false, "post-sale cadence ≠ visited");
assert.equal(customerVisitConfirmed({ appointment: { bookedEventId: "evt1", status: "confirmed" } }), false, "merely-booked appointment ≠ visited (they haven't come yet)");
assert.equal(customerVisitConfirmed({ lead: { source: "HDFS COA Online" } }), false, "online credit-app source ≠ visited");
assert.equal(customerVisitConfirmed({}), false, "no signal → not visited (fail-safe)");

// --- 2) rideOutcomeImpliesVisit ---
assert.equal(rideOutcomeImpliesVisit("showed", null, null), true, "showed → visit");
assert.equal(rideOutcomeImpliesVisit(null, "sold", null), true, "sold outcome → visit");
assert.equal(rideOutcomeImpliesVisit(null, "hold", null), true, "hold outcome → visit");
assert.equal(rideOutcomeImpliesVisit(null, null, "financing_declined"), true, "finance-declined-after-ride → visit");
assert.equal(rideOutcomeImpliesVisit("did_not_show", null, null), false, "did_not_show → NO visit");
assert.equal(rideOutcomeImpliesVisit("cancelled", null, null), false, "cancelled → NO visit");
assert.equal(rideOutcomeImpliesVisit(null, null, null), false, "no outcome → NO visit (fail-safe)");

// --- 3) dark by default ---
delete process.env.PHANTOM_VISIT_GUARD;
assert.equal(phantomVisitGuardEnabled(), false, "ships DARK — flag off by default");
process.env.PHANTOM_VISIT_GUARD = "1";
assert.equal(phantomVisitGuardEnabled(), true, "flag on when set to 1");
delete process.env.PHANTOM_VISIT_GUARD;

// --- 3b) source guard: both paths gate the phantom intro + use the initial-touch fallback ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const adf = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");
for (const [label, src] of [["index.ts", index], ["sendgridInbound.ts", adf]] as const) {
  assert.ok(/customerVisitConfirmed\(/.test(src), `${label} must gate on customerVisitConfirmed`);
  assert.ok(/phantomVisitGuardEnabled\(/.test(src), `${label} must read the dark flag`);
  assert.ok(/Thanks for your interest in the \$\{modelLabel\}/.test(src), `${label} must have the initial-touch fallback intro`);
}
assert.ok(/rideOutcomeImpliesVisit\(/.test(index), "index.ts outcome builder must gate on rideOutcomeImpliesVisit");
assert.ok(/Congrats on your \$\{bikeModel\}/.test(index), "post-sale builder must have the visit-neutral congrats fallback");

console.log("PASS phantom-visit guard — customerVisitConfirmed table (Knighton class: sold/booked/online ≠ visit), rideOutcomeImpliesVisit, dark-by-default, both-path source guard.");
