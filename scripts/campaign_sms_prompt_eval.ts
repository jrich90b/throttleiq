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
import { campaignCopyOutputRequirements } from "../services/api/src/domain/campaignBuilder.js";

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
assert.ok(smsLines <= 6, `SMS block should be tight (got ${smsLines} lines)`);

console.log(`campaign_sms_prompt_eval: OK (sms=${smsLines} lines, email=${emailLines} lines)`);
