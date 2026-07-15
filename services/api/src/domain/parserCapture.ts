// Parser capture log — the distillation data flywheel (Joe, 2026-07-15).
//
// Every typed-parser call is a ready-made teacher example: the exact prompt the
// frontier model saw and the structured answer it gave. Today that pair is used
// once for routing and thrown away; this module durably appends it as JSONL so
// the future "student model" training set accumulates as free exhaust.
//
// Fail-direction: pure logging. append* swallows every error — a capture bug
// can never touch the live customer path. Worst case: a day of training data
// is missing. NEVER add behavior here that the reply path depends on.
//
// Storage: daily files under PARSER_CAPTURE_DIR (or REPORT_ROOT/parser_capture),
// ~2-6KB/record. Kill switch: PARSER_CAPTURE_DISABLED=1.

import fs from "node:fs";

// A single record must stay a sane size even if a caller ships a pathological
// prompt (giant ADF blob, base64 junk). Truncation is recorded so a training
// pipeline can drop clipped rows instead of learning from half a prompt.
export const PARSER_CAPTURE_PROMPT_CAP = 32_000;
export const PARSER_CAPTURE_OUTPUT_CAP = 16_000;

export type ParserCaptureRecord = {
  at: string;
  schemaName: string;
  model: string;
  source: "structured" | "fallback";
  elapsedMs: number;
  prompt: string;
  promptTruncated: boolean;
  output: string; // JSON-stringified parser output
  outputTruncated: boolean;
};

export function buildParserCaptureRecord(args: {
  at: string;
  schemaName: string;
  model: string;
  source: "structured" | "fallback";
  elapsedMs: number;
  prompt: unknown;
  output: unknown;
}): ParserCaptureRecord {
  const promptRaw = String(args.prompt ?? "");
  let outputRaw = "";
  try {
    outputRaw = JSON.stringify(args.output) ?? "";
  } catch {
    outputRaw = ""; // circular/unserializable — record the call, not the payload
  }
  const promptTruncated = promptRaw.length > PARSER_CAPTURE_PROMPT_CAP;
  const outputTruncated = outputRaw.length > PARSER_CAPTURE_OUTPUT_CAP;
  return {
    at: String(args.at ?? ""),
    schemaName: String(args.schemaName ?? "").trim() || "unknown",
    model: String(args.model ?? "").trim() || "unknown",
    source: args.source === "fallback" ? "fallback" : "structured",
    elapsedMs: Number.isFinite(args.elapsedMs) ? Math.max(0, Math.round(args.elapsedMs)) : 0,
    prompt: promptTruncated ? promptRaw.slice(0, PARSER_CAPTURE_PROMPT_CAP) : promptRaw,
    promptTruncated,
    output: outputTruncated ? outputRaw.slice(0, PARSER_CAPTURE_OUTPUT_CAP) : outputRaw,
    outputTruncated
  };
}

/**
 * Where capture records go, or null when capture is off. Pure on its env input
 * so the eval can pin: kill switch wins; explicit dir wins over REPORT_ROOT;
 * no configured root → off (dev machines stay clean).
 */
export function resolveParserCaptureDir(env: {
  PARSER_CAPTURE_DISABLED?: string;
  PARSER_CAPTURE_DIR?: string;
  REPORT_ROOT?: string;
}): string | null {
  if (String(env.PARSER_CAPTURE_DISABLED ?? "") === "1") return null;
  const explicit = String(env.PARSER_CAPTURE_DIR ?? "").trim();
  if (explicit) return explicit;
  const root = String(env.REPORT_ROOT ?? "").trim();
  if (root) return `${root}/parser_capture`;
  return null;
}

export function appendParserCaptureRecord(record: ParserCaptureRecord): void {
  try {
    const dir = resolveParserCaptureDir(process.env as any);
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    const day = record.at.slice(0, 10).replace(/-/g, "") || "unknown";
    fs.appendFileSync(`${dir}/parser_capture_${day}.jsonl`, `${JSON.stringify(record)}\n`);
  } catch {
    // best-effort by design — capture must never disturb the live path
  }
}
