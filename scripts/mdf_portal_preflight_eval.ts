/**
 * MDF portal preflight eval (deterministic — no LLM, no browser).
 *
 * Pins the Ansira Create-MDF-Recap structural guard (scripts/mdf_portal_preflight.ts)
 * that runs before the deterministic Playwright filler touches the form. Origin:
 * Ansira is a third-party portal we don't control; a form-layout change there would
 * otherwise crash the filler mid-fill or trip a save-time FK error after partially
 * building the form. The preflight must (a) cover the load-bearing controls, (b)
 * report EVERY missing control (not just the first) so an operator sees the full
 * diff after a redesign, (c) make clear nothing was saved, and (d) pass cleanly when
 * all controls are present.
 */
import assert from "node:assert/strict";
import {
  ANSIRA_FORM_CONTROLS,
  ansiraFormChangedSummary,
  findMissingFormControls,
  formatMissingControls
} from "./mdf_portal_preflight.ts";

// 1) The guard must cover the controls the filler actually reads/writes — including
//    the Save button, the only persistence point, whose absence is the worst case.
const covered = new Set(ANSIRA_FORM_CONTROLS.map(control => control.selector));
for (const required of [
  "#app-marketing-activity",
  "#app-claim-name",
  "#app-claimed-amount",
  'input[name="invoices[1][vendor_name]"]',
  'input[type="file"][name="files[]"]',
  "#app-draft-submit-btn"
]) {
  assert.ok(covered.has(required), `preflight must cover load-bearing control ${required}`);
}

// 2) All present → nothing missing → the run proceeds normally.
const allPresent = await findMissingFormControls(ANSIRA_FORM_CONTROLS, () => true);
assert.equal(allPresent.length, 0, "when every control is present, preflight reports nothing missing");

// 3) A single renamed control (simulate Ansira renaming the Save button) is detected,
//    not swallowed, and identified by selector.
const renamedSave = (selector: string) => selector !== "#app-draft-submit-btn";
const missingSave = await findMissingFormControls(ANSIRA_FORM_CONTROLS, renamedSave);
assert.equal(missingSave.length, 1, "a single missing control is detected");
assert.equal(missingSave[0].selector, "#app-draft-submit-btn", "the missing control is identified by selector");

// 4) Reports ALL missing controls, not just the first (operator needs the full diff
//    after a wholesale redesign).
const everythingGone = await findMissingFormControls(ANSIRA_FORM_CONTROLS, () => false);
assert.equal(
  everythingGone.length,
  ANSIRA_FORM_CONTROLS.length,
  "every missing control is reported, not just the first"
);

// 5) The operator summary names the missing control, points at Ansira as the cause,
//    and is explicit that nothing was saved (zero partial state — the safety promise).
const summary = ansiraFormChangedSummary(missingSave);
assert.ok(summary.includes("#app-draft-submit-btn"), "summary names the missing selector");
assert.ok(/no draft was created/i.test(summary), "summary states no draft was created");
assert.ok(/ansira/i.test(summary), "summary points at the Ansira form as the cause");

// 6) Async existence predicate is supported (the runner passes an async
//    page.locator().count() check).
const asyncMissing = await findMissingFormControls(ANSIRA_FORM_CONTROLS, async selector =>
  Promise.resolve(selector !== "#app-claim-name")
);
assert.equal(asyncMissing.length, 1, "async existence predicate works");
assert.equal(asyncMissing[0].selector, "#app-claim-name", "async predicate identifies the missing control");

// 7) The formatted list pairs a human label with the selector.
const formatted = formatMissingControls(everythingGone);
assert.ok(
  formatted.includes("Save for Later") && formatted.includes("(#app-draft-submit-btn)"),
  "formatted list pairs label + selector"
);

console.log("PASS mdf portal preflight eval");
