import fs from "node:fs";
import path from "node:path";

type ManualSeedRow = {
  id?: string;
  reason?: string;
  modelDraft?: string;
  preferredDraft?: string;
};

type PositiveSeedRow = {
  id?: string;
  preferredDraft?: string;
};

type NegativeSeedRow = {
  id?: string;
  rejectedDraft?: string;
};

type DeterministicRuleEntry = {
  match: string;
  replace: string;
  count: number;
  source: string;
  updatedAt: string;
};

type BlockedDraftEntry = {
  text: string;
  count: number;
  source: string;
  updatedAt: string;
};

type DeterministicToneRulesFile = {
  version: number;
  updatedAt: string;
  auto?: {
    sourceDir: string;
    minCount: number;
    rewriteRules: DeterministicRuleEntry[];
    blockedExactDrafts: BlockedDraftEntry[];
  };
  manual?: {
    rewriteRules?: Array<{ match: string; replace: string; note?: string }>;
    blockedExactDrafts?: Array<{ text: string; note?: string }>;
  };
};

type ParsedArgs = {
  reportDir: string;
  outPath: string;
  minCount: number;
};

function parseArgs(argv: string[]): ParsedArgs {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) continue;
    args.set(key, value);
    i += 1;
  }

  const cwd = process.cwd();
  const dataDir = process.env.DATA_DIR || path.resolve(cwd, "data");
  const reportDir =
    args.get("--report-dir") ||
    process.env.LANGUAGE_CORPUS_OUT_DIR ||
    path.resolve(cwd, "reports", "language_corpus");
  const outPath =
    args.get("--out") ||
    process.env.DETERMINISTIC_TONE_RULES_PATH ||
    path.resolve(dataDir, "deterministic_tone_rules.json");
  const minCountRaw = Number(
    args.get("--min-count") || process.env.DETERMINISTIC_RULE_PROMOTE_MIN_COUNT || "2"
  );
  const minCount = Number.isFinite(minCountRaw) && minCountRaw > 0 ? minCountRaw : 2;

  return { reportDir, outPath, minCount };
}

function readRows<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (Array.isArray(parsed)) return parsed as T[];
    if (Array.isArray(parsed?.rows)) return parsed.rows as T[];
    return [];
  } catch {
    return [];
  }
}

function normText(input: unknown): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normKey(input: unknown): string {
  return normText(input).toLowerCase();
}

function isUsablePhrase(input: string): boolean {
  const text = normText(input);
  if (!text) return false;
  if (text.length < 8) return false;
  if (text.length > 500) return false;
  return true;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadExistingRules(outPath: string): DeterministicToneRulesFile | null {
  if (!fs.existsSync(outPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(outPath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as DeterministicToneRulesFile;
  } catch {
    return null;
  }
}

function run() {
  const parsed = parseArgs(process.argv.slice(2));
  const nowIso = new Date().toISOString();

  const manualSeedPath = path.join(parsed.reportDir, "few_shot_seed_candidates.json");
  const positiveSeedPath = path.join(parsed.reportDir, "few_shot_seed_positive_feedback.json");
  const negativeSeedPath = path.join(parsed.reportDir, "few_shot_seed_negative_feedback.json");

  const manualRows = readRows<ManualSeedRow>(manualSeedPath);
  const positiveRows = readRows<PositiveSeedRow>(positiveSeedPath);
  const negativeRows = readRows<NegativeSeedRow>(negativeSeedPath);

  const positivePreferred = new Set(
    positiveRows
      .map(row => normKey(row.preferredDraft))
      .filter(key => key.length > 0)
  );

  const rewriteCounts = new Map<
    string,
    { match: string; replace: string; count: number; source: string }
  >();
  for (const row of manualRows) {
    const match = normText(row.modelDraft);
    const replace = normText(row.preferredDraft);
    if (!isUsablePhrase(match) || !isUsablePhrase(replace)) continue;
    if (normKey(match) === normKey(replace)) continue;
    const key = `${normKey(match)}=>${normKey(replace)}`;
    const entry = rewriteCounts.get(key) ?? {
      match,
      replace,
      count: 0,
      source: "manual_edit_delta"
    };
    entry.count += 1;
    rewriteCounts.set(key, entry);
  }

  const blockedCounts = new Map<string, { text: string; count: number; source: string }>();
  for (const row of negativeRows) {
    const rejected = normText(row.rejectedDraft);
    const rejectedKey = normKey(rejected);
    if (!isUsablePhrase(rejected)) continue;
    if (positivePreferred.has(rejectedKey)) continue;
    const entry = blockedCounts.get(rejectedKey) ?? {
      text: rejected,
      count: 0,
      source: "negative_feedback"
    };
    entry.count += 1;
    blockedCounts.set(rejectedKey, entry);
  }

  const rewriteRules: DeterministicRuleEntry[] = [...rewriteCounts.values()]
    .filter(entry => entry.count >= parsed.minCount)
    .sort((a, b) => b.count - a.count)
    .map(entry => ({
      match: entry.match,
      replace: entry.replace,
      count: entry.count,
      source: entry.source,
      updatedAt: nowIso
    }));

  const blockedExactDrafts: BlockedDraftEntry[] = [...blockedCounts.values()]
    .filter(entry => entry.count >= parsed.minCount)
    .sort((a, b) => b.count - a.count)
    .map(entry => ({
      text: entry.text,
      count: entry.count,
      source: entry.source,
      updatedAt: nowIso
    }));

  const existing = loadExistingRules(parsed.outPath);
  const next: DeterministicToneRulesFile = {
    version: 1,
    updatedAt: nowIso,
    auto: {
      sourceDir: parsed.reportDir,
      minCount: parsed.minCount,
      rewriteRules,
      blockedExactDrafts
    },
    manual: existing?.manual ?? { rewriteRules: [], blockedExactDrafts: [] }
  };

  fs.mkdirSync(path.dirname(parsed.outPath), { recursive: true });
  fs.writeFileSync(parsed.outPath, JSON.stringify(next, null, 2) + "\n");

  const summary = {
    ok: true,
    reportDir: parsed.reportDir,
    outPath: parsed.outPath,
    minCount: parsed.minCount,
    loaded: {
      manualRows: manualRows.length,
      positiveRows: positiveRows.length,
      negativeRows: negativeRows.length
    },
    promoted: {
      rewriteRules: rewriteRules.length,
      blockedExactDrafts: blockedExactDrafts.length
    }
  };

  const summaryPath = path.join(parsed.reportDir, "deterministic_rules_promotion_summary.json");
  try {
    fs.mkdirSync(parsed.reportDir, { recursive: true });
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  } catch {
    // non-fatal when report dir is unavailable
  }

  console.log(JSON.stringify(summary, null, 2));
}

run();
