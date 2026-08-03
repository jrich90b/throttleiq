/**
 * MDF portal upload outcome — what ACTUALLY attached, stated honestly.
 *
 * WHY THIS EXISTS (production, 2026-08-03, claim mdf_498ac7ea88726 / Ansira RB26080001112054).
 * The runner's summary reported "Uploaded 1 invoice file(s) and 2 supporting file(s)" and carried
 * no warning — but that count came from the files it had DOWNLOADED ready to upload, not from the
 * files that reached the form. Two paths could skip an upload without recording anything:
 *
 *   - the invoice row's file input was not found on the page  -> `continue`, silently
 *   - the supporting-documents input was not found            -> the whole block was skipped
 *
 * Neither raised an error, so the "ATTENTION - file upload(s) did NOT attach" guard never fired and
 * a draft with nothing attached read exactly like a clean one. That is the precise failure the
 * runner's own comment warns about: "a draft missing an invoice looks identical to a complete one
 * in the console, and the dealer finds out at Harley."
 *
 * THE INVARIANT, and it is the whole point of this module: **planned > attached MUST produce an
 * attention line, whether or not anything threw.** A missing control is not a quiet no-op; it is an
 * upload that did not happen, and it must be as loud as one that failed.
 *
 * FAIL DIRECTION: over-warning is free (a human re-checks a draft that was actually fine); under-
 * warning sends an incomplete claim to Harley with a clean-looking summary. So anything the runner
 * cannot positively confirm attached counts as NOT attached.
 *
 * Pure and browser-free so `mdf_upload_outcome:eval` can pin it without a portal session.
 */

export type MdfUploadOutcome = {
  /** Invoice files the runner downloaded and intended to attach. */
  plannedInvoiceFiles: number;
  /** Invoice files the runner positively confirmed onto a form control. */
  attachedInvoiceFiles: number;
  /** Supporting files the runner downloaded and intended to attach. */
  plannedSupportFiles: number;
  /** Supporting files the runner positively confirmed onto a form control. */
  attachedSupportFiles: number;
  /** Named reasons — a throw, a missing control, a timeout. One per skipped/failed upload. */
  failures: string[];
};

export type MdfUploadReport = {
  /** The counts line for the run summary. Always states what ATTACHED. */
  countsLine: string;
  /** Non-null whenever anything did not attach. Never suppressed. */
  attentionLine: string | null;
  /** True only when every planned file is confirmed attached. */
  allAttached: boolean;
  /** How many planned files never made it, by any cause. */
  missingCount: number;
};

const nonNegative = (n: unknown): number => {
  const value = Number(n);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
};

export function describeMdfUploadOutcome(outcome: MdfUploadOutcome): MdfUploadReport {
  const plannedInvoice = nonNegative(outcome?.plannedInvoiceFiles);
  const plannedSupport = nonNegative(outcome?.plannedSupportFiles);
  // An attached count can never exceed what was planned — a bug that inflated it would otherwise
  // read as "more attached than intended" and hide a shortfall. Clamp, don't trust.
  const attachedInvoice = Math.min(nonNegative(outcome?.attachedInvoiceFiles), plannedInvoice);
  const attachedSupport = Math.min(nonNegative(outcome?.attachedSupportFiles), plannedSupport);
  const failures = Array.isArray(outcome?.failures) ? outcome.failures.filter(f => String(f ?? "").trim()) : [];

  const missingInvoice = plannedInvoice - attachedInvoice;
  const missingSupport = plannedSupport - attachedSupport;
  const missingCount = missingInvoice + missingSupport;
  const allAttached = missingCount === 0;

  // The counts line states ATTACHED, and names the planned total whenever they differ — so the
  // number a human reads is the number that reached Ansira, never the number we hoped to send.
  const invoicePart = missingInvoice
    ? `${attachedInvoice} of ${plannedInvoice} invoice file(s)`
    : `${attachedInvoice} invoice file(s)`;
  const supportPart = missingSupport
    ? `${attachedSupport} of ${plannedSupport} supporting file(s)`
    : `${attachedSupport} supporting file(s)`;
  const countsLine = `Uploaded ${invoicePart} and ${supportPart}.`;

  if (allAttached) return { countsLine, attentionLine: null, allAttached, missingCount };

  // A shortfall with no named reason is the silent-skip case this module exists for. Say so
  // explicitly rather than emitting an attention line with an empty cause, which reads like a
  // glitch and gets ignored.
  const reasons = failures.length
    ? failures.join("; ")
    : "no error was raised — the upload control was not found on the page, so the file was never attached";
  const attentionLine =
    `ATTENTION - ${missingCount} file upload(s) did NOT attach and must be added by hand before ` +
    `submitting: ${reasons}.`;

  return { countsLine, attentionLine, allAttached, missingCount };
}
