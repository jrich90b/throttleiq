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

  // 7) Unknown binary (e.g. .xlsx) -> supporting-context placeholder, not text.
  const bin = await extractBriefExcerpt(Buffer.from([0x50, 0x4b, 0x03, 0x04]), ".xlsx");
  assert.equal(bin.type, "binary", "unknown binary stays type binary");

  // 8) Empty file -> missing.
  const empty = await extractBriefExcerpt(Buffer.alloc(0), ".pdf");
  assert.equal(empty.type, "missing", "empty file is missing");

  // 9) Word .docx with real body text -> extracted text reaches the prompt.
  //    Built with the same jszip the extractor uses so it exercises the real docx path.
  const JsZip = (await import("jszip")).default;
  const zip = new JsZip();
  const docXml =
    '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
    "<w:p><w:r><w:t>Fall Service Special: $89.95 oil change</w:t></w:r></w:p>" +
    "<w:p><w:r><w:t>Book by October 31 &amp; save.</w:t></w:r></w:p>" +
    "</w:body></w:document>";
  zip.file("word/document.xml", docXml);
  const docxBuf = await zip.generateAsync({ type: "nodebuffer" });
  const docx = await extractBriefExcerpt(docxBuf, ".docx");
  assert.equal(docx.type, "text", "valid .docx should extract as text");
  assert.ok(docx.excerpt.includes("Fall Service Special"), "docx excerpt carries body text");
  assert.ok(docx.excerpt.includes("$89.95"), "docx excerpt carries promo specifics");
  assert.ok(docx.excerpt.includes("October 31 & save"), "docx entities decoded (&amp; -> &)");

  // 10) Corrupt .docx (zip magic but not a real docx) -> binary placeholder, no crash.
  const badDocx = await extractBriefExcerpt(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]), ".docx");
  assert.equal(badDocx.type, "binary", "corrupt .docx falls back to binary");

  // 11) Injected docx parser: text -> type text; throw -> binary.
  const injText = await extractBriefExcerpt(Buffer.from("x"), ".docx", {
    parseDocx: async () => "Spring Open House Saturday 9-3, free swag"
  });
  assert.equal(injText.type, "text", "docx with extractable text is type text");
  assert.ok(injText.excerpt.includes("Spring Open House"), "docx injected text reaches prompt");
  const injThrow = await extractBriefExcerpt(Buffer.from("x"), ".docx", {
    parseDocx: async () => {
      throw new Error("bad docx");
    }
  });
  assert.equal(injThrow.type, "binary", "docx parser throw falls back to binary");

  console.log("campaign_brief_extraction_eval: OK (11 checks)");
}

main().catch(err => {
  console.error("campaign_brief_extraction_eval FAILED:", err?.message ?? err);
  process.exit(1);
});
