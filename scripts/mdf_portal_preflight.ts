/**
 * MDF portal preflight — structural guard for the Ansira "Create MDF Recap" form.
 *
 * The deterministic Playwright filler (runPlaywrightPortalDraft in
 * scripts/mdf_portal_runner.ts) depends on a fixed set of Ansira form controls
 * (element IDs / field names). Ansira is a third-party portal we don't control, so a
 * layout change there would otherwise crash the filler mid-fill — or worse, trip a
 * save-time validation/FK error after the form is partially built.
 *
 * This preflight runs BEFORE any field is filled and BEFORE the only persistence
 * point (the "Save for Later" click), so a missing control fails the run loud and
 * early with a clear "Ansira changed the form" message and ZERO partial state —
 * never a half-built draft, never a duplicate. The fix is then a one-line selector
 * update, not a debugging session. Pinned by scripts/mdf_portal_preflight_eval.ts.
 *
 * Kept browser-free (no Playwright import) on purpose: the runner runs main() at
 * import time, so the eval imports THIS module, never the runner.
 */

export type PreflightControl = { selector: string; label: string };

/**
 * Load-bearing controls the deterministic filler reads or writes. Each one, if
 * absent, would either crash the fill or yield an un-saveable / broken draft.
 * Optional, gracefully-handled controls (e.g. the standalone-claim radio, which the
 * filler already guards with a count() check) are intentionally NOT listed — we only
 * fail the run for controls whose absence actually breaks it, so the guard doesn't
 * false-positive on a cosmetic change.
 */
export const ANSIRA_FORM_CONTROLS: PreflightControl[] = [
  { selector: "#app-marketing-activity", label: "Marketing Activity dropdown" },
  { selector: "#app-claim-start-date", label: "Activity start date" },
  { selector: "#app-claim-end-date", label: "Activity end date" },
  { selector: "#app-claim-name", label: "Claim name" },
  { selector: "#activity-sub-detail", label: "Activity sub-detail dropdown" },
  { selector: "#app-claimed-amount", label: "Claimed amount" },
  { selector: 'input[name="invoices[1][vendor_name]"]', label: "First invoice vendor field" },
  { selector: 'input[type="file"][name="files[]"]', label: "File upload input" },
  { selector: "#app-draft-submit-btn", label: "Save for Later (draft submit) button" }
];

/**
 * Returns the controls NOT present, given an existence predicate (sync or async).
 * The runner passes an async `page.locator(selector).count() > 0` check; the eval
 * passes a plain set membership. Every control is checked so the caller can report
 * the FULL diff after an Ansira redesign, not just the first miss.
 */
export async function findMissingFormControls(
  controls: PreflightControl[],
  exists: (selector: string) => boolean | Promise<boolean>
): Promise<PreflightControl[]> {
  const missing: PreflightControl[] = [];
  for (const control of controls) {
    if (!(await exists(control.selector))) missing.push(control);
  }
  return missing;
}

/** Human-readable "Label (selector); Label (selector)" list of missing controls. */
export function formatMissingControls(missing: PreflightControl[]): string {
  return missing.map(control => `${control.label} (${control.selector})`).join("; ");
}

/**
 * Shared shell for every preflight failure: states the form changed, that NOTHING was
 * saved (zero partial state — the safety promise), the specific detail, and the fix.
 */
function preflightFailureSummary(detail: string): string {
  return (
    "MDF preflight failed — the Ansira Create MDF Recap form changed (likely an Ansira update). " +
    "No draft was created (nothing was saved). " +
    `${detail} ` +
    "Re-inspect the form in the runner's Chrome window and update the runner's selectors before retrying."
  );
}

/** Operator-facing summary when load-bearing controls are missing. */
export function ansiraFormChangedSummary(missing: PreflightControl[]): string {
  return preflightFailureSummary(`Missing controls the runner depends on: ${formatMissingControls(missing)}.`);
}

