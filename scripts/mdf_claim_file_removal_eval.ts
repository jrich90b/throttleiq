/**
 * Taking an uploaded document back off an MDF claim (Joe, 2026-08-10: "there is nowhere to delete an
 * invoice if you already uploaded it... let's say you uploaded an invoice on accident").
 *
 * The claim holds the same document twice — as a file the runner ATTACHES (`packet.uploadedFiles`)
 * and as an invoice ROW the runner TYPES (`packet.invoices[].fileNames`). Removing only one of the
 * two is worse than not removing anything:
 *   - file gone, row left  → the runner types a claim line into Ansira with no document behind it;
 *   - row gone too         → a mis-upload silently destroys numbers a human typed.
 *
 * So the reducer removes the FILE, stops any row referencing it, and REPORTS rows left with no
 * evidence for the console to warn on. Nothing typed is discarded; nothing unsupported goes out
 * unnoticed.
 *
 * Fail direction: it can only ever detach ONE named document and describe what that left behind. It
 * never edits an amount and never touches stored bytes.
 *
 * Run: npx tsx scripts/mdf_claim_file_removal_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  removeUploadedFileFromPacket,
  uploadedFileKey
} from "../services/api/src/domain/mdfClaimFileRemoval.ts";

const invoiceFile = { name: "Invoice_INV1905640.pdf", type: "application/pdf", size: 20480, url: "https://x/i1", inferredRole: "invoice" };
const wrongFile = { name: "Invoice_WRONG.pdf", type: "application/pdf", size: 4096, url: "https://x/w1", inferredRole: "invoice" };
const supportFile = { name: "Keywords-18.xlsx", type: "application/xlsx", size: 8192, url: "https://x/k1", inferredRole: "supporting_only" };

const basePacket = () => ({
  uploadedFiles: [{ ...invoiceFile }, { ...wrongFile }, { ...supportFile }],
  invoices: [
    { vendorName: "Room58", invoiceDate: "07/01/2026", invoiceNumber: "INV1905640", amount: "1200.00", fileNames: ["Invoice_INV1905640.pdf"], description: "" },
    { vendorName: "Oops Vendor", invoiceDate: "07/02/2026", invoiceNumber: "WRONG", amount: "999.00", fileNames: ["Invoice_WRONG.pdf"], description: "" }
  ],
  descriptionDraft: "keep me"
});

// ---------- identity ----------
assert.equal(
  uploadedFileKey({ name: "A.pdf", size: 10, url: "https://x/a" }),
  uploadedFileKey({ name: " a.PDF ", size: 10, url: "HTTPS://X/A" }),
  "the key is case- and whitespace-insensitive, so the console button and the stored row agree"
);
assert.notEqual(
  uploadedFileKey({ name: "A.pdf", size: 10, url: "https://x/a" }),
  uploadedFileKey({ name: "A.pdf", size: 11, url: "https://x/a" }),
  "same name, different size => a different document"
);

// ---------- the ordinary case: remove the wrong invoice ----------
{
  const before = basePacket();
  const out = removeUploadedFileFromPacket(before, { name: "Invoice_WRONG.pdf", size: 4096, url: "https://x/w1" });
  assert.equal(out.removed, true, "the named file comes off");
  assert.equal(out.removedFile?.name, "Invoice_WRONG.pdf", "and is reported back for the confirmation");
  assert.deepEqual(
    out.packet.uploadedFiles?.map(f => f.name),
    ["Invoice_INV1905640.pdf", "Keywords-18.xlsx"],
    "the other documents are untouched"
  );
  // The row that named it no longer claims a file it does not have...
  const wrongRow = out.packet.invoices?.find(r => r.invoiceNumber === "WRONG");
  assert.deepEqual(wrongRow?.fileNames, [], "the invoice row stops referencing the removed file");
  // ...and because a human typed money into it, it is KEPT and REPORTED, never silently dropped.
  assert.equal(wrongRow?.amount, "999.00", "typed detail is never destroyed by a file removal");
  assert.equal(out.orphanedInvoices.length, 1, "the now-unevidenced row is reported to the caller");
  assert.equal(out.orphanedInvoices[0]?.invoiceNumber, "WRONG", "and it is the right row");
  // The good invoice is completely unaffected.
  const goodRow = out.packet.invoices?.find(r => r.invoiceNumber === "INV1905640");
  assert.deepEqual(goodRow?.fileNames, ["Invoice_INV1905640.pdf"], "the untouched invoice keeps its file");
  assert.equal(out.orphanedInvoices.some(r => r.invoiceNumber === "INV1905640"), false, "and is not flagged");
  // Nothing else in the packet is disturbed.
  assert.equal((out.packet as any).descriptionDraft, "keep me", "the rest of the packet is carried through");
  // PURE: the input packet is not mutated.
  assert.equal(before.uploadedFiles.length, 3, "the caller's packet is not mutated in place");
}

// ---------- a row that was pure residue (no typed detail) is dropped, not reported ----------
{
  const packet = {
    uploadedFiles: [{ ...wrongFile }],
    invoices: [{ vendorName: "", invoiceDate: "", invoiceNumber: "", amount: "", fileNames: ["Invoice_WRONG.pdf"], description: "" }]
  };
  const out = removeUploadedFileFromPacket(packet, { name: "Invoice_WRONG.pdf", size: 4096, url: "https://x/w1" });
  assert.equal(out.packet.invoices?.length, 0, "an empty row that only existed for that file goes with it");
  assert.equal(out.orphanedInvoices.length, 0, "and there is nothing to warn about");
}

// ---------- the same filename on ANOTHER surviving upload keeps its references ----------
{
  const packet = {
    uploadedFiles: [
      { name: "Invoice.pdf", type: "application/pdf", size: 100, url: "https://x/1", inferredRole: "invoice" },
      { name: "Invoice.pdf", type: "application/pdf", size: 200, url: "https://x/2", inferredRole: "invoice" }
    ],
    invoices: [{ vendorName: "V", invoiceDate: "", invoiceNumber: "1", amount: "5", fileNames: ["Invoice.pdf"], description: "" }]
  };
  const out = removeUploadedFileFromPacket(packet, { name: "Invoice.pdf", size: 100, url: "https://x/1" });
  assert.equal(out.packet.uploadedFiles?.length, 1, "only the selected copy is removed");
  assert.deepEqual(
    out.packet.invoices?.[0]?.fileNames,
    ["Invoice.pdf"],
    "the row keeps the name, because a surviving upload still carries it"
  );
  assert.equal(out.orphanedInvoices.length, 0, "so nothing is orphaned");
}

// ---------- a file that is not on the claim is NOT a silent success ----------
{
  const out = removeUploadedFileFromPacket(basePacket(), { name: "NotHere.pdf", size: 1, url: "" });
  assert.equal(out.removed, false, "no match => removed:false, so the caller 404s instead of lying");
  assert.equal(out.packet.uploadedFiles?.length, 3, "and nothing is changed");
}

// ---------- malformed packets are inert ----------
assert.equal(removeUploadedFileFromPacket({} as any, { name: "x" }).removed, false, "empty packet => nothing removed");
assert.equal(
  removeUploadedFileFromPacket({ uploadedFiles: null, invoices: null } as any, { name: "x" }).removed,
  false,
  "null collections => nothing removed"
);

// ---------- wiring: the endpoint and the console button exist and agree ----------
{
  const idx = fs.readFileSync("services/api/src/index.ts", "utf8");
  const web = fs.readFileSync("apps/web/src/app/page.tsx", "utf8");
  assert.match(
    idx,
    /app\.post\("\/mdf\/claims\/:id\/remove-file", requireManager,/,
    "the endpoint exists and is manager-gated"
  );
  assert.match(
    idx,
    /if \(!result\.removed\) return res\.status\(404\)/,
    "an unmatched file is a 404, never a silent success"
  );
  assert.match(web, /removeMdfUploadedFile/, "the console has a remove action");
  assert.match(web, /window\.confirm\(`Remove "\$\{file\.name\}"/, "and it confirms before removing");
  // The console must send the SAME three fields the key is built from, or the button and the reducer
  // would disagree about which document was clicked.
  assert.match(
    web,
    /JSON\.stringify\(\{ name: file\.name, size: file\.size, url: file\.url \?\? "" \}\)/,
    "the console identifies the file by name+size+url, exactly as uploadedFileKey does"
  );
  assert.match(web, /invoice row\(s\) now have no file attached/, "and it surfaces the orphan warning");
}

console.log(
  "PASS mdf claim file removal — one document detaches, invoice rows stop referencing it, typed detail survives, unevidenced rows are reported, and a miss is a 404."
);
