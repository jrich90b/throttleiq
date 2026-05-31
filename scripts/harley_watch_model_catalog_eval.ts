import { readFile } from "node:fs/promises";
import path from "node:path";

type Catalog = {
  aliases?: Record<string, string[]>;
  families?: Record<string, string[]>;
};

const root = process.cwd();

function normalizeKey(value: string): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\bpan[-\s]+am\b/g, "pan america")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function codeSet(values: string[] | undefined): Set<string> {
  return new Set((values ?? []).map(v => String(v).trim().toUpperCase()).filter(Boolean));
}

function hasOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.resolve(root, file), "utf8")) as T;
}

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: unknown, message: string): void {
  if (!condition) fail(message);
}

function getAlias(catalog: Catalog, label: string): Set<string> {
  const target = normalizeKey(label);
  for (const [raw, codes] of Object.entries(catalog.aliases ?? {})) {
    if (normalizeKey(raw) === target) return codeSet(codes);
  }
  return new Set();
}

function assertAliasCodes(catalog: Catalog, label: string, expectedCodes: string[]): void {
  const codes = getAlias(catalog, label);
  const missing = expectedCodes.filter(code => !codes.has(code));
  assert(!missing.length, `${label} is missing catalog codes: ${missing.join(", ")}`);
}

function assertAliasBridge(catalog: Catalog, left: string, right: string): void {
  const leftCodes = getAlias(catalog, left);
  const rightCodes = getAlias(catalog, right);
  assert(leftCodes.size, `${left} alias is missing`);
  assert(rightCodes.size, `${right} alias is missing`);
  assert(hasOverlap(leftCodes, rightCodes), `${left} does not share model codes with ${right}`);
}

function allCatalogCodes(catalog: Catalog): Set<string> {
  const out = new Set<string>();
  for (const section of [catalog.aliases, catalog.families]) {
    for (const values of Object.values(section ?? {})) {
      for (const code of values ?? []) {
        const normalized = String(code ?? "").trim().toUpperCase();
        if (normalized) out.add(normalized);
      }
    }
  }
  return out;
}

