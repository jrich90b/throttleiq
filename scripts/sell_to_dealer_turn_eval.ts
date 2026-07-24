/**
 * Sell-to-dealer (outright cash sale) turn eval (pure, no LLM).
 *
 * Pins the Josh Kiddy class (+17169831712, 2026-07-23, corpus-replay judge-fail + staff
 * human-correction on the same turn). Staff (in takeover) asked "are you looking into trading
 * the bike in or you want to sell outright?" and the customer answered "Sell it outright."
 * In dealer parlance BOTH options are transactions with US — a trade applies the bike's value
 * toward a purchase, an outright sale is us buying it for cash — so that turn is a live
 * used-inventory ACQUISITION lead. The disposition parser read it as sell_on_own @0.98, which
 * mapped to customer_sell_on_own and CLOSED the conversation, paused the cadence indefinitely,
 * paused inventory watches, and replied "I hear you. If anything changes down the road, just
 * give me a shout." Re-replayed against the deployed dist on 2026-07-24 — it reproduced
 * byte-for-byte, so this was live behavior, not a stale finding.
 *
 * Layers:
 *   1. Decision table — decideSellToDealerTurn fires ONLY on the structured
 *      sell_to_dealer_interest slot, never on a conflicting sell_on_own parse, never below the
 *      confidence floor, and never on a closed/sold lead.
 *   2. Wiring guard — the ONE shared applier is called from BOTH paths (/webhooks/twilio +
 *      /conversations/:id/regenerate), it never closes/pauses (the fail-direction invariant,
 *      encoded), and the shared disposition mapper refuses to emit a sell_on_own closeout when
 *      the acquisition slot is set.
 *
 * Run: npx tsx scripts/sell_to_dealer_turn_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  decideSellToDealerTurn,
  SELL_TO_DEALER_CONFIDENCE_FLOOR
} from "../services/api/src/domain/routeStateReducer.ts";

// --- 1) Decision table (pure). ---
type Row = {
  id: string;
  sellToDealerInterest: boolean;
  disposition: string | null;
  confidence: number | null;
  conversationClosed?: boolean;
  saleRecorded?: boolean;
  fire: boolean;
};
const rows: Row[] = [
  // The production replay: "Sell it outright." answering our own trade-vs-sell question.
  { id: "sell_outright_to_dealer", sellToDealerInterest: true, disposition: "none", confidence: 0.95, fire: true },
  // A confident acquisition read with no disposition at all still fires.
  { id: "null_disposition_fires", sellToDealerInterest: true, disposition: null, confidence: 0.9, fire: true },
  // Below the floor → fail toward today's post-fix behavior (no task; the turn still drafts).
  { id: "below_floor_no_task", sellToDealerInterest: true, disposition: "none", confidence: 0.6, fire: false },
  // Missing confidence is treated as 0 — a task-creating side effect wants a confident read.
  { id: "missing_confidence_no_task", sellToDealerInterest: true, disposition: "none", confidence: null, fire: false },
  // Conflict guard: the two intents are opposites; never fire on a sell_on_own parse.
  { id: "conflicting_sell_on_own_never_fires", sellToDealerInterest: true, disposition: "sell_on_own", confidence: 0.95, fire: false },
  // A genuine sell-it-without-us turn is untouched (still closes out upstream).
  { id: "true_sell_on_own_untouched", sellToDealerInterest: false, disposition: "sell_on_own", confidence: 0.97, fire: false },
  // Closed / sold leads are untouched.
  { id: "closed_conv_untouched", sellToDealerInterest: true, disposition: "none", confidence: 0.95, conversationClosed: true, fire: false },
  { id: "sold_lead_untouched", sellToDealerInterest: true, disposition: "none", confidence: 0.95, saleRecorded: true, fire: false },
  // No acquisition signal → never fire.
  { id: "no_interest_untouched", sellToDealerInterest: false, disposition: "none", confidence: 0.9, fire: false }
];
for (const r of rows) {
  const decision = decideSellToDealerTurn({
    sellToDealerInterest: r.sellToDealerInterest,
    disposition: r.disposition,
    confidence: r.confidence,
    conversationClosed: r.conversationClosed,
    saleRecorded: r.saleRecorded
  });
  assert.equal(
    decision.kind === "sell_to_dealer_appraisal",
    r.fire,
    `decideSellToDealerTurn[${r.id}] expected fire=${r.fire}, got kind=${decision.kind}`
  );
}
assert.ok(
  SELL_TO_DEALER_CONFIDENCE_FLOOR >= 0.7 && SELL_TO_DEALER_CONFIDENCE_FLOOR <= 0.95,
  "confidence floor stays a sane band for a task-creating side effect"
);

// --- 2) Wiring guard. ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");

const applierStart = index.indexOf("function applySellToDealerAppraisalFromDispositionParse");
assert.ok(applierStart > 0, "the shared sell-to-dealer applier must exist in index.ts");
const applierBody = index.slice(applierStart, index.indexOf("function buildFriendlyReachOutClose"));

assert.ok(
  /decideSellToDealerTurn\(/.test(applierBody),
  "the applier must route through the centralized decideSellToDealerTurn decision"
);
// THE fail-direction invariant, encoded: this turn must never suppress the lead. Closing /
// pausing is exactly the bug being fixed.
assert.ok(
  !/closeConversation/.test(applierBody),
  "the sell-to-dealer applier must NEVER close the conversation (that is the bug being fixed)"
);
assert.ok(
  !/paused_indefinite|stopFollowUpCadence|setFollowUpMode/.test(applierBody),
  "the sell-to-dealer applier must NEVER pause the follow-up cadence"
);
assert.ok(
  /addTodo\(/.test(applierBody) && /trade_cash/.test(applierBody),
  "the applier must drop a staff appraisal task and set the existing trade_cash state"
);

// Both reply paths call the ONE shared applier (no mirrored per-path logic).
const applierCalls = index.split("applySellToDealerAppraisalFromDispositionParse(").length - 1;
assert.ok(
  applierCalls >= 4,
  `the definition plus the live, regen and human-mode call sites must all reference the shared applier (found ${applierCalls})`
);
const liveHandler = index.slice(
  index.indexOf('applyDecideSoonCheckInFromDispositionParse(\n      conv,\n      customerDispositionParse')
);
assert.ok(
  /applySellToDealerAppraisalFromDispositionParse\(\s*conv,\s*customerDispositionParse/.test(liveHandler),
  "the LIVE /webhooks/twilio path must call the shared applier with the live disposition parse"
);
assert.ok(
  /applySellToDealerAppraisalFromDispositionParse\(\s*conv,\s*regenCustomerDispositionParse/.test(index),
  "the REGENERATE path must call the shared applier with the regen disposition parse"
);

// The shared disposition mapper refuses to emit a closeout when the acquisition slot is set —
// this is what protects live + regen + human-mode even if a future model still says sell_on_own.
const mapperBody = index.slice(
  index.indexOf("function resolveCustomerDispositionDecision"),
  index.indexOf("function applyInternationalLeadCloseout")
);
assert.ok(
  /sellToDealerInterest/.test(mapperBody),
  "resolveCustomerDispositionDecision must refuse a closeout when sell_to_dealer_interest is set"
);
assert.ok(
  mapperBody.indexOf("sellToDealerInterest") < mapperBody.indexOf('=== "sell_on_own"'),
  "the sell-to-dealer guard must be checked BEFORE the sell_on_own closeout mapping"
);

console.log(
  `PASS sell-to-dealer turn eval — ${rows.length} decision cases (${rows.filter(r => r.fire).length} fire / ${rows.filter(r => !r.fire).length} untouched), floor ${SELL_TO_DEALER_CONFIDENCE_FLOOR}, both-paths wiring + no-close/no-pause invariant`
);
