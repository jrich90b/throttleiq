/**
 * MDF spreadsheet source-file extraction eval (deterministic — no LLM).
 *
 * Pins that CSV and XLSX claim source files are parsed into text the MDF extractor
 * can read (spreadsheetFileToText in services/api/src/domain/mdfAssistant.ts). Origin:
 * managers needed to attach Excel/CSV media-spend exports as claim source files, but
 * the extractor only ingested images/PDFs, so a spreadsheet attached without its
 * content ever reaching the LLM. CSV is decoded directly; XLSX via exceljs.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { spreadsheetFileToText, sumInvoiceSpend } from "../services/api/src/domain/mdfAssistant.ts";

// Pin the upload whitelist (buildMdfPacketFromUploads in index.ts) so the xlsx/csv
// mime types + the .csv/.xlsx extension fallback can't be narrowed back out — that
// whitelist throws BEFORE the extractor runs, so parsing support alone isn't enough.
const apiIndex = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.ok(
  apiIndex.includes("spreadsheetml.sheet") && apiIndex.includes("allowedByExt"),
  "MDF claim upload whitelist must accept Excel (xlsx mime) + CSV via the .csv/.xlsx extension fallback"
);

function file(name: string, mimeType: string, buffer: Buffer) {
  return { name, mimeType, size: buffer.length, buffer };
}

// CSV by mime type.
const csv = Buffer.from("Vendor,Spend,Invoice\nMeta Platforms,1234.56,INV-9001\n", "utf-8");
const csvText = await spreadsheetFileToText(file("media.csv", "text/csv", csv));
assert.ok(
  csvText && csvText.includes("Meta Platforms") && csvText.includes("1234.56") && csvText.includes("INV-9001"),
  "CSV cell values are extracted to text"
);

// CSV detected by extension even when the browser sends a generic mime type.
const csvByExt = await spreadsheetFileToText(file("media.csv", "application/octet-stream", csv));
assert.ok(csvByExt && csvByExt.includes("INV-9001"), "CSV is detected by .csv extension");

// XLSX via exceljs round-trip.
const mod: any = await import("exceljs");
const ExcelJS = mod.default ?? mod;
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Spend");
ws.addRow(["Vendor", "Spend", "Invoice"]);
ws.addRow(["Meta Platforms", 1234.56, "INV-9001"]);
const xbuf = Buffer.from(await wb.xlsx.writeBuffer());
const xlsxText = await spreadsheetFileToText(
  file("media.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xbuf)
);
assert.ok(
  xlsxText && xlsxText.includes("Meta Platforms") && xlsxText.includes("1234.56") && xlsxText.includes("INV-9001"),
  "XLSX cell values are extracted to text"
);
assert.ok(xlsxText!.includes("# Sheet: Spend"), "XLSX sheet name is included");

// Non-spreadsheet files must NOT be treated as spreadsheets (they keep their image/PDF path).
assert.equal(
  await spreadsheetFileToText(file("invoice.pdf", "application/pdf", Buffer.from("%PDF-1.4"))),
  null,
  "PDF is not treated as a spreadsheet"
);
assert.equal(
  await spreadsheetFileToText(file("photo.png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47]))),
  null,
  "image is not treated as a spreadsheet"
);

// A corrupt/non-xlsx buffer degrades to null (skipped), never throws.
assert.equal(
  await spreadsheetFileToText(
    file("broken.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", Buffer.from("not a real xlsx"))
  ),
  null,
  "corrupt xlsx degrades to null instead of throwing"
);

// --- Multi-invoice claim total: headline spend = SUM of all invoices, not the primary
// (Taste of Country 6/22: two invoices $2446.88 + $61.40 mirrored only $2446.88). ---
assert.equal(
  sumInvoiceSpend([{ amount: "2446.88" }, { amount: "61.40" }]),
  "2508.28",
  "two invoices sum to the full claim total"
);
assert.equal(
  sumInvoiceSpend([{ amount: "$2,446.88" }, { amount: "$61.40" }]),
  "2508.28",
  "amounts with $ and commas still sum"
);
assert.equal(sumInvoiceSpend([{ amount: "2446.88" }]), null, "single invoice keeps the extracted value (no override)");
assert.equal(sumInvoiceSpend([]), null, "no invoices => no override");
assert.equal(
  sumInvoiceSpend([{ amount: "100.00" }, { amount: "" }]),
  null,
  "only one parseable amount => no override (don't fabricate a partial total)"
);

console.log("PASS mdf spreadsheet extract eval");