/**
 * Phase-A check: the runner picks the claim type by selecting a Marketing Activity option
 * by its visible text (selectOptionByText → Playwright `hasText`, a case-insensitive
 * "contains" match). If Ansira renames that option — most likely at YEAR ROLLOVER
 * ("2026 Media Claim" → "2027 Media Claim") — the select would otherwise throw mid-run with
 * a generic error. This catches it up front, before any fill. Mirrors the runner's
 * contains-match so it neither false-positives nor misses. Returns a detail string when the
 * required option is absent, else null. An empty `requiredLabel` (a claim type the
 * deterministic path doesn't drive) returns null — not our concern here.
 */
export function marketingActivityOptionIssue(
  requiredLabel: string,
  availableOptions: string[]
): string | null {
  return marketingActivityFailure(requiredLabel, availableOptions)?.detail ?? null;
}

/** Operator-facing summary when the required Marketing Activity option is missing/renamed. */
export function ansiraMarketingOptionSummary(detail: string): string {
  return preflightFailureSummary(detail);
}

// ---------------------------------------------------------------------------
// Claim-YEAR mismatch vs. Ansira form drift (2026-08-01).
//
// Production: four "250 Years of Freedom" portal runs blocked on 2026-07-31 (tasks
// agent_ms9dixrw_a0t5dh, agent_ms9foivd_7qsqd8, agent_ms9fzccl_qn2lhr) and every one of them
// told the operator "the Ansira Create MDF Recap form changed (likely an Ansira update) …
// update the runner's selectors". The form had NOT changed. The runner asked for
// "2020 Event Claim"; Ansira offered "2026 Event Claim", "2026 Media Claim", "MAP Only".
//
// The 2020 came from the CLAIM, not the portal: that packet's activity dates extracted as
// 07/18/2020 (one invoice mis-read; the event was 07/18/2026 — the other six invoices all say
// 2026), and portalClaimTypeLabel() builds the option label from `activityYearFromDates`.
//
// So the message pointed the operator at the wrong system entirely — the same misdiagnosis class
// this file has already been burned by twice (the hidden-until-dates form body on 2026-07-06,
// and the 12-file run budget on `sales2` 2026-07-31). When the dropdown still offers the SAME
// claim family in a different year, the portal is fine and the CLAIM's dates are wrong; say that.
//
// Deterministic and read-only: this only classifies an already-failed lookup so the operator is
// sent to the right place. It changes NO fill behavior and never rewrites the year — picking a
// different funding year is a money-path decision and stays with the human.
//
// FAIL DIRECTION: anything it cannot confidently classify as a year mismatch keeps today's
// "Ansira changed / re-inspect the form" wording, so a real portal change is never softened.
// ---------------------------------------------------------------------------

export type MarketingActivityFailureKind = "claim_year_mismatch" | "option_missing";

export type MarketingActivityFailure = {
  kind: MarketingActivityFailureKind;
  /** The bare detail sentence (no summary shell). */
  detail: string;
  /** The year the runner asked Ansira for, when the failure is a year mismatch. */
  requestedYear?: string;
  /** The year(s) Ansira actually offers for the same claim family. */
  offeredYears?: string[];
};

const YEAR_RE = /\b(?:19|20)\d{2}\b/;

