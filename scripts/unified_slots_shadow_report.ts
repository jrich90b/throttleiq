/**
 * unified_slots_shadow:report — summarizes the merged-parser shadow log
 * (reports/unified_slots_shadow/*.jsonl written by the live API when
 * UNIFIED_SLOTS_MERGED_SHADOW=1).
 *
 * Usage:
 *   npx tsx scripts/unified_slots_shadow_report.ts [--dir <path>] [--since-days N]
 *
 * The cutover bar (consolidation plan): high agreement overall, and NO
 * disagreement class where the merged parser is systematically worse. Field-
 * level counts below are the triage entry point; read samples before judging.
 */
import fs from "node:fs";
import path from "node:path";

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

const dir =
  argValue("--dir") ||
  process.env.UNIFIED_SLOTS_SHADOW_DIR ||
  (process.env.REPORT_ROOT ? path.join(process.env.REPORT_ROOT, "unified_slots_shadow") : "") ||
  "reports/unified_slots_shadow";

const sinceDays = Number(argValue("--since-days") ?? 0);
const sinceMs = sinceDays > 0 ? Date.now() - sinceDays * 86_400_000 : 0;

if (!fs.existsSync(dir)) {
  console.log(`No shadow log directory at ${dir} — nothing recorded yet.`);
  process.exit(0);
}

type Record_ = {
  at?: string;
  outcome?: string;
  elapsedMs?: number;
  diffs?: Array<{ field: string; legacy: unknown; merged: unknown }>;
  textPreview?: string;
};

const records: Record_[] = [];
for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")).sort()) {
  for (const line of fs.readFileSync(path.join(dir, file), "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as Record_;
      if (sinceMs && Date.parse(String(rec.at ?? "")) < sinceMs) continue;
      records.push(rec);
    } catch {
      // skip malformed line
    }
  }
}

if (!records.length) {
  console.log(`Shadow log at ${dir} has no records${sinceDays ? ` in the last ${sinceDays}d` : ""}.`);
  process.exit(0);
}

const agree = records.filter(r => r.outcome === "agree").length;
const disagree = records.filter(r => r.outcome === "disagree").length;
const mergedNull = records.filter(r => r.outcome === "merged_null").length;
const compared = agree + disagree;
const elapsed = records.map(r => Number(r.elapsedMs)).filter(n => Number.isFinite(n) && n > 0);
const avgMs = elapsed.length ? Math.round(elapsed.reduce((a, b) => a + b, 0) / elapsed.length) : 0;

const fieldCounts = new Map<string, number>();
for (const rec of records) {
  for (const d of rec.diffs ?? []) {
    fieldCounts.set(d.field, (fieldCounts.get(d.field) ?? 0) + 1);
  }
}

console.log(`# Unified-slots merged-parser shadow report`);
console.log(`Source: ${dir}${sinceDays ? ` (last ${sinceDays}d)` : ""}`);
console.log(`Records: ${records.length} (compared ${compared}, merged_null ${mergedNull})`);
if (compared) {
  console.log(`Agreement: ${agree}/${compared} (${((agree / compared) * 100).toFixed(1)}%)`);
}
console.log(`Avg merged-parser latency: ${avgMs}ms`);
console.log("");
if (fieldCounts.size) {
  console.log("Disagreements by field:");
  for (const [field, count] of [...fieldCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${field}`);
  }
  console.log("");
  console.log("Sample disagreements (up to 10):");
  for (const rec of records.filter(r => r.outcome === "disagree").slice(0, 10)) {
    console.log(`- ${rec.at} "${rec.textPreview ?? ""}"`);
    for (const d of rec.diffs ?? []) {
      console.log(`    ${d.field}: legacy=${JSON.stringify(d.legacy)} merged=${JSON.stringify(d.merged)}`);
    }
  }
} else {
  console.log("No field disagreements recorded.");
}
