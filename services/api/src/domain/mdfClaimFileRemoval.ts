// Take a file back off an MDF claim (Joe, 2026-08-10: "there is nowhere to delete an invoice if you
// already uploaded it... let's say you uploaded an invoice on accident").
//
// A claim holds the same document in TWO places, and removing it from only one is worse than not
// removing it at all:
//   - `packet.uploadedFiles` — the documents the runner attaches to the Ansira claim;
//   - `packet.invoices[].fileNames` — the invoice ROWS (vendor / date / number / amount) the runner
//     types into the form, each naming the file that evidences it.
//
// Drop only the file and the row survives, so the runner types a claim line into Ansira with no
// document behind it — a claim that looks complete and cannot be substantiated. Drop the row too and
// a mis-upload silently destroys numbers a human typed.
//
// So this does neither: it removes the FILE, strips that filename from every invoice row, and
// REPORTS any row left with no evidence. The caller shows that as a warning. Nothing typed is ever
// discarded, and nothing unsupported goes out unnoticed — the human decides which way to fix it.
//
// The stored file itself is left alone. This detaches a document from a claim; it is not a delete of
// the underlying upload, which may be referenced elsewhere and is not ours to destroy.
//
// Pure + eval-pinned (mdf_claim_file_removal:eval).

export type RemovableUploadedFile = {
  name?: string | null;
  type?: string | null;
  size?: number | null;
  url?: string | null;
  inferredRole?: string | null;
};

export type RemovableInvoiceRow = {
  vendorName?: string | null;
  invoiceDate?: string | null;
  invoiceNumber?: string | null;
  amount?: string | null;
  fileNames?: string[] | null;
  description?: string | null;
};

export type RemovableClaimPacket = {
  uploadedFiles?: RemovableUploadedFile[] | null;
  invoices?: RemovableInvoiceRow[] | null;
  [key: string]: unknown;
};

/** What the caller must name to identify ONE file. Mirrors the console's own list key. */
export type UploadedFileSelector = {
  name?: string | null;
  size?: number | null;
  url?: string | null;
};

/**
 * Identity of an uploaded file: name + size + url. The console already keys its "Saved files" list
 * on exactly this triple, so the button the user clicks and the row this removes cannot disagree.
 * Two genuinely identical uploads (same name, same size, same url) are the same document.
 */
export function uploadedFileKey(file: UploadedFileSelector | RemovableUploadedFile): string {
  const name = String(file?.name ?? "").trim().toLowerCase();
  const size = Number(file?.size ?? 0) || 0;
  const url = String(file?.url ?? "").trim().toLowerCase();
  return `${name}|${size}|${url}`;
}

function sameFileName(a: unknown, b: unknown): boolean {
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

/** An invoice row is "empty" when a human typed nothing into it — no numbers are lost by dropping it. */
function invoiceRowIsBlank(row: RemovableInvoiceRow): boolean {
  return (
    !String(row?.vendorName ?? "").trim() &&
    !String(row?.invoiceDate ?? "").trim() &&
    !String(row?.invoiceNumber ?? "").trim() &&
    !String(row?.amount ?? "").trim() &&
    !String(row?.description ?? "").trim()
  );
}

export type RemoveUploadedFileResult = {
  /** False when nothing matched — the caller should 404 rather than silently report success. */
  removed: boolean;
  packet: RemovableClaimPacket;
  /** The file that came off, for the confirmation message. */
  removedFile: RemovableUploadedFile | null;
  /**
   * Invoice rows that still carry typed detail but no longer have ANY file behind them. The console
   * warns on these; the runner would otherwise type an unevidenced line into Ansira.
   */
  orphanedInvoices: RemovableInvoiceRow[];
};

/**
 * PURE. Returns a NEW packet with the named file detached.
 *
 * Fail direction: it can only ever remove one named document and report what that left behind. It
 * never edits an amount, never drops a row a human typed into, and never touches stored bytes.
 */
export function removeUploadedFileFromPacket(
  packet: RemovableClaimPacket,
  selector: UploadedFileSelector
): RemoveUploadedFileResult {
  const files = Array.isArray(packet?.uploadedFiles) ? packet.uploadedFiles : [];
  const target = uploadedFileKey(selector);
  const match = files.find(file => uploadedFileKey(file) === target) ?? null;
  if (!match) {
    return { removed: false, packet, removedFile: null, orphanedInvoices: [] };
  }

  const remainingFiles = files.filter(file => uploadedFileKey(file) !== target);
  // A name can legitimately still be present on ANOTHER surviving upload (same filename, different
  // size/url). Only stop referencing the name when no remaining file carries it.
  const nameStillPresent = remainingFiles.some(file => sameFileName(file?.name, match?.name));

  const invoices = Array.isArray(packet?.invoices) ? packet.invoices : [];
  const nextInvoices: RemovableInvoiceRow[] = [];
  const orphanedInvoices: RemovableInvoiceRow[] = [];
  for (const row of invoices) {
    const fileNames = Array.isArray(row?.fileNames) ? row.fileNames : [];
    const nextFileNames = nameStillPresent
      ? [...fileNames]
      : fileNames.filter(name => !sameFileName(name, match?.name));
    const nextRow: RemovableInvoiceRow = { ...row, fileNames: nextFileNames };
    // A row that referenced ONLY this file and holds nothing typed is pure residue — drop it.
    if (!nextFileNames.length && fileNames.length && invoiceRowIsBlank(nextRow)) continue;
    if (!nextFileNames.length && fileNames.length) orphanedInvoices.push(nextRow);
    nextInvoices.push(nextRow);
  }

  return {
    removed: true,
    removedFile: match,
    orphanedInvoices,
    packet: { ...packet, uploadedFiles: remainingFiles, invoices: nextInvoices }
  };
}
