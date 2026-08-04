/**
 * credit_lead_engagement:eval — a credit-app lead gets a REPLY, not just a handoff (Joe, 2026-08-04).
 *
 * FROM THE GOLDEN CORPUS. Scoring 117 held-out real turns surfaced a coherent cluster: on
 * credit-application / prequalification leads the salesperson engages and the agent does not.
 *
 *   HDFS COA lead, ref 11712
 *   salesperson: "hello good morning charles if you want to stop in today feel free ill be here
 *                 until 3pm! lots of street glides in various colors"
 *   agent:       "Got it. I'll have our business manager follow up on your pre-qual and next steps."
 *
 *   HDFS COA lead, ref 11623
 *   salesperson: "I saw you inquired about the 2026 street glide model. If your interested by any
 *                 means come down and test ride one"
 *   agent:       "Got it, Timothy. I received your credit app — our finance manager will call."
 *
 * The agent was not misreading anything: the composer prompt TOLD it to "acknowledge receipt and say
 * a business/finance manager will follow up", full stop. A rule that produces a content-free handoff
 * on every credit lead is the defect.
 *
 * THE SPLIT THIS PINS. Finance SPECIFICS stay with the manager — an approval decision, a rate, a
 * term, a monthly payment, an amount approved. Those are the money path and they are not ours to
 * guess (see rate-quoting policy, and the prequal ruling that a prequal FORM is not a finance deal).
 * The BIKE and the INVITATION are ours: name the model from the lead and ask them in.
 *
 * SCOPE: the SMS ack only. The credit-lead EMAIL stays finance-specific per Joe's 2026-07-25 ruling
 * and is pinned separately by `credit_lead_email:eval` — this eval must never make that email
 * product-flavoured.
 *
 * WHY LLM-BACKED. The change is to composition, so the honest test is what the composer actually
 * writes. Asserting on the prompt's source text would pass while guarding nothing the moment the
 * wording was reworded. Wrapped by retry_llm_eval.sh like every other composed-output eval.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { generateDraftWithLLM } from "../services/api/src/domain/llmDraft.ts";

const LEAD = {
  leadRef: "11712",
  source: "HDFS COA Online",
  firstName: "Charles",
  lastName: "Bailey Jr",
  phone: "+17173197142",
  vehicle: { make: "Harley-Davidson", year: "2025", model: "Street Glide", condition: "new" }
};

const INQUIRY = [
  "WEB LEAD (ADF)",
  "Source: HDFS COA Online",
  "Ref: 11712",
  "Name: Charles Bailey Jr",
  "Phone: 7173197142",
  "Year: 2025",
  "Vehicle: Harley-Davidson Street Glide"
].join("\n");

const draft = String(
  (await generateDraftWithLLM({
    channel: "sms",
    leadKey: "+17173197142",
    lead: LEAD as any,
    // The rule keys on ctx.bucket / ctx.cta, NOT on the lead's source string. Omitting these was
    // the first draft of this eval: it passed while never entering the credit-app branch at all.
    bucket: "finance_prequal",
    cta: "hdfs_coa",
    inquiry: INQUIRY,
    history: []
  } as any)) ?? ""
).trim();

assert.ok(draft, "the composer must produce a credit-lead reply at all");
const lower = draft.toLowerCase();

// ── 1. THE MONEY PATH IS STILL THE MANAGER'S ────────────────────────────────────────────────────
// These are the claims we must never make off a submitted application. This half of the rule is
// the reason the blunt "just hand off" version existed; relaxing it must not cost us this.
const forbidden: Array<[RegExp, string]> = [
  [/\b(you(?:'re| are)|congrat\w*)\b[^.!?]{0,40}\bapproved\b/, "an approval decision"],
  [/\b\d+(?:\.\d+)?\s*%\s*(?:apr|rate|interest)?/, "a rate"],
  [/\$\s?\d[\d,]*(?:\.\d{2})?\s*(?:\/|per\s+)?\s*(?:mo\b|month)/, "a monthly payment"],
  [/\b(?:60|72|84)\s*months?\b/, "a term"],
  [/\bapproved (?:for|up to)\b/, "an approved amount"],
  [/\b(pre[- ]?approved|qualif(?:y|ied) for)\b/, "an approval claim"]
];
for (const [re, what] of forbidden) {
  assert.ok(!re.test(lower), `a credit-app reply must NOT state ${what} — got: ${draft}`);
}

// ── 2. …BUT IT IS NOT A BARE HANDOFF ────────────────────────────────────────────────────────────
// The failure being fixed: acknowledge-and-punt with nothing the customer can act on.
const namesBike = /street glide|the bike|your bike|2025/i.test(draft);
const invites = /\b(come|stop|swing)\s+(?:on\s+)?(?:in|by|down)\b|\bvisit\b|\btest ride\b|\bsee it\b|\bcheck it out\b/i.test(draft);
// REQUIRE THE INVITATION, not merely a mention of the bike. An earlier version of this eval
// accepted `namesBike || invites` and passed against the OLD prompt, because "a business manager
// will follow up shortly about the 2025 Street Glide" names the bike while still giving the
// customer nothing to do. Naming the unit is incidental; the ASK is the thing the salesperson
// supplies and the handoff version never does.
assert.ok(
  invites,
  `a credit-app reply must invite the customer in, not just hand off — got: ${draft}`
);
assert.ok(namesBike, `…and should say which bike it is about — got: ${draft}`);

// ── 3. SCHEDULING STAYS OUT OF IT ───────────────────────────────────────────────────────────────
// A general "come on in" is the point; proposing slots belongs to the scheduling lane and would
// collide with it. Times look like "at 3", "3:00", "3pm", "Tuesday at".
assert.ok(
  !/\b\d{1,2}:\d{2}\b/.test(draft) && !/\bat \d{1,2}\s?(?:am|pm)\b/i.test(draft),
  `a credit-app reply must not propose specific appointment times — got: ${draft}`
);

// ── 4. THE EMAIL LANE IS UNTOUCHED (Joe, 2026-07-25) ────────────────────────────────────────────
// The credit-lead EMAIL is deliberately finance-specific, never product copy. This change is
// SMS-only; if someone later moves the bike/invite language into the shared email builder, the
// ruling is broken and credit_lead_email:eval should be the thing that says so.
const emailHelper = fs.readFileSync("services/api/src/domain/creditLeadEmail.ts", "utf8");
assert.ok(
  !/come (?:on )?in and see|check it out/i.test(emailHelper),
  "the credit-lead EMAIL must stay finance-specific — product copy belongs in the SMS only"
);

console.log(`PASS credit_lead_engagement — no approval/rate/term/payment claim, engages the bike or the invite, no proposed times, email lane untouched.\n  draft: ${draft}`);
