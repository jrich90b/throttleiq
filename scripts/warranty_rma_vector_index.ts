import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: "services/api/.env", override: false });

const { listWarrantyRmaManuals, warrantyRmaStoreReady } = await import("../services/api/src/domain/warrantyRmaStore.ts");
const { getWarrantyRmaVectorStatus, indexWarrantyRmaManuals } = await import("../services/api/src/domain/warrantyRmaVectorStore.ts");

await warrantyRmaStoreReady;

const manualIds = process.argv
  .slice(2)
  .filter(arg => !arg.startsWith("--"))
  .map(arg => arg.trim())
  .filter(Boolean);
const requireConfig = process.argv.includes("--require-config");

const status = getWarrantyRmaVectorStatus();
if (!status.configured) {
  const message = `Warranty/RMA vector indexing skipped. Missing: ${status.missing.join(", ")}`;
  if (requireConfig) {
    console.error(message);
    process.exit(1);
  }
  console.log(message);
  process.exit(0);
}

const result = await indexWarrantyRmaManuals(listWarrantyRmaManuals(), {
  manualIds: manualIds.length ? manualIds : undefined
});

console.log(
  JSON.stringify(
    {
      ok: true,
      indexName: result.indexName,
      namespace: result.namespace,
      namespaces: result.namespaces,
      documentsConsidered: result.documentsConsidered,
      documentsIndexed: result.documentsIndexed,
      chunksUpserted: result.chunksUpserted,
      chunksDeleted: result.chunksDeleted,
      skipped: result.skipped.length,
      errors: result.errors
    },
    null,
    2
  )
);

if (result.errors.length) process.exit(1);
