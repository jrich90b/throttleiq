/**
 * Watch-fire-miss sweep — folds the inventory watch-fire-miss detector into the unified feed.
 *
 * watch_fire_miss needs the INVENTORY feed (not just the conversation), so unlike the conv-only
 * auditConversationOutcome detectors it runs as a SIBLING sweep (like open_critic): it reads the
 * conversations + the on-disk inventory snapshot, runs `findWatchFireMisses` (an active watch whose
 * matching unit is in stock but the customer was never notified — a real lost-sale gap), and writes
 * OutcomeAnomaly entries that `anomaly_loop_detect` merges. Deterministic, read-only, no network.
 *
 * Run (on the box): CONVERSATIONS_DB_PATH=.../data/conversations.json REPORT_ROOT=.../reports npm run watch_fire_miss_sweep
 */
import fs from "node:fs";
import path from "node:path";

const dbPath = path.resolve(process.env.CONVERSATIONS_DB_PATH || "data/conversations.json");
const raw = JSON.parse(fs.readFileSync(dbPath, "utf8"));
const conversations: any[] = Array.isArray(raw?.conversations) ? raw.conversations : [];

// Inventory snapshot lives alongside the conversation store in the data dir ({ items: [...] } or a bare array).
const snapshotPath = path.join(path.dirname(dbPath), "inventory_snapshot.json");
let feedItems: any[] = [];
try {
  const snap = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  feedItems = Array.isArray(snap?.items) ? snap.items : Array.isArray(snap) ? snap : [];
} catch {
  feedItems = []; // missing snapshot → 0 misses (safe; never breaks the loop)
}

const { findWatchFireMisses } = await import("../services/api/src/domain/watchFireMiss.ts");
const misses = feedItems.length ? findWatchFireMisses({ conversations, feedItems }) : [];

const anomalies = misses.map((m: any) => ({
  convId: String(m.convId ?? ""),
  leadKey: String(m.leadKey ?? ""),
  dimension: "watch_fire_miss",
  category: "state" as const,
  severity: m.confidence === "high" ? ("P1" as const) : ("P2" as const),
  healed: false,
  detail: `watch-fire miss (${m.confidence}): a matching ${m.matchedModel ?? m.model}${m.matchedStockId ? ` (stock ${m.matchedStockId})` : ""} is in stock but the customer was never notified — ${String(m.reason ?? "").slice(0, 120)}`
}));

const reportRoot = process.env.REPORT_ROOT || path.resolve("reports");
const outDir = path.join(reportRoot, "watch_fire_miss");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "latest.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), source: process.env.CONVERSATIONS_DB_PATH, summary: { inventoryItems: feedItems.length, misses: anomalies.length }, anomalies }, null, 2)
);

console.log(`Watch-fire-miss sweep — ${feedItems.length} inventory item(s), ${anomalies.length} miss(es) (high+medium)`);
for (const a of anomalies.slice(0, 25)) console.log(`   - [${a.severity}] ${a.dimension} ${a.convId} | ${a.detail}`);
console.log(`\nFeed written: ${path.join(outDir, "latest.json")}`);
