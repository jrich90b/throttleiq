/**
 * long_term_message:eval (universal, deterministic) — runs inside ci:eval.
 *
 * Pins the shared long-term-timeline cadence message (`buildLongTermTimelineMessage`) now that
 * the live (orchestrator), ADF/email (sendgridInbound), and outbound-cadence (index.ts) paths
 * all call it instead of keeping copy-pasted twins that had drifted.
 *
 * De-hardcoding pin: the message identity (agent + dealer) must be BUILT FROM the dealer
 * profile passed in — never the old hardcoded "Brooke at American Harley-Davidson" — and the
 * opener must be the charter-softened `buildAgentIntro` line, not the corporate "this is".
 * All dealer-identity values live in fixture objects below; assertions reference the fixture
 * fields (never dealer-fact string literals) so the eval stays universal and proves the same
 * code serves dealer #2 unchanged (eval_suite.manifest.ts guard).
 */
import assert from "node:assert/strict";

import { buildLongTermTimelineMessage } from "../services/api/src/domain/longTermMessage.ts";
import {
  buildAgentIntro,
  stripAgentIntroPhraseForDealer,
  stripLeadingAgentGreeting
} from "../services/api/src/domain/agentVoice.ts";
import { findComputerLikePhrases } from "../services/api/src/domain/voiceBannedPhrases.ts";

// Fixture dealer profiles — identity facts live HERE, not in assertion lines.
const fixtureLive = { agentName: "Alexandra", dealerName: "American Harley-Davidson" };
const fixturePortable = { agentName: "Sam", dealerName: "Example Motorsports" };
const oldHardcodedAgent = "Brooke"; // the bug this eval pins out forever

// (a) Identity comes from the fixture profile, via the standard softened intro helper.
const msg = buildLongTermTimelineMessage({
  agentName: fixtureLive.agentName,
  dealerName: fixtureLive.dealerName,
  firstName: "Jordan",
  timeframe: "4-6 Months",
  hasLicense: true
});
assert.ok(
  msg.startsWith(buildAgentIntro("Jordan", fixtureLive.agentName, fixtureLive.dealerName)),
  `expected the standard buildAgentIntro opener built from the profile: ${msg}`
);
assert.ok(msg.includes(fixtureLive.agentName), `expected the profile agent name in: ${msg}`);
assert.ok(msg.includes(fixtureLive.dealerName), `expected the profile dealer name in: ${msg}`);
assert.ok(msg.includes("a 4-6 Months timeline"), `expected the timeframe to be interpolated: ${msg}`);
assert.doesNotMatch(msg, /\bthis is\b/i, `must not use the corporate "this is" intro: ${msg}`);

// (b) A different dealer profile produces THAT dealer's message (portability for dealer #2).
const msg2 = buildLongTermTimelineMessage({
  agentName: fixturePortable.agentName,
  dealerName: fixturePortable.dealerName,
  timeframe: "12+ Months"
});
assert.ok(msg2.includes(fixturePortable.agentName), `expected dealer #2's agent name in: ${msg2}`);
assert.ok(msg2.includes(fixturePortable.dealerName), `expected dealer #2's dealer name in: ${msg2}`);
assert.ok(!msg2.includes(fixtureLive.agentName), `dealer #1's agent must not leak into dealer #2's message: ${msg2}`);
assert.ok(!msg2.includes(fixtureLive.dealerName), `dealer #1's dealer name must not leak into dealer #2's message: ${msg2}`);
assert.ok(msg2.startsWith("Hey there, "), `missing first name should greet generically: ${msg2}`);

// Missing profile fields degrade gracefully — never to a hardcoded identity.
const msgDealerOnly = buildLongTermTimelineMessage({
  dealerName: fixturePortable.dealerName,
  timeframe: "4-6 Months"
});
assert.ok(msgDealerOnly.includes(fixturePortable.dealerName), `dealer-only fallback should name the dealer: ${msgDealerOnly}`);
const msgAgentOnly = buildLongTermTimelineMessage({
  agentName: fixturePortable.agentName,
  timeframe: "4-6 Months"
});
assert.ok(msgAgentOnly.includes(fixturePortable.agentName), `agent-only fallback should name the agent: ${msgAgentOnly}`);
const msgBare = buildLongTermTimelineMessage({ firstName: "Jordan" });
assert.ok(msgBare.includes("a future timeline"), "missing timeframe should read 'a future timeline'");
assert.doesNotMatch(msgBare, /\ba a\b/i, `missing timeframe must not double the article: ${msgBare}`);

// (c) The old hardcoded identity never appears — in ANY shape, including empty-profile fallbacks.
const allOutputs = [msg, msg2, msgDealerOnly, msgAgentOnly, msgBare];
for (const out of allOutputs) {
  assert.ok(
    !out.toLowerCase().includes(oldHardcodedAgent.toLowerCase()),
    `the old hardcoded agent name must never appear: ${out}`
  );
}
for (const out of [msgAgentOnly, msgBare]) {
  assert.ok(
    !out.toLowerCase().includes(fixtureLive.dealerName.toLowerCase()),
    `no profile passed => no hardcoded dealer identity may appear: ${out}`
  );
}

for (const out of allOutputs) {
  // De-corporatized: the charter-approved "text me", never "reach out".
  assert.match(out, /Just text me when the time is right\./, `expected the de-corped "text me" closer: ${out}`);
  assert.doesNotMatch(out, /reach out/i, `must not re-introduce the "reach out" tell: ${out}`);
  // Clean against the computer-like denylist.
  const hits = findComputerLikePhrases(out);
  assert.equal(hits.length, 0, `long-term message tripped the banned-phrase denylist: ${hits.join(", ")}`);
}

// Initial-ADF prefix dedupe: when the ADF prefix pass re-prepends the profile intro over a
// template that already carries one (mismatched first name / per-send agent override), the
// route strips greeting + any intro naming this dealer first — so the result has exactly ONE
// intro, never two (stripAgentIntroPhraseForDealer, sendgridInbound applyInitialAdfPrefix).
{
  const templated = buildLongTermTimelineMessage({
    agentName: "Casey", // per-send override differs from the profile agent below
    dealerName: fixturePortable.dealerName,
    firstName: "Jordan",
    timeframe: "4-6 Months"
  });
  const deduped = stripAgentIntroPhraseForDealer(stripLeadingAgentGreeting(templated), fixturePortable.dealerName);
  const reprefixed = `${buildAgentIntro("Jordan", fixturePortable.agentName, fixturePortable.dealerName)}${deduped}`;
  const introCount = (reprefixed.match(/\bover at\b/gi) ?? []).length;
  assert.equal(introCount, 1, `re-prefixing a templated intro must yield exactly one intro: ${reprefixed}`);
  assert.ok(!reprefixed.includes("Casey"), `the overridden template agent must be replaced, not doubled: ${reprefixed}`);
  assert.ok(
    reprefixed.includes("You mentioned a 4-6 Months timeline."),
    `the message body must survive the dedupe: ${reprefixed}`
  );
  // No dealer name => strip is a no-op (fails safe toward keeping text).
  assert.equal(stripAgentIntroPhraseForDealer(templated, ""), templated, "empty dealer name must be a no-op");
}

// hasLicense does not change the copy (both originals returned the same string either way).
assert.equal(
  buildLongTermTimelineMessage({ ...fixtureLive, timeframe: "4-6 Months", hasLicense: true }),
  buildLongTermTimelineMessage({ ...fixtureLive, timeframe: "4-6 Months", hasLicense: false }),
  "long-term message copy must be identical regardless of hasLicense"
);

console.log("long_term_message_eval passed");
