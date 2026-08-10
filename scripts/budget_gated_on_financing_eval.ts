/**
 * budget_gated_on_financing:eval — "only finance can handle that info" (Joe, 2026-08-10).
 *
 * ORIGIN (+17164208660, Franklin, live 2026-08-10 12:03 ET). On an HDFS credit application for a
 * Street Bob 114 we asked "do you want new, used, or both, and what budget should I target?" and
 * he answered:
 *
 *     "No I want used and I don't know it depends on how much money I have to put down"
 *
 * He answered both halves — used, and "I can't name a number until I know the down payment" — and
 * the next draft asked "any budget range I should target before I pull the short list?". A rep
 * took the thread over before it sent. Joe: *"it should probably hand it to finance, only finance
 * can handle that info."*
 *
 * WHAT THIS PINS
 *  1. The pure decision table (decideBudgetGatedOnFinancingTurn) — the DECISION, not a label.
 *  2. The fail direction: anything short of a confident, on-intent parse leaves today's behavior.
 *  3. That the word list which caused the miss STILL cannot see the sentence — so if someone
 *     "fixes" this by extending the regex instead of the parser, this eval says so out loud.
 *  4. That the clarifier is unchanged by the move out of index.ts (behavior-preserving refactor).
 *  5. Charter C1.7 on the TEMPLATE: the handoff copy must END BY ASKING, and must quote no money.
 */
import assert from "node:assert/strict";
import { decideBudgetGatedOnFinancingTurn } from "../services/api/src/domain/routeStateReducer.ts";
import {
  budgetFinancingDeferralHint,
  budgetGatedOnFinancingConfidenceMin,
  buildBudgetGatedOnFinancingReply
} from "../services/api/src/domain/budgetFinancingDeferral.ts";
import { buildShortListClarifierReply } from "../services/api/src/domain/shortListClarifier.ts";

const FRANKLIN = "No I want used and I don't know it depends on how much money I have to put down";
const MIN = budgetGatedOnFinancingConfidenceMin();

// ── 1. The decision table ──────────────────────────────────────────────────────────────
{
  assert.equal(
    decideBudgetGatedOnFinancingTurn({
      parserAccepted: true,
      intent: "budget_gated_on_financing",
      confidence: 0.9,
      confidenceMin: MIN
    }).kind,
    "finance_handoff",
    "a confident on-intent parse hands the thread to finance"
  );

  // Fail direction: every degraded input leaves today's behavior running.
  const leavesBehaviorAlone = [
    ["parser did not answer", { parserAccepted: false, intent: "budget_gated_on_financing", confidence: 0.99 }],
    ["different intent", { parserAccepted: true, intent: "none", confidence: 0.99 }],
    ["null intent", { parserAccepted: true, intent: null, confidence: 0.99 }],
    ["below the floor", { parserAccepted: true, intent: "budget_gated_on_financing", confidence: MIN - 0.01 }],
    ["NaN confidence", { parserAccepted: true, intent: "budget_gated_on_financing", confidence: Number.NaN }]
  ] as const;
  for (const [label, input] of leavesBehaviorAlone) {
    assert.equal(
      decideBudgetGatedOnFinancingTurn({ ...(input as any), confidenceMin: MIN }).kind,
      "none",
      `${label} => no handoff (unsure must never pull a person into the thread)`
    );
  }

  // Exactly at the floor still fires — the floor is inclusive, and a >= boundary that silently
  // became > would drop the confidence band this handoff actually lives in.
  assert.equal(
    decideBudgetGatedOnFinancingTurn({
      parserAccepted: true,
      intent: "budget_gated_on_financing",
      confidence: MIN,
      confidenceMin: MIN
    }).kind,
    "finance_handoff",
    "confidence exactly at the floor hands off"
  );
}

// ── 2. The pre-filter is a GATE, and it must not drop the turn that caused this ─────────
{
  assert.equal(budgetFinancingDeferralHint(FRANKLIN), true, "Franklin's turn must reach the parser");
  for (const t of [
    "whatever my monthly payment works out to",
    "depends what the bank approves me for",
    "I need to know what I qualify for first",
    "depends on my down payment"
  ]) {
    assert.equal(budgetFinancingDeferralHint(t), true, `the gate must not drop: ${t}`);
  }
  assert.equal(budgetFinancingDeferralHint(""), false, "an empty turn never reaches the parser");
}

// ── 3. The word list that caused the miss is STILL blind — on purpose ───────────────────
// If this ever starts passing, someone widened the regex instead of trusting the parser, which is
// the exact anti-pattern AGENTS.md forbids (comprehend, never regex).
{
  const clarifier = buildShortListClarifierReply(FRANKLIN, /* hasModelContext */ true);
  assert.ok(
    clarifier.reply.includes("budget range I should target"),
    "the clarifier alone STILL asks for a budget on Franklin's turn — the parser, not the word " +
      "list, is what must stop it. Widening the regex to fix this is the wrong repair."
  );
}

// ── 4. The clarifier move out of index.ts was behavior-preserving ───────────────────────
{
  // A plainly-stated budget AND condition leaves nothing left to narrow.
  assert.ok(
    !buildShortListClarifierReply("used, around 15k", true).reply.includes("budget"),
    "a stated budget + condition still suppresses the budget ask"
  );
  // Documented as-is, not endorsed: a budget with no condition word still re-asks budget inside
  // the new/used question. Pre-existing, unchanged by the move, and out of scope for this slice —
  // pinned so the move cannot be blamed for it later.
  assert.ok(
    buildShortListClarifierReply("around 15k", true).reply.includes("what budget should I target"),
    "unchanged pre-existing wart: budget-without-condition still carries the budget ask"
  );
  // No model context and no style hint still asks the family question first.
  assert.ok(
    buildShortListClarifierReply("just looking", false).reply.includes("Grand American Touring"),
    "no model + no style still leads with the family question"
  );
  // Condition named, model known => the budget ask is what remains.
  assert.ok(
    buildShortListClarifierReply("used", true).reply.includes("budget range I should target"),
    "model known + condition given leaves the budget question"
  );
  assert.equal(
    buildShortListClarifierReply("used", true).hasPreferenceHint,
    true,
    "a condition word is still a preference hint"
  );
}

// ── 5. Charter C1.7 + the money rule, on the TEMPLATE ───────────────────────────────────
{
  const reply = buildBudgetGatedOnFinancingReply();
  assert.ok(
    reply.trim().endsWith("?"),
    "C1.7 binds our deterministic templates: the handoff must END BY ASKING, not on a statement"
  );
  assert.equal(
    (reply.match(/\?/g) ?? []).length,
    1,
    "exactly one question — C1.7's ceiling is one, and two questions is a worse ask than one"
  );
  assert.ok(reply.includes(" or "), "prefer a choice of two, per C1.7");
  assert.ok(
    !/\$|\d\s*%|\bdown payment of\b|\bper month\b/i.test(reply),
    "the agent quotes no money here — only finance does (rate policy / charter C1.6)"
  );
  assert.ok(
    /finance manager/i.test(reply),
    "the reply must name who is picking it up, so the customer knows a person is coming"
  );
}

console.log("budget_gated_on_financing:eval PASS");
