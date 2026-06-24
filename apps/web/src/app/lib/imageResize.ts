// Client-side image downscale for MDF uploads. Phone photos of invoices are often 3–12 MB, which makes
// uploads slow (and base64 adds ~33%). We downscale large images in the browser before upload — keeping
// invoice text legible (balanced ~2000px long edge) — so uploads are fast and the vision model still
// reads them. PDFs / CSV / XLSX are never touched. The size/dimension DECISION is pure + unit-tested
// (computeResizeTarget); the canvas encode is a thin browser wrapper around it.

export type ResizePlan = { resize: boolean; width: number; height: number };

// Decide whether to re-encode an image and at what dimensions. "Balanced": cap the long edge at maxEdge
// (keeping aspect ratio) when it's larger; if it's already within maxEdge but the file is heavy, re-encode
// at the same dimensions (JPEG quality shrinks it); otherwise leave it alone. Pure.
export function computeResizeTarget(
  width: number,
  height: number,
  bytes: number,
  maxEdge = 2000,
  sizeFloorBytes = 1_500_000
): ResizePlan {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const longEdge = Math.max(w, h);
  if (longEdge > maxEdge) {
    const scale = maxEdge / longEdge;
    return { resize: true, width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
  }
  if (bytes > sizeFloorBytes) return { resize: true, width: w, height: h };
  return { resize: false, width: w, height: h };
}

// Downscale/recompress an image File for upload, or return the original untouched (non-image, decode
// failure, no DOM, or no size gain). Never throws — a failure just uploads the original.
export async function resizeImageForUpload(file: File, maxEdge = 2000, quality = 0.82): Promise<Blob> {
  if (typeof document === "undefined" || typeof createImageBitmap === "undefined") return file;
  if (!file.type.startsWith("image/")) return file; // PDFs / spreadsheets pass through unchanged
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file; // undecodable (e.g. HEIC on some browsers) -> upload original
  }
  try {
    const plan = computeResizeTarget(bitmap.width, bitmap.height, file.size, maxEdge);
    if (!plan.resize) return file;
    const canvas = document.createElement("canvas");
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, plan.width, plan.height);
    // PNG keeps its mime (toBlob ignores quality for png); everything else encodes as JPEG for size.
    const outType = file.type === "image/png" ? "image/png" : "image/jpeg";
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, outType, quality));
    if (!blob || blob.size >= file.size) return file; // no real gain -> keep the original
    return blob;
  } catch {
    return file;
  } finally {
    bitmap.close?.();
  }
}