function normalizeOptionText(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** "2020 Event Claim" -> "event claim" (the year-free family the dropdown groups by). */
function claimFamily(label: string): string {
  return normalizeOptionText(label).replace(YEAR_RE, "").replace(/\s+/g, " ").trim();
}

/**
 * Classifies a missing Marketing Activity option. Returns null when the option is present
 * (contains-match, whitespace/case-insensitive — mirroring the runner's `hasText` select).
 */
export function marketingActivityFailure(
  requiredLabel: string,
  availableOptions: string[]
): MarketingActivityFailure | null {
  const need = normalizeOptionText(requiredLabel);
  if (!need) return null;
  const options = (availableOptions ?? []).map(option => String(option ?? "").trim()).filter(Boolean);
  if (options.some(option => normalizeOptionText(option).includes(need))) return null;

  const shown = options.length ? options.join(", ") : "(none)";
  const requestedYear = String(requiredLabel).match(YEAR_RE)?.[0] ?? "";
  const family = claimFamily(requiredLabel);
  // Same claim family, different year => the portal is fine; the claim's dates are not.
  const offeredYears = requestedYear && family
    ? options
        .filter(option => claimFamily(option) === family)
        .map(option => option.match(YEAR_RE)?.[0] ?? "")
        .filter(year => year && year !== requestedYear)
    : [];

  if (offeredYears.length) {
    const unique = [...new Set(offeredYears)];
    return {
      kind: "claim_year_mismatch",
      requestedYear,
      offeredYears: unique,
      detail:
        `This claim's activity dates put it in ${requestedYear}, so the runner looked for the Marketing Activity ` +
        `"${requiredLabel}" — but Ansira only offers that claim type for ${unique.join(", ")}. ` +
        `Available options: ${shown}.`
    };
  }

  return {
    kind: "option_missing",
    requestedYear: requestedYear || undefined,
    detail:
      `Marketing Activity option "${requiredLabel}" was not found in the dropdown ` +
      "(the runner needs it to pick the claim type — most likely an Ansira rename such as a year rollover). " +
      `Available options: ${shown}.`
  };
}

/**
 * The claim-year-mismatch summary. Deliberately does NOT say the form changed and does NOT ask
 * for a selector update — it names the claim's dates as the thing to fix, because they are.
 */
export function claimYearMismatchSummary(failure: MarketingActivityFailure): string {
  return (
    "MDF preflight stopped this run — the claim's activity year does not exist in Ansira. " +
    "No draft was created (nothing was saved). " +
    `${failure.detail} ` +
    "The Ansira form is fine; the claim's activity dates are what's wrong. Fix the Activity start/end dates on " +
    "the claim (check the invoice dates in the packet — a single mis-read date sets the year for the whole claim), " +
    "then run the portal draft again."
  );
}

/** Routes a marketing-activity failure to the summary that names the RIGHT system. */
export function marketingActivityFailureSummary(failure: MarketingActivityFailure): string {
  return failure.kind === "claim_year_mismatch"
    ? claimYearMismatchSummary(failure)
    : ansiraMarketingOptionSummary(failure.detail);
}

// ---------------------------------------------------------------------------
// CDP browser-health preflight (runs before chromium.connectOverCDP).
//
// Production failure 2026-07-06 (task agent_mr9o31de_1i5y8h): the runner Chrome's
// CDP endpoint answered HTTP instantly, but `connectOverCDP` hung 30s and died with
// a generic "Timeout 30000ms exceeded". Root cause: the dedicated runner Chrome had
// drifted into daily-browsing use — 119 debug targets (35 tabs + 64 iframes +
// workers, incl. chrome:// pages) — and Playwright attaches to EVERY target on
// connect, so one hung tab stalls the whole attach. The generic timeout told the
// operator nothing; the fix (restart the runner Chrome) took a live debugging
// session to find. These helpers classify the failure up front so the blocked-task
// summary says exactly which of the known causes hit and what to do about it.
// Browser-free + pure on purpose (same rule as the form preflight above): the eval
// imports this module, never the runner.
// ---------------------------------------------------------------------------

export type CdpTargetStats = {
  /** CDP HTTP endpoint (`/json`) answered. False = Chrome down / no debug port. */
  reachable: boolean;
  /** Count of `type === "page"` targets (tabs). */
  pages?: number;
  /** Total debug targets (tabs + iframes + workers + …) — what attach must walk. */
  targets?: number;
  /** `chrome://` pages open (sync prompts etc. — common hung-target culprits). */
  chromePages?: number;
  /** Probe error text when unreachable. */
  error?: string;
};

// Healthy runner Chrome ≈ 14 targets / 2 tabs; the 2026-07-06 hang had 119 / 35.
// Thresholds sit far above healthy and safely below the observed failure, so the
// classifier neither cries wolf on a normal session nor shrugs at a real pile-up.
export const CDP_BLOAT_PAGE_LIMIT = 15;
export const CDP_BLOAT_TARGET_LIMIT = 60;

/** True when the target pile-up is big enough to explain a hung CDP attach. */
export function cdpLooksBloated(stats: CdpTargetStats): boolean {
  return (stats.pages ?? 0) > CDP_BLOAT_PAGE_LIMIT || (stats.targets ?? 0) > CDP_BLOAT_TARGET_LIMIT;
}

/**
 * Restart instructions for the runner Chrome, in the DEALER'S platform.
 *
 * This text was macOS-only, so a Windows dealer was told to run `launchctl` — a command that
 * cannot exist on their machine, with nothing marking it as the wrong platform (hit live on
 * dealership PC `sales2`, 2026-07-31). A remedy a dealer cannot execute is worse than none:
 * it reads as "you are doing it wrong" rather than "this tool does not know your computer".
 */
export function runnerChromeRestartHint(platform: string = process.platform): string {
  const restart =
    platform === "win32"
      ? 'Restart the runner Chrome (close that Chrome window, then run: schtasks /Run /TN "LeadRider MDF Chrome")'
      : "Restart the runner Chrome (launchctl kickstart -k gui/501/ai.leadrider.hdnet-chrome)";
  return `${restart} and keep that window for portal work only, then run the portal draft again.`;
}

const RUNNER_CHROME_RESTART_HINT = runnerChromeRestartHint();

/**
 * Classified, operator-actionable summary for a CDP connect failure. Wording is
 * load-bearing: it must keep matching the mdf-portal-health detector's
 * LOAD_FAILURE_RE ("not reachable" / "timed out" / "failed to load" classes) so a
 * blocked run still surfaces in the anomaly feed — pinned by the eval.
 */
export function cdpConnectFailureSummary(stats: CdpTargetStats, attachError?: string): string {
  if (!stats.reachable) {
    return (
      "The MDF runner's Chrome is not reachable at its CDP debug port — the runner Chrome is down (or was started without remote debugging). " +
      RUNNER_CHROME_RESTART_HINT +
      (stats.error ? ` Probe error: ${stats.error}` : "")
    );
  }
  if (cdpLooksBloated(stats)) {
    const chromePages = stats.chromePages ?? 0;
    return (
      `The MDF runner's Chrome is unhealthy: the CDP attach timed out with ${stats.targets ?? "?"} debug targets across ` +
      `${stats.pages ?? "?"} tabs${chromePages ? ` (${chromePages} chrome:// page${chromePages === 1 ? "" : "s"})` : ""} — ` +
      "the dedicated runner Chrome has drifted into daily-browsing use, and one hung tab stalls Playwright's attach to every target. " +
      RUNNER_CHROME_RESTART_HINT +
      (attachError ? ` Original error: ${attachError}` : "")
    );
  }
  return (
    "The MDF runner could not attach to its Chrome over CDP (the attach timed out even though the debug port answered). " +
    RUNNER_CHROME_RESTART_HINT +
    (attachError ? ` Original error: ${attachError}` : "")
  );
}

/**
 * Run-level watchdog summary — the POST-connect hang class. Production 2026-07-06
 * (Radio advertising claim, first attempt): the attach succeeded, but the run then
 * wedged 20+ minutes on a browser-level CDP call that Playwright gives NO default
 * timeout (newPage/bringToFront — unlike goto/selectOption, which cap at 30s), with
 * no output, no fallback, and a console task stuck looking "in progress". The
 * watchdog turns that silent wedge into this classified, operator-actionable
 * summary. Honest about partial state: a hung run has almost always not reached
 * "Save for Later" (the only persistence point), but the operator must VERIFY in
 * the claims list before re-running so a rare post-save hang can't double-draft.
 */
/**
 * `lastStep` names what the run was doing when the clock ran out. Without it this summary
 * asserted "the runner Chrome stopped responding", which is only ONE of the reasons a run can
 * overrun — a 12-file claim simply taking longer than the budget reads identically, and that
 * misdiagnosis sent an operator hunting a Chrome problem that did not exist (dealership PC
 * `sales2`, 2026-07-31). Say what it was doing; only blame Chrome when nothing was in flight.
 * The phrase "timed out" is load-bearing — the mdf-portal-health detector matches on it.
 */
export function portalRunDeadlineSummary(deadlineMinutes: number, lastStep?: string): string {
  const cause = lastStep
    ? `it was still working on: ${lastStep} (that step did not finish in time)`
    : "the runner Chrome stopped responding mid-run (a browser call hung with no timeout; the attach itself had succeeded)";
  return (
    `The MDF portal run timed out after ${deadlineMinutes} minutes and was abandoned — ${cause}. ` +
    RUNNER_CHROME_RESTART_HINT +
    " Before re-running, check the Ansira claims list for a draft from this run — a hung run normally never reaches Save for Later, but verify so a re-run can't create a duplicate."
  );
}

/**
 * Per-file allowance on top of the base run budget.
 *
 * The fixed 10-minute budget was sized on "~3-4 min observed" runs, but the upload step costs
 * real time PER FILE (a settle wait after each invoice row, another after the supporting batch,
 * plus Ansira's own processing) — so a claim with a dozen files could never fit, and was killed
 * mid-upload every time while looking like a hang (`sales2`, 2026-07-31: 12 files, 6 invoices).
 * Scaling with the actual work keeps the watchdog ABOVE any legitimate run, which is the whole
 * point of it: it must only ever fire on a genuinely stuck run, never on a slow-but-working one.
 */
export const PORTAL_RUN_BASE_MS = 10 * 60_000;
export const PORTAL_RUN_PER_FILE_MS = 45_000;
export const PORTAL_RUN_MAX_MS = 45 * 60_000;

export function portalRunDeadlineMs(fileCount: number, baseMs: number = PORTAL_RUN_BASE_MS): number {
  const files = Number.isFinite(fileCount) && fileCount > 0 ? Math.floor(fileCount) : 0;
  return Math.min(PORTAL_RUN_MAX_MS, baseMs + files * PORTAL_RUN_PER_FILE_MS);
}

// ---------------------------------------------------------------------------
// Activity-dates gate. Production 2026-07-06 (Promotional apparel event claim,
// task agent_mr9qnn3k_96w3kv): the Ansira create form keeps its ENTIRE body
// (#app-wrapper-form — sub-detail, claim name, invoices, Save button) hidden until
// BOTH Activity dates are accepted. That claim's packet had no extractable dates,
// the runner's date fill is conditional (`if (startDate)`), so the form never
// expanded and the fill died 30s later on a hidden #activity-sub-detail with a
// generic "element is not visible" — which read like form drift and burned a live
// inspection to disprove (the form had NOT changed). These two summaries make the
// real causes loud: a packet with no dates fails BEFORE the form is touched, and a
// form that doesn't expand after the dates fails AT the gate, named as such.
// ---------------------------------------------------------------------------

/** Packet-level blocker: no activity dates → the form can never expand. */
export function missingActivityDatesSummary(claimTitle: string): string {
  return (
    `The MDF packet for "${claimTitle}" has no Activity start/end dates, and the Ansira create form keeps every other field ` +
    "hidden until both dates are set — so there is nothing the runner can fill. No draft was created (nothing was saved). " +
    "Add the activity dates to the claim (or fix the packet extraction) and run the portal draft again."
  );
}

/** The dates were filled but Ansira did not expand the form body. */
export function portalFormDidNotExpandSummary(): string {
  return (
    "The runner selected the Marketing Activity and set both Activity dates, but the rest of the Ansira form did not expand " +
    "(Ansira keeps it hidden until it accepts those inputs) — most likely a rejected date value/format or a new gating question " +
    "on the create form. No draft was created (nothing was saved). " +
    "Open the Create MDF Recap form in the runner's Chrome, check what it asks for after the dates, and update the runner if the form changed."
  );
}

// ---------------------------------------------------------------------------
// Session-expiry preflight (2026-07-17). The dominant portal-run failure class
// (4 of the 8 most recent failures — agent_mr3s6tv6 7/2 + agent_mrp010rb /
// agent_mrp0cs8u / agent_mrp0czzy all 7/17) was an EXPIRED H-DNet/Ansira session,
// discovered only after staff pressed "Start portal draft" and a full run burned
// (file downloads, navigation, or an entire browser-use pass) before landing on
// the sign-in screen. The runner already knows how to RECOGNIZE that screen when
// it fails (openAnsiraClaimFormThroughHNet's login checks); these helpers factor
// that same detection into a pure, browser-free form so the runner can probe the
// Ansira claims list read-only RIGHT AFTER the CDP attach — through the runner
// Chrome's own cookies, no credentials touched — and abort instantly with an
// actionable message instead of burning the run.
//
// Fail direction: a false "expired" verdict would turn away a live session, so the
// classifier only fires on POSITIVE sign-in markers (the SSO host / login routes in
// the final URL, or sign-in form text). An unreachable probe, an empty body, or an
// unrecognized landing NEVER blocks — the runner proceeds and the existing in-run
// login detection still applies downstream.
// ---------------------------------------------------------------------------

/** The logged-in Ansira MDF claims list — the session probe target. */
export const ANSIRA_CLAIMS_LIST_URL = "https://app.ansira.com/member/reimbursements/claims";

/**
 * Sign-in page TEXT markers — the runner's long-standing login-screen detection
 * (previously the runner-private isLoginPage), now shared so the early probe and
 * the in-run checks can never drift apart. "Create Claim" excludes the logged-in
 * Ansira create form, which legitimately mentions e.g. Microsoft-hosted assets.
 */
export function isSignInPageText(text: string): boolean {
  return /sign in|password|microsoft|enter your email|authenticate/i.test(text) && !/Create Claim/i.test(text);
}

export type SessionProbeLanding = {
  /** URL the probe RESOLVED to after redirects (an expired session 302s to sign-in). */
  finalUrl: string;
  /** Body of the landing page (HTML or text); empty/unreadable never classifies as expired. */
  bodyText?: string;
};

/**
 * True when the claims-list probe landed on a sign-in/SSO surface — the session is
 * expired. URL markers mirror the runner's in-run login check (onLogin): Microsoft's
 * SSO host (where H-DNet auth lives) or a /auth/login route; body markers reuse
 * isSignInPageText for an inline auth wall served without a redirect.
 */
export function isExpiredSessionLanding(landing: SessionProbeLanding): boolean {
  const url = String(landing?.finalUrl ?? "");
  if (/login\.microsoftonline\.com/i.test(url)) return true; // H-DNet SSO host
  if (/\/auth\/login/i.test(url)) return true; // Ansira's own login route
  return isSignInPageText(String(landing?.bodyText ?? ""));
}

/**
 * Operator-facing summary for the expired-session class — shared by the early
 * probe AND the in-run detection so the failure reads the same everywhere.
 * Wording is load-bearing: "sign-in screen" / "session has expired" keep it inside
 * the mdf-portal-health detector's LOAD_FAILURE_RE classes (pinned by the eval).
 */
export function sessionExpiredSummary(where: string): string {
  return (
    `The MDF runner hit the Ansira/H-DNet sign-in screen (${where}) — the session has expired. ` +
    "No draft was created (nothing was saved). " +
    "Log into h-dnet.com in the runner's dedicated Chrome window, confirm app.ansira.com/member/reimbursements/claims shows the claims list (not a login), then press Start portal draft again."
  );
}

/**
 * Microsoft "Pick an account" tile selection (saved-login click-through). Clicking
 * an account TILE is credential-free — it only chooses which account the ordinary
 * autofill/sign-in flow continues with — so it sits on the allowed side of the
 * runner's login rule (click Next/Sign-in: yes; read/type credentials: never).
 * Deterministic + conservative: pick the sole dealer-domain (@h-dnet.com) tile, or
 * the sole account-looking tile ("Use another account" / "Open menu" have no @ and
 * never match). ANY ambiguity → null → the runner stops for a human, the same
 * fail-direction as an unfillable password. (Production 2026-07-06: the fresh
 * sign-in flow opened on this picker and the click-through stopped one tile short.)
 */
export function pickAccountTileLabel(tileLabels: string[]): string | null {
  const candidates = tileLabels.map(t => String(t ?? "").trim()).filter(t => /@/.test(t));
  const dealer = candidates.filter(t => /@h-?dnet\.com/i.test(t));
  if (dealer.length === 1) return dealer[0];
  if (!dealer.length && candidates.length === 1) return candidates[0];
  return null;
}

/**
 * Activity-year extraction (2026-07-29 reliability audit). The old code took
 * `activityStartDate.slice(0, 4)` — correct for ISO ("2026-06-01") but for a US-format
 * packet date ("06/01/2026") it produced "06/0", so the guided packet told the human to
 * pick the marketing activity "06/0 Media Claim" (live 7/17 packets). The Playwright
 * label was separately HARDCODED to "2026" — a silent January-rollover bomb. One robust
 * extractor for both: first 4-digit year anywhere in the start/end date, else fallback.
 */
export function activityYearFromDates(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  fallbackYear: number
): string {
  for (const value of [startDate, endDate]) {
    const match = String(value ?? "").match(/\b(19|20)\d{2}\b/);
    if (match) return match[0];
  }
  return String(fallbackYear);
}

/**
 * Rescue-summary composition (2026-07-29). When automation fails and the guided-packet
 * rescue succeeds, the task summary used to be ONLY the rescue text — the actual failure
 * reason was dropped (every 7/17 blocked task reads a generic "blocked before completion"
 * with no why). Reliability rule: the WHY always survives into the task the human reads.
 */
export function composeRescueSummary(failureReason: string, rescueSummary: string): string {
  const reason = String(failureReason ?? "").trim();
  const rescue = String(rescueSummary ?? "").trim();
  if (!reason) return rescue;
  return `${rescue}\n\nWhy automation stopped: ${reason}`;
}

/**
 * Session-retry queue policy (2026-07-29). When the session preflight blocks a run
 * (expired H-DNet/Ansira SSO — the dominant failure class), the runner records the task
 * in a local retry queue and, once a later tick sees the session live again,
 * automatically re-runs it — the human just logs in; no re-clicking "Start portal
 * draft". SAFETY: only PREFLIGHT-blocked tasks enter the queue (the preflight aborts
 * before ANY portal interaction, so a retry can never duplicate a draft). Pure policy
 * helpers so the eval can pin them.
 */
export type SessionRetryEntry = {
  taskId: string;
  claimId: string;
  blockedAtMs: number;
  attempts: number;
};

export const SESSION_RETRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_RETRY_MAX_ATTEMPTS = 2;

/** Drop stale / exhausted entries. */
export function pruneSessionRetryQueue(entries: SessionRetryEntry[], nowMs: number): SessionRetryEntry[] {
  return (entries ?? []).filter(
    entry =>
      entry &&
      typeof entry.taskId === "string" &&
      entry.taskId.length > 0 &&
      Number.isFinite(entry.blockedAtMs) &&
      nowMs - entry.blockedAtMs < SESSION_RETRY_MAX_AGE_MS &&
      (entry.attempts ?? 0) < SESSION_RETRY_MAX_ATTEMPTS
  );
}

/** Add-or-refresh an entry (idempotent on taskId; attempts preserved). */
export function upsertSessionRetryEntry(
  entries: SessionRetryEntry[],
  entry: { taskId: string; claimId: string },
  nowMs: number
): SessionRetryEntry[] {
  const existing = (entries ?? []).find(row => row.taskId === entry.taskId);
  if (existing) return entries;
  return [...(entries ?? []), { taskId: entry.taskId, claimId: entry.claimId, blockedAtMs: nowMs, attempts: 0 }];
}

/** The summary for a preflight-blocked task once the login page has been auto-opened. */
export function sessionExpiredAutoRetrySummary(where: string): string {
  return (
    `The MDF runner hit the Ansira/H-DNet sign-in screen (${where}) — the session has expired. ` +
    "No draft was created (nothing was saved). " +
    "The H-DNet login page has been opened in the runner's dedicated Chrome window — log in there (approve MFA if asked). " +
    "The runner will retry this claim automatically once the session is back; no need to press Start portal draft again."
  );
}
