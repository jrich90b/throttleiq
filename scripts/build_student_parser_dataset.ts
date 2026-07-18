/**
 * build_student_parser_dataset.ts — Stage 1 of the student-parser distillation pilot.
 *
 * Turns the parser-capture flywheel JSONL (the teacher's real input->output pairs) into an
 * OpenAI fine-tuning training set for ONE parser schema, with a deterministic held-out eval
 * slice so a training example can never leak into the test set.
 *
 * INPUT (PII — customer messages): daily parser_capture_*.jsonl from the box. Pull a copy to a
 * scratch dir, run this, then DELETE the copy and the emitted JSONL (they contain customer text).
 * This script SENDS NOTHING anywhere — pure local transform.
 *
 * Usage:
 *   npx tsx scripts/build_student_parser_dataset.ts \
 *     --in <dir-of-parser_capture_*.jsonl> \
 *     --schema inventory_entity_parser \
 *     --out <out-dir> \
 *     [--variant full|slim]        (default full = train on the exact captured prompt)
 *     [--eval-fraction 0.2]
 *
 * Emits <out>/train.jsonl, <out>/eval.jsonl (OpenAI chat fine-tuning format) + prints a
 * dataset scorecard (uniques, split sizes, target_type balance, model-resolution coverage).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const inDir = arg("in");
const schemaName = arg("schema", "inventory_entity_parser")!;
const outDir = arg("out");
const variant = (arg("variant", "full") as "full" | "slim");
const evalFraction = Number(arg("eval-fraction", "0.2"));
// When set, downsample the over-represented "none" (no-inventory-target) class in the TRAIN split
// to ~1:1 with the real-entity examples, so the student doesn't over-learn "none" and stays sharp
// on the model-resolution cases. The EVAL split is left untouched so it still reflects real traffic.
const balance = process.argv.includes("--balance");

if (!inDir || !outDir) {
  console.error("usage: --in <dir> --out <dir> [--schema inventory_entity_parser] [--variant full|slim] [--eval-fraction 0.2]");
  process.exit(2);
}

// Deterministic train/eval split by content hash — matches goldCorpusHarvest.splitFor semantics
// so the split is stable across runs and never depends on ordering.
function splitFor(key: string): "train" | "eval" {
  const h = parseInt(crypto.createHash("sha1").update(key).digest("hex").slice(0, 8), 16) / 0xffffffff;
  return h < evalFraction ? "eval" : "train";
}

// The captured prompt embeds the 15 few-shot "Voice-style examples:" block. A fine-tuned student
// internalizes those, so the SLIM variant strips them (the real cost/latency win). FULL keeps the
// exact prompt the teacher saw — the cleanest apples-to-apples baseline and a pure env-var cutover
// (no serving-code change). We keep the instructions + known-lead + recent-history + Message.
function toSlimPrompt(fullPrompt: string): string {
  const startIdx = fullPrompt.indexOf("Voice-style examples:");
  const msgIdx = fullPrompt.indexOf("\nMessage:");
  if (startIdx < 0 || msgIdx < 0 || msgIdx < startIdx) return fullPrompt;
  return fullPrompt.slice(0, startIdx).trimEnd() + fullPrompt.slice(msgIdx);
}

const files = fs
  .readdirSync(inDir)
  .filter(f => /parser_capture_.*\.jsonl$/.test(f))
  .map(f => path.join(inDir, f));
if (!files.length) {
  console.error(`no parser_capture_*.jsonl found in ${inDir}`);
  process.exit(1);
}

type Row = { prompt: string; output: string; targetType: string; hasModel: boolean };
const seen = new Set<string>();
const rows: Row[] = [];
let rawForSchema = 0;
let droppedTruncated = 0;
let droppedBadJson = 0;

for (const file of files) {
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.schemaName !== schemaName) continue;
    rawForSchema++;
    if (rec.promptTruncated || rec.outputTruncated) {
      droppedTruncated++;
      continue;
    }
    const prompt = String(rec.prompt ?? "");
    const output = String(rec.output ?? "");
    if (!prompt || !output) continue;
    let parsedOut: any;
    try {
      parsedOut = JSON.parse(output);
    } catch {
      droppedBadJson++;
      continue;
    }
    const key = crypto.createHash("md5").update(prompt.slice(0, 6000) + "||" + output).digest("hex");
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      prompt,
      output,
      targetType: String(parsedOut.target_type ?? parsedOut.intent ?? "?"),
      hasModel: !!String(parsedOut.model ?? "").trim()
    });
  }
}

fs.mkdirSync(outDir, { recursive: true });
const targetBalance: Record<string, number> = {};
let modelResolutionCount = 0;

function toExampleLine(r: Row): string {
  const userContent = variant === "slim" ? toSlimPrompt(r.prompt) : r.prompt;
  return JSON.stringify({
    messages: [
      { role: "system", content: "You extract structured motorcycle shopping entities as strict JSON." },
      { role: "user", content: userContent },
      { role: "assistant", content: r.output }
    ]
  });
}

// Split first (deterministic), so a training example can never leak into eval.
const trainRows: Row[] = [];
const evalRows: Row[] = [];
for (const r of rows) {
  targetBalance[r.targetType] = (targetBalance[r.targetType] ?? 0) + 1;
  if (r.hasModel) modelResolutionCount++;
  const bucket = splitFor(r.output + "||" + r.prompt.slice(0, 200));
  (bucket === "eval" ? evalRows : trainRows).push(r);
}

// Balance the TRAIN split only: keep every real-entity example, deterministically downsample "none".
let droppedNone = 0;
let finalTrainRows = trainRows;
if (balance) {
  const nonNone = trainRows.filter(r => r.targetType !== "none");
  const noneSorted = trainRows
    .filter(r => r.targetType === "none")
    .map(r => ({ r, h: crypto.createHash("sha1").update(r.output + r.prompt.slice(0, 200)).digest("hex") }))
    .sort((a, b) => (a.h < b.h ? -1 : 1))
    .map(x => x.r);
  const keepNone = noneSorted.slice(0, nonNone.length);
  droppedNone = noneSorted.length - keepNone.length;
  finalTrainRows = [...nonNone, ...keepNone];
}

fs.writeFileSync(
  path.join(outDir, "train.jsonl"),
  finalTrainRows.map(toExampleLine).join("\n") + (finalTrainRows.length ? "\n" : "")
);
fs.writeFileSync(
  path.join(outDir, "eval.jsonl"),
  evalRows.map(toExampleLine).join("\n") + (evalRows.length ? "\n" : "")
);
const trainN = finalTrainRows.length;
const evalN = evalRows.length;

console.log(`# Student-parser dataset — schema=${schemaName} variant=${variant}`);
console.log(`source files:        ${files.length}`);
console.log(`raw rows (schema):   ${rawForSchema}`);
console.log(`dropped truncated:   ${droppedTruncated}`);
console.log(`dropped bad-json:    ${droppedBadJson}`);
console.log(`unique examples:     ${rows.length}`);
console.log(`balance mode:        ${balance ? `ON (dropped ${droppedNone} "none" from train)` : "off"}`);
console.log(`  -> train:          ${trainN}`);
console.log(`  -> eval (held-out):${evalN}`);
console.log(`model-resolution (non-empty model): ${modelResolutionCount} (${((modelResolutionCount / Math.max(rows.length, 1)) * 100).toFixed(0)}%)`);
console.log(`target_type balance:`);
for (const [k, v] of Object.entries(targetBalance).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(20)} ${v}`);
}
console.log(`\nwrote:\n  ${path.join(outDir, "train.jsonl")}\n  ${path.join(outDir, "eval.jsonl")}`);
