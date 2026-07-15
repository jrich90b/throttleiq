import { strict as assert } from "node:assert";

/**
 * parser_capture:eval — pins the distillation data flywheel's pure rules
 * (services/api/src/domain/parserCapture.ts). Deterministic; no LLM.
 *
 * The capture log is training data for a future distilled parser model. Its
 * fail-direction is logging-only, but two contracts matter enough to pin:
 *  1. buildParserCaptureRecord never throws and caps pathological payloads
 *     (a giant ADF/base64 blob must not balloon the log or crash the wrapper).
 *  2. resolveParserCaptureDir — the kill switch always wins; explicit dir wins
 *     over REPORT_ROOT; nothing configured = capture off (dev machines clean).
 */

const {
  buildParserCaptureRecord,
  resolveParserCaptureDir,
  PARSER_CAPTURE_PROMPT_CAP,
  PARSER_CAPTURE_OUTPUT_CAP
} = await import("../services/api/src/domain/parserCapture.ts");

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`FAIL ${name}: ${err?.message ?? err}`);
  }
}

// ── 1. record builder ────────────────────────────────────────────────────────
check("normal record carries the full teacher example", () => {
  const rec = buildParserCaptureRecord({
    at: "2026-07-15T12:00:00.000Z",
    schemaName: "semantic_slot_parse",
    model: "gpt-5-mini",
    source: "structured",
    elapsedMs: 812,
    prompt: 'Customer: "lmk when you get a 23 lrs in black"',
    output: { watch_action: "set_watch", watch: { model: "Low Rider S", year: "2023", color: "black" } }
  });
  assert.equal(rec.schemaName, "semantic_slot_parse");
  assert.equal(rec.source, "structured");
  assert.equal(rec.elapsedMs, 812);
  assert.equal(rec.promptTruncated, false);
  assert.equal(rec.outputTruncated, false);
  assert.match(rec.prompt, /23 lrs in black/);
  assert.match(rec.output, /"Low Rider S"/);
});

check("giant prompt is capped and flagged, not crashed", () => {
  const rec = buildParserCaptureRecord({
    at: "2026-07-15T12:00:00.000Z",
    schemaName: "x",
    model: "gpt-5-mini",
    source: "structured",
    elapsedMs: 5,
    prompt: "A".repeat(PARSER_CAPTURE_PROMPT_CAP + 5000),
    output: { ok: true }
  });
  assert.equal(rec.prompt.length, PARSER_CAPTURE_PROMPT_CAP);
  assert.equal(rec.promptTruncated, true);
});

check("giant output is capped and flagged", () => {
  const rec = buildParserCaptureRecord({
    at: "2026-07-15T12:00:00.000Z",
    schemaName: "x",
    model: "gpt-5-mini",
    source: "fallback",
    elapsedMs: 5,
    prompt: "p",
    output: { blob: "B".repeat(PARSER_CAPTURE_OUTPUT_CAP + 5000) }
  });
  assert.equal(rec.output.length, PARSER_CAPTURE_OUTPUT_CAP);
  assert.equal(rec.outputTruncated, true);
  assert.equal(rec.source, "fallback");
});

check("weird inputs are safe: null prompt, circular output, bad elapsed", () => {
  const circular: any = {};
  circular.self = circular;
  const rec = buildParserCaptureRecord({
    at: "2026-07-15T12:00:00.000Z",
    schemaName: "",
    model: null as any,
    source: "structured",
    elapsedMs: Number.NaN,
    prompt: null,
    output: circular
  });
  assert.equal(rec.schemaName, "unknown");
  assert.equal(rec.model, "unknown");
  assert.equal(rec.elapsedMs, 0);
  assert.equal(rec.prompt, "");
  assert.equal(rec.output, ""); // circular JSON → recorded as empty, never thrown
});

// ── 2. dir resolution / kill switch ─────────────────────────────────────────
check("kill switch wins over everything", () => {
  assert.equal(
    resolveParserCaptureDir({
      PARSER_CAPTURE_DISABLED: "1",
      PARSER_CAPTURE_DIR: "/x",
      REPORT_ROOT: "/r"
    }),
    null
  );
});

check("explicit dir wins over REPORT_ROOT", () => {
  assert.equal(
    resolveParserCaptureDir({ PARSER_CAPTURE_DIR: "/data/capture", REPORT_ROOT: "/r" }),
    "/data/capture"
  );
});

check("REPORT_ROOT fallback lands in parser_capture/", () => {
  assert.equal(resolveParserCaptureDir({ REPORT_ROOT: "/r" }), "/r/parser_capture");
});

check("nothing configured = capture off", () => {
  assert.equal(resolveParserCaptureDir({}), null);
});

if (failures > 0) {
  console.error(`parser_capture:eval FAILED (${failures} case(s))`);
  process.exit(1);
}
console.log("parser_capture:eval OK");
