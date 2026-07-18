/**
 * score_student_parser.ts — Stage 3 of the distillation pilot: the offline scorecard.
 *
 * Runs the held-out eval examples through the fine-tuned student model (Fireworks, OpenAI-compatible
 * endpoint, json_schema-constrained) and compares its output to the teacher's recorded answer
 * field-by-field. The teacher is NOT ground truth (it's what we're trying to beat), so disagreements
 * on the model-resolution subset are dumped for human spot-check — that's where the real signal is.
 *
 * Usage:
 *   FIREWORKS_API_KEY=... npx tsx scripts/score_student_parser.ts \
 *     --eval <path/to/eval.jsonl> \
 *     --model accounts/<acct>/models/<id> \
 *     [--base https://api.fireworks.ai/inference/v1] \
 *     [--concurrency 4] [--limit N]
 *
 * eval.jsonl lines: {messages:[{role:system},{role:user},{role:assistant, content:<teacher JSON>}]}
 */
import fs from "node:fs";
import OpenAI from "openai";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const evalPath = arg("eval");
const model = arg("model");
const baseURL = arg("base", "https://api.fireworks.ai/inference/v1")!;
const concurrency = Number(arg("concurrency", "4"));
const limit = arg("limit") ? Number(arg("limit")) : Infinity;
const key = process.env.FIREWORKS_API_KEY;

if (!evalPath || !model || !key) {
  console.error("need --eval <file> --model <fireworks-model> and FIREWORKS_API_KEY in env");
  process.exit(2);
}

const client = new OpenAI({ apiKey: key, baseURL });

// The schema fields we score (confidence excluded — it's a soft signal, not a decision).
const SCHEMA_FIELDS = [
  "target_type",
  "is_availability_question",
  "is_test_ride_context",
  "model",
  "year",
  "year_min",
  "year_max",
  "color",
  "trim",
  "stock_id",
  "condition",
  "min_price",
  "max_price",
  "monthly_budget",
  "down_payment"
];

// The JSON schema the student must emit (mirrors INVENTORY_ENTITY_PARSER_JSON_SCHEMA).
const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...SCHEMA_FIELDS, "confidence"],
  properties: {
    target_type: {
      type: "string",
      enum: [
        "stock_id",
        "vin",
        "exact_year_model",
        "model_only",
        "color_model",
        "alternate_request",
        "generic_inventory",
        "image_reference",
        "none"
      ]
    },
    is_availability_question: { type: "boolean" },
    is_test_ride_context: { type: "boolean" },
    model: { type: "string" },
    year: { type: "integer" },
    year_min: { type: "integer" },
    year_max: { type: "integer" },
    color: { type: "string" },
    trim: { type: "string" },
    stock_id: { type: "string" },
    condition: { type: "string", enum: ["new", "used", "unknown"] },
    min_price: { type: "number" },
    max_price: { type: "number" },
    monthly_budget: { type: "number" },
    down_payment: { type: "number" },
    confidence: { type: "number" }
  }
};

// The fine-tuned model can emit its JSON answer followed by stray tokens (reasoning/whitespace).
// Extract the FIRST balanced {...} object rather than demanding the whole string parse.
function extractFirstJson(raw: string): any {
  const s = String(raw ?? "");
  const start = s.indexOf("{");
  if (start < 0) return JSON.parse(s); // let it throw with context
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return JSON.parse(s.slice(start, i + 1));
    }
  }
  return JSON.parse(s.slice(start)); // unbalanced — throw with context
}

function norm(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim().toLowerCase();
  return String(v);
}
function extractMessage(userContent: string): string {
  const i = userContent.lastIndexOf("Message:");
  return i >= 0 ? userContent.slice(i + 8).trim().slice(0, 120) : userContent.slice(-120);
}

