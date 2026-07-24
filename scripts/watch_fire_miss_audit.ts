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

  // Condition + price-band gate (2026-07-11) — the recurring false-positives: a used, price-capped watch
  // matched to a NEW unit far above budget. Now that the snapshot carries condition + price, these reject.
  const usedRoadGlide = { model: "Road Glide", condition: "used", minPrice: 14000, maxPrice: 16000, createdAt: "" } as any;
  assert.equal(
    inventoryItemMatchesWatch({ model: "Road Glide", year: "2026", condition: "New", price: 29899 } as any, usedRoadGlide),
    false,
    "Robert Hofmeister case: used $14-16k watch must NOT match a new $29,899 unit (condition AND price both reject)"
  );
  assert.equal(
    inventoryItemMatchesWatch({ model: "Road Glide", year: "2021", condition: "Used", price: 15500 } as any, usedRoadGlide),
    true,
    "a used Road Glide in the $14-16k band IS a real match (the genuine miss we must still catch)"
  );
  // Price gate alone (no condition on either side) — over budget rejects.
  assert.equal(
    inventoryItemMatchesWatch({ model: "Fat Boy", price: 18000 } as any, { model: "Fat Boy", maxPrice: 10000, createdAt: "" } as any),
    false,
    "Rahscheem case: a $18k Fat Boy is over the $10k cap => not a match"
  );
  // Engine PARITY (2026-07-11): a BANDED watch rejects a unit with no valid price — the live engine
  // (index.ts) does the same (`if (hasMinPrice||hasMaxPrice){ if(!Number.isFinite(itemPrice)...) return false }`),
  // so an unpriced unit against a budget watch is NOT a miss the engine would have fired on. (Was
  // previously kept as "fail toward the miss", which diverged from the engine and cried wolf on
  // +17162264009 — a null-price 2011 Road Glide Custom against a used $14-16k Road Glide watch.)
  assert.equal(
    inventoryItemMatchesWatch({ model: "Fat Boy", condition: "used" } as any, { model: "Fat Boy", condition: "used", maxPrice: 10000, createdAt: "" } as any),
    false,
    "banded watch + unknown price => no match (engine parity)"
  );
  assert.equal(
    inventoryItemMatchesWatch({ model: "Fat Boy", condition: "used", price: 0 } as any, { model: "Fat Boy", condition: "used", maxPrice: 10000, createdAt: "" } as any),
    false,
    "banded watch + zero/invalid price => no match (engine parity)"
  );
  // A watch with NO price band still keeps an unknown-price unit — nothing to reject on.
  assert.equal(
    inventoryItemMatchesWatch({ model: "Fat Boy", condition: "used" } as any, { model: "Fat Boy", condition: "used", createdAt: "" } as any),
    true,
    "no price band => unknown price still matches"
  );

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

  // Notify-once parity (2026-07-11): a DIFFERENT same-model unit is not a fresh miss while the unit
  // we already notified about is STILL in stock (the standing notification covers the model). The
  // medium only fires when the notified unit is GONE and a new matching one is available.
  {
    const feed2 = [
      { stockId: "SG-A", model: "Street Glide", year: "2024", condition: "New" },
      { stockId: "SG-B", model: "Street Glide", year: "2024", condition: "New" }
    ] as any[];
    const stillInStock = findWatchFireMisses({
      conversations: [
        { id: "d1", leadKey: "+1", inventoryWatch: { model: "Street Glide", year: 2024, status: "active", createdAt: "2026-06-01", lastNotifiedAt: "2026-06-02", lastNotifiedStockId: "SG-A" } }
      ] as any[],
      feedItems: feed2
    });
    assert.equal(stillInStock.length, 0, "notified unit still in stock => no fresh miss (notify-once)");
    const notifiedGone = findWatchFireMisses({
      conversations: [
        { id: "d2", leadKey: "+1", inventoryWatch: { model: "Street Glide", year: 2024, status: "active", createdAt: "2026-06-01", lastNotifiedAt: "2026-06-02", lastNotifiedStockId: "SG-GONE" } }
      ] as any[],
      feedItems: feed2
    });
    assert.equal(notifiedGone.length, 1, "notified unit gone + new one available => medium miss stays");
    assert.equal(notifiedGone[0].confidence, "medium");
  }

  // Engine-parity GROUP guard (2026-07-23, +19292685345): duplicate/backfilled sibling watches
  // where only ONE carries the notification stamp for the available unit. The live engine's
  // group guard (inventoryWatchGroupAlreadyNotifiedStock) never re-fires on a unit ANY sibling
  // watch already notified, so the un-stamped duplicate is NOT a miss — it was a persistent
  // every-sweep phantom high before the detector mirrored the guard.
  {
    const feedGroup = [{ stockId: "U600-05", model: "15th Anniversary Fat Boy", year: "2010", condition: "Used" }] as any[];
    const dupSiblings = findWatchFireMisses({
      conversations: [
        {
          id: "g1",
          leadKey: "+19292685345",
          inventoryWatches: [
            // stamped sibling: the customer WAS notified about U600-05 on this watch
            { model: "103 Anv Fat Boy Lo Anv", status: "active", createdAt: "2026-07-15", lastNotifiedAt: "2026-07-22", lastNotifiedStockId: "U600-05" },
            // un-stamped duplicates of the same intent — must NOT cry wolf on the same unit
            { model: "Anv Fat Boy Lo Anv", status: "active", createdAt: "2026-07-15" },
            { model: "Fat Boy", status: "active", createdAt: "2026-07-15" }
          ]
        }
      ] as any[],
      feedItems: feedGroup
    });
    assert.equal(
      dupSiblings.length,
      0,
      `+19292685345 shape: a unit any SIBLING watch already notified is not a miss (engine group-guard parity); got ${JSON.stringify(dupSiblings)}`
    );
    // The guard must not over-suppress: a sibling's stamp for a DIFFERENT (gone) unit does not
    // cover a NEW matching unit the customer never heard about — that stays a real high miss.
    const newUnitStillMiss = findWatchFireMisses({
      conversations: [
        {
          id: "g2",
          leadKey: "+1555000009",
          inventoryWatches: [
            { model: "Road Glide", year: 2024, status: "active", createdAt: "2026-06-01", lastNotifiedAt: "2026-06-02", lastNotifiedStockId: "RG-GONE" },
            { model: "Street Glide", year: 2024, status: "active", createdAt: "2026-06-01" }
          ]
        }
      ] as any[],
      feedItems: [{ stockId: "SG-NEW", model: "Street Glide", year: "2024", condition: "New" }] as any[]
    });
    assert.ok(
      newUnitStillMiss.some(m => m.convId === "g2" && m.confidence === "high" && m.matchedStockId === "SG-NEW"),
      "g2: a sibling stamp for a different, gone unit must NOT suppress a genuine never-notified miss on a new unit"
    );
  }

  // Engine-parity HELD-LEAD guard (2026-07-24). The engine skips a conversation that is off
  // proactive outreach before it reads any watch, so a never-fired watch on a held lead is the
  // design working, not a miss. Live phantoms: James Mcclain +17164253400 and Shane Smith
  // +17163852815 (both manual_handoff) were 2 of the 4 highs that morning.
  {
    const heldFeed = [{ stockId: "CVO-1", model: "CVO Road Glide ST", year: "2026", condition: "New" }] as any[];
    const heldConvs = [
      // staff own the thread — engine skips (isProactiveContactPaused)
      { id: "h1", leadKey: "+17164253400", followUp: { mode: "manual_handoff" }, inventoryWatch: { model: "CVO Road Glide ST", year: 2026, status: "active", createdAt: "2026-05-07" } },
      // explicit "hold off" — engine skips
      { id: "h2", leadKey: "+1555000010", followUp: { mode: "paused_indefinite" }, inventoryWatch: { model: "CVO Road Glide ST", year: 2026, status: "active", createdAt: "2026-05-07" } },
      // customer asked us to stop alerting — engine skips (durable opt-out)
      { id: "h3", leadKey: "+1555000011", inventoryWatchOptOut: { at: "2026-06-01", reason: "watch_opt_out" }, inventoryWatch: { model: "CVO Road Glide ST", year: 2026, status: "active", createdAt: "2026-05-07" } },
      // holding_inventory is deliberately NOT held — this lead WANTS the alert, so a never-notified
      // matching unit stays a real high miss.
      { id: "h4", leadKey: "+1555000012", followUp: { mode: "holding_inventory" }, inventoryWatch: { model: "CVO Road Glide ST", year: 2026, status: "active", createdAt: "2026-05-07" } }
    ] as any[];
    const heldMisses = findWatchFireMisses({ conversations: heldConvs, feedItems: heldFeed });
    const heldIds = heldMisses.map(m => m.convId);
    for (const id of ["h1", "h2", "h3"]) {
      assert.ok(!heldIds.includes(id), `${id}: a held/opted-out lead is off proactive outreach => not a miss (engine parity); got ${JSON.stringify(heldIds)}`);
    }
    assert.ok(
      heldMisses.some(m => m.convId === "h4" && m.confidence === "high"),
      "h4: holding_inventory is NOT a hold — a never-notified match must stay flagged"
    );
  }

  // Price-band parity at the conversation level: a null-price unit against a banded watch is not a
  // miss (mirrors the +17162264009 live case).
  {
    const feed3 = [{ stockId: "RG-NP", model: "Road Glide", year: "2011", condition: "used", price: null }] as any[];
    const bandedNullPrice = findWatchFireMisses({
      conversations: [
        { id: "e1", leadKey: "+1", inventoryWatch: { model: "Road Glide", condition: "used", minPrice: 14000, maxPrice: 16000, status: "active", createdAt: "2026-04-01" } }
      ] as any[],
      feedItems: feed3
    });
    assert.equal(bandedNullPrice.length, 0, "banded watch + null-price unit => not a miss (engine parity)");
  }

  // --- Arrival gate (firstSeen): only units that arrived AFTER the watch are misses (Joe's policy:
  // a unit already in stock at watch-creation is intentionally never fired). Same fixtures, now with
  // a first-seen map. c1's STK100 arrived after the watch => still a miss; flip it to baseline /
  // before-the-watch and it must clear.
  const watchCreated = "2026-06-01";
  const arrivedAfter = { stk100: { key: "stk100", firstSeenAt: "2026-06-10", baseline: false } } as any;
  const gated = findWatchFireMisses({ conversations, feedItems: feed, firstSeen: arrivedAfter });
  const gatedById = Object.fromEntries(gated.map(m => [m.convId, m]));
  assert.equal(gatedById.c1?.confidence, "high", "c1: STK100 arrived after the watch => still a high miss");
  assert.equal(gatedById.c1?.matchedStockId, "STK100");
  // STK200 (c8's Road Glide) has NO first-seen entry => unknown arrival => NOT a miss under the gate.
  assert.ok(!gatedById.c8, "c8: a unit with no first-seen record is not a confirmed post-watch arrival => not flagged");

  // STK100 already in stock at watch creation (baseline) => c1 clears.
  const baselineSeen = { stk100: { key: "stk100", firstSeenAt: new Date(0).toISOString(), baseline: true } } as any;
  assert.ok(
    !findWatchFireMisses({ conversations, feedItems: feed, firstSeen: baselineSeen }).some(m => m.convId === "c1"),
    "c1: a baseline (already-in-stock) unit must NOT be flagged"
  );
  // STK100 first-seen BEFORE the watch was created => c1 clears.
  const seenBefore = { stk100: { key: "stk100", firstSeenAt: "2026-05-01", baseline: false } } as any;
  assert.ok(
    !findWatchFireMisses({ conversations, feedItems: feed, firstSeen: seenBefore }).some(m => m.convId === "c1"),
    `c1: a unit first seen before the watch (${watchCreated}) must NOT be flagged`
  );

  console.log("PASS watch fire miss audit (self-test: matcher + dedup + group-notified parity + held-lead parity + arrival-gate, 14 fixtures)");
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
  // Arrival gate: load the first-seen map written by the watch-fire cron so we only flag a unit that
  // genuinely arrived AFTER the watch (a real cron miss), not one already in stock at watch-creation
  // (which the cron intentionally never fires). Absent map => legacy behavior (no gate), with a note.
  const { loadInventoryFirstSeen } = await import("../services/api/src/domain/inventoryFirstSeen.ts");
  const firstSeenPath =
    process.env.INVENTORY_FIRST_SEEN_PATH ||
    (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "inventory_first_seen.json") : path.join(path.dirname(convPath), "inventory_first_seen.json"));
  const firstSeenMap = await loadInventoryFirstSeen(firstSeenPath).catch(() => null);
  const firstSeen = firstSeenMap?.entries;
  const misses = findWatchFireMisses({ conversations, feedItems, firstSeen });

  const lines: string[] = [];
  lines.push(`# Watch-fire miss report — ${misses.length} active watch(es) with a matching in-stock unit not notified`);
  lines.push(`# Feed items scanned: ${feedItems.length}. Source: ${convPath}`);
  lines.push(
    firstSeen
      ? `# Arrival gate ON: only units that arrived after the watch (first-seen map: ${Object.keys(firstSeen).length} keys) are flagged.`
      : `# Arrival gate OFF (no inventory_first_seen.json) — legacy scan; already-in-stock units may over-report.`
  );
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
