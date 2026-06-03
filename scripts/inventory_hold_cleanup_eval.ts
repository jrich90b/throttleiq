import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "inventory-hold-cleanup-eval-"));
process.env.DATA_DIR = tempDir;

const { listInventoryHolds, setInventoryHold, clearInventoryHoldRefs } = await import(
  "../services/api/src/domain/inventoryHolds.ts"
);

const now = new Date().toISOString();

await setInventoryHold({
  stockId: "U123-24",
  vin: null,
  hold: {
    id: "u123-24",
    stockId: "U123-24",
    vin: "1HDTESTVIN123",
    label: "2024 Road Glide",
    createdAt: now,
    updatedAt: now
  }
});
await setInventoryHold({
  stockId: null,
  vin: "1HDVINONLY456",
  hold: {
    id: "1hdvinonly456",
    vin: "1HDVINONLY456",
    label: "2022 Street Glide",
    createdAt: now,
    updatedAt: now
  }
});

let removed = await clearInventoryHoldRefs({ vin: "1HDTESTVIN123" });
let holds = await listInventoryHolds();
const stockHoldClearedByVin = removed === 1 && !holds["u123-24"];

removed = await clearInventoryHoldRefs({ key: "1hdvinonly456" });
holds = await listInventoryHolds();
const vinHoldClearedByPriorKey = removed === 1 && Object.keys(holds).length === 0;

const checks = [
  ["stock_hold_cleared_by_vin", stockHoldClearedByVin, true],
  ["vin_hold_cleared_by_prior_key", vinHoldClearedByPriorKey, true]
] as const;

let passed = 0;
for (const [id, actual, expected] of checks) {
  const ok = actual === expected;
  if (ok) passed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${id} expected=${expected} actual=${actual}`);
}

if (passed !== checks.length) {
  console.error(`\n${checks.length - passed} inventory hold cleanup eval check(s) failed`);
  process.exit(1);
}

console.log(`\nAll ${checks.length} inventory hold cleanup eval checks passed.`);
