import { strict as assert } from "node:assert";
import os from "node:os";
import * as path from "node:path";
import { promises as fs, rmSync } from "node:fs";

/**
 * Placeholder-model display eval — ADF forms often attach a non-bike "model"
 * (Full Line, Other, Harley-Davidson Other on Meta promo / prequal leads). The lead
 * stays active, but its model of interest must read "N/A", never the junk placeholder
 * — and follow-up labels say "the bike", never "the Other" / "Full Line"
 * (Joe, 2026-06-21).
 *
 * Pins the shared predicate isGenericModelInterest plus source guards that the two
 * surfaces consume it (latestModelInterestLabel -> "N/A", formatModelLabelForFollowUp
 * -> "the bike"). Deterministic; no LLM.
 */

// Isolate store hydration on a throwaway file (import side-effect).
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "placeholder-model-eval-"));
process.env.CONVERSATIONS_DB_PATH = path.join(tmpDir, "conversations.json");

const { isGenericModelInterest } = await import("../services/api/src/domain/conversationStore.ts");

// Placeholder / non-bike values -> generic (must not render as a model)
for (const generic of [
  "",
  "   ",
  "Other",
  "OTHER",
  "Harley-Davidson Other",
  "harley davidson other",
  "Full Line",
  "Harley-Davidson Full Line",
  "Harley Davidson",
  "Unknown",
  "N/A",
  "na",
  "2026",
  "new",
  "used"
]) {
  assert.equal(isGenericModelInterest(generic), true, `should be generic/placeholder: "${generic}"`);
}

// Real bikes -> NOT generic (must still show)
for (const real of [
  "Street Glide",
  "Breakout",
  "Road Glide Limited",
  "Low Rider ST",
  "Iron 883",
  "Heritage Classic",
  "CVO Road Glide ST"
]) {
  assert.equal(isGenericModelInterest(real), false, `real model must render: "${real}"`);
}

// --- Source guards: the two display surfaces consume the predicate / placeholder rule ---
const store = await fs.readFile("services/api/src/domain/conversationStore.ts", "utf8");
assert.ok(
  /if \(leadDescription \|\| leadModel\) return "N\/A";/.test(store),
  "latestModelInterestLabel must show a present-but-placeholder vehicle as N/A (lead stays active)"
);

const idx = await fs.readFile("services/api/src/index.ts", "utf8");
assert.ok(
  /\/\\b\(full line\|other\)\\b\/i\.test\(model\)/.test(idx),
  "formatModelLabelForFollowUp must treat full line AND other as 'the bike'"
);

// --- "None Recorded" is a placeholder, not a bike (+17167279369, 2026-08-02) -----------------
// A customer received "thanks again for coming in for the test ride on the None Recorded." — the
// Dealer Lead App's empty-field literal rode the intro template as a model name. The shared
// authority now recognizes the CRM nothing-recorded family, and the outcome-label choke point
// returns blank for it so every caller's own "bike" fallback engages.
{
  const { isPlaceholderModel, isSpecificModel } = await import(
    "../services/api/src/domain/modelDeflection.ts"
  );
  for (const junk of ["None Recorded", "none recorded", "NONE", "Not Recorded", "not applicable", "no", "N/A"]) {
    assert.equal(isPlaceholderModel(junk), true, `CRM placeholder recognized: ${junk}`);
  }
  // ...and real models are untouched — "no"-adjacent names must not be swallowed.
  for (const real of ["Nightster", "Road Glide", "Notable Custom", "Norton Commando"]) {
    assert.equal(isSpecificModel(real), true, `real model survives: ${real}`);
  }

  const idx = await fs.readFile("services/api/src/index.ts", "utf8");
  // The outcome-label normalizer blanks placeholders (so its callers' "bike" fallback engages)...
  assert.match(
    idx,
    /normalizeOutcomeCustomerModelLabel\(raw: string\): string \{[\s\S]{0,400}isPlaceholderModel\(source\)\) return "";/,
    "normalizeOutcomeCustomerModelLabel must blank a CRM placeholder before it can render"
  );
  // ...and the Dealer Lead App intro's label build consults the shared authority too.
  assert.match(
    idx,
    /isSpecificModel\(leadModelRaw\)[\s\S]{0,200}\|\| "bike";/,
    "the test-ride intro label must degrade to 'bike' on a placeholder model"
  );
}

// rmSync (not async fs.rm): a synchronous remove can't yield the event loop
// mid-delete, so the conversation store's pending async flush can't re-write
// conversations.json between the unlink and rmdir and race us to ENOTEMPTY.
rmSync(tmpDir, { recursive: true, force: true });
console.log("placeholder_model_display:eval ok");
