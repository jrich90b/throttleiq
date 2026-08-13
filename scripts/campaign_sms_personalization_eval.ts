/**
 * campaign_sms_personalization:eval — a campaign SMS goes out with the recipient's NAME on it,
 * and the dealer's own booking link survives the white-label URL strip.
 *
 * THE CAMPAIGN THIS IS BUILT FROM. Joe generated "Pre-Owned Special" (`camp_15a30d02b7f3f_…`) on
 * 2026-08-13T15:00:45Z and asked two things of it: *"Can a sms be personalized with a name when it
 * gets sent out"* and *"I also want to make the sms more sounding like a human instead of just
 * generating verbatim what i typed."* Both answers were no, and a third problem showed up while
 * checking: the call-to-action link was going to be deleted mid-sentence on send.
 *
 * The strings below are VERBATIM from the live store — the generated `smsBody`, the dealer
 * profile's `bookingUrl`, and the junk first names. A plausible-looking invented fixture would
 * pass against predicates that never fire on the real data (SKILL: "the fixture IS the
 * measurement"), and the junk names in particular are not shapes anyone would think to invent.
 *
 * Deterministic — no clock, no network, no LLM.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { rewriteBroadcastSmsBodyForBranding } from "../services/api/src/domain/broadcastSmsUrls.ts";
import {
  buildCampaignGreeting,
  hasLeadingGreeting,
  personalizeCampaignSmsBody,
  resolveCampaignGreetingName
} from "../services/api/src/domain/campaignPersonalization.ts";

/** Verbatim `smsBody` from campaigns.json, campaign "Pre-Owned Special". */
const PRE_OWNED_SPECIAL =
  "Get 10% Customer Cash on any pre-owned Harley through Aug 31 — credit can go toward the bike price, your trade‑in, or parts & accessories. Call (716) 692-7200 or book a visit: https://americanharley.leadrider.ai/book?token=64cd5973-ce99-4256-8b51-fa456ef04531";
/** Verbatim `bookingUrl` from dealer_profile.json — a DEALER-level token, not a per-customer one. */
const DEALER_BOOKING_URL =
  "https://americanharley.leadrider.ai/book?token=64cd5973-ce99-4256-8b51-fa456ef04531";

// ---------------------------------------------------------------------------
// 1) NAME RESOLUTION. 767 of 772 live contacts have a usable first name; the 5
//    that do not are exactly these shapes, read off contacts.json.
// ---------------------------------------------------------------------------
assert.equal(resolveCampaignGreetingName({ firstName: "Mike" }), "Mike", "an ordinary first name is used");
assert.equal(resolveCampaignGreetingName({ firstName: "mike" }), "Mike", "lower-case is normalized");
assert.equal(resolveCampaignGreetingName({ firstName: "MIKE" }), "Mike", "shouty ALL-CAPS is normalized");
assert.equal(
  resolveCampaignGreetingName({ firstName: "Ken Hardy" }),
  "Ken",
  "only the first token is greeted (charter: first name only in message bodies)"
);
assert.equal(resolveCampaignGreetingName({ firstName: "", name: "" }), null, "a blank name is unusable");
for (const junk of ["B", "K", "G"]) {
  assert.equal(
    resolveCampaignGreetingName({ firstName: junk }),
    null,
    `a single letter (${junk}) is not a name — "Hey ${junk}!" is worse than no name`
  );
}
assert.equal(
  resolveCampaignGreetingName({ firstName: "s           R" }),
  null,
  'the live junk field "s           R" is unusable'
);
assert.equal(resolveCampaignGreetingName({ firstName: "7166795683" }), null, "a phone number is not a name");
assert.equal(resolveCampaignGreetingName({ firstName: "n/a" }), null, "a placeholder is not a name");
assert.equal(resolveCampaignGreetingName({ name: "Carl Wehling" }), "Carl", "falls back to `name`");

// ---------------------------------------------------------------------------
// 2) THE GREETING. Ends with its own terminator so a generated body keeps its
//    capital: "Hey Mike, Get 10%..." would be wrong.
// ---------------------------------------------------------------------------
assert.equal(buildCampaignGreeting("Mike"), "Hey Mike! ", "named greeting");
assert.equal(buildCampaignGreeting(null), "Hey there! ", "name-less greeting is still warm");
assert.ok(!buildCampaignGreeting("Mike").includes("—"), "the greeting adds no em-dash (charter diet)");

// ---------------------------------------------------------------------------
// 3) THE REAL CAMPAIGN, PERSONALIZED. This is the whole ask.
// ---------------------------------------------------------------------------
const forMike = personalizeCampaignSmsBody(PRE_OWNED_SPECIAL, { firstName: "Mike" });
assert.ok(forMike.startsWith("Hey Mike! Get 10% Customer Cash"), `got: ${forMike.slice(0, 60)}`);
assert.ok(forMike.includes(DEALER_BOOKING_URL), "personalizing does not disturb the body");
assert.notEqual(forMike, PRE_OWNED_SPECIAL, "the sent text differs per recipient — that is the point");

const forJunk = personalizeCampaignSmsBody(PRE_OWNED_SPECIAL, { firstName: "B" });
assert.ok(forJunk.startsWith("Hey there! Get 10%"), "an unusable name degrades, never breaks");

