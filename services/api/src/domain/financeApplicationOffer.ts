/**
 * Offer the credit application when the customer ASKS whether they can finance.
 *
 * ── WHY THIS EXISTS (Joe, 2026-08-20) ─────────────────────────────────────────────────────────
 * Maxie Johnson `+17166036684`, 2026-08-19 16:45Z, four minutes into his first thread:
 * *"I hoping to see if you had financing for bad credit or credit building"*. He got an
 * empathetic co-signer nudge — correct copy, Joe's own 2026-07-16 ruling — which ends by asking
 * HIM a question. He never answered. A voicemail went unreturned. Nothing in the thread offered
 * him the one thing that would have told him where he stood: the credit application.
 *
 * Joe, reviewing it: *"If someone is asking a question similar to Maxie's, we should probably
 * send them an application link at some point as well."*
 *
 * ── WHAT WAS ACTUALLY BROKEN (measured 2026-08-20, whole live store) ──────────────────────────
 * Not the copy, and not the link. `buildFinanceAppInviteLine` already exists, is already wired
 * into both paths, is already eval-pinned, and Joe already approved its wording on 2026-06-24.
 * Its ONE trigger is the "manual quote details received" moment — a lead who has already engaged
 * with numbers. Measured across every conversation on the store: `financeAppInviteSentAt` is set
 * on **0 leads**. The offer has never gone out, to anyone, once.
 *
 * And the customer who ASKS can never reach it. There are two cheap pre-filters in front of the
 * finance parsers, and neither was written for this class:
 *   - the HARDSHIP hint reads credit distress ("bad credit", "bankruptcy", "identity theft")
 *   - the PROCESS hint reads paperwork timing ("insurance", "down payment", "the title")
 * Executed against twelve ordinary ways of asking, **11 of 12 reach no finance parser at all**:
 * "Do you guys do financing?", "How do I apply?", "Can I get financed?", "Is there an application
 * I can fill out?", "Would I be able to finance this?" — all invisible. `+17167439566` asked
 * *"Do you guys do financing? I know Stan's Harley does and Arkport does"*, naming two
 * competitors, and nothing in the finance lane looked at the message.
 *
 * So the gap is not that hints are the wrong pattern — AGENTS.md blesses a fail-safe hint as a
 * gate, never as comprehension. The gap is that **this class never had one**. This module adds it,
 * and hands the actual decision to a typed parser, which is the same shape every sibling lane uses.
 *
 * ── FAIL DIRECTION ────────────────────────────────────────────────────────────────────────────
 * Toward NOT offering, at every step, because this is the money path:
 *   - no hint, no LLM, no key, a parser error, or a confidence below the floor ⇒ `none` ⇒ the
 *     turn behaves exactly as it does today. This arm can only ever ADD a line.
 *   - a customer talking about RATES, or one who has already applied, is `none`. They are not
 *     asking whether they can finance; sending them an application reads as not listening.
 *   - no `creditAppUrl` on the dealer profile ⇒ `none`. We never promise a link we do not have,
 *     and a new dealer with an unconfigured profile is silent rather than wrong.
 *   - already offered ⇒ `none`, forever. One offer per lead, enforced by the SAME
 *     `financeAppInviteSentAt` stamp the existing trigger writes, so the two triggers can never
 *     double up on the same customer.
 *
 * ── WHAT THIS MUST NEVER DO ───────────────────────────────────────────────────────────────────
 * Send the application; never CLAIM a program. On 2026-08-19 the review lane, asked to improve a
 * reply to this very customer, invented a subprime lender relationship the dealership does not
 * have. An application link is a fact about a form. "We work with bad-credit lenders" is a claim
 * about our lending book, and the assistant has no way to know it. The copy here is the template
 * Joe approved — the link, and an offer to run it with them in person. Nothing else.
 */
import { z } from "zod";
import { buildFinanceAppInviteLine } from "./financeAppInvite.js";

