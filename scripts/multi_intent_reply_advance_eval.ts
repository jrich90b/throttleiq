/**
 * A MULTI-INTENT ANSWER HAS TO END BY ASKING SOMETHING (charter C1.7).
 *
 * Mike Wolf, +17164323990, 2026-08-07 18:02 — "Thanks Scott, I've already seen one but I'll be by
 * soon to get a price on a trade in." He told us he was coming in. The deterministic multi-intent
 * composer (price + trade) answered:
 *
 *   "The listed price on the new 2026 FLHD Deadwood is $17,999. Final numbers can change with tax,
 *    fees, trade-in, and financing. For the trade value, we can start with an estimate based on the
 *    bike details and finalize it in person."
 *
 * Three sentences, no question. The rep threw it away and typed "Sounds good, let me know when you
 * plan on stopping by with your bike." REPRODUCED against the DEPLOYED build on 2026-08-09 (shadow
 * replay of that exact turn), so this is current behaviour, not a stale echo.
 *
 * C1.7: "Every customer-facing reply ends with ONE question that advances the lead… This rule binds
 * our deterministic TEMPLATES exactly as it binds the LLM composer." Only one of the composer's four
 * lines ever asks anything (schedulingLine), and it needs `wantsScheduling` — which "I'll be by
 * soon" does not set. So whether this reply asked anything was decided by which lines happened to
 * fire, which is precisely the gap the charter names.
 *
 * WHAT THIS EVAL PINS — the DECISION (does the reply end by advancing?), never the wording:
 *  1) EXECUTION: run orchestrateInbound over Mike's real turn and assert the draft ends in a
 *     question. This is the wiring proof — a source pin cannot tell whether the call is reached
 *     (SKILL trap 2), so the composer is actually run.
 *  2) THE CEILING: a composed reply that already asks something is left alone. "One question. Never
 *     two." Executed through the composer as well (a scheduling turn), not asserted on source.
 *  3) THE FOUR SUPPRESSIONS: grief / not-interested / already-bought / already-booked never get
 *     pushed — the same referee the LLM arm uses.
 *  4) The question itself is a question, is charter-clean, and offers a choice of two.
 *
 * Run: npx tsx scripts/multi_intent_reply_advance_eval.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { InboundMessageEvent } from "../services/api/src/domain/types.ts";
import { checkMessage } from "./voice_charter_audit.ts";

process.env.OPENAI_API_KEY ||= "test";
process.env.DEALER_PROFILE_PATH ||= "services/api/data/dealer_profile.json";

const evalDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "throttleiq-multi-intent-advance-"));
await fs.cp("services/api/data", evalDataDir, { recursive: true });
process.env.DATA_DIR = evalDataDir;

const { orchestrateInbound } = await import("../services/api/src/domain/orchestrator.ts");
const { templateAdvanceTail } = await import("../services/api/src/domain/draftChannelRules.ts");
const { buildVisitAdvanceQuestion } = await import("../services/api/src/domain/workflowRegressionGuards.ts");

let n = 0;
const ok = (cond: boolean, msg: string) => {
  assert.equal(cond, true, msg);
  n++;
};

const now = new Date().toISOString();

/** Mike's lead record as the store actually holds it (walk-in ADF, ref 11750). */
const mikeCtx = (extra: Record<string, unknown> = {}) => ({
  lead: {
    firstName: "Mike",
    source: "Walk In",
    vehicle: {
      year: "2026",
      make: "Harley-Davidson",
      model: "FLHD Deadwood",
      condition: "new"
    }
  } as any,
  ...extra
});

const mikeEvent = (body: string, id: string): InboundMessageEvent => ({
  channel: "sms",
  provider: "twilio",
  from: "+17164323990",
  to: "+17164032516",
  body,
  providerMessageId: id,
  receivedAt: now
});

const MIKE_TURN = "Thanks Scott, I've already seen one but I'll be by soon to get a price on a trade in.";

/** Does the reply END by asking? Trailing whitespace only — a mid-draft "?" is not an ending. */
function endsByAsking(text: string): boolean {
  return String(text ?? "").trim().endsWith("?");
}

function questionCount(text: string): number {
  return (String(text ?? "").match(/\?/g) ?? []).length;
}

// ---------------------------------------------------------------------------
// 1) EXECUTION — the turn that named this, through the real composer
// ---------------------------------------------------------------------------
{
  const res: any = await orchestrateInbound(mikeEvent(MIKE_TURN, "multi-intent-advance-1"), [], mikeCtx());
  const draft = String(res?.draft ?? "");
  ok(draft.length > 0, "Mike's turn must still produce a draft");
  ok(
    /trade/i.test(draft),
    `the multi-intent composer must still answer the trade half — got: ${draft}`
  );
  ok(
    endsByAsking(draft),
    `C1.7: a multi-intent answer must END by asking something — got: ${draft}`
  );
  ok(
    questionCount(draft) === 1,
    `the ceiling is ONE question, never two — got ${questionCount(draft)}: ${draft}`
  );
}

