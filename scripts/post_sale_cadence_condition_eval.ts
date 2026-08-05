/**
 * Post-sale cadence NEW-vs-PRE-OWNED eval (deterministic — no LLM).
 *
 * Pins that the Custom Coverage / factory-warranty accessory reminder only goes to NEW-bike
 * purchases, and pre-owned buyers get a warm no-warranty-claim check-in. postSaleVehicleIsNew
 * must fail SAFE (unknown condition => pre-owned), so a false "full factory warranty" claim
 * can't reach a pre-owned buyer. Origin: Marcy got the factory-warranty reminder post-sale.
 */
import assert from "node:assert/strict";
import {
  postSaleVehicleIsNew,
  postSaleAccessoryOrEnjoyMessage,
  decidePostSaleCadenceBackfill,
  POST_SALE_BACKFILL_MAX_AGE_DAYS
} from "../services/api/src/domain/postSaleCadence.ts";
import { isCadenceCloseSoldReason } from "../services/api/src/domain/routeStateReducer.ts";
import fs from "node:fs";
import { checkMessage } from "./voice_charter_audit.ts";

// --- postSaleVehicleIsNew: confident NEW only, else pre-owned ---
assert.equal(postSaleVehicleIsNew({ sale: { condition: "new" } }), true, "sale.condition=new => new");
assert.equal(postSaleVehicleIsNew({ lead: { vehicle: { condition: "new" } } }), true, "lead vehicle new => new");
assert.equal(postSaleVehicleIsNew({ inventoryContext: { condition: "new" } }), true, "inventoryContext new => new");
assert.equal(postSaleVehicleIsNew({ sale: { condition: "new", label: "2025 Street Glide" } }), true, "new + clean label => new");

assert.equal(postSaleVehicleIsNew({}), false, "unknown condition => pre-owned (fail-safe)");
assert.equal(postSaleVehicleIsNew({ lead: { vehicle: { condition: "used" } } }), false, "lead vehicle used => pre-owned");
assert.equal(postSaleVehicleIsNew({ sale: { label: "Pre-Owned 2020 Road Glide" } }), false, "pre-owned label => pre-owned");
assert.equal(postSaleVehicleIsNew({ sale: { label: "Used 2019 Street Glide" } }), false, "used label => pre-owned");
assert.equal(
  postSaleVehicleIsNew({ sale: { condition: "new", label: "Certified Pre-Owned Fat Boy" } }),
  false,
  "used label hint overrides a stray new condition => pre-owned (no false warranty claim)"
);

// --- model-year sanity (Joe ruling 2026-07-09, Kellen +17167995197): a lying ADF
// condition:"new" on a bike whose model year is 3+ years older than the sale flips to
// pre-owned; genuine non-current new stock (gap <= 2) stays new. ---
assert.equal(
  postSaleVehicleIsNew({
    lead: { vehicle: { condition: "new", year: "2019", model: "Electra Glide Ultra Classic" } },
    closedAt: "2026-05-04T13:23:15.029Z"
  }),
  false,
  "Kellen class: 2019 bike sold 2026 with condition:new => pre-owned (ADF field lies)"
);
assert.equal(
  postSaleVehicleIsNew({
    lead: { vehicle: { condition: "new", year: "2024", model: "Low Rider S" } },
    closedAt: "2026-06-30T12:00:00.000Z"
  }),
  true,
  "non-current new stock: new 2024 sold 2026 (gap 2) stays NEW"
);
assert.equal(
  postSaleVehicleIsNew({
    sale: { condition: "new", year: 2026, soldAt: "2026-07-01T12:00:00.000Z" }
  }),
  true,
  "current-year new sale stays NEW (sale.year + sale.soldAt path)"
);
assert.equal(
  postSaleVehicleIsNew({ lead: { vehicle: { condition: "new", year: "not-a-year" } }, closedAt: "2026-05-04T00:00:00Z" }),
  true,
  "unparseable year => no year override (condition signal stands)"
);

// --- the condition-specific message (cadence step 2) ---
const newMsg = postSaleAccessoryOrEnjoyMessage({
  firstName: "Marcy", repName: "Giovanni", dealerName: "American Harley-Davidson", bikeModel: "Street Glide", isNewBike: true
});
assert.ok(/Custom Coverage/.test(newMsg) && /full factory warranty/.test(newMsg), "NEW bike => Custom Coverage / factory warranty reminder");

