/**
 * self-heal win harvester — turn runtime self-corrections into durable learning (APPROVE-FIRST).
 *
 * The draft self-heal loop (selfHealDraftWithLLM) fixes held drafts at runtime but remembers
 * nothing — the same miss class gets re-solved from scratch every occurrence (e.g. 7 of the first
 * 8 live heals were the SAME HTML-email pattern). This miner reads the durable heal-win JSONL the
 * runtime now appends (heal_wins_*.jsonl, full before→after + judge reason) and proposes the wins
 * as few-shot/fixture candidates on the SAME review surface as the gold-example harvester.
 *
 * Discipline (identical to gold_example_harvester): this writes a PROPOSAL only — a human reviews
 * and promotes into data/manual_reply_examples.json and/or a ci:eval replay fixture. It never
 * edits examples, prompts, or evals itself. NOTE the confidence tier: a heal win is JUDGE-blessed,
 * not human-blessed — the judge held the original and passed the rewrite. Verify each pair before
 * promoting; the value is the before→after contrast for the failure class.
 *
 * Usage:
 *   npx tsx scripts/self_heal_harvest.ts --self-test
 *   SELF_HEAL_WINS_DIR=... npx tsx scripts/self_heal_harvest.ts [--limit=100] [--out-dir=DIR]
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

type HealWin = {
  at?: string | null;
  channel?: string | null;
  leadKey?: string | null;
  inbound?: string | null;
  before?: string | null;
  after?: string | null;
  judgeReason?: string | null;
  judgeSteering?: string | null;
};
type Candidate = {
  tier: "self_heal_win";
  at: string | null;
  leadKey: string | null;
  channel: string | null;
  inbound: string;
  before: string;
  reply: string; // the healed draft — the candidate few-shot output
  judgeReason: string | null;
};

function norm(s: string): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Reason class for grouping recurring heal patterns (report readability only). */
export function reasonClass(reason: string | null | undefined): string {
  const r = norm(reason ?? "");
  if (!r) return "(no reason)";
  // First clause, capped — enough to cluster "answers an HTML notice as if it were a question"-style repeats.
  return r.split(/[.;]/)[0].slice(0, 80) || "(no reason)";
}

/** All reply-like strings already captured as examples, for dedup (same walk as gold harvester). */
function existingReplyKeys(manualExamplesPath: string): Set<string> {
  const keys = new Set<string>();
  try {
    const raw = JSON.parse(fs.readFileSync(manualExamplesPath, "utf8"));
    const walk = (v: any) => {
      if (typeof v === "string") { if (v.trim().length > 12) keys.add(norm(v)); }
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(raw);
  } catch { /* none */ }
  return keys;
}

export function parseHealWinLines(lines: string[]): HealWin[] {
  const out: HealWin[] = [];
  for (const line of lines) {
    const t = String(line ?? "").trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t);
      if (r && typeof r === "object") out.push(r as HealWin);
    } catch { /* skip malformed line */ }
  }
  return out;
}

export function harvestHealWins(
  wins: HealWin[],
  opts: { limit: number; manualExamplesPath: string }
): Candidate[] {
  const seen = existingReplyKeys(opts.manualExamplesPath);
  const out: Candidate[] = [];
  for (const w of wins) {
    const inbound = String(w?.inbound ?? "").trim();
    const before = String(w?.before ?? "").trim();
    const after = String(w?.after ?? "").trim();
    // A usable candidate needs the full triple; a win whose "fix" is a no-op is noise.
    if (!inbound || !after || !before || norm(after) === norm(before)) continue;
    const key = norm(after);
    if (seen.has(key)) continue; // dedup vs existing examples + earlier candidates
    seen.add(key);
    out.push({
      tier: "self_heal_win",
      at: w?.at ?? null,
      leadKey: w?.leadKey ?? null,
      channel: w?.channel ?? null,
      inbound: inbound.slice(0, 400),
      before: before.slice(0, 400),
      reply: after.slice(0, 400),
      judgeReason: w?.judgeReason ? String(w.judgeReason) : null
    });
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at))); // most recent first
  return out.slice(0, opts.limit);
}

