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
  if (typeof document === "undefined") return file;
  if (!file.type.startsWith("image/")) return file; // PDFs / spreadsheets pass through unchanged
  // Decode with createImageBitmap when available, but FALL BACK to an <img> decode. On iOS Safari
  // createImageBitmap throws on large phone photos — the old code then returned the FULL-SIZE original,
  // so a multi-MB image was uploaded unscaled and the cross-origin POST died on mobile ("Load failed").
  // The <img>+canvas path is more memory-tolerant (we only ever draw into a small downscaled canvas).
  const decoded = await decodeImageForResize(file);
  if (!decoded) return file; // truly undecodable (e.g. HEIC on an old browser) -> upload original
  try {
    const plan = computeResizeTarget(decoded.width, decoded.height, file.size, maxEdge);
    if (!plan.resize) return file;
    const canvas = document.createElement("canvas");
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    decoded.draw(ctx, plan.width, plan.height);
    // PNG keeps its mime (toBlob ignores quality for png); everything else encodes as JPEG for size.
    const outType = file.type === "image/png" ? "image/png" : "image/jpeg";
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, outType, quality));
    if (!blob || blob.size >= file.size) return file; // no real gain -> keep the original
    return blob;
  } catch {
    return file;
  } finally {
    decoded.close?.();
  }
}

type DecodedImage = {
  width: number;
  height: number;
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  close?: () => void;
};

// Prefer createImageBitmap (fast); fall back to HTMLImageElement (tolerant of large iOS photos that
// createImageBitmap rejects). Returns null only when the image is genuinely undecodable.
async function decodeImageForResize(file: File): Promise<DecodedImage | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file);
      return { width: bmp.width, height: bmp.height, draw: (ctx, w, h) => ctx.drawImage(bmp, 0, 0, w, h), close: () => bmp.close?.() };
    } catch {
      /* fall through to the <img> decode */
    }
  }
  if (typeof Image === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("image decode failed"));
      el.src = url;
    });
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) return null;
    return { width, height, draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h) };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Map a raw upload error into a clear, actionable dealer-facing message. WebKit/iOS Safari surfaces a
// failed fetch() as "Load failed" (Chrome: "Failed to fetch") — which is what showed in the MDF
// Assistant when a mobile upload dropped. Turn that (and the too-large/413 case) into plain guidance.
export function humanizeUploadError(err: unknown, fallback = "Upload could not be completed."): string {
  const raw = (err instanceof Error ? err.message : String(err ?? "")).trim();
  if (/load failed|failed to fetch|networkerror|network error|network connection was lost|timed out|aborted/i.test(raw)) {
    return "Upload didn’t go through — large photos can be slow on mobile data. Check your connection and tap “Add files to packet” again.";
  }
  if (/FUNCTION_PAYLOAD_TOO_LARGE|Request Entity Too Large|payload too large|\b413\b|too large/i.test(raw)) {
    return "That file is too large to upload. Try a smaller photo, or crop/compress it first.";
  }
  return raw || fallback;
}
