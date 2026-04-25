import fs from "node:fs";
import path from "node:path";

type ManualSeedRow = {
  id?: string;
  intentHint?: string;
  inboundText?: string;
  preferredDraft?: string;
  observedAt?: string;
  convId?: string;
  leadRef?: string | null;
};

type ManualReplyExample = {
  inboundText: string;
  reply: string;
  count: number;
  observedAt?: string;
};

type ManualReplyExamplesFile = {
  version: number;
  updatedAt: string;
  sourceDir: string;
  minCount: number;
  maxPerIntent: number;
  byIntent: Record<string, ManualReplyExample[]>;
};

type ParsedArgs = {
  reportDir: string;
  outPath: string;
  minCount: number;
  maxPerIntent: number;
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
    process.env.MANUAL_REPLY_EXAMPLES_PATH ||
    path.resolve(dataDir, "manual_reply_examples.json");
  const minCountRaw = Number(args.get("--min-count") || process.env.MANUAL_REPLY_PROMOTE_MIN_COUNT || "1");
  const maxPerIntentRaw = Number(
    args.get("--max-per-intent") || process.env.MANUAL_REPLY_PROMOTE_MAX_PER_INTENT || "6"
  );
  const minCount = Number.isFinite(minCountRaw) && minCountRaw > 0 ? minCountRaw : 1;
  const maxPerIntent = Number.isFinite(maxPerIntentRaw) && maxPerIntentRaw > 0 ? maxPerIntentRaw : 6;
  return { reportDir, outPath, minCount, maxPerIntent };
}

function readRows(filePath: string): ManualSeedRow[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (Array.isArray(parsed)) return parsed as ManualSeedRow[];
    if (Array.isArray(parsed?.rows)) return parsed.rows as ManualSeedRow[];
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

function normalizeIntentHint(input: unknown): string {
  const text = normKey(input);
  if (text === "pricing_payments") return "pricing_payments";
  if (text === "availability") return "availability";
  if (text === "scheduling") return "scheduling";
  if (text === "callback") return "callback";
  return "general";
}

function run() {
  const parsed = parseArgs(process.argv.slice(2));
  const nowIso = new Date().toISOString();
  const seedPath = path.join(parsed.reportDir, "few_shot_seed_manual_outbound.json");
  const rows = readRows(seedPath);

  const buckets = new Map<string, Map<string, { inboundText: string; reply: string; count: number; observedAt?: string }>>();
  for (const row of rows) {
    const inboundText = normText(row.inboundText);
    const reply = normText(row.preferredDraft);
    if (!inboundText || !reply) continue;
    if (reply.length < 10) continue;
    if (reply.length > 500) continue;

    const intentHint = normalizeIntentHint(row.intentHint);
    const key = `${normKey(inboundText)}=>${normKey(reply)}`;
    const bucket = buckets.get(intentHint) ?? new Map<string, { inboundText: string; reply: string; count: number; observedAt?: string }>();
    const entry = bucket.get(key) ?? {
      inboundText,
      reply,
      count: 0,
      observedAt: undefined
    };
    entry.count += 1;
    const observedAt = normText(row.observedAt);
    if (observedAt && (!entry.observedAt || Date.parse(observedAt) > Date.parse(entry.observedAt))) {
      entry.observedAt = observedAt;
    }
    bucket.set(key, entry);
    buckets.set(intentHint, bucket);
  }

  const byIntent: Record<string, ManualReplyExample[]> = {};
  for (const [intentHint, bucket] of buckets.entries()) {
    const promoted = [...bucket.values()]
      .filter(entry => entry.count >= parsed.minCount)
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return Date.parse(b.observedAt ?? "") - Date.parse(a.observedAt ?? "");
      })
      .slice(0, parsed.maxPerIntent)
      .map(entry => ({
        inboundText: entry.inboundText,
        reply: entry.reply,
        count: entry.count,
        observedAt: entry.observedAt
      }));
    byIntent[intentHint] = promoted;
  }

  const out: ManualReplyExamplesFile = {
    version: 1,
    updatedAt: nowIso,
    sourceDir: parsed.reportDir,
    minCount: parsed.minCount,
    maxPerIntent: parsed.maxPerIntent,
    byIntent
  };

  fs.mkdirSync(path.dirname(parsed.outPath), { recursive: true });
  fs.writeFileSync(parsed.outPath, JSON.stringify(out, null, 2) + "\n");

  const summary = {
    ok: true,
    seedPath,
    outPath: parsed.outPath,
    minCount: parsed.minCount,
    maxPerIntent: parsed.maxPerIntent,
    loadedRows: rows.length,
    promotedByIntent: Object.fromEntries(
      Object.entries(byIntent).map(([intent, examples]) => [intent, examples.length])
    )
  };
  const summaryPath = path.join(parsed.reportDir, "manual_outbound_promotion_summary.json");
  try {
    fs.mkdirSync(parsed.reportDir, { recursive: true });
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  } catch {
    // non-fatal when report dir is unavailable
  }
  console.log(JSON.stringify(summary, null, 2));
}

run();
