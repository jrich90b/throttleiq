/**
 * outbound_no_got_it:eval (universal, deterministic) — runs inside ci:eval.
 *
 * Joe (2026-06-20): the curt "Got it" acknowledgment must never ship in any customer-facing
 * outbound — follow-up cadence, Twilio SMS, or email. Enforcement is centralized, not scattered
 * across the ~30 deterministic templates that historically opened with it:
 *   1. SOURCE (SMS/draft): the lead-in normalizer (`normalizeGotItLeadIn` / `pickLeadInVariant`)
 *      rewrites a "Got it" opener to a contextual lead-in, and falls back to "Sounds good."
 *   2. SINK (universal, all channels incl. email): `stripGotItAcknowledgement` runs inside
 *      `applyDeterministicToneOverrides`, which `appendOutbound` applies to every draft_ai /
 *      twilio / sendgrid body.
 *
 * The guard is scoped to the ACK only: the possessive "we've got it in stock" and the
 * affirmation "You got it" carry different meaning and MUST survive untouched.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { stripGotItAcknowledgement, applyDeterministicToneOverrides } from "../services/api/src/domain/tone.ts";

const GOT_IT_RE = /\bgot it\b/i;

// ---------------------------------------------------------------------------
// 1) Sink guarantee: representative deterministic templates + channels.
// ---------------------------------------------------------------------------
const stripCases: Array<{ name: string; input: string; expect: string }> = [
  { name: "sms_dash_leadin", input: "Got it — I’ll have a manager pull the exact pricing and follow up shortly.", expect: "I’ll have a manager pull the exact pricing and follow up shortly." },
  { name: "period_leadin", input: "Got it. Thanks for the photo — that helps.", expect: "Thanks for the photo — that helps." },
  { name: "comma_leadin", input: "Got it, sending those over shortly.", expect: "Sending those over shortly." },
  { name: "optout_context", input: "Got it — I won’t message you again.", expect: "I won’t message you again." },
  { name: "bare_ack", input: "Got it.", expect: "Sounds good." },
  { name: "bare_ack_lowercase", input: "got it", expect: "Sounds good." },
  { name: "inventory_context", input: "Got it — we do have 2 options in stock.", expect: "We do have 2 options in stock." },
  {
    name: "email_greeting_block",
    input: "Hi Mike,\n\nGot it — I’ll have the team follow up.\n\nThanks,\nBrooke",
    expect: "Hi Mike,\n\nI’ll have the team follow up.\n\nThanks,\nBrooke"
  },
  { name: "mid_body_sentence", input: "Thanks. Got it — I’ll follow up.", expect: "Thanks. I’ll follow up." }
];

for (const c of stripCases) {
  const got = stripGotItAcknowledgement(c.input);
  assert.equal(got, c.expect, `strip[${c.name}] expected ${JSON.stringify(c.expect)} got ${JSON.stringify(got)}`);
  assert.doesNotMatch(got, GOT_IT_RE, `strip[${c.name}] still contains a "got it" ack: ${JSON.stringify(got)}`);
  // The full tone pipeline must also leave no "got it" ack behind.
  assert.doesNotMatch(applyDeterministicToneOverrides(c.input), GOT_IT_RE, `tone[${c.name}] still contains "got it"`);
}

// ---------------------------------------------------------------------------
// 2) Preservation: "got it" with a non-ack meaning must NOT be touched.
// ---------------------------------------------------------------------------
const preserveCases: string[] = [
  "As soon as we’ve got it in stock, I’ll text you.",
  "You got it.",
  "I’ll keep an eye out and text you once we’ve got it.",
  "We don’t have it yet, but the moment we’ve got it I’ll let you know."
];
for (const input of preserveCases) {
  assert.equal(stripGotItAcknowledgement(input), input, `preserve: must not rewrite ${JSON.stringify(input)}`);
  assert.equal(
    applyDeterministicToneOverrides(input),
    applyDeterministicToneOverrides(input.replace(/\s+/g, " ").trim()),
    `preserve(tone): possessive/affirmation "got it" must survive the full pipeline for ${JSON.stringify(input)}`
  );
}

// ---------------------------------------------------------------------------
// 3) End-to-end through the real sink (appendOutbound) on the SMS/draft path.
// ---------------------------------------------------------------------------
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "outbound-no-got-it-eval-"));
process.env.CONVERSATIONS_DB_PATH = path.join(tempDir, "conversations.json");

const { appendInbound, appendOutbound, upsertConversationByLeadKey } = await import(
  "../services/api/src/domain/conversationStore.ts"
);

let seq = 0;
function convWith(inbound: string) {
  seq += 1;
  const conv = upsertConversationByLeadKey(`+1716777${String(3000 + seq)}`, "suggest");
  appendInbound(conv, {
    from: conv.leadKey,
    to: "+17165550000",
    body: inbound,
    receivedAt: new Date().toISOString(),
    provider: "twilio",
    providerMessageId: `SM_nogotit_in_${seq}`
  });
  return conv;
}

const e2e: Array<{ inbound: string; draft: string }> = [
  { inbound: "How much is the Street Glide out the door?", draft: "Got it — I’ll have a manager pull the exact pricing and follow up shortly." },
  { inbound: "Please stop texting me.", draft: "Got it — I won’t message you again." },
  { inbound: "I’ll be there around noon.", draft: "Got it." }
];

for (let i = 0; i < e2e.length; i++) {
  const conv = convWith(e2e[i].inbound);
  const stored = appendOutbound(conv, "salesperson", conv.leadKey, e2e[i].draft, "twilio", `SM_nogotit_out_${i}`);
  assert.ok(stored, "outbound should be stored");
  assert.doesNotMatch(stored!.body, /\bGot it\b/, `e2e[${i}] shipped "Got it": ${JSON.stringify(stored!.body)}`);
}

console.log(`outbound_no_got_it_eval passed (${stripCases.length} sink + ${preserveCases.length} preserve + ${e2e.length} e2e)`);
