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
  firstNameCollidesWithAgentName,
  greetingFirstName,
  resolveAdfAckFirstName,
  hasCustomerReceivedOutbound,
  shouldIntroduceOnAdfTouch,
  buildDealerRideIdentitySentence,
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

// ── The shared collision helpers (also used by the sendgrid inline ADF/email intros so both lanes
//    stay in lock-step). firstNameCollidesWithAgentName: exact first-token, case-insensitive.
assert.equal(firstNameCollidesWithAgentName("Alexandra", "Alexandra"), true);
assert.equal(firstNameCollidesWithAgentName("alexandra", "ALEXANDRA"), true, "case-insensitive");
assert.equal(firstNameCollidesWithAgentName("Alexandra Meinhold", "Alexandra"), true, "first token only");
assert.equal(firstNameCollidesWithAgentName("Nicholas", "Alexandra"), false, "different names never collide");
assert.equal(firstNameCollidesWithAgentName("", "Alexandra"), false, "blank customer name → no collision");
assert.equal(firstNameCollidesWithAgentName("Alexandra", ""), false, "blank agent name → no collision");
assert.equal(firstNameCollidesWithAgentName("Alexander", "Alexandra"), false, "substring is not a collision");
// greetingFirstName: the name to greet with, or "" on a collision (drives the inline "Hi {name} —" sites).
assert.equal(greetingFirstName("Nicholas", "Alexandra"), "Nicholas", "non-collision → the name");
assert.equal(greetingFirstName("Alexandra", "Alexandra"), "", "collision → blank (name-less greeting)");
assert.equal(greetingFirstName("  Alexandra  ", "Alexandra"), "", "collision after trim");
assert.equal(greetingFirstName("", "Alexandra"), "", "blank stays blank");

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

