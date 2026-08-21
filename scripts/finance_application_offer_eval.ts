/**
 * CREDIT-APPLICATION OFFER when the customer ASKS whether they can finance (Joe, 2026-08-20).
 *
 * Maxie Johnson +17166036684, 2026-08-19 16:45Z: "I hoping to see if you had financing for bad
 * credit or credit building". He got the co-signer nudge — right copy, Joe's own 2026-07-16 rule —
 * which ends by asking HIM a question. He never answered, a voicemail went unreturned, and nothing
 * ever offered him the credit application.
 *
 * MEASURED 2026-08-20 on the live store, and the numbers are why this exists:
 *   - `financeAppInviteSentAt` is set on **0 leads**. The offer has never gone out, to anyone.
 *   - its only trigger is the "manual quote details received" moment, which has never occurred.
 *   - the two finance pre-filters already in the tree were written for OTHER classes (credit
 *     distress; paperwork timing) and between them let **11 of 12** ordinary ways of asking
 *     ("Do you guys do financing?", "How do I apply?", "Can I get financed?") through to NOTHING.
 *
 * Pure, no LLM. Run: npx tsx scripts/finance_application_offer_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const F = await import("../services/api/src/domain/financeApplicationOffer.ts");
const INV = await import("../services/api/src/domain/financeAppInvite.ts");

let n = 0;
const ok = (cond: boolean, msg: string) => {
  assert.equal(cond, true, msg);
  n++;
};

const URL = "https://creditapplication.harley-davidson.com/us/en/?dealerid=3436";
const BOOK = "https://americanharley.leadrider.ai/book?token=abc";
type Parse = Awaited<ReturnType<typeof F.parseFinanceApplicationInterestWithLLM>>;
const parse = (over: Partial<NonNullable<Parse>> = {}): NonNullable<Parse> =>
  ({ asks_about_financing: true, ask_kind: "can_i_finance", confidence: 0.9, ...over }) as any;
const decide = (over: Record<string, unknown> = {}) =>
  F.decideFinanceApplicationOfferTurn({
    parse: parse(),
    confidenceMin: 0.7,
    alreadyOffered: false,
    creditAppAvailable: true,
    ...(over as any)
  }).kind;

// ---------------------------------------------------------------------------
// PART 1 — the decision table
// ---------------------------------------------------------------------------
ok(decide() === "offer_credit_application", "a confident 'can I finance' ask offers the application");
for (const k of ["can_i_finance", "how_do_i_apply", "credit_barrier"] as const) {
  ok(decide({ parse: parse({ ask_kind: k }) }) === "offer_credit_application", `${k} is offerable`);
}
// The two kinds deliberately EXCLUDED, and the reason is the measurement: 43 customer messages on
// the store mention financing/applying/approval and most are people already approved or shopping
// rates. An application is not an answer to "my credit union quoted 6.29%".
ok(
  decide({ parse: parse({ ask_kind: "rate_or_terms", asks_about_financing: false }) }) === "none",
  "a RATE question is never answered with an application form"
);
ok(
  decide({ parse: parse({ ask_kind: "already_handled", asks_about_financing: false }) }) === "none",
  "someone already approved is not offered an application"
);
ok(decide({ parse: parse({ ask_kind: "none", asks_about_financing: false }) }) === "none", "a non-finance turn is none");
// ISOLATES the offerable-kind set. The three rows above pair the excluded kind with
// asks_about_financing:false, so the earlier gate catches them and the kind set is never exercised
// — a sabotage adding rate_or_terms to OFFERABLE_ASK_KINDS survived exactly that way. Here the
// parser says "yes, a finance ask" and ONLY the kind may refuse it.
ok(
  decide({ parse: parse({ ask_kind: "rate_or_terms", asks_about_financing: true, confidence: 0.99 }) }) === "none",
  "a rate question is refused BY THE KIND, even when the parser calls it a finance ask"
);
ok(
  decide({ parse: parse({ ask_kind: "already_handled", asks_about_financing: true, confidence: 0.99 }) }) === "none",
  "and so is an already-approved customer"
);
ok(
  decide({ parse: parse({ ask_kind: "none", asks_about_financing: true, confidence: 0.99 }) }) === "none",
  "an unclassified kind never offers, however confident the read"
);
// asks_about_financing is the gate even when the KIND looks offerable — the two must agree.
ok(
  decide({ parse: parse({ asks_about_financing: false }) }) === "none",
  "an offerable ask_kind cannot fire on its own — asks_about_financing has to agree"
);

// ---------------------------------------------------------------------------
// PART 2 — fail direction: every unclear path is silence
// ---------------------------------------------------------------------------
ok(decide({ parse: null }) === "none", "no parse (LLM off, no key, error) => today's behaviour");
ok(decide({ parse: undefined }) === "none", "an undefined parse => today's behaviour");
ok(decide({ parse: parse({ confidence: 0.69 }) }) === "none", "below the floor => silence");
ok(decide({ parse: parse({ confidence: 0.7 }) }) === "offer_credit_application", "the floor itself passes");
ok(decide({ parse: parse({ confidence: Number.NaN }) }) === "none", "an unusable confidence => silence");
ok(
  decide({ creditAppAvailable: false }) === "none",
  "NO application URL => silence — we never promise a link we do not have (portability: a new dealer is quiet, not wrong)"
);
ok(decide({ alreadyOffered: true }) === "none", "already offered => never a second time");
// The two store facts short-circuit BEFORE the parse, so they hold even on a perfect read.
ok(
  decide({ alreadyOffered: true, parse: parse({ confidence: 1 }) }) === "none",
  "already-offered outranks even a certain read"
);
ok(F.financeApplicationOfferConfidenceMin() > 0 && F.financeApplicationOfferConfidenceMin() <= 1, "the floor is a probability");

// ---------------------------------------------------------------------------
// PART 3 — the hint is a GATE, and its job is RECALL
//
// This is the assertion the whole slice exists for. Executed 2026-08-20, the hardship hint and the
// process hint between them matched 1 of these 12. If this list ever stops passing, the parser stops
// being asked and the arm goes silently inert — the exact failure mode this replaced.
// ---------------------------------------------------------------------------
const ASKS = [
  "Do you guys do financing?",
  "Do you guys do financing? I know Stan's Harley does and Arkport does.",
  "Can I get financed?",
  "How do I apply for financing?",
  "Is there an application I can fill out?",
  "I'd like to apply for financing",
  "Do you offer in house financing?",
  "What's the process for financing?",
  "How do I get started on financing?",
  "Can you run my credit?",
  "What do I need to do to get approved?",
  "Would I be able to finance this?",
  "Do you finance people with less than perfect credit?",
  // The two REAL messages from the live store.
  "I hoping to see if you had financing for bad credit or credit building",
  "The application is that something I do or can u guys?"
];
for (const t of ASKS) ok(F.financeApplicationHint(t), `the hint must SEE: ${t}`);

// A gate, not comprehension: rate questions pass the hint on purpose and the PARSER declines them.
// (Cheap to hand the parser a question it answers `rate_or_terms` to; expensive to never look.)
ok(F.financeApplicationHint("What is the lowest interest rate you can get me on the flex financing?"), "recall over precision — a rate question reaches the parser");
ok(F.financeApplicationHint("I ran the credit app and was approved for 14,500"), "and so does an already-approved report");
// Plainly unrelated turns cost nothing.
for (const t of ["What time do you close on Saturday?", "Can I bring my trade in tomorrow?", "Sounds good, see you then", ""]) {
  ok(!F.financeApplicationHint(t), `the hint must NOT fire on: ${t || "(empty)"}`);
}
ok(!F.financeApplicationHint(null) && !F.financeApplicationHint(undefined), "unusable input never hints");

// ---------------------------------------------------------------------------
// PART 4 — the copy is the template Joe approved on 2026-06-24, not new words
// ---------------------------------------------------------------------------
const line = INV.buildFinanceAppInviteLine({ creditAppUrl: URL, bookingUrl: BOOK })!;
ok(!!line, "a configured dealer yields an offer line");
ok(line.includes(URL), "the EXACT application URL, never LLM-composed");
ok(INV.buildFinanceAppInviteLine({ creditAppUrl: "", bookingUrl: BOOK }) === null, "no URL => no line, never a fabricated one");
// NEVER A CAPABILITY CLAIM. On 2026-08-19 the review lane, asked to improve a reply to this very
// customer, invented a subprime lender relationship the dealership does not have. Sending a form is
// a fact; "we work with bad-credit lenders" is a claim the assistant cannot know.
// "Want to get PRE-approved?" is an invitation to apply and is fine. What must never appear is a
// claim about our lending book or about this customer's outcome.
ok(
  !/(bad credit|poor credit|subprime|sub-prime|special financ|we work with|our lenders|guarantee|any credit|you'?re approved|you are approved|get you approved|approval odds)/i.test(line),
  "the offer promises NOTHING about credit, lenders, or approval — it is a link to a form"
);
ok(/pre-approved/i.test(line) && /\?/.test(line), "it ASKS whether they want to apply, rather than asserting anything");

// ---------------------------------------------------------------------------
// PART 5 — applied to a reply: appended, stamped, and never twice
// ---------------------------------------------------------------------------
const convWith = (over: Record<string, unknown> = {}) => ({
  id: "+17166036684",
  leadKey: "+17166036684",
  messages: [{ direction: "in", body: "I hoping to see if you had financing for bad credit or credit building" }],
  ...over
});
// `resolveOffer` is injected so the wrapper's OWN gates are reachable. Without it the LLM read is
// the first gate every test hits, CI has no key, and the protected-reply / stamping / once-only
// assertions all pass for the wrong reason — measured: two sabotages survived exactly that way.
const OFFERS = async () => ({ kind: "offer_credit_application" }) as any;
const applied = async (over: Record<string, unknown> = {}, args: Record<string, unknown> = {}) => {
  const conv: any = convWith(over);
  const out = await F.applyFinanceApplicationOfferToReply({
    conv,
    text: "Thanks for reaching out.",
    creditAppUrl: URL,
    bookingUrl: BOOK,
    resolveOffer: OFFERS,
    ...(args as any)
  });
  return { conv, out };
};

// The happy path, driven end to end: appended, and stamped.
{
  const { conv, out } = await applied();
  ok(out.startsWith("Thanks for reaching out. ") && out.includes(URL), "an offered turn appends the line to the reply it was already sending");
  ok(!!conv.financeAppInviteSentAt, "and stamps the shared once-only marker");
}
// ONCE. Feed the same conversation back through and it must refuse — this is what stops a lead
// being handed the same form on every turn.
{
  const conv: any = convWith();
  const first = await F.applyFinanceApplicationOfferToReply({
    conv, text: "A.", creditAppUrl: URL, bookingUrl: BOOK, resolveOffer: OFFERS
  });
  const second = await F.applyFinanceApplicationOfferToReply({
    conv, text: "B.", creditAppUrl: URL, bookingUrl: BOOK, resolveOffer: OFFERS
  });
  ok(first.includes(URL), "the first turn offers");
  ok(second === "B.", "the second turn does NOT — one offer per customer, enforced by the stamp");
}
// A DECLINED read leaves the reply byte-identical and stamps nothing — a stamp without an offer
// would silence the lead forever.
{
  const conv: any = convWith();
  const out = await F.applyFinanceApplicationOfferToReply({
    conv, text: "Thanks for reaching out.", creditAppUrl: URL, bookingUrl: BOOK,
    resolveOffer: async () => ({ kind: "none" }) as any
  });
  ok(out === "Thanks for reaching out.", "a declined read leaves the reply byte-identical");
  ok(!conv.financeAppInviteSentAt, "and stamps nothing");
}
// The REAL resolver with the parser DISABLED must also decline (the production kill switch).
// Pinned with the flag set explicitly, never by assuming CI has no key — `ci:eval` sources .env and
// does have one, so an implicit no-key assumption is an environment-dependent test, i.e. a flake.
{
  const prev = process.env.LLM_FINANCE_APPLICATION_OFFER_PARSER_ENABLED;
  process.env.LLM_FINANCE_APPLICATION_OFFER_PARSER_ENABLED = "0";
  try {
    const conv: any = convWith();
    const out = await F.applyFinanceApplicationOfferToReply({ conv, text: "Z.", creditAppUrl: URL, bookingUrl: BOOK });
    ok(out === "Z.", "the kill switch (…PARSER_ENABLED=0) leaves the reply untouched");
    ok(!conv.financeAppInviteSentAt, "and stamps nothing, so flipping the switch back re-arms the lead");
  } finally {
    if (prev === undefined) delete process.env.LLM_FINANCE_APPLICATION_OFFER_PARSER_ENABLED;
    else process.env.LLM_FINANCE_APPLICATION_OFFER_PARSER_ENABLED = prev;
  }
}
{
  const { out } = await applied({}, { protectedReply: true });
  ok(out === "Thanks for reaching out.", "a compliance/protected reply is never decorated");
}
{
  const { out } = await applied({ messages: [] });
  ok(out === "Thanks for reaching out.", "no inbound turn to answer => nothing appended");
}
{
  const { out } = await applied({}, { creditAppUrl: "" });
  ok(out === "Thanks for reaching out.", "no application URL => nothing appended");
}
{
  const { out } = await applied({ financeAppInviteSentAt: "2026-08-01T00:00:00.000Z" });
  ok(out === "Thanks for reaching out.", "an already-offered lead is never offered again");
}
ok(
  F.latestInboundCustomerText({
    messages: [
      { direction: "in", body: "first" },
      { direction: "out", body: "ours" },
      { direction: "in", body: "  the newest  " }
    ]
  }) === "the newest",
  "the offer answers the customer's MOST RECENT words, not the first"
);
ok(F.latestInboundCustomerText({ messages: [{ direction: "out", body: "ours" }] }) === "", "our own outbound is never the ask");
ok(F.latestInboundCustomerText(null) === "" && F.latestInboundCustomerText({}) === "", "unusable input => no ask");

// ---------------------------------------------------------------------------
// PART 6 — the wiring, in BOTH paths (route-parity law)
// ---------------------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const api = fs.readFileSync(path.join(here, "../services/api/src/index.ts"), "utf8");

ok(
  api.includes('import { applyFinanceApplicationOfferToReply } from "./domain/financeApplicationOffer.js";'),
  "index.ts reaches the offer through the domain module, not a local copy"
);
// publishCustomerReplyDraft is the chokepoint BOTH the main pipeline and /conversations/:id/
// regenerate publish through, so parity is by construction. publishLiveTwilioReply is the EARLY
// funnel for deterministic templates that bypass it — the co-signer nudge Maxie actually received
// is one of those, which is the whole reason both sites are wired.
ok(
  (api.match(/maybeApplyFinanceApplicationOffer\(/g) ?? []).length >= 3,
  "wired at BOTH publish funnels (2 call sites + the wrapper), or one path answers differently"
);
ok(
  api.includes('recordRouteOutcome(scope, "finance_application_offer_appended"'),
  "an appended offer is recorded in the route audit — otherwise nobody can tell whether it ever fires"
);
// The offer must be applied BEFORE the availability disclosure at the early funnel, so a reply that
// gets both keeps the disclosure last (it is the sentence that must not be buried).
const earlyOffer = api.indexOf('maybeApplyFinanceApplicationOffer(conv, publishedText');
const earlyDisclose = api.indexOf("maybeApplyLeadUnitAvailabilityDisclosure(conv, publishedText");
ok(earlyOffer > 0 && earlyDisclose > earlyOffer, "at the early funnel the hold/sold disclosure stays last");

// The extraction that PAID for this slice under the source ratchet: the disclosure's plumbing moved
// to its domain module and index.ts kept a thin injected wrapper. Both publish funnels must still
// reach it, or a hold/sold disclosure silently stops going out.
ok(
  api.includes('import { applyLeadUnitAvailabilityDisclosure } from "./domain/leadUnitAvailabilityDisclosure.js";'),
  "the extracted disclosure is imported from its domain module"
);
ok(
  (api.match(/maybeApplyLeadUnitAvailabilityDisclosure\(/g) ?? []).length >= 3,
  "and is still called at BOTH publish funnels after the move"
);
const shared = fs.readFileSync(
  path.join(here, "../services/api/src/domain/leadUnitAvailabilityDisclosure.ts"),
  "utf8"
);
ok(
  shared.includes("export async function applyLeadUnitAvailabilityDisclosure("),
  "the moved disclosure lives in the domain module"
);
ok(
  shared.includes("args.resolveAvailability(conv)") && shared.includes("args.onDisclosed?.("),
  "and takes its index.ts-local dependencies by injection rather than importing the router"
);

// ONE stamp, shared with the older quote-details trigger, so the two can never double up.
ok(
  api.includes("conv.financeAppInviteSentAt") || api.includes("financeAppInviteSentAt"),
  "the older quote-details trigger still reads the same stamp"
);
const mod = fs.readFileSync(path.join(here, "../services/api/src/domain/financeApplicationOffer.ts"), "utf8");
ok(
  mod.includes("conv.financeAppInviteSentAt = args.nowIso ?? new Date().toISOString()"),
  "the offer writes the SAME stamp the other trigger reads — one offer per customer, not one per trigger"
);
ok(mod.includes('import { z } from "zod";'), "a NEW parser uses Zod (Joe, 2026-08-10)");
ok(
  mod.includes('out[k === "oneOf" ? "anyOf" : k] = walk(v);'),
  "and converts Zod's oneOf to anyOf, or strict mode refuses the schema and the parser silently never runs"
);

console.log(`finance_application_offer_eval: PASS (${n} assertions)`);
