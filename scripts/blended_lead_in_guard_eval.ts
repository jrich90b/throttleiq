/**
 * blended_lead_in_guard:eval — pins isFabricatedGratitudeLeadIn (leadInGuards.ts) + its wiring
 * into generateBlendedLeadInWithLLM. The blended lead-in LLM acknowledges a customer's chatter
 * before the business reply; it must NOT respond to thanks the customer never gave. Real miss
 * (mike jaglowski, 6/16): "I absolutely love my bike, was more curiosity of what the value is" ->
 * "You're welcome." (affection, not gratitude). The guard drops a gratitude-style lead-in unless
 * the customer's turn actually thanked.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { isFabricatedGratitudeLeadIn } from "../services/api/src/domain/leadInGuards.ts";

// The reproduced production miss: gratitude lead-in, no thanks in the customer turn -> fabricated.
assert.equal(
  isFabricatedGratitudeLeadIn("You're welcome.", "I have to be honest I absolutely love my bike, was more curiosity of what the value is"),
  true,
  "the mike jaglowski miss: 'You're welcome' on affection (no thanks) -> fabricated"
);
assert.equal(isFabricatedGratitudeLeadIn("No problem.", "Can you send pics of the bike?"), true, "'No problem' with no thanks -> fabricated");
assert.equal(isFabricatedGratitudeLeadIn("Happy to help!", "what's my trade worth"), true, "'Happy to help' with no thanks -> fabricated");
assert.equal(isFabricatedGratitudeLeadIn("Anytime.", "do you have any tri glides"), true, "'Anytime' with no thanks -> fabricated");

// A genuine thank-you keeps the gratitude lead-in allowed.
assert.equal(isFabricatedGratitudeLeadIn("You're welcome.", "Thanks so much for the help!"), false, "real thanks -> gratitude lead-in is fine");
assert.equal(isFabricatedGratitudeLeadIn("You're welcome.", "appreciate it"), false, "'appreciate it' is gratitude -> allowed");
assert.equal(isFabricatedGratitudeLeadIn("Happy to help.", "thank you"), false, "'thank you' -> allowed");

// Non-gratitude lead-ins are never touched by this guard.
assert.equal(isFabricatedGratitudeLeadIn("Love that.", "I absolutely love my bike"), false, "warm non-gratitude lead-in -> not flagged");
assert.equal(isFabricatedGratitudeLeadIn("Great question.", "what's the price"), false, "'Great question' -> not a gratitude lead-in");
assert.equal(isFabricatedGratitudeLeadIn("Haha, fair one.", "lol you guys could hire me"), false, "humor lead-in -> not flagged");
assert.equal(isFabricatedGratitudeLeadIn("", "thanks"), false, "empty lead-in -> not flagged");

// Wiring: the blended lead-in generator applies the guard at BOTH filter sites, with the prompt rule.
const draftSrc = fs.readFileSync(path.resolve("services/api/src/domain/llmDraft.ts"), "utf8");
const guardSites = (draftSrc.match(/!isFabricatedGratitudeLeadIn\(leadIn, text\)/g) ?? []).length;
assert.ok(guardSites >= 2, `both lead-in filter sites must apply the gratitude guard (found ${guardSites})`);
assert.ok(/never say 'You're welcome'/i.test(draftSrc) || /respond to thanks the customer did not give/i.test(draftSrc), "the lead-in prompt must forbid fabricated thanks");

console.log("PASS blended-lead-in gratitude guard eval (helper + wiring)");
