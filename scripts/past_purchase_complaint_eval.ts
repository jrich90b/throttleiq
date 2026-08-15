/**
 * Past-purchase complaint eval (pure, no LLM).
 *
 * Pins the referee that decides what happens when a customer complains about a bike they ALREADY
 * OWN — `decidePastPurchaseComplaintTurn` (services/api/src/domain/pastPurchaseComplaint.ts) — the
 * wording it produces, and the three placements that make it reachable at all.
 *
 * THE DEFECT, 2026-08-15, Tom Leo +12162171070 (Room58 web lead, 04:30Z). He wrote a long account
 * of a used Road King he says he bought "last year": 12-year-old tires, nothing serviced, a brake
 * handle that snapped, $2,000 of his own money. Two failures in sequence:
 *
 *   1. The word "tires" matched the ADF parts lexicon, so a customer-experience complaint was
 *      answered "I've received your parts request" and filed to the parts counter.
 *   2. The in-product Claude review caught the wrong words and rewrote them — into an APOLOGY:
 *      "12-year-old tires and no service before delivery is not okay", plus an offer to "see what
 *      we can do for you", on a bike he himself says he bought AS-IS, from a sale nobody had
 *      verified was ours.
 *
 * Joe: "we need to find out if the customer actually bought the bike from us or they are reaching
 * out to the wrong dealer" — and, on the build: ask "only if it looks suspicious."
 *
 * MEASURED the same morning: we cannot answer it from the store. No prior conversation; his
 * purchase predates the store; the two Road Kings recorded sold since tracking began both went to
 * Buffalo numbers and he is a Cleveland number ~200 miles away. So the reply must ASK, and must
 * concede nothing while it asks.
 *
 * Run: npx tsx scripts/past_purchase_complaint_eval.ts
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";

const {
  decidePastPurchaseComplaintTurn,
  buildPastPurchaseComplaintReply,
  buildPastPurchaseComplaintTodoSummary,
  pastPurchaseComplaintJsonSchema,
  pastPurchaseComplaintConfidenceMin,
  isLongEnoughForPastPurchaseComplaint
} = await import("../services/api/src/domain/pastPurchaseComplaint.ts");

const MIN = pastPurchaseComplaintConfidenceMin();
const parse = (over: any = {}) => ({
  is_past_purchase_complaint: true,
  purchase_attribution: "unclear",
  bought_as_is: false,
  confidence: 0.9,
  ...over
});
const decide = (over: any = {}, purchaseOnRecord = false) =>
  decidePastPurchaseComplaintTurn({ parse: parse(over), confidenceMin: MIN, purchaseOnRecord });

// ── 1) Tom's own turn: unverified, so we ASK and concede nothing ──────────────────────────────
// His wording never says he bought it from US — "they advertised", "I've sent people there",
// "them" — while addressing the reader as "you guys". That is `unclear`, not `this_dealer`.
const tom = decide({ purchase_attribution: "unclear", bought_as_is: true }, false);
assert.equal(tom.arm, "service_recovery_unverified", "an unattributed complaint must not be treated as our sale");
assert.equal(tom.askPurchaseVerification, true, "we ask whose sale it was before anything else");
assert.equal(tom.suppressFaultConcession, true, "no fault is conceded on an unverified sale");
assert.equal(tom.handoffToHuman, true, "a complaint always reaches a person");

// ── 2) "Only if it looks suspicious" — a customer we can SEE we sold to is not interrogated ──
const known = decide({ purchase_attribution: "this_dealer" }, true);
assert.equal(known.arm, "service_recovery_verified", "customer says us AND our books say us => verified");
assert.equal(known.askPurchaseVerification, false, "do not ask a known customer to prove they bought here");
assert.equal(known.handoffToHuman, true, "verified still reaches a person");
assert.equal(known.suppressFaultConcession, true, "even a known customer gets no written admission from the bot");

// ── 3) BOTH opinions are required — either one alone leaves it suspicious ────────────────────
assert.equal(
  decide({ purchase_attribution: "this_dealer" }, false).askPurchaseVerification,
  true,
  "the customer saying 'you sold it to me' is not by itself proof — our books must agree"
);
assert.equal(
  decide({ purchase_attribution: "unclear" }, true).askPurchaseVerification,
  true,
  "a sale on our books does not settle whether THIS complaint is about it"
);
assert.equal(
  decide({ purchase_attribution: "another_dealer" }, true).askPurchaseVerification,
  true,
  "a customer pointing at another dealer is asked, never assumed into our own deal"
);

// ── 3b) …but never ask a question the customer already ANSWERED (Joe, 2026-08-15 review) ─────
// "or they are reaching out to the wrong dealer" was Joe's own framing of this case. When they say
// plainly it was another store's sale and our books hold nothing against that, asking "was that
// with us?" reads as not having read them — the same family of miss this whole arm exists to fix.
const elsewhere = decide({ purchase_attribution: "another_dealer" }, false);
assert.equal(elsewhere.arm, "service_recovery_other_dealer", "they told us whose sale it was; believe them");
assert.equal(
  elsewhere.askPurchaseVerification,
  false,
  "a customer who opened with 'I bought it downstate' must not be asked whether they bought it here"
);
assert.equal(elsewhere.handoffToHuman, true, "a misdirected complaint still reaches a person");
assert.equal(
  elsewhere.suppressFaultConcession,
  true,
  "conceding nothing matters MORE on another store's deal, not less"
);

// ── 4) Fail direction: DETECTION fails toward today's behaviour ──────────────────────────────
assert.equal(
  decidePastPurchaseComplaintTurn({ parse: null, confidenceMin: MIN, purchaseOnRecord: false }).arm,
  "none",
  "no parse (disabled LLM, no key, an error) must leave existing routing alone"
);
assert.equal(
  decide({ is_past_purchase_complaint: false }).arm,
  "none",
  "an ordinary sales lead is never pulled into the complaint arm"
);
assert.equal(
  decide({ confidence: MIN - 0.01 }).arm,
  "none",
  "an unsure read must not start asking people to prove they bought a bike"
);
assert.equal(decide({ confidence: MIN }).arm, "service_recovery_unverified", "the floor itself passes");

// ── 5) The wording — this arm exists because a GENERATED reply apologised ────────────────────
const askReply = buildPastPurchaseComplaintReply({
  arm: "service_recovery_unverified",
  firstName: "Tom",
  agentName: "Alexandra",
  dealerCity: "North Tonawanda"
});
const knownReply = buildPastPurchaseComplaintReply({
  arm: "service_recovery_verified",
  firstName: "Tom",
  agentName: "Alexandra",
  dealerCity: "North Tonawanda"
});
// The exact concession the minute lane wrote, and the shapes next to it. None may come back.
const FAULT_PHRASES = [
  /is not okay/i,
  /should (?:not|never) have/i,
  /we were wrong/i,
  /our (?:mistake|fault|error)/i,
  /that('| i)?s on us/i,
  /make (?:this|it) right/i,
  /see what we can do/i,
  /refund|reimburse|compensat/i
];
const otherDealerReply = buildPastPurchaseComplaintReply({
  arm: "service_recovery_other_dealer",
  firstName: "Tom",
  agentName: "Alexandra",
  dealerCity: "North Tonawanda"
});
for (const reply of [askReply, knownReply, otherDealerReply]) {
  for (const phrase of FAULT_PHRASES) {
    assert.ok(!phrase.test(reply), `a complaint reply must concede no fault and promise no remedy (${phrase})`);
  }
  assert.ok(!/\$\s?\d/.test(reply), "no figure may appear in a reply the bot writes about a disputed deal");
  assert.ok(/sorry/i.test(reply), "acknowledging the experience is still required — this is not coldness");
}
assert.ok(
  /when you bought it/i.test(askReply) && /stock number/i.test(askReply),
  "the unverified reply must ask the ONE question that resolves whose sale it is"
);
assert.ok(
  /North Tonawanda/.test(askReply),
  "the ask names where we are, so a customer at the wrong dealer can say so"
);
assert.ok(
  !/when you bought it/i.test(knownReply) && !/stock number/i.test(knownReply),
  "a verified customer is NOT asked to prove the purchase"
);
// The other-dealer reply answers the case Joe named on review: they already said whose sale it was.
assert.ok(
  !/when you bought it/i.test(otherDealerReply) &&
    !/stock number/i.test(otherDealerReply) &&
    !/was that (?:purchase )?with us/i.test(otherDealerReply),
  "a customer who already told us it was another store's sale is not asked to settle it again"
);
assert.ok(
  !/North Tonawanda/.test(otherDealerReply),
  "naming our city here would re-open the question they already closed"
);
assert.ok(
  /service/i.test(otherDealerReply),
  "a misdirected complaint gets the one honest offer we can make, not a dead end"
);
assert.ok(
  /can't speak to|cannot speak to/i.test(otherDealerReply),
  "we must not characterise how another store prepped a bike we never touched"
);

// One advancing question per reply (voice charter C1.7) — and exactly one.
for (const [label, reply] of [
  ["ask", askReply],
  ["known", knownReply],
  ["other_dealer", otherDealerReply]
] as const) {
  assert.equal((reply.match(/\?/g) ?? []).length, 1, `${label} reply must end with exactly one question`);
}
// ── 5b) The MANAGER's half must not hand them the wrong starting assumption ─────────────────
// The summary used to branch on `askPurchaseVerification`, which the other-dealer arm also leaves
// false — so a wrong-dealer complaint would have reached a manager described as "a bike they
// bought from us". That is worse than saying nothing: it is a false fact in the work queue.
const otherSummary = buildPastPurchaseComplaintTodoSummary({
  decision: elsewhere,
  customerText: "I bought a bike at a dealer downstate and nothing was serviced."
});
assert.ok(
  /ANOTHER dealer/i.test(otherSummary),
  "the manager must be told up front that the customer attributes the sale elsewhere"
);
assert.ok(
  !/bought from us|they bought from us/i.test(otherSummary),
  "a wrong-dealer complaint must never be summarised as our own sale"
);
for (const [label, decision] of [
  ["unverified", tom],
  ["verified", known],
  ["other_dealer", elsewhere]
] as const) {
  const summary = buildPastPurchaseComplaintTodoSummary({ decision, customerText: "…" });
  assert.ok(
    /No fault has been conceded/i.test(summary),
    `${label}: the queue must record that the bot admitted nothing`
  );
}

// Portability: the source ratchet counts dealer literals in services/api/src, so the city and the
// agent name must arrive as arguments, never be baked into the builder.
const domainSrc = fs.readFileSync("services/api/src/domain/pastPurchaseComplaint.ts", "utf8");
assert.ok(
  !/North Tonawanda|American Harley/i.test(domainSrc),
  "dealer literals must not be hard-coded in the reply builder"
);
assert.ok(
  buildPastPurchaseComplaintReply({ arm: "service_recovery_unverified", agentName: "our team" }).includes(
    "was that purchase with us"
  ),
  "with no city configured the ask still resolves whose sale it is"
);

// ── 6) The length gate is content-blind — never a keyword gate ───────────────────────────────
// A keyword gate is the exact failure this arm replaces: a lexicon decided what Tom's message was
// about. His own text carries no obvious grief word ("surprised", "wouldn't expect", no swearing),
// so anything keyed on outrage vocabulary would miss him.
assert.equal(isLongEnoughForPastPurchaseComplaint("thanks!"), false, "short acks never buy a parse");
assert.equal(
  isLongEnoughForPastPurchaseComplaint(
    "I bought a road king from you last year and the tires turned out to be twelve years old"
  ),
  true,
  "a substantial account buys a parse"
);
// The gate itself must be a WORD COUNT and nothing else. Assert on the gate's own body: the only
// pattern it may apply to the customer's text is a whitespace split.
const gateBody =
  domainSrc.split("export function isLongEnoughForPastPurchaseComplaint")[1]?.split("\n}")[0] ?? "";
assert.ok(gateBody.includes("split(/\\s+/)"), "the gate must count words");
const gatePatterns = gateBody.match(/\/[^/\n]+\/[gimsuy]*/g) ?? [];
assert.deepEqual(
  gatePatterns,
  ["/\\s+/"],
  `the gate may apply exactly one pattern — a whitespace split — never a vocabulary test (found ${gatePatterns.join(", ")})`
);

