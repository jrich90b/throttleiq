/**
 * Watch-fire miss audit — the detector for Joe's #1 gap: an active inventory watch whose matching
 * unit is in stock but the customer was never notified.
 *
 *   real run:  CONVERSATIONS_DB_PATH=/path/conversations.json npx tsx scripts/watch_fire_miss_audit.ts [--out FILE]
 *   self-test: npx tsx scripts/watch_fire_miss_audit.ts --self-test   (deterministic, no feed — for ci:eval)
 *
 * Read-only. Reuses the real model matcher; reports candidates for the agent-watch loop to verify.
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { findWatchFireMisses, inventoryItemMatchesWatch } from "../services/api/src/domain/watchFireMiss.ts";

if (process.argv.includes("--self-test")) {
  // model + year-range + condition matching
  assert.equal(inventoryItemMatchesWatch({ model: "Street Glide", year: "2024" } as any, { model: "Street Glide", createdAt: "" } as any), true);
  assert.equal(inventoryItemMatchesWatch({ model: "Road Glide", year: "2024" } as any, { model: "Street Glide", createdAt: "" } as any), false, "different model must not match");
  assert.equal(inventoryItemMatchesWatch({ model: "Street Glide", year: "2022" } as any, { model: "Street Glide", year: 2024, createdAt: "" } as any), false, "year mismatch must not match");
  assert.equal(inventoryItemMatchesWatch({ model: "Street Glide", year: "2024", condition: "Used" } as any, { model: "Street Glide", condition: "new", createdAt: "" } as any), false, "condition mismatch must not match");

  const feed = [
    { stockId: "STK100", model: "Street Glide", year: "2024", condition: "New" },
    { stockId: "STK200", model: "Road Glide", year: "2024", condition: "New" }
  ] as any[];
  const conversations = [
    // HIGH: active watch, matching unit, never notified
    { id: "c1", leadKey: "+1555000001", inventoryWatch: { model: "Street Glide", year: 2024, status: "active", createdAt: "2026-06-01" } },
    // MEDIUM: notified a DIFFERENT stock id than the one available
    { id: "c2", leadKey: "+1555000002", inventoryWatch: { model: "Street Glide", year: 2024, status: "active", createdAt: "2026-06-01", lastNotifiedAt: "2026-06-02", lastNotifiedStockId: "STK999" } },
    // NOT a miss: already notified the available unit
    { id: "c3", leadKey: "+1555000003", inventoryWatch: { model: "Street Glide", year: 2024, status: "active", createdAt: "2026-06-01", lastNotifiedAt: "2026-06-02", lastNotifiedStockId: "STK100" } },
    // NOT a miss: paused watch
    { id: "c4", leadKey: "+1555000004", inventoryWatch: { model: "Street Glide", year: 2024, status: "paused", createdAt: "2026-06-01" } },
    // NOT a miss: closed conversation
    { id: "c5", leadKey: "+1555000005", status: "closed", inventoryWatch: { model: "Street Glide", year: 2024, status: "active", createdAt: "2026-06-01" } },
    // NOT a miss: no matching unit in stock
    { id: "c6", leadKey: "+1555000006", inventoryWatch: { model: "Fat Boy", year: 2024, status: "active", createdAt: "2026-06-01" } },
    // NOT a miss: the SAME watch is carried both as a stale singular `inventoryWatch` (no notify
    // record) AND in `inventoryWatches[]` WITH the notify record for the available unit. The firing
    // engine records lastNotified on the array entry only, leaving the singular stale; the detector
    // must NOT double-count the stale singular as a phantom "never notified" miss (live FP class
    // 2026-06-28: Low Rider S S7-26, Road King U896-23, etc.).
    {
      id: "c7",
      leadKey: "+1555000007",
      inventoryWatch: { model: "Street Glide", year: 2024, status: "active", createdAt: "2026-06-01" },
      inventoryWatches: [
        { model: "Street Glide", year: 2024, status: "active", createdAt: "2026-06-01", lastNotifiedAt: "2026-06-26", lastNotifiedStockId: "STK100" }
      ]
    },
    // STILL a miss: a genuinely DISTINCT singular watch (different model) alongside a notified array
    // entry must remain surfaced — the dedup only drops a stale MIRROR, never a distinct watch.
    {
      id: "c8",
      leadKey: "+1555000008",
      inventoryWatch: { model: "Road Glide", year: 2024, status: "active", createdAt: "2026-06-01" },
      inventoryWatches: [
        { model: "Street Glide", year: 2024, status: "active", createdAt: "2026-06-01", lastNotifiedAt: "2026-06-26", lastNotifiedStockId: "STK100" }
      ]
    }
  ] as any[];
  const misses = findWatchFireMisses({ conversations, feedItems: feed });
  const byId = Object.fromEntries(misses.map(m => [m.convId, m]));
  assert.equal(misses.length, 3, `expected 3 misses, got ${misses.length}: ${misses.map(m => m.convId)}`);
  assert.equal(byId.c1?.confidence, "high", "c1 must be a high-confidence never-notified miss");
  assert.equal(byId.c1?.matchedStockId, "STK100");
  assert.equal(byId.c2?.confidence, "medium", "c2 must be a medium-confidence different-unit miss");
  assert.ok(!byId.c7, "c7 must NOT be flagged — the array entry's notify record covers the stale singular mirror");
  assert.equal(byId.c8?.confidence, "high", "c8 must stay flagged — a DISTINCT singular Road Glide watch (STK200) was never notified");
  assert.equal(byId.c8?.matchedStockId, "STK200");
  for (const id of ["c3", "c4", "c5", "c6"]) assert.ok(!byId[id], `${id} must NOT be flagged`);
  assert.equal(misses[0].confidence, "high", "high-confidence misses sort first");
  console.log("PASS watch fire miss audit (self-test: matcher + 8-fixture detector, stale-singular dedup)");
  process.exit(0);
}

// --- real run ---
async function main() {
  const { getInventoryFeed } = await import("../services/api/src/domain/inventoryFeed.ts");
  const convPath =
    process.env.CONVERSATIONS_DB_PATH ||
    (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "conversations.json") : "");
  if (!convPath || !fs.existsSync(convPath)) {
    console.error("Set CONVERSATIONS_DB_PATH (or DATA_DIR) to the conversations.json to scan.");
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(convPath, "utf8"));
  const conversations = Array.isArray(raw) ? raw : Array.isArray(raw?.conversations) ? raw.conversations : Object.values(raw);
  const feedItems = await getInventoryFeed().catch(() => []);
  const misses = findWatchFireMisses({ conversations, feedItems });

  const lines: string[] = [];
  lines.push(`# Watch-fire miss report — ${misses.length} active watch(es) with a matching in-stock unit not notified`);
  lines.push(`# Feed items scanned: ${feedItems.length}. Source: ${convPath}`);
  lines.push("# Candidates for the agent-watch loop: verify, then fix the watch-fire code parser-first + backfill (notify).");
  lines.push("");
  if (!misses.length) lines.push("(no watch-fire misses)");
  for (const m of misses) {
    lines.push(`## [${m.confidence}] conv ${m.convId} (${m.leadKey}) — watch: ${m.model}${m.watchYear ? " " + m.watchYear : ""}`);
    lines.push(`  matching unit in stock: ${m.matchedYear ?? ""} ${m.matchedModel ?? ""} (stock ${m.matchedStockId ?? "?"})`);
    lines.push(`  last notified: ${m.lastNotifiedAt ?? "never"} — ${m.reason}`);
    lines.push("");
  }
  const out = lines.join("\n");
  const outPath = process.env.WATCH_FIRE_MISS_OUT || (process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "");
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, out + "\n", "utf8");
    console.log(`Wrote ${misses.length} watch-fire miss(es) to ${outPath}`);
  } else {
    console.log(out);
  }
}
void main();
