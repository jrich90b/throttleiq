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
  cdpConnectFailureSummary,
  cdpLooksBloated,
  findMissingFormControls,
  formatMissingControls,
  marketingActivityOptionIssue,
  missingActivityDatesSummary,
  pickAccountTileLabel,
  portalFormDidNotExpandSummary,
  portalRunDeadlineSummary
} from "./mdf_portal_preflight.ts";

const { findMdfPortalFailures } = await import("../services/api/src/domain/mdfPortalHealth.ts");

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

// ---------------------------------------------------------------------------
// 9) CDP browser-health classification — pins the 2026-07-06 production failure
//    (task agent_mr9o31de_1i5y8h): connectOverCDP died with a generic "Timeout
//    30000ms exceeded" because the dedicated runner Chrome had drifted into
//    daily-browsing use (119 debug targets / 35 tabs, incl. chrome:// pages) and
//    one hung target stalled Playwright's attach. The classifier must (a) not cry
//    wolf on a healthy session, (b) name the pile-up + the restart fix on the
//    observed failure shape, (c) classify a down Chrome distinctly, and (d) keep
//    every summary detectable by the mdf-portal-health anomaly feed.
// ---------------------------------------------------------------------------

// (a) The healthy post-restart shape (observed 2026-07-06: 14 targets / 2 tabs) is not bloated.
assert.equal(cdpLooksBloated({ reachable: true, targets: 14, pages: 2, chromePages: 0 }), false, "healthy runner Chrome is not classified bloated");

// (b) THE production failure shape: bloated, and the summary names the counts, the
//     drift cause, and the exact restart command — the operator's whole fix.
const bloatedStats = { reachable: true, targets: 119, pages: 35, chromePages: 2 };
assert.equal(cdpLooksBloated(bloatedStats), true, "the 2026-07-06 target pile-up is classified bloated");
const bloatedSummary = cdpConnectFailureSummary(bloatedStats, "browserType.connectOverCDP: Timeout 30000ms exceeded.");
assert.ok(bloatedSummary.includes("119 debug targets"), "bloated summary names the target count");
assert.ok(bloatedSummary.includes("35 tabs"), "bloated summary names the tab count");
assert.ok(/daily-browsing/i.test(bloatedSummary), "bloated summary names the drift cause");
assert.ok(bloatedSummary.includes("launchctl kickstart -k gui/501/ai.leadrider.hdnet-chrome"), "bloated summary carries the restart command");
assert.ok(bloatedSummary.includes("Timeout 30000ms exceeded"), "bloated summary preserves the original error");

// (c) Chrome down / no debug port → a distinct "not reachable" class with the same fix.
const downSummary = cdpConnectFailureSummary({ reachable: false, error: "fetch failed" });
assert.ok(/not reachable/i.test(downSummary), "down-Chrome summary says the port is not reachable");
assert.ok(downSummary.includes("launchctl kickstart"), "down-Chrome summary carries the restart command");

// A non-bloated attach failure (the unknown-cause residue) still gets the restart
// runbook rather than a bare stack trace.
const otherSummary = cdpConnectFailureSummary({ reachable: true, targets: 14, pages: 2 }, "kaboom");
assert.ok(/timed out/i.test(otherSummary), "non-bloated failure is described as a timed-out attach");
assert.ok(otherSummary.includes("launchctl kickstart"), "non-bloated failure carries the restart command");
assert.ok(otherSummary.includes("kaboom"), "non-bloated failure preserves the original error");

// (c2) Run-level watchdog — pins the 2026-07-06 POST-connect hang (Radio advertising
//      claim: attach succeeded, then a browser-level CDP call with no Playwright
//      default timeout wedged the tick 20+ min, silent, until manually killed). The
//      deadline summary must say the run timed out, carry the restart runbook, and
//      — because a watchdog abandonment cannot PROVE zero partial state the way the
//      form preflight can — tell the operator to verify the claims list before
//      re-running so a rare post-save hang can't double-draft.
const deadlineSummary = portalRunDeadlineSummary(10);
assert.ok(/timed out after 10 minutes/i.test(deadlineSummary), "deadline summary states the run timed out and after how long");
assert.ok(deadlineSummary.includes("launchctl kickstart"), "deadline summary carries the restart command");
assert.ok(/claims list/i.test(deadlineSummary) && /duplicate/i.test(deadlineSummary), "deadline summary tells the operator to verify the claims list against a duplicate draft");

// (c3) Activity-dates + expansion gates — pins the 2026-07-06 Promotional-apparel
//      blocker (task agent_mr9qnn3k_96w3kv): the packet had no activity dates, the
//      Ansira form keeps its whole body hidden until BOTH dates are set (verified by
//      live inspection — this was NOT form drift), and the fill died 30s later on a
//      hidden #activity-sub-detail. The missing-dates summary must name the claim,
//      the date-gate mechanism, that nothing was saved, and the human fix; the
//      no-expansion summary must distinguish "dates set but form stayed hidden".
const datesSummary = missingActivityDatesSummary("Promotional apparel — customer giveaway");
assert.ok(datesSummary.includes("Promotional apparel — customer giveaway"), "missing-dates summary names the claim");
assert.ok(/no activity start\/end dates/i.test(datesSummary), "missing-dates summary states the packet has no dates");
assert.ok(/hidden until both dates/i.test(datesSummary), "missing-dates summary explains the date-gate mechanism");
assert.ok(/no draft was created/i.test(datesSummary), "missing-dates summary states nothing was saved");
assert.ok(/add the activity dates/i.test(datesSummary), "missing-dates summary tells the operator the fix");