// ── 7) The strict-schema trap: Zod must not emit `oneOf` (OpenAI rejects it outright) ────────
const schemaJson = JSON.stringify(pastPurchaseComplaintJsonSchema());
assert.ok(!schemaJson.includes('"oneOf"'), "strict structured outputs reject oneOf — must be anyOf");
assert.ok(!schemaJson.includes('"$schema"'), "$schema must be stripped for strict mode");
assert.ok(schemaJson.includes("purchase_attribution"), "the schema must carry the attribution field");

// ── 8) Reachability — the placements, which no unit test of the referee can see ──────────────
// 8a. ALL THREE paths go through the one resolver: ADF intake, live inbound, regenerate.
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const adf = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");
assert.equal(
  index.split("resolvePastPurchaseComplaintDraft(").length - 1,
  2,
  "live inbound and regenerate must each call the shared resolver exactly once"
);
assert.equal(
  adf.split("resolvePastPurchaseComplaintTurn(").length - 1,
  1,
  "ADF intake must call the shared resolver exactly once"
);
// Neither SMS lane may compose the reply itself — both go through the one applier, or the two
// paths drift and regenerate becomes the hole an apology comes back through.
assert.ok(
  !index.includes("applyPastPurchaseComplaintHandoff("),
  "the reply must be composed inside the shared resolver, not assembled at either call site"
);
assert.ok(
  !index.includes("buildPastPurchaseComplaintReply("),
  "index.ts must not compose the complaint wording inline"
);

