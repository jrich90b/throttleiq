/**
 * Watch opt-out eval.
 *
 * A customer on an inventory WATCH (we proactively text them when a matching bike comes in) can now
 * remove themselves from the alerts so we don't spam them. Parser-first comprehension
 * (parseWatchOptOutWithLLM) + a pure decision (decideWatchOptOutTurn) + a deterministic side effect
 * (pause the watch — the engine skips paused) in BOTH /webhooks/twilio and /conversations/:id/regenerate.
 * Belt-and-suspenders: explicit STOP and the disposition closeout also pause the watch, and the watch
 * notification now tells customers they can opt out.
 *
 * Layers: (1) source guard (parser + flag + schema; centralized decision; hint + resolver wired BOTH
 * paths; pause/active-watch helpers; STOP + disposition both pause; notification opt-out copy), (2)
 * pure decision table (pause_watch ONLY on an active watch + accepted + confident watch_opt_out;
 * everything else => none — fail toward keeping the watch), (3) LLM coverage (clear opt-outs vs
 * ADVERSARIAL continued-interest / defer which must NOT remove the watch).
 *
 * Run gated: LLM_ENABLED=1 LLM_WATCH_OPT_OUT_PARSER_ENABLED=1 npx tsx scripts/watch_opt_out_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseWatchOptOutWithLLM } from "../services/api/src/domain/llmDraft.ts";
import {
  decidePendingCloseoutOnSend,
  decideWatchOptOutTurn
} from "../services/api/src/domain/routeStateReducer.ts";
import { buildAcquiredVehicleAck } from "../services/api/src/domain/agentVoice.ts";

// --- 1) Source guard. ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
const reducer = fs.readFileSync("services/api/src/domain/routeStateReducer.ts", "utf8");

assert.ok(/export async function parseWatchOptOutWithLLM/.test(llm), "parser must be exported");
assert.ok(/WATCH_OPT_OUT_PARSER_JSON_SCHEMA/.test(llm), "strict JSON schema const must exist");
assert.ok(/LLM_WATCH_OPT_OUT_PARSER_ENABLED/.test(llm), "parser must be behind an enable flag");
assert.ok(/export function decideWatchOptOutTurn/.test(reducer), "decision must be centralized in routeStateReducer");
// The keyword pre-filter is GONE (Joe, 2026-08-04 — Mark Kocsis +17168609533). It gated the PARSER
// CALL on a word list, and its miss produced silence plus a watch that keeps firing, which is the
// fail direction AGENTS.md reserves for comprehension. "just picked up a 2023 street glide
// anniversary edition" matched none of its alternatives.
// Asserts the DECLARATIONS are gone, not the words: the removal note in index.ts names the old
// constant on purpose so the history is readable, and a prose mention must not read as the gate.
assert.ok(
  !/function watchOptOutHint\s*\(/.test(index) && !/const WATCH_OPT_OUT_HINT_RE\b/.test(index),
  "the watch-opt-out keyword pre-filter must NOT come back — comprehension belongs to the parser"
);
assert.ok(
  !/if \(!watchOptOutHint\(/.test(index),
  "nothing may gate the watch-opt-out parser call on a word list again"
);
assert.ok(/function pauseInventoryWatches/.test(index) && /function hasActiveInventoryWatch/.test(index), "pause + active-watch helpers must exist");
const callSites = (index.match(/await resolveWatchOptOutReply\(/g) || []).length;
assert.ok(callSites >= 2, `the resolver must be wired in BOTH paths; found ${callSites}`);
// Belt-and-suspenders: explicit STOP + disposition closeout also pause the watch.
assert.ok(/async function applySmsOptOut[\s\S]{0,400}pauseInventoryWatches\(conv\)/.test(index), "explicit STOP must also pause watches");
assert.ok(/function applyCustomerDispositionCloseout[\s\S]{0,400}pauseInventoryWatches\(conv\)/.test(index), "disposition closeout must also pause watches");
// The watch notification now invites opt-out — via the shared buildWatchAvailableReply (agentVoice.ts),
// which both watch-fire sites route through. It also ASKS whether they're still looking (Joe, 2026-06-26).
const agentVoice = fs.readFileSync("services/api/src/domain/agentVoice.ts", "utf8");
assert.ok(/take you off the list/.test(agentVoice), "the watch notification (buildWatchAvailableReply) must tell customers they can opt out");
assert.ok(/still looking/i.test(agentVoice), "the watch notification must ask whether they're still looking");
assert.ok(/buildWatchAvailableReply\(/.test(index), "the watch-fire notification must route through buildWatchAvailableReply");

// --- 2) Decision-table coverage (pure). ---
type Kind = "acknowledge_and_close" | "pause_watch" | "none";
type Row = { id: string; input: Parameters<typeof decideWatchOptOutTurn>[0]; kind: Kind };
const ok = { hasActiveWatch: true, parserAccepted: true, intent: "watch_opt_out" as string | null, confidence: 0.9, confidenceMin: 0.7 };
const got1 = { ...ok, intent: "acquired_vehicle" as string | null };
const rows: Row[] = [
  { id: "accepted_confident", input: { ...ok }, kind: "pause_watch" },
  { id: "at_floor", input: { ...ok, confidence: 0.7 }, kind: "pause_watch" },
  { id: "below_floor", input: { ...ok, confidence: 0.69 }, kind: "none" },
  { id: "intent_none", input: { ...ok, intent: "none" }, kind: "none" },
  { id: "not_accepted", input: { ...ok, parserAccepted: false }, kind: "none" },
  { id: "no_active_watch", input: { ...ok, hasActiveWatch: false }, kind: "none" },
  // The acquisition arm (Joe, 2026-08-04): "they bought one" is not "stop the alerts".
  { id: "acquired_confident", input: { ...got1 }, kind: "acknowledge_and_close" },
  { id: "acquired_at_floor", input: { ...got1, confidence: 0.7 }, kind: "acknowledge_and_close" },
  // Closing a live lead is the expensive mistake, so every uncertainty still lands on none.
  { id: "acquired_below_floor", input: { ...got1, confidence: 0.69 }, kind: "none" },
  { id: "acquired_not_accepted", input: { ...got1, parserAccepted: false }, kind: "none" },
  { id: "acquired_no_active_watch", input: { ...got1, hasActiveWatch: false }, kind: "none" },
  { id: "acquired_unknown_intent", input: { ...got1, intent: "bought_a_boat" }, kind: "none" }
];
for (const r of rows) {
  const got = decideWatchOptOutTurn(r.input).kind;
  assert.equal(got, r.kind, `decision[${r.id}] expected ${r.kind}, got ${got}`);
}

// --- 2b) The deferred closeout: armed by the acquisition turn, fired only by a real SEND. ---
// Joe, 2026-08-04: "After we send draft and it goes through it should close the lead." A draft is a
// proposal until staff release it, so nothing may close at draft time.
{
  const ARMED = 1_000_000;
  const base = { armed: true, armedAtMs: ARMED, lastInboundAtMs: ARMED - 5_000, alreadyClosed: false };
  const sendRows: Array<{ id: string; input: typeof base; kind: "close_lead" | "none"; clearArm: boolean }> = [
    { id: "sent_after_arm", input: { ...base }, kind: "close_lead", clearArm: true },
    { id: "nothing_armed", input: { ...base, armed: false }, kind: "none", clearArm: false },
    { id: "already_closed", input: { ...base, alreadyClosed: true }, kind: "none", clearArm: true },
    { id: "undatable_arm", input: { ...base, armedAtMs: NaN }, kind: "none", clearArm: true },
    // The load-bearing refusal: they wrote back before we sent, so they are re-engaged.
    { id: "customer_replied_since", input: { ...base, lastInboundAtMs: ARMED + 1 }, kind: "none", clearArm: true },
    { id: "no_inbound_at_all", input: { ...base, lastInboundAtMs: null }, kind: "close_lead", clearArm: true }
  ];
  for (const r of sendRows) {
    const d = decidePendingCloseoutOnSend(r.input);
    assert.equal(d.kind, r.kind, `closeout-on-send[${r.id}] expected ${r.kind}, got ${d.kind}`);
    assert.equal(d.clearArm, r.clearArm, `closeout-on-send[${r.id}] clearArm expected ${r.clearArm}`);
    assert.ok(d.why.length > 0, `closeout-on-send[${r.id}] must explain itself`);
  }
}

// --- 2c) The acknowledgement copy: acknowledge, offer help with the bike, name it only if they did. ---
{
  const named = buildAcquiredVehicleAck("2023 Street Glide Anniversary Edition");
  assert.ok(/congrats/i.test(named), "the acknowledgement must actually acknowledge the purchase");
  assert.ok(named.includes("2023 Street Glide Anniversary Edition"), "it must name the bike they named");
  assert.ok(/parts|service|gear/i.test(named), "it must offer help with the bike (Joe's ask)");
  assert.ok(/off the alert/i.test(named), "it must tell them they are off the alert list");

  const blank = buildAcquiredVehicleAck("");
  assert.ok(/congrats/i.test(blank) && /parts|service|gear/i.test(blank), "the un-named form still congratulates and offers help");
  assert.ok(!/undefined|null/i.test(blank), "a missing bike name must never leak into the copy");
  // Never invent a bike: with nothing named this turn, the copy stays generic rather than guessing
  // from the thread — the over-attachment trap passesModelRelevanceGuard exists for.
  assert.ok(!/street glide/i.test(blank), "with no bike named, the copy must not name one");
}

// --- 3) LLM coverage + adversarial negatives (gated; skips cleanly). ---
const optOut = ["take me off the list please", "you can stop the alerts, not looking anymore"];
// Saying they GOT one is the acquisition arm, not a bare opt-out. The first is Mark Kocsis's exact
// live message (+17168609533, 2026-08-04) — the one the old keyword gate never even sent to a parser.
const acquired = [
  "Thanks for keeping me in mind but I actually just picked up a 2023 street glide anniversary edition.",
  "no thanks, I already bought one",
  "ended up buying a Road Glide from another dealer last week",
  "picked mine up saturday!"
];
// Must NOT remove the watch: continued interest, a question, a deferral, or a bike they're SELLING.
const keepWatch = ["yes! send me details", "what's the price?", "not right now, maybe next month", "thinking about selling my Sportster"];

let ran = 0;
let safe = 0;
let acq = 0;
for (const text of optOut) {
  const v = await parseWatchOptOutWithLLM({ text });
  if (!v) continue;
  ran++;
  assert.equal(v.intent, "watch_opt_out", `"${text}" should be watch_opt_out, got ${v.intent}`);
}
for (const text of acquired) {
  const v = await parseWatchOptOutWithLLM({ text });
  if (!v) continue;
  acq++;
  assert.equal(v.intent, "acquired_vehicle", `"${text}" should be acquired_vehicle, got ${v.intent}`);
  assert.ok(
    decideWatchOptOutTurn({ hasActiveWatch: true, parserAccepted: true, intent: v.intent, confidence: v.confidence ?? 0, confidenceMin: 0.7 }).kind ===
      "acknowledge_and_close",
    `"${text}" must reach the acknowledge-and-close arm (confidence ${v.confidence})`
  );
}
for (const text of keepWatch) {
  const v = await parseWatchOptOutWithLLM({ text });
  if (!v) continue;
  safe++;
  assert.notEqual(v.intent, "watch_opt_out", `ADVERSARIAL: "${text}" must NOT opt out of the watch`);
  assert.notEqual(v.intent, "acquired_vehicle", `ADVERSARIAL: "${text}" must NOT close the lead`);
}
// The bike name must come from THIS message and nowhere else.
{
  const v = await parseWatchOptOutWithLLM({
    text: "picked one up over the weekend, thanks though",
    history: [{ direction: "out", body: "A 2019 Road Glide Special just landed — want a look?" }]
  });
  if (v) {
    acq++;
    assert.ok(
      !/road glide/i.test(String(v.vehicle ?? "")),
      `the bike name must come from the customer's own words, not our alert (got "${v.vehicle}")`
    );
  }
}

console.log(
  ran === 0 && safe === 0 && acq === 0
    ? `PASS watch opt-out eval (source guard + ${rows.length} decision rows + closeout-on-send table + ack copy; LLM skipped — parser disabled)`
    : `PASS watch opt-out eval (source guard + ${rows.length} decision rows + closeout-on-send table + ack copy + ` +
      `${ran}/${optOut.length} opt-out + ${acq}/${acquired.length + 1} acquired-vehicle + ${safe}/${keepWatch.length} keep-watch cases)`
);
