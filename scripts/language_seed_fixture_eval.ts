import fs from "node:fs";
import path from "node:path";
import { applyDraftStateInvariants } from "../services/api/src/domain/draftStateInvariants.ts";

type AnyObj = Record<string, any>;

type ParsedArgs = {
  candidatesPath: string;
  outDir: string;
  maxFixtures: number;
};

type FixtureCase = {
  id: string;
  expectedAllow: boolean;
  expectedReason?: string;
  input: {
    inboundText: string;
    draftText: string;
    followUpMode?: string | null;
    followUpReason?: string | null;
    dialogState?: string | null;
    classificationBucket?: string | null;
    classificationCta?: string | null;
    turnFinanceIntent?: boolean | null;
    turnAvailabilityIntent?: boolean | null;
    turnSchedulingIntent?: boolean | null;
    financeContextIntent?: boolean | null;
    shortAckIntent?: boolean | null;
  };
  meta: {
    kind: string;
    severity: string;
    reason: string;
    convId: string;
    leadRef?: string | null;
    leadName?: string | null;
    leadPhone?: string | null;
    inboundAt: string;
    observedAt?: string | null;
  };
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

  const reportRoot = process.env.REPORT_ROOT || path.resolve(process.cwd(), "reports");
  const languageOut = process.env.LANGUAGE_CORPUS_OUT_DIR || path.join(reportRoot, "language_corpus");
  const candidatesPath =
    args.get("--candidates") || process.env.LANGUAGE_CANDIDATES_PATH || path.join(languageOut, "few_shot_candidates.json");
  const outDir = args.get("--out-dir") || process.env.LANGUAGE_FIXTURE_OUT_DIR || languageOut;
  const maxFixturesRaw = Number(args.get("--max-fixtures") || process.env.LANGUAGE_FIXTURE_MAX || "250");
  const maxFixtures = Number.isFinite(maxFixturesRaw) && maxFixturesRaw > 0 ? maxFixturesRaw : 250;

  return { candidatesPath, outDir, maxFixtures };
}

function normText(input: unknown): string {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

function isShortAck(text: string): boolean {
  const t = normText(text).toLowerCase();
  if (!t) return false;
  if (t.length > 60) return false;
  if (/[?]/.test(t)) return false;
  return /^(ok|okay|k|kk|thanks|thank you|thx|ty|sounds good|sounds great|perfect|awesome|cool|great|will do|you bet)[.! ]*$/.test(
    t
  );
}

function hasFinanceSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(apr|rate|rates|monthly|payment|payments|per month|down payment|how much down|put down|money down|cash down|term|months?|financing|finance|credit|application|specials?|deals?|incentives?)\b/.test(
    t
  );
}

function hasAvailabilitySignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(in[-\s]?stock|available|availability|do you have|have any|any .* in[-\s]?stock|still there|still available)\b/.test(
    t
  );
}

function hasSchedulingSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return (
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(t) ||
    /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/.test(t) ||
    /\b(schedule|book|appointment|time works|can i come in)\b/.test(t)
  );
}

function hasFinanceContext(dialogState: string, followUpReason: string): boolean {
  const ds = String(dialogState ?? "").toLowerCase();
  const fr = String(followUpReason ?? "").toLowerCase();
  return (
    ds.startsWith("pricing_") ||
    ds.startsWith("payments_") ||
    /(^|:|\b)(pricing|payments?|finance|financing|credit|approval)\b/.test(fr)
  );
}

const KNOWN_INVARIANT_REASONS = new Set<string>([
  "short_ack_no_action_guard",
  "manual_handoff_inventory_prompt_guard",
  "paused_state_inventory_prompt_guard",
  "finance_priority_inventory_prompt_guard",
  "finance_priority_schedule_prompt_guard",
  "availability_priority_pricing_prompt_guard"
]);

