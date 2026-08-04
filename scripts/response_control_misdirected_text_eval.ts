/**
 * Response-control parser eval (LLM-backed) — a text the CUSTOMER misdirected to US is not
 * "you have the wrong number".
 *
 * Production incident (Justin Alley +17163390288, 2026-07-21, operator-reported "lead should have
 * never closed out"): mid-negotiation on a used 2017 Breakout, with a 5-6 PM walk-in set for that
 * same evening, Justin fat-fingered a joke meant for a friend into our thread and apologized —
 * "Oops omg sorry that sooo went to wrong person ... that wasn't meant for you ... I was trying to
 * joke with my close friend and it went and sent to you instead". The response-control parser read
 * it as `wrong_number` @0.98 (route_audit `wrong_number_suppressed`, 19:39:10Z), which runs
 * applyWrongNumberSuppression: pending drafts discarded, cadence stopped, RELATED PHONES
 * suppressed, and the live lead CLOSED. Staff filed the report 2h26m later.
 *
 * The fail direction is the point: `wrong_number` is a fail-UNSAFE terminal side effect (silence +
 * closeout + cross-phone suppression), so a false positive costs a warm, actively-negotiating lead.
 * The regex fallback `isWrongNumberText` never matched this text — the miss is purely the parser's,
 * and its prompt definition ("the message reached the wrong person") was ambiguous about WHOSE
 * message went astray.
 *
 * Pins:
 *  1) THE FIX — an apology for a text the customer misdirected to us never reaches the
 *     wrong-number suppression arm (both the raw intent and the acceptance gate index.ts reads).
 *  2) generalization — a paraphrase the few-shots do not contain behaves the same way.
 *  3) REGRESSION GUARD — a genuine "you have the wrong number" still suppresses.
 *  4) REGRESSION GUARD — the terse "Wrong number?" form still suppresses.
 */
import assert from "node:assert/strict";

import { parseResponseControlWithLLM } from "../services/api/src/domain/llmDraft.ts";
import { isResponseControlParserAccepted } from "../services/api/src/domain/transitionSafety.ts";

async function control(text: string, history?: { direction: "in" | "out"; body: string }[]) {
  const parsed = await parseResponseControlWithLLM({ text, history });
  assert.ok(parsed, `parser returned null for: ${text}`);
  return parsed!;
}

/**
 * The exact live condition in index.ts (`llmWrongNumber`): the parse must clear the acceptance
 * gate AND name wrong_number before applyWrongNumberSuppression runs. Asserting the composite is
 * what makes this a behavior pin rather than a bare intent check — a parse that says wrong_number
 * at low confidence is harmless, and a parse that says none at 0.99 is harmless too.
 */
function suppressesAsWrongNumber(parsed: { intent?: string | null; explicitRequest?: boolean; confidence?: number }) {
  return isResponseControlParserAccepted(parsed) && parsed.intent === "wrong_number";
}

// The live thread state when it happened: an engaged buyer with a visit planned for that evening.
const NEGOTIATION_HISTORY: { direction: "in" | "out"; body: string }[] = [
  { direction: "in", body: "Yea it'll probably be between 5 and 6 p then " },
  { direction: "out", body: "Ok we will see you then" }
];

// 1) THE FIX — the verbatim production turn must not trip the suppression arm.
const misdirected = await control(
  "Oops omg sorry that sooo went to wrong person bahahahahaha that wasn't meant for you omg I'm embarrassed as I was trying to joke with my close friend and it went and sent to you instead",
  NEGOTIATION_HISTORY
);
assert.ok(
  !suppressesAsWrongNumber(misdirected),
  `a customer apologizing for a text THEY misdirected to us must never suppress+close the lead — got intent=${misdirected.intent} explicit=${misdirected.explicitRequest} confidence=${misdirected.confidence}`
);

// 2) GENERALIZATION — a paraphrase that is not one of the few-shots behaves the same way.
const paraphrase = await control(
  "haha sorry about that last one, meant to send it to my buddy not you",
  NEGOTIATION_HISTORY
);
assert.ok(
  !suppressesAsWrongNumber(paraphrase),
  `a paraphrased misdirected-text apology must not suppress+close the lead — got intent=${paraphrase.intent} explicit=${paraphrase.explicitRequest} confidence=${paraphrase.confidence}`
);

// 3) REGRESSION GUARD — a real wrong-number report still suppresses. Without this the "fix" could
// be a parser that simply stopped believing in wrong_number, which fails the other direction:
// we would keep texting a stranger.
const realWrongNumber = await control("You have the wrong number, I don't know anything about a Harley");
assert.ok(
  suppressesAsWrongNumber(realWrongNumber),
  `a genuine wrong-number report must still suppress — got intent=${realWrongNumber.intent} explicit=${realWrongNumber.explicitRequest} confidence=${realWrongNumber.confidence}`
);

// 4) REGRESSION GUARD — the terse form staff see most often.
const terseWrongNumber = await control("Wrong number?");
assert.ok(
  suppressesAsWrongNumber(terseWrongNumber),
  `"Wrong number?" must still suppress — got intent=${terseWrongNumber.intent} explicit=${terseWrongNumber.explicitRequest} confidence=${terseWrongNumber.confidence}`
);

console.log("PASS misdirected_customer_text_is_not_wrong_number");
console.log("PASS misdirected_paraphrase_is_not_wrong_number");
console.log("PASS genuine_wrong_number_still_suppresses");
console.log("PASS terse_wrong_number_still_suppresses");
console.log("\nAll 4 response-control misdirected-text checks passed.");
