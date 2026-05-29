import { promises as fs } from "node:fs";
import * as path from "node:path";

function argValue(name: string) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || "";
  const prefix = `${name}=`;
  return process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length) || "";
}

function configureDefaultStorePath() {
  if (process.env.DEALER_SETUPS_PATH?.trim()) return process.env.DEALER_SETUPS_PATH;
  const cwd = process.cwd();
  const isApiWorkspace = cwd.endsWith(path.join("services", "api"));
  const storePath = isApiWorkspace
    ? path.resolve(cwd, "data/dealer_setups.json")
    : path.resolve(cwd, "services/api/data/dealer_setups.json");
  process.env.DEALER_SETUPS_PATH = storePath;
  return storePath;
}

function safeSlug(value: string) {
  return value.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "dealer";
}

async function writePackage(outDir: string, files: Array<{ path: string; content: string; mode?: number }>) {
  await fs.mkdir(outDir, { recursive: true });
  for (const file of files) {
    const target = path.join(outDir, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, "utf8");
    if (file.mode) await fs.chmod(target, file.mode);
  }
}

async function main() {
  const storePath = configureDefaultStorePath();
  const slug = safeSlug(argValue("--slug") || argValue("--dealer") || "americanharley-sandbox");
  const outDir = path.resolve(argValue("--out") || argValue("--package") || path.join("reports/dealer-setup", slug, "runtime-config-package"));
  const { listDealerSetups } = await import("../services/api/src/domain/dealerSetupStore.js");
  const { buildDealerRuntimePackage, verifyDealerRuntimePackage } = await import("../services/api/src/domain/dealerRuntimePackage.js");
  const setup = (await listDealerSetups(500)).find(row => row.slug === slug);
  if (!setup) throw new Error(`Dealer setup "${slug}" not found in ${storePath}.`);

  const runtimePackage = buildDealerRuntimePackage(setup, { packageDir: outDir });
  const verification = verifyDealerRuntimePackage(setup, runtimePackage);
  await writePackage(outDir, runtimePackage.files);

  console.log(JSON.stringify({
    ok: verification.ok,
    dealerSetupsPath: storePath,
    slug: setup.slug,
    dealerName: setup.dealerName,
    packageDir: outDir,
    files: runtimePackage.files.map(file => path.join(outDir, file.path)),
    verification,
    next: `npm run dealer:config:verify -- --slug ${setup.slug} --package ${outDir}`
  }, null, 2));
  if (!verification.ok) process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
