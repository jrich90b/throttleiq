/**
 * mdf_upload_outcome:eval — the MDF run summary must state what ATTACHED, and a shortfall must
 * always be loud.
 *
 * THE INCIDENT THIS PINS (2026-08-03, claim mdf_498ac7ea88726 / Ansira RB26080001112054). The
 * runner reported "Uploaded 1 invoice file(s) and 2 supporting file(s)" with no warning, and the
 * invoice was not on the claim. The count came from the files DOWNLOADED ready to upload, and two
 * code paths skipped an upload without recording anything: an invoice row whose file input was not
 * found (`continue`, silently) and a missing supporting-documents input (block skipped). Nothing
 * threw, so the "ATTENTION - did NOT attach" guard never fired, and a draft with nothing attached
 * read exactly like a complete one.
 *
 * THE INVARIANT: planned > attached MUST produce an attention line, with or without a thrown error.
 * The dangerous state is not "an upload failed" — that was always reported. It is "an upload never
 * happened and nobody noticed."
 *
 * FAIL DIRECTION: over-warning costs a human a second look at a draft that was fine; under-warning
 * sends an incomplete claim to Harley behind a clean summary. Anything not positively confirmed
 * counts as NOT attached.
 *
 * Behavior assertions only — no source-text pins (see eval_source_pin_ratchet:eval).
 *
 * Run: npx tsx scripts/mdf_upload_outcome_eval.ts
 */
import assert from "node:assert/strict";

const { describeMdfUploadOutcome } = await import("./lib/mdfUploadOutcome.ts");

let checks = 0;
const eq = (actual: unknown, expected: unknown, message: string) => {
  assert.deepEqual(actual, expected, message);
  checks++;
};
const ok = (cond: boolean, message: string) => {
  assert.equal(cond, true, message);
  checks++;
};

// --- THE REGRESSION CASE: the exact production shape that fooled us -------------------------------
// One invoice PDF + two .xlsx planned; the form's upload controls were not found, so nothing
// attached and nothing threw. Before the fix this produced "Uploaded 1 invoice file(s) and 2
// supporting file(s)." with no warning at all.
{
  const report = describeMdfUploadOutcome({
    plannedInvoiceFiles: 1,
    attachedInvoiceFiles: 0,
    plannedSupportFiles: 2,
    attachedSupportFiles: 0,
    failures: [] // <- the whole point: NOTHING threw
  });
  ok(
    !/Uploaded 1 invoice file\(s\) and 2 supporting file\(s\)\./.test(report.countsLine),
    "the counts line must NOT report the planned totals as uploaded"
  );
  eq(
    report.countsLine,
    "Uploaded 0 of 1 invoice file(s) and 0 of 2 supporting file(s).",
    "it states what attached, out of what was planned"
  );
  ok(report.attentionLine !== null, "a shortfall with NO thrown error must still raise ATTENTION");
  ok(
    /ATTENTION/.test(String(report.attentionLine)) && /3 file upload\(s\) did NOT attach/.test(String(report.attentionLine)),
    "...naming how many never made it"
  );
  ok(
    /upload control was not found/.test(String(report.attentionLine)),
    "...and saying WHY, rather than an empty cause that reads like a glitch"
  );
  eq(report.allAttached, false, "and the run is not clean");
  eq(report.missingCount, 3, "all three files are counted missing");
}

// --- the clean case stays clean (no false alarms) -------------------------------------------------
// Over-warning is cheap but not free: an attention line on every good run trains people to ignore it.
{
  const report = describeMdfUploadOutcome({
    plannedInvoiceFiles: 1,
    attachedInvoiceFiles: 1,
    plannedSupportFiles: 2,
    attachedSupportFiles: 2,
    failures: []
  });
  eq(report.countsLine, "Uploaded 1 invoice file(s) and 2 supporting file(s).", "a full upload reads plainly");
  eq(report.attentionLine, null, "no attention line when everything attached");
  eq(report.allAttached, true, "the run is clean");
  eq(report.missingCount, 0, "nothing missing");
}

// --- a claim with no files at all is clean, not a shortfall ---------------------------------------
{
  const report = describeMdfUploadOutcome({
    plannedInvoiceFiles: 0,
    attachedInvoiceFiles: 0,
    plannedSupportFiles: 0,
    attachedSupportFiles: 0,
    failures: []
  });
  eq(report.attentionLine, null, "nothing planned means nothing missing — no phantom warning");
  eq(report.allAttached, true, "and the run is clean");
}

// --- a thrown failure still reports, and keeps its named reason -----------------------------------
// This path always worked; pinned so the rewrite cannot lose it.
{
  const report = describeMdfUploadOutcome({
    plannedInvoiceFiles: 2,
    attachedInvoiceFiles: 1,
    plannedSupportFiles: 0,
    attachedSupportFiles: 0,
    failures: ["invoice row 2 (Invoice_B.pdf): Timeout 120000ms exceeded"]
  });
  eq(report.countsLine, "Uploaded 1 of 2 invoice file(s) and 0 supporting file(s).", "partial upload states the shortfall");
  ok(
    /Timeout 120000ms exceeded/.test(String(report.attentionLine)),
    "the thrown reason survives into the summary verbatim"
  );
  eq(report.missingCount, 1, "one file missing");
}

// --- PARTIAL SILENT SKIP: some attached, some vanished with no error ------------------------------
// The nastiest shape — a run that looks mostly right. Must still warn.
{
  const report = describeMdfUploadOutcome({
    plannedInvoiceFiles: 3,
    attachedInvoiceFiles: 2,
    plannedSupportFiles: 1,
    attachedSupportFiles: 1,
    failures: []
  });
  eq(report.countsLine, "Uploaded 2 of 3 invoice file(s) and 1 supporting file(s).", "only the short side is qualified");
  ok(report.attentionLine !== null, "one silently-missing invoice out of three still warns");
  eq(report.missingCount, 1, "exactly one missing");
}

// --- an inflated attached count can never mask a shortfall ----------------------------------------
// Defensive: a counting bug that over-increments must not read as "more attached than planned" and
// quietly cancel a real gap.
{
  const report = describeMdfUploadOutcome({
    plannedInvoiceFiles: 1,
    attachedInvoiceFiles: 5,
    plannedSupportFiles: 0,
    attachedSupportFiles: 3,
    failures: []
  });
  eq(report.countsLine, "Uploaded 1 invoice file(s) and 0 supporting file(s).", "attached is clamped to planned");
  eq(report.missingCount, 0, "and cannot go negative to hide a gap elsewhere");
}

// --- malformed input fails toward warning, never toward silence -----------------------------------
{
  const report = describeMdfUploadOutcome({
    plannedInvoiceFiles: 2,
    attachedInvoiceFiles: undefined as any,
    plannedSupportFiles: undefined as any,
    attachedSupportFiles: null as any,
    failures: ["", "   "] // blank reasons must not count as named causes
  });
  eq(report.missingCount, 2, "an unreadable attached count is treated as nothing attached");
  ok(report.attentionLine !== null, "...and warns");
  ok(
    /no error was raised/.test(String(report.attentionLine)),
    "blank failure strings are not mistaken for a named reason"
  );
}

console.log(`mdf_upload_outcome:eval OK — ${checks} checks`);