const noExpandSummary = portalFormDidNotExpandSummary();
assert.ok(/set both activity dates/i.test(noExpandSummary), "no-expansion summary says the dates WERE set (distinct from the missing-dates class)");
assert.ok(/did not expand/i.test(noExpandSummary), "no-expansion summary names the failure");
assert.ok(/no draft was created/i.test(noExpandSummary), "no-expansion summary states nothing was saved");

// Both are blocked-path summaries: the runner emits them under the rescue/blocked
// shell ("... blocked before completion"), which the detector's LOAD_FAILURE_RE
// keys on — assert that parity the way the runner actually emits them.
for (const [label, blockedSummary] of [
  ["missing-dates", datesSummary],
  ["no-expansion", noExpandSummary]
] as const) {
  const flagged = findMdfPortalFailures({
    tasks: [
      {
        id: `eval_${label}`,
        kind: "mdf_portal",
        status: "needs_approval",
        updatedAt: new Date().toISOString(),
        output: { summary: `Deterministic MDF portal runner blocked before completion.\n\n${blockedSummary}` }
      }
    ] as any
  });
  assert.equal(flagged.length, 1, `${label} summary is still detected by mdf-portal-health`);
  assert.equal(flagged[0].dimension, "mdf_assistant_failure", `${label} summary maps to mdf_assistant_failure`);
}

// (d) CONSOLE-PARITY with the anomaly feed: every classified summary — wrapped the
//     way the runner's catch block wraps it into the blocked task — must still trip
//     the mdf-portal-health detector (LOAD_FAILURE_RE), or classification would
//     silently drop these runs from the daily review.
for (const [label, summary] of [
  ["bloated", bloatedSummary],
  ["down", downSummary],
  ["other", otherSummary],
  ["deadline", deadlineSummary]
] as const) {
  const flagged = findMdfPortalFailures({
    tasks: [
      {
        id: `eval_${label}`,
        kind: "mdf_portal",
        status: "needs_approval",
        updatedAt: new Date().toISOString(),
        output: { summary: `Automatic MDF portal runner failed before completion: ${summary}` }
      }
    ] as any
  });
  assert.equal(flagged.length, 1, `${label} classified summary is still detected by mdf-portal-health`);
  assert.equal(flagged[0].dimension, "mdf_assistant_failure", `${label} summary maps to mdf_assistant_failure`);
}

// ---------------------------------------------------------------------------
// 10) Account-picker tile choice (saved-login click-through) — pins the 2026-07-06
//     gap: a fresh Microsoft sign-in opens on "Pick an account" and the credential-
//     free click-through stopped one tile short of the autofilled-password step.
//     Tile choice must be deterministic and conservative: sole dealer tile wins,
//     ambiguity NEVER auto-picks (fail toward the human, like an unfillable
//     password), and non-account chrome ("Use another account") never matches.
// ---------------------------------------------------------------------------

// The live 2026-07-06 picker: one dealer tile + Microsoft's chrome buttons.
assert.equal(
  pickAccountTileLabel(["Sign in with j.hartri3@h-dnet.com work or school account.", "Open menu", "Use another account"]),
  "Sign in with j.hartri3@h-dnet.com work or school account.",
  "the sole @h-dnet.com tile is picked"
);
// A personal account alongside the dealer tile → dealer wins.
assert.equal(
  pickAccountTileLabel(["Sign in with joe@gmail.com personal account.", "Sign in with j.hartri3@h-dnet.com work or school account.", "Use another account"]),
  "Sign in with j.hartri3@h-dnet.com work or school account.",
  "the dealer-domain tile wins over a personal account"
);
// No dealer tile but exactly one account → that one (single-account machine).
assert.equal(
  pickAccountTileLabel(["Sign in with joe@example.com work or school account.", "Use another account"]),
  "Sign in with joe@example.com work or school account.",
  "a sole account tile is picked when no dealer tile exists"
);
// TWO dealer tiles (or two accounts, none dealer) = ambiguous → null → human.
assert.equal(
  pickAccountTileLabel(["a@h-dnet.com", "b@h-dnet.com"]),
  null,
  "two dealer tiles is ambiguous — never auto-pick"
);
assert.equal(
  pickAccountTileLabel(["a@example.com", "b@example.com"]),
  null,
  "two non-dealer accounts is ambiguous — never auto-pick"
);
// Only chrome buttons (no @) → null.
assert.equal(pickAccountTileLabel(["Use another account", "Open menu", "Back"]), null, "non-account buttons never match");
assert.equal(pickAccountTileLabel([]), null, "empty picker → null");

console.log("PASS mdf portal preflight eval");