// ---------------------------------------------------------------------------
// 2) THE CEILING, through the composer — a turn whose own lines already ask
// ---------------------------------------------------------------------------
{
  // Scheduling + trade: the schedulingLine arm asks on its own, so nothing may be appended.
  const res: any = await orchestrateInbound(
    mikeEvent("Can I stop in Saturday to get a price on a trade in?", "multi-intent-advance-2"),
    [],
    mikeCtx()
  );
  const draft = String(res?.draft ?? "");
  ok(draft.length > 0, "the scheduling+trade turn must still produce a draft");
  ok(
    questionCount(draft) === 1,
    `a composer reply that already asks must not gain a second question — got ${questionCount(draft)}: ${draft}`
  );
  ok(
    !draft.includes(buildVisitAdvanceQuestion()),
    `the advance tail must not be appended to a reply that already asks — got: ${draft}`
  );
}

// ---------------------------------------------------------------------------
// 3) THE DECISION TABLE for templateAdvanceTail — suppressions + ceiling
// ---------------------------------------------------------------------------
const ASK = "Do you want to swing by this week, or is the weekend easier?";
const STATEMENT = "The listed price on the 2026 FLHD Deadwood is $17,999.";
const ALREADY_ASKS = "I am not seeing one in stock right now. Do you want me to keep an eye out?";

const tailCases: { label: string; draft: string; ask: string; ctx: any; expectTail: boolean }[] = [
  { label: "clean statement gets the ask", draft: STATEMENT, ask: ASK, ctx: {}, expectTail: true },
  { label: "ceiling: draft already asks", draft: ALREADY_ASKS, ask: ASK, ctx: {}, expectTail: false },
  { label: "suppression: needsEmpathy", draft: STATEMENT, ask: ASK, ctx: { needsEmpathy: true }, expectTail: false },
  {
    label: "suppression: dispositionClosing",
    draft: STATEMENT,
    ask: ASK,
    ctx: { dispositionClosing: true },
    expectTail: false
  },
  {
    label: "suppression: alreadyPurchased",
    draft: STATEMENT,
    ask: ASK,
    ctx: { alreadyPurchased: true },
    expectTail: false
  },
  {
    label: "suppression: appointment booked",
    draft: STATEMENT,
    ask: ASK,
    ctx: { appointment: { status: "booked" } },
    expectTail: false
  },
  {
    label: "suppression: appointment has a start time",
    draft: STATEMENT,
    ask: ASK,
    ctx: { appointment: { startLocal: "2026-08-12T14:00" } },
    expectTail: false
  },
  {
    label: "a cancelled appointment is not a booking — still asks",
    draft: STATEMENT,
    ask: ASK,
    ctx: { appointment: { status: "cancelled" } },
    expectTail: true
  },
  { label: "blank ask appends nothing", draft: STATEMENT, ask: "   ", ctx: {}, expectTail: false },
  { label: "blank draft appends nothing", draft: "   ", ask: ASK, ctx: {}, expectTail: false }
];

for (const c of tailCases) {
  const tail = templateAdvanceTail({ draft: c.draft, ask: c.ask, ctx: c.ctx });
  ok(
    (tail.trim().length > 0) === c.expectTail,
    `${c.label}: expected ${c.expectTail ? "a tail" : "no tail"} — got ${JSON.stringify(tail)}`
  );
  if (c.expectTail) {
    ok(tail.startsWith(" "), `${c.label}: the tail must carry its own separating space`);
    ok(
      questionCount(`${c.draft}${tail}`) === 1,
      `${c.label}: appending must leave exactly one question`
    );
  }
}

// ---------------------------------------------------------------------------
// 4) THE QUESTION ITSELF
// ---------------------------------------------------------------------------
{
  const q = buildVisitAdvanceQuestion();
  ok(q.trim().endsWith("?"), "the visit-advance question must be a question");
  ok(questionCount(q) === 1, "the visit-advance question must be exactly one question");
  ok(q.includes(", or "), "C1.7 prefers a choice of two — the question must offer one");
  ok(
    checkMessage(q, { firstOutbound: false, smsLike: true, staffHasSent: false }).filter(v =>
      ["banned_phrase", "doubled_article", "bare_check_in", "dropped_verb"].includes(v.check)
    ).length === 0,
    "the visit-advance question must be charter-clean"
  );
  // The whole reason it is not buildFinanceAckVisitQuestion: this reply may name no unit, so a bare
  // "it" would bind to the customer's own trade bike. No dangling pronoun.
  ok(!/\bsee it\b/i.test(q), "the visit-advance question must not depend on an unnamed antecedent");
}

await fs.rm(evalDataDir, { recursive: true, force: true });
console.log(`multi_intent_reply_advance_eval: ${n} assertion(s) passed`);
