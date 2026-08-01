/**
 * Agent correction rate — how often staff have to CORRECT the agent.
 *
 * Joe, 2026-08-01: "track how often the user needs to change a reply when it's not a true turn
 * over — to see how often the user has to correct the agent."
 *
 * The qualifier is the point. A raw edit count is a misleading number and we have been burned by
 * reading it as one before ([[staff-draft-edit-corpus]]). Three things that are NOT the agent
 * being wrong get subtracted here — a thread already handed to a person, a rep supplying knowledge
 * the agent had no access to, and pure rewording — and the report never folds what it could not
 * classify into either side. Bucketing lives in services/api/src/domain/agentCorrectionRate.ts.
 *
 * Run:
 *   CONVERSATIONS_DB_PATH=... npx tsx scripts/agent_correction_rate_report.ts [--days 90]
 * Writes reports/agent_correction_rate/latest.json + latest.md when REPORT_ROOT is set.
 */
import fs from "node:fs";
import path from "node:path";
import {
  bucketDraftEdit,
  classifiedCoverage,
  summarizeCorrectionBuckets,
  type CorrectionBucket
} from "../services/api/src/domain/agentCorrectionRate.ts";

const REAL_OUTBOUND = new Set(["twilio", "sendgrid", "sendgrid_email", "email"]);

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]) : fallback;
}

const days = Math.max(1, Number(arg("days", "90")) || 90);
const dbPath =
  process.env.CONVERSATIONS_DB_PATH || path.resolve("services/api/data/conversations.json");