// ── Email/ADF lane name-collision guard (open-critic +17162636134, 2026-07-22). Every sendgrid
//    inline first-touch intro that greets by name AND names the agent must route the greeting name
//    through greetingFirstName(...) so a customer who shares the agent's persona name never gets
//    "Hi Alexandra — This is Alexandra at …". The raw shapes (a bare ${firstName}/${firstNameGreeting}
//    greeting immediately paired with a "This is ${agentName}/${salespersonName}" self-intro) must be gone.
const FORBIDDEN_RAW_INTROS: Array<[RegExp, string]> = [
  [/`Hi \$\{firstName\} — This is \$\{agentName\}/, "EagleRider intro must gate the greeting name (greetingFirstName)"],
  [/`Hi \$\{firstName\} — this is \$\{salespersonName\}/, "walk-in intro must gate the greeting name vs salespersonName"],
  [/const greeting = firstName \? `Hi \$\{firstName\} — `/, "Room58/pricing/meta-promo greeting must gate firstName via greetingFirstName"],
  [/const emailGreeting = firstName \? `Hi \$\{firstName\},`/, "meta-promo email greeting must gate firstName via greetingFirstName"],
  [/`Hi \$\{firstNameGreeting\} — thanks for booking/, "test-ride booking confirm must gate the greeting name via greetingFirstName"]
];
for (const [re, msg] of FORBIDDEN_RAW_INTROS) {
  assert.ok(!re.test(sendgrid), `email-lane collision regression: ${msg}`);
}
// Coverage: the guard is applied at every intro site we migrated (8), not silently dropped.
const greetingHelperUses = (sendgrid.match(/greetingFirstName\(/g) ?? []).length;
assert.ok(
  greetingHelperUses >= 8,
  `expected >=8 greetingFirstName(...) sites in sendgridInbound.ts, found ${greetingHelperUses}`
);

// ---------------------------------------------------------------------------
// THE GREETING CASES THE NAME (2026-08-08). ADF forms record whatever the customer typed, so the
// store holds "igor" and "DONALD" — 52 of 819 leads (6.3%) measured — and the greeting rendered them
// verbatim: "Hey igor,". buildAgentGreeting is the ONE place "Hey {name}, " is written, so the rule
// lives there and no second reader can disagree with it.
// ---------------------------------------------------------------------------
{
  const greet = (n: string | null | undefined) => buildAgentGreeting(n);
  assert.equal(greet("igor"), "Hey Igor, ", "an all-lowercase name is capitalised");
  assert.equal(greet("DONALD"), "Hey Donald, ", "a SHOUTING name is calmed down");
  assert.equal(greet("jean-luc"), "Hey Jean-Luc, ", "and word boundaries include the hyphen");
  assert.equal(greet("o'brien"), "Hey O'Brien, ", "and the apostrophe");

  // The important half: a name that CARRIES case information is how that name is spelled.
  for (const asTyped of ["DeShawn", "O'Brien", "McDonald", "LaToya", "van Dyke"]) {
    assert.equal(
      greet(asTyped),
      `Hey ${asTyped}, `,
      `a mixed-case name must survive untouched — "fixing" ${asTyped} is not an improvement`
    );
  }

  // Degenerate shapes stay safe rather than clever.
  assert.equal(greet("B"), "Hey B, ", "a single initial is left as an initial");
  assert.equal(greet(""), "Hey there, ", "no name still greets");
  assert.equal(greet(null), "Hey there, ", "and a missing name does not throw");
  assert.equal(greet("  igor  "), "Hey Igor, ", "padding is trimmed before casing");

  // One rule, not two: the ADF ack resolver must produce exactly what the greeting would render.
  for (const raw of ["igor", "DONALD", "jean-luc", "DeShawn"]) {
    assert.equal(
      `Hey ${resolveAdfAckFirstName({ firstName: raw })}, `,
      greet(raw),
      `the ADF ack name and the greeting must agree on "${raw}" — two readers of one fact is the bug class`
    );
  }
}


// ── Charter C1.2a on the DEALER-RIDE builders (Rick Williamson +17165241170, 2026-08-16) ──────────
// The rule ("once the customer has received ANY message from us on the thread, never introduce
// again; a second lead form is still the same thread") was implemented in ONE place — the
// riding-academy ack. The three dealer-ride builders hardcoded "This is {name} at {dealer}. ", so a
// second Dealer Lead App form on 8/15 drew "Hi Rick — This is Scott at American Harley-Davidson…"
// eleven days into a live SMS conversation with Scott. MEASURED on the live store: 32 of 90
// repeat-ADFs on an already-two-way thread re-introduced, 18 of them this builder's own line.
{
  const IDENT = { senderFirst: "Scott", dealerName: "American Harley-Davidson" };
  const say = (messages: any[]) => buildDealerRideIdentitySentence({ ...IDENT, messages });

  // A genuine first touch still introduces — unchanged behaviour, and the fail-safe direction.
  assert.equal(say([]), "This is Scott at American Harley-Davidson. ", "a genuine first touch still introduces");
  assert.equal(say([inbound()]), "This is Scott at American Harley-Davidson. ", "inbound-only history still introduces");
  assert.equal(
    say([inbound(), draft(), inbound()]),
    "This is Scott at American Harley-Davidson. ",
    "an unsent draft must NOT suppress the intro (the Zackary regression, same fail direction)"
  );
  assert.equal(say(null as any), "This is Scott at American Harley-Davidson. ", "missing history fails toward introducing");

  // THE MISS: Rick's real provider sequence, copied verbatim from the live store record for
  // +17165241170 (ADF, two stale drafts, a delivered twilio send, his replies, a stale draft, the
  // SECOND ADF). The builder must not re-introduce on the touch that follows.
  const RICK = [
    { direction: "in", provider: "sendgrid_adf" },
    { direction: "out", provider: "draft_ai", draftStatus: "stale" },
    { direction: "out", provider: "draft_ai", draftStatus: "stale" },
    { direction: "out", provider: "twilio" },
    { direction: "in", provider: "twilio" },
    { direction: "out", provider: "twilio" },
    { direction: "in", provider: "twilio" },
    { direction: "out", provider: "draft_ai", draftStatus: "stale" },
    { direction: "in", provider: "sendgrid_adf" }
  ];
  assert.equal(say(RICK), "", "Rick: a second Dealer Lead App form must not re-introduce Scott");
  assert.equal(
    say([inbound(), sent("human"), inbound()]),
    "",
    "a staff text counts too — never re-introduce over a human (C1.2a)"
  );

  // The sentence the builders actually compose, so the assertion covers the CUSTOMER-VISIBLE text
  // and not just the flag. Greeting + identity + the thank-you the builder appends.
  const compose = (messages: any[]) =>
    `Hi Rick — ${say(messages)}Thanks again for coming in for the test ride on the 2021 Road Glide Special.`;
  assert.equal(
    compose([]),
    "Hi Rick — This is Scott at American Harley-Davidson. Thanks again for coming in for the test ride on the 2021 Road Glide Special."
  );
  assert.equal(
    compose(RICK),
    "Hi Rick — Thanks again for coming in for the test ride on the 2021 Road Glide Special.",
    "the repeat touch keeps the greeting and the thank-you, and drops only the self-introduction"
  );
  assert.ok(!compose(RICK).includes("  "), "dropping the identity sentence must not leave a double space");

  // WIRING, counted — the ratchet cannot prove a call site exists (trap 2). Both twins of the
  // post-ride builder AND the ride-outcome draft must go through the helper: index.ts carries two
  // builders + the import (3), sendgridInbound.ts one builder + the import (2).
  const liveSrc = fs.readFileSync(new URL("../services/api/src/index.ts", import.meta.url), "utf8");
  const mailSrc = fs.readFileSync(new URL("../services/api/src/routes/sendgridInbound.ts", import.meta.url), "utf8");
  const count = (src: string) => src.split("buildDealerRideIdentitySentence").length - 1;
  assert.equal(count(liveSrc), 3, "index.ts: the import + BOTH dealer-ride builders call the C1.2a helper");
  assert.equal(count(mailSrc), 2, "sendgridInbound.ts: the import + the post-ride builder call the C1.2a helper");
  // And no builder may go back to hardcoding the identity sentence.
  for (const [name, src] of [["index.ts", liveSrc], ["sendgridInbound.ts", mailSrc]] as const) {
    assert.equal(
      src.split("This is ${senderFirst} at ${dealerName}.").length - 1,
      0,
      `${name} must not hardcode the self-introduction — it goes through buildDealerRideIdentitySentence`
    );
  }
}

console.log("PASS agent voice intro eval (+ ADF first-received intro gate + r2r/finance both-path guard + email-lane name-collision guard)");
