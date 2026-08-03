/**
 * Feature-flag wiring eval (pure, no LLM).
 *
 * Pins the 8/3 wiring-triage "dead switches" fixes — flags whose documented behavior and actual
 * wiring disagreed, which is worse than no flag: an incident responder reaches for the documented
 * lever and concludes the revert "didn't help".
 *
 *   D1 — CADENCE_QUALITY_JUDGE_ENABLED promised live promotion and fed only the run-at-all gate
 *        (held open by shadow's ON default), so setting it did NOTHING. Now OR'd with
 *        CADENCE_QUALITY_ENFORCE at the decider call site.
 *   D2 — three per-parser "kill switches" were OR'd with the (prod-ON) unified-slot flag, so they
 *        could only turn parsers ON, never OFF. isParserFlagEnabled gives "0" real kill power
 *        while keeping unset flags byte-identical to the pre-fix behavior.
 *   D3 — docs promised a TURN_UNDERSTANDING_ENABLED kill switch that never existed in code; the
 *        doc now names the real levers.
 *
 * Run: npx tsx scripts/feature_flag_wiring_eval.ts
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";

const { isParserFlagEnabled } = await import("../services/api/src/domain/llmFlags.ts");

const FLAG = "LLM_TRADE_PAYOFF_PARSER_ENABLED";
const UNIFIED = "LLM_UNIFIED_SLOT_PARSER_ENABLED";
const saved = { flag: process.env[FLAG], unified: process.env[UNIFIED] };

function withEnv(flag: string | undefined, unified: string | undefined, fn: () => void) {
  if (flag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = flag;
  if (unified === undefined) delete process.env[UNIFIED];
  else process.env[UNIFIED] = unified;
  fn();
}

// --- D2: the kill switch kills, and unset behaves exactly as before. ---

withEnv("0", "1", () =>
  assert.equal(
    isParserFlagEnabled(FLAG),
    false,
    "explicit 0 must WIN over the unified flag — this is the whole point: a kill switch that kills"
  )
);
withEnv("1", undefined, () =>
  assert.equal(isParserFlagEnabled(FLAG), true, "explicit 1 enables on its own")
);
withEnv(undefined, "1", () =>
  assert.equal(isParserFlagEnabled(FLAG), true, "unset + unified ON = enabled (pre-fix behavior kept)")
);
withEnv(undefined, undefined, () =>
  assert.equal(isParserFlagEnabled(FLAG), false, "unset + unified OFF = disabled (pre-fix behavior kept)")
);
withEnv("0", undefined, () =>
  assert.equal(isParserFlagEnabled(FLAG), false, "explicit 0 with unified OFF stays off")
);

// restore
if (saved.flag === undefined) delete process.env[FLAG];
else process.env[FLAG] = saved.flag;
if (saved.unified === undefined) delete process.env[UNIFIED];
else process.env[UNIFIED] = saved.unified;

// --- D2 wiring: the three legacy per-parser gates all route through the helper. ---

const llmDraft = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
for (const flag of [
  "LLM_TRADE_PAYOFF_PARSER_ENABLED",
  "LLM_TRADE_TARGET_VALUE_PARSER_ENABLED",
  "LLM_SEMANTIC_SLOT_PARSER_ENABLED"
]) {
  assert.ok(
    llmDraft.includes(`isParserFlagEnabled("${flag}")`),
    `${flag} must gate through isParserFlagEnabled so an explicit 0 can actually kill the parser`
  );
  assert.ok(
    !new RegExp(`${flag} === "1" \\|\\|\\s*\\n?\\s*process\\.env\\.${UNIFIED}`).test(llmDraft),
    `${flag} must not keep the raw OR-with-unified gate that made 0 a no-op`
  );
}

// --- D1: the cadence-quality decider's live bit honors BOTH switches. ---

const api = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.ok(
  /const enforce = isCadenceQualityEnforceEnabled\(\) \|\| isCadenceQualityJudgeEnabled\(\)/.test(api),
  "CADENCE_QUALITY_JUDGE_ENABLED must be a real live switch (OR'd with ENFORCE at the decider) — " +
    "its doc promised live promotion while it wired nothing (the NO_RESPONSE_JUDGE_ENABLED class)"
);

// --- D3: the consolidation plan names real levers, not the phantom. ---

const plan = fs.readFileSync("docs/comprehension_consolidation_plan.md", "utf8");
assert.ok(
  !/`TURN_UNDERSTANDING_ENABLED=0`/.test(plan),
  "the plan must not point an incident responder at TURN_UNDERSTANDING_ENABLED — no code reads it"
);
assert.ok(
  /LLM_TURN_UNDERSTANDING_PARSER_ENABLED/.test(plan) && /TURN_UNDERSTANDING_MODEL_AUTHORITY/.test(plan),
  "the plan must name the real kill switches"
);
// And the phantom really has no reader — if code ever grows one, this pin forces a doc revisit.
const grepTargets = ["services/api/src/index.ts", "services/api/src/domain/llmDraft.ts"];
for (const target of grepTargets) {
  const src = fs.readFileSync(target, "utf8");
  assert.ok(
    !/process\.env\.TURN_UNDERSTANDING_ENABLED\b/.test(src),
    `${target} must not read the phantom flag — if this fails, the doc and this eval need updating together`
  );
}

console.log("PASS feature_flag_wiring_eval — 15 checks");
