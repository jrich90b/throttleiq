/**
 * THE JUDGE SHADOW ARM'S EVIDENCE HAS TO SURVIVE A WEEK (2026-08-13).
 *
 * The arm exists to answer one question a WEEK after it is switched on: does a Claude challenger
 * judge better than the shipped `gpt-5-mini`? It logged its verdict pairs with `console.log` only —
 * i.e. to the pm2 log, which truncates lines and rotates. That exact artifact has already produced
 * one wrong conclusion on this codebase: the self-heal review read "~21 events in 5 weeks" off the
 * pm2 tail when the real volume was 4-8 a day. An arm whose evidence evaporates before the readout
 * is worse than no arm, because it looks like it ran.
 *
 * So the pairs now also go to a durable daily JSONL, same shape and same fail-direction as
 * `parserCapture.ts`. This eval EXECUTES the appender against a temp dir — a source-text assertion
 * could not tell the difference between a file that is written and one that is not.
 *
 * Run: npx tsx scripts/judge_shadow_durable_log_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const A = await import("../services/api/src/domain/judgeShadowArm.ts");

let n = 0;
const ok = (cond: boolean, msg: string) => {
  assert.equal(cond, true, msg);
  n++;
};

// ---------------------------------------------------------------------------
// 1) WHERE IT WRITES — REPORT_ROOT is the convention; an explicit dir overrides.
// ---------------------------------------------------------------------------
ok(
  A.resolveJudgeShadowDir({ REPORT_ROOT: "/runtime/reports" }) === "/runtime/reports/judge_shadow",
  "REPORT_ROOT drives the location, matching every other report producer"
);
ok(
  A.resolveJudgeShadowDir({ JUDGE_SHADOW_DIR: "/explicit", REPORT_ROOT: "/runtime/reports" }) === "/explicit",
  "an explicit dir wins over REPORT_ROOT"
);
ok(
  A.resolveJudgeShadowDir({}) === null,
  "with neither set it writes NOWHERE rather than guessing a path — a stray file is a bug"
);

// ---------------------------------------------------------------------------
// 2) IT ACTUALLY WRITES — executed, not asserted from the source.
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "judge-shadow-eval-"));
const prevRoot = process.env.REPORT_ROOT;
const prevDir = process.env.JUDGE_SHADOW_DIR;
process.env.JUDGE_SHADOW_DIR = tmp;
delete process.env.REPORT_ROOT;

try {
  const base = {
    operation: "draft_quality_judge",
    primaryModel: "gpt-5-mini",
    primaryVerdict: "good",
    shadowModel: "claude-sonnet-5",
    shadowMs: 921,
    status: 200,
    retriedWithoutTemperature: false
  };
  const rows = [
    { ...base, at: "2026-08-14T10:00:00.000Z", shadowVerdict: "good", agree: true },
    { ...base, at: "2026-08-14T10:05:00.000Z", shadowVerdict: "bad", agree: false },
    // The challenger errored — NEITHER agreement nor disagreement.
    { ...base, at: "2026-08-14T10:06:00.000Z", shadowVerdict: null, agree: null, status: null, shadowMs: null },
    // A different day must land in a different file.
    { ...base, at: "2026-08-15T09:00:00.000Z", shadowVerdict: "good", agree: true }
  ];
  for (const r of rows) A.appendJudgeShadowRecord(r as any);

  const files = fs.readdirSync(tmp).sort();
  ok(
    files.join(",") === "judge_shadow_20260814.jsonl,judge_shadow_20260815.jsonl",
    `daily files, named from the record's OWN timestamp (not the wall clock): ${files.join(",")}`
  );

  const day1 = fs
    .readFileSync(path.join(tmp, "judge_shadow_20260814.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(l => JSON.parse(l));
  ok(day1.length === 3, `every pair is a line — appended, never overwritten (got ${day1.length})`);
  ok(day1[0].agree === true && day1[1].agree === false, "both verdicts survive the round trip");

  // THE POINT OF THE WHOLE FILE: a null `agree` must stay null on disk. Flattening it to false
  // would invent a disagreement; flattening to true would credit the incumbent for a failed call.
  ok(day1[2].agree === null, "an uncomparable pair round-trips as null, not as agree/disagree");
  ok(day1[2].shadowVerdict === null, "a failed challenger records no verdict rather than an empty string");

  // The readout groups by these, so they have to be present on every row.
  for (const r of day1) {
    for (const field of ["at", "operation", "primaryModel", "shadowModel"]) {
      ok(r[field] !== undefined && r[field] !== "", `every row carries ${field} for the readout to group by`);
    }
  }

  // Latency is the arm's SECOND question (it decides whether a challenger is affordable live).
  ok(day1[0].shadowMs === 921, "challenger latency is recorded, not just the verdict");

  // ---------------------------------------------------------------------------
  // 3) FAIL DIRECTION — logging can never take a customer turn down.
  // ---------------------------------------------------------------------------
  process.env.JUDGE_SHADOW_DIR = "/proc/definitely-not-writable/judge-shadow";
  let threw = false;
  try {
    A.appendJudgeShadowRecord({ ...base, at: "2026-08-14T10:07:00.000Z", shadowVerdict: "good", agree: true } as any);
  } catch {
    threw = true;
  }
  ok(!threw, "an unwritable directory is swallowed — the arm must never throw into the reply path");

  const circular: any = { ...base, at: "2026-08-14T10:08:00.000Z", shadowVerdict: "good", agree: true };
  circular.self = circular;
  let threwCircular = false;
  try {
    A.appendJudgeShadowRecord(circular);
  } catch {
    threwCircular = true;
  }
  ok(!threwCircular, "an unserializable record is swallowed too");
} finally {
  if (prevRoot === undefined) delete process.env.REPORT_ROOT;
  else process.env.REPORT_ROOT = prevRoot;
  if (prevDir === undefined) delete process.env.JUDGE_SHADOW_DIR;
  else process.env.JUDGE_SHADOW_DIR = prevDir;
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 3b) THE RECORD BUILDER — where the null rule actually lives.
//
// Testing only the writer left a hole: sabotaging the BUILDER to coerce a null `agree` to false
// passed a 6-way sabotage sweep, because the eval hand-built its own rows and never exercised the
// construction path. The rule is pinned at its source now.
// ---------------------------------------------------------------------------
const built = {
  at: "2026-08-14T11:00:00.000Z",
  operation: "draft_quality_judge",
  primaryModel: "gpt-5-mini",
  shadowModel: "claude-sonnet-5"
};
ok(
  A.buildJudgeShadowRecord({ ...built, primaryVerdict: "good", shadowVerdict: "good" }).agree === true,
  "two matching verdicts agree"
);
ok(
  A.buildJudgeShadowRecord({ ...built, primaryVerdict: "good", shadowVerdict: "bad" }).agree === false,
  "two differing verdicts disagree"
);
for (const [label, primary, shadow] of [
  ["the challenger returned nothing", "good", null],
  ["the incumbent had no verdict", null, "good"],
  ["neither answered", null, null]
] as [string, string | null, string | null][]) {
  const r = A.buildJudgeShadowRecord({ ...built, primaryVerdict: primary, shadowVerdict: shadow });
  ok(
    r.agree === null,
    `an UNCOMPARABLE pair must stay null, never coerced (${label}) — got ${JSON.stringify(r.agree)}`
  );
}
ok(
  A.buildJudgeShadowRecord({ ...built, primaryVerdict: undefined, shadowVerdict: "good" }).primaryVerdict === null,
  "an absent incumbent verdict normalizes to null, not the string 'undefined'"
);
ok(
  A.buildJudgeShadowRecord({ ...built, primaryVerdict: "good", shadowVerdict: "good", shadowMs: undefined }).shadowMs === null,
  "a missing latency is null rather than dropped from the row"
);

// ---------------------------------------------------------------------------
// 4) THE ARM IS STILL OFF BY DEFAULT — this slice must not switch anything on.
// ---------------------------------------------------------------------------
const prevFlag = process.env.JUDGE_SHADOW_ARM;
delete process.env.JUDGE_SHADOW_ARM;
ok(A.isJudgeShadowArmEnabled() === false, "with the flag unset the arm stays OFF");
process.env.JUDGE_SHADOW_ARM = "1";
ok(A.isJudgeShadowArmEnabled() === true, "the flag is the only switch");
if (prevFlag === undefined) delete process.env.JUDGE_SHADOW_ARM;
else process.env.JUDGE_SHADOW_ARM = prevFlag;

// The challengers are asked at temperature 0 — the incumbent gpt-5-mini REJECTS that parameter
// outright (measured 2026-08-13: 400 "temperature is not supported with this model"), so pinning it
// is a property only the challenger side can have. Losing it would quietly change what is compared.
const armSrc = fs.readFileSync(
  new URL("../services/api/src/domain/judgeShadowArm.ts", import.meta.url),
  "utf8"
);
ok(armSrc.includes("temperature: 0"), "challengers are asked at temperature 0");
ok(
  armSrc.includes("appendJudgeShadowRecord(record)"),
  "the durable write is wired into the arm, not merely exported"
);

console.log(`judge_shadow_durable_log_eval: PASS (${n} assertions)`);