function leadingModelCode(raw: string): string | null {
  const parts = String(raw ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;
  if (!/^[A-Z0-9]{2,8}$/.test(parts[0] ?? "")) return null;
  if (!/\d/.test(parts[1] ?? "")) return null;
  return String(parts[0]).toUpperCase();
}

const official2026ByFamily = {
  Cruiser: [
    "Street Bob",
    "Low Rider S",
    "Heritage Classic",
    "Fat Boy",
    "Breakout",
    "Low Rider ST"
  ],
  "Grand American Touring": [
    "Street Glide",
    "Road Glide",
    "Street Glide Limited",
    "Road Glide Limited",
    "CVO Street Glide ST",
    "CVO Road Glide ST",
    "CVO Street Glide",
    "CVO Street Glide Limited"
  ],
  Sport: ["Nightster", "Nightster Special", "Sportster S"],
  Trike: ["Road Glide 3", "Street Glide 3 Limited", "CVO Street Glide 3 Limited"],
  "Adventure Touring": ["Pan America 1250 Special", "Pan America 1250 ST", "Pan America 1250 Limited"]
} as const;

const stale2026Labels = ["Pan America 1250 L", "Pan America Special", "Road Glide Trike"];

const catalogBridges: Array<[string, string]> = [
  ["Road Glide Trike", "Road Glide 3"],
  ["Road Glide III", "Road Glide 3"],
  ["Pan Am Limited", "Pan America 1250 Limited"],
  ["Pan Am L", "Pan America 1250 Limited"],
  ["Pan America 1250 L", "Pan America 1250 Limited"],
  ["Pan Am ST", "Pan America 1250 ST"],
  ["Pan America Special", "Pan America 1250 Special"],
  ["Street Glide Limited III", "Street Glide 3 Limited"],
  ["CVO Street Glide 3 Limited", "Street Glide 3 Limited"],
  ["Tri Glide", "Tri Glide Ultra"],
  ["Free Wheeler", "Freewheeler"]
];

const familyAliases = [
  "Cruiser",
  "Grand American Touring",
  "Sport",
  "Trike",
  "Adventure Touring",
  "Touring"
];

async function main(): Promise<void> {
  const modelsByYear = await readJson<Record<string, string[]>>("services/api/data/models_by_year.json");
  const catalog = await readJson<Catalog>("services/api/src/domain/model_codes_by_family.json");
  const apiSource = await readFile(path.resolve(root, "services/api/src/index.ts"), "utf8");
  const webSource = await readFile(path.resolve(root, "apps/web/src/app/page.tsx"), "utf8");

  const official2026 = Object.values(official2026ByFamily).flat();
  const modelSet = new Set((modelsByYear["2026"] ?? []).map(normalizeKey));
  const catalogCodes = allCatalogCodes(catalog);

  for (const model of official2026) {
    assert(modelSet.has(normalizeKey(model)), `2026 UI model list is missing official model: ${model}`);
  }
  for (const [year, list] of Object.entries(modelsByYear)) {
    for (const raw of list ?? []) {
      const code = leadingModelCode(raw);
      if (!code) continue;
      assert(catalogCodes.has(code), `UI model code ${code} from ${year} "${raw}" is missing from catalog codes`);
    }
  }
  for (const stale of stale2026Labels) {
    assert(!modelSet.has(normalizeKey(stale)), `2026 UI model list still exposes stale label: ${stale}`);
  }
  assert(
    (modelsByYear["2026"] ?? []).length === official2026.length,
    `2026 UI model count drifted: expected ${official2026.length}, got ${(modelsByYear["2026"] ?? []).length}`
  );

  for (const [left, right] of catalogBridges) {
    assertAliasBridge(catalog, left, right);
  }
  for (const family of familyAliases) {
    const codes = getAlias(catalog, family);
    assert(codes.size, `${family} family alias is missing from model code catalog`);
  }

  assertAliasCodes(catalog, "Road Glide 3", ["FLTRT"]);
  assertAliasCodes(catalog, "Street Glide 3 Limited", ["FLHLT"]);
  assertAliasCodes(catalog, "CVO Street Glide 3 Limited", ["FLHLTSE"]);
  assertAliasCodes(catalog, "Pan America 1250 Limited", ["RA1250L"]);
  assertAliasCodes(catalog, "Pan America 1250 Special", ["RA1250S"]);
  assertAliasCodes(catalog, "Pan America 1250 ST", ["RA1250ST"]);

  assert(!apiSource.includes('return "Pan America 1250 L"'), "API canonicalizer still returns Pan America 1250 L");
  assert(
    !apiSource.includes('return "Pan America Special"'),
    "API canonicalizer still returns shortened Pan America Special"
  );
  assert(!apiSource.includes('Road Glide Trike",'), "API default lexicon still exposes Road Glide Trike as primary");
  assert(apiSource.includes('"adventure_touring"'), "API watch family matching does not include Adventure Touring");
  assert(apiSource.includes('"cruiser"'), "API watch family matching does not include Cruiser");
  assert(apiSource.includes('"sport"'), "API watch family matching does not include Sport");
  assert(webSource.includes('"adventure_touring"'), "UI watch family matching does not include Adventure Touring");
  assert(webSource.includes('"cruiser"'), "UI watch family matching does not include Cruiser");
  assert(webSource.includes('"sport"'), "UI watch family matching does not include Sport");

  console.log(
    `Harley watch model catalog OK: ${official2026.length} official 2026 models, ` +
      `${catalogBridges.length} alias bridges, ${familyAliases.length} family aliases.`
  );
}

main().catch(err => {
  console.error("[harley-watch-model-catalog-eval] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
