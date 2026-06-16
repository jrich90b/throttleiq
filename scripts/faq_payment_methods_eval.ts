/**
 * faq_payment_methods:eval — pins the payment-methods FAQ topic end to end (deterministic; the
 * LLM-recognition fixture lives in dealership_faq_topic_examples.json, exercised by faq_topic:eval).
 *
 * Real miss (Bobby Kindred, +17165701338, 6/16): "Do I have to have cash or can I use debit" — a
 * tender question — had no FAQ topic, so it fell through to the PRICING handoff and drafted
 * "I'll have a manager pull the exact pricing…" (cold re-intro, wrong answer). Fix: a
 * payment_methods FAQ topic + a direct reply. The FAQ parser already runs BEFORE the pricing
 * handoff, so recognizing the tender question answers it instead of escalating.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { buildPaymentMethodsReply } from "../services/api/src/domain/paymentMethodsReply.ts";

const orch = fs.readFileSync(path.resolve("services/api/src/domain/orchestrator.ts"), "utf8");
const draft = fs.readFileSync(path.resolve("services/api/src/domain/llmDraft.ts"), "utf8");
const profile = fs.readFileSync(path.resolve("services/api/src/domain/dealerProfile.ts"), "utf8");
const examples = JSON.parse(fs.readFileSync(path.resolve("scripts/dealership_faq_topic_examples.json"), "utf8")) as Array<{ text: string; expected: { topic: string } }>;

// 1) The reply answers payment_methods directly — confirms debit, never the pricing handoff.
const plain = buildPaymentMethodsReply().toLowerCase();
assert.ok(/debit/.test(plain), "the payment_methods reply must address debit (the customer's question)");
assert.ok(/credit cards/.test(plain), "default reply mentions credit cards (no cap)");
assert.ok(!/up to \$/.test(plain), "default reply states no card cap");
assert.ok(!/manager.*pull|exact pricing|exact numbers/.test(plain), "the payment_methods reply must NOT be the pricing-manager handoff");

// 1b) A configured credit-card cap is rendered; 0 / null / undefined render no cap.
assert.ok(/credit cards \(up to \$1,000\)/.test(buildPaymentMethodsReply({ creditCardCapUsd: 1000 })), "a $1,000 cap renders 'credit cards (up to $1,000)'");
assert.ok(/up to \$5,000/.test(buildPaymentMethodsReply({ creditCardCapUsd: 5000 })), "cap is formatted with thousands separator");
assert.equal(buildPaymentMethodsReply({ creditCardCapUsd: 0 }), buildPaymentMethodsReply(), "cap of 0 -> no stated cap");
assert.equal(buildPaymentMethodsReply({ creditCardCapUsd: null }), buildPaymentMethodsReply(), "null cap -> no stated cap");

// 1c) Wiring: the FAQ case uses the builder, and the dealer profile feeds the cap in.
assert.ok(/case "payment_methods":\s*\n\s*return buildPaymentMethodsReply\(/.test(orch), "the payment_methods case must call buildPaymentMethodsReply");
assert.ok(/creditCardCapUsd: dealerProfile\?\.payments\?\.creditCardCapUsd/.test(orch), "the FAQ call site must pass the dealer-profile card cap");
assert.ok(/creditCardCapUsd\?: number;/.test(profile), "DealerProfile.payments must expose creditCardCapUsd");

// 2) payment_methods is a recognized topic everywhere (type enum in BOTH files, schema, validator).
assert.ok(/\|\s*"payment_methods"/.test(draft), "DealershipFaqTopicParse must include payment_methods");
assert.ok(/\|\s*"payment_methods"/.test(orch), "buildDealershipFaqReply's topic union must include payment_methods");
assert.ok(/"payment_methods",/.test(draft), "the FAQ topic JSON schema enum must include payment_methods");
assert.ok(/topicRaw === "payment_methods"/.test(draft), "the topic validator must whitelist payment_methods (else it normalizes to none)");

// 3) The parser is taught: a topic description + the reproduced few-shot.
assert.ok(/- payment_methods:/.test(draft), "the parser prompt must describe the payment_methods topic");
assert.ok(/"topic":"payment_methods"/.test(draft), "the parser prompt must include a payment_methods few-shot");
assert.ok(/Do I have to have cash or can I use debit/.test(draft), "the reproduced Bobby turn must be a few-shot");

// 4) The LLM-recognition fixture (faq_topic:eval) carries the reproduced turn.
assert.ok(
  examples.some(e => /can i use debit/i.test(e.text) && e.expected.topic === "payment_methods"),
  "dealership_faq_topic_examples.json must pin the cash-or-debit turn -> payment_methods"
);

console.log("PASS faq-payment-methods eval (reply + topic wiring + parser few-shot + fixture)");
