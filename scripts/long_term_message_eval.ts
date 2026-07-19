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
import { readFileSync } from "node:fs";

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
// Joe ruling 2026-07-19: even when a timeframe IS present, the copy must NOT claim the
// customer "mentioned/said" it — it's usually a FORM field, not a conversational statement.
assert.doesNotMatch(
  msg,
  /you (mentioned|said|told)/i,
  `must not attribute a timeframe the customer never stated in conversation: ${msg}`
);
assert.doesNotMatch(msg, /timeline/i, `must not reference a timeline the customer didn't state: ${msg}`);
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
// Missing timeframe must NOT fabricate one (the old copy said "you mentioned a future
// timeline" — a claim on a timeframe the customer never gave). No timeline reference at all.
assert.doesNotMatch(msgBare, /timeline/i, `missing timeframe must not fabricate a timeline claim: ${msgBare}`);
assert.doesNotMatch(msgBare, /you (mentioned|said|told)/i, `missing timeframe must not attribute a statement: ${msgBare}`);
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
  // Joe ruling 2026-07-19: NO output may attribute an unstated timeframe/statement.
  assert.doesNotMatch(out, /you (mentioned|said|told)/i, `no output may attribute an unstated statement: ${out}`);
  assert.doesNotMatch(out, /timeline/i, `no output may reference an unstated timeline: ${out}`);
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
    reprefixed.includes("Just text me when the time is right."),
    `the message body (neutral closer) must survive the dedupe: ${reprefixed}`
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

// (d) Source-level parity: the live-tick twin `buildLongTermFollowUp` (index.ts, used by
// processDueFollowUpsUnlocked) must ALSO be free of the "since you mentioned a {timeframe}
// timeline" attribution — otherwise the ruled +13476815373 production copy regenerates on the
// live path while the canonical builder is clean. Pin it at the source, like the other
// two-path cadence evals do.
{
  const indexSrc = readFileSync("services/api/src/index.ts", "utf8");
  const start = indexSrc.indexOf("async function buildLongTermFollowUp(");
  assert.ok(start >= 0, "buildLongTermFollowUp must exist in index.ts");
  const body = indexSrc.slice(start, start + 4000);
  assert.doesNotMatch(
    body,
    /you mentioned a \$\{timeframe\} timeline/i,
    "buildLongTermFollowUp must not attribute the ADF-form timeframe as a customer statement"
  );
  assert.doesNotMatch(
    body,
    /since you mentioned/i,
    "buildLongTermFollowUp must not use the 'since you mentioned' attribution the ruling retired"
  );
}

console.log("long_term_message_eval passed");
