import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildInventorySnapshot,
  buildInventoryWatchScanPlan,
  inventoryWatchGroupMatchesLastNotifiedStock,
  inventoryWatchItemMatchesLastNotifiedStock,
  loadInventorySnapshotFile,
  saveInventorySnapshotFile
} from "../services/api/src/domain/inventoryWatchSnapshot.js";

const currentInventory = [
  { stockId: "U876-22", vin: "1HD1KEF18NB619612", year: "2022", model: "Ultra Limited", color: "Vivid Black" },
  { stockId: "S7-26", vin: "1HD1YWZ10TB032949", year: "2026", model: "Low Rider S", color: "White Onyx Pearl Black Trim" },
  { stockId: "T22-26", vin: "1HD1MGN10TB854612", year: "2026", model: "Street Glide 3 Limited", color: "Iron Horse Metallic Black Trim" },
  { stockId: "T14-26", vin: "1HD1KHP10TB600212", year: "2026", model: "Road Glide Limited", color: "Vivid Black Black Trim" },
  { stockId: "U882-02", vin: "1HD1FRW122Y622903", year: "2002", model: "Road King Classic", color: "White Pearl" },
  { stockId: "U121-22", vin: "1HD1LC312NC404193", year: "2022", model: "Forty-Eight", color: "Vivid Black" }
];

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "inventory-watch-snapshot-"));
  const snapshotPath = path.join(tmp, "inventory_snapshot.json");
  const largeInventory = [
    ...currentInventory,
    ...Array.from({ length: 50 }, (_, index) => ({
      stockId: `OLD-${index}`,
      vin: `1HDTESTOLD${String(index).padStart(6, "0")}`,
      year: "2026",
      model: "Road Glide",
      color: "Vivid Black"
    }))
  ];

  await fs.writeFile(
    snapshotPath,
    JSON.stringify(buildInventorySnapshot(largeInventory), null, 2).slice(0, 4096),
    "utf8"
  );
  const corrupt = await loadInventorySnapshotFile(snapshotPath);
  assert.equal(corrupt.trusted, false);
  assert.equal(corrupt.status, "invalid");
  const corruptPlan = buildInventoryWatchScanPlan({ snapshotResult: corrupt, items: currentInventory });
  assert.equal(corruptPlan.allowNotifications, false);
  assert.equal(corruptPlan.reason, "invalid_snapshot");
  assert.equal(corruptPlan.newItems.length, 0);

  await fs.rm(snapshotPath, { force: true });
  const missing = await loadInventorySnapshotFile(snapshotPath);
  const missingPlan = buildInventoryWatchScanPlan({ snapshotResult: missing, items: currentInventory });
  assert.equal(missingPlan.allowNotifications, false);
  assert.equal(missingPlan.reason, "missing_snapshot");

  await saveInventorySnapshotFile(snapshotPath, currentInventory);
  const stable = await loadInventorySnapshotFile(snapshotPath);
  assert.equal(stable.trusted, true);
  const stablePlan = buildInventoryWatchScanPlan({ snapshotResult: stable, items: currentInventory });
  assert.equal(stablePlan.allowNotifications, true);
  assert.equal(stablePlan.newItems.length, 0);

  const oneNew = [
    ...currentInventory,
    { stockId: "N1-26", vin: "1HDTESTNEW000001", year: "2026", model: "Heritage Classic", color: "Blue Burst" }
  ];
  const oneNewPlan = buildInventoryWatchScanPlan({ snapshotResult: stable, items: oneNew });
  assert.equal(oneNewPlan.allowNotifications, true);
  assert.equal(oneNewPlan.newItems.length, 1);

  const bulkNew = [
    ...currentInventory,
    ...Array.from({ length: 12 }, (_, index) => ({
      stockId: `BULK-${index}`,
      vin: `1HDTESTBULK${String(index).padStart(6, "0")}`,
      year: "2026",
      model: "Street Glide",
      color: "Vivid Black"
    }))
  ];
  const bulkPlan = buildInventoryWatchScanPlan({
    snapshotResult: stable,
    items: bulkNew,
    bulkNewItemThreshold: 10,
    bulkNewItemRatio: 0.2
  });
  assert.equal(bulkPlan.allowNotifications, false);
  assert.equal(bulkPlan.reason, "bulk_resync");

  assert.equal(
    inventoryWatchItemMatchesLastNotifiedStock("S7-26", {
      stockId: "S7-26",
      vin: "1HD1YWZ10TB032949"
    }),
    true
  );
  assert.equal(
    inventoryWatchItemMatchesLastNotifiedStock("1HD1YWZ10TB032949", {
      stockId: "S7-26",
      vin: "1HD1YWZ10TB032949"
    }),
    true
  );
  assert.equal(
    inventoryWatchGroupMatchesLastNotifiedStock(
      [
        { lastNotifiedStockId: "U121-22" },
        {},
        { lastNotifiedStockId: null }
      ],
      { stockId: "U121-22", vin: "1HD1LC312NC404193", model: "Forty-Eight" }
    ),
    true
  );

  console.log("All inventory watch snapshot guard checks passed.");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
