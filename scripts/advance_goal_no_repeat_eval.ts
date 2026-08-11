/**
 * The advancing question gets a GOAL, and never repeats itself (Joe, 2026-08-11).
 *
 * Two asks, one slice, because shipping the first without the second would make the second worse:
 *
 *  1. *"If the customer goes off track and asks or says something unpredictable, will it ask the
 *     question needed to get back on track?"* — so a lane's goal is handed to the composer as a
 *     SUBORDINATE clause to answering the customer, never as an instruction that outranks them.
 *  2. *"We have to make sure the questions aren't repeated exactly the same."*
 *
 * MEASURED before building, live store, 743 conversations touched in 45 days:
 * **60 (8%) contain a verbatim repeated question — 128 repeat-askings.** Every reply now ends with a
 * question, so a customer who does not answer one gets it back identically. The fixture below is a
 * REAL repeated question copied off the live store, not an invented one.
 *
 * Defence in depth, both halves pinned here:
 *  - a prompt rule (cheap, first), and
 *  - a deterministic trigger in the self-heal loop (`deterministicHealTriggers`), because a prompt
 *    rule is a request, not a guarantee — the same reason the four suppressions live in code.
 *
 * FAIL DIRECTION: the trigger can only ever cause a RE-DRAFT. It cannot hold, block or alter a reply.
 * A false positive costs one regenerate; it can never cost a customer their answer.
 *
 * Run: npx tsx scripts/advance_goal_no_repeat_eval.ts
 */
import assert from "node:assert/strict";

// A real repeated question, copied verbatim off +17164792868 in the live store (2026-08-11).
const REAL_REPEAT = "Absolutely — later this month around that same time can work. What day later this month works best?";