type Row = { user: string; teacher: any; msg: string };
const rows: Row[] = [];
for (const line of fs.readFileSync(evalPath, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const ex = JSON.parse(line);
  const user = ex.messages.find((m: any) => m.role === "user")?.content ?? "";
  const teacher = JSON.parse(ex.messages.find((m: any) => m.role === "assistant")?.content ?? "{}");
  rows.push({ user, teacher, msg: extractMessage(user) });
  if (rows.length >= limit) break;
}

let done = 0;
let errors = 0;
let exactMatch = 0;
const fieldCorrect: Record<string, number> = {};
SCHEMA_FIELDS.forEach(f => (fieldCorrect[f] = 0));
// model-resolution subset = teacher says a real inventory target (not "none")
let modelSubset = 0;
let modelSubsetTargetTypeOk = 0;
let modelSubsetModelOk = 0;
let modelSubsetFullOk = 0; // target_type + model + year all right
// "none" subset = teacher says no target; does student avoid a false-positive?
let noneSubset = 0;
let noneCorrect = 0;
const disagreements: Array<{ msg: string; field: string; teacher: string; student: string; subset: string }> = [];

async function scoreOne(r: Row): Promise<void> {
  let student: any;
  try {
    const resp = await client.chat.completions.create({
      model: model!,
      messages: [
        { role: "system", content: "You extract structured motorcycle shopping entities as strict JSON." },
        { role: "user", content: r.user }
      ],
      // @ts-ignore Fireworks json_schema response format
      response_format: { type: "json_schema", json_schema: { name: "inventory_entity_parser", schema: RESPONSE_SCHEMA } },
      max_tokens: 400,
      temperature: 0
    });
    student = extractFirstJson(resp.choices[0]?.message?.content ?? "{}");
  } catch (e: any) {
    errors++;
    if (errors <= 3) process.stderr.write(`  ERROR: ${e?.status ?? ""} ${e?.message ?? e}\n${JSON.stringify(e?.error ?? e?.response?.data ?? "").slice(0, 300)}\n`);
    return;
  }
  let allOk = true;
  for (const f of SCHEMA_FIELDS) {
    const ok = norm(r.teacher[f]) === norm(student[f]);
    if (ok) fieldCorrect[f]++;
    else {
      allOk = false;
      disagreements.push({
        msg: r.msg,
        field: f,
        teacher: norm(r.teacher[f]),
        student: norm(student[f]),
        subset: norm(r.teacher.target_type) === "none" ? "none" : "model"
      });
    }
  }
  if (allOk) exactMatch++;
  const isNone = norm(r.teacher.target_type) === "none";
  if (isNone) {
    noneSubset++;
    if (norm(student.target_type) === "none") noneCorrect++;
  } else {
    modelSubset++;
    if (norm(student.target_type) === norm(r.teacher.target_type)) modelSubsetTargetTypeOk++;
    if (norm(student.model) === norm(r.teacher.model)) modelSubsetModelOk++;
    if (
      norm(student.target_type) === norm(r.teacher.target_type) &&
      norm(student.model) === norm(r.teacher.model) &&
      norm(student.year) === norm(r.teacher.year)
    )
      modelSubsetFullOk++;
  }
  done++;
}

async function run(): Promise<void> {
  const queue = [...rows];
  async function worker(): Promise<void> {
    while (queue.length) {
      const r = queue.shift()!;
      await scoreOne(r);
      if ((done + errors) % 20 === 0) process.stderr.write(`  scored ${done + errors}/${rows.length}\n`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const pct = (n: number, d: number) => (d ? ((n / d) * 100).toFixed(1) : "n/a");
  console.log(`\n# Student-parser offline scorecard`);
  console.log(`model:    ${model}`);
  console.log(`eval set: ${rows.length} held-out examples (scored ${done}, errors ${errors})`);
  console.log(`\nexact-match (all ${SCHEMA_FIELDS.length} fields == teacher): ${exactMatch}/${done} = ${pct(exactMatch, done)}%`);
  console.log(`\n-- "no bike" subset (teacher target_type=none): ${noneSubset} --`);
  console.log(`   student also said none:        ${noneCorrect}/${noneSubset} = ${pct(noneCorrect, noneSubset)}%`);
  console.log(`\n-- model-resolution subset (teacher named a target): ${modelSubset} --`);
  console.log(`   target_type matches teacher:   ${modelSubsetTargetTypeOk}/${modelSubset} = ${pct(modelSubsetTargetTypeOk, modelSubset)}%`);
  console.log(`   model string matches teacher:  ${modelSubsetModelOk}/${modelSubset} = ${pct(modelSubsetModelOk, modelSubset)}%`);
  console.log(`   target_type+model+year all ok: ${modelSubsetFullOk}/${modelSubset} = ${pct(modelSubsetFullOk, modelSubset)}%`);
  console.log(`\n-- per-field agreement with teacher --`);
  for (const f of SCHEMA_FIELDS) console.log(`   ${f.padEnd(24)} ${pct(fieldCorrect[f], done)}%`);
  console.log(`\n-- disagreements on the MODEL subset (spot-check: who's actually right?) --`);
  const modelDis = disagreements.filter(d => d.subset === "model").slice(0, 25);
  for (const d of modelDis) console.log(`   "${d.msg}"\n      [${d.field}] teacher="${d.teacher}" student="${d.student}"`);
  console.log(`\n(${disagreements.filter(d => d.subset === "model").length} model-subset field disagreements total; showing first 25)`);
}

run();