// ─────────────────────────────────────────────────────────────────────────────
function selfTest(): void {
  const tmpExamples = path.join(process.env.TMPDIR || "/tmp", `heal_dedup_${process.pid}.json`);
  fs.writeFileSync(tmpExamples, JSON.stringify({ version: 1, examples: ["An already promoted healed reply"] }));

  const wins = parseHealWinLines([
    JSON.stringify({ at: "2026-07-05T00:00:00Z", channel: "sms", leadKey: "+1", inbound: "<html><body>notice</body></html>", before: "What used bike are you looking for?", after: "Looks like your message came through as HTML — want to resend?", judgeReason: "answers an HTML notice as if it were a bike question" }),
    // duplicate "after" vs existing examples → deduped out
    JSON.stringify({ at: "2026-07-05T01:00:00Z", channel: "sms", leadKey: "+2", inbound: "price?", before: "old", after: "An already promoted healed reply", judgeReason: "x" }),
    // no-op heal (before == after modulo whitespace) → dropped
    JSON.stringify({ at: "2026-07-05T02:00:00Z", channel: "sms", leadKey: "+3", inbound: "hi", before: "Same text.", after: "  Same   text. ", judgeReason: "y" }),
    "not json {{{",
    ""
  ]);
  assert.equal(wins.length, 3, "malformed/empty lines must be skipped, valid ones kept");

  const cands = harvestHealWins(wins, { limit: 50, manualExamplesPath: tmpExamples });
  fs.unlinkSync(tmpExamples);
  assert.equal(cands.length, 1, "dedup + no-op filtering must leave exactly the real win");
  assert.equal(cands[0].tier, "self_heal_win");
  assert.equal(cands[0].leadKey, "+1");
  assert.match(cands[0].reply, /^Looks like your message came through as HTML/);
  assert.equal(cands[0].before, "What used bike are you looking for?");

  // reason clustering: same first clause groups; distinct reasons don't.
  assert.equal(reasonClass("answers an HTML notice as if it were a question. Also X."), reasonClass("Answers an HTML notice as if it were a question; wrong tone"));
  assert.notEqual(reasonClass("fabricated a price"), reasonClass("answers an HTML notice as if it were a question"));
  assert.equal(reasonClass(null), "(no reason)");

  console.log("self_heal_harvest self-test passed");
}

// ─────────────────────────────────────────────────────────────────────────────
function runBatch(): void {
  const arg = (k: string, d: string) => (process.argv.find(a => a.startsWith(`${k}=`))?.split("=")[1] ?? d);
  const limit = Number(arg("--limit", "100"));
  const winsDir =
    process.env.SELF_HEAL_WINS_DIR ||
    (process.env.REPORT_ROOT ? path.join(process.env.REPORT_ROOT, "draft_self_heal") : "reports/draft_self_heal");
  const dataDir = process.env.DATA_DIR || "data";
  const manualExamplesPath = process.env.MANUAL_REPLY_EXAMPLES_PATH || path.join(dataDir, "manual_reply_examples.json");
  // Same review surface as the gold-example harvester — one place for the human to look.
  const outDir = arg("--out-dir", process.env.REPORT_ROOT ? path.join(process.env.REPORT_ROOT, "gold_examples") : "reports/gold_examples");

  let files: string[] = [];
  try {
    files = fs.readdirSync(winsDir).filter(f => /^heal_wins_\d{8}\.jsonl$/.test(f)).sort();
  } catch { /* no dir yet — zero wins is a valid state */ }
  const lines = files.flatMap(f => fs.readFileSync(path.join(winsDir, f), "utf8").split("\n"));
  const wins = parseHealWinLines(lines);
  const candidates = harvestHealWins(wins, { limit, manualExamplesPath });

  const byReason = candidates.reduce<Record<string, number>>((a, c) => {
    const k = reasonClass(c.judgeReason);
    a[k] = (a[k] ?? 0) + 1;
    return a;
  }, {});

  fs.mkdirSync(outDir, { recursive: true });
  const summary = { generatedAt: new Date().toISOString(), winsDir, filesRead: files.length, winsRecorded: wins.length, candidates: candidates.length, byReason };
  fs.writeFileSync(path.join(outDir, "self_heal_win_summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, "self_heal_win_candidates.json"), JSON.stringify(candidates, null, 2));
  const md = [
    `# Self-heal wins — judge-confirmed fixes to promote (APPROVE-FIRST; nothing auto-applied)`,
    ``,
    `Generated ${summary.generatedAt} — ${candidates.length} candidate(s) from ${wins.length} recorded win(s).`,
    `A recurring reason class = a miss the system keeps re-solving at runtime → the strongest promote signal.`,
    `Review each pair (judge-blessed, NOT human-blessed), then promote into data/manual_reply_examples.json`,
    `(few-shot) and/or a ci:eval replay fixture. Reason classes: ${JSON.stringify(byReason)}.`,
    ``,
    ...candidates.slice(0, 60).map(c =>
      `- [${c.channel ?? "?"}${c.at ? ` · ${c.at}` : ""}] ${c.leadKey ?? "?"} — ${reasonClass(c.judgeReason)}\n  IN:     ${c.inbound}\n  BEFORE: ${c.before}\n  AFTER:  ${c.reply}`
    )
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "self_heal_win_report.md"), md);
  console.log(`self_heal_harvest: ${candidates.length} candidate(s) from ${wins.length} win(s) ${JSON.stringify(byReason)} -> ${outDir}`);
}

if (process.argv.includes("--self-test")) selfTest();
else runBatch();
