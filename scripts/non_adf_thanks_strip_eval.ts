/**
 * Non-ADF reply spacing eval (pure, no LLM) — and the landmine guard that goes with it.
 *
 * Pins `normalizeNonAdfReplySpacing` (services/api/src/domain/agentVoice.ts), the last-mile pass
 * every non-ADF reply goes through on the regenerate path (index.ts, three consecutive calls).
 *
 * WHY THIS EVAL EXISTS — it is not really about spacing.
 * Until 2026-08-15 this function lived in index.ts as `stripNonAdfThanks` and carried two rules
 * ahead of the spacing pass, meant to delete a leading "Thanks for ….' sentence:
 *
 *     out = out.replace(/^(\\s*(hi|hey)\\s+[^—\\n]+—\\s*)(thanks for[^.]+\\.\\s*)/i, "$1");
 *     out = out.replace(/^(\\s*)thanks for[^.]+\\.\\s*<slash>i, "$1");   // <slash> = the literal regex
 *                                                                       // terminator, spelled out here
 *                                                                       // because it would close this comment
 *
 * They are DOUBLE-escaped inside a regex literal, so `\\s` matches a literal backslash followed by
 * "s". MEASURED against the whole americanharley store: **0 matches in 5,329 agent-authored
 * outbound bodies, all-time** — in the function's entire life neither rule ever fired once.
 *
 * The escaping looks exactly like a typo, and repairing it is the trap. Re-measured with the
 * single-escaped versions, they match **121 of those 5,329 bodies**, and because `[^.]+\.` eats
 * the whole first sentence they empty or gut most of them. The bodies below are VERBATIM from the
 * live store, chosen to span that damage: the first three collapse to the EMPTY STRING, the
 * fourth loses the sentence that frames the price it then quotes.
 *
 * So the dead rules were DELETED rather than repaired. This eval asserts the DECISION — a real
 * reply that opens "Thanks for …" comes out the other side with its words intact — so that
 * re-introducing the strip in ANY escaping goes red here instead of sending a customer an empty
 * message. A source-text assertion could not do that; this executes the shipped function.
 *
 * Run: npx tsx scripts/non_adf_thanks_strip_eval.ts
 */
import { strict as assert } from "node:assert";

const { normalizeNonAdfReplySpacing } = await import("../services/api/src/domain/agentVoice.ts");

// --- 1) The population the deleted rules would have destroyed. VERBATIM store bodies. --------
const THANKS_OPENERS: Array<[string, string]> = [
  [
    "draft_ai 2026-06-15 — guts to the empty string",
    "Thanks for the update."
  ],
  [
    "draft_ai 2026-04-13 / twilio 2026-04-20 — guts to the empty string",
    "Thanks for the message — I’m checking that now and will follow up shortly."
  ],
  [
    "draft_ai 2026-06-13 — guts to the empty string",
    "Thanks for sending that over, Stevie! Let me match it against what we've got in stock and coming in, and I'll text you what I find today."
  ],
  [
    "twilio 2026-03-20 — loses the sentence that frames the price it goes on to quote",
    "Hi David — Thanks for your Facebook inquiry on the 2026 Harley-Davidson Heritage Classic. This is Alexandra at American Harley-Davidson. The price we have listed for the 2026 Heritage Classic in-stock is $22,649."
  ],
  [
    "twilio 2026-07-25 — the answer to the customer's question is the part that would go",
    "Thanks for the update. The Pan America’s your focus — are you looking at the 1250 or the Special? I’ll loop in our sales team to help on the bike side and get you details."
  ]
];

for (const [who, body] of THANKS_OPENERS) {
  const out = normalizeNonAdfReplySpacing(body, "twilio");

  assert.ok(out.trim().length > 0, `${who}: a reply must never come back empty`);

  // The decision under test: every word the customer was going to read is still there.
  // Compared on collapsed whitespace, because collapsing whitespace IS this function's job.
  const collapsed = body.replace(/\s{2,}/g, " ").replace(/—\s+/g, "— ").trim();
  assert.equal(out, collapsed, `${who}: the body must survive intact — only spacing may change`);

  // Spelled out, so a future reader sees the failure mode without re-deriving it.
  const firstSentence = body.slice(0, body.indexOf(".") + 1);
  assert.ok(
    out.includes(firstSentence),
    `${who}: the opening sentence must still be there (the deleted strip ate exactly this)`
  );
}

// A body that is NOTHING BUT the thanks sentence is the sharpest case: there is no remainder to
// fall back on, so a strip here is the difference between a reply and silence.
assert.equal(
  normalizeNonAdfReplySpacing("Thanks for the update.", "twilio"),
  "Thanks for the update.",
  "a reply that is only the thanks sentence must survive whole"
);

// --- 2) The job the function actually has: spacing, on non-ADF lanes. ------------------------
assert.equal(
  normalizeNonAdfReplySpacing("Happy to help.  What day works?", "twilio"),
  "Happy to help. What day works?",
  "runs of whitespace collapse to one space"
);
assert.equal(
  normalizeNonAdfReplySpacing("Hi Dave —   thanks for the note.", "twilio"),
  "Hi Dave — thanks for the note.",
  "the gap after an em-dash normalizes to a single space"
);
assert.equal(
  normalizeNonAdfReplySpacing("  Sounds good.  ", "twilio"),
  "Sounds good.",
  "leading and trailing whitespace is trimmed"
);
assert.equal(
  normalizeNonAdfReplySpacing("Sounds good.", undefined),
  "Sounds good.",
  "an unknown provider is treated as non-ADF (the shipped default)"
);

// --- 3) ADF is exempt, unchanged — its template owns its own line breaks. --------------------
const ADF_BODY = "Hi Brad,\nThanks for your inquiry.\n\nAlexandra\nAmerican Harley-Davidson";
assert.equal(
  normalizeNonAdfReplySpacing(ADF_BODY, "sendgrid_adf"),
  ADF_BODY,
  "sendgrid_adf passes through byte-identical — blank lines in the ADF template are deliberate"
);
assert.notEqual(
  normalizeNonAdfReplySpacing(ADF_BODY, "twilio"),
  ADF_BODY,
  "and the exemption is load-bearing: the same body IS rewritten on a non-ADF lane"
);

console.log(
  `non_adf_thanks_strip:eval OK (${THANKS_OPENERS.length} verbatim store bodies survive intact; spacing + ADF exemption held)`
);
