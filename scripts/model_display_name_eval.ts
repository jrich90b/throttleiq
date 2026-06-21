import { strict as assert } from "node:assert";
import os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";

/**
 * Model display-name eval — feed/ADF models arrive with a verbose inventory tail
 * ("CVO Road Glide ST 2026 FLTRXSTSE C6-26 Citrus Heat Re-Entry"); the card/label
 * should show just "CVO Road Glide ST". cleanModelDisplayName cuts at the model-year
 * token, while real numeric model suffixes (Iron 883, Road Glide 3, …) survive.
 * Deterministic; no LLM. Display-only — never used for matching/watch keys.
 */

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "model-display-eval-"));
process.env.CONVERSATIONS_DB_PATH = path.join(tmpDir, "conversations.json");

const { cleanModelDisplayName } = await import("../services/api/src/domain/conversationStore.ts");

const cases: Array<[string, string]> = [
  // verbose feed strings -> base model name (cut at the year)
  ["CVO Road Glide ST 2026 FLTRXSTSE C6-26 Citrus Heat Re-Entry", "CVO Road Glide ST"],
  ["Street Bob 2026 FXBB S4-26 Dark Billiard Gray Chrome Cast Wheels", "Street Bob"],
  ["Road Glide 2026 FLTRX T26-26 Teal Thunder Vivid Black Chrome Trim", "Road Glide"],
  ["Street Glide 2026 FLHX T12-26 Olive Steel Metallic Vivid Black Chrome Trim", "Street Glide"],
  ["Freewheeler 2025 FLRT T10-25 Billiard Gray", "Freewheeler"],
  // real numeric model suffixes must NOT be stripped (not 19xx/20xx)
  ["Iron 883", "Iron 883"],
  ["Street 750", "Street 750"],
  ["Sportster 1200 Custom", "Sportster 1200 Custom"],
  ["Road Glide 3", "Road Glide 3"],
  ["Pan America 1250 ST", "Pan America 1250 ST"],
  ["Fat Bob 114", "Fat Bob 114"],
  ["Breakout 117", "Breakout 117"],
  ["Softail Deluxe 103", "Softail Deluxe 103"],
  // already-clean names pass through; whitespace normalized
  ["Street Glide", "Street Glide"],
  ["  Low Rider   ST  ", "Low Rider ST"],
  ["", ""],
  // year-first (no model name before it) -> leave as-is rather than empty
  ["2026 Street Glide", "2026 Street Glide"]
];

for (const [input, expected] of cases) {
  const got = cleanModelDisplayName(input);
  assert.equal(got, expected, `cleanModelDisplayName("${input}") => "${got}", expected "${expected}"`);
}

// Source guards: both display surfaces run the cleaner.
const store = await fs.readFile("services/api/src/domain/conversationStore.ts", "utf8");
assert.ok(
  /cleanModelDisplayName\(leadModel\)/.test(store) && /cleanModelDisplayName\(model\)/.test(store),
  "latestModelInterestLabel must clean the model for the vehicle line"
);
const idx = await fs.readFile("services/api/src/index.ts", "utf8");
assert.ok(
  /normalizeDisplayCase\(cleanModelDisplayName\(model\)\)/.test(idx),
  "normalizeDisplayModelForYear (follow-up label) must clean the model"
);

await fs.rm(tmpDir, { recursive: true, force: true });
console.log("model_display_name:eval ok");
