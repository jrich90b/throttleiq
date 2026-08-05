/**
 * Jumpstart profile toggle eval (pure, no LLM).
 *
 * Joe, 2026-08-05: *"American Harley has one but it needs to be added to dealer profile so a dealer
 * can check off if they have one."* The capability existed as a JSON field; this pins the CONSOLE
 * CONTROL that lets a dealer set it themselves — which is also what makes it portable, since dealer
 * #2 ticks or leaves the same box.
 *
 * WHAT THIS GUARDS. A settings checkbox is worthless if any link in the chain uses a different key:
 * the box would tick, the profile would save, and the agent would still never offer the Jumpstart —
 * silently, with nothing red anywhere. So this asserts ONE key string end to end:
 *
 *   console form default → hydrate from saved profile → save payload → what the runtime READS
 *
 * The runtime half is executed (`readFirstTimeRiderPolicy` against real profile shapes); the console
 * half is asserted against `apps/web/src/app/page.tsx` source, because `tsc` for the web app does
 * not run in `ci:eval` and a React form cannot be imported here. Both halves must name
 * `jumpstartEnabled`, so a rename on EITHER side fails this eval.
 *
 * Run: npx tsx scripts/jumpstart_profile_toggle_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  readFirstTimeRiderPolicy,
  enrollmentSeatIsUnpaid,
  REGISTRATION_NOTE_MAX_CHARS
} from "../services/api/src/domain/firstTimeRiderPolicy.ts";

const KEY = "jumpstartEnabled";
const web = fs.readFileSync("apps/web/src/app/page.tsx", "utf8");
const runtime = fs.readFileSync("services/api/src/domain/firstTimeRiderPolicy.ts", "utf8");

// --- 1) The console form carries the control, all four wiring points. ---
assert.ok(
  new RegExp(`\\n\\s+${KEY}: false,`).test(web),
  "the profile form must default the Jumpstart toggle to OFF — a dealer who has not answered does not have one"
);
assert.ok(
  new RegExp(`${KEY}: profile\\?\\.policies\\?\\.firstTimeRider\\?\\.${KEY} === true`).test(web),
  "the form must hydrate from policies.firstTimeRider.jumpstartEnabled, and only from an explicit true"
);
assert.ok(
  new RegExp(`${KEY}: !!dealerProfileForm\\.${KEY},`).test(web),
  "the save payload must write the toggle back to the SAME key inside firstTimeRider"
);
assert.ok(
  new RegExp(`checked=\\{!!dealerProfileForm\\.${KEY}\\}`).test(web) &&
    new RegExp(`${KEY}: e\\.target\\.checked`).test(web),
  "there must be a real checkbox bound to the form field (checked + onChange)"
);
// The save payload writes inside the firstTimeRider object, not at the top of policies — otherwise
// the runtime reader would never see it.
const savePayload = web.slice(web.indexOf("firstTimeRider: {"), web.indexOf("internationalShipping: {"));
assert.ok(
  savePayload.includes(`${KEY}: !!dealerProfileForm.${KEY},`),
  "the toggle must be saved INSIDE policies.firstTimeRider, where the runtime reads it"
);

// --- 2) A dealer would find it: it sits in the rider-training card and says what it does. ---
const card = web.slice(web.indexOf("Riding Academy / First-Time Rider"));
const cardEnd = card.indexOf("Dealership has a Jumpstart on site");
assert.ok(cardEnd > 0, "the toggle must live in the Riding Academy / First-Time Rider settings card");
// Collapse JSX line wrapping before matching — the copy is indented across several lines.
const helper = card.slice(cardEnd, cardEnd + 700).replace(/\s+/g, " ");
assert.ok(
  /little or no riding experience/i.test(helper) && /never mentioned/i.test(helper),
  `the helper text must say WHO gets offered it and what leaving it unchecked means: "${helper.slice(0, 300)}"`
);
// Never gate it behind the course toggle: a store can own a Jumpstart without running a course.
assert.ok(
  !/disabled=\{!dealerProfileForm\.ridingAcademyEnabled\}[\s\S]{0,200}jumpstartEnabled/.test(card.slice(0, cardEnd + 900)),
  "the Jumpstart toggle must not be disabled by the Riding Academy toggle — they are separate capabilities"
);

// --- 3) The runtime reads THAT key, executed against real profile shapes. ---
assert.ok(runtime.includes(KEY), "the runtime policy reader must name the same key the console writes");
assert.equal(
  readFirstTimeRiderPolicy({ policies: { firstTimeRider: { [KEY]: true } } }).jumpstartEnabled,
  true,
  "a ticked box must read back as enabled"
);
assert.equal(
  readFirstTimeRiderPolicy({ policies: { firstTimeRider: { [KEY]: false } } }).jumpstartEnabled,
  false,
  "an unticked box must read back as disabled"
);
assert.equal(
  readFirstTimeRiderPolicy({ policies: { firstTimeRider: {} } }).jumpstartEnabled,
  false,
  "a dealer who has never seen the box must default to NO — never offer equipment a store may not have"
);
// The exact round trip the console performs: form → saved profile → runtime.
for (const ticked of [true, false]) {
  const savedProfile = { policies: { firstTimeRider: { riderCourseName: "Riding Academy course", [KEY]: !!ticked } } };
  assert.equal(
    readFirstTimeRiderPolicy(savedProfile).jumpstartEnabled,
    ticked,
    `round trip: a box saved as ${ticked} must be read back as ${ticked}`
  );
  // Saving the toggle must not disturb the other rider-training settings on the same card.
  assert.equal(
    readFirstTimeRiderPolicy(savedProfile).courseName,
    "Riding Academy course",
    "saving the Jumpstart toggle must not clobber the course settings beside it"
  );
}

// --- 4) The two dealer-typed registration fields (Joe, 2026-08-05). ----------------------------
for (const field of ["registrationNote", "unpaidSeatPaymentMethods"] as const) {
  assert.ok(
    new RegExp(`\\n\\s+${field}: "",`).test(web),
    `the profile form must default ${field} to EMPTY — an unconfigured dealer says nothing extra`
  );
  assert.ok(
    new RegExp(`${field}: profile\\?\\.policies\\?\\.firstTimeRider\\?\\.${field} \\?\\? ""`).test(web),
    `the form must hydrate ${field} from policies.firstTimeRider`
  );
  assert.ok(
    new RegExp(`${field}: dealerProfileForm\\.${field}\\.trim\\(\\),`).test(web),
    `the save payload must write ${field} back, trimmed`
  );
  assert.ok(savePayload.includes(`${field}: dealerProfileForm.${field}.trim(),`), `${field} must save INSIDE firstTimeRider`);
  assert.ok(new RegExp(`maxLength=\\{${REGISTRATION_NOTE_MAX_CHARS}\\}`).test(web), "the inputs must cap length in the console");
  assert.equal(readFirstTimeRiderPolicy({ policies: { firstTimeRider: { [field]: "  hello  there " } } })[field], "hello there",
    `${field} must be normalised to one line`);
  assert.equal(readFirstTimeRiderPolicy({ policies: { firstTimeRider: { [field]: "x".repeat(REGISTRATION_NOTE_MAX_CHARS + 1) } } })[field], "",
    `an over-long ${field} must be DROPPED, never truncated mid-sentence`);
  assert.equal(readFirstTimeRiderPolicy({ policies: { firstTimeRider: {} } })[field], "", `${field} defaults to empty`);
}

// --- 5) Unpaid-seat detection: an ALLOWLIST of not-paid wordings. ------------------------------
// The store holds exactly two Payment Status values, both unpaid, and NO example of a paid one —
// so anything we cannot read plainly stays silent rather than telling someone their payment failed.
for (const [status, unpaid] of [
  ["Failed", true],
  ["Awaiting Payment at Dealer", true],
  ["Payment Declined", true],
  ["Paid", false],
  ["Complete", false],
  ["Paid in Full", false],
  ["", false],
  ["Something We Have Never Seen", false]
] as const) {
  assert.equal(
    enrollmentSeatIsUnpaid(`Enrollment Status: Enrolled-Payment Status: ${status}-Gender: Female`),
    unpaid,
    `enrollmentSeatIsUnpaid[${status || "(blank)"}]`
  );
}
assert.equal(enrollmentSeatIsUnpaid("Interested in a Street Glide"), false, "a lead with no enrollment record is not 'unpaid'");

console.log(
  "PASS jumpstart profile toggle eval — one key end to end (form default → hydrate → save → runtime read), off by default, independent of the course toggle"
);
