/**
 * answer_to_own_question:eval
 *
 * A customer who ANSWERS the question we just asked must be heard as answering it.
 *
 * Live miss, +17169902571 (John Zimmerman, 2026-08-10, operator-reported by Joe:
 * "The customer answered our question and the agent did not know how to answer it").
 * We sent the finance ack ending "Are you looking at the Road Glide, or open to a
 * couple of options?"; he replied "Couple options"; the routing parser read
 * primary_intent=none and drafted "Quick check - are you asking about availability,
 * pricing/payments, or scheduling a time to come in for a couple of options?" —
 * re-asking the question we had just asked.
 *
 * Measured on main before the fix, 5 runs of the real turn: primary_intent=none 5/5,
 * split fallback_action clarify 2/5 and no_response 3/5. So the customer got either
 * our own question back or silence. After the prompt fix: 14/14 runs route it as an
 * answer, with zero clarify.
 *
 * The fixture is the REAL stored text of both turns, not a paraphrase.
 *
 * These assert the DECISION the system branches on — "do we answer this turn, re-ask,
 * or say nothing" — never a particular intent label, because availability/general/
 * scheduling all produce the same decision here.
 *
 * Sample size: each case runs 3 times and needs a 2/3 majority. Measured variance on
 * the two cases the fix moves is ZERO across 14 and 12 runs respectively, so 2-of-3
 * survives one unlucky sample with room to spare.
 */
import assert from "node:assert";
import { parseRoutingDecisionWithLLM } from "../services/api/src/domain/llmDraft.js";

type Turn = { direction: "in" | "out"; body: string };

const RUNS = 3;
const MAJORITY = 2;

// The real delivered ack on +17169902571, verbatim from the store.
const REAL_ACK =
  "Hey John, it's Alexandra over at American Harley-Davidson. Thanks — I received your " +
  "credit application. I’ll have our finance team reach out when we open tomorrow. Are you " +
  "looking at the Road Glide, or open to a couple of options? Reply STOP to opt out.";

async function runCase(args: {
  text: string;
  history: Turn[];
  lead?: any;
  classification?: { bucket?: string | null; cta?: string | null } | null;
}) {
  const out: { primaryIntent: string; fallbackAction: string; explicitRequest: boolean }[] = [];
  for (let i = 0; i < RUNS; i++) {
    const parsed = await parseRoutingDecisionWithLLM({
      text: args.text,
      history: args.history,
      lead: args.lead,
      followUp: null,
      dialogState: null,
      classification: args.classification ?? null
    });
    assert.ok(parsed, "routing parser returned null — needs OPENAI_API_KEY and LLM_ENABLED=1");
    out.push({
      primaryIntent: parsed.primaryIntent,
      fallbackAction: parsed.fallbackAction,
      explicitRequest: parsed.explicitRequest
    });
  }
  return out;
}

const countWhere = (
  rows: { primaryIntent: string; fallbackAction: string; explicitRequest: boolean }[],
  pred: (r: { primaryIntent: string; fallbackAction: string; explicitRequest: boolean }) => boolean
) => rows.filter(pred).length;

async function main() {
  // ---------------------------------------------------------------------------
  // 1. The live miss: he answered our two-option question. The decision must be
  //    "answer him" — not re-ask, not go silent.
  // ---------------------------------------------------------------------------
  const answered = await runCase({
    text: "Couple options",
    history: [
      {
        direction: "in",
        body:
          "WEB LEAD (ADF)\nSource: HDFS COA Online\nRef: 11767\nName: John Zimmerman\n" +
          "Year: 2026\nVehicle: Harley-Davidson Road Glide"
      },
      { direction: "out", body: REAL_ACK }
    ],
    lead: { vehicle: { model: "Road Glide", year: 2026 }, source: "HDFS COA Online" },
    classification: { bucket: "finance_prequal", cta: "hdfs_coa" }
  });

  const answeredRouted = countWhere(
    answered,
    r => r.fallbackAction === "none" && r.primaryIntent !== "none" && r.explicitRequest
  );
  assert.ok(
    answeredRouted >= MAJORITY,
    `answering our own question must route as a real ask: got ${answeredRouted}/${RUNS} — ` +
      JSON.stringify(answered)
  );

  // The specific production symptom: never hand back the question we just asked.
  const reAsked = countWhere(answered, r => r.fallbackAction === "clarify");
  assert.equal(
    reAsked,
    0,
    `re-asking the question we just asked is always wrong: got ${reAsked}/${RUNS} clarify — ` +
      JSON.stringify(answered)
  );

  // And never answer an answer with silence.
  const wentSilent = countWhere(answered, r => r.fallbackAction === "no_response");
  assert.ok(
    wentSilent <= RUNS - MAJORITY,
    `answering our own question must not read as nothing to say: got ${wentSilent}/${RUNS} ` +
      `no_response — ${JSON.stringify(answered)}`
  );

  // ---------------------------------------------------------------------------
  // 2. Guard: with no question in the preceding turn, an ambiguous fragment is
  //    still ambiguous. The fix must not turn every short reply into an ask.
  // ---------------------------------------------------------------------------
  const ambiguous = await runCase({
    text: "Yeah maybe",
    history: [
      { direction: "in", body: "Do you guys have any bikes" },
      { direction: "out", body: "We sure do — plenty on the floor right now." }
    ]
  });
  const stillUnrouted = countWhere(ambiguous, r => r.primaryIntent === "none");
  assert.ok(
    stillUnrouted >= MAJORITY,
    `an ambiguous fragment with no pending question must not be routed as an ask: got ` +
      `${stillUnrouted}/${RUNS} — ${JSON.stringify(ambiguous)}`
  );

  // ---------------------------------------------------------------------------
  // 3. Guard: a courtesy acknowledgment is not an answer, even right after we
  //    asked something. Charter C2.2 — reciprocate a closer once, then stop.
  // ---------------------------------------------------------------------------
  const courtesy = await runCase({
    text: "Ok thanks",
    history: [
      { direction: "in", body: "I submitted the credit app" },
      {
        direction: "out",
        body: "Got it — I can have our finance team call you. What time of day is best?"
      }
    ]
  });
  const stayedQuiet = countWhere(
    courtesy,
    r => r.primaryIntent === "none" && r.fallbackAction === "no_response"
  );
  assert.ok(
    stayedQuiet >= MAJORITY,
    `a courtesy acknowledgment after our question must stay silent: got ${stayedQuiet}/${RUNS} — ` +
      JSON.stringify(courtesy)
  );

  console.log("answer_to_own_question:eval PASS");
  console.log("  answered-our-question routed:", answeredRouted, "of", RUNS, "clarify:", reAsked);
  console.log("  ambiguous-no-question unrouted:", stillUnrouted, "of", RUNS);
  console.log("  courtesy-ack silent:", stayedQuiet, "of", RUNS);
}

main().catch(err => {
  console.error("answer_to_own_question:eval FAIL");
  console.error(err?.message ?? err);
  process.exit(1);
});
