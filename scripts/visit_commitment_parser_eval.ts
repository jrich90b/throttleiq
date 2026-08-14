/**
 * Visit-commitment parser fixture (LLM-backed).
 *
 * Executes `parseVisitCommitmentWithLLM` on the REAL turns that motivated it and asserts the
 * DECISION the referee reaches (arm / don't arm), not any particular label spelling — a `no` and
 * an `unclear` differ in wording but only one of them changes what we do.
 *
 * ── SAMPLE SIZE, JUSTIFIED AGAINST A MEASURED EFFECT ──────────────────────────────────────────
 * Measured 2026-08-14 on held-out turns (none of which are in the parser's few-shots), 5 runs each:
 *   "Took short day today at work to go out for a ride"        no   5/5
 *   "Agent: Thank you for calling American Harley Davidson…"   no   5/5  (was unclear 4/5 before
 *                                                                   the machine-record few-shots)
 *   "Ill swing in Saturday to take a look at it"               yes  5/5
 *   "Ill try to stop by the 15th or 16th"                      yes  4/5 (1 unclear)
 *   "…Would it be possible for you guys to come look at my bike" no 4/5 (1 yes)
 * The reported turn itself ("out of town … come back Monday") read `no@0.95` on 11 of 11
 * observations across two sessions.
 *
 * ⚠️ Every fixture below is VERBATIM store text, and the `detectSoftVisitIntent` precondition in
 * the loop is why. A hand-written "We are on vacation in Myrtle Beach til Sunday" and an abridged
 * call transcript both looked like perfectly good cases and neither trips the keyword rule at all,
 * so neither would ever have reached the tiebreak — they would have "passed" while testing nothing.
 *
 * So the stable cases are stable, and BOTH observed instabilities land on the harmless side:
 * `unclear` and `yes` leave today's behaviour untouched, because only a confident `no` vetoes.
 * This file asserts only the 5/5 cases, and takes 3 samples requiring a 2/3 majority so one
 * unlucky sample cannot red-line `main` for everyone (the trap that burned
 * `incoming_unit_arrival:eval`).
 *
 * Requires OPENAI_API_KEY + LLM_ENABLED=1 (the ci:eval chain supplies both).
 * Run: LLM_ENABLED=1 npx tsx scripts/visit_commitment_parser_eval.ts
 */
import { strict as assert } from "node:assert";

const { parseVisitCommitmentWithLLM } = await import(
  "../services/api/src/domain/visitCommitmentParser.ts"
);
const { resolveSoftVisitCommitment } = await import("../services/api/src/domain/softVisitSignal.ts");
const { detectSoftVisitIntent } = await import("../services/api/src/domain/legacyRegexFallback.ts");

if (process.env.LLM_ENABLED !== "1" || !process.env.OPENAI_API_KEY) {
  console.log("SKIP visit_commitment_parser_eval — needs LLM_ENABLED=1 + OPENAI_API_KEY");
  process.exit(0);
}

const SAMPLES = 3;
const MAJORITY = 2;

/** The appointment-timing reading these turns actually get: intent none, no day-anchored verb. */
const neutralParse = (day = "") => ({
  intent: "none" as const,
  explicitRequest: false,
  requested: { day, timeText: "", timeWindow: "unknown" as const },
  normalizedText: "",
  confidence: 0.9
});

type Case = { label: string; text: string; history?: { direction: "in" | "out"; body: string }[]; day?: string; expectArm: boolean };

const CASES: Case[] = [
  {
    // THE REPORTED MISS. Michelle Hyjek +17163164854, 2026-08-08 17:33Z. Joe: "This looks like a
    // another lead got tied to this lead" — the soft-visit task claimed she said she'd come in.
    label: "away at a wedding, returning Monday",
    text: "No I am out of town for my nieces wedding I come back Monday",
    history: [{ direction: "out", body: "Wasn't sure if you were with Dave or not" }],
    day: "monday",
    expectArm: false
  },
  {
    // +17169086716, 2026-08-12 16:57Z — verbatim from the store. He is talking about riding the
    // bike he just bought, not about coming here.
    label: "putting miles on his own bike next week",
    text: "Thanks Scott. Enjoyed the ride home..hoping to put some miles on the Deadwood nxt week",
    day: "next week",
    expectArm: false
  },
  {
    // +17164005844, 2026-07-17 14:31Z — verbatim from the store.
    label: "took the day off to go for a ride",
    text: "Thank you, absolutely loving it. Took short day today at work to go out for a ride actually. And will do, thank you.",
    day: "today",
    expectArm: false
  },
  {
    // +17163164854, 2026-08-06 15:06Z — a CALL RECORDING transcript, verbatim from the store, and
    // the reason the full text matters: an abridged version does not even trip the keyword rule,
    // so a hand-written fixture would have proved nothing (AGENTS.md: a keyword rule written for
    // customer prose must not run against a machine record).
    label: "a call-recording transcript is not a customer commitment",
    text:
      "Agent: Thank you for calling American Harley Davidson. If you know your party's extension, you may enter it at any time.\n" +
      "Agent: If you are calling for motorcycle sales, press one. For parts, press two. For motor close, press three. For the business office, press four. For service, press five. For all other inquiries,\n" +
      "Agent: please press zero.\n" +
      "Agent: American Harley Davidson service department. Nick speaking.\n" +
      "Customer: Hi, Nick. It's Michelle.\n" +
      "Customer: Just calling on behalf of Dave Miller. He picked up his bike yesterday. The problem was supposed to be fixed, but, however, he took it out for a ride today, and the same problem happened.\n" +
      "Customer: Now the bike is stuck on Cleveland Drive. I don't know if he reached out to you guys yet.\n" +
      "Agent: Yes. He has reached out to us.\n" +
      "Customer: Alright. Thank you.",
    expectArm: false
  },
  {
    // The population the keyword rule is genuinely carrying — these MUST survive.
    label: "a real day-anchored commitment (held out)",
    text: "Ill swing in Saturday to take a look at it",
    day: "saturday",
    expectArm: true
  }
];

let failures = 0;
for (const c of CASES) {
  // Every case must actually reach the referee's disputed branch, or the fixture proves nothing.
  assert.equal(
    detectSoftVisitIntent(c.text),
    true,
    `${c.label}: the legacy keyword rule must fire, else this turn never reaches the tiebreak`
  );
  const arms: boolean[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const vc = await parseVisitCommitmentWithLLM({ text: c.text, history: c.history });
    arms.push(
      resolveSoftVisitCommitment({
        legacySignal: true,
        parse: neutralParse(c.day),
        visitCommitment: vc
      }).arm
    );
  }
  const agreeing = arms.filter(a => a === c.expectArm).length;
  const verdict = agreeing >= MAJORITY ? "ok  " : "FAIL";
  console.log(`  ${verdict} ${c.label} — expected arm=${c.expectArm}, got [${arms.join(",")}]`);
  if (agreeing < MAJORITY) failures++;
}

assert.equal(failures, 0, `${failures} visit-commitment case(s) failed the ${MAJORITY}/${SAMPLES} majority`);
console.log("PASS visit_commitment_parser_eval — the parser decides the disputed turns correctly");
