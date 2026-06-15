/**
 * Agent-voice intro eval. Pins the softened, charter-compliant agent intro
 * (services/api/src/domain/agentVoice.ts) so it can't silently regress to the old
 * corporate "Hi {name} — This is {agent} at {dealer}." (em-dash + stiff). Dealer-agnostic.
 */
import assert from "node:assert/strict";
import {
  buildAgentGreeting,
  buildAgentIntro,
  buildAgentIntroPhrase,
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

// Stripper removes BOTH the old and new leading greeting forms before re-prefixing.
assert.equal(stripLeadingAgentGreeting("Hi Nicholas — thanks for reaching out."), "thanks for reaching out.");
assert.equal(stripLeadingAgentGreeting("Hey Nicholas, thanks for reaching out."), "thanks for reaching out.");
assert.equal(stripLeadingAgentGreeting("Thanks for reaching out."), "Thanks for reaching out.");

console.log("PASS agent voice intro eval");