export const FinanceApplicationInterestSchema = z.object({
  asks_about_financing: z
    .boolean()
    .describe(
      "True when the customer is asking whether they CAN finance a bike through us, or how to " +
        "start — 'do you do financing?', 'can I get financed?', 'how do I apply?', 'is there an " +
        "application?', 'what do I need to get approved?', or asking whether their credit " +
        "situation is something we can work with. The test is simple: would handing them our " +
        "credit application be a direct, useful answer to what they just asked? " +
        "False when they are asking what a RATE or a PAYMENT is, negotiating terms, comparing us " +
        "to another lender, or telling us about financing they already have or already got " +
        "approved for. False for every non-finance turn."
    ),
  ask_kind: z
    .enum(["can_i_finance", "how_do_i_apply", "credit_barrier", "rate_or_terms", "already_handled", "none"])
    .describe(
      'What kind of finance turn this is. "can_i_finance": do you offer it / would I be able to. ' +
        '"how_do_i_apply": how do I start, is there an application, can you run my credit. ' +
        '"credit_barrier": they raise their own credit as the obstacle and want to know if we can ' +
        'still help. "rate_or_terms": a NUMBER question — what rate, what payment, how many ' +
        'months, comparing to their credit union. "already_handled": they are already approved, ' +
        'already applied, or financing elsewhere. "none": not a finance turn.'
    ),
  confidence: z.number().min(0).max(1)
});

export type FinanceApplicationInterestParse = z.infer<typeof FinanceApplicationInterestSchema>;

/**
 * Strip the JSON-schema keywords OpenAI strict mode rejects (Zod emits `oneOf` for enums/unions,
 * which the API refuses outright and `requestStructuredJson` turns into null — a parser that looks
 * merely unsure while never having run). Mirrors `pastPurchaseComplaint.toStrictSchema`.
 */
function toStrictSchema(schema: unknown): { [key: string]: unknown } {
  const walk = (node: any): any => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: any = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$schema") continue;
      out[k === "oneOf" ? "anyOf" : k] = walk(v);
    }
    return out;
  };
  return walk(schema) as { [key: string]: unknown };
}

export function financeApplicationInterestJsonSchema(): { [key: string]: unknown } {
  return toStrictSchema(z.toJSONSchema(FinanceApplicationInterestSchema, { target: "draft-7" }));
}

/**
 * The floor this read must clear before an offer is appended. Deliberately at the same 0.7 as its
 * finance siblings: below it the cost is a link nobody asked for on the money path, which is the
 * error Joe is most careful about.
 */
export function financeApplicationOfferConfidenceMin(): number {
  const raw = Number(process.env.LLM_FINANCE_APPLICATION_OFFER_CONFIDENCE_MIN);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.7;
}

/**
 * The ask kinds our credit application actually answers.
 *
 * `rate_or_terms` and `already_handled` are deliberately OUT. Measured on the live store, they are
 * the bulk of what mentions financing at all — 43 customer messages mention financing/applying/
 * approval and most are people already approved or shopping rates against their credit union.
 * Handing an application to someone who just told us their credit union quoted 6.29% is not an
 * answer, it is a form letter.
 */
const OFFERABLE_ASK_KINDS: ReadonlySet<FinanceApplicationInterestParse["ask_kind"]> = new Set([
  "can_i_finance",
  "how_do_i_apply",
  "credit_barrier"
]);

export type FinanceApplicationOfferKind = "offer_credit_application" | "none";

export type FinanceApplicationOfferInput = {
  parse: FinanceApplicationInterestParse | null | undefined;
  confidenceMin: number;
  /**
   * Has this lead already been offered the application, by EITHER trigger? Read off
   * `conv.financeAppInviteSentAt` by the caller so the referee stays pure — and so the
   * quote-details trigger and this one share one stamp instead of racing on two.
   */
  alreadyOffered: boolean;
  /** Does the dealer profile carry a real credit-application URL? Never fabricate one. */
  creditAppAvailable: boolean;
};

