/**
 * In-process-deal entry + draft-quiet eval (pure, no LLM).
 *
 * Pins the Joe-approved behavior (2026-07-02; the Jeff Hollfelder +17164182619 / Gary
 * Busenlehner +17163168664 class): a customer turn that is deal LOGISTICS on a staff-worked
 * purchase (insurance/payoff/delivery/paperwork/accessory install) transitions the conversation
 * into in_process_deal — per-turn auto-drafts stop (staff answer with off-system deal facts;
 * 5/7 staff-corrected drafts in the 7/2 audit were this class), the owner gets a reply-needed
 * task, and the existing quiet-deal nudge + stale-handoff nets keep coverage.
 *
 * Layers:
 *   1. decideInProcessDealTurn decision table — high confidence floor, protected modes and
 *      sold/closed convs untouched, parser-acceptance required (disabled LLM = today's behavior).
 *   2. isInProcessDealLead covers the new reason (the 3-business-day owner nudge applies).
 *   3. Wiring guards — early draft-quiet gate + hint-gated entry in the LIVE path; regenerate
 *      deliberately NOT gated (staff explicitly asking for a draft is the override).
 *
 * Run: npx tsx scripts/in_process_deal_eval.ts
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import * as path from "node:path";

import {
  decideInProcessDealTurn,
  IN_PROCESS_DEAL_CONFIDENCE_FLOOR
} from "../services/api/src/domain/routeStateReducer.ts";

process.env.CONVERSATIONS_DB_PATH = path.join(os.tmpdir(), `in-process-deal-eval-${process.pid}.json`);
const { isInProcessDealLead } = (await import("../services/api/src/domain/conversationStore.ts")) as any;

let n = 0;
const eq = (a: unknown, b: unknown, m: string) => {
  assert.deepEqual(a, b, m);
  n++;
};

// --- 1) Decision table. ---
type Row = {
  id: string;
  input: Parameters<typeof decideInProcessDealTurn>[0];
  enter: boolean;
};
const rows: Row[] = [
  // The Jeff Hollfelder replay: confident deal-logistics turn on an active conv → enter.
  { id: "insurance_delivery_turn_enters", input: { parserAccepted: true, dealInProgress: true, confidence: 0.95, followUpMode: "active" }, enter: true },
  { id: "at_floor_enters", input: { parserAccepted: true, dealInProgress: true, confidence: IN_PROCESS_DEAL_CONFIDENCE_FLOOR, followUpMode: "active" }, enter: true },
  // Conservative gates.
  { id: "below_floor_untouched", input: { parserAccepted: true, dealInProgress: true, confidence: 0.7, followUpMode: "active" }, enter: false },
  { id: "parser_not_accepted_untouched", input: { parserAccepted: false, dealInProgress: true, confidence: 0.95, followUpMode: "active" }, enter: false },
  { id: "not_deal_progress_untouched", input: { parserAccepted: true, dealInProgress: false, confidence: 0.95, followUpMode: "active" }, enter: false },
  { id: "already_handed_off_untouched", input: { parserAccepted: true, dealInProgress: true, confidence: 0.95, followUpMode: "manual_handoff" }, enter: false },
  { id: "paused_indefinite_untouched", input: { parserAccepted: true, dealInProgress: true, confidence: 0.95, followUpMode: "paused_indefinite" }, enter: false },
  { id: "sold_conv_is_post_sale_machinery", input: { parserAccepted: true, dealInProgress: true, confidence: 0.95, followUpMode: "active", saleRecorded: true }, enter: false },
  { id: "closed_conv_untouched", input: { parserAccepted: true, dealInProgress: true, confidence: 0.95, followUpMode: "active", conversationClosed: true }, enter: false }
];
for (const r of rows) {
  eq(
    decideInProcessDealTurn(r.input).kind === "enter_in_process_deal",
    r.enter,
    `decideInProcessDealTurn[${r.id}] expected enter=${r.enter}`
  );
}
assert.ok(IN_PROCESS_DEAL_CONFIDENCE_FLOOR >= 0.75, "entry keeps a high parser-confidence floor");
n++;

// --- 2) The nudge net covers the new reason. ---
eq(
  isInProcessDealLead({ followUp: { reason: "in_process_deal" }, followUpCadence: { kind: "standard" } }),
  true,
  "in_process_deal reason is covered by the quiet-deal owner nudge"
);
eq(
  isInProcessDealLead({ followUp: { reason: "in_process_deal" }, followUpCadence: { kind: "post_sale" } }),
  false,
  "post-sale cadence stays post-sale machinery's job (unchanged exclusion)"
);

// --- 3) Wiring guards. ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
// Draft-quiet gate: early in the live path, keyed on the state, produces the owner task.
const quietGate = index.indexOf('conv.followUp?.reason === "in_process_deal"');
assert.ok(quietGate > 0, "live path carries the in_process_deal draft-quiet gate");
const quietBlock = index.slice(quietGate, quietGate + 1200);
assert.ok(/in_process_deal_staff_todo_no_draft/.test(quietBlock), "the quiet gate records its route outcome");
assert.ok(/needs your answer/.test(quietBlock), "the quiet gate hands the turn to the owner as a task");
// Entry: hint-gated parser call + centralized decision + shared transition.
assert.ok(/hasDealProgressParserHintText\(event\.body\)/.test(index), "the LLM entry parser is gated by the cheap hint filter");
assert.ok(/safeLlmParse\("deal_progress_parser"/.test(index), "entry uses the typed deal-progress parser via safeLlmParse");
assert.ok(/decideInProcessDealTurn\(\{/.test(index), "entry consults the centralized reducer decision");
assert.ok(/applyInProcessDealTransition\(conv, /.test(index), "entry applies the shared transition helper");
const transition = index.slice(index.indexOf("function applyInProcessDealTransition"), index.indexOf("function applyInProcessDealTransition") + 700);
assert.ok(/setFollowUpMode\(conv, "manual_handoff", "in_process_deal"\)/.test(transition), "transition enters the handoff family");
assert.ok(/stopFollowUpCadence\(conv, "in_process_deal"\)/.test(transition), "transition quiets the cadence");
// Regenerate is the staff override: no in_process_deal gate in the regen path.
const regenStart = index.indexOf('app.post("/conversations/:id/regenerate"');
assert.ok(regenStart > 0, "regen route present");
assert.ok(
  !index.slice(regenStart, regenStart + 200000).includes("in_process_deal_staff_todo_no_draft"),
  "regenerate is deliberately NOT gated — staff asking for a draft is the override"
);
n += 10;

console.log(`PASS in-process-deal eval (${n + rows.length} checks) — entry table, nudge coverage, live gate + regen override`);
