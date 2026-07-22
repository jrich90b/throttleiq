/**
 * Agent-voice intro eval. Pins the softened, charter-compliant agent intro
 * (services/api/src/domain/agentVoice.ts) so it can't silently regress to the old
 * corporate "Hi {name} — This is {agent} at {dealer}." (em-dash + stiff). Dealer-agnostic.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildAgentGreeting,
  buildAgentIntro,
  buildAgentIntroPhrase,
  hasCustomerReceivedOutbound,
  shouldIntroduceOnAdfTouch,
  stripLeadingAgentGreeting
} from "../services/api/src/domain/agentVoice.ts";

// Greeting: casual, comma, no em-dash.
assert.equal(buildAgentGreeting("Nicholas"), "Hey Nicholas, ");
assert.equal(buildAgentGreeting(""), "Hey there, ");
assert.equal(buildAgentGreeting(null), "Hey there, ");

// Full intro: "Hey {name}, it's {agent} over at {dealer}. " — softened, no em-dash, no "This is".
const intro = buildAgentIntro("Nicholas", "Alexandra", "American Harley-Davidson");
assert.equal(intro, "Hey Nicholas, it's Alexandra over at American Harley-Davidson. ");
assert.ok(!intro.includes("—"), "intro must contain no em-dash (charter)");
assert.ok(!/this is /i.test(intro), "intro must not use the old 'This is' phrasing");
assert.ok(intro.startsWith("Hey "), "intro must open with 'Hey'");

// Greeting-less phrase: the intro clause without a "Hey {name}," — used for mid-reply
// identity lines and `${buildAgentGreeting(...)}` openers. buildAgentIntro is just the
// greeting + this phrase, so the two must stay in lock-step.
const introPhrase = buildAgentIntroPhrase("Alexandra", "American Harley-Davidson");
assert.equal(introPhrase, "it's Alexandra over at American Harley-Davidson. ");
assert.ok(!/this is /i.test(introPhrase), "intro phrase must not use the old 'This is' phrasing");
assert.equal(buildAgentGreeting("Nicholas") + introPhrase, intro, "buildAgentIntro = greeting + phrase");

// ── Name-collision guard: the customer's first name == the agent's OWN persona name.
//    The dealer's configured agentName is "Alexandra", so a customer also named Alexandra got
//    "Hey Alexandra, it's Alexandra over at American Harley-Davidson." (open-critic +17162636134,
//    2026-07-22). On a collision, drop the greeting NAME (keep the self-intro) → "Hey there, …".
const collide = buildAgentIntro("Alexandra", "Alexandra", "American Harley-Davidson");
assert.equal(collide, "Hey there, it's Alexandra over at American Harley-Davidson. ");
assert.ok(!/Hey Alexandra, it's Alexandra/i.test(collide), "must not mirror the customer's name as the agent name");
// Case-insensitive + full-name-in-greeting still collides on the first token.
assert.equal(
  buildAgentIntro("alexandra", "Alexandra", "American Harley-Davidson"),
  "Hey there, it's Alexandra over at American Harley-Davidson. ",
  "collision is case-insensitive"
);
assert.equal(
  buildAgentIntro("Alexandra Meinhold", "Alexandra", "American Harley-Davidson"),
  "Hey there, it's Alexandra over at American Harley-Davidson. ",
  "collision keys off the customer's first token, not the full name"
);
// The common, non-colliding case is UNCHANGED (this is the whole point — no personalization lost
// unless the names actually clash). Nicholas != Alexandra → normal greeting.
assert.equal(
  buildAgentIntro("Nicholas", "Alexandra", "American Harley-Davidson"),
  "Hey Nicholas, it's Alexandra over at American Harley-Davidson. ",
  "non-colliding intro keeps the personalized greeting"
);
// A generic/blank agent name never triggers the guard (blank first token).
assert.equal(
  buildAgentIntro("Alexandra", "the team", "American Harley-Davidson"),
  "Hey Alexandra, it's the team over at American Harley-Davidson. ",
  "a generic agent name does not collide with the customer's real name"
);

// Stripper removes BOTH the old and new leading greeting forms before re-prefixing.
assert.equal(stripLeadingAgentGreeting("Hi Nicholas — thanks for reaching out."), "thanks for reaching out.");
assert.equal(stripLeadingAgentGreeting("Hey Nicholas, thanks for reaching out."), "thanks for reaching out.");
assert.equal(stripLeadingAgentGreeting("Thanks for reaching out."), "Thanks for reaching out.");

// ── WHEN to introduce on an inbound ADF. The gate is "has the customer actually RECEIVED anything
//    from us", NOT "is this the first ADF" — an unsent draft must never buy our silence about who we
//    are. Six americanharley leads got a no-intro first message behind an unsent draft (Zackary Hauff
//    +17165985414 2026-07-16; Aaron, Francis, Curtis, Elijah, John). Joe 2026-07-16: "the first
//    outgoing message, the agent should always introduce itself."
const ADF = { isAdfEvent: true };
const draft = (draftStatus = "stale") => ({ direction: "out", provider: "draft_ai", draftStatus });
const sent = (provider = "twilio") => ({ direction: "out", provider });
const inbound = () => ({ direction: "in", provider: "sendgrid_adf" });

// hasCustomerReceivedOutbound — only real, customer-facing sends count.
assert.equal(hasCustomerReceivedOutbound([]), false, "no messages → nothing received");
assert.equal(hasCustomerReceivedOutbound(null), false, "null messages → nothing received");
assert.equal(hasCustomerReceivedOutbound([inbound(), draft()]), false, "an unsent draft is NOT received");
assert.equal(hasCustomerReceivedOutbound([draft(), draft("pending")]), false, "pending/stale drafts are NOT received");
for (const p of ["voice_call", "voice_summary", "voice_transcript", "payment_event"]) {
  assert.equal(
    hasCustomerReceivedOutbound([{ direction: "out", provider: p }]),
    false,
    `${p} is an internal log row, not a message the customer received`
  );
}
for (const p of ["twilio", "sendgrid", "human", "web_widget"]) {
  assert.equal(hasCustomerReceivedOutbound([sent(p)]), true, `${p} IS a real customer-facing send`);
}
assert.equal(hasCustomerReceivedOutbound([{ direction: "in", provider: "twilio" }]), false, "an INBOUND twilio msg is not something we sent");
// An unknown/new provider fails toward "not received" → we introduce again (harmless) rather than
// silently skipping the intro (the bug).
assert.equal(hasCustomerReceivedOutbound([{ direction: "out", provider: "some_new_channel" }]), false, "unknown provider fails toward introducing");

// shouldIntroduceOnAdfTouch — the decision itself.
assert.equal(shouldIntroduceOnAdfTouch({ ...ADF, messages: [] }), true, "a genuine first ADF introduces (unchanged)");
assert.equal(shouldIntroduceOnAdfTouch({ ...ADF, messages: [inbound()] }), true, "inbound-only history still introduces");
// THE REGRESSION: first ADF drafted but never sent, second ADF arrives → must STILL introduce.
assert.equal(
  shouldIntroduceOnAdfTouch({ ...ADF, messages: [inbound(), draft(), inbound()] }),
  true,
  "Zackary: an unsent first-ADF draft must NOT suppress the intro on the next ADF"
);
// Already talked to them for real → do not re-introduce.
assert.equal(
  shouldIntroduceOnAdfTouch({ ...ADF, messages: [inbound(), sent(), inbound()] }),
  false,
  "a real prior send means they know us — no re-intro"
);
assert.equal(
  shouldIntroduceOnAdfTouch({ ...ADF, messages: [inbound(), draft(), sent(), inbound()] }),
  false,
  "a draft plus a real send still counts as contacted"
);
assert.equal(
  shouldIntroduceOnAdfTouch({ ...ADF, messages: [sent("human"), inbound()] }),
  false,
  "a staff text counts — don't re-introduce over a human"
);
// Non-ADF turns are out of scope (this gate only governs the ADF ack path).
assert.equal(shouldIntroduceOnAdfTouch({ isAdfEvent: false, messages: [] }), false, "non-ADF event never routes through the ADF intro");

// ── Both-path source guard: the finance + Rider-to-Rider ADF acks must gate their first-touch intro
//    on "customer RECEIVED" (shouldIntroduceOnAdf / hasCustomerReceivedOutbound), NOT on "is this the
//    first ADF" (isInitialAdf / a raw any-outbound scan). This is the #218 migration; it must cover the
//    rider-to-rider ack (both paths) and the index.ts regenerate finance twin, or an unsent draft makes
//    the customer's first received message skip the intro / pick mid-conversation wording.
const sendgrid = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");
const indexTs = fs.readFileSync("services/api/src/index.ts", "utf8");

// Rider-to-Rider (live ADF intake): builder keyed off shouldIntroduce, fed shouldIntroduceOnAdf; and
// the intro prefix is applied UNCONDITIONALLY (the old `if (isInitialAdf) { ack = applyInitialAdfPrefix }`
// wrapper — the last isInitialAdf-gated intro — is gone).
assert.ok(
  /buildRiderToRiderFinanceLeadReply\(\{[\s\S]*?shouldIntroduce:\s*shouldIntroduceOnAdf/.test(sendgrid),
  "rider-to-rider ADF ack must fork wording on shouldIntroduceOnAdf, not isInitialAdf"
);
assert.ok(
  !/if \(isInitialAdf\) \{\s*ack = await applyInitialAdfPrefix/.test(sendgrid),
  "the rider-to-rider intro prefix must be applied unconditionally (no isInitialAdf wrapper) — applyInitialAdfPrefix self-gates on shouldIntroduceOnAdf"
);

// index.ts regenerate twin: the `hasPriorOutbound` wording gate (finance + rider-to-rider regen) must
// use the shared allowlist helper, so it can't drift from the intake path and never counts an unsent
// draft or a voice/payment log row as contact.
assert.ok(
  /const hasPriorOutbound = hasCustomerReceivedOutbound\(conv\.messages\)/.test(indexTs),
  "index.ts regenerate finance/rider-to-rider wording gate must be hasCustomerReceivedOutbound(conv.messages)"
);
// And the old hand-rolled draft_ai-exclusion scan for this gate must be gone (would reintroduce the
// voice/payment residual + the drift).
assert.ok(
  !/const hasPriorOutbound =\s*\n\s*Array\.isArray\(conv\.messages\) &&/.test(indexTs),
  "the old hand-rolled hasPriorOutbound scan must be replaced by the shared helper"
);

console.log("PASS agent voice intro eval (+ ADF first-received intro gate + r2r/finance both-path guard)");