async function main(): Promise<void> {
  const { extractAskedQuestions, isRepeatedOutboundQuestion, repeatsAQuestionFromHistory } = await import(
    "../services/api/src/domain/leadInGuards.ts"
  );
  const { deterministicHealTriggers, stillTriggered, buildSelfHealSteering } = await import(
    "../services/api/src/domain/selfHealSteering.ts"
  );
  const { buildChannelRules } = await import("../services/api/src/domain/draftChannelRules.ts");
  const { buildPrequalStageGoal } = await import("../services/api/src/domain/workflowRegressionGuards.ts");

  // --- 1. what counts as "a question we asked" ---------------------------------------------------
  assert.deepEqual(
    extractAskedQuestions("Thanks! What day later this month works best?"),
    ["what day later this month works best?"],
    "the QUESTION is picked out, not the sentence in front of it"
  );
  // The one that matters: same question, different lead-in, still a repeat. The first cut of the
  // extractor normalised before splitting, so the preamble rode along and this case slipped through.
  assert.equal(
    isRepeatedOutboundQuestion("Sure thing. What day later this month works best?", [REAL_REPEAT]),
    true,
    "a different preamble does not hide an identical question"
  );
  // Short courtesies recur naturally in conversation and must NOT be treated as repeats.
  assert.deepEqual(extractAskedQuestions("Sound good?"), [], "short questions are not tracked");
  assert.deepEqual(extractAskedQuestions("Does that work?"), [], "…nor are they");
  // A link carries "?dealerid=" and is not a question.
  assert.deepEqual(
    extractAskedQuestions("Apply here: https://creditapplication.harley-davidson.com/us/en/?dealerid=3436"),
    [],
    "a URL's query string is not a question"
  );

  // --- 2. the real miss, and what must NOT trip -------------------------------------------------
  assert.equal(
    isRepeatedOutboundQuestion(REAL_REPEAT, [REAL_REPEAT]),
    true,
    "the measured real case: the identical question sent twice"
  );
  assert.equal(
    isRepeatedOutboundQuestion(REAL_REPEAT, ["Hey Mark, just following up on the Road Glide."]),
    false,
    "a question we have not asked before is fine"
  );
  // RE-ASKING IS THE POINT. Pressing again in different words is the behaviour we want when someone
  // has not answered; only the recording-like repeat is the bug.
  assert.equal(
    isRepeatedOutboundQuestion("What day works best for you later this month?", [REAL_REPEAT]),
    false,
    "the same ask in different words must pass — re-asking is correct, repeating is not"
  );
  assert.equal(isRepeatedOutboundQuestion("Thanks, I'll get that over to you.", [REAL_REPEAT]), false, "no question, no repeat");
  assert.equal(isRepeatedOutboundQuestion(REAL_REPEAT, []), false, "nothing prior, nothing to repeat");

  // --- 3. the self-heal wiring ------------------------------------------------------------------
  const history = [
    { direction: "out" as const, body: REAL_REPEAT },
    { direction: "in" as const, body: "not sure yet" }
  ];
  const triggers = deterministicHealTriggers({ draft: REAL_REPEAT, inbound: "not sure yet", history });
  assert.equal(triggers.repeatsOwnQuestion, true, "the repeat fires the deterministic trigger");
  assert.equal(triggers.any, true, "…so the draft is re-drafted even if the judge liked it");
  const clean = deterministicHealTriggers({ draft: "Sure — which day suits you better, Friday or Saturday?", inbound: "not sure yet", history });
  assert.equal(clean.repeatsOwnQuestion, false, "a reworded ask does not trigger");
  assert.equal(
    stillTriggered(triggers, { draft: REAL_REPEAT, inbound: "not sure yet", history }),
    true,
    "a re-draft that repeats again is NOT a heal"
  );
  assert.equal(
    stillTriggered(triggers, { draft: "Which day suits you better, Friday or Saturday?", inbound: "not sure yet", history }),
    false,
    "a genuinely reworded re-draft IS a heal"
  );

  // The steering must demand a REWORD and must not let the question be dropped.
  const steering = buildSelfHealSteering({ original: REAL_REPEAT, judgeSteering: "", echoesInbound: false, repeatsOwnQuestion: true });
  // Asserted as SEPARATE properties, not an OR. The first cut used /different way|do not repeat/ and
  // a sabotage that deleted the "ask it a different way" half sailed through on the other alternative
  // — an OR assertion only proves that SOMETHING survived, which is not what we mean.
  assert.ok(/different way/i.test(steering), "the steering asks for a different wording");
  assert.ok(/do not repeat the sentence/i.test(steering), "…and forbids the verbatim repeat outright");
  assert.ok(/shorter|another angle|choice of two/i.test(steering), "…and says HOW to vary it");
  assert.ok(/not drop the question/i.test(steering), "…and refuses to let the question be dropped");
  assert.ok(/something to answer/i.test(steering), "…leaving them something to answer");

  // --- 4. the prompt rules ----------------------------------------------------------------------
  // THE NO-REPEAT RULE BINDS EVERY REPLY, arm on or off. The first cut nested it inside the
  // salesperson-arm branch, so it vanished whenever the arm was off — caught here, and worth keeping
  // pinned: "do not send the same sentence twice" has nothing to do with whether we are advancing.
  delete process.env.DRAFT_ADVANCE_EVERY_REPLY;
  const rulesArmOff = buildChannelRules({ channel: "sms", history } as any);
  assert.ok(
    /NEVER ask a question you have already asked/i.test(rulesArmOff),
    "the no-repeat rule binds even with the salesperson arm OFF"
  );

  // The GOAL, by contrast, only exists when there IS an advancing question to aim — so the rest of
  // this section runs with the arm on, which is how production runs (DRAFT_ADVANCE_EVERY_REPLY=1).
  process.env.DRAFT_ADVANCE_EVERY_REPLY = "1";
  const rulesWithHistory = buildChannelRules({ channel: "sms", history } as any);
  assert.ok(/NEVER ask a question you have already asked/i.test(rulesWithHistory), "the no-repeat rule is in the prompt");
  assert.ok(
    rulesWithHistory.includes("what day later this month works best?"),
    "and the prompt names the exact sentences already sent"
  );

  // --- 5. THE GOAL IS SUBORDINATE TO ANSWERING THEM ---------------------------------------------
  // Joe's off-track question. A goal that outranks the customer's actual words is a worse agent than
  // no goal at all, and a caveat under a strong imperative loses to it 3 times out of 3 (measured
  // when the salesperson arm shipped). So the answer-first instruction is asserted to be present
  // WITH the goal, not merely somewhere in the prompt.
  const goal = buildPrequalStageGoal("ask_budget", "2025 Road Glide");
  assert.ok(goal && /monthly payment/i.test(goal), "the budget rung states its goal");
  assert.ok(goal && /never name a figure/i.test(goal), "…and forbids quoting a number of our own");
  const rulesWithGoal = buildChannelRules({ channel: "sms", advanceGoal: goal, history: [] } as any);
  assert.ok(rulesWithGoal.includes(goal!), "the goal reaches the composer");
  assert.ok(/ANSWER WHAT THEY ACTUALLY SAID FIRST/i.test(rulesWithGoal), "answering the customer comes FIRST");
  assert.ok(
    /drop the goal for this turn/i.test(rulesWithGoal),
    "and the goal is explicitly droppable when it does not fit what they said"
  );
  const goalAt = rulesWithGoal.indexOf(goal!);
  const answerFirstAt = rulesWithGoal.search(/ANSWER WHAT THEY ACTUALLY SAID FIRST/i);
  assert.ok(answerFirstAt > goalAt, "the answer-first instruction sits AFTER the goal, so it reads as the binding one");

  // A lane with no goal is untouched — every non-prequal lead keeps today's behaviour exactly.
  const rulesNoGoal = buildChannelRules({ channel: "sms", history: [] } as any);
  assert.ok(!/THIS LEAD HAS A GOAL/i.test(rulesNoGoal), "no goal, no goal block");
  assert.ok(/NEVER ask a question you have already asked/i.test(rulesNoGoal), "but the no-repeat rule binds every lead");

  // The application rung yields NO goal: it carries a URL, which is never LLM-composed.
  assert.equal(buildPrequalStageGoal("send_credit_app", "2025 Road Glide"), null, "a link is never handed to the composer");
  assert.equal(buildPrequalStageGoal("none", null), null, "and a settled lead has no goal");

  console.log("PASS advance goal + no repeat — the goal answers them first, and no sentence is ever sent twice.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
