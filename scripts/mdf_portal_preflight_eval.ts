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
  ANSIRA_CLAIMS_LIST_URL,
  ANSIRA_FORM_CONTROLS,
  ansiraFormChangedSummary,
  ansiraMarketingOptionSummary,
  cdpConnectFailureSummary,
  cdpLooksBloated,
  findMissingFormControls,
  formatMissingControls,
  isExpiredSessionLanding,
  isSignInPageText,
  marketingActivityOptionIssue,
  missingActivityDatesSummary,
  pickAccountTileLabel,
  portalFormDidNotExpandSummary,
  portalRunDeadlineSummary,
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
  assert.ok(/log in there now/.test(ps1), "installer tells the human the one manual step (H-DNet login)");
  assert.ok(/only ONE runner computer/.test(ps1), "installer surfaces the single-runner rule");
  assert.ok(!/launchctl/.test(ps1), "no macOS plumbing leaks into the Windows payload");
  assert.ok(!/—|’|“/.test(ps1), "payload stays ASCII-safe (bat extraction re-encodes)");
  // PowerShell backticks would be corrupted by the TS template-literal embedding — the builder's
  // quoting rule is concatenated single-quoted pieces, never backticks.
  assert.ok(!ps1.includes("`"), "no PowerShell backticks in the payload (TS-template embedding rule)");

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