function mapCandidateToFixture(row: AnyObj): FixtureCase | null {
  const kind = String(row?.kind ?? "").trim();
  const inboundText = normText(row?.inboundText);
  const draftText = normText(row?.observedDraft);
  if (!inboundText || !draftText) return null;

  const followUpMode = String(row?.followUpMode ?? "") || null;
  const followUpReason = String(row?.followUpReason ?? "") || null;
  const dialogState = String(row?.dialogState ?? "") || null;
  const classificationBucket = String(row?.classificationBucket ?? "") || null;
  const classificationCta = String(row?.classificationCta ?? "") || null;
  const expectedReasonRaw = String(row?.invariantExpectedReason ?? row?.reason ?? "").trim();
  const expectedReason = KNOWN_INVARIANT_REASONS.has(expectedReasonRaw) ? expectedReasonRaw : undefined;

  let expectedAllow = true;
  if (kind === "invariant_guard_miss") {
    expectedAllow = false;
  } else if (kind === "manual_edit_delta") {
    expectedAllow = true;
  } else {
    return null;
  }

  const turnFinanceIntent = hasFinanceSignal(inboundText);
  const turnAvailabilityIntent = hasAvailabilitySignal(inboundText);
  const turnSchedulingIntent = hasSchedulingSignal(inboundText);
  const financeContextIntent = hasFinanceContext(dialogState ?? "", followUpReason ?? "");
  const shortAckIntent = isShortAck(inboundText);

  return {
    id: String(row?.id ?? `${kind}_${Date.now()}`),
    expectedAllow,
    expectedReason,
    input: {
      inboundText,
      draftText,
      followUpMode,
      followUpReason,
      dialogState,
      classificationBucket,
      classificationCta,
      turnFinanceIntent,
      turnAvailabilityIntent,
      turnSchedulingIntent,
      financeContextIntent,
      shortAckIntent
    },
    meta: {
      kind,
      severity: String(row?.severity ?? "medium"),
      reason: String(row?.reason ?? ""),
      convId: String(row?.convId ?? ""),
      leadRef: row?.leadRef ?? null,
      leadName: row?.leadName ?? null,
      leadPhone: row?.leadPhone ?? null,
      inboundAt: String(row?.inboundAt ?? ""),
      observedAt: String(row?.observedAt ?? "")
    }
  };
}

function run() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(parsed.candidatesPath)) {
    console.error(`few_shot_candidates.json not found: ${parsed.candidatesPath}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(parsed.candidatesPath, "utf8"));
  const rows: AnyObj[] = Array.isArray(raw?.rows) ? raw.rows : Array.isArray(raw) ? raw : [];
  const fixtures: FixtureCase[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const fixture = mapCandidateToFixture(row);
    if (!fixture) continue;
    if (seen.has(fixture.id)) continue;
    seen.add(fixture.id);
    fixtures.push(fixture);
    if (fixtures.length >= parsed.maxFixtures) break;
  }

  const resultRows = fixtures.map(f => {
    const actual = applyDraftStateInvariants(f.input);
    const pass =
      actual.allow === f.expectedAllow &&
      (f.expectedAllow || !f.expectedReason || String(actual.reason ?? "") === String(f.expectedReason ?? ""));
    return {
      id: f.id,
      pass,
      expectedAllow: f.expectedAllow,
      actualAllow: actual.allow,
      expectedReason: f.expectedReason ?? null,
      actualReason: actual.reason ?? null,
      kind: f.meta.kind,
      severity: f.meta.severity,
      convId: f.meta.convId,
      inboundAt: f.meta.inboundAt
    };
  });

  const passing = resultRows.filter(r => r.pass).length;
  const failing = resultRows.length - passing;
  const summary = {
    generatedAt: new Date().toISOString(),
    candidatesPath: parsed.candidatesPath,
    fixtureCount: fixtures.length,
    passing,
    failing
  };

  fs.mkdirSync(parsed.outDir, { recursive: true });
  const fixturesPath = path.join(parsed.outDir, "auto_seed_replay_fixtures.json");
  const resultsPath = path.join(parsed.outDir, "auto_seed_replay_results.json");
  const summaryPath = path.join(parsed.outDir, "auto_seed_replay_summary.json");

  fs.writeFileSync(fixturesPath, JSON.stringify({ count: fixtures.length, fixtures }, null, 2));
  fs.writeFileSync(
    resultsPath,
    JSON.stringify({ generatedAt: summary.generatedAt, total: resultRows.length, passing, failing, rows: resultRows }, null, 2)
  );
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log(
    JSON.stringify(
      {
        ok: true,
        outputs: {
          fixturesPath,
          resultsPath,
          summaryPath
        },
        summary
      },
      null,
      2
    )
  );
}

run();