// ---------------------------------------------------------------------------
// 4) FAIL DIRECTION. Never double-greet; never fabricate a body.
// ---------------------------------------------------------------------------
assert.equal(hasLeadingGreeting("Hi Mike, we've got 10% off"), true, "detects an existing greeting");
assert.equal(hasLeadingGreeting("Good morning! Big news"), true, "detects a time-of-day greeting");
assert.equal(hasLeadingGreeting("Get 10% Customer Cash"), false, "a bare offer has no greeting");
const alreadyGreeted = "Hey Mike, quick one from American Harley.";
assert.equal(
  personalizeCampaignSmsBody(alreadyGreeted, { firstName: "Mike" }),
  alreadyGreeted,
  "a body that greets itself is left alone — a double greeting is worse than no personalization"
);
assert.equal(personalizeCampaignSmsBody("", { firstName: "Mike" }), "", "an empty body stays empty");
assert.equal(
  personalizeCampaignSmsBody("   ", { firstName: "Mike" }),
  "",
  "a whitespace-only body never becomes a bare greeting"
);

// ---------------------------------------------------------------------------
// 5) THE DEALER BOOKING LINK SURVIVES THE SEND — EXECUTED, not pinned. Without
//    this the real campaign sends as "...or book a visit:" with the URL torn out
//    mid-sentence and a generic dealer link two lines below it.
// ---------------------------------------------------------------------------
const DEALER_SITE = "https://americanharley-davidson.com/";

// THE REGRESSION ITSELF: today's behaviour, reproduced. No allowlist => link deleted.
const withoutAllowlist = rewriteBroadcastSmsBodyForBranding({
  body: PRE_OWNED_SPECIAL,
  brandedFallbackUrl: DEALER_SITE
});
assert.ok(
  !withoutAllowlist.includes(DEALER_BOOKING_URL),
  "baseline: with no allowlist the booking link is stripped (this is the bug)"
);
assert.ok(
  /book a visit:\s*$/m.test(withoutAllowlist.split("\n")[0]),
  "baseline: the sentence is left hanging on a colon"
);

// THE FIX: the dealer's own configured booking URL is preserved verbatim.
const withAllowlist = rewriteBroadcastSmsBodyForBranding({
  body: PRE_OWNED_SPECIAL,
  brandedFallbackUrl: DEALER_SITE,
  preserveUrls: [DEALER_BOOKING_URL]
});
assert.ok(withAllowlist.includes(DEALER_BOOKING_URL), "the dealer's booking link survives the send");
assert.ok(
  !withAllowlist.includes(DEALER_SITE),
  "nothing was stripped, so no branded fallback is bolted on"
);
assert.equal(withAllowlist, PRE_OWNED_SPECIAL, "an allowlisted body passes through untouched");

// THE WHITE-LABEL RULE IS INTACT: everything else on our domain still goes.
const leaky =
  "Check the flyer https://americanharley.leadrider.ai/uploads/campaigns/abc.jpg and our app https://app.leadrider.ai/inbox today.";
const scrubbed = rewriteBroadcastSmsBodyForBranding({
  body: leaky,
  brandedFallbackUrl: DEALER_SITE,
  preserveUrls: [DEALER_BOOKING_URL]
});
assert.ok(!scrubbed.includes("leadrider.ai/uploads"), "an upload URL is still stripped");
assert.ok(!scrubbed.includes("app.leadrider.ai"), "a non-allowlisted leadrider host is still stripped");
assert.ok(scrubbed.includes(DEALER_SITE), "the branded fallback still replaces what was removed");

// The allowlist is EXACT — a lookalike the copy generator invented does not get through.
const spoof = rewriteBroadcastSmsBodyForBranding({
  body: "Book here https://americanharley.leadrider.ai/book?token=deadbeef-0000-0000-0000-000000000000",
  brandedFallbackUrl: DEALER_SITE,
  preserveUrls: [DEALER_BOOKING_URL]
});
assert.ok(
  !spoof.includes("deadbeef"),
  "only the dealer's CONFIGURED booking URL survives — an invented one is still stripped"
);

// ---------------------------------------------------------------------------
// 5b) SOURCE PINS for the wiring that has no importable surface.
// ---------------------------------------------------------------------------
const indexSrc = readFileSync(new URL("../services/api/src/index.ts", import.meta.url), "utf8");
assert.ok(
  /const broadcastPreservedUrl\s*=[\s\S]{0,200}?bookingUrl/.test(indexSrc),
  "the allowlist is fed from the dealer profile's own bookingUrl"
);
assert.ok(
  /preserveUrls: \[broadcastPreservedUrl\]/.test(indexSrc),
  "the broadcast send passes the allowlist through"
);

// ---------------------------------------------------------------------------
// 6) PERSONALIZATION IS ACTUALLY WIRED INTO THE SEND. The module can be perfect
//    while the loop still sends the shared body, and every assertion above would
//    stay green while 772 people get an identical text.
// ---------------------------------------------------------------------------
assert.ok(
  /personalizeCampaignSmsBody\(\s*rewriteBroadcastSmsBodyForBranding\(/.test(indexSrc),
  "the broadcast SMS is personalized per recipient at send time"
);
assert.ok(
  /import \{ personalizeCampaignSmsBody \} from "\.\/domain\/campaignPersonalization\.js";/.test(indexSrc),
  "index.ts imports the personalizer"
);

console.log("campaign_sms_personalization:eval PASS");
