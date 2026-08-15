/**
 * Past-purchase complaint PARSER eval (LLM-backed).
 *
 * The replay fixture for the new state (AGENTS.md required order, step 6). The decision table is
 * pinned separately and without an LLM in `past_purchase_complaint_eval.ts`; this file asserts the
 * only thing that file cannot — that the parser actually READS these turns the way the referee
 * assumes.
 *
 * THE ONE THAT MATTERS is Tom Leo's own text, verbatim from the store (+12162171070, 2026-08-15
 * 04:30Z, Room58 web lead). Two separate reads have to be right at once:
 *   - it IS a complaint about a bike he already owns (the routing half — the live system called it
 *     a parts request because it contains the word "tires"), and
 *   - whose sale it is, is NOT settled by his text (the liability half — he says "they advertised",
 *     "I've sent people there", "a good experience with them", while addressing "you guys").
 * Getting the second one wrong in the confident direction is what produced a written apology on an
 * unverified deal, so `unclear` is the assertion, not a nicety.
 *
 * Sampled 3x with a 2/3 majority so one unlucky sample cannot red-line main for everyone (the trap
 * that burned `incoming_unit_arrival:eval`).
 *
 * Requires OPENAI_API_KEY + LLM_ENABLED=1 (the ci:eval chain supplies both).
 * Run: LLM_ENABLED=1 npx tsx scripts/past_purchase_complaint_parser_eval.ts
 */
import { strict as assert } from "node:assert";

const { parsePastPurchaseComplaintWithLLM, decidePastPurchaseComplaintTurn, pastPurchaseComplaintConfidenceMin } =
  await import("../services/api/src/domain/pastPurchaseComplaint.ts");

if (process.env.LLM_ENABLED !== "1" || !process.env.OPENAI_API_KEY) {
  console.log("SKIP past_purchase_complaint_parser_eval — needs LLM_ENABLED=1 + OPENAI_API_KEY");
  process.exit(0);
}

const SAMPLES = 3;
const MAJORITY = 2;

// Verbatim store text, apostrophes stripped exactly as the ADF delivered it.
const TOM =
  "I ve done business in the past I was trading a bike in I wanted a road king and there was one they advertised for 9999 is probably worth four grand. I had to put $2000 into it once I took it home. The tires were 12 years old. There was nothing serviced on it. I thought you guys kind of prided yourself on at least changing the oils and checking things. The brake handle snapped right off. I bought it as it so it s my fault and thank God I like the bike, but it just surprised me that they would do something like this. I wouldn t expect to get a $10,000 bike and have all that wrong with it. I ve sent people there in the past because I had a good experience with them last year, but maybe Sales are down or something. Thanks for your time Thomas Leo 216-217-1070.";

type Case = {
  label: string;
  text: string;
  expectComplaint: boolean;
  /** Attributions that are ACCEPTABLE — more than one where the text genuinely permits it. */
  allowAttribution?: string[];
};

const CASES: Case[] = [
  {
    // THE REPORTED MISS.
    label: "Tom Leo — complaint about a used Road King, seller never named",
    text: TOM,
    expectComplaint: true,
    // "this_dealer" is the read that caused the harm: it is what licenses an apology. It must not
    // win. "another_dealer" is defensible from his pronouns, "unclear" is the honest read; both
    // route to the same place — ask.
    allowAttribution: ["unclear", "another_dealer"]
  },
  {
    label: "shopper haggling — unhappy, but nothing is theirs yet",
    text:
      "Your price on that Road Glide is way over book and nobody has called me back after three days. Honestly the worst service I have had from a dealership.",
    expectComplaint: false
  },
  {
    label: "pre-purchase condition question — about a bike still on the floor",
    text:
      "The tires on that Low Rider I looked at yesterday seemed pretty old to me. Would you be putting new ones on it before I picked it up, or is it sold as is?",
    expectComplaint: false
  },
  {
    label: "our own customer, names us plainly",
    text:
      "I picked up my Street Glide from you guys last month and the front tire was already worn down to the wear bars. Pretty disappointed after what I paid for it.",
    expectComplaint: true,
    allowAttribution: ["this_dealer"]
  },
  {
    label: "another dealer's deal, brought to us",
    text:
      "I bought a bike at a dealer downstate back in March and they still have not sent me the title. I am getting nowhere with them. Can you help me get Harley corporate involved in this?",
    expectComplaint: true,
    allowAttribution: ["another_dealer"]
  }
];

let failures = 0;
for (const c of CASES) {
  const reads = [] as Array<{ complaint: boolean; attribution: string; confidence: number }>;
  for (let i = 0; i < SAMPLES; i++) {
    const parse = await parsePastPurchaseComplaintWithLLM({ text: c.text });
    reads.push({
      complaint: !!parse?.is_past_purchase_complaint,
      attribution: String(parse?.purchase_attribution ?? "none"),
      confidence: Number(parse?.confidence ?? 0)
    });
  }
  const complaintVotes = reads.filter(r => r.complaint === c.expectComplaint).length;
  const ok = complaintVotes >= MAJORITY;
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${c.label} — complaint ${complaintVotes}/${SAMPLES} as expected ` +
      `(${reads.map(r => `${r.complaint ? "yes" : "no"}/${r.attribution}@${r.confidence.toFixed(2)}`).join(", ")})`
  );
  assert.ok(ok, `${c.label}: expected is_past_purchase_complaint=${c.expectComplaint} by majority`);

  if (c.allowAttribution) {
    const attributionVotes = reads.filter(r => c.allowAttribution!.includes(r.attribution)).length;
    assert.ok(
      attributionVotes >= MAJORITY,
      `${c.label}: attribution must be one of ${c.allowAttribution.join("/")} by majority, got ` +
        reads.map(r => r.attribution).join(", ")
    );
  }
}

// End to end on the reported miss: whatever the parser's exact attribution, the arm Tom gets must
// be the one that ASKS. This is the assertion that would have stopped the apology.
const tomReads = [] as string[];
for (let i = 0; i < SAMPLES; i++) {
  const parse = await parsePastPurchaseComplaintWithLLM({ text: TOM });
  const decision = decidePastPurchaseComplaintTurn({
    parse,
    confidenceMin: pastPurchaseComplaintConfidenceMin(),
    purchaseOnRecord: false // measured: no sale for him on our books, and none could be — see the memory
  });
  tomReads.push(decision.arm);
}
const asks = tomReads.filter(a => a === "service_recovery_unverified").length;
console.log(`ok   Tom end-to-end — ${asks}/${SAMPLES} resolve to ask-first (${tomReads.join(", ")})`);
assert.ok(asks >= MAJORITY, `Tom's turn must resolve to the ask-first arm by majority, got ${tomReads.join(", ")}`);

assert.equal(failures, 0, `${failures} case(s) failed`);
console.log("PASS past_purchase_complaint_parser_eval — the complaint is read, the seller is not assumed");