if (!fs.existsSync(dbPath)) {
  console.error(`agent_correction_rate: conversations store not found at ${dbPath}`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(dbPath, "utf8"));
const convs: any[] = Array.isArray(raw) ? raw : (raw?.conversations ?? []);
const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

/**
 * `--backfill N` judges up to N historical edits that carry no verdict, IN MEMORY ONLY.
 *
 * The provenance stamp starts accruing at deploy, so without this the first honest number is weeks
 * away. Backfilling reads the same judge the live path uses and reports what it finds — it never
 * writes to the conversations store. That is deliberate: this report is run by an unattended
 * routine, and a script that mutates production data to improve its own metric is exactly the kind
 * of thing that should not exist. The stamps accrue naturally from live sends.
 */
const backfillLimit = Math.max(0, Number(arg("backfill", "0")) || 0);

const buckets: CorrectionBucket[] = [];
const byCategory = new Map<string, number>();
const examples: { conv: string; at: string; bucket: string; reason: string }[] = [];
/** Draft-sourced sends the rep did NOT change — the other half of the denominator. */
let uneditedDraftSends = 0;
/** Draft-sourced sends with no provenance stamp (pre-2026-08-01 history). */
let unstamped = 0;

/** Edits with no verdict, collected so `--backfill` can judge them before bucketing. */
const pendingJudge: { conv: any; message: any }[] = [];

for (const conv of convs) {
  const followUp = conv?.followUp ?? {};
  for (const message of conv?.messages ?? []) {
    if (message?.direction !== "out") continue;
    if (!REAL_OUTBOUND.has(String(message?.provider ?? ""))) continue;
    const atMs = Date.parse(String(message?.at ?? ""));
    if (!Number.isFinite(atMs) || atMs < cutoffMs) continue;

    const wasEdited = !!String(message?.originalDraftBody ?? "").trim();
    if (!wasEdited) {
      // Only a STAMPED unedited send is provably a draft the rep accepted. Everything else is
      // indistinguishable from a rep typing from scratch, and guessing would invent a denominator.
      if (message?.draftUsed === true) uneditedDraftSends += 1;
      continue;
    }
    if (message?.draftUsed !== true) unstamped += 1;
    if (!message?.draftEditVerdict) pendingJudge.push({ conv, message });
  }
}

// --- optional in-memory backfill, before any bucketing ---
let backfilled = 0;
if (backfillLimit > 0 && pendingJudge.length) {
  const { classifyDraftEditWithLLM } = await import("../services/api/src/domain/llmDraft.ts");
  const todo = pendingJudge.slice(0, backfillLimit);
  console.error(`backfilling ${todo.length} of ${pendingJudge.length} unjudged edit(s)…`);
  for (const [i, { conv, message }] of todo.entries()) {
    const history = (conv?.messages ?? [])
      .filter((m: any) => m?.body)
      .slice(-8)
      .map((m: any) => ({ direction: m.direction, body: String(m.body) }));
    const lastInbound = [...(conv?.messages ?? [])].reverse().find((m: any) => m?.direction === "in");
    try {
      const verdict = await classifyDraftEditWithLLM({
        generated: String(message.originalDraftBody ?? ""),
        sent: String(message.body ?? ""),
        inbound: String(lastInbound?.body ?? ""),
        history,
        anchor: {
          modelOfRecord: conv?.lead?.vehicle?.model ?? conv?.lead?.vehicle?.description ?? null,
          leadType: [conv?.classification?.bucket, conv?.classification?.cta].filter(Boolean).join("/") || null,
          dialogState: conv?.dialogState?.name ?? null
        },
        channel: String(message.provider ?? "").startsWith("twilio") ? "sms" : "email"
      });
      if (verdict) {
        // In memory only — this object is never written back to the store.
        message.draftEditVerdict = {
          isMaterial: verdict.isMaterial,
          agentCouldHaveKnown: verdict.agentCouldHaveKnown !== false,
          category: verdict.category ?? null,
          confidence: verdict.confidence ?? null
        };
        backfilled += 1;
      }
    } catch {
      // A judge failure leaves the edit unclassified — which the report shows. Never guess.
    }
    if ((i + 1) % 25 === 0) console.error(`  …${i + 1}/${todo.length}`);
  }
}

for (const conv of convs) {
  const followUp = conv?.followUp ?? {};
  for (const message of conv?.messages ?? []) {
    if (message?.direction !== "out") continue;
    if (!REAL_OUTBOUND.has(String(message?.provider ?? ""))) continue;
    const atMs = Date.parse(String(message?.at ?? ""));
    if (!Number.isFinite(atMs) || atMs < cutoffMs) continue;
    if (!String(message?.originalDraftBody ?? "").trim()) continue;

    const verdict = message?.draftEditVerdict ?? null;
    const bucketing = bucketDraftEdit({
      sentAt: String(message?.at ?? ""),
      followUpMode: followUp?.mode ?? null,
      followUpModeUpdatedAt: followUp?.updatedAt ?? null,
      judge: verdict
        ? {
            isMaterial: verdict.isMaterial,
            agentCouldHaveKnown: verdict.agentCouldHaveKnown,
            category: verdict.category ?? null,
            confidence: verdict.confidence ?? null
          }
        : null
    });
    buckets.push(bucketing.bucket);
    if (bucketing.bucket === "correction") {
      const key = String(verdict?.category ?? "uncategorized");
      byCategory.set(key, (byCategory.get(key) ?? 0) + 1);
    }
    if (examples.length < 20) {
      examples.push({
        conv: String(conv?.id ?? ""),
        at: String(message?.at ?? ""),
        bucket: bucketing.bucket,
        reason: bucketing.reason
      });
    }
  }
}

const totals = summarizeCorrectionBuckets(buckets);
const coverage = classifiedCoverage(totals);
const pct = (n: number | null) => (n === null ? "not yet measured" : `${(n * 100).toFixed(1)}%`);

// Share of ALL draft-sourced sends that needed a real correction. Only computable over the
// STAMPED population, which starts accruing at deploy — stated, never extrapolated.
const stampedDenominator = uneditedDraftSends + (totals.edits - unstamped);
const ofAllDrafts =
  stampedDenominator > 0 && totals.corrections + uneditedDraftSends > 0
    ? totals.corrections / stampedDenominator
    : null;

const report = {
  generatedAt: new Date().toISOString(),
  windowDays: days,
  totals,
  correctionRateOfClassifiedEdits: totals.correctionRate,
  classifiedCoverage: coverage,
  uneditedDraftSends,
  unstampedEdits: unstamped,
  correctionRateOfAllDraftSends: ofAllDrafts,
  correctionsByCategory: Object.fromEntries([...byCategory.entries()].sort((a, b) => b[1] - a[1])),
  examples
};

const lines: string[] = [];
lines.push(`# Agent correction rate — last ${days} days`);
lines.push("");
lines.push(
  `**Of the edits we could classify, ${pct(totals.correctionRate)} were real corrections.** ` +
    `Coverage: ${pct(coverage)} of non-turnover edits carry a judge verdict.`
);
lines.push("");
lines.push("| Bucket | Count | What it means |");
lines.push("| --- | --- | --- |");
lines.push(`| Correction | ${totals.corrections} | the agent had what it needed and got it wrong |`);
lines.push(`| Out-of-band | ${totals.outOfBand} | the rep knew something the agent could not |`);
lines.push(`| Cosmetic | ${totals.cosmetic} | wording/length only |`);
lines.push(`| Turnover | ${totals.turnover} | thread was already handed to a person |`);
lines.push(`| Unclassified | ${totals.unclassified} | no judge verdict on record |`);
lines.push(`| **Edits total** | **${totals.edits}** | |`);
lines.push("");
lines.push(
  `Draft-sourced sends the rep left UNCHANGED: ${uneditedDraftSends}. ` +
    `Correction rate across all stamped draft sends: ${pct(ofAllDrafts)}.`
);
if (unstamped > 0) {
  lines.push("");
  lines.push(
    `> ${unstamped} edited draft(s) predate the provenance stamp (shipped 2026-08-01), so the ` +
      "all-draft-sends rate above covers only what has been stamped since. It is not backfilled — " +
      "a guessed denominator would be a made-up rate."
  );
}
if (byCategory.size) {
  lines.push("");
  lines.push("## What the corrections were");
  lines.push("");
  lines.push("| Category | Count |");
  lines.push("| --- | --- |");
  for (const [category, count] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${category} | ${count} |`);
  }
}

const markdown = lines.join("\n") + "\n";
console.log(markdown);

const reportRoot = process.env.REPORT_ROOT;
if (reportRoot) {
  const dir = path.join(reportRoot, "agent_correction_rate");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(dir, "latest.md"), markdown);
  console.log(`wrote ${dir}/latest.json + latest.md`);
}
