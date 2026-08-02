/**
 * Prior-intro owner identity eval (agent-watch held-draft sweep, 2026-08-02).
 *
 * THE MISS this pins. `resolveConversationAgentName` hands a thread to its `leadOwner` only when
 * the thread is a walk-in or an explicit manual takeover. But on an ordinary lead the owner often
 * introduced themselves anyway — via the CRM, an imported history row, or a hand-sent text — and
 * none of those rows carry an `actorUserName`, so the historic-backfill scan skips them and the
 * NEXT draft signs with the configured persona instead. The customer is told "This is {owner} at
 * …" in May and "it's {persona} over at …" in August, on the same thread.
 *
 * 26 threads in the americanharley store sit in exactly that state, and the live draft-quality
 * judge already calls the flip a defect ("introduces a new staff name inconsistent with prior
 * thread ... could confuse the customer") — it was the most common self-heal reason across
 * 2026-08-01/02, and self-heal does NOT reliably fix it (a 08-02 heal on such a thread left the
 * persona name in place).
 *
 * THE FIX: `resolveIntroducedOwnerFirstName` — when a message the customer ACTUALLY RECEIVED
 * introduced the thread's own `leadOwner` by name, that owner keeps the thread.
 *
 * The two rails this eval exists to hold, because the return value gets SIGNED ON A CUSTOMER TEXT:
 *  (1) the name can only ever be the thread's own `leadOwner` — never a token scraped from prose;
 *  (2) an unapproved `draft_ai` row is NOT evidence the customer heard anything (same lesson as
 *      `buildCustomerReceivedHistory` / `draft_judge_received_history:eval`).
 * No evidence → null → the caller keeps today's persona answer. Fixture-driven, dealer-portable:
 * fictional names, no per-dealer fact, no LLM call.
 */
import assert from "node:assert/strict";
import {
  buildAgentSelfIntroPattern,
  resolveIntroducedOwnerFirstName
} from "../services/api/src/domain/agentVoice.ts";

const OWNER = "Marcus Webb";

const received = (body: string) => ({ direction: "out", provider: "twilio", body });
const inbound = (body: string) => ({ direction: "in", provider: "twilio", body });

// ── (1) THE MISS: the owner introduced themselves on a delivered text → the thread stays theirs.
assert.equal(
  resolveIntroducedOwnerFirstName({
    ownerName: OWNER,
    messages: [
      received("Hi Dana — This is Marcus at Lakeside Cycle Works. Thanks again for coming in for the test ride."),
      inbound("Thank you guys for doing the demo event, always a pleasure stopping in.")
    ]
  }),
  "Marcus",
  "a delivered 'This is {owner}' intro hands the thread to its owner"
);

// Every intro shape the codebase emits counts — `buildAgentIntroPhrase` is the live one.
for (const shape of [
  "Hey Dana, it's Marcus over at Lakeside Cycle Works. What can I help with?",
  "Hey Dana, it's Marcus at Lakeside Cycle Works. What can I help with?",
  "Hey Dana, I'm Marcus at Lakeside Cycle Works. What can I help with?"
]) {
  assert.equal(
    resolveIntroducedOwnerFirstName({ ownerName: OWNER, messages: [received(shape)] }),
    "Marcus",
    `intro shape recognized: ${shape}`
  );
}

// ── (2) FAIL DIRECTION: an unsent draft is not something the customer heard.
assert.equal(
  resolveIntroducedOwnerFirstName({
    ownerName: OWNER,
    messages: [
      { direction: "out", provider: "draft_ai", draftStatus: "stale", body: "Hi Dana — This is Marcus at Lakeside Cycle Works." } as any,
      inbound("still thinking about it")
    ]
  }),
  null,
  "an unapproved draft_ai row is a proposal, not a message the customer received"
);

// Internal log rows are not customer-facing either (voice summaries quote staff by name).
assert.equal(
  resolveIntroducedOwnerFirstName({
    ownerName: OWNER,
    messages: [{ direction: "out", provider: "voice_summary", body: "This is Marcus at Lakeside Cycle Works, call summary." } as any]
  }),
  null,
  "an internal voice_summary row is not a delivered introduction"
);

// ── (3) THE NAME CAN ONLY BE THE OWNER: a different rep's intro never becomes the sender.
assert.equal(
  resolveIntroducedOwnerFirstName({
    ownerName: OWNER,
    messages: [received("Hi Dana — This is Priya at Lakeside Cycle Works, covering for the weekend.")]
  }),
  null,
  "an intro naming somebody other than the leadOwner is not evidence about the owner"
);

// Prose that merely contains the owner's name is not an introduction.
for (const notAnIntro of [
  "Marcus said the Road King is still available if you want to come look.",
  "Hey Dana, it's Marcus's day off but I can help you today.",
  "Talk to Marcus at the counter when you get here."
]) {
  assert.equal(
    resolveIntroducedOwnerFirstName({ ownerName: OWNER, messages: [received(notAnIntro)] }),
    null,
    `prose mentioning the owner is not a self-intro: ${notAnIntro}`
  );
}

// ── (4) NO OWNER / NO EVIDENCE → null, i.e. the caller keeps today's persona behaviour.
assert.equal(resolveIntroducedOwnerFirstName({ ownerName: "", messages: [received("This is Marcus at Lakeside Cycle Works.")] }), null);
assert.equal(resolveIntroducedOwnerFirstName({ ownerName: "our team", messages: [received("This is Marcus at Lakeside Cycle Works.")] }), null);
assert.equal(resolveIntroducedOwnerFirstName({ ownerName: OWNER, messages: [] }), null);
assert.equal(resolveIntroducedOwnerFirstName({ ownerName: OWNER, messages: null }), null);
assert.equal(
  resolveIntroducedOwnerFirstName({
    ownerName: OWNER,
    messages: [received("Hey Dana, it's Alexis over at Lakeside Cycle Works. What can I help with?"), inbound("hi")]
  }),
  null,
  "a persona-only history leaves the thread with the persona"
);

// An INBOUND that happens to name the owner is the customer talking, not us introducing anyone.
assert.equal(
  resolveIntroducedOwnerFirstName({ ownerName: OWNER, messages: [inbound("Hey is this Marcus at Lakeside Cycle Works?")] }),
  null,
  "the customer naming the owner is not us introducing the owner"
);

// ── (5) Pattern hygiene: regex metacharacters in a name must not blow up or over-match.
const oddPattern = buildAgentSelfIntroPattern("D'An(gelo)");
assert.ok(oddPattern, "a name with metacharacters still yields a pattern");
assert.ok(oddPattern!.test("Hi — This is D'An(gelo) at Lakeside Cycle Works."), "metacharacters match literally");
assert.equal(buildAgentSelfIntroPattern(""), null, "no name → no pattern");
assert.equal(buildAgentSelfIntroPattern(null), null, "no name → no pattern");

console.log("agent_identity_prior_intro:eval OK — owner-introduced threads keep their owner; drafts, other reps, and prose do not.");
