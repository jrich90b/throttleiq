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
  ansiraMarketingOptionSummary,
  findMissingFormControls,
  formatMissingControls,
  marketingActivityOptionIssue
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

// 8) Marketing-activity OPTION check (Phase A) — the live options observed 2026-06-17.
const liveOptions = ["-- Select --", "2026 Event Claim", "2026 Media Claim", "Minimum Advertised Price (MAP) Only"];
assert.equal(
  marketingActivityOptionIssue("2026 Media Claim", liveOptions),
  null,
  "required option present in the live dropdown → no issue"
);
assert.equal(
  marketingActivityOptionIssue("2026 Event Claim", liveOptions),
  null,
  "event option present → no issue"
);

// Mirrors the runner's `hasText` contains-match (and is whitespace/case-insensitive), so a
// decorated option text still matches and doesn't false-positive.
assert.equal(
  marketingActivityOptionIssue("2026 Media Claim", ["  2026   MEDIA claim  (FY26)"]),
  null,
  "contains-match tolerates decoration + case/whitespace, like the runner"
);

// Year rollover: the option Ansira renames first. Must be CAUGHT, name the required label,
// and list what's actually available so the fix is obvious.
const rollover = marketingActivityOptionIssue("2026 Media Claim", ["-- Select --", "2027 Event Claim", "2027 Media Claim"]);
assert.ok(rollover, "a year-rollover rename of the required option is detected");
assert.ok(rollover!.includes("2026 Media Claim"), "issue names the required option");
assert.ok(rollover!.includes("2027 Media Claim"), "issue lists the available options for diagnosis");

// Empty dropdown (broken form) → issue, not a silent pass.
assert.ok(marketingActivityOptionIssue("2026 Media Claim", []), "no options at all is reported");

// An empty required label (a claim type the deterministic path doesn't drive) → not our concern.
assert.equal(marketingActivityOptionIssue("", liveOptions), null, "empty required label is a no-op");

// The option-failure summary shares the safety shell: nothing saved, points at Ansira.
const optionSummary = ansiraMarketingOptionSummary(rollover!);
assert.ok(/no draft was created/i.test(optionSummary), "option summary states no draft was created");
assert.ok(/ansira/i.test(optionSummary), "option summary points at Ansira");
assert.ok(optionSummary.includes("2026 Media Claim"), "option summary carries the detail");

console.log("PASS mdf portal preflight eval");
