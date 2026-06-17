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

/** Operator-facing summary for a failed preflight (returned as the task result). */
export function ansiraFormChangedSummary(missing: PreflightControl[]): string {
  return (
    "MDF preflight failed — the Ansira Create MDF Recap form is missing controls the runner depends on. " +
    "This usually means Ansira changed the form layout. No draft was created (nothing was saved). " +
    `Missing: ${formatMissingControls(missing)}. ` +
    "Re-inspect the form in the runner's Chrome window and update the runner's selectors before retrying."
  );
}
