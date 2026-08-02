/**
 * anthropic_request_contract:eval — one Anthropic caller, and a shadow arm that can't cost or
 * change anything.
 *
 * THE BUG THIS EXISTS TO STOP (2026-08-02). Joe asked for the most capable model on our judges.
 * Setting `ANTHROPIC_OPEN_CRITIC_MODEL=claude-opus-5` did nothing: both of our hand-rolled request
 * builders hardcoded `temperature: 0`, and Opus 5 answers that with
 * `400 "temperature is deprecated for this model."`. Measured on the box:
 *
 *     claude-opus-5     + temperature:0  -> 400 in 251ms
 *     claude-opus-5     (no temperature) -> 200 in 2806ms, tool_use returned correctly
 *     claude-sonnet-4-6 + temperature:0  -> 200 in 923ms
 *
 * The open critic returns null on a failed Claude call and falls through to OpenAI SILENTLY, so
 * the config change would have read as "the critic is on Opus now" while 100% of critiques still
 * came from gpt-5-mini. Same family as the wrongful-silence judge that watched 10 of 230 silences:
 * an instrument reporting fine while measuring nothing. This eval pins the fix and the fail
 * directions around it.
 *
 * Run: npx tsx scripts/anthropic_request_contract_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  anthropicModelRejectsTemperature,
  isTemperatureRejection,
  noteAnthropicModelRejectsTemperature
} from "../services/api/src/domain/anthropicRequest.ts";
import {
  JUDGE_SHADOW_DEFAULT_MODELS,
  claimJudgeShadowSlot,
  isJudgeShadowArmEnabled,
  judgeShadowDailyCap,
  judgeShadowModels,
  judgeVerdictsAgree,
  resetJudgeShadowSpend,
  runJudgeShadowArm
} from "../services/api/src/domain/judgeShadowArm.ts";

// --- the 400 detector is NARROW: it must not swallow unrelated failures into a silent retry ----
assert.equal(
  isTemperatureRejection(400, "`temperature` is deprecated for this model."),
  true,
  "the exact production error must be recognized"
);
assert.equal(isTemperatureRejection(400, "temperature is not supported"), true, "wording variant");
assert.equal(isTemperatureRejection(400, "TEMPERATURE IS DEPRECATED"), true, "case-insensitive");
for (const [status, msg] of [
  [400, "max_tokens: must be greater than 0"],
  [400, "model: unknown model"],
  [401, "invalid x-api-key"],
  [429, "rate limited"],
  [500, "internal server error"],
  [529, "overloaded"],
  // A 500 that happens to mention temperature is NOT the deprecation case — retrying without a
  // parameter would not fix it, and treating it as such hides a real outage behind a second call.
  [500, "temperature deprecated"]
] as [number, string][]) {
  assert.equal(isTemperatureRejection(status, msg), false, `must NOT retry: ${status} ${msg}`);
}
assert.equal(isTemperatureRejection(400, null), false, "no message => not the temperature case");
assert.equal(isTemperatureRejection(400, ""), false, "blank message => not the temperature case");

// --- the quirk is LEARNED, not a hardcoded model table -----------------------------------------
const probe = "claude-test-model-not-real";
assert.equal(anthropicModelRejectsTemperature(probe), false, "unknown model starts permissive");
noteAnthropicModelRejectsTemperature(probe);
assert.equal(anthropicModelRejectsTemperature(probe), true, "recorded after a rejection");
assert.equal(anthropicModelRejectsTemperature("  "), false, "blank model is never 'unsupported'");

// --- the shadow arm is OFF unless explicitly switched on ---------------------------------------
// Fail direction: an unset flag must mean "do nothing", so merging this changes no behavior and
// spends no money. A shadow arm that defaulted ON would be a live cost change disguised as a test.
delete process.env.JUDGE_SHADOW_ARM;
assert.equal(isJudgeShadowArmEnabled(), false, "unset flag => disabled");
for (const off of ["", "0", "true", "yes", "1 "]) {
  process.env.JUDGE_SHADOW_ARM = off;
  assert.equal(isJudgeShadowArmEnabled(), String(off).trim() === "1", `opt-IN only: ${JSON.stringify(off)}`);
}
delete process.env.JUDGE_SHADOW_ARM;

// It must also be inert when called with the flag off — no throw, no return value to consume.
resetJudgeShadowSpend();
assert.equal(
  runJudgeShadowArm({
    operation: "draft_quality_judge",
    prompt: "p",
    schemaName: "draft_quality_judge",
    schema: { type: "object" },
    primaryModel: "gpt-5-mini",
    primaryVerdict: "good",
    verdictField: "overall"
  }),
  undefined,
  "the shadow arm returns nothing — no caller may ever act on a shadow verdict"
);

// --- SONNET IS THE DEFAULT FIRST CHALLENGER ----------------------------------------------------
// Joe's research: Claude 3 Opus was not worth it as a judge over 3.5 Sonnet (slower, dearer, no
// measurable accuracy gain), and the Sonnet tier is the one described as fitting multi-turn chat
// judging. That is a hypothesis about TODAY's models, not a proven law — but the default must not
// quietly assert the opposite.
assert.equal(JUDGE_SHADOW_DEFAULT_MODELS[0], "claude-sonnet-5", "Sonnet leads; Opus is the control");
assert.ok(JUDGE_SHADOW_DEFAULT_MODELS.includes("claude-opus-5"), "Opus stays in the bake-off");
delete process.env.JUDGE_SHADOW_MODELS;
assert.deepEqual(judgeShadowModels(), JUDGE_SHADOW_DEFAULT_MODELS, "unset => both tiers");
process.env.JUDGE_SHADOW_MODELS = " claude-opus-5 , , claude-sonnet-5 ";
assert.deepEqual(judgeShadowModels(), ["claude-opus-5", "claude-sonnet-5"], "trimmed, blanks dropped");
delete process.env.JUDGE_SHADOW_MODELS;

// --- the spend cap is real, counts PER CALL, and resets on the UTC date roll -------------------
resetJudgeShadowSpend();
assert.equal(claimJudgeShadowSlot("2026-08-02", 2), true, "1st allowed");
assert.equal(claimJudgeShadowSlot("2026-08-02", 2), true, "2nd allowed");
assert.equal(claimJudgeShadowSlot("2026-08-02", 2), false, "3rd refused at cap 2");
assert.equal(claimJudgeShadowSlot("2026-08-03", 2), true, "new UTC day resets the counter");
resetJudgeShadowSpend();
assert.equal(claimJudgeShadowSlot("2026-08-02", 0), false, "cap 0 disables the arm outright");
delete process.env.JUDGE_SHADOW_DAILY_CAP;
assert.equal(judgeShadowDailyCap(), 300, "default cap");
process.env.JUDGE_SHADOW_DAILY_CAP = "not-a-number";
assert.equal(judgeShadowDailyCap(), 300, "garbage cap falls back to the default, never to unlimited");
process.env.JUDGE_SHADOW_DAILY_CAP = "-5";
assert.equal(judgeShadowDailyCap(), 300, "a negative cap is not 'unlimited' either");
delete process.env.JUDGE_SHADOW_DAILY_CAP;

// --- a missing verdict is NEVER agreement ------------------------------------------------------
// The load-bearing one: if a challenger errors, counting it as "agreed" would inflate the
// agreement rate and argue for changing nothing — the flattering direction.
assert.equal(judgeVerdictsAgree("good", "good"), true);
assert.equal(judgeVerdictsAgree("good", "hold"), false);
for (const [a, b] of [
  ["good", null],
  [null, "good"],
  ["good", ""],
  ["", "good"],
  [null, null],
  ["good", undefined],
  [undefined, "good"]
] as [any, any][]) {
  assert.equal(judgeVerdictsAgree(a, b), null, `missing side => null, never true: ${a}/${b}`);
}

// --- WIRING: exactly ONE place builds an Anthropic request -------------------------------------
// The quirk above had to be found and fixed twice because there were two builders. A third would
// bring the next quirk back, so the scan is repo-wide rather than a two-file check.
const OWNER = "services/api/src/domain/anthropicRequest.ts";
const offenders: string[] = [];
const walk = (dir: string): void => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      walk(full);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (full.endsWith(OWNER)) continue;
    const text = fs.readFileSync(full, "utf8");
    if (text.includes("api.anthropic.com/v1/messages")) offenders.push(full);
  }
};
walk("services/api/src");
assert.deepEqual(
  offenders,
  [],
  "only anthropicRequest.ts may build an Anthropic Messages request — a second builder is how the " +
    `temperature quirk survived in two places. Route these through it: ${offenders.join(", ")}`
);

// Both known callers must actually use the shared helper (an unused module proves nothing).
for (const [file, why] of [
  ["services/api/src/domain/llmDraft.ts", "the open critic's Claude arm"],
  ["services/api/src/domain/preShipReview.ts", "the pre-ship auto-merge gate"]
] as [string, string][]) {
  const text = fs.readFileSync(file, "utf8");
  // Symbol reference, not a call-shape pin: the ratchet exists to stop evals from encoding
  // punctuation, and the behavior guarded here is "this file goes through the shared caller".
  assert.ok(text.includes("anthropicMessagesRequest"), `${why} must call anthropicMessagesRequest (${file})`);
}

// (The "a failed Claude critique must log its fallback" pin lives in
// conversation_outcome_audit_eval.ts, beside the critic's other wiring pins — asserting it here too
// would cost a slot on the eval_source_pin_ratchet for no extra coverage.)
const llmDraft = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");

// --- the shadow arm is never awaited in the reply path -----------------------------------------
// If a judge awaited it, the customer would wait for a model we are only measuring. Opus answered
// in 2.8s on the box; first-touch auto-send makes that the number we are graded on.
for (const m of llmDraft.matchAll(/(await\s+)?runJudgeShadowArm\(/g)) {
  assert.equal(m[1], undefined, "runJudgeShadowArm must NEVER be awaited — it is off the hot path");
}
assert.equal(
  (llmDraft.match(/runJudgeShadowArm\(\{/g) ?? []).length,
  3,
  "all three per-turn judges (should-respond, draft quality, cadence quality) carry the shadow arm"
);

console.log(
  "PASS anthropic request contract — one caller, learned temperature quirk, opt-in capped shadow arm, no silent fallback"
);
