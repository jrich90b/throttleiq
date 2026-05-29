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

async function main() {
  const storePath = configureDefaultStorePath();
  const slug = safeSlug(argValue("--slug") || argValue("--dealer") || "americanharley-sandbox");
  const { listDealerSetups } = await import("../services/api/src/domain/dealerSetupStore.js");
  const { buildDealerLaunchDryRun } = await import("../services/api/src/domain/dealerLaunchDryRun.js");
  const setup = (await listDealerSetups(500)).find(row => row.slug === slug);
  if (!setup) throw new Error(`Dealer setup "${slug}" not found in ${storePath}.`);
  const dryRun = buildDealerLaunchDryRun(setup);
  console.log(JSON.stringify({
    ok: dryRun.ok,
    slug: setup.slug,
    dealerSetupsPath: storePath,
    dryRun
  }, null, 2));
  if (!dryRun.ok) process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
