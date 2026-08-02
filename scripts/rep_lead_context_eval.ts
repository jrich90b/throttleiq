/**
 * rep_lead_context:eval — pins the "Before you reply" strip the console shows a rep (2026-08-02).
 *
 * WHY. Measured over 45 days: 1,569 outbound messages, of which 45% were typed by a PERSON and
 * 32% of ALL outbound never touched a draft. The product assumes agent-drafts / staff-approves, so
 * every feature built on the draft loop is blind to a third of customer contact.
 *
 * The cost, concretely: Dennis Daffron (+16303628805) arrived on a Room58 ADF naming a 2024 Street
 * Glide, stock U902-24. The agent opened with it correctly. Thirteen hours later a rep texted from
 * a phone "reaching out to see what bike you were inquiring about?", and Dennis replied "Im only
 * interested in the bike I inquired about." Ten days later he asked "What bike was this again for
 * 22995" — the bike and the figure lived in two different heads.
 *
 * These readers are PURE and cannot change what gets sent. The contract they must keep is that a
 * row is SILENT rather than wrong: anything we cannot state specifically renders nothing.
 *
 * Run: npx tsx scripts/rep_lead_context_eval.ts   (no LLM)
 */
import assert from "node:assert/strict";
// apps/web is CommonJS (no "type":"module"), so this ESM eval reads the named exports off the
// interop default rather than destructuring the import. Same module the console renders from —
// this eval must never grade a copy (the cadence-repeat eval already got burned scoring a
// hand-copy that had drifted from the shipped code).
import leadContext from "../apps/web/src/lib/leadContext.ts";
const {
  formatLeadBikeLabel,
  findLastDealerQuote,
  findOpenCustomerQuestion,
  buildRepLeadContext,
  isDeliveredOutbound
} = leadContext as any;

let n = 0;
const sent = (body: string, at = "2026-07-23T14:45:00.000Z") => ({ direction: "out" as const, body, at, provider: "twilio" });
const draft = (body: string, at = "2026-07-23T01:06:00.000Z") => ({ direction: "out" as const, body, at, provider: "draft_ai", draftStatus: "stale" });
const from = (body: string, at = "2026-07-23T14:36:00.000Z") => ({ direction: "in" as const, body, at, provider: "twilio" });

// --- 1) the bike, from the lead card ------------------------------------------------------------
assert.equal(
  formatLeadBikeLabel({ vehicle: { year: "2024", model: "Street Glide", stockId: "STK-200" } }),
  "2024 Street Glide · STK-200",
  "DENNIS-shaped: the label the rep never saw (his real stock number is dealer-specific, so the"
  + " fixture uses a neutral one — the portability guard keeps universal evals dealer-agnostic)"
);
assert.equal(formatLeadBikeLabel({ vehicle: { year: 2024, model: "Street Glide" } }), "2024 Street Glide", "numeric year, no stock");
assert.equal(formatLeadBikeLabel({ vehicle: { model: "Road Glide", stockId: "STK-100" } }), "Road Glide · STK-100", "no year is fine");
assert.equal(formatLeadBikeLabel({ vehicle: { year: "2002", description: "Harley-Davidson Flhrci" } }), "2002 Harley-Davidson Flhrci", "falls back to description");
// SILENT RATHER THAN WRONG: a stock number alone is not something a rep can say to a customer.
assert.equal(formatLeadBikeLabel({ vehicle: { stockId: "STK-200" } }), null, "stock number alone renders nothing");
assert.equal(formatLeadBikeLabel({ vehicle: null }), null);
assert.equal(formatLeadBikeLabel(null), null);
assert.equal(formatLeadBikeLabel({}), null);
n += 8;

// --- 2) delivered vs drafted --------------------------------------------------------------------
// An unsent draft is not something the customer has seen; treating one as a reply is exactly the
// bug that made a dead thread look recent (open-critic #431) and fed the live judge (8/1).
assert.equal(isDeliveredOutbound(sent("hi")), true);
assert.equal(isDeliveredOutbound(draft("hi")), false, "a stale draft was never delivered");
assert.equal(isDeliveredOutbound({ direction: "out", body: "x", provider: "draft_ai", draftStatus: "pending" }), false, "a PENDING draft is not a reply either");
assert.equal(isDeliveredOutbound(from("hi")), false);
n += 4;

