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
import { decideWatchOptOutTurn } from "../services/api/src/domain/routeStateReducer.ts";

// --- 1) Source guard. ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
const reducer = fs.readFileSync("services/api/src/domain/routeStateReducer.ts", "utf8");

assert.ok(/export async function parseWatchOptOutWithLLM/.test(llm), "parser must be exported");
assert.ok(/WATCH_OPT_OUT_PARSER_JSON_SCHEMA/.test(llm), "strict JSON schema const must exist");
assert.ok(/LLM_WATCH_OPT_OUT_PARSER_ENABLED/.test(llm), "parser must be behind an enable flag");
assert.ok(/export function decideWatchOptOutTurn/.test(reducer), "decision must be centralized in routeStateReducer");
assert.ok(/function watchOptOutHint/.test(index) && /WATCH_OPT_OUT_HINT_RE/.test(index), "pre-filter hint must exist");
assert.ok(/function pauseInventoryWatches/.test(index) && /function hasActiveInventoryWatch/.test(index), "pause + active-watch helpers must exist");
const callSites = (index.match(/await resolveWatchOptOutReply\(/g) || []).length;
assert.ok(callSites >= 2, `the resolver must be wired in BOTH paths; found ${callSites}`);
// Belt-and-suspenders: explicit STOP + disposition closeout also pause the watch.
assert.ok(/async function applySmsOptOut[\s\S]{0,400}pauseInventoryWatches\(conv\)/.test(index), "explicit STOP must also pause watches");
assert.ok(/function applyCustomerDispositionCloseout[\s\S]{0,400}pauseInventoryWatches\(conv\)/.test(index), "disposition closeout must also pause watches");
// The watch notification now invites opt-out.
assert.ok(/stop these alerts/.test(index), "the watch notification must tell customers they can opt out");

// --- 2) Decision-table coverage (pure). ---
type Row = { id: string; input: Parameters<typeof decideWatchOptOutTurn>[0]; kind: "pause_watch" | "none" };
const ok = { hasActiveWatch: true, parserAccepted: true, intent: "watch_opt_out" as string | null, confidence: 0.9, confidenceMin: 0.7 };
const rows: Row[] = [
  { id: "accepted_confident", input: { ...ok }, kind: "pause_watch" },
  { id: "at_floor", input: { ...ok, confidence: 0.7 }, kind: "pause_watch" },
  { id: "below_floor", input: { ...ok, confidence: 0.69 }, kind: "none" },
  { id: "intent_none", input: { ...ok, intent: "none" }, kind: "none" },
  { id: "not_accepted", input: { ...ok, parserAccepted: false }, kind: "none" },
  { id: "no_active_watch", input: { ...ok, hasActiveWatch: false }, kind: "none" }
];
for (const r of rows) {
  const got = decideWatchOptOutTurn(r.input).kind;
  assert.equal(got, r.kind, `decision[${r.id}] expected ${r.kind}, got ${got}`);
}

// --- 3) LLM coverage + adversarial negatives (gated; skips cleanly). ---
const optOut = ["take me off the list please", "no thanks, I already bought one", "you can stop the alerts, not looking anymore"];
// Must NOT remove the watch: continued interest, a question, or a deferral.
const keepWatch = ["yes! send me details", "what's the price?", "not right now, maybe next month"];

let ran = 0;
let safe = 0;
for (const text of optOut) {
  const v = await parseWatchOptOutWithLLM({ text });
  if (!v) continue;
  ran++;
  assert.equal(v.intent, "watch_opt_out", `"${text}" should be watch_opt_out, got ${v.intent}`);
}
for (const text of keepWatch) {
  const v = await parseWatchOptOutWithLLM({ text });
  if (!v) continue;
  safe++;
  assert.notEqual(v.intent, "watch_opt_out", `ADVERSARIAL: "${text}" must NOT opt out of the watch`);
}

console.log(
  ran === 0 && safe === 0
    ? `PASS watch opt-out eval (source guard + ${rows.length} decision rows; LLM skipped — parser disabled)`
    : `PASS watch opt-out eval (source guard + ${rows.length} decision rows + ${ran}/${optOut.length} opt-out + ${safe}/${keepWatch.length} keep-watch cases)`
);
