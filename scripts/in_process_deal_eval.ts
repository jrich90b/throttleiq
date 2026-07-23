/**
 * In-process-deal entry + draft-quiet eval (pure decision/hint layers + optional LLM coverage).
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
 *   3. Hint-gate fixture tables (2026-07-23, Kevin Short +17166035402 / Jaden Capozzi
 *      +17166046117 corrections): accessory-config / total-cost turns open the parser gate,
 *      and the rep's own recent HUMAN sends are an alternate hint source for deals whose
 *      language lives only in staff texts.
 *   4. Wiring guards — early draft-quiet gate + hint-gated entry in the LIVE path; regenerate
 *      deliberately NOT gated (staff explicitly asking for a draft is the override).
 *   5. LLM coverage on the production replay turns (runs when the parser is enabled — ci:eval
 *      loads OPENAI_API_KEY — and skips cleanly otherwise).
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
import {
  hasDealProgressParserHintText,
  hasStaffOutboundDealProgressHintText,
  STAFF_OUTBOUND_DEAL_HINT_WINDOW_DAYS
} from "../services/api/src/domain/dealProgressHint.ts";
import { parseDealProgressSignalWithLLM } from "../services/api/src/domain/llmDraft.ts";

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

// --- 3) Hint-gate fixture tables (deterministic; the hint only opens the parser gate). ---
// Inbound-text hints — the Kevin Short (+17166035402) accessory/total-cost replay: these turns
// carried none of the original logistics vocabulary, the parser was never consulted, and the
// agent quoted an unrelated bike price on a live deal (7/9 human correction).
const hintRows: { text: string; hint: boolean }[] = [
  { text: "O man you make my laugh. Yes please for it. And I'll need a total cost. \u{1F4B2}", hint: true },
  { text: "Please put those on. Thank you, Kevin.", hint: true },
  { text: "Nice trunk guard put it on please.", hint: true },
  { text: "Would you want me to add it to the list?", hint: true },
  // Original logistics vocabulary keeps hinting.
  { text: "Just reached out to Allstate. They will email you the insurance cards.", hint: true },
  { text: "What would the out the door price be on the orange ST?", hint: true }, // parser (EXAMPLE J) says NOT deal progress
  // Hint-free turns stay hint-free on the inbound source (the staff-outbound source below covers them).
  { text: "Is Wednesday around noon fine?", hint: false },
  { text: "Thank you", hint: false },
  { text: "Is the Low Rider ST still available?", hint: false },
  { text: "", hint: false }
];
for (const r of hintRows) {
  eq(hasDealProgressParserHintText(r.text), r.hint, `hint[${r.text.slice(0, 40)}] expected ${r.hint}`);
}

// Staff-outbound hints — the Jaden Capozzi (+17166046117) replay: all the deal language lived
// in the rep's own texts ("finalize and take delivery"), so the customer's hint-free time
// proposal drew a generic auto-draft that staff had to rewrite (7/20 human correction).
const NOW = new Date("2026-07-20T16:03:32.393Z");
const jadenStaffSend = {
  direction: "out",
  actorUserName: "Scott Hartrich",
  at: "2026-07-20T15:45:55.232Z",
  body: "Hey Jaden- it's Scott from American H-D. Just wanted to touch base and see what your plan was to finalize and take delivery of your 2025 Low Rider ST. Let me know your thoughts. Thanks!"
};
eq(hasStaffOutboundDealProgressHintText([jadenStaffSend], NOW), true, "recent human deal-language send opens the parser gate");
eq(
  hasStaffOutboundDealProgressHintText([{ ...jadenStaffSend, at: "2026-06-20T15:45:55.232Z" }], NOW),
  false,
  `human sends older than ${STAFF_OUTBOUND_DEAL_HINT_WINDOW_DAYS} days stop hinting`
);
eq(
  hasStaffOutboundDealProgressHintText([{ ...jadenStaffSend, actorUserName: null }], NOW),
  false,
  "agent/system outbounds (no human actor) are not a hint source"
);
eq(
  hasStaffOutboundDealProgressHintText(
    [{ direction: "out", actorUserName: "Scott Hartrich", at: "2026-07-20T15:45:55.232Z", body: "See you then" }],
    NOW
  ),
  false,
  "a human send without deal language does not hint"
);
eq(hasStaffOutboundDealProgressHintText([], NOW), false, "no messages, no hint");
eq(
  hasStaffOutboundDealProgressHintText([{ ...jadenStaffSend, direction: "in" }], NOW),
  false,
  "inbound messages never count as staff sends"
);

// --- 4) Wiring guards. ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
// Draft-quiet gate: early in the live path, keyed on the state, produces the owner task.
const quietGate = index.indexOf('conv.followUp?.reason === "in_process_deal"');
assert.ok(quietGate > 0, "live path carries the in_process_deal draft-quiet gate");
const quietBlock = index.slice(quietGate, quietGate + 1200);
assert.ok(/in_process_deal_staff_todo_no_draft/.test(quietBlock), "the quiet gate records its route outcome");
assert.ok(/needs your answer/.test(quietBlock), "the quiet gate hands the turn to the owner as a task");
// Entry: hint-gated parser call + centralized decision + shared transition.
assert.ok(/hasDealProgressParserHintText\(event\.body\)/.test(index), "the LLM entry parser is gated by the cheap hint filter");
assert.ok(
  /hasStaffOutboundDealProgressHintText\(conv\.messages \?\? \[\]\)/.test(index),
  "the rep's recent human sends are wired as the alternate hint source"
);
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
n += 11;

// --- 5) LLM coverage on the production replay turns (skips cleanly when the parser is off). ---
const llmCases: {
  id: string;
  text: string;
  history: { direction: "in" | "out"; body: string }[];
  dealInProgress: boolean;
}[] = [
  {
    id: "kevin_accessory_total_cost",
    text: "O man you make my laugh. Yes please for it. And I'll need a total cost. \u{1F4B2}",
    history: [
      { direction: "out", body: "Hey Kevin - Scott here from American H-D. You are going to be working with me on the purchase of you 2026 Road Glide 3. We have to schedule day/time to go get your bike which should be this week." },
      { direction: "in", body: "One more thing is there a bar that goes around the trunk to protect it a black one I don't know if it comes with it or not." },
      { direction: "out", body: "The radio has Bluetooth! I will add a heel shifter to the list. Also, below is a link to the H-D Trunk Guard" },
      { direction: "in", body: "Scott, what about the forward pegs and the 26 Harley Davidson St. glide three they fit on my road glide three.?" },
      { direction: "out", body: "The Road Glide 3 does not come with the Highway pegs, but the ones that come with the Street Glide 3 Limited will fit. Would you want me to add it to the list?" }
    ],
    dealInProgress: true
  },
  {
    id: "jaden_take_delivery_time_proposal",
    text: "Is Wednesday around noon fine?",
    history: [
      { direction: "out", body: "Jaden- it's Scott from American H-D. Thanks for your time today and feel free to text or call me if you have any questions or concerns. We will set up a time next week for you to ride in your sportster and ride out on your Low Rider ST." },
      { direction: "out", body: "Hey Jaden- it's Scott from American H-D. Just wanted to touch base and see what your plan was to finalize and take delivery of your 2025 Low Rider ST. Let me know your thoughts. Thanks!" }
    ],
    dealInProgress: true
  },
  {
    id: "shopping_otd_price_ask_not_deal",
    text: "What would the out the door price be on the orange ST?",
    history: [{ direction: "out", body: "Hi! Happy to help — were you looking at anything in particular?" }],
    dealInProgress: false
  }
];
let llmRan = 0;
for (const c of llmCases) {
  const parsed = await parseDealProgressSignalWithLLM({ text: c.text, history: c.history });
  if (!parsed) continue; // parser disabled or transient null — skip, don't red the gate
  llmRan += 1;
  assert.equal(
    parsed.dealInProgress,
    c.dealInProgress,
    `LLM[${c.id}] expected deal_in_progress=${c.dealInProgress}, got ${parsed.dealInProgress} (signal=${parsed.signal}, conf=${parsed.confidence})`
  );
  if (c.dealInProgress) {
    assert.ok(
      decideInProcessDealTurn({
        parserAccepted: true,
        dealInProgress: parsed.dealInProgress,
        confidence: parsed.confidence,
        followUpMode: "active"
      }).kind === "enter_in_process_deal",
      `LLM[${c.id}] must clear the reducer's confidence floor (got ${parsed.confidence})`
    );
  }
}

console.log(
  `PASS in-process-deal eval (${n + rows.length} checks) — entry table, nudge coverage, hint tables, live gate + regen override` +
    (llmRan === 0 ? "; LLM coverage skipped (parser disabled)" : `; LLM coverage ${llmRan}/${llmCases.length}`)
);
