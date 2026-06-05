import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  filterCadenceUnavailableItemsByRequestedYear,
  inventoryItemMatchesRequestedYear
} from "../services/api/src/domain/cadenceInventoryGuard.ts";

const josephRequestedYear = "2025";
const heldDifferentYear = {
  stockId: "S5-26",
  vin: "1HD1YA915TB027782",
  year: "2026",
  make: "Harley-Davidson",
  model: "Heritage Classic",
  color: "Vivid Black Black Laced Wheels"
};
const heldRequestedYear = {
  stockId: "S9-25",
  vin: "1HDTESTHERITAGE25",
  year: "2025",
  make: "Harley-Davidson",
  model: "Heritage Classic",
  color: "Vivid Black"
};

assert.equal(
  inventoryItemMatchesRequestedYear(heldDifferentYear, josephRequestedYear),
  false,
  "2026 held unit should not be treated as the requested 2025 Heritage Classic"
);
assert.equal(
  inventoryItemMatchesRequestedYear(heldRequestedYear, josephRequestedYear),
  true,
  "same-year held unit should remain eligible for exact unavailable messaging"
);
assert.deepEqual(
  filterCadenceUnavailableItemsByRequestedYear([heldDifferentYear], josephRequestedYear, {
    yearSearchBroadened: true
  }),
  [],
  "broadened similar-inventory search must not create a held-watch override for a different year"
);
assert.deepEqual(
  filterCadenceUnavailableItemsByRequestedYear([heldRequestedYear], josephRequestedYear, {
    yearSearchBroadened: true
  }),
  [heldRequestedYear],
  "broadened search should still allow a matching requested-year unavailable unit"
);
assert.deepEqual(
  filterCadenceUnavailableItemsByRequestedYear([heldDifferentYear], null, {
    yearSearchBroadened: true
  }),
  [heldDifferentYear],
  "model-only customer context can still use model-only held/sold availability handling"
);

const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
const heldOverride = apiSource.match(
  /async function buildCadenceHeldInventoryOverride[\s\S]*?const heldItem = status\.held\[0\];/
)?.[0];
assert.ok(heldOverride, "held inventory override function should be present");
assert.match(
  heldOverride,
  /let yearSearchBroadened = false;[\s\S]*?yearSearchBroadened = true;/,
  "held inventory override must track when it broadens from requested year to model-only search"
);
assert.match(
  heldOverride,
  /filterCadenceUnavailableItemsByRequestedYear\([\s\S]*?status\.held[\s\S]*?context\.year[\s\S]*?yearSearchBroadened/,
  "held items must be filtered by requested year after a broadened search"
);
assert.match(
  heldOverride,
  /filterCadenceUnavailableItemsByRequestedYear\([\s\S]*?status\.sold[\s\S]*?context\.year[\s\S]*?yearSearchBroadened/,
  "sold items must be filtered by requested year after a broadened search"
);

console.log("PASS cadence inventory specificity guard eval");