// --- 3) the last price WE quoted ----------------------------------------------------------------
const quoteThread = [
  from("whats the out the door price?"),
  sent("Since its a out of state sale your out the door price is $22,995 no NYS sales tax", "2026-07-23T14:45:00.000Z")
];
assert.equal(findLastDealerQuote(quoteThread)?.amount, "$22,995", "DENNIS: the figure he asked about 10 days later");
// Newest wins.
assert.equal(
  findLastDealerQuote([sent("was $19,500", "2026-07-01T00:00:00.000Z"), sent("now $18,250", "2026-07-05T00:00:00.000Z")])?.amount,
  "$18,250"
);
assert.equal(findLastDealerQuote([sent("around $9,995 before tax")])?.amount, "$9,995");
assert.equal(findLastDealerQuote([sent("$22995.00 out the door")])?.amount, "$22995.00", "no-comma and cents forms");
// A price the customer names is THEIRS, not a quote we made.
assert.equal(findLastDealerQuote([from("I was offered $21,000 elsewhere")]), null, "a customer's own number is not our quote");
// An unsent draft never counts as a quote the customer received.
assert.equal(findLastDealerQuote([draft("I can do $20,000")]), null, "a draft quote was never sent");
assert.equal(findLastDealerQuote([sent("no numbers here")]), null);
assert.equal(findLastDealerQuote([]), null);
assert.equal(findLastDealerQuote(null), null);
n += 9;

// --- 4) the question still waiting on an answer -------------------------------------------------
assert.equal(
  findOpenCustomerQuestion([sent("hi"), from("Do you offer shipping to Illinois?")])?.text,
  "Do you offer shipping to Illinois?",
  "an unanswered question surfaces"
);
// KNOWN LIMIT, pinned deliberately. Dennis actually wrote "Do you offer shipping to Illinois" with
// NO question mark, and plenty of SMS questions arrive that way — so this row stays SILENT on them.
// That is the chosen trade: inferring a question from phrasing is a comprehension call, and getting
// it wrong would put words in the customer's mouth on the rep's screen. The bike and quote rows
// still render. Revisit only with a typed parser, never with a looser pattern.
assert.equal(
  findOpenCustomerQuestion([sent("hi"), from("Do you offer shipping to Illinois")]),
  null,
  "no '?' => silent, even on a real question (documented limit, not a bug)"
);
// A DELIVERED reply closes the loop — this is the guard that keeps the strip from nagging.
assert.equal(
  findOpenCustomerQuestion([from("Do you offer shipping?"), sent("We can line up shipping.")]),
  null,
  "answered => nothing outstanding"
);
// ...but an unsent draft does NOT close it. This is the Dennis case: a stale draft sat in the box
// while his question went unanswered.
assert.equal(
  findOpenCustomerQuestion([from("What bike was this again for 22995?"), draft("Totally fair — the Street Glide is a strong pick…")])?.text,
  "What bike was this again for 22995?",
  "a DRAFT does not answer the customer"
);
// Conservative on purpose: no question mark, no claim. Guessing would put words in the customer's
// mouth on the rep's screen.
assert.equal(findOpenCustomerQuestion([from("I need the best out the door price")]), null, "no '?' => we do not guess");
// Machine payloads and call transcripts are not the customer asking us something.
assert.equal(findOpenCustomerQuestion([from("WEB LEAD (ADF) Source: Room58 Ref: 11671 Inquiry: ?")]), null, "ADF payload is not a question");
assert.equal(findOpenCustomerQuestion([from("Agent: If you know your party's extension?")]), null, "call transcript is not a question");
assert.equal(findOpenCustomerQuestion([]), null);
assert.equal(findOpenCustomerQuestion(null), null);
n += 8;

// --- 5) the whole strip, on Dennis's real thread ------------------------------------------------
const dennis = buildRepLeadContext(
  { vehicle: { year: "2024", model: "Street Glide", stockId: "STK-200", condition: "used" } },
  [
    from("I live in Illinois im hard of hearing text is best whats the out the door price?", "2026-07-23T01:06:00.000Z"),
    sent("Since its a out of state sale your out the door price is $22,995", "2026-07-23T14:45:00.000Z"),
    from("What bike was this again for 22995", "2026-08-02T15:45:00.000Z")
  ]
);
assert.equal(dennis.bike, "2024 Street Glide · STK-200");
assert.equal(dennis.lastQuote?.amount, "$22,995");
// No '?' in his last message, so no claim is made — the bike and the quote alone answer him.
assert.equal(dennis.openQuestion, null);
assert.equal(dennis.hasAnything, true, "the strip renders for Dennis");
n += 4;

// A bare thread renders NOTHING at all — the strip never occupies space it cannot earn.
const empty = buildRepLeadContext(null, []);
assert.equal(empty.hasAnything, false);
assert.equal(empty.bike, null);
assert.equal(empty.lastQuote, null);
assert.equal(empty.openQuestion, null);
n += 4;

console.log(`PASS rep lead-context eval (${n} assertions — bike, last quote, open question; silent rather than wrong; drafts never count as delivered)`);
