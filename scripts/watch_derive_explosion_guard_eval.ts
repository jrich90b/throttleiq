/**
 * watch_derive_explosion_guard:eval — pins the fix for the +19292685345 (Shawon) watch explosion:
 * a family word on a voice call ("compare Sportster vs Fat Boy") resolved against the VIN-decoded
 * model catalog and minted 22 junk watches ("Xl1200cx 1lm3 1200 Roadster", "Rh1250s 1zc4 Sportster
 * S"). deriveContextNoteWatches now (1) DROPS any VIN-code-shaped model label and (2) CAPS the
 * derived model watches at WATCH_DERIVE_MAX (default 3) — over the cap = a family/catalog explosion,
 * mint NONE. Fail direction: fewer / no watches, never a spray of wrong-model alerts.
 *
 * Layer 1 — behavior of the VIN-shape detector (modelLabelHasVinCode).
 * Layer 2 — source guard that deriveContextNoteWatches applies both guards.
 *
 * Run: npx tsx scripts/watch_derive_explosion_guard_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { modelLabelHasVinCode } from "../services/api/src/domain/watchModelVinCodes.ts";

// --- VIN-shape detector: the exact garbage from the explosion, and the clean names that must survive ---
for (const junk of [
  "Xl1200cx 1lm3 1200 Roadster",
  "Rh1250s 1zc4 Sportster S",
  "Xl1200x 1lc3 Forty-Eight",
  "Xr1200x 1ld6 Xr1200x",
  "Flhtcutg 1mad Tri Glide Ultra",
  "Fxst Bhlf Softail Standard"
]) {
  assert.equal(modelLabelHasVinCode(junk), true, `VIN-decoded label must be flagged: ${junk}`);
}
for (const clean of [
  "Nightster",
  "Fat Boy",
  "Street Glide Special",
  "Low Rider S",
  "Road Glide",
  "Tri Glide",
  "Sportster S",
  "Forty-Eight",
  ""
]) {
  assert.equal(modelLabelHasVinCode(clean), false, `a friendly model name must NOT be flagged: "${clean}"`);
}

// --- Source guard: deriveContextNoteWatches drops VIN labels + caps the derived model watches ---
const idx = fs.readFileSync(path.join(process.cwd(), "services/api/src/index.ts"), "utf8");
const fnStart = idx.indexOf("async function deriveContextNoteWatches");
assert.ok(fnStart > 0, "deriveContextNoteWatches must exist");
const fnBody = idx.slice(fnStart, fnStart + 12000);
assert.match(
  fnBody,
  /const nonVinWatches = watches\.filter\(w => !modelLabelHasVinCode\(String\(w\.model \?\? ""\)\)\)/,
  "must drop VIN-code-shaped model labels from the derived watches"
);
assert.match(
  fnBody,
  /Number\(process\.env\.WATCH_DERIVE_MAX \?\? 3\)/,
  "must cap the derived model watches at a configurable max (default 3)"
);
assert.match(
  fnBody,
  /nonVinWatches\.length > watchDeriveMax \? \[\] : nonVinWatches/,
  "over the cap = family/catalog explosion → mint NONE"
);
assert.match(
  fnBody,
  /watch_derive_explosion_suppressed/,
  "a suppressed explosion records a route outcome so it stays observable"
);

console.log(
  "PASS watch_derive_explosion_guard eval — VIN-decoded labels dropped, derived model watches capped at WATCH_DERIVE_MAX (mint none over the cap); clean names survive."
);
