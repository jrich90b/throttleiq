/**
 * campaign_brief_extraction_eval
 *
 * Pins the contract of extractBriefExcerpt — the function that turns an attached SMS/email
 * campaign REFERENCE FILE into text the copy LLM can read. The bug this guards: a PDF (or
 * other reference file) was accepted by the picker but only a placeholder string ("PDF
 * uploaded...") reached the prompt, so the generated draft ignored everything in the file.
 *
 * The real pdf-parse dependency is injected here so the assertions are deterministic and
 * do not depend on a checked-in binary PDF fixture.
 */
import { strict as assert } from "node:assert";
import { extractBriefExcerpt } from "../services/api/src/domain/campaignBuilder.js";

const PLACEHOLDER_FRAGMENT = "PDF uploaded";

async function main() {
  // 1) PDF with selectable text -> the extracted text reaches the prompt as real content.
  const fakePdfText =
    "SPRING PARTS EVENT. 20% off all genuine Harley-Davidson parts and accessories, " +
    "May 1 through May 15. Free installation on orders over $500. Mention code SPRING20.";
  const pdf = await extractBriefExcerpt(Buffer.from("%PDF-1.4 fake bytes"), ".pdf", {
    parsePdf: async () => ({ text: fakePdfText })
  });
  assert.equal(pdf.type, "text", "PDF with text should be treated as extracted text");
  assert.ok(pdf.excerpt.includes("SPRING PARTS EVENT"), "PDF excerpt must carry the real file text");
  assert.ok(pdf.excerpt.includes("SPRING20"), "PDF excerpt must carry promo specifics");
  assert.ok(
    !pdf.excerpt.includes(PLACEHOLDER_FRAGMENT),
    "PDF with extractable text must NOT fall back to the placeholder"
  );

  // 2) PDF that yields no text (scanned/image-only) -> honest placeholder, type pdf.
  const scanned = await extractBriefExcerpt(Buffer.from("%PDF-1.4 image only"), ".pdf", {
    parsePdf: async () => ({ text: "   " })
  });
  assert.equal(scanned.type, "pdf", "image-only PDF stays type pdf");
  assert.ok(scanned.excerpt.length > 0, "image-only PDF still returns a placeholder excerpt");

  // 3) PDF parser throws -> graceful placeholder, never crashes generation.
  const broken = await extractBriefExcerpt(Buffer.from("%PDF-1.4 broken"), ".pdf", {
    parsePdf: async () => {
      throw new Error("corrupt pdf");
    }
  });
  assert.equal(broken.type, "pdf", "unreadable PDF falls back to type pdf");
  assert.ok(broken.excerpt.includes(PLACEHOLDER_FRAGMENT), "unreadable PDF uses the placeholder");

  // 4) PDF parser unavailable (dep missing) -> graceful placeholder.
  const noDep = await extractBriefExcerpt(Buffer.from("%PDF-1.4 nodep"), ".pdf", { parsePdf: null });
  assert.equal(noDep.type, "pdf", "missing pdf-parse falls back to type pdf");
  assert.ok(noDep.excerpt.includes(PLACEHOLDER_FRAGMENT), "missing pdf-parse uses the placeholder");

  // 5) Plain-text brief -> real content, unchanged behavior.
  const txtBody = "Memorial Day Blowout: demo rides all weekend, 0% APR for 36 months on select models.";
  const txt = await extractBriefExcerpt(Buffer.from(txtBody, "utf8"), ".txt");
  assert.equal(txt.type, "text", "txt brief is extracted text");
  assert.ok(txt.excerpt.includes("Memorial Day Blowout"), "txt excerpt carries the file text");

  // 6) Excerpt is capped (bounded prompt) but generous enough to carry a real brief.
  const longBody = "A".repeat(10_000);
  const capped = await extractBriefExcerpt(Buffer.from(longBody, "utf8"), ".md");
  assert.ok(capped.excerpt.length > 900, "excerpt cap must be larger than the old 900-char truncation");
  assert.ok(capped.excerpt.length <= 4000, "excerpt stays bounded for the prompt");

  // 7) Unknown binary (e.g. .docx today) -> supporting-context placeholder, not text.
  const bin = await extractBriefExcerpt(Buffer.from([0x50, 0x4b, 0x03, 0x04]), ".docx");
  assert.equal(bin.type, "binary", "unknown binary stays type binary");

  // 8) Empty file -> missing.
  const empty = await extractBriefExcerpt(Buffer.alloc(0), ".pdf");
  assert.equal(empty.type, "missing", "empty file is missing");

  console.log("campaign_brief_extraction_eval: OK (8 checks)");
}

main().catch(err => {
  console.error("campaign_brief_extraction_eval FAILED:", err?.message ?? err);
  process.exit(1);
});
