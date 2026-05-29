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

async function readPackage(packageDir: string) {
  const files: Array<{ path: string; content: string; description: string; sha256: string; mode?: number }> = [];
  const stack = [packageDir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const rel = path.relative(packageDir, full);
        files.push({
          path: rel,
          content: await fs.readFile(full, "utf8"),
          description: rel,
          sha256: ""
        });
      }
    }
  }
  const manifestFile = files.find(file => file.path === "manifest.json");
  const manifest = manifestFile ? JSON.parse(manifestFile.content) : null;
  const byPath = new Map((manifest?.files ?? []).map((file: any) => [String(file.path), file]));
  return {
    packageDir,
    slug: manifest?.dealer?.slug ?? "",
    generatedAt: manifest?.generatedAt ?? "",
    manifest,
    files: files.map(file => {
      const manifestEntry = byPath.get(file.path) as any;
      return {
        ...file,
        description: manifestEntry?.description ?? file.description,
        sha256: manifestEntry?.sha256 ?? file.sha256
      };
    })
  };
}

async function main() {
  const storePath = configureDefaultStorePath();
  const slug = safeSlug(argValue("--slug") || argValue("--dealer") || "americanharley-sandbox");
  const packageDir = path.resolve(argValue("--package") || argValue("--out") || path.join("reports/dealer-setup", slug, "runtime-config-package"));
  const { listDealerSetups } = await import("../services/api/src/domain/dealerSetupStore.js");
  const { verifyDealerRuntimePackage } = await import("../services/api/src/domain/dealerRuntimePackage.js");
  const setup = (await listDealerSetups(500)).find(row => row.slug === slug);
  if (!setup) throw new Error(`Dealer setup "${slug}" not found in ${storePath}.`);

  const runtimePackage = await readPackage(packageDir);
  const verification = verifyDealerRuntimePackage(setup, runtimePackage);
  console.log(JSON.stringify({
    ok: verification.ok,
    slug: setup.slug,
    packageDir,
    dealerSetupsPath: storePath,
    failures: verification.failures,
    warnings: verification.warnings
  }, null, 2));
  if (!verification.ok) process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
