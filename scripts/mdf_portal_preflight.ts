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
  const norm = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const need = norm(requiredLabel);
  if (!need) return null;
  const present = availableOptions.some(option => norm(option).includes(need));
  if (present) return null;
  const shown = availableOptions.map(option => option.trim()).filter(Boolean);
  return (
    `Marketing Activity option "${requiredLabel}" was not found in the dropdown ` +
    "(the runner needs it to pick the claim type — most likely an Ansira rename such as a year rollover). " +
    `Available options: ${shown.length ? shown.join(", ") : "(none)"}.`
  );
}

/** Operator-facing summary when the required Marketing Activity option is missing/renamed. */
export function ansiraMarketingOptionSummary(detail: string): string {
  return preflightFailureSummary(detail);
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

const RUNNER_CHROME_RESTART_HINT =
  "Restart the runner Chrome (launchctl kickstart -k gui/501/ai.leadrider.hdnet-chrome) and keep that window for portal work only, then run the portal draft again.";

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
export function portalRunDeadlineSummary(deadlineMinutes: number): string {
  return (
    `The MDF portal run timed out after ${deadlineMinutes} minutes and was abandoned — the runner Chrome stopped responding mid-run ` +
    "(a browser call hung with no timeout; the attach itself had succeeded). " +
    RUNNER_CHROME_RESTART_HINT +
    " Before re-running, check the Ansira claims list for a draft from this run — a hung run normally never reaches Save for Later, but verify so a re-run can't create a duplicate."
  );
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