const preownedMsg = postSaleAccessoryOrEnjoyMessage({
  firstName: "Marcy", repName: "Giovanni", dealerName: "American Harley-Davidson", bikeModel: "Street Glide", isNewBike: false
});
assert.ok(!/Custom Coverage/i.test(preownedMsg), "PRE-OWNED => no Custom Coverage pitch");
assert.ok(!/factory warranty/i.test(preownedMsg), "PRE-OWNED => no factory-warranty claim");
assert.ok(/enjoying the Street Glide/i.test(preownedMsg) && /just let me know/i.test(preownedMsg), "PRE-OWNED => warm 'enjoying it / anything you need' check-in naming the bike");
// charter: at most one em-dash in the message (the intro), no doubled em-dash list
assert.ok((preownedMsg.match(/—/g) || []).length <= 1, "pre-owned message keeps the em-dash diet (<=1)");

// charter long_brand_repeat: a post-sale touch is NOT a first outbound, so the full brand
// name must be framed as a re-intro to clear the check.
// Origin: Weston (+17167439566) 2026-07-05 — "Giovanni at American Harley-Davidson" tripped it.
// The re-intro now uses the canonical SOFTENED wording (buildAgentIntro, "it's {rep} over at
// {dealer}") per Joe's 2026-07-29 ruling; the charter rule was taught that form in the same change,
// having previously only recognized the legacy "this is {rep} at {dealer}".
assert.ok(/it's Giovanni over at American Harley-Davidson/.test(preownedMsg), "PRE-OWNED => re-intro phrasing clears charter long_brand_repeat");
assert.ok(/it's Giovanni over at American Harley-Davidson/.test(newMsg), "NEW => re-intro phrasing clears charter long_brand_repeat");
// And the charter checker itself must AGREE — the assertion above is only meaningful if the rule
// actually clears the softened form (it didn't before 2026-07-29).
for (const [label, msg] of [["PRE-OWNED", preownedMsg], ["NEW", newMsg]] as const) {
  assert.ok(
    !checkMessage(msg, { firstOutbound: false, smsLike: true, staffHasSent: false })
      .some(v => v.check === "long_brand_repeat"),
    `${label} => voice_charter_audit clears the softened re-intro (no long_brand_repeat)`
  );
}

console.log("PASS post-sale cadence condition eval");

// --- WHICH stranded sold leads a backfill may re-arm (+17168614216, 2026-08-05) ---------------
// #519 is forward-only, so records frozen before it stay frozen. The naive selector — "sold, and no
// active post-sale chase" — matched 15 leads on the live store; only 3 were stranded by the bug.
// Re-arming the other 12 would have texted customers who had ASKED us to back off. Every row below
// is a real record from that store, so this eval fails if the rule ever loosens under them.
const ASOF = "2026-08-05T09:00:00.000Z";
const heal = (over: { [k: string]: unknown }) =>
  decidePostSaleCadenceBackfill({
    asOfIso: ASOF,
    isSoldCloseReason: isCadenceCloseSoldReason,
    ...over
  } as any);

// THE ONE THAT MUST HEAL: Charles Desalvo, sold 8/3, killed by the sold-close bug itself.
const charles = heal({
  stopReason: "sold_walkin_note",
  followUpMode: "manual_handoff",
  soldAtIso: "2026-08-03T11:21:47.479Z"
});
assert.equal(charles.heal, true, "+17168614216: the lead the sold-close bug stranded, 2 days old");
assert.equal(charles.skipReason, null, "a healed lead carries no skip reason");
// `manual_handoff` is NOT a deliberate park here — it is what the sold walk-in flow sets, and
// Charles carried it. Treating it as a park would have refused the one repair we actually wanted.
assert.equal(
  heal({ stopReason: "sold", followUpMode: "manual_handoff", soldAtIso: "2026-08-04T12:00:00.000Z" }).heal,
  true,
  "the console sold path's own reason heals too"
);

// THE TWELVE THAT MUST NOT: stopped for reasons that were CORRECT. Live rows, verbatim.
for (const [stopReason, followUpMode, soldAtIso, label] of [
  ["customer_stepping_back", "paused_indefinite", "2026-07-24T15:27:57.380Z", "+17163591526 the customer asked us to back off"],
  ["customer_stepping_back", "active", "2026-05-23T12:00:00.000Z", "+17168701333 stepping back, cadence still nominally active"],
  ["purchase_delivery", "manual_handoff", "2026-05-08T12:00:00.000Z", "+17163083675 delivery flow owns the thread"],
  ["in_process_deal", "manual_handoff", "2026-06-07T12:00:00.000Z", "+17163741119 a human is mid-deal"],
  ["inventory_watch", "holding_inventory", "2026-04-09T12:00:00.000Z", "+17163806373 parked on a watch"],
  ["pending_incoming_inventory", "manual_handoff", "2026-06-26T12:00:00.000Z", "+17166286477 waiting on the unit"],
  ["suppressed", "active", "2026-06-19T12:00:00.000Z", "+17169085647 suppressed is not a sold close"],
  ["other", "active", "2026-06-16T12:00:00.000Z", "+17166795683 'other' says nothing — refuse"]
] as [string, string, string, string][]) {
  const d = heal({ stopReason, followUpMode, soldAtIso });
  assert.equal(d.heal, false, `${label} => never auto-resumed`);
  assert.match(
    String(d.skipReason),
    /^not_a_sold_close:/,
    `${label} => skipped for NOT being the bug, and the reason says so`
  );
}

// THE AGE CEILING. The other two genuine victims are 74 and 89 days old — a "congratulations on the
// new bike" text three months late reads as a system that lost the customer, not a repair.
const stale = heal({
  stopReason: "sold_walkin_note",
  followUpMode: "manual_handoff",
  soldAtIso: "2026-05-23T12:00:00.000Z"
});
assert.equal(stale.heal, false, "+17162137076: a real victim, but 74 days stale => still silent");
assert.match(String(stale.skipReason), /^too_old:\d+d>14d$/, "the skip says how old and against what");
assert.equal(POST_SALE_BACKFILL_MAX_AGE_DAYS, 14, "the ceiling is a stated number, not a magic literal");
// Exactly at the ceiling still heals; a day past it does not.
assert.equal(heal({ stopReason: "sold", soldAtIso: "2026-07-22T09:00:00.000Z" }).heal, true, "14 days => heals");
assert.equal(heal({ stopReason: "sold", soldAtIso: "2026-07-21T08:00:00.000Z" }).heal, false, "15 days => silent");

// A DELIBERATE PARK BEATS EVEN A GENUINE SOLD-CLOSE. Belt and braces: if staff parked the thread,
// the repair defers to them regardless of why the cadence stopped.
for (const mode of ["paused_indefinite", "holding_inventory"]) {
  const d = heal({ stopReason: "sold_walkin_note", followUpMode: mode, soldAtIso: "2026-08-04T12:00:00.000Z" });
  assert.equal(d.heal, false, `${mode} => staff parked it; the repair does not un-park`);
  assert.equal(d.skipReason, `deliberately_parked:${mode}`);
}

// FAIL DIRECTION: every uncertainty resolves to SILENCE, which is today's behaviour for these records.
assert.equal(heal({ stopReason: "sold", soldAtIso: "" }).skipReason, "no_sale_date", "no sale date => silent");
assert.equal(heal({ stopReason: "sold", soldAtIso: "not a date" }).skipReason, "no_sale_date", "junk date => silent");
assert.equal(heal({ stopReason: "sold", soldAtIso: "2026-09-01T12:00:00.000Z" }).skipReason, "sale_date_in_future");
assert.equal(heal({ stopReason: null, soldAtIso: "2026-08-04T12:00:00.000Z" }).skipReason, "not_a_sold_close:unknown");
assert.equal(heal({ stopReason: "", soldAtIso: "2026-08-04T12:00:00.000Z" }).skipReason, "not_a_sold_close:unknown");
// Every refusal explains itself — a run that matched nothing must not read like a run with nothing to do.
for (const bad of [{ stopReason: "other" }, { stopReason: "sold", soldAtIso: "" }]) {
  assert.ok(String(heal(bad as any).skipReason ?? "").length > 0, "a skip always carries a reason");
}

// ONE AUTHORITY, NOT TWO. The heal must select on exactly what the referee protects; a private
// second list is how a forward fix and its backfill drift apart.
assert.equal(isCadenceCloseSoldReason("sold_walkin_note"), true);
assert.equal(isCadenceCloseSoldReason("sold"), true);
assert.equal(isCadenceCloseSoldReason("customer_stepping_back"), false);
assert.equal(isCadenceCloseSoldReason(undefined), false);

// THE WRITE GUARD. `--phone 555` (space) parsed as NO TARGET and matched every stranded lead;
// one keystroke stood between a single-lead repair and 14 stale customers being texted.
const backfillSrc = fs.readFileSync("scripts/backfill_post_sale_cadence.ts", "utf8");
assert.ok(
  /refusing to --write with no target/.test(backfillSrc),
  "writing with no target must be refused, not silently treated as 'all'"
);
assert.ok(
  /process\.argv\.includes\("--all"\)/.test(backfillSrc),
  "a full-store write has to be asked for out loud"
);
assert.ok(
  /decidePostSaleCadenceBackfill\(/.test(backfillSrc),
  "the script asks the shared decision, not its own inline rule"
);
assert.ok(/skippedCount/.test(backfillSrc), "the run reports what it passed over");

console.log("PASS post-sale cadence backfill selection eval (sold-close only, age ceiling, park guard, write guard)");

