/**
 * Comprehension gap report (2026-07-31, Joe-approved).
 *
 * Turns the raw gap log into the thing that actually answers a question: a RANKED list of the
 * customer language the agent knows it can't read, most frequent first.
 *
 * The point is to replace guessing. "Should 'next spring' get a parser?" is unanswerable from one
 * anecdote; it is obvious from "seen 40 times across 31 leads this month" or "seen twice since
 * March". This report is the input to the parser-coverage audit, where a phrase that earns its
 * place becomes an EVAL ROW first and a prompt example only if that row fails (Joe, 2026-07-29).
 *
 * Read-only. Reads REPORT_ROOT/comprehension_gaps/*.jsonl and writes latest.json + latest.md
 * beside them. Never touches conversations, tasks, or anything customer-facing.
 *
 * Usage: REPORT_ROOT=... npx tsx scripts/comprehension_gap_report.ts [--days 30]
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  groupComprehensionGaps,
  type ComprehensionGapRecord
} from "../services/api/src/domain/comprehensionGapLog.ts";

export function readGapRecords(dir: string, sinceIso: string): ComprehensionGapRecord[] {
  if (!fs.existsSync(dir)) return [];
  const out: ComprehensionGapRecord[] = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.startsWith("comprehension_gaps_") || !file.endsWith(".jsonl")) continue;
    let raw = "";
    try {
      raw = fs.readFileSync(path.join(dir, file), "utf8");
    } catch {
      continue; // an unreadable day is missing evidence, never a crash
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as ComprehensionGapRecord;
        if (String(rec?.at ?? "") >= sinceIso) out.push(rec);
      } catch {
        // a torn final line (append crashed mid-write) is one lost record, not a failed report
      }
    }
  }
  return out;
}

export function renderGapMarkdown(
  groups: ReturnType<typeof groupComprehensionGaps>,
  opts: { days: number; total: number }
): string {
  const lines: string[] = [];
  lines.push(`# What the agent couldn't read — last ${opts.days} days`);
  lines.push("");
  if (!groups.length) {
    lines.push(`No recorded comprehension gaps. Either nothing was unreadable, or nothing is wired`);
    lines.push(`to record one yet — check which sites call recordComprehensionGap before concluding`);
    lines.push(`the agent understands everything.`);
    return `${lines.join("\n")}\n`;
  }
  lines.push(`${opts.total} occurrence(s) across ${groups.length} distinct phrasing(s).`);
  lines.push("");
  lines.push("| # | site | phrase | seen | leads | last |");
  lines.push("|---|------|--------|------|-------|------|");
  groups.forEach((g, i) => {
    const phrase = g.phrase.replace(/\|/g, "\\|").slice(0, 70);
    lines.push(
      `| ${i + 1} | ${g.site} | ${phrase} | ${g.count} | ${g.convIds.length} | ${g.lastSeenAt.slice(0, 10)} |`
    );
  });
  lines.push("");
  lines.push("Next step for anything near the top: add it as an EVAL ROW first. A prompt example");
  lines.push("only earns its place once that row actually fails (Joe, 2026-07-29).");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const reportRoot = String(process.env.REPORT_ROOT ?? "").trim();
  if (!reportRoot) {
    console.error("comprehension_gap_report needs REPORT_ROOT.");
    process.exit(2);
  }
  const argv = process.argv.slice(2);
  const daysIdx = argv.indexOf("--days");
  const days = Math.max(1, Number(daysIdx >= 0 ? argv[daysIdx + 1] : 30) || 30);
  const dir = path.join(reportRoot, "comprehension_gaps");
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const records = readGapRecords(dir, sinceIso);
  const groups = groupComprehensionGaps(records);
  const payload = {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    totalOccurrences: records.length,
    distinctPhrases: groups.length,
    groups
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "latest.json"), `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "latest.md"), renderGapMarkdown(groups, { days, total: records.length }));
  console.log(
    `[comprehension-gaps] ${records.length} occurrence(s), ${groups.length} distinct phrasing(s) over ${days}d`
  );
  for (const g of groups.slice(0, 10)) {
    console.log(`   ${String(g.count).padStart(4)}x  [${g.site}] "${g.phrase.slice(0, 60)}"`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main();
}
