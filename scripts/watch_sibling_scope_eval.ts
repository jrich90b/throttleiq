/**
 * Watch sibling-scope eval (Joe, 2026-07-04).
 *
 * When a same-FAMILY sibling trim lands during a strict base-model watch ("Road Glide"
 * watch; a "Road Glide Special" arrives), the agent asks ONCE whether the customer is
 * open to variants; their answer (parseWatchScopeWithLLM + decideWatchScopeTurn, BOTH
 * reply paths) either broadens the watch (openToOtherTrims) or pins it base-only —
 * never re-asked. Cross-family units ("Road Glide 3" — a TRIKE) never prompt the ask
 * (model_family:eval owns the fire-side guard).
 *
 * Layers: (1) source guard (parser + flag + schema; centralized decision; state-only
 * resolver wired in BOTH paths; engine ask sites), (2) pure ask-eligibility decision
 * table, (3) pure answer decision table, (4) the ask copy, (5) LLM coverage (gated;
 * skips cleanly without a key).
 *
 * Run gated: LLM_ENABLED=1 LLM_WATCH_SCOPE_PARSER_ENABLED=1 npx tsx scripts/watch_sibling_scope_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseWatchScopeWithLLM } from "../services/api/src/domain/llmDraft.ts";
import { decideWatchScopeTurn } from "../services/api/src/domain/routeStateReducer.ts";
import { decideWatchSiblingScopeAsk } from "../services/api/src/domain/watchSiblingScope.ts";
import { buildWatchSiblingScopeAsk } from "../services/api/src/domain/agentVoice.ts";

// --- 1) Source guard. ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
const reducer = fs.readFileSync("services/api/src/domain/routeStateReducer.ts", "utf8");

assert.ok(/export async function parseWatchScopeWithLLM/.test(llm), "parser must be exported");
assert.ok(/WATCH_SCOPE_PARSER_JSON_SCHEMA/.test(llm), "strict JSON schema const must exist");
assert.ok(/LLM_WATCH_SCOPE_PARSER_ENABLED/.test(llm), "parser must be behind an enable flag");
assert.ok(/export function decideWatchScopeTurn/.test(reducer), "decision must be centralized in routeStateReducer");
const applySites = (index.match(/await applyWatchScopeAnswer\(/g) || []).length;
assert.ok(applySites >= 2, `the scope-answer application must be wired in BOTH paths; found ${applySites}`);
assert.ok(/function findPendingWatchScopeAsk/.test(index), "the pending-ask gate must exist (no hint regex)");
// The engines must route the ask through the shared eligibility decision + builder, in BOTH
// the cron sweep and the hold-release notifier.
const engineAskSites = (index.match(/maybeDraftWatchSiblingScopeAsk\(/g) || []).length;
assert.ok(engineAskSites >= 3, `both watch-fire engines must call the ask helper; found ${engineAskSites}`);
assert.ok(/decideWatchSiblingScopeAsk\(/.test(index), "the engine ask must go through the pure eligibility decision");
assert.ok(/buildWatchSiblingScopeAsk\(/.test(index), "the ask copy must come from agentVoice");
// The live matcher must carry the cross-family guard (never fire cross form-factor).
assert.ok(/trikeClassConflict\(item\.model, watch\.model\)/.test(index), "the live matcher must apply the trike cross-family guard");

// --- 2) Ask-eligibility decision table (pure). ---
{
  type In = Parameters<typeof decideWatchSiblingScopeAsk>[0];
  const ok: In = {
    hasWatchModel: true,
    watchActive: true,
    unitMatchesWatchDirectionally: true,
    unitIsDistinctTrim: true,
    trikeClassConflict: false,
    openToOtherTrims: false,
    alreadyAsked: false,
    declined: false,
    notifiedRecently: false
  };
  const rows: Array<{ id: string; input: In; kind: "ask_scope" | "none" }> = [
    { id: "sibling_trim_asks", input: { ...ok }, kind: "ask_scope" },
    { id: "cross_family_never_asks", input: { ...ok, trikeClassConflict: true }, kind: "none" },
    { id: "not_a_sibling_fires_instead", input: { ...ok, unitIsDistinctTrim: false }, kind: "none" },
    { id: "unrelated_model", input: { ...ok, unitMatchesWatchDirectionally: false }, kind: "none" },
    { id: "already_open_nothing_to_ask", input: { ...ok, openToOtherTrims: true }, kind: "none" },
    { id: "never_reask", input: { ...ok, alreadyAsked: true }, kind: "none" },
    { id: "declined_stays_declined", input: { ...ok, declined: true }, kind: "none" },
    { id: "paused_watch", input: { ...ok, watchActive: false }, kind: "none" },
    { id: "no_model", input: { ...ok, hasWatchModel: false }, kind: "none" },
    { id: "rate_limited", input: { ...ok, notifiedRecently: true }, kind: "none" }
  ];
  for (const r of rows) {
    const got = decideWatchSiblingScopeAsk(r.input).kind;
    assert.equal(got, r.kind, `ask decision[${r.id}] expected ${r.kind}, got ${got}`);
  }
}

// --- 3) Answer decision table (pure). Fail direction: unsure => none (watch stays strict). ---
{
  type In = Parameters<typeof decideWatchScopeTurn>[0];
  const ok: In = { scopeAskPending: true, parserAccepted: true, intent: "open_to_variants", confidence: 0.9, confidenceMin: 0.7 };
  const rows: Array<{ id: string; input: In; kind: "broaden_watch" | "keep_base_only" | "none" }> = [
    { id: "confident_yes_broadens", input: { ...ok }, kind: "broaden_watch" },
    { id: "at_floor_broadens", input: { ...ok, confidence: 0.7 }, kind: "broaden_watch" },
    { id: "below_floor_none", input: { ...ok, confidence: 0.69 }, kind: "none" },
    { id: "confident_no_pins_base", input: { ...ok, intent: "base_only" }, kind: "keep_base_only" },
    { id: "unrelated_none", input: { ...ok, intent: "unrelated" }, kind: "none" },
    { id: "not_accepted_none", input: { ...ok, parserAccepted: false }, kind: "none" },
    { id: "nothing_pending_none", input: { ...ok, scopeAskPending: false }, kind: "none" },
    { id: "unknown_intent_none", input: { ...ok, intent: "gibberish" }, kind: "none" }
  ];
  for (const r of rows) {
    const got = decideWatchScopeTurn(r.input).kind;
    assert.equal(got, r.kind, `answer decision[${r.id}] expected ${r.kind}, got ${got}`);
  }
}

// --- 4) The ask copy: names both the unit and the watched base model, offers BOTH
//        directions, and keeps the base model as the default (no pressure to broaden). ---
{
  const ask = buildWatchSiblingScopeAsk({
    firstName: "Ray",
    watchModelLabel: "Road Glide",
    unitLabel: "2026 Harley-Davidson Road Glide Special"
  });
  assert.ok(ask.includes("Road Glide Special"), "the ask names the arriving sibling unit");
  assert.ok(/watching for the Road Glide/.test(ask), "the ask restates what they're watching for");
  assert.ok(/just the Road Glide\?$/.test(ask), "the ask keeps base-only as an explicit, final option");
  assert.ok(ask.startsWith("Hey Ray"), "personalized when a first name exists");
  assert.ok(!/great question|I understand|rest assured|at your convenience/i.test(ask), "no corporate tells");
  const noName = buildWatchSiblingScopeAsk({ watchModelLabel: "Road Glide", unitLabel: "2026 Road Glide ST" });
  assert.ok(noName.startsWith("Quick one"), "clean opener without a name");
}

// --- 5) LLM coverage (gated; skips cleanly without LLM_ENABLED/key). ---
const args = { watchModel: "Road Glide", askedUnitLabel: "2026 Road Glide Special" };
const opens = ["sure that works", "yeah I'd look at the Special too", "either way is fine with me"];
const bases = ["no just the base please", "nah holding out for the standard one"];
// Must NOT act (fail toward keeping the watch strict): unrelated turns and an opt-out
// (a separate parser owns opt-outs — a scope parser must not eat them).
const unrelated = ["thanks man", "can I come by Saturday to look at helmets?", "take me off the list"];

let ran = 0;
for (const text of opens) {
  const v = await parseWatchScopeWithLLM({ text, ...args });
  if (!v) continue;
  ran++;
  assert.equal(v.intent, "open_to_variants", `"${text}" should be open_to_variants, got ${v.intent}`);
}
for (const text of bases) {
  const v = await parseWatchScopeWithLLM({ text, ...args });
  if (!v) continue;
  ran++;
  assert.equal(v.intent, "base_only", `"${text}" should be base_only, got ${v.intent}`);
}
for (const text of unrelated) {
  const v = await parseWatchScopeWithLLM({ text, ...args });
  if (!v) continue;
  ran++;
  assert.equal(v.intent, "unrelated", `ADVERSARIAL: "${text}" must not resolve the scope ask, got ${v.intent}`);
}
// An answer carrying another question must flag hasOtherAsk so the pipeline (not a canned
// ack) composes the reply.
{
  const v = await parseWatchScopeWithLLM({ text: "sure — what color is it?", ...args });
  if (v) {
    ran++;
    assert.equal(v.intent, "open_to_variants", "engaging with the variant is openness");
    assert.equal(v.hasOtherAsk, true, "the extra question must be flagged so it is not dropped");
  }
}

console.log(
  ran
    ? `PASS watch sibling scope eval (LLM cases ran: ${ran})`
    : "PASS watch sibling scope eval (LLM cases skipped — parser disabled)"
);
