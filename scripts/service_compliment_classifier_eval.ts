/**
 * Service-block compliment classification eval (2026-07-06).
 *
 * The twilio + regenerate service blocks used to comprehend compliments with a keyword
 * regex (/\b(love|like|awesome|...)\b/) — comprehension-by-regex (AGENTS.md violation)
 * with a broad false-positive surface: any service-routed question containing "like"
 * got the canned "Totally — glad you like it." Production case (7/6 corpus sweep,
 * Plinio +17162280349): "How does it work? So far the only thing I would like to do is
 * upgrade my exhaust, is there anything to do with the custom coverage regarding this
 * specific?" — a Custom Coverage question, hijacked into a compliment ack.
 *
 * Migration passed the fail-direction test: with the regex gone, an LLM-null turn falls
 * through to the service HANDOFF (todo + real answer path) — fail-safe — while the regex's
 * presence produced wrong answers. So: LLM classifier only, in BOTH paths.
 *
 * This eval pins:
 *   1. SOURCE GUARD (deterministic): the compliment keyword regex must not reappear in
 *      index.ts, and BOTH paths call classifyComplimentWithLLM (live + regen parity).
 *   2. LLM COVERAGE: classifyComplimentWithLLM distinguishes praise from requests that
 *      merely contain positive words (two samples before failing — borderline one-sample
 *      flips must not break the ci:eval chain).
 *
 * Run: LLM_ENABLED=1 npx tsx scripts/service_compliment_classifier_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// ---------- 1) Source guard (no network) ----------
const indexSrc = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");

assert.ok(
  !/complimentRegex/.test(indexSrc),
  "the compliment keyword regex must stay migrated out of index.ts (comprehend, never regex)"
);
assert.ok(
  !/\\b\(love\|like\|awesome\|amazing\|great\|cool\|nice\|sweet\|beautiful\|killer\|badass\|sick\|clean\)\\b/.test(indexSrc),
  "the compliment keyword alternation must not reappear in index.ts"
);
const complimentCallSites = indexSrc.match(/classifyComplimentWithLLM\(/g) ?? [];
assert.ok(
  complimentCallSites.length >= 2,
  `both paths (live twilio + regenerate) must classify compliments via the LLM classifier — found ${complimentCallSites.length} call site(s)`
);

console.log("PASS source guard — compliment regex gone, LLM classifier in both paths");

// ---------- 2) LLM coverage ----------
if (process.env.LLM_ENABLED !== "1" || !process.env.OPENAI_API_KEY) {
  console.error("LLM_ENABLED=1 and OPENAI_API_KEY are required for the coverage half of this eval.");
  process.exit(1);
}

const { classifyComplimentWithLLM } = await import("../services/api/src/domain/llmDraft.ts");

type Case = {
  id: string;
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  expected: boolean;
};

const cases: Case[] = [
  {
    // The production hijack — a coverage QUESTION containing "like".
    id: "custom_coverage_exhaust_question_not_compliment",
    text:
      "Good morning Gio. How does it work? So far the only thing I would like to do is upgrade my exhaust, is there anything to do with the custom coverage regarding this specific?",
    history: [
      {
        direction: "out",
        body: "Quick reminder about Custom Coverage. Any Harley-Davidson accessory we install will go under your full factory warranty on the bike."
      }
    ],
    expected: false
  },
  {
    id: "id_like_service_request_not_compliment",
    text: "I'd like to get new pipes put on, what would that run me?",
    expected: false
  },
  {
    id: "great_question_about_availability_not_compliment",
    text: "That bike looks great online — is it still available and what's the price?",
    expected: false
  },
  {
    id: "plain_compliment_true",
    text: "Man those new pipes sound awesome!",
    history: [{ direction: "out", body: "We got the Vance & Hines installed today — come hear them." }],
    expected: true
  },
  {
    id: "loves_the_bike_true",
    text: "Love the new wheels, bike looks killer",
    expected: true
  }
];

let failures = 0;
for (const c of cases) {
  // Two samples before failing — same principle as the flywheel confirm-on-refail.
  let got = await classifyComplimentWithLLM({ text: c.text, history: c.history });
  if (got !== c.expected) {
    got = await classifyComplimentWithLLM({ text: c.text, history: c.history });
  }
  const ok = got === c.expected;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} [${c.id}] expected=${c.expected} got=${got}`);
}

assert.equal(failures, 0, `${failures} compliment-classifier coverage case(s) failed`);
console.log(`\nPASS service compliment classifier eval (source guard + ${cases.length}/${cases.length} LLM coverage cases)`);
