/**
 * State-writer contention report — the un-stacking queue.
 *
 * Ranks the pieces of conversation state that the most places write with nobody refereeing them.
 * The daily anomaly review works the top unrefereed field, one per run (see that routine's
 * SKILL.md, STEP 4b). Origin: PR #398, where two of the 68 places that write `followUpCadence`
 * disagreed 37 seconds apart and put a just-declined customer back on the fast chase.
 *
 * Run:
 *   npx tsx scripts/state_writer_contention_report.ts [--min 5] [--top 12]
 * Writes reports/state_contention/latest.json + latest.md when REPORT_ROOT is set.
 */
import fs from "node:fs";
import path from "node:path";
import {
  rankContention,
  unstackingQueue,
  type SourceFile
} from "../services/api/src/domain/stateWriterContention.ts";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const minWrites = arg("min", 5);
const top = arg("top", 12);

const ROOT = path.resolve("services/api/src");
const files: SourceFile[] = [];
function walk(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full);
    } else if (entry.name.endsWith(".ts")) {
      files.push({ path: path.relative(process.cwd(), full), text: fs.readFileSync(full, "utf8") });
    }
  }
}
walk(ROOT);

const ranked = rankContention(files, { minWrites });
const queue = unstackingQueue(ranked);

const lines: string[] = [];
lines.push("# State-writer contention — the un-stacking queue");
lines.push("");
lines.push(
  `Scanned ${files.length} source files. ${ranked.length} field(s) written in ${minWrites}+ places; ` +
    `**${queue.length} carry an unrefereed fight surface** (2+ independent writers, none asking a referee).`
);
lines.push("");
lines.push("A WRITER is an independent place that sets this state (adjacent writes collapse — they run");
lines.push("in sequence and cannot fight). It counts as refereed when a `decide*`/`resolve*` call sits");
lines.push("within 40 lines above it. `decideFinanceDeclinedCadence` (PR #398) is the worked example:");
lines.push("two writers wanted the cadence, so one referee now says which wins and both ask it.");
lines.push("");
lines.push("| Field | Writers | Unrefereed | Files | Raw writes |");
lines.push("| --- | --- | --- | --- | --- |");
for (const field of ranked.slice(0, top)) {
  const flag = field.unrefereedWriters >= 2 ? `**${field.unrefereedWriters}**` : String(field.unrefereedWriters);
  lines.push(
    `| \`${field.field}\` | ${field.writers} | ${flag} | ${field.files.length} | ${field.writes} |`
  );
}

if (queue.length) {
  const next = queue[0];
  lines.push("");
  lines.push(`## Next to un-stack: \`${next.field}\``);
  lines.push("");
  lines.push(
    `${next.unrefereedWriters} of ${next.writers} independent writers decide for themselves, across ` +
      `${next.files.length} file(s); ${next.wholesaleWrites} of ${next.writes} raw writes replace the ` +
      "whole object. Files:"
  );
  lines.push("");
  for (const file of next.files) lines.push(`- ${file}`);
  lines.push("");
  lines.push("The unrefereed writers:");
  lines.push("");
  for (const site of next.unrefereedWriterSites.slice(0, 12)) {
    lines.push(`- \`${site.file}:${site.line}\` — ${site.snippet}`);
  }
}

lines.push("");
lines.push(
  "> This UNDER-reports by design: only recognizable assignment forms are counted, and a field is " +
    "a write counted as refereed only on positive evidence of a nearby decision call. A field listed " +
    "here is genuinely contended; a field absent from it may still be."
);

const markdown = lines.join("\n") + "\n";
console.log(markdown);

const reportRoot = process.env.REPORT_ROOT;
if (reportRoot) {
  const dir = path.join(reportRoot, "state_contention");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "latest.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        scannedFiles: files.length,
        minWrites,
        contendedFields: ranked.length,
        unstackingQueueSize: queue.length,
        nextToUnstack: queue[0]?.field ?? null,
        fields: ranked.map(f => ({
          field: f.field,
          writes: f.writes,
          files: f.files,
          wholesaleWrites: f.wholesaleWrites,
          writers: f.writers,
          unrefereedWriters: f.unrefereedWriters,
          sites: f.unrefereedWriterSites.map(s => `${s.file}:${s.line}`)
        }))
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(dir, "latest.md"), markdown);
  console.log(`wrote ${dir}/latest.json + latest.md`);
}
