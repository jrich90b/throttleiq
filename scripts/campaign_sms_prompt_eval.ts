/**
 * campaign_sms_prompt_eval
 *
 * Pins the channel split in the campaign copy prompt's "Output requirements" block.
 *
 * An SMS-only campaign never uses an email downstream, yet the prompt used to demand a full
 * responsive HTML email for every channel — which burned the gpt-5-mini output-token budget
 * and truncated the SMS draft (the 7/15 incident). For SMS-only we now drop all the HTML/image
 * instructions and keep the required email fields trivial; email/"both" keep the full set.
 */
import { strict as assert } from "node:assert";
import {
  campaignCopyOutputRequirements,
  campaignSmsVoiceRules
} from "../services/api/src/domain/campaignBuilder.js";

const HTML_MARKER = "responsive table-based email markup";
const IMAGE_MARKER = "pair the most relevant image";

// SMS-only: requiresEmailHtml=false, channelSupportsEmailDigest=false.
const sms = campaignCopyOutputRequirements(false, false).join("\n");
assert.ok(sms.startsWith("Output requirements:"), "sms block starts with the header");
assert.ok(/sms_body: 1-2 short sentences/.test(sms), "sms block asks for sms_body");
assert.ok(!sms.includes(HTML_MARKER), "SMS-only must NOT demand responsive HTML email markup");
assert.ok(!sms.includes(IMAGE_MARKER), "SMS-only must NOT include image-pairing instructions");
assert.ok(/Do NOT produce email_body_html/.test(sms), "SMS-only tells the model to skip email HTML");

// Email/both: requiresEmailHtml=true.
const email = campaignCopyOutputRequirements(true, true).join("\n");
assert.ok(email.startsWith("Output requirements:"), "email block starts with the header");
assert.ok(/sms_body: 1-2 short sentences/.test(email), "email block still asks for sms_body");
assert.ok(email.includes(HTML_MARKER), "email channel keeps the responsive HTML requirement");
assert.ok(email.includes(IMAGE_MARKER), "email channel keeps image-pairing instructions");
assert.ok(/Prefer 2-4 sections/.test(email), "digest-capable email prefers multiple sections");

// The SMS block must be materially leaner than the email block (fewer output-requirement lines).
const smsLines = campaignCopyOutputRequirements(false, false).length;
const emailLines = campaignCopyOutputRequirements(true, true).length;
assert.ok(smsLines < emailLines, `SMS block (${smsLines}) must be leaner than email block (${emailLines})`);

// The <= 6 line cap that used to sit here was a proxy for "don't blow the gpt-5-mini OUTPUT
// budget" — the 7/15 incident was caused by demanding a full responsive HTML email as OUTPUT,
// which the HTML/IMAGE assertions above still pin directly. Voice rules are INPUT instructions
// and cannot recreate that failure, so the cap now applies to the channel-specific extras only.
const voiceLines = campaignSmsVoiceRules().length;
const smsChannelSpecific = smsLines - voiceLines - 2; // minus the header + the sms_body line
assert.ok(
  smsChannelSpecific <= 6,
  `SMS-only channel-specific block should stay tight (got ${smsChannelSpecific} lines)`
);

// ---------------------------------------------------------------------------
// VOICE. Campaign copy was the one customer-facing surface that never learned the
// Agent Voice Charter, so it restated the brief verbatim (Joe, 2026-08-13). These
// rules must reach the model on BOTH channels, or the SMS goes back to being ad copy.
// ---------------------------------------------------------------------------
for (const [label, block] of [["sms", sms], ["email", email]] as const) {
  assert.ok(
    /The brief is an INSTRUCTION, not a draft/.test(block),
    `${label} block forbids restating the brief`
  );
  assert.ok(
    /read like a text from someone at the dealership/.test(block),
    `${label} block sets the texting register, not ad copy`
  );
  assert.ok(
    /never sign as a person/i.test(block),
    `${label} block keeps campaigns in the DEALER voice (Joe ruled 2026-08-13)`
  );
  assert.ok(
    /Do NOT write a greeting/.test(block),
    `${label} block leaves the greeting to the send path, which alone knows the recipient`
  );
  assert.ok(/at most ONE dash/.test(block), `${label} block carries the em-dash diet`);
  assert.ok(/just checking in/.test(block), `${label} block carries the banned filler list`);
}

// The charter's short-name rule, so a blast never opens with the full legal name.
assert.ok(/SHORT everyday form of the dealer name/.test(sms), "sms block asks for the casual dealer short name");
assert.ok(/drop Inc\/LLC/.test(sms), "sms block strips legal suffixes");

// PORTABILITY (readiness bar section 2, and the AH-hardcode ratchet that caught this at 134/133):
// these rules ship to every dealer, so they must not name dealer #1. The dealer name reaches the
// model through the prompt's `Dealer:` context line, never through a literal in here.
const voiceBlock = campaignSmsVoiceRules().join("\n");
assert.ok(
  !/american[\s-]?harley|north tonawanda/i.test(voiceBlock),
  "the campaign voice rules must not hardcode a specific dealer"
);

console.log(
  `campaign_sms_prompt_eval: OK (sms=${smsLines} lines, email=${emailLines} lines, voice=${voiceLines})`
);
