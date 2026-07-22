/**
 * One-off data repair: retarget Peter Arnoldo's (+17166887637) inventory watch from the
 * discontinued "Super Glide" to "Street Glide".
 *
 * WHY: the Traffic Log Pro lead's structured Vehicle field is "Harley-Davidson Street Glide", and
 * the rep's typed note ("Wants to see new Super Glide ... the next one we have coming in ... projected
 * ship date is 7/29") describes a specific NEW incoming unit. Harley no longer makes a Super Glide and
 * there are zero in the 60-unit inventory, so the "Super Glide" watch can never fire — it's a rep typo
 * for Street Glide (7 new 2026 Street Glides are in stock). The code guard (decideWatchConditionPin)
 * stops NEW such mis-created watches; this repairs the one already on the store.
 *
 * WHAT: on the ONE conversation whose id is +17166887637, if its active watch model is "Super Glide",
 * rewrite the model to "Street Glide" in BOTH storage locations (`conv.inventoryWatch` and the
 * `conv.inventoryWatches` array — the store keeps a watch in both). Drop the year pin (match any new
 * Street Glide, in stock or the 7/29 arrival) and keep condition "new" (Street Glide is a current
 * model, so a new-condition watch is fireable). Idempotent: a watch already on Street Glide is left
 * untouched. Touches no other conversation.
 *
 * SAFETY: dry-run by default; --apply writes. The caller must quiesce the API first (pm2 stop) and
 * back up conversations.json, then restart — the running service holds the store in memory and would
 * otherwise clobber an in-place edit.
 *
 *   DRY RUN:  CONVERSATIONS_DB_PATH=/path/conversations.json npx tsx scripts/backfill_peter_superglide_watch.ts
 *   APPLY:    CONVERSATIONS_DB_PATH=/path/conversations.json npx tsx scripts/backfill_peter_superglide_watch.ts --apply
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const TARGET_CONV_ID = "+17166887637";
const FROM_MODEL = /^super\s*glide$/i;
const TO_MODEL = "Street Glide";

/** Pure: retarget any active Super Glide watch on this conv to Street Glide (new, no year pin).
 *  Returns the number of watch records changed (0 if nothing matched — idempotent). */
export function correctPeterSuperGlideWatch(conv: any): number {
  if (!conv || conv.id !== TARGET_CONV_ID) return 0;
  let changed = 0;
  const retarget = (w: any): void => {
    if (!w || typeof w !== "object") return;
    if (w.status !== "active") return;
    if (!FROM_MODEL.test(String(w.model ?? "").trim())) return;
    w.model = TO_MODEL;
    delete w.year;
    delete w.yearMin;
    delete w.yearMax;
    w.condition = "new";
    w.exactness = "model_only";
    w.note = "peter_superglide_typo_corrected_to_street_glide";
    changed++;
  };
  if (Array.isArray(conv.inventoryWatches)) conv.inventoryWatches.forEach(retarget);
  retarget(conv.inventoryWatch);
  return changed;
}

// ── self-test (no args) ──
if (process.argv.length <= 2 || process.argv.includes("--self-test")) {
  // matching conv: both storage slots carry the typo'd Super Glide watch
  const conv = {
    id: TARGET_CONV_ID,
    inventoryWatch: { model: "Super Glide", year: 2026, condition: "new", status: "active", exactness: "year_model" },
    inventoryWatches: [
      { model: "Super Glide", year: 2026, condition: "new", status: "active", exactness: "year_model" }
    ]
  };
  const n = correctPeterSuperGlideWatch(conv);
  assert.equal(n, 2, "both watch records (singular + array) are retargeted");
  for (const w of [conv.inventoryWatch, conv.inventoryWatches[0]]) {
    assert.equal(w.model, "Street Glide");
    assert.equal(w.condition, "new");
    assert.equal(w.exactness, "model_only");
    assert.ok(!("year" in w), "year pin dropped so any new Street Glide matches");
  }
  // idempotent: running again changes nothing
  assert.equal(correctPeterSuperGlideWatch(conv), 0, "already-corrected watch is left untouched");

  // never touches another conversation, even with the same typo
  const other = { id: "+15550000000", inventoryWatch: { model: "Super Glide", status: "active" } };
  assert.equal(correctPeterSuperGlideWatch(other), 0, "only the target conversation is edited");
  assert.equal(other.inventoryWatch.model, "Super Glide");

  // never touches an inactive/paused watch on the target
  const paused = { id: TARGET_CONV_ID, inventoryWatch: { model: "Super Glide", status: "paused" } };
  assert.equal(correctPeterSuperGlideWatch(paused), 0, "inactive watch is left untouched");

  console.log("PASS backfill peter super-glide watch (self-test: 2 records retargeted, idempotent, scoped)");
  process.exit(0);
}

// ── real run ──
const apply = process.argv.includes("--apply");
const convPath =
  process.env.CONVERSATIONS_DB_PATH ||
  (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "conversations.json") : "");
if (!convPath || !fs.existsSync(convPath)) {
  console.error("Set CONVERSATIONS_DB_PATH (or DATA_DIR) to the conversations.json to edit.");
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(convPath, "utf8"));
const conversations: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.conversations) ? raw.conversations : [];
const target = conversations.find(c => c?.id === TARGET_CONV_ID);
if (!target) {
  console.error(`Conversation ${TARGET_CONV_ID} not found in ${convPath}.`);
  process.exit(3);
}
const changed = correctPeterSuperGlideWatch(target);
console.log(`Target ${TARGET_CONV_ID}: ${changed} watch record(s) would be retargeted Super Glide → Street Glide.`);
console.log("  after:", JSON.stringify(target.inventoryWatch));
if (apply && changed) {
  fs.writeFileSync(convPath, JSON.stringify(raw, null, 2));
  console.log(`\nApplied and persisted ${convPath}. Restart the API so it reloads the edited store.`);
} else if (!apply) {
  console.log("\n(dry-run — re-run with --apply to write this change)");
}
