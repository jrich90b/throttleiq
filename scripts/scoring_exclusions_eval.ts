/**
 * Scoring exclusions eval — quality scorers must skip shadow-replay traffic,
 * automated senders, and non-sales threads (release-gate honesty).
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  isAutomatedSenderInbound,
  isNonSalesConversation,
  isShadowReplayMessage
} from "../services/api/src/domain/scoringExclusions.ts";

// Shadow replay markers (scripts/inbound_shadow_replay.ts id formats).
assert.equal(isShadowReplayMessage({ providerMessageId: "SMshadow1781172955abc123" }), true);
assert.equal(isShadowReplayMessage({ providerMessageId: "adf_shadow_1781172955_x1y2z3" }), true);
assert.equal(isShadowReplayMessage({ from: "shadow-replay@leadrider.ai" }), true);
assert.equal(isShadowReplayMessage({ providerMessageId: "SM16cffd94acd340ba7746e936" }), false);
assert.equal(isShadowReplayMessage({ providerMessageId: "MMbd063b253b1db761aa7ef89e" }), false);

// Automated senders (autosender@trafficlogpro.com produced a phantom miss 6/9).
assert.equal(
  isAutomatedSenderInbound({ from: "autosender@trafficlogpro.com", body: "anything" }),
  true
);
assert.equal(isAutomatedSenderInbound({ convId: "autosender@trafficlogpro.com" }), true);
assert.equal(
  isAutomatedSenderInbound({
    from: "someone@yahoo.com",
    body: "This email contains HTML formatted content, please be sure to view it in an HTML capable email client."
  }),
  true
);
assert.equal(isAutomatedSenderInbound({ from: "noreply@hd.com", body: "Lead notification" }), true);
assert.equal(
  isAutomatedSenderInbound({ from: "jacksoncharles32@yahoo.com", body: "Is the Nightster available?" }),
  false
);

// Non-sales threads (Jim Serio hiring thread scored as a customer miss 6/11).
assert.equal(isNonSalesConversation({ followUp: { reason: "hiring_manager_inquiry" } }), true);
assert.equal(isNonSalesConversation({ followUp: { reason: "post_sale" } }), false);
assert.equal(isNonSalesConversation({}), false);

// Scorers must be wired to the shared module.
const wiring: Array<[string, RegExp[]]> = [
  [
    "scripts/tone_quality_eval.ts",
    [/isShadowReplayMessage\(inbound\)/, /isAutomatedSenderInbound\(/, /isNonSalesConversation\(conv\)/]
  ],
  ["scripts/voice_charter_audit.ts", [/isShadowReplayMessage\(m\)/],],
  [
    "scripts/route_audit_watchdog.ts",
    [/isShadowReplayMessage\(m\)/, /isAutomatedSenderInbound\(/, /isNonSalesConversation\(conv\)/]
  ]
];
for (const [file, patterns] of wiring) {
  const src = await fs.readFile(path.resolve(file), "utf8");
  for (const re of patterns) {
    assert.match(src, re, `${file} must use ${re}`);
  }
}

// Shadow replay hermeticity: the spawned shadow API must override the
// loop-exported live-store paths, or it reads/writes production data.
const replaySrc = await fs.readFile(path.resolve("scripts/inbound_shadow_replay.ts"), "utf8");
assert.match(
  replaySrc,
  /CONVERSATIONS_DB_PATH: path\.join\(args\.dataDir, "conversations\.json"\)/,
  "shadow replay must pin CONVERSATIONS_DB_PATH to the shadow data copy"
);

console.log("PASS scoring exclusions eval");
