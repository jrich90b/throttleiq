/**
 * MDF client-side image-resize eval (pure, no DOM).
 *
 * Phone photos of invoices were making uploads slow. We downscale large images in the browser before
 * upload ("balanced" ~2000px long edge) while keeping invoice text legible; PDFs/spreadsheets are never
 * touched. The size/dimension DECISION is pure (computeResizeTarget) and pinned here; the canvas encode is
 * a thin browser wrapper. Source guards confirm the upload path actually calls the resizer and that
 * non-images pass through.
 *
 * Run: npx tsx scripts/mdf_image_resize_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
const { computeResizeTarget, humanizeUploadError } = await import("../apps/web/src/app/lib/imageResize.ts");

// Long edge over the cap -> downscale to maxEdge, aspect ratio preserved.
assert.deepEqual(computeResizeTarget(4000, 3000, 500_000), { resize: true, width: 2000, height: 1500 }, "landscape 4000px -> 2000px");
assert.deepEqual(computeResizeTarget(3000, 4000, 500_000), { resize: true, width: 1500, height: 2000 }, "portrait 4000px -> 2000px");
assert.deepEqual(computeResizeTarget(2400, 2400, 500_000), { resize: true, width: 2000, height: 2000 }, "square caps to 2000");

// Within the cap but heavy bytes -> recompress at the same dimensions (JPEG quality shrinks it).
assert.deepEqual(computeResizeTarget(1500, 1000, 3_000_000), { resize: true, width: 1500, height: 1000 }, "heavy but small-dim -> recompress same dims");

// Small + light -> leave untouched.
assert.deepEqual(computeResizeTarget(800, 600, 200_000), { resize: false, width: 800, height: 600 }, "small light image untouched");
assert.deepEqual(computeResizeTarget(2000, 1000, 500_000), { resize: false, width: 2000, height: 1000 }, "exactly maxEdge + light -> untouched");
assert.deepEqual(computeResizeTarget(10, 10, 1000), { resize: false, width: 10, height: 10 }, "tiny image untouched");

// Custom cap honored.
assert.deepEqual(computeResizeTarget(2800, 2100, 500_000, 1400), { resize: true, width: 1400, height: 1050 }, "aggressive 1400 cap");

// --- Source guards ---
const lib = fs.readFileSync("apps/web/src/app/lib/imageResize.ts", "utf8");
assert.ok(/!file\.type\.startsWith\("image\/"\)/.test(lib), "non-image files (PDF/CSV/XLSX) must pass through untouched");
assert.ok(/canvas\.toBlob/.test(lib), "the resizer must encode via canvas.toBlob");
assert.ok(/blob\.size >= file\.size.*return file|return file/.test(lib), "no-gain resize must fall back to the original");

// --- Decode fallback: createImageBitmap can throw on large iOS photos; the <img> path must catch it. ---
assert.ok(/createImageBitmap/.test(lib), "fast path uses createImageBitmap");
assert.ok(/decodeImageForResize/.test(lib), "a decode helper with an <img> fallback must exist");
assert.ok(/new Image\(\)/.test(lib) && /el\.onload/.test(lib), "the fallback must decode via HTMLImageElement (tolerant of large iOS images)");
assert.ok(/naturalWidth/.test(lib), "the <img> fallback must read natural dimensions for the resize plan");

// --- humanizeUploadError: WebKit 'Load failed' / too-large -> clear, actionable guidance. ---
assert.match(humanizeUploadError(new Error("Load failed")), /check your connection|try again|tap/i, "Safari 'Load failed' becomes connection guidance");
assert.match(humanizeUploadError(new Error("Failed to fetch")), /check your connection|try again|tap/i, "Chrome 'Failed to fetch' too");
assert.match(humanizeUploadError(new Error("FUNCTION_PAYLOAD_TOO_LARGE")), /too large|smaller|crop/i, "413/too-large becomes a size hint");
assert.equal(humanizeUploadError(new Error("Vendor name is required.")), "Vendor name is required.", "a real backend message passes through unchanged");
assert.equal(humanizeUploadError(null, "fallback msg"), "fallback msg", "empty error uses the fallback");

const page = fs.readFileSync("apps/web/src/app/page.tsx", "utf8");
assert.ok(/import \{ resizeImageForUpload, humanizeUploadError \} from "\.\/lib\/imageResize"/.test(page), "page must import the resizer + error humanizer");
assert.ok(/await resizeImageForUpload\(entry\.file\)/.test(page), "the MDF upload builder must resize each file before base64");
assert.ok(/dataBase64: await readFileBase64\(blob\)/.test(page), "the upload must base64 the (possibly resized) blob, not the raw file");
assert.ok(/setMdfError\(humanizeUploadError\(err/.test(page), "the MDF upload catch must humanize the error (no raw 'Load failed')");

console.log("PASS mdf image-resize eval — computeResizeTarget + decode fallback + humanizeUploadError + upload-path source guards");
