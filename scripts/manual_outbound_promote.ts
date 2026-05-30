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

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (input: any): any => {
    if (input == null) return input;
    if (Array.isArray(input)) return input.map(normalize);
    if (typeof input !== "object") return input;
    if (seen.has(input)) return "[Circular]";
    seen.add(input);
    const out: Record<string, any> = {};
    for (const key of Object.keys(input).sort()) out[key] = normalize(input[key]);
    return out;
  };
  return JSON.stringify(normalize(value));
}

function normText(input: unknown): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeManualReplyExampleReply(input: string): string {
  // Manual reply exemplars are used as tone references. They should not contain absolute calendar dates
  // (which go stale and can leak into future drafts). Keep weekday + time, but strip month/day/year
  // when a weekday is present (e.g. "Wed, Feb 25, 3:30 PM" -> "Wed, 3:30 PM").
  const months =
    "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
  const weekdays =
    "(?:Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:s(?:day)?)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)";

  let text = normText(input);
  const weekdayMonthDay = new RegExp(
    `\\b(${weekdays})\\b\\s*,?\\s*\\b${months}\\b\\s+\\d{1,2}(?:st|nd|rd|th)?(?:\\s*,?\\s*\\d{4})?\\s*,?\\s*`,
    "gi"
  );
  text = text.replace(weekdayMonthDay, (_match, weekday: string) => `${weekday}, `);
  return normText(text);
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
    const reply = sanitizeManualReplyExampleReply(normText(row.preferredDraft));
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

  const outCore = {
    version: 1,
    minCount: parsed.minCount,
    maxPerIntent: parsed.maxPerIntent,
    byIntent
  };

  let wroteOutFile = false;
  let existingUpdatedAt: string | null = null;
  try {
    if (fs.existsSync(parsed.outPath)) {
      const existing = JSON.parse(fs.readFileSync(parsed.outPath, "utf8"));
      existingUpdatedAt = typeof existing?.updatedAt === "string" ? existing.updatedAt : null;
      const existingCore = {
        version: Number(existing?.version) || 1,
        minCount: Number(existing?.minCount) || parsed.minCount,
        maxPerIntent: Number(existing?.maxPerIntent) || parsed.maxPerIntent,
        byIntent: existing?.byIntent && typeof existing.byIntent === "object" ? existing.byIntent : {}
      };
      if (stableStringify(existingCore) === stableStringify(outCore)) {
        wroteOutFile = false;
      } else {
        const out: ManualReplyExamplesFile = {
          ...(outCore as Omit<ManualReplyExamplesFile, "updatedAt" | "sourceDir">),
          updatedAt: nowIso,
          sourceDir: parsed.reportDir
        };
        fs.mkdirSync(path.dirname(parsed.outPath), { recursive: true });
        fs.writeFileSync(parsed.outPath, JSON.stringify(out, null, 2) + "\n");
        wroteOutFile = true;
      }
    } else {
      const out: ManualReplyExamplesFile = {
        ...(outCore as Omit<ManualReplyExamplesFile, "updatedAt" | "sourceDir">),
        updatedAt: nowIso,
        sourceDir: parsed.reportDir
      };
      fs.mkdirSync(path.dirname(parsed.outPath), { recursive: true });
      fs.writeFileSync(parsed.outPath, JSON.stringify(out, null, 2) + "\n");
      wroteOutFile = true;
    }
  } catch {
    // Best-effort: only write if we couldn't read/compare.
    const out: ManualReplyExamplesFile = {
      ...(outCore as Omit<ManualReplyExamplesFile, "updatedAt" | "sourceDir">),
      updatedAt: nowIso,
      sourceDir: parsed.reportDir
    };
    fs.mkdirSync(path.dirname(parsed.outPath), { recursive: true });
    fs.writeFileSync(parsed.outPath, JSON.stringify(out, null, 2) + "\n");
    wroteOutFile = true;
  }

  const promotedByIntent = Object.fromEntries(
    Object.entries(byIntent).map(([intent, examples]) => [intent, examples.length])
  );
  const promotedExamples = Object.values(promotedByIntent).reduce((sum, n) => sum + Number(n || 0), 0);

  const summary = {
    ok: true,
    seedPath,
    outPath: parsed.outPath,
    minCount: parsed.minCount,
    maxPerIntent: parsed.maxPerIntent,
    loadedRows: rows.length,
    wroteOutFile,
    existingUpdatedAt,
    promotedExamples,
    promotedByIntent
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
