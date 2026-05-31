import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type Catalog = {
  aliases?: Record<string, string[]>;
  families?: Record<string, string[]>;
};

const root = process.cwd();

type CliArgs = {
  out?: string;
  markdown?: string;
};

type CheckResult = {
  ok: boolean;
  message: string;
};

type CatalogReport = {
  ok: boolean;
  generatedAt: string;
  summary: {
    checkCount: number;
    failureCount: number;
    official2026ModelCount: number;
    configured2026ModelCount: number;
    aliasBridgeCount: number;
    familyAliasCount: number;
  };
  runtimeWatch?: RuntimeWatchSummary;
  checks: CheckResult[];
  findings: CheckResult[];
  fatalError?: string;
};

type RuntimeWatchFinding = {
  issue: string;
  message: string;
  conversationId?: string;
  customerName?: string;
  leadRef?: string;
  watch?: unknown;
};

type RuntimeWatchSummary = {
  sourcePath?: string;
  conversationsChecked: number;
  watchConversations: number;
  activeWatchCount: number;
  promptedWatchCount: number;
  skippedUnrecognizedNonHarleyCount: number;
  findingCount: number;
  findings: RuntimeWatchFinding[];
};

const checks: CheckResult[] = [];

function parseArgs(argv = process.argv.slice(2)): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--out") {
      args.out = argv[i + 1];
      i += 1;
    } else if (value === "--markdown" || value === "--md") {
      args.markdown = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

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

async function readOptionalJson<T>(file: string | undefined): Promise<T | null> {
  if (!file) return null;
  try {
    return JSON.parse(await readFile(path.resolve(root, file), "utf8")) as T;
  } catch (error) {
    const code = (error as any)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

function assert(condition: unknown, message: string): void {
  checks.push({ ok: Boolean(condition), message });
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

function resolveCatalogCodesForLabel(catalog: Catalog, catalogCodes: Set<string>, label: string): Set<string> {
  const exact = getAlias(catalog, label);
  if (exact.size) return exact;

  const tokenMatches = new Set<string>();
  for (const rawToken of String(label ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)) {
    const token = rawToken.replace(/_{2,}/g, "_");
    if (catalogCodes.has(token)) tokenMatches.add(token);
  }
  if (tokenMatches.size) return tokenMatches;

  const labelKey = normalizeKey(label);
  const aliasEntries = Object.entries(catalog.aliases ?? {})
    .map(([raw, codes]) => ({
      key: normalizeKey(raw),
      codes: codeSet(codes)
    }))
    .filter(entry => entry.key.length >= 5 && entry.codes.size)
    .sort((left, right) => right.key.length - left.key.length);

  for (const entry of aliasEntries) {
    if (labelKey === entry.key || labelKey.includes(entry.key)) return entry.codes;
  }
  return new Set();
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

function resolveConversationsPath(): string | undefined {
  const explicit = String(process.env.CONVERSATIONS_DB_PATH || process.env.CONVERSATIONS_PATH || "").trim();
  if (explicit) return explicit;
  const dataDir = String(process.env.DATA_DIR || "").trim();
  return dataDir ? path.join(dataDir, "conversations.json") : undefined;
}

function extractConversations(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.conversations)) return raw.conversations;
  if (raw?.conversations && typeof raw.conversations === "object") {
    return Object.values(raw.conversations);
  }
  if (raw && typeof raw === "object") {
    return Object.values(raw).filter(value => {
      if (!value || typeof value !== "object") return false;
      return Boolean(
        (value as any).messages ||
          (value as any).inventoryWatch ||
          (value as any).inventoryWatches ||
          (value as any).followUp ||
          (value as any).dialogState
      );
    });
  }
  return [];
}

function watchKey(watch: any): string {
  return JSON.stringify({
    model: normalizeKey(watch?.model ?? ""),
    make: normalizeKey(watch?.make ?? ""),
    year: watch?.year ?? null,
    yearMin: watch?.yearMin ?? null,
    yearMax: watch?.yearMax ?? null,
    color: normalizeKey(watch?.color ?? ""),
    trim: normalizeKey(watch?.trim ?? ""),
    condition: normalizeKey(watch?.condition ?? "")
  });
}

function activeWatchList(conv: any): any[] {
  const raw = [
    conv?.inventoryWatch,
    ...(Array.isArray(conv?.inventoryWatches) ? conv.inventoryWatches : [])
  ].filter(Boolean);
  const seen = new Set<string>();
  return raw.filter(watch => {
    const key = watchKey(watch);
    if (seen.has(key)) return false;
    seen.add(key);
    return !watch?.status || String(watch.status).toLowerCase() === "active";
  });
}

function dialogStateName(conv: any): string {
  return normalizeKey(typeof conv?.dialogState === "string" ? conv.dialogState : conv?.dialogState?.name ?? "");
}

function isLikelyHarleyWatch(catalog: Catalog, watch: any): boolean {
  const make = normalizeKey(watch?.make ?? "");
  const model = normalizeKey(watch?.model ?? "");
  if (make.includes("harley") || make.includes("davidson")) return true;
  if (model && getAlias(catalog, model).size) return true;
  return /\b(street|road|glide|iron|sportster|softail|fat boy|fat bob|breakout|heritage|low rider|pan america|nightster|freewheeler|tri glide|cvo|electra|road king)\b/i.test(
    String(watch?.model ?? "")
  );
}

function sameWatchIdentity(left: any, right: any): boolean {
  return watchKey(left) === watchKey(right);
}

async function auditRuntimeWatches(catalog: Catalog): Promise<RuntimeWatchSummary | undefined> {
  const sourcePath = resolveConversationsPath();
  const raw = await readOptionalJson<any>(sourcePath);
  if (!raw) return undefined;

  const conversations = extractConversations(raw);
  const catalogCodes = allCatalogCodes(catalog);
  const findings: RuntimeWatchFinding[] = [];
  let watchConversations = 0;
  let activeWatchCount = 0;
  let promptedWatchCount = 0;
  let skippedUnrecognizedNonHarleyCount = 0;

  const addFinding = (conv: any, issue: string, message: string, watch?: unknown) => {
    findings.push({
      issue,
      message,
      conversationId: conv?.id ? String(conv.id) : undefined,
      customerName: conv?.customerName || conv?.name ? String(conv.customerName || conv.name) : undefined,
      leadRef: conv?.leadRef ? String(conv.leadRef) : undefined,
      watch
    });
  };

  for (const conv of conversations) {
    const watches = activeWatchList(conv);
    const state = dialogStateName(conv);
    const prompted = state === "inventory watch prompted";
    const activeState = state === "inventory watch active";
    const followUpReason = normalizeKey(conv?.followUp?.reason ?? "");
    const hasWatchContext = watches.length > 0 || activeState || prompted || followUpReason === "inventory watch";

    if (!hasWatchContext) continue;
    watchConversations += 1;
    if (prompted) promptedWatchCount += 1;
    activeWatchCount += watches.length;

    if (!watches.length && (activeState || followUpReason === "inventory watch") && !prompted) {
      addFinding(
        conv,
        "missing_active_watch",
        "Conversation is marked as inventory watch, but no active inventoryWatch record is present."
      );
    }

    if (conv?.inventoryWatch && Array.isArray(conv?.inventoryWatches) && conv.inventoryWatches[0]) {
      if (!sameWatchIdentity(conv.inventoryWatch, conv.inventoryWatches[0])) {
        addFinding(
          conv,
          "primary_watch_mismatch",
          "inventoryWatch and inventoryWatches[0] do not describe the same watch.",
          { primary: conv.inventoryWatch, firstListItem: conv.inventoryWatches[0] }
        );
      }
    }

    for (const watch of watches) {
      const model = String(watch?.model ?? "").trim();
      if (!model) {
        addFinding(conv, "active_watch_missing_model", "Active inventory watch is missing a model.", watch);
      }

      const year = Number(watch?.year ?? NaN);
      const yearMin = Number(watch?.yearMin ?? NaN);
      const yearMax = Number(watch?.yearMax ?? NaN);
      const nextYear = new Date().getUTCFullYear() + 1;
      if (Number.isFinite(year) && (year < 1903 || year > nextYear)) {
        addFinding(conv, "watch_year_out_of_range", `Watch year ${year} is outside the expected Harley range.`, watch);
      }
      if (Number.isFinite(yearMin) && Number.isFinite(yearMax) && yearMin > yearMax) {
        addFinding(conv, "watch_year_range_reversed", "Watch yearMin is greater than yearMax.", watch);
      }

      if (model && isLikelyHarleyWatch(catalog, watch)) {
        const codes = resolveCatalogCodesForLabel(catalog, catalogCodes, model);
        if (!codes.size) {
          addFinding(
            conv,
            "harley_watch_model_missing_catalog_codes",
            `Harley watch model "${model}" does not resolve to model catalog codes.`,
            watch
          );
        }
      } else if (model) {
        skippedUnrecognizedNonHarleyCount += 1;
      }
    }
  }

  return {
    sourcePath,
    conversationsChecked: conversations.length,
    watchConversations,
    activeWatchCount,
    promptedWatchCount,
    skippedUnrecognizedNonHarleyCount,
    findingCount: findings.length,
    findings
  };
}

function buildReport(input: {
  official2026ModelCount: number;
  configured2026ModelCount: number;
  runtimeWatch?: RuntimeWatchSummary;
}): CatalogReport {
  const findings = checks.filter(check => !check.ok);
  const totalFailureCount = findings.length + (input.runtimeWatch?.findingCount ?? 0);
  return {
    ok: totalFailureCount === 0,
    generatedAt: new Date().toISOString(),
    summary: {
      checkCount: checks.length,
      failureCount: totalFailureCount,
      official2026ModelCount: input.official2026ModelCount,
      configured2026ModelCount: input.configured2026ModelCount,
      aliasBridgeCount: catalogBridges.length,
      familyAliasCount: familyAliases.length
    },
    runtimeWatch: input.runtimeWatch,
    checks,
    findings
  };
}

function buildFatalReport(message: string): CatalogReport {
  return {
    ok: false,
    generatedAt: new Date().toISOString(),
    summary: {
      checkCount: checks.length,
      failureCount: checks.filter(check => !check.ok).length + 1,
      official2026ModelCount: Object.values(official2026ByFamily).flat().length,
      configured2026ModelCount: 0,
      aliasBridgeCount: catalogBridges.length,
      familyAliasCount: familyAliases.length
    },
    checks,
    findings: [...checks.filter(check => !check.ok), { ok: false, message }],
    fatalError: message
  };
}

function reportMarkdown(report: CatalogReport): string {
  const lines = [
    "# Vehicle Watch Catalog QA",
    "",
    `Generated: ${report.generatedAt}`,
    `Status: ${report.ok ? "OK" : "Needs review"}`,
    "",
    "## Summary",
    "",
    `- Checks: ${report.summary.checkCount}`,
    `- Findings: ${report.summary.failureCount}`,
    `- Official 2026 models expected: ${report.summary.official2026ModelCount}`,
    `- 2026 models configured: ${report.summary.configured2026ModelCount}`,
    `- Alias bridges checked: ${report.summary.aliasBridgeCount}`,
    `- Family aliases checked: ${report.summary.familyAliasCount}`,
    ...(report.runtimeWatch
      ? [
          `- Runtime watch conversations: ${report.runtimeWatch.watchConversations}`,
          `- Runtime active watches: ${report.runtimeWatch.activeWatchCount}`,
          `- Runtime watch findings: ${report.runtimeWatch.findingCount}`
        ]
      : ["- Runtime watch audit: not available"]),
    "",
    "## Findings",
    ""
  ];

  if (!report.findings.length) {
    lines.push("- None");
  } else {
    for (const finding of report.findings) {
      lines.push(`- ${finding.message}`);
    }
  }

  lines.push("", "## Runtime Watch Findings", "");
  if (!report.runtimeWatch) {
    lines.push("- Not available");
  } else if (!report.runtimeWatch.findings.length) {
    lines.push("- None");
  } else {
    for (const finding of report.runtimeWatch.findings) {
      const label = [
        finding.customerName,
        finding.leadRef ? `Lead ${finding.leadRef}` : "",
        finding.conversationId ? `Conversation ${finding.conversationId}` : ""
      ]
        .filter(Boolean)
        .join(" - ");
      lines.push(`- ${finding.issue}${label ? ` (${label})` : ""}: ${finding.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function writeArtifacts(report: CatalogReport, args: CliArgs): Promise<void> {
  if (args.out) {
    const filePath = path.resolve(root, args.out);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (args.markdown) {
    const filePath = path.resolve(root, args.markdown);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, reportMarkdown(report));
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
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

  const runtimeWatch = await auditRuntimeWatches(catalog);
  const report = buildReport({
    official2026ModelCount: official2026.length,
    configured2026ModelCount: (modelsByYear["2026"] ?? []).length,
    runtimeWatch
  });
  await writeArtifacts(report, args);

  if (report.ok) {
    console.log(
      `Harley watch model catalog OK: ${official2026.length} official 2026 models, ` +
        `${catalogBridges.length} alias bridges, ${familyAliases.length} family aliases.`
    );
    return;
  }

  for (const finding of report.findings) {
    console.error(`[harley-watch-model-catalog-eval] ${finding.message}`);
  }
  for (const finding of report.runtimeWatch?.findings ?? []) {
    console.error(`[harley-watch-model-catalog-eval] ${finding.issue}: ${finding.message}`);
  }
  process.exitCode = 1;
}

main().catch(async err => {
  const message = err instanceof Error ? err.message : String(err);
  await writeArtifacts(buildFatalReport(message), parseArgs()).catch(() => {});
  console.error("[harley-watch-model-catalog-eval] failed:", message);
  process.exit(1);
});
