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
import fs from "node:fs";
import path from "node:path";
import {
  ANSIRA_CLAIMS_LIST_URL,
  MDF_TOOLBOX_LINK_TEXT,
  ANSIRA_FORM_CONTROLS,
  ANSIRA_POST_DATE_FORM_CONTROLS,
  ansiraFormChangedSummary,
  ansiraMarketingOptionSummary,
  cdpConnectFailureSummary,
  cdpLooksBloated,
  findMissingFormControls,
  formatMissingControls,
  isExpiredSessionLanding,
  isSignInPageText,
  marketingActivityOptionIssue,
  marketingActivityFailure,
  marketingActivityFailureSummary,
  missingActivityDatesSummary,
  pickAccountTileLabel,
  portalFormDidNotExpandSummary,
  portalRunDeadlineSummary,
  portalRunDeadlineMs,
  runnerChromeRestartHint,
  PORTAL_RUN_MAX_MS,
  sessionExpiredSummary
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
// 8b) CLAIM-YEAR MISMATCH vs. Ansira form drift (2026-08-01 production).
//
// Four "250 Years of Freedom" portal runs blocked on 2026-07-31 (agent_ms9dixrw_a0t5dh,
// agent_ms9foivd_7qsqd8, agent_ms9fzccl_qn2lhr) and every one told the operator the Ansira
// form had changed and to update the runner's selectors. It had not changed. The runner asked
// for "2020 Event Claim" — the packet's activity dates extracted as 07/18/2020 off a single
// mis-read invoice (the event was 07/18/2026) — while Ansira offered exactly what it always
// offers. Blaming the portal sends the human to inspect a form that is fine.
// ---------------------------------------------------------------------------
const PROD_OPTIONS_20260731 = [
  "-- Select --",
  "2026 Event Claim",
  "2026 Media Claim",
  "Minimum Advertised Price (MAP) Only"
];

const yearMismatch = marketingActivityFailure("2020 Event Claim", PROD_OPTIONS_20260731);
assert.ok(yearMismatch, "the 7/31 production failure is still caught");
assert.equal(yearMismatch!.kind, "claim_year_mismatch", "it is classified as a CLAIM-year problem, not form drift");
assert.equal(yearMismatch!.requestedYear, "2020", "names the year the runner asked for");
assert.deepEqual(yearMismatch!.offeredYears, ["2026"], "names the year Ansira actually offers for that family");

const mismatchSummary = marketingActivityFailureSummary(yearMismatch!);
assert.ok(/no draft was created/i.test(mismatchSummary), "year-mismatch summary states nothing was saved");
assert.ok(
  !/form changed|update the runner's selectors|re-inspect the form/i.test(mismatchSummary),
  "year-mismatch summary must NOT blame Ansira or ask for a selector update"
);
assert.ok(/activity (start\/end )?dates/i.test(mismatchSummary), "year-mismatch summary points at the claim's activity dates");
assert.ok(mismatchSummary.includes("2020") && mismatchSummary.includes("2026"), "summary carries both years");

// A genuine Ansira rollover rename — every year in the dropdown moves — is NOT a claim-year
// mismatch: there is no same-family option in another year that the claim could belong to...
// except that IS the rollover case, so the discriminator is which side is out of date. A claim
// whose year is absent while the portal offers a LATER year is still the claim's problem to
// fix (change the dates or wait for the new option); the drift wording is reserved for a
// dropdown that no longer offers the family AT ALL.
const familyGone = marketingActivityFailure("2026 Media Claim", ["-- Select --", "Co-op Reimbursement", "MAP Only"]);
assert.ok(familyGone, "a dropdown with no matching claim family is caught");
assert.equal(familyGone!.kind, "option_missing", "family gone entirely => real Ansira drift wording");
assert.ok(
  /form changed|re-inspect the form/i.test(marketingActivityFailureSummary(familyGone!)),
  "genuine drift keeps the Ansira wording (fail direction: never soften a real portal change)"
);

// An empty dropdown (broken/blank form) must stay in the drift class too.
assert.equal(
  marketingActivityFailure("2026 Media Claim", [])!.kind,
  "option_missing",
  "empty dropdown is drift, not a claim-year problem"
);

// Present option => no failure at all, both APIs agree.
assert.equal(marketingActivityFailure("2026 Event Claim", PROD_OPTIONS_20260731), null, "present option => null");
assert.equal(
  marketingActivityOptionIssue("2026 Event Claim", PROD_OPTIONS_20260731),
  null,
  "legacy string API stays in sync with the classifier"
);

// The classified summary must still reach the daily review: the mdf-portal-health detector
// keys on the blocked shell, so a year-mismatch run cannot silently vanish from the feed.
{
  const flagged = findMdfPortalFailures({
    tasks: [
      {
        id: "eval_claim_year_mismatch",
        kind: "mdf_portal",
        status: "needs_approval",
        updatedAt: new Date().toISOString(),
        output: { summary: `Deterministic MDF portal runner blocked before completion.\n\n${mismatchSummary}` }
      }
    ] as any
  });
  assert.equal(flagged.length, 1, "year-mismatch summary is still detected by mdf-portal-health");
  assert.equal(flagged[0].dimension, "mdf_assistant_failure", "year-mismatch maps to mdf_assistant_failure");
}

// The runner must route through the CLASSIFIER, not the old unclassified string helper —
// otherwise this whole distinction is dead code and the misdiagnosis comes straight back.
{
  const runnerSource = fs.readFileSync(path.resolve("scripts/mdf_portal_runner.ts"), "utf8");
  assert.ok(
    runnerSource.includes("marketingActivityFailureSummary(optionFailure)"),
    "the runner emits the CLASSIFIED marketing-activity summary"
  );
  assert.ok(
    !/ansiraMarketingOptionSummary\(/.test(runnerSource),
    "the runner no longer emits the unclassified Ansira-drift summary directly"
  );
}

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
assert.ok(bloatedSummary.includes(runnerChromeRestartHint()), "bloated summary carries the restart command for THIS platform");
assert.ok(bloatedSummary.includes("Timeout 30000ms exceeded"), "bloated summary preserves the original error");

// (c) Chrome down / no debug port → a distinct "not reachable" class with the same fix.
const downSummary = cdpConnectFailureSummary({ reachable: false, error: "fetch failed" });
assert.ok(/not reachable/i.test(downSummary), "down-Chrome summary says the port is not reachable");
assert.ok(downSummary.includes(runnerChromeRestartHint()), "down-Chrome summary carries the restart command for THIS platform");

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
assert.ok(deadlineSummary.includes(runnerChromeRestartHint()), "deadline summary carries the restart command for THIS platform");
assert.ok(/claims list/i.test(deadlineSummary) && /duplicate/i.test(deadlineSummary), "deadline summary tells the operator to verify the claims list against a duplicate draft");

// (c2b) The deadline must SAY what it was doing. Blaming Chrome unconditionally sent an
//       operator hunting a browser problem that did not exist, when the real cause was a
//       12-file claim overrunning a budget sized for 3-4 minute runs (sales2, 2026-07-31).
const stepSummary = portalRunDeadlineSummary(10, "uploading invoice row 3 of 6 (Invoice-3.pdf)");
assert.ok(/still working on: uploading invoice row 3 of 6/.test(stepSummary), "deadline names the step it was on");
assert.ok(!/Chrome stopped responding/.test(stepSummary), "it does not blame Chrome when a step was in flight");
assert.ok(/timed out/i.test(stepSummary), "the health detector's 'timed out' phrase survives");
assert.ok(/Chrome stopped responding/.test(deadlineSummary), "with no step in flight, the Chrome-hang wording is kept");

// (c2c) The budget scales with the WORK. A fixed 10 min could never fit a 12-file claim, so
//       every such run was killed mid-upload and reported as a hang.
assert.ok(portalRunDeadlineMs(12) > portalRunDeadlineMs(0), "more files buy more time");
assert.equal(portalRunDeadlineMs(0), 10 * 60_000, "a claim with no files keeps the original budget");
assert.ok(portalRunDeadlineMs(12) >= 19 * 60_000, "a 12-file claim gets materially more than the old fixed 10 minutes");
assert.equal(portalRunDeadlineMs(10_000), PORTAL_RUN_MAX_MS, "the budget is capped so a bad file count cannot hang a tick forever");
assert.equal(portalRunDeadlineMs(-5), 10 * 60_000, "a nonsense file count falls back to the base budget");

// (c2d) Restart instructions must match the DEALER'S platform. A Windows dealer was told to run
//       `launchctl` — a command that cannot exist on their machine (sales2, 2026-07-31).
const winHint = runnerChromeRestartHint("win32");
assert.ok(/schtasks \/Run \/TN "LeadRider MDF Chrome"/.test(winHint), "Windows gets a Windows restart command");
assert.ok(!/launchctl/.test(winHint), "no macOS command is shown to a Windows dealer");
assert.ok(/launchctl kickstart/.test(runnerChromeRestartHint("darwin")), "macOS keeps its launchctl command");

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

// ---------------------------------------------------------------------------
// 11) Session-expiry preflight — pins the dominant 30d failure class (4 of the 8
//     most recent failures: agent_mr3s6tv6 7/2 + agent_mrp010rb / agent_mrp0cs8u /
//     agent_mrp0czzy 7/17): an expired H-DNet/Ansira session discovered only after
//     a full run burned. The pure classifier must (a) fire on every observed
//     sign-in landing shape (SSO-host redirect, Ansira /auth/login route, inline
//     sign-in form text), (b) NEVER fire on a logged-in Ansira landing or an
//     unreadable probe (fail-open — a false "expired" would turn away a live
//     session), and (c) emit a summary the anomaly feed still classifies.
// ---------------------------------------------------------------------------

// The probe target is the claims list the operator is told to verify — same URL,
// one source of truth.
assert.equal(
  ANSIRA_CLAIMS_LIST_URL,
  "https://app.ansira.com/member/reimbursements/claims",
  "the session probe targets the Ansira claims list"
);

// (a1) Expired session redirects to the H-DNet SSO host (Microsoft) — decisive on
//      URL alone, even when the body is unreadable.
assert.equal(
  isExpiredSessionLanding({
    finalUrl: "https://login.microsoftonline.com/625f2ee0-190f-4e6f-9cbb-be276a887c4d/oauth2/authorize?client_id=abc",
    bodyText: ""
  }),
  true,
  "a redirect to the Microsoft SSO host is an expired session"
);

// (a2) Ansira's own login route.
assert.equal(
  isExpiredSessionLanding({ finalUrl: "https://app.ansira.com/auth/login?returnTo=%2Fmember%2Freimbursements%2Fclaims" }),
  true,
  "a redirect to Ansira's /auth/login route is an expired session"
);

// (a3) Inline auth wall: URL unchanged but the body is a sign-in form — the same
//      text markers the runner's in-run login check uses.
assert.equal(
  isExpiredSessionLanding({
    finalUrl: ANSIRA_CLAIMS_LIST_URL,
    bodyText: "Sign in\nEnter your email or phone\nNext\nCan't access your account?"
  }),
  true,
  "an inline sign-in form at the claims URL is an expired session"
);

// (b1) The logged-in claims list ("Create MDF Recap" button, claim rows) is NOT
//      a sign-in landing.
assert.equal(
  isExpiredSessionLanding({
    finalUrl: ANSIRA_CLAIMS_LIST_URL,
    bodyText: "MDF Recaps\nCreate MDF Recap\nClaim Name\nStatus\nClaimed Amount\nDraft"
  }),
  false,
  "the logged-in claims list is not classified expired"
);

// (b2) Fail-open: an unreadable/empty body with an unremarkable URL never blocks —
//      downstream in-run detection still applies.
assert.equal(
  isExpiredSessionLanding({ finalUrl: ANSIRA_CLAIMS_LIST_URL, bodyText: "" }),
  false,
  "an unreadable probe body fails open (never blocks the run)"
);

// (b3) The "Create Claim" exclusion: the logged-in create form legitimately
//      mentions e.g. Microsoft-hosted assets — must not read as a login screen.
assert.equal(
  isSignInPageText("Create Claim\nMarketing Activity\nfonts served by Microsoft\nSave for Later"),
  false,
  "the create form mentioning 'microsoft' is excluded by the Create Claim marker"
);
assert.equal(
  isSignInPageText("Sign in to continue\nPassword\nForgot my password"),
  true,
  "a real sign-in form still matches the shared text markers"
);

// (c) The operator summary: names the sign-in screen + expired session, says
//     nothing was saved, and carries the whole fix (log in via the runner Chrome,
//     verify the claims list, press Start again).
const expiredSummary = sessionExpiredSummary("session preflight, before any fill");
assert.ok(/sign-in screen/i.test(expiredSummary), "expired-session summary names the sign-in screen");
assert.ok(/session has expired/i.test(expiredSummary), "expired-session summary names the expiry");
assert.ok(/no draft was created/i.test(expiredSummary), "expired-session summary states nothing was saved");
assert.ok(expiredSummary.includes("h-dnet.com"), "expired-session summary tells the operator where to log in");
assert.ok(expiredSummary.includes("app.ansira.com/member/reimbursements/claims"), "expired-session summary tells the operator what to verify");
assert.ok(/start portal draft again/i.test(expiredSummary), "expired-session summary tells the operator to press Start again");
assert.ok(expiredSummary.includes("session preflight, before any fill"), "expired-session summary carries WHERE it was caught");

// Anomaly-feed parity, both ways the runner records it: the preflight abort writes
// a BLOCKED task; the in-run detection surfaces via the blocked/needs_approval
// shells. All must keep tripping the mdf-portal-health detector.
const blockedFlagged = findMdfPortalFailures({
  tasks: [
    {
      id: "eval_session_blocked",
      kind: "mdf_portal",
      status: "blocked",
      updatedAt: new Date().toISOString(),
      output: { summary: expiredSummary }
    }
  ] as any
});
assert.equal(blockedFlagged.length, 1, "a session-preflight blocked task is detected by mdf-portal-health");
assert.equal(blockedFlagged[0].dimension, "mdf_assistant_failure", "session-preflight block maps to mdf_assistant_failure");

const fallbackFlagged = findMdfPortalFailures({
  tasks: [
    {
      id: "eval_session_fallback",
      kind: "mdf_portal",
      status: "needs_approval",
      updatedAt: new Date().toISOString(),
      output: { summary: `Automatic MDF portal runner failed before completion: ${sessionExpiredSummary("recap list")}` }
    }
  ] as any
});
assert.equal(fallbackFlagged.length, 1, "the in-run expired-session summary still trips LOAD_FAILURE_RE under needs_approval");
assert.equal(fallbackFlagged[0].dimension, "mdf_assistant_failure", "in-run expired-session summary maps to mdf_assistant_failure");

console.log("PASS mdf portal preflight eval");

// === Reliability rework (2026-07-29): year extraction, rescue reason, session-retry policy ===
{
  const {
    activityYearFromDates,
    composeRescueSummary,
    pruneSessionRetryQueue,
    upsertSessionRetryEntry,
    sessionExpiredAutoRetrySummary,
    SESSION_RETRY_MAX_ATTEMPTS
  } = await import("./mdf_portal_preflight.ts");
  const fsx = await import("node:fs");

  // 1) Year extraction — the "06/0 Media Claim" bug (US-format packet dates) + rollover safety.
  assert.equal(activityYearFromDates("2026-06-01", "2026-06-30", 2020), "2026", "ISO date year");
  assert.equal(activityYearFromDates("06/01/2026", "06/30/2026", 2020), "2026", "US-format date year (the 06/0 bug)");
  assert.equal(activityYearFromDates("", "12/31/2027", 2020), "2027", "falls to the end date");
  assert.equal(activityYearFromDates("junk", null, 2025), "2025", "no year anywhere => fallback");
  // The two consumers no longer mangle/hardcode the year.
  const runnerSrc = fsx.readFileSync("scripts/mdf_portal_runner.ts", "utf8");
  assert.ok(!/activityStartDate ?\?\? ""\)\.slice\(0, ?4\)/.test(runnerSrc), "buildPrompt no longer slices the raw date for the year");
  assert.ok(!/return "2026 Media Claim"/.test(runnerSrc), "portalClaimTypeLabel no longer hardcodes 2026");
  assert.ok(/const year = activityYearFromDates\(/.test(runnerSrc), "portalClaimTypeLabel derives the year from the claim dates");

  // 2) Rescue keeps the WHY. (Every 7/17 blocked task read a generic summary with no cause.)
  const composed = composeRescueSummary("Timeout 30000ms exceeded at #app-claim-name", "Guided packet opened for manual completion.");
  assert.ok(composed.includes("Why automation stopped: Timeout 30000ms exceeded"), "rescue summary carries the failure reason");
  assert.ok(composed.startsWith("Guided packet opened"), "rescue instructions still lead");
  assert.equal(composeRescueSummary("", "rescue only"), "rescue only", "no reason => rescue text unchanged");
  assert.ok(/composeRescueSummary\(result\.summary, rescue\.summary\)/.test(runnerSrc), "the rescue-success task summary includes the failure reason");

  // 3) Session-retry queue policy: prune stale/exhausted; upsert is idempotent.
  const now = Date.now();
  const fresh = { taskId: "t1", claimId: "c1", blockedAtMs: now - 60_000, attempts: 0 };
  const stale = { taskId: "t2", claimId: "c2", blockedAtMs: now - 8 * 24 * 60 * 60 * 1000, attempts: 0 };
  const exhausted = { taskId: "t3", claimId: "c3", blockedAtMs: now - 60_000, attempts: SESSION_RETRY_MAX_ATTEMPTS };
  const pruned = pruneSessionRetryQueue([fresh, stale, exhausted], now);
  assert.deepEqual(pruned.map(e => e.taskId), ["t1"], "stale + attempt-exhausted entries are pruned");
  const once = upsertSessionRetryEntry([], { taskId: "t9", claimId: "c9" }, now);
  const twice = upsertSessionRetryEntry(once, { taskId: "t9", claimId: "c9" }, now + 1);
  assert.equal(twice.length, 1, "upsert is idempotent on taskId");

  // 4) The auto-retry summary keeps the health-detector's expired-session wording AND tells the
  //    human the retry is automatic (no re-clicking Start portal draft).
  const autoSummary = sessionExpiredAutoRetrySummary("session preflight, before any fill");
  assert.ok(/session has expired/.test(autoSummary), "auto-retry summary keeps the load-failure wording");
  assert.ok(/retry this claim automatically/.test(autoSummary), "auto-retry summary promises the automatic retry");
  const autoFlagged = findMdfPortalFailures({
    tasks: [
      {
        id: "eval_auto_retry_block",
        kind: "mdf_portal",
        status: "blocked",
        updatedAt: new Date().toISOString(),
        output: { summary: autoSummary }
      }
    ] as any
  });
  assert.equal(autoFlagged.length, 1, "the auto-retry blocked summary still trips the mdf-portal-health detector");

  // 5) Wiring invariants: preflight-block opens the login page + queues the retry; the idle tick
  //    picks the retry up; packet tabs are cleaned; the daemon heals Chrome + backs off + heartbeats.
  assert.ok(/openLoginPageForSessionRecovery\(options\.cdpUrl, options\.portalUrl\)/.test(runnerSrc), "preflight block auto-opens the login page");
  assert.ok(/recordSessionRetryCandidate\(task\.id, claimId\)/.test(runnerSrc), "preflight block queues the auto-retry");
  assert.ok(/pickSessionRetryTask\(tasks, options\)/.test(runnerSrc), "the idle tick picks up a waiting retry");
  assert.ok(/url\.startsWith\("file:\/\/"\) && url\.includes\("mdf_portal_runs"\)/.test(runnerSrc), "stale guided-packet tabs are closed at attach");
  const daemonSrc = fsx.readFileSync("scripts/mdf_portal_runner_daemon.ts", "utf8");
  assert.ok(/kickstart", "-k", `gui\/\$\{uid\}\/ai\.leadrider\.hdnet-chrome`/.test(daemonSrc) || /ai\.leadrider\.hdnet-chrome/.test(daemonSrc), "daemon auto-heals the dead runner Chrome");
  assert.ok(/backoffUntil = Date\.now\(\) \+ failureBackoffMs/.test(daemonSrc), "daemon backs off after consecutive failures");
  assert.ok(/MDF_PORTAL_QUIET_IDLE: "1"/.test(daemonSrc), "daemon silences the per-tick idle line");
  assert.ok(/heartbeat: alive/.test(daemonSrc), "daemon prints an hourly heartbeat");
}

console.log("PASS mdf portal reliability additions");

// === Windows runner port (2026-07-29): OS-aware download + the .bat/PowerShell installer +
// the daemon's cross-platform pieces. Joe hit the dead macOS .sh on a dealership Windows
// desktop testing the rollout scenario; Windows now gets a real installer. ===
{
  const fsx = await import("node:fs");
  const { buildWindowsInstallerBat, buildWindowsInstallerPs1 } = await import(
    "../services/api/src/domain/mdfRunnerWindowsInstaller.ts"
  );

  // 1) The console button is OS-aware: Windows gets the .bat, not the macOS .sh.
  const webSrc = fsx.readFileSync("apps/web/src/app/page.tsx", "utf8");
  assert.ok(
    /if \(\/Windows\/i\.test\(ua\)\) \{[\s\S]{0,700}?install-windows[\s\S]{0,200}?return;/.test(webSrc),
    "a Windows visitor downloads the Windows installer (install-windows), never the macOS .sh"
  );
  assert.ok(/SmartScreen/.test(webSrc), "the Windows notice explains the SmartScreen run-anyway step");

  // 2) The installer builder emits a well-formed double-clickable .bat + PowerShell payload.
  const args = {
    apiBase: "https://api.example.leadrider.ai",
    runnerToken: "tok_eval_123",
    repoUrl: "https://github.com/jrich90b/throttleiq.git",
    branch: "main"
  };
  const bat = buildWindowsInstallerBat(args);
  assert.ok(bat.startsWith("@echo off"), "bat header first (double-clickable)");
  assert.ok(bat.includes("::PS1::"), "bat carries the payload marker");
  assert.ok(bat.includes("-ExecutionPolicy Bypass -File"), "bat runs the extracted payload with Bypass");
  assert.ok(bat.includes("\r\n"), "bat uses CRLF line endings (cmd.exe requirement)");
  const ps1 = buildWindowsInstallerPs1(args);
  assert.ok(ps1.includes("MDF_PORTAL_RUNNER_TOKEN=tok_eval_123"), "payload embeds the runner token in .env");
  assert.ok(ps1.includes("MDF_PORTAL_API_BASE_URL=https://api.example.leadrider.ai"), "payload embeds the API base");
  assert.ok(ps1.includes("MDF_PORTAL_CDP_URL=http://127.0.0.1:9222"), "payload configures the CDP url");
  assert.ok(/Register-ScheduledTask -TaskName "LeadRider MDF Chrome"/.test(ps1), "dedicated CDP Chrome scheduled task");
  assert.ok(/--remote-debugging-port=9222/.test(ps1), "Chrome starts with the CDP port");
  assert.ok(/Register-ScheduledTask -TaskName "LeadRider MDF Runner"/.test(ps1), "daemon scheduled task");
  assert.ok(/Register-ScheduledTask -TaskName "LeadRider MDF Runner Watchdog"/.test(ps1), "5-minute keep-alive watchdog task");
  // ELEVATION. Register-ScheduledTask needs admin; without it the installer completes the clone
  // and npm install and then dies on the LAST step with "Access is denied" (HRESULT 0x80070005),
  // registering no task — so the runner never starts, never contacts the server, and the console
  // shows only "no active runner". Joe hit this 17 times on a real dealership PC (2026-07-31).
  // The check must come BEFORE any Register-ScheduledTask call, or the failure returns.
  assert.ok(
    /WindowsBuiltInRole\]::Administrator/.test(ps1),
    "installer checks for administrator rights (Register-ScheduledTask fails without them)"
  );
  assert.ok(
    /Start-Process .*-Verb RunAs/.test(ps1),
    "installer re-launches itself elevated instead of failing at the last step"
  );
  assert.ok(
    ps1.indexOf("WindowsBuiltInRole]::Administrator") < ps1.indexOf("Register-ScheduledTask"),
    "the elevation check runs BEFORE the first Register-ScheduledTask, not after the work is done"
  );
  assert.ok(
    /Run as administrator/.test(ps1),
    "if elevation is declined the installer names the exact manual fix"
  );
  // CHECK-IN. Registration otherwise happens ONLY when the daemon polls, so a successful install
  // whose auto-start failed is indistinguishable in the console from no install at all — both read
  // "no active runner". That ambiguity cost an afternoon (Joe, 2026-07-31).
  assert.ok(
    /Invoke-WebRequest -Uri '[^']*\/mdf\/portal-runner\/tasks/.test(ps1),
    "installer checks in with the server so the computer appears in the console"
  );
  assert.ok(
    /"x-mdf-portal-token" = 'tok_eval_123'/.test(ps1),
    "the check-in authenticates with the runner token"
  );
  assert.ok(
    /mdf-runner-machine\.json/.test(ps1),
    "the check-in uses the SAME identity file the runner reads, so both agree on the machine"
  );
  assert.ok(
    /if \(-not \(Test-Path \$IdentityPath\)\)/.test(ps1),
    "an existing machine identity is never overwritten (the id must stay stable across re-installs)"
  );
  assert.ok(
    /The runner will register itself once it starts/.test(ps1),
    "a failed check-in never fails the install — it is a reporting nicety, not a gate"
  );
  assert.ok(/log in there now/.test(ps1), "installer tells the human the one manual step (H-DNet login)");
  assert.ok(/only ONE runner computer/.test(ps1), "installer surfaces the single-runner rule");
  assert.ok(!/launchctl/.test(ps1), "no macOS plumbing leaks into the Windows payload");
  assert.ok(!/—|’|“/.test(ps1), "payload stays ASCII-safe (bat extraction re-encodes)");
  // PowerShell backticks would be corrupted by the TS template-literal embedding — the builder's
  // quoting rule is concatenated single-quoted pieces, never backticks.
  assert.ok(!ps1.includes("`"), "no PowerShell backticks in the payload (TS-template embedding rule)");

  // 2b) Prerequisites install THEMSELVES (Joe 2026-07-31). The first real-Windows run died at
  // "Git is required", sending a non-technical dealer to two download pages. winget now installs
  // Chrome/Git/Node in place. Two properties are load-bearing and pinned here:
  //   (a) PATH is re-read from the registry after an install, or the same session still can't
  //       see the new tool and the installer would false-fail the very thing it just installed;
  //   (b) the manual-URL fallback SURVIVES for every tool — winget is missing on older Windows
  //       and can be declined at the UAC prompt, and failing toward a clear instruction beats
  //       proceeding half-installed.
  for (const [id, name] of [
    ["Google.Chrome", "Chrome"],
    ["Git.Git", "Git"],
    ["OpenJS.NodeJS.LTS", "Node.js"]
  ] as const) {
    assert.ok(ps1.includes(id), `${name} is auto-installed via its winget id (${id})`);
  }
  assert.ok(
    /winget install -e --id \$WingetId --silent --accept-package-agreements --accept-source-agreements/.test(ps1),
    "winget runs unattended (silent + both agreement flags) so a dealer never sees a prompt-loop"
  );
  assert.ok(
    /GetEnvironmentVariable\("Path", "Machine"\)/.test(ps1) && /GetEnvironmentVariable\("Path", "User"\)/.test(ps1),
    "PATH is re-read from the registry after install, so the running session sees the new tool"
  );
  for (const url of ["https://git-scm.com/download/win", "https://nodejs.org/", "https://www.google.com/chrome/"]) {
    assert.ok(ps1.includes(url), `manual-download fallback survives for ${url} (winget may be absent or declined)`);
  }
  // Pin the CONSTRUCT, not a file-wide count: Git and Node share one Ensure-Command helper, so
  // counting exit blocks would forbid exactly the reuse we want (see the eval-source-count
  // brittleness lesson). What must hold is that BOTH paths to a missing tool fail closed.
  assert.ok(
    /Ensure-Command -CommandName "git"/.test(ps1) && /Ensure-Command -CommandName "npm"/.test(ps1),
    "Git and Node both route through the ensure-then-fail-closed helper"
  );
  for (const block of [
    ps1.slice(ps1.indexOf("function Ensure-Command")),
    ps1.slice(ps1.indexOf("$Chrome = Find-Chrome"))
  ]) {
    assert.ok(
      /could not be installed automatically[\s\S]{0,400}?Read-Host "Press Enter to exit"[\s\S]{0,40}?exit 1/.test(block),
      "a prerequisite that winget could not supply still exits with the manual instruction, never a silent half-install"
    );
  }

  // 3) The API serves the .bat behind the same manager gate as the .sh.
  const apiSrc = fsx.readFileSync("services/api/src/index.ts", "utf8");
  assert.ok(
    /app\.get\("\/mdf\/portal-runner\/install\.bat", requireManager/.test(apiSrc),
    "install.bat endpoint exists and is manager-gated"
  );
  assert.ok(/buildWindowsInstallerBat\(\{ apiBase, runnerToken, repoUrl, branch \}\)/.test(apiSrc), "endpoint uses the pure builder");

  // 4) Daemon: win32 Chrome-heal branch (start-only, NEVER taskkill chrome.exe) + singleton lock.
  const daemonSrc = fsx.readFileSync("scripts/mdf_portal_runner_daemon.ts", "utf8");
  assert.ok(/\["\/Run", "\/TN", "LeadRider MDF Chrome"\]/.test(daemonSrc), "win32 auto-heal starts the Chrome scheduled task");
  assert.ok(!/spawn\(\s*"taskkill/i.test(daemonSrc), "auto-heal never RUNS taskkill (would nuke a human's own Chrome windows)");
  assert.ok(/acquireDaemonSingleton\(\)/.test(daemonSrc) && /leadrider-mdf-portal-daemon\.lock/.test(daemonSrc), "daemon singleton lock (watchdog duplicates exit instantly)");
}
console.log("PASS mdf runner windows port guards");

// === Seamless computer switch (Joe 2026-07-31) ===================================================
// Switching the runner to a new computer used to need shell access: Reset DELETED the record and
// the retired computer's next poll silently re-claimed the empty slot, so the console showed the
// old machine coming back with no explanation. Worse, the MDF and warranty/RMA runners shared ONE
// slot, so a dealer could never run them on different computers. Both are pinned here.
{
  const { REVOKED_MARKER, RUNNER_REVOKED_EXIT_CODE, PORTAL_RUNNER_KINDS, resolveRunnerKindsToRetire } = await import(
    "../services/api/src/domain/portalRunnerHandoff.ts"
  );
  const fsx = await import("node:fs");
  const apiSrc = fsx.readFileSync("services/api/src/index.ts", "utf8");
  const runnerSrc = fsx.readFileSync("scripts/mdf_portal_runner.ts", "utf8");
  const daemonSrc = fsx.readFileSync("scripts/mdf_portal_runner_daemon.ts", "utf8");
  const webSrcRunner = fsx.readFileSync("apps/web/src/app/page.tsx", "utf8");
  const { buildWindowsInstallerPs1 } = await import(
    "../services/api/src/domain/mdfRunnerWindowsInstaller.ts"
  );

  // The stand-down exit code must be distinct from success (0) and generic failure (1). If it
  // collided with 1, every API blip would retire a working dealer's computer — the one failure
  // here that is far worse than the bug being fixed.
  assert.equal(RUNNER_REVOKED_EXIT_CODE, 3, "revoked exit code is dedicated");
  assert.ok(RUNNER_REVOKED_EXIT_CODE !== 0 && RUNNER_REVOKED_EXIT_CODE !== 1, "revoked exit code never collides with success/generic-failure");

  // (a) Reset writes a TOMBSTONE naming the retired machine — it must not just delete the file,
  //     which is precisely what let the old computer re-claim the slot.
  assert.ok(/async function revokeMdfRunnerRegistry/.test(apiSrc), "reset revokes rather than deletes");
  assert.ok(/revokedMachineId: retiredId/.test(apiSrc), "the tombstone names the retired machine");
  assert.ok(/await revokeMdfRunnerRegistry\(kind\)/.test(apiSrc), "the DELETE endpoint uses the revoking path");

  // (b) The retired machine is refused with the marker the runner matches on.
  assert.ok(
    /existing\.revokedMachineId === machineId/.test(apiSrc),
    "a revoked machine is matched by EXACT machine id (never by name or a stale heartbeat)"
  );
  assert.ok(apiSrc.includes(REVOKED_MARKER), `the refusal body carries the ${REVOKED_MARKER} marker`);

  // (c) Revocation is SELF-EXPIRING: any other machine claiming the slot clears the tombstone,
  //     so a stale tombstone can never lock a dealer out of their own runner.
  assert.ok(
    /Claiming the slot CLEARS any tombstone/.test(apiSrc),
    "claiming the slot clears the tombstone (revocation cannot accumulate)"
  );

  // (d) Each runner kind gets its OWN slot — the shared-slot bug that made stopping one runner
  //     insufficient during a migration.
  assert.ok(/WARRANTY_RMA_RUNNER_REGISTRY_PATH/.test(apiSrc), "warranty/RMA has its own registry path");
  assert.ok(
    /validateMdfPortalRunnerMachine\(req, "warranty_rma"\)/.test(apiSrc),
    "the warranty/RMA runner validates against its OWN slot, not the MDF one"
  );
  assert.ok(
    /validateMdfPortalRunnerMachine\(req, "mdf"\)/.test(apiSrc),
    "the MDF runner validates against the MDF slot"
  );

  // (d2) Splitting the slot in two must not put a slot out of the console's REACH. Production
  //      regression, American Harley 2026-07-31: the console sends no ?kind=, so Reset retired
  //      only the default MDF slot while a MacBook kept renewing the warranty/RMA claim every
  //      60s — Reset looked dead again, and the warranty slot had to be tombstoned by hand.
  //      An unqualified Reset therefore retires the whole COMPUTER.
  assert.deepEqual(
    resolveRunnerKindsToRetire(undefined),
    [...PORTAL_RUNNER_KINDS],
    "Reset with no kind retires EVERY slot (the console sends no kind — this is the live path)"
  );
  assert.deepEqual(resolveRunnerKindsToRetire(""), [...PORTAL_RUNNER_KINDS], "blank kind retires every slot");
  assert.deepEqual(
    resolveRunnerKindsToRetire("warranty_rma"),
    ["warranty_rma"],
    "an explicitly named slot is retired alone"
  );
  assert.deepEqual(resolveRunnerKindsToRetire("mdf"), ["mdf"], "the MDF slot can still be retired alone");
  assert.deepEqual(
    resolveRunnerKindsToRetire("typo"),
    [...PORTAL_RUNNER_KINDS],
    "an unrecognized kind fails toward retiring everything, never toward retiring nothing"
  );
  assert.ok(
    PORTAL_RUNNER_KINDS.includes("mdf") && PORTAL_RUNNER_KINDS.includes("warranty_rma"),
    "every runner slot a computer can hold is listed, or Reset silently misses one"
  );
  assert.ok(
    /resolveRunnerKindsToRetire\(/.test(apiSrc),
    "the DELETE endpoint resolves which slots to retire (never a single hardcoded kind)"
  );
  assert.ok(
    /const slots = await Promise\.all\(PORTAL_RUNNER_KINDS\.map/.test(apiSrc),
    "the registration read reports EVERY slot, so a held computer cannot hide behind an empty default slot"
  );

  // (d2b) Retiring a slot that has NO current holder must PRESERVE a standing tombstone.
  //       Live regression 2026-07-31: once Reset retired every slot, each click tombstoned the
  //       slot that had a holder and DELETED the other slot's tombstone — freeing it, so the
  //       retired MacBook bounced straight back in on its next poll. Reset stopped sticking
  //       again, one level down. Deleting a tombstone is UN-retiring a machine.
  assert.ok(
    /if \(existing\?\.revokedMachineId\) return existing;[\s\S]{0,200}?fs\.promises\.rm\(mdfRunnerRegistryPath\(kind\)/.test(
      apiSrc
    ),
    "a standing tombstone is preserved, never deleted, when the slot has no current holder"
  );

  // (d3) The console must consume the multi-slot reply. It reached only the default slot before,
  //      and the Next.js proxy takes no request object, so it cannot forward a ?kind= even if the
  //      browser sent one — which is exactly why "no kind" has to mean "all".
  assert.ok(
    /Array\.isArray\(data\.slots\)/.test(webSrcRunner),
    "the console reads the per-slot list, not just the default slot"
  );
  assert.ok(
    /ALL LeadRider automation on it/.test(webSrcRunner),
    "the Reset confirm tells the manager it stops every automation on that computer"
  );

  // (d4) The retired-computer EXPLANATIONS must actually be populated. The panel has rendered
  //      `revoked` / `retiredStillTrying` since #383, but the loader never set them, so a
  //      mid-switch dealer saw a machine name with no check-in line and no reason at all —
  //      silence exactly where the guidance was supposed to be (Joe, 2026-07-31).
  const loader = webSrcRunner.slice(
    webSrcRunner.indexOf("async function loadMdfRunnerStatus"),
    webSrcRunner.indexOf("function downloadMdfRunnerInstaller")
  );
  assert.ok(loader.length > 0, "the runner-status loader must be findable");
  for (const field of ["revoked", "retiredStillTrying"]) {
    assert.ok(
      new RegExp(`${field}:`).test(loader),
      `the runner-status loader must set ${field}, or the retired-computer guidance never renders`
    );
  }

  // (d5) The card must distinguish "never installed" from "installed but not running". Both used
  //      to render as a bare "no active runner", which is precisely how a failed auto-start hid
  //      for an afternoon while the install had actually succeeded.
  assert.ok(
    /registered but has stopped checking in/.test(webSrcRunner),
    "the card names the installed-but-not-running state instead of showing a bare 'no active runner'"
  );
  assert.ok(
    /!mdfRunnerStatus\?\.active &&[\s\S]{0,120}?registration\?\.lastSeenAt \? \(/.test(webSrcRunner),
    "that state keys off a PRIOR check-in going stale (registered once, then quiet)"
  );

  // (e) The runner child stands down on the revoked reply, and ONLY on that reply.
  assert.ok(
    new RegExp(`resp\\.status === 409 && /${REVOKED_MARKER}/\\.test\\(text\\)`).test(runnerSrc),
    "the runner detects the revoked refusal specifically (a bare 409 stays a retryable failure)"
  );
  assert.ok(/process\.exit\(RUNNER_REVOKED_EXIT_CODE\)/.test(runnerSrc), "the runner exits with the dedicated code");

  // (f) The daemon disables its OWN service — exiting alone would restart-loop under KeepAlive
  //     and keep fighting for the slot, which is the visible symptom we are killing.
  // (f0) The daemon must be able to LAUNCH the runner on Windows at all. `npx` is npx.cmd, and
  //      Node >=18.20.2 / >=20.12.2 refuses to spawn .cmd/.bat without a shell — so the daemon
  //      polled fine and failed on every tick with "runner spawn failed", on Windows only.
  //      Live on a dealership PC 2026-07-31; invisible on macOS, which is why it shipped.
  assert.ok(
    /shell: isWindows/.test(daemonSrc),
    "the daemon spawns the runner through a shell on Windows (npx is a .cmd Node will not spawn directly)"
  );
  assert.ok(
    /isWindows \? `"\$\{apiBase\}"` : apiBase/.test(daemonSrc),
    "the api-base is quoted on Windows, where shell mode re-parses the argument list"
  );

  assert.ok(/code === RUNNER_REVOKED_EXIT_CODE/.test(daemonSrc), "the daemon reacts to the revoked code");
  assert.ok(/standDownRetiredComputer/.test(daemonSrc), "the daemon stands the retired computer down");
  assert.ok(
    /\["\/Change", "\/TN", "LeadRider MDF Runner", "\/DISABLE"\]/.test(daemonSrc),
    "Windows stand-down disables the runner scheduled task"
  );
  assert.ok(
    /bootout.*ai\.leadrider\.mdf-portal-runner/.test(daemonSrc),
    "macOS stand-down unloads the runner LaunchAgent"
  );

  // (f2) Windows ALSO has a watchdog task that runs `schtasks /Run` on the runner every 5
  //      minutes, and /Run starts a task even when it is DISABLED. Disabling only the runner
  //      left the watchdog resurrecting a retired computer on a 5-minute loop — the macOS
  //      `bootout` has no such counterpart (verified live 7/31). The watchdog must go down
  //      FIRST, or it can fire in the gap between the two calls.
  assert.ok(
    /\["\/Change", "\/TN", "LeadRider MDF Runner Watchdog", "\/DISABLE"\]/.test(daemonSrc),
    "Windows stand-down also disables the WATCHDOG, or it re-runs the disabled runner every 5 min"
  );
  assert.ok(
    daemonSrc.indexOf('"LeadRider MDF Runner Watchdog", "/DISABLE"') <
      daemonSrc.indexOf('"LeadRider MDF Runner", "/DISABLE"'),
    "the watchdog is disabled BEFORE the runner (kill the resurrector first)"
  );
  // The watchdog task name must match what the installer actually registers, or the disable
  // silently no-ops against a task that does not exist.
  assert.ok(
    buildWindowsInstallerPs1({
      apiBase: "https://api.example.com",
      runnerToken: "t",
      repoUrl: "https://example.com/r.git",
      branch: "main"
    }).includes('"LeadRider MDF Runner Watchdog"'),
    "the installer registers the exact watchdog task name the stand-down disables"
  );
  // Stand-down must target the RUNNER service only — never the Chrome agent, which a human may
  // be relying on, and never a taskkill of chrome.exe.
  assert.ok(
    !/standDownRetiredComputer[\s\S]{0,600}hdnet-chrome/.test(daemonSrc),
    "stand-down never touches the Chrome agent"
  );
}
console.log("PASS portal runner computer-switch handoff");

// ---------------------------------------------------------------------------------------------
// THE SSO HANDOFF — H-DNet > My Toolbox > "Marketing Development Fund" (Joe, 2026-08-10).
//
// The runner had a toolbox-click function since 2026-06 and NOTHING CALLED IT: a later change
// routed around the widget, and the live Playwright path went straight to app.ansira.com on the
// assumption that an H-DNet login auto-SSOs Ansira. It does not. The result was a closed loop —
// the preflight refused to run without an Ansira session while nothing in the run ever created
// one — which is why 2026-08-07 logged four completed logins and zero filled drafts.
//
// These assertions exist to stop the click being orphaned a second time.
// ---------------------------------------------------------------------------------------------
{
  const runnerSrc = fs.readFileSync("scripts/mdf_portal_runner.ts", "utf8");

  // --- EXECUTED: the label matcher, against real menu text -------------------------------------
  assert.ok(MDF_TOOLBOX_LINK_TEXT.test("Marketing Development Fund"), "matches the Toolbox item");
  assert.ok(MDF_TOOLBOX_LINK_TEXT.test("  Marketing Development Fund  "), "tolerates the widget's padding");
  assert.ok(MDF_TOOLBOX_LINK_TEXT.test("marketing development fund"), "case-insensitive");
  // The dead ends it must never follow — same words, not the app.
  for (const decoy of [
    "Marketing Development Fund Guidelines",
    "Marketing Development Fund - Reference",
    "2026 Marketing Development Fund Policy",
    "MARKETING-DEVELOPMENT-FUND.aspx"
  ]) {
    assert.equal(MDF_TOOLBOX_LINK_TEXT.test(decoy), false, `must not follow the document "${decoy}"`);
  }

  // --- WIRED: the handoff is CALLED, not merely defined ----------------------------------------
  assert.ok(
    /async function establishAnsiraSessionViaToolbox\(/.test(runnerSrc),
    "the toolbox handoff exists"
  );
  const callSites = (runnerSrc.match(/establishAnsiraSessionViaToolbox\(/g) ?? []).length;
  assert.equal(
    callSites,
    3,
    `the handoff must be DEFINED once and CALLED twice — the in-run path and the preflight (found ${callSites} occurrences). ` +
      "A count, not a substring: the whole defect being fixed here is a correct function nobody called."
  );
  assert.ok(
    /const handoff = await establishAnsiraSessionViaToolbox\(page, options\);/.test(runnerSrc),
    "the in-run path (openAnsiraClaimFormThroughHNet) performs the handoff"
  );
  assert.ok(
    /const handoff = await attemptToolboxSessionHandoff\(options\);/.test(runnerSrc),
    "the preflight performs the handoff through its CDP wrapper"
  );

  // --- ORDER: the preflight must TRY before it CONDEMNS -----------------------------------------
  // Both anchors must be found: indexOf returns -1 for a missing string and -1 beats everything,
  // so an unanchored comparison passes vacuously the moment either line is reworded.
  const firstProbe = runnerSrc.indexOf("let sessionCheck = await checkAnsiraSessionViaCdp(options.cdpUrl);");
  const handoffAt = runnerSrc.indexOf("const handoff = await attemptToolboxSessionHandoff(options);");
  const blockAt = runnerSrc.indexOf("const loginOpened = await openLoginPageForSessionRecovery(");
  assert.ok(firstProbe >= 0, "the preflight probe call site is present (ordering anchor)");
  assert.ok(handoffAt >= 0, "the preflight handoff call site is present (ordering anchor)");
  assert.ok(blockAt >= 0, "the preflight block call site is present (ordering anchor)");
  assert.ok(
    firstProbe < handoffAt && handoffAt < blockAt,
    "the preflight probes, then attempts the handoff, and only then blocks the claim"
  );
  // Ordering alone is not enough: dropping the handoff INSIDE the blocking branch also reads as
  // "before the block" while still condemning the run. The recovery must be its own decision,
  // taken and re-judged BEFORE the branch that gives up — so there are two separate tests of
  // sessionCheck.expired, and the handoff belongs to the first. (This sabotage survived the
  // first version of this eval; that is why the shape is asserted, not just the order.)
  const expiredTests = [...runnerSrc.matchAll(/if \(sessionCheck\.expired\) \{/g)].map(m => m.index ?? -1);
  assert.equal(
    expiredTests.length,
    2,
    `the preflight must test sessionCheck.expired TWICE — once to recover, once to give up (found ${expiredTests.length})`
  );
  assert.ok(
    expiredTests[0] < handoffAt && handoffAt < expiredTests[1],
    "the handoff sits in the RECOVERY branch, before the branch that blocks the claim"
  );
  // The re-probe is what makes the handoff mean anything — without it the run blocks regardless.
  assert.ok(
    /if \(handoff\) sessionCheck = await checkAnsiraSessionViaCdp\(options\.cdpUrl\);/.test(runnerSrc),
    "a successful handoff is re-probed, so the run proceeds on the session it just established"
  );

  // --- ORDER: the in-run path must TRY before it CONDEMNS ---------------------------------------
  // Asserted on BEHAVIOUR, not on prose. The old assumption survives in the comments on purpose so
  // the history stays readable, and a comment must never be what the gate reads.
  const inRunHandoff = runnerSrc.indexOf("const handoff = await establishAnsiraSessionViaToolbox(page, options);");
  const inRunExpired = runnerSrc.indexOf('return sessionExpired("recap list");');
  assert.ok(inRunHandoff >= 0 && inRunExpired >= 0, "both in-run anchors are present");
  assert.ok(
    inRunHandoff < inRunExpired,
    "the in-run path performs the toolbox handoff BEFORE it reports the session expired"
  );
  // The orphan itself: the old entry point must not linger as a second, uncalled copy.
  assert.ok(
    !/async function openMdfSsoEntry\(/.test(runnerSrc),
    "the orphaned openMdfSsoEntry is gone (rehabilitated into establishAnsiraSessionViaToolbox), not left as dead code"
  );
}
console.log("PASS MDF toolbox SSO handoff — the Marketing Development Fund click is wired into BOTH the in-run path and the preflight, and the preflight tries it before blocking.");

// ---------------------------------------------------------------------------------------------
// WHEN a control exists, not just WHETHER (Joe's photo, 2026-08-10).
//
// The runner blocked an IDMP media claim with "the Ansira form changed — missing Activity
// sub-detail dropdown". It had not changed. Joe photographed the live Create Claim page in that
// exact state: "2026 Media Claim" selected, both Dates of Activity EMPTY, and the page showing
// nothing below them. The other eight controls were found (present but hidden), so the sub-detail
// dropdown is genuinely not created until the dates are accepted — and the runner was demanding it
// beforehand.
//
// It also explains the claim that succeeded twenty minutes earlier: that form had been driven by
// hand first, so the dropdown already existed. A runner that only works after a human warms up the
// form is not working.
// ---------------------------------------------------------------------------------------------
{
  const runnerSrc = fs.readFileSync("scripts/mdf_portal_runner.ts", "utf8");
  const preSelectors = ANSIRA_FORM_CONTROLS.map(c => c.selector);
  const postSelectors = ANSIRA_POST_DATE_FORM_CONTROLS.map(c => c.selector);

  // --- EXECUTED: the split itself ---------------------------------------------------------------
  assert.ok(
    !preSelectors.includes("#activity-sub-detail"),
    "#activity-sub-detail must NOT be demanded before the dates — Ansira has not created it yet"
  );
  assert.ok(
    postSelectors.includes("#activity-sub-detail"),
    "#activity-sub-detail is checked after the dates, where it genuinely exists"
  );
  // Nothing may be lost in the split, and nothing checked twice.
  const overlap = preSelectors.filter(sel => postSelectors.includes(sel));
  assert.deepEqual(overlap, [], `a control must be checked in exactly one phase (both: ${overlap.join(", ")})`);
  for (const required of [
    "#app-marketing-activity",
    "#app-claim-start-date",
    "#app-claim-end-date",
    "#app-claim-name",
    "#app-claimed-amount",
    "#activity-sub-detail",
    'input[name="invoices[1][vendor_name]"]',
    'input[type="file"][name="files[]"]',
    "#app-draft-submit-btn"
  ]) {
    assert.ok(
      [...preSelectors, ...postSelectors].includes(required),
      `the split must not DROP a control the filler depends on: ${required}`
    );
  }

  // --- EXECUTED: the phase-B check still reports a real absence ---------------------------------
  assert.equal(
    (await findMissingFormControls(ANSIRA_POST_DATE_FORM_CONTROLS, () => true)).length,
    0,
    "sub-detail present after the dates → the run proceeds"
  );
  const stillMissing = await findMissingFormControls(ANSIRA_POST_DATE_FORM_CONTROLS, () => false);
  assert.equal(stillMissing.length, 1, "sub-detail STILL absent after the dates → that is a real form change");
  assert.match(
    ansiraFormChangedSummary(stillMissing),
    /Activity sub-detail dropdown/,
    "and it is named in the operator summary"
  );

  // --- ORDER: phase B runs AFTER the dates are filled -------------------------------------------
  // Anchors must be found first: indexOf returns -1 when a string moves, and -1 beats everything.
  const datesFilledAt = runnerSrc.indexOf('await fillText(page, "#app-claim-end-date", endDate);');
  const phaseBAt = runnerSrc.indexOf("const missingPostDateControls = await findMissingFormControls(");
  const phaseAAt = runnerSrc.indexOf("const missingControls = await findMissingFormControls(");
  assert.ok(datesFilledAt >= 0 && phaseBAt >= 0 && phaseAAt >= 0, "all three ordering anchors are present");
  assert.ok(phaseAAt < datesFilledAt, "phase A (present-but-hidden controls) is checked before the dates");
  assert.ok(
    datesFilledAt < phaseBAt,
    "phase B is checked AFTER the dates go in — checking it earlier is the whole defect being fixed"
  );
  assert.ok(
    runnerSrc.indexOf("portalFormDidNotExpandSummary()") < phaseBAt,
    "phase B runs after the form-expansion gate, so a slow render is never mistaken for a missing control"
  );
  // And the result must actually STOP the run. Order and existence are not enough: neutering the
  // branch (`if (false && …)`) left every other assertion here green. A check nobody acts on is the
  // same defect in a different costume.
  const phaseBBlock = runnerSrc.slice(phaseBAt, phaseBAt + 600).replace(/\s+/g, " ");
  assert.ok(
    phaseBBlock.includes("if (missingPostDateControls.length) { await browser.close(); return { code: 2, summary: ansiraFormChangedSummary(missingPostDateControls) };"),
    "a missing post-date control CLOSES the browser and blocks the run with the named control"
  );
}
console.log("PASS Ansira control-phase split — #activity-sub-detail is checked AFTER the dates, where Ansira actually creates it.");

// ---------------------------------------------------------------------------------------------
// RETIRE → REINSTALL must actually recover the computer (Joe, 2026-08-10, hit TWICE in one hour).
//
// The console's Retire writes a tombstone keyed to the runner's machine id, and then tells the
// operator to "run the installer on the new computer". But the id lives in
// ~/.leadrider/mdf-runner-machine.json — OUTSIDE the app folder the installer replaces — so
// reinstalling on the SAME computer came back with the SAME id and was refused forever. The console
// read "no active runner" while the runner hammered the API and was turned away every few minutes.
//
// Both installers now drop that file, which makes reinstalling the recovery the console promises:
// a fresh id claims the slot, and claiming clears the tombstone.
// ---------------------------------------------------------------------------------------------
{
  const idxSrc = fs.readFileSync("services/api/src/index.ts", "utf8");
  const winSrc = fs.readFileSync("services/api/src/domain/mdfRunnerWindowsInstaller.ts", "utf8");
  const runnerSrc2 = fs.readFileSync("scripts/mdf_portal_runner.ts", "utf8");

  // The identity path the runner uses — asserted so the installers cannot drift off it.
  assert.match(
    runnerSrc2,
    /path\.join\(os\.homedir\(\), "\.leadrider", "mdf-runner-machine\.json"\)/,
    "the runner's machine identity lives at ~/.leadrider/mdf-runner-machine.json"
  );

  // macOS installer clears it, BEFORE writing .env / registering the agents. The script moved out of
  // index.ts into domain/mdfRunnerMacInstaller.ts (index.ts was on its size ceiling) — assert against
  // its new home, and assert index.ts still CALLS the builder so the move cannot orphan it.
  const macSrc = fs.readFileSync("services/api/src/domain/mdfRunnerMacInstaller.ts", "utf8");
  assert.match(
    idxSrc,
    /const script = buildMacInstallerScript\(\{ apiBase, runnerToken, repoUrl, branch \}\);/,
    "the install.sh route builds its script from the extracted module"
  );
  assert.match(macSrc, /return `#!\/bin\/zsh/, "the generated script still starts with the shebang on line 1");
  const shClear = macSrc.indexOf('rm -f "\\${HOME}/.leadrider/mdf-runner-machine.json"');
  const shEnv = macSrc.indexOf('cat > "\\${APP_DIR}/.env" <<ENV');
  assert.ok(shClear >= 0, "install.sh clears the stale machine identity");
  assert.ok(shEnv >= 0, "install.sh env anchor present");
  assert.ok(shClear < shEnv, "install.sh clears the identity before it configures the runner");

  // Windows installer clears it too — same file, PowerShell form.
  assert.match(
    winSrc,
    /Remove-Item -Force -ErrorAction SilentlyContinue \(Join-Path \$env:USERPROFILE "\.leadrider\\\\mdf-runner-machine\.json"\)/,
    "install.bat clears the stale machine identity"
  );
  const batClear = winSrc.indexOf("Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $env:USERPROFILE");
  const batEnv = winSrc.indexOf("$envLines = @(");
  assert.ok(batClear >= 0 && batEnv >= 0 && batClear < batEnv, "install.bat clears the identity before configuring");

  // The refusal must name the step that WORKS. The old wording ("run the runner installer on it")
  // was true-sounding and useless — it is what sent Joe round the loop a second time.
  const revokedMsg = idxSrc.slice(idxSrc.indexOf("runner_revoked: this computer was retired"), idxSrc.indexOf("runner_revoked: this computer was retired") + 420);
  assert.match(revokedMsg, /INSTALLER/, "the refusal names the installer explicitly");
  assert.match(revokedMsg, /re-identifies the computer and clears the retirement/, "and says WHY that is the fix");
  assert.match(revokedMsg, /re-downloading alone is not enough/, "and rules out the thing an operator tries first");
}
console.log("PASS runner retire/reinstall recovery — both installers clear the stale machine identity, and the refusal names the step that works.");
