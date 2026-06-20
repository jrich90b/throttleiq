/**
 * sweepstakes_reply:eval (universal, deterministic) — runs inside ci:eval.
 *
 * A national-sweepstakes ADF signup (cta === "sweepstakes", e.g. lead source "National Event
 * Dealer Sweeps") is a non-sales promo entry, NOT a bike inquiry. In prod these were falling
 * through to the general reply path and getting a WRONG-FRAME reply — "Thanks for your inquiry
 * about the 2026 Heritage Classic. If you'd like to stop in…" / "I can set up a test ride…".
 * The handler intercepts cta=sweepstakes early and replies with a congratulatory ack + an offer
 * of help, and starts NO follow-up cadence. This eval pins the copy + the wiring.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  buildSweepstakesSignupReply,
  hasSweepstakesSignupAcknowledgement
} from "../services/api/src/domain/workflowRegressionGuards.ts";
import { findComputerLikePhrases } from "../services/api/src/domain/voiceBannedPhrases.ts";

// ---- Copy: congratulatory non-sales ack, charter-clean ----
const reply = buildSweepstakesSignupReply();
assert.match(reply, /national sweepstakes/i, "must name the national sweepstakes");
assert.match(reply, /good luck/i, "must wish good luck");
assert.match(reply, /let me know/i, "must offer help");
assert.doesNotMatch(
  reply,
  /\bstop in\b|\bstop by\b|inquiry about|interested in the|pricing|test ride/i,
  "must not pitch a unit / stop-in / test ride"
);
assert.doesNotMatch(reply, /\bGot it\b/, 'no "Got it" ack');
assert.equal(
  findComputerLikePhrases(reply).length,
  0,
  `reply tripped the banned-phrase denylist: ${findComputerLikePhrases(reply).join(", ")}`
);
assert.ok((reply.match(/—/g) ?? []).length <= 1, "at most one em-dash");

// ---- Idempotency guard (no double-ack on replay/regenerate) ----
assert.equal(hasSweepstakesSignupAcknowledgement([{ direction: "out", body: reply }]), true, "guard true on the ack");
assert.equal(
  hasSweepstakesSignupAcknowledgement([
    { direction: "out", body: "Thanks for your inquiry about the 2026 Heritage Classic. If you'd like to stop in, just let me know." }
  ]),
  false,
  "guard false on a bike-inquiry reply"
);
assert.equal(hasSweepstakesSignupAcknowledgement([{ direction: "in", body: reply }]), false, "guard ignores inbound");

// ---- Wiring: route intercepts cta=sweepstakes early, with NO cadence ----
const route = fs.readFileSync(path.join(process.cwd(), "services/api/src/routes/sendgridInbound.ts"), "utf8");
assert.ok(
  /const isSweepstakesSignup =[\s\S]{0,200}inferredCta === "sweepstakes"/.test(route),
  "branch keyed on inferredCta === sweepstakes"
);
const branchIdx = route.indexOf("if (isSweepstakesSignup)");
assert.ok(branchIdx >= 0, "isSweepstakesSignup branch present");
const branch = route.slice(branchIdx, branchIdx + 1000);
assert.ok(branch.includes("buildSweepstakesSignupReply()"), "branch builds the sweepstakes ack");
assert.ok(branch.includes("publishEarlyAdfSmsDraft(ack)"), "branch publishes the ack");
assert.ok(/closeConversation\(conv, "sweepstakes_no_cadence"\)/.test(branch), "branch closes with no-cadence reason");
assert.ok(
  !/scheduleLongTermFollowUp|setFollowUpMode\(conv, "active"|startFollowUpCadence/.test(branch),
  "branch must start NO follow-up cadence"
);
assert.ok(
  branchIdx < route.indexOf("if (isDealerRideEventLead)"),
  "sweepstakes intercept must precede the general dealer-ride / bike-reply path"
);

console.log("sweepstakes_reply_eval passed");
