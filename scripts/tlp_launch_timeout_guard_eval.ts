/**
 * TLP browser-launch timeout guard. Production TLP failures included
 * "browserType.launchPersistentContext: Timeout 180000ms exceeded" — the
 * Chromium launch had no explicit timeout, so a stuck launch hung on
 * Playwright's default before failing, blocking the TLP queue. Both launch
 * paths must now pass an explicit, env-tunable, bounded timeout so a bad launch
 * fails fast. (The dominant TLP failures are stale UI selectors, which need
 * live TLP-UI access to re-verify — out of scope for this static guard.)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(
  path.resolve("services/api/src/connectors/crm/tlpPlaywright.ts"),
  "utf8"
);

assert.match(
  src,
  /const LAUNCH_TIMEOUT_MS = Number\(process\.env\.TLP_LAUNCH_TIMEOUT_MS \?\? \d[\d_]*\)/,
  "LAUNCH_TIMEOUT_MS must be defined and env-tunable via TLP_LAUNCH_TIMEOUT_MS"
);
// The default must be bounded (fail fast, not hang for minutes).
const m = src.match(/TLP_LAUNCH_TIMEOUT_MS \?\? (\d[\d_]*)\)/);
assert.ok(m, "launch timeout default must be a literal");
assert.ok(Number(m![1].replace(/_/g, "")) <= 120_000, "launch timeout default must be <= 120s");

assert.match(
  src,
  /launchPersistentContext\([^)]*\{[\s\S]*?timeout:\s*LAUNCH_TIMEOUT_MS/,
  "launchPersistentContext must pass timeout: LAUNCH_TIMEOUT_MS"
);
assert.match(
  src,
  /chromium\.launch\(\{[^}]*timeout:\s*LAUNCH_TIMEOUT_MS/,
  "chromium.launch must pass timeout: LAUNCH_TIMEOUT_MS"
);

console.log("PASS tlp launch timeout guard eval");