export type FinanceApplicationOfferDecision = { kind: FinanceApplicationOfferKind };

const NO_OFFER: FinanceApplicationOfferDecision = { kind: "none" };

/**
 * Pure referee — the ONE place this is decided, so `/webhooks/twilio` and
 * `/conversations/:id/regenerate` cannot drift (route-parity law). No LLM, no store, no clock.
 * Pinned by `finance_application_offer:eval`.
 */
export function decideFinanceApplicationOfferTurn(
  input: FinanceApplicationOfferInput
): FinanceApplicationOfferDecision {
  if (!input.creditAppAvailable) return NO_OFFER;
  if (input.alreadyOffered) return NO_OFFER;
  const parse = input.parse;
  if (!parse || !parse.asks_about_financing) return NO_OFFER;
  if (!(Number(parse.confidence ?? 0) >= input.confidenceMin)) return NO_OFFER;
  if (!OFFERABLE_ASK_KINDS.has(parse.ask_kind)) return NO_OFFER;
  return { kind: "offer_credit_application" };
}

/**
 * Cheap pre-filter so the parser only runs on plausible "can I finance this" phrasings.
 *
 * A GATE, NOT COMPREHENSION — a miss falls through to today's behaviour and the parser, never this
 * regex, decides. It exists because the two finance hints already in the tree were written for
 * OTHER classes (credit distress; paperwork timing) and between them let 11 of 12 ordinary ways of
 * asking through to nothing at all.
 *
 * Written for RECALL, not precision: it is cheap to hand the parser a rate question it will answer
 * `rate_or_terms` to, and expensive to never look at "do you guys do financing". Recall is measured
 * against the live store in `finance_application_offer:eval`, not asserted here.
 */
const FINANCE_APPLICATION_HINT_RE =
  /\b(financ\w+|apply|application|appl(y|ied|ying)|pre[-\s]?approv\w*|approv\w*|qualify|qualified|credit\s*(app|application|check|score)?|lend\w+|loan)\b/i;

export function financeApplicationHint(text: string | null | undefined): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  return FINANCE_APPLICATION_HINT_RE.test(t);
}

/**
 * Reads whether this turn is a customer asking if/how they can finance.
 *
 * Returns null on every failure mode — disabled, no key, a refused schema, a thrown request — and
 * `decideFinanceApplicationOfferTurn` maps null to `none`, i.e. today's behaviour.
 */
export async function parseFinanceApplicationInterestWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
}): Promise<FinanceApplicationInterestParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_FINANCE_APPLICATION_OFFER_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const { requestStructuredJson } = await import("./llmDraft.js");
  const primaryModel =
    process.env.OPENAI_FINANCE_APPLICATION_OFFER_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_FINANCE_APPLICATION_OFFER_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const history = (args.history ?? []).slice(-6).map(h => `${h.direction}: ${h.body}`);
  const prompt = [
    "You read SMS in a Harley dealership sales thread and answer ONE question: is this customer",
    "asking whether they can FINANCE a bike through us, or how to get started? Return only JSON",
    "matching the schema.",
    "",
    "The test that settles it: would handing this person our credit application be a direct,",
    "useful answer to what they just asked? If yes, asks_about_financing is true.",
    "",
    "Sort ask_kind:",
    '- "can_i_finance": do you offer financing, would I be able to finance this, do you finance',
    "  someone like me. Often phrased against a competitor ('I know Stan's does').",
    '- "how_do_i_apply": how do I start, is there an application, can you run my credit, what do I',
    "  need to get approved.",
    '- "credit_barrier": they raise their OWN credit as the obstacle and want to know whether we',
    "  can still work with them — bad or no credit, a past denial, a score wiped by identity theft.",
    '- "rate_or_terms": a NUMBER question. What rate can you get me, what would the payment be, 60',
    "  or 72 months, my credit union quoted 6.29%. They already know we finance; they are shopping.",
    '- "already_handled": they are approved already, have applied already, or are financing',
    "  elsewhere. Nothing to offer.",
    '- "none": not a finance turn at all.',
    "",
    "Hard rules:",
    "- A rate or payment question is NEVER asks_about_financing, however finance-flavoured. Sending",
    "  an application to someone comparing rates is not an answer.",
    "- Someone reporting an approval ('I got approved for 14,500') is already_handled, not a question.",
    "- An incidental mention of the word finance or application ('a job application', 'considering",
    '  finances") is "none".',
    "- Judge THIS message. The history is context for pronouns and follow-ons, not the subject.",
    "",
    "Examples:",
    'input: "Do you guys do financing? I know Stan\'s Harley does and Arkport does." output: {"asks_about_financing":true,"ask_kind":"can_i_finance","confidence":0.95}',
    'input: "I hoping to see if you had financing for bad credit or credit building" output: {"asks_about_financing":true,"ask_kind":"credit_barrier","confidence":0.94}',
    'input: "The application is that something I do or can u guys?" output: {"asks_about_financing":true,"ask_kind":"how_do_i_apply","confidence":0.92}',
    'input: "due to a past identity theft I no longer have a credit score and paying a ridiculous high interest for that just doesn\'t seem plausible for me" output: {"asks_about_financing":true,"ask_kind":"credit_barrier","confidence":0.85}',
    'input: "What is the lowest interest rate you can get me on the flex financing on the 36 and the 48 month?" output: {"asks_about_financing":false,"ask_kind":"rate_or_terms","confidence":0.94}',
    'input: "My credit Union is 6.29 for 48 months and 6.54 for 60 months, big difference from Harley finance." output: {"asks_about_financing":false,"ask_kind":"rate_or_terms","confidence":0.93}',
    'input: "I ran the credit app and was approved for 14,500" output: {"asks_about_financing":false,"ask_kind":"already_handled","confidence":0.95}',
    'input: "Already HD financing approved. May come tomorrow to look at." output: {"asks_about_financing":false,"ask_kind":"already_handled","confidence":0.94}',
    'input: "I was just wondering because I am completing a cover letter and inquiry for a job application." output: {"asks_about_financing":false,"ask_kind":"none","confidence":0.95}',
    'input: "Thanks, considering physical stamina and finances." output: {"asks_about_financing":false,"ask_kind":"none","confidence":0.9}',
    'input: "What time do you close on Saturday?" output: {"asks_about_financing":false,"ask_kind":"none","confidence":0.96}',
    "",
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "finance_application_offer_parser",
      schema: financeApplicationInterestJsonSchema(),
      maxOutputTokens: 90,
      debugTag: "llm-finance-application-offer-parser",
      debug: process.env.LLM_FINANCE_APPLICATION_OFFER_PARSER_DEBUG === "1"
    });

  const raw =
    (await runParse(primaryModel)) ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!raw) return null;
  const result = FinanceApplicationInterestSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * The ONE call both paths make: hint, parse, referee. Any failure resolves to `none` — today's
 * behaviour — and can never block a turn.
 *
 * The two cheap store facts are checked FIRST and short-circuit before any LLM work, so a dealer
 * with no application URL and a lead we have already offered cost nothing at all.
 */
export async function resolveFinanceApplicationOfferTurn(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  alreadyOffered: boolean;
  creditAppAvailable: boolean;
}): Promise<FinanceApplicationOfferDecision> {
  if (!args.creditAppAvailable || args.alreadyOffered) return NO_OFFER;
  if (!financeApplicationHint(args.text)) return NO_OFFER;
  let parse: FinanceApplicationInterestParse | null = null;
  try {
    parse = await parseFinanceApplicationInterestWithLLM({ text: args.text, history: args.history });
  } catch {
    parse = null; // a failed read leaves the reply exactly as it was
  }
  return decideFinanceApplicationOfferTurn({
    parse,
    confidenceMin: financeApplicationOfferConfidenceMin(),
    alreadyOffered: args.alreadyOffered,
    creditAppAvailable: args.creditAppAvailable
  });
}

