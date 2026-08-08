/**
 * self_heal_keeps_the_ask:eval — a draft repair must not turn a question into a statement.
 *
 * MEASURED 2026-08-07 across 184 real before/after repair pairs: the repair step deleted the
 * closing question 40 times and added one 15 times — 2.7 to 1 against the single thing the
 * business is gated on (57% of leads offered a time, 17% booked). 16 of those 40 were the
 * appointment-time class PR #605 closed from the judge's side. The other 24 were plain qualifying
 * questions whose steering was EMPTY: nothing asked for the removal, the rewrite just lost it.
 *
 *   "Do you want me to line up delivery for mid next week?"
 *     -> "Once it's confirmed, I can line up mid-next-week delivery."
 *
 * A/B on three of the real cases, three runs each: OLD steering kept the ask 1/3 every time, the
 * new steering 3/3 every time.
 *
 * Run: npx tsx scripts/self_heal_keeps_the_ask_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const { extractClosingQuestion, buildSelfHealSteering } = await import(
  "../services/api/src/domain/selfHealSteering.ts"
);

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks += 1;
};

// --- 1) The closing ask is recovered from the REAL drafts that lost it.
const realLostTheAsk: [string, string][] = [
  [
    "Got it. I’ll have a sales manager call you today to line things up—what’s the best number to reach you?",
    "what’s the best number to reach you?"
  ],
  [
    "Hey there, it's Alexandra over at American Harley-Davidson. What used bike are you looking for?",
    "What used bike are you looking for?"
  ],
  [
    "Spoke with the tech. The carb clean is done and it’s running smooth now. Do you want me to line up delivery for mid next week?",
    "Do you want me to line up delivery for mid next week?"
  ],
  [
    "Glad you got in touch. I can set that up for 5/29 for a Road Glide — do you have a motorcycle endorsement?",
    "do you have a motorcycle endorsement?"
  ]
];
for (const [draft, mustContain] of realLostTheAsk) {
  const ask = extractClosingQuestion(draft);
  ok(ask !== null, `a draft ending in a question must yield an ask: ${JSON.stringify(draft.slice(-50))}`);
  ok(
    String(ask).includes(mustContain),
    `the recovered ask must be the QUESTION, not the whole draft — got ${JSON.stringify(ask)}`
  );
}

// --- 2) And nothing is invented when there was no ask. A repair of a statement must be untouched.
for (const draft of [
  "Thanks Michael — I’ll get those photos over to you shortly.",
  "Sounds good, see you Saturday at 11:00 AM.",
  "You’re all set. Reply STOP to opt out.",
  "?",
  "",
  "   "
]) {
  ok(extractClosingQuestion(draft) === null, `no ask to protect in ${JSON.stringify(draft.slice(0, 40))}`);
}

// --- 3) THE DECISION. Steering carries the ask forward, and the judge's own complaint still leads.
const judge = "The draft states the carb work is complete but the record does not confirm it.";
const withAsk = buildSelfHealSteering({
  original: realLostTheAsk[2][0],
  judgeSteering: judge,
  echoesInbound: false
});
ok(withAsk.startsWith(judge), "the judge's correction must come FIRST — it is why the repair is happening");
ok(withAsk.includes(realLostTheAsk[2][1]), "the steering must quote the ask the rewrite has to keep");
ok(
  /specifically about that question/.test(withAsk),
  "the rewrite must stay free to change the ask when the correction IS about it — otherwise this pins a bad question in place"
);

// A repair with nothing to protect must be byte-identical to what the repairer saw before.
assert.equal(
  buildSelfHealSteering({ original: "Sounds good, see you Saturday.", judgeSteering: "Too long.", echoesInbound: false }),
  "Too long.",
  "with no closing ask the steering must be UNCHANGED — this change is scoped to drafts that asked something"
);
checks += 1;

// The anti-parrot trigger still dominates, and still gets the ask protection.
const echo = buildSelfHealSteering({
  original: realLostTheAsk[1][0],
  judgeSteering: "ignored when echoing",
  echoesInbound: true
});
ok(/Do NOT open by repeating/.test(echo), "an echoed opening still leads with the anti-parrot instruction");
ok(!echo.includes("ignored when echoing"), "the echo trigger replaces the judge steering, as before");
ok(echo.includes(realLostTheAsk[1][1]), "and the ask is protected on the echo path too");

// --- 4) WIRING. The repairer must actually call this; a helper nothing calls is dead code.
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
ok(
  /const steering = buildSelfHealSteering\(\{/.test(llm),
  "selfHealDraftWithLLM must build its steering through this helper"
);
ok(
  !/const steering = echoesInbound\s*\n\s*\?/.test(llm),
  "the old inline ternary must be GONE — two ways to build the steering is how one of them goes stale"
);

console.log(`self_heal_keeps_the_ask:eval OK (${checks} checks)`);
