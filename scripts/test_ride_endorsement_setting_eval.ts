/**
 * TEST-RIDE ENDORSEMENT SETTING — the control moved, the rule did not (2026-08-07).
 *
 * Joe asked for "Test rides require a motorcycle endorsement" to sit with the test-ride settings
 * instead of inside the Riding Academy block. That is a change to where the checkbox is DRAWN. The
 * risk it carries is silent: relocating JSX can drop the save or the load wiring, and a dealer would
 * then have a checkbox that does nothing — or worse, one that reads back the wrong way.
 *
 * WHY THE FAIL DIRECTION IS SAFE EITHER WAY, and why that is not an excuse to skip this eval.
 * `readFirstTimeRiderPolicy` computes
 *   requiresEndorsement = p.requiresMotorcycleEndorsementForTestRide !== false
 *                      && p.testRideRequiresEndorsement !== false
 * so an ABSENT value still means "endorsement required". Losing the wiring therefore fails toward
 * REQUIRING a licence, never toward putting an unlicensed rider on a bike. Good — but it would also
 * mean a dealer who legitimately turns the requirement OFF silently cannot, and nothing would say so.
 *
 * WHAT THIS PINS
 *   1. the reader's `!== false` shape — the safe default — is intact on BOTH legacy keys;
 *   2. the form still LOADS from `policies.firstTimeRider`, both keys, both `!== false`;
 *   3. the form still SAVES both keys off the one form field;
 *   4. the checkbox now renders in the Test Rides section, not the Riding Academy block.
 *
 * Run: npx tsx scripts/test_ride_endorsement_setting_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { readFirstTimeRiderPolicy } = await import("../services/api/src/domain/firstTimeRiderPolicy.ts");

let n = 0;
const ok = (cond: boolean, msg: string) => {
  assert.equal(cond, true, msg);
  n++;
};
const profile = (firstTimeRider: Record<string, unknown>) => ({ policies: { firstTimeRider } });

// ---------------------------------------------------------------------------
// PART 1 — the rule itself, executed. Unchanged by the UI move.
// ---------------------------------------------------------------------------
ok(
  readFirstTimeRiderPolicy(profile({})).requiresEndorsement === true,
  "an absent setting REQUIRES an endorsement — the safe default a dropped wiring falls back to"
);
ok(
  readFirstTimeRiderPolicy(profile({ testRideRequiresEndorsement: true, requiresMotorcycleEndorsementForTestRide: true }))
    .requiresEndorsement === true,
  "both keys true => required (americanharley's live profile)"
);
ok(
  readFirstTimeRiderPolicy(
    profile({ testRideRequiresEndorsement: false, requiresMotorcycleEndorsementForTestRide: false })
  ).requiresEndorsement === false,
  "a dealer who turns it off CAN turn it off — the point of keeping the wiring"
);
// Either legacy key alone is enough to switch it off; that is the pre-existing contract.
for (const key of ["testRideRequiresEndorsement", "requiresMotorcycleEndorsementForTestRide"]) {
  ok(
    readFirstTimeRiderPolicy(profile({ [key]: false })).requiresEndorsement === false,
    `${key}: false alone turns the requirement off, as before`
  );
}
// Only an explicit false counts — a truthy-ish or junk value must not silently disable it.
for (const junk of [null, undefined, 0, "", "false", "no"]) {
  ok(
    readFirstTimeRiderPolicy(profile({ testRideRequiresEndorsement: junk as never })).requiresEndorsement === true,
    `a non-false value (${JSON.stringify(junk)}) still REQUIRES an endorsement — only an explicit false disables`
  );
}

// ---------------------------------------------------------------------------
// PART 2 — the console wiring. A checkbox that saves nothing is the failure mode.
// ---------------------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const page = fs.readFileSync(path.join(here, "../apps/web/src/app/page.tsx"), "utf8");

ok(
  /testRideRequiresEndorsement:\s*\n?\s*profile\?\.policies\?\.firstTimeRider\?\.testRideRequiresEndorsement !== false &&\s*\n?\s*profile\?\.policies\?\.firstTimeRider\?\.requiresMotorcycleEndorsementForTestRide !== false/.test(
    page
  ),
  "the form LOADS from both legacy keys, keeping the !== false default"
);
ok(
  /testRideRequiresEndorsement:\s*!!dealerProfileForm\.testRideRequiresEndorsement,\s*\n\s*requiresMotorcycleEndorsementForTestRide:\s*!!dealerProfileForm\.testRideRequiresEndorsement/.test(
    page
  ),
  "the form SAVES both legacy keys off the single checkbox"
);
ok(
  (page.match(/Test rides require a motorcycle endorsement/g) ?? []).length === 1,
  "exactly one endorsement checkbox — a duplicate means the move left a copy behind"
);

// PART 3 — it is in the Test Rides section, not the Riding Academy block.
const testRideIdx = page.indexOf('<div className="text-sm font-medium mb-2">Test Rides</div>');
const weatherIdx = page.indexOf('<div className="text-sm font-medium mb-2">Weather & Pickup</div>');
const checkboxIdx = page.indexOf("Test rides require a motorcycle endorsement");
const courseUrlIdx = page.indexOf("dealerProfileForm.riderCourseUrl");
ok(testRideIdx > 0, "a Test Rides section exists");
ok(weatherIdx > testRideIdx, "the Weather & Pickup section still follows it (section order intact)");
ok(
  checkboxIdx > testRideIdx && checkboxIdx < weatherIdx,
  "the endorsement checkbox renders INSIDE the Test Rides section"
);
ok(checkboxIdx > courseUrlIdx, "and no longer sits up in the Riding Academy course block");
ok(
  page.includes("dealerProfileForm.testRideEnabled"),
  "the test-ride follow-up toggle is still in the section too — nothing was displaced by the move"
);

console.log(`test_ride_endorsement_setting_eval: PASS (${n} assertions)`);
