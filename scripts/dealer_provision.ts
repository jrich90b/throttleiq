import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * Dealer provisioning — dry-run only (docs/multi_tenant_platform.md, M2).
 *
 * Usage:
 *   npm run dealer:provision -- --slug <dealer-slug> [--out <dir>]
 *
 * Reads the Dealer Setup record (DATA_DIR) and writes a reviewable plan under
 * reports/dealer-provision/<slug>/. Applies nothing: no SSH, no DNS, no PM2,
 * no vendor calls. Apply steps land in a later phase behind explicit flags.
 */
async function main() {
  const args = process.argv.slice(2);
  const slugIdx = args.indexOf("--slug");
  const outIdx = args.indexOf("--out");
  const slug = slugIdx >= 0 ? String(args[slugIdx + 1] ?? "").trim() : "";
  if (!slug) {
    console.error("dealer:provision requires --slug <dealer-slug>");
    process.exit(1);
  }

  const { listDealerSetups } = await import("../services/api/src/domain/dealerSetupStore.ts");
  const { buildDealerProvisionPlan } = await import(
    "../services/api/src/domain/dealerProvisionPlan.ts"
  );

  const setups = await listDealerSetups(500);
  const setup = setups.find(s => s.slug === slug);
  if (!setup) {
    console.error(
      `No dealer setup found for slug '${slug}'. Known slugs: ${setups.map(s => s.slug).join(", ") || "(none)"}`
    );
    process.exit(1);
  }

  const plan = buildDealerProvisionPlan(setup);
  const outDir = path.resolve(
    (outIdx >= 0 ? args[outIdx + 1] : "") || path.join(process.cwd(), "reports/dealer-provision", plan.slug)
  );
  for (const file of plan.files) {
    const dest = path.join(outDir, file.path);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, file.content, "utf8");
  }

  console.log(`dealer:provision DRY-RUN ok -> ${outDir}`);
  for (const line of plan.summaryLines) console.log(`  ${line}`);
  console.log(`  Files: ${plan.files.map(f => f.path).join(", ")}`);
  console.log("  Nothing was applied. Review plan.md for the apply order.");
}

main().catch(err => {
  console.error("dealer:provision failed:", err?.message ?? err);
  process.exit(1);
});