// 8b. THE PRECEDENCE THAT MADE THE ORIGINAL BUG INERT-PROOF. The complaint branch must come
// BEFORE the parts/apparel/service override in the ADF bucket chain — Tom's complaint contained
// "tires", and a lexical gate that decides first makes any later parser fix unreachable
// (memory: parser-fix-inert-until-the-lexical-gate-lets-it-through). Positions, not names.
const complaintBranch = adf.indexOf("if (isPastPurchaseComplaintLead) {");
const partsOverride = adf.indexOf('inferredCta = "parts_request";');
assert.ok(complaintBranch > 0, "the ADF bucket chain must carry a complaint branch");
assert.ok(partsOverride > 0, "the parts override must still exist (this eval is meaningless without it)");
assert.ok(
  complaintBranch < partsOverride,
  "the complaint branch must be decided BEFORE the parts lexicon override, or it can never fire"
);
// And the handling block must precede the department handlers for the same reason.
const complaintBlock = adf.lastIndexOf("if (isPastPurchaseComplaintLead) {");
const serviceBlock = adf.indexOf("if (isServiceLead) {");
const partsBlock = adf.indexOf("if (isPartsLead || isApparelLead) {");
assert.ok(
  complaintBlock < serviceBlock && complaintBlock < partsBlock,
  "the complaint handler must run before the department handlers"
);

// 8c. A complaint never lands in a department queue — it goes to a MANAGER, in every path.
// The SMS lanes inherit this from the shared applier; ADF files its own task in its own block.
assert.ok(
  /addTodo\(\s*\n?\s*conv,\s*\n?\s*"manager"/.test(domainSrc),
  "the shared applier must file the complaint task to a manager, never to parts/service"
);
assert.ok(
  domainSrc.includes('PAST_PURCHASE_COMPLAINT_HANDOFF_REASON = "past_purchase_complaint"'),
  "the handoff reason must name the complaint, so it is findable in the queue"
);
const adfBlock = adf.slice(adf.lastIndexOf("if (isPastPurchaseComplaintLead) {"), adf.lastIndexOf("if (isPastPurchaseComplaintLead) {") + 2600);
assert.ok(
  /addTodo\(\s*\n?\s*conv,\s*\n?\s*"manager"/.test(adfBlock),
  "adf: the complaint task must be filed to a manager, never to parts/service"
);
assert.ok(
  /"past_purchase_complaint"/.test(adfBlock),
  "adf: the handoff reason must name the complaint"
);

console.log("PASS past_purchase_complaint_eval — ask before apologising, and only when it looks suspicious");
