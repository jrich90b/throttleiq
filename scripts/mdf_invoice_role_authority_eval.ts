/**
 * MDF invoice ROLE-AUTHORITY eval (pure, no LLM).
 *
 * Pins the fix for "creative used as an invoice" + "two invoices, only one parsed": invoices[] is now
 * extracted PER-FILE and ROLE-RESPECTING (extractInvoicesPerFile over invoiceCandidateFiles) as the
 * AUTHORITY — the main pass only supplies non-invoice details. So a creative/proof file can never become
 * an invoice or inflate spend, and two invoices never merge.
 *
 * Layers:
 *  1) invoiceCandidateFiles — excludes creative/proof/support-only (by providedRole OR filename), keeps
 *     invoice/receipt/unknown image+PDF; non-image/PDF (csv) excluded.
 *  2) syncExtractedInvoiceFields — headline vendor/date/number/spend mirror the authoritative invoice set;
 *     BLANK when there are no invoices (so creative numbers can't surface as spend); spend = SUM for 2+.
 *  3) Source guards — extractMdfClaimPacket makes the per-file pass authoritative + syncs the headline,
 *     gated by invoiceCandidateFiles; the per-file pass runs for 1+ candidates; the old single-call
 *     invoice fallback/merge path is gone.
 *
 * Run: npx tsx scripts/mdf_invoice_role_authority_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  invoiceCandidateFiles,
  syncExtractedInvoiceFields,
  sumInvoiceSpend,
  invoicesFromInvoiceRoleFiles,
  auditMdfExtraction
} from "../services/api/src/domain/mdfAssistant.ts";

// --- 1) invoiceCandidateFiles: role-respecting, image/PDF only. ---
const f = (name: string, mimeType: string, providedRole?: string) => ({ name, mimeType, size: 1000, providedRole } as any);
const files = [
  f("scan.jpg", "image/jpeg", "invoice"),        // keep
  f("receipt.pdf", "application/pdf", "receipt"), // keep
  f("photo.jpg", "image/jpeg"),                   // keep (unknown image — per-file self-filters)
  f("event-flyer.png", "image/png", "creative"),  // drop (creative role)
  f("screenshot.png", "image/png", "proof_of_performance"), // drop (proof)
  f("notes.png", "image/png", "supporting_only"), // drop (support-only)
  f("flyer.png", "image/png"),                    // drop (filename -> creative)
  f("data.csv", "text/csv", "invoice")            // drop (not image/PDF)
];
const candidateNames = invoiceCandidateFiles(files).map(x => x.name).sort();
assert.deepEqual(
  candidateNames,
  ["photo.jpg", "receipt.pdf", "scan.jpg"].sort(),
  `invoiceCandidateFiles should keep only invoice-eligible image/PDF files, got ${JSON.stringify(candidateNames)}`
);
// A creative is NEVER a candidate even if its filename looks invoice-ish.
assert.equal(invoiceCandidateFiles([f("invoice-flyer.png", "image/png", "creative")]).length, 0, "an explicit creative role wins over the filename");

// --- 2) syncExtractedInvoiceFields: authoritative mirror + blank-when-empty. ---
const mkPacket = (invoices: any[]) => ({
  extractedFields: { vendorName: "STALE", invoiceDate: "STALE", invoiceNumber: "STALE", spend: "STALE" }
, invoices } as any);

// No invoices -> headline blanks (a creative's numbers can't surface).
const empty = mkPacket([]);
syncExtractedInvoiceFields(empty);
assert.deepEqual(
  [empty.extractedFields.vendorName, empty.extractedFields.invoiceDate, empty.extractedFields.invoiceNumber, empty.extractedFields.spend],
  ["", "", "", ""],
  "no invoices => all headline invoice fields blank"
);

// One invoice -> primary fields; spend = that invoice's amount (sum returns null for <2).
const one = mkPacket([{ vendorName: "IBBQ", invoiceDate: "2026-06-01", invoiceNumber: "A1", amount: "$2446.88", fileNames: ["a.pdf"] }]);
syncExtractedInvoiceFields(one);
assert.equal(one.extractedFields.vendorName, "IBBQ");
assert.equal(one.extractedFields.invoiceNumber, "A1");
assert.equal(one.extractedFields.invoiceDate, "2026-06-01");
assert.equal(one.extractedFields.spend, "$2446.88", "single invoice keeps its amount verbatim");

// Two invoices -> primary's vendor/date/number; spend = SUM (Taste of Country case: 2446.88 + 61.40).
const two = mkPacket([
  { vendorName: "IBBQ", invoiceDate: "2026-06-01", invoiceNumber: "A1", amount: "$2446.88", fileNames: ["a.pdf"] },
  { vendorName: "Consumer's Beverages", invoiceDate: "2026-06-02", invoiceNumber: "B2", amount: "$61.40", fileNames: ["b.pdf"] }
]);
syncExtractedInvoiceFields(two);
assert.equal(two.extractedFields.vendorName, "IBBQ", "headline vendor = primary invoice");
assert.equal(two.extractedFields.spend, "2508.28", "headline spend = SUM of all invoices");
assert.equal(sumInvoiceSpend(two.invoices), "2508.28");

// --- 2b) Fallback: keep main-pass invoices supported by an invoice file; drop creative-only ones. ---
const roleFiles = [f("inv.pdf", "application/pdf", "invoice"), f("flyer.png", "image/png", "creative")];
const filtered = invoicesFromInvoiceRoleFiles(
  [
    { vendorName: "Real", amount: "$50", fileNames: ["inv.pdf"] } as any,        // keep (invoice file)
    { vendorName: "Flyer$", amount: "$99", fileNames: ["flyer.png"] } as any,    // drop (creative only)
    { vendorName: "Mixed", amount: "$10", fileNames: ["flyer.png", "inv.pdf"] } as any, // keep (has invoice file)
    { vendorName: "Unattributed", amount: "$5", fileNames: [] } as any           // keep (can't prove creative)
  ],
  roleFiles
).map((i: any) => i.vendorName).sort();
assert.deepEqual(filtered, ["Mixed", "Real", "Unattributed"].sort(), "fallback drops only invoices sourced solely from creative/proof");

// --- 2c) Watchdog: surface a no-invoice extraction despite invoice-eligible uploads. ---
const candFiles = [f("scan.jpg", "image/jpeg", "invoice")];
assert.ok(
  /Couldn't read invoice details/i.test(auditMdfExtraction({ invoices: [], eligibility: { concerns: [] } } as any, candFiles).join(" ")),
  "watchdog flags invoice-eligible files that produced no invoices"
);
assert.deepEqual(
  auditMdfExtraction({ invoices: [{ vendorName: "X", amount: "$50", fileNames: ["scan.jpg"] }], eligibility: { concerns: [] } } as any, candFiles),
  [],
  "a clean single-invoice extraction raises no warnings"
);
assert.ok(
  /without an amount/i.test(auditMdfExtraction({ invoices: [{ vendorName: "X", amount: "", fileNames: ["scan.jpg"] }] } as any, candFiles).join(" ")),
  "watchdog flags an invoice extracted without an amount"
);
assert.ok(
  /without a vendor/i.test(auditMdfExtraction({ invoices: [{ vendorName: "", amount: "$50", fileNames: ["scan.jpg"] }] } as any, candFiles).join(" ")),
  "watchdog flags an invoice extracted without a vendor"
);
assert.deepEqual(
  auditMdfExtraction({ invoices: [] } as any, [f("flyer.png", "image/png", "creative")]),
  [],
  "creative-only upload (no invoice candidates) is not flagged"
);

// --- 3) Source guards. ---
const src = fs.readFileSync("services/api/src/domain/mdfAssistant.ts", "utf8");
assert.ok(
  /perFile\.length \? perFile : invoicesFromInvoiceRoleFiles\(packet\.invoices, files\)/.test(src),
  "a per-file miss must fall back to role-filtered main-pass invoices (don't silently blank an uploaded invoice)"
);
assert.ok(/auditMdfExtraction\(packet, files\)/.test(src) && /mdf-extract-watchdog/.test(src), "the packet watchdog must run + log");
assert.ok(/never 'American Harley-Davidson'|NOT 'American Harley-Davidson'/.test(src), "the extractor prompt must clarify vendorName is the seller/supplier, not the dealer itself");
assert.ok(/"mdf_invoice_fields", 3000/.test(src), "the per-file call must have enough token headroom (3000) to avoid truncation");
assert.ok(
  /const perFile = await extractInvoicesPerFile\(files, model\)/.test(src),
  "extractMdfClaimPacket must make the per-file pass the AUTHORITY for invoices[]"
);
assert.ok(/const candidates = invoiceCandidateFiles\(files\);/.test(src), "the main flow must gate on invoiceCandidateFiles");
assert.ok(/syncExtractedInvoiceFields\(packet\)/.test(src), "the main flow must re-sync the headline fields from the authoritative invoices");
assert.ok(/if \(!candidates\.length\) return \[\];/.test(src), "extractInvoicesPerFile must run for 1+ candidate files (not only 2+)");
assert.ok(
  !/function mergeInvoiceFields|async function extractInvoiceFields|function shouldRunInvoiceOnlyPass/.test(src),
  "the old single-call invoice fallback/merge path must be removed"
);

console.log("PASS mdf invoice role-authority eval — invoiceCandidateFiles + syncExtractedInvoiceFields + source guards");