/** The customer's most recent inbound words — the turn this offer is answering. */
export function latestInboundCustomerText(conv: any): string {
  const rows = Array.isArray(conv?.messages) ? conv.messages : [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const m = rows[i];
    if (m?.direction !== "in") continue;
    const body = String(m?.body ?? "").trim();
    if (body) return body;
  }
  return "";
}

/**
 * Append the credit-application offer to a reply that is about to publish, ONCE.
 *
 * Lives here rather than in `index.ts` for the reason the source ratchet exists: the first draft of
 * this slice put the whole helper inline and index.ts went 53 lines over its ceiling. `index.ts`
 * carries the call; the reasoning and the stamp live in the domain.
 *
 * Shaped like the lead-unit availability disclosure it sits beside at the publish chokepoints: a
 * one-time line appended to whatever reply this turn was already sending, never a replacement.
 * Joe's rule (2026-08-20) is "when they ask", not "later" — Maxie Johnson asked, was answered with a
 * question back, and went quiet.
 *
 * ONE stamp (`financeAppInviteSentAt`) is shared with the older quote-details trigger, so the two
 * can never both offer the same customer.
 *
 * FAIL DIRECTION at every step: a protected (compliance) reply, no application URL, an
 * already-offered lead, no inbound turn to answer, no hint, a failed or unsure parse, or a
 * rate/already-approved read all return `text` byte-for-byte unchanged.
 */
export async function applyFinanceApplicationOfferToReply(args: {
  conv: any;
  text: string;
  /** Compliance replies (opt-out confirmations) are never decorated. */
  protectedReply?: boolean;
  history?: { direction: "in" | "out"; body: string }[];
  creditAppUrl?: string | null;
  bookingUrl?: string | null;
  /** Called only when a line is actually appended — the caller records the route outcome. */
  onOffered?: () => void;
  nowIso?: string;
  /**
   * Seam for the eval ONLY. Production never passes it. Without it the LLM read is the first gate
   * every test hits, so a CI run with no key returns `none` before reaching the protected-reply,
   * stamping or once-only guards — and those guards then "pass" their tests for the wrong reason.
   * Measured: two sabotages (offering on a compliance reply; never stamping) survived a suite that
   * looked like it covered them.
   */
  resolveOffer?: (a: {
    text: string;
    history?: { direction: "in" | "out"; body: string }[];
    alreadyOffered: boolean;
    creditAppAvailable: boolean;
  }) => Promise<FinanceApplicationOfferDecision>;
}): Promise<string> {
  const text = args.text;
  try {
    const conv = args.conv;
    if (!String(text ?? "").trim() || !conv) return text;
    if (args.protectedReply) return text;
    // Defence in depth on the ONE guarantee that matters on the money path: a customer is offered
    // the application once, ever. The referee checks this too, but the referee is reached through a
    // parse; this check is not, so a resolver that ever answered wrongly still cannot double-send.
    if (conv.financeAppInviteSentAt) return text;
    const inbound = latestInboundCustomerText(conv);
    if (!inbound) return text;
    const creditAppUrl = String(args.creditAppUrl ?? "").trim();
    const decision = await (args.resolveOffer ?? resolveFinanceApplicationOfferTurn)({
      text: inbound,
      history: args.history,
      alreadyOffered: !!conv.financeAppInviteSentAt,
      creditAppAvailable: /^https?:\/\//i.test(creditAppUrl)
    });
    if (decision.kind !== "offer_credit_application") return text;
    const line = buildFinanceAppInviteLine({ creditAppUrl, bookingUrl: args.bookingUrl });
    if (!line) return text;
    // Stamped the moment it is composed, so a retry, a regenerate, or the older quote-details
    // trigger can never send a second one.
    conv.financeAppInviteSentAt = args.nowIso ?? new Date().toISOString();
    args.onOffered?.();
    return `${text} ${line}`;
  } catch {
    return text; // a failed offer never costs the reply
  }
}
