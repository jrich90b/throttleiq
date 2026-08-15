/**
 * Past-purchase complaint — acknowledge, but never concede fault before the sale is verified.
 *
 * ── WHY THIS EXISTS (Joe, 2026-08-15) ─────────────────────────────────────────────────────────
 * Tom Leo `+12162171070`, 04:30Z, arrived as a Room58 web lead whose Inquiry was a complaint about
 * a used Road King he says he bought from us "last year" — 12-year-old tires, nothing serviced, a
 * brake handle that snapped, $2,000 out of his pocket. Two things went wrong, in this order:
 *
 *   1. The word "tires" put him in the PARTS queue (the ADF lexicon override), so the first draft
 *      answered a complaint with "I've received your parts request."
 *   2. The in-product Claude review caught that and rewrote it — into a written apology:
 *      *"12-year-old tires and no service before delivery is not okay"*, plus an offer to
 *      "see what we can do for you", on a bike he himself says he bought AS-IS.
 *
 * Nobody had checked whether the sale was ours. Joe: *"we need to find out if the customer
 * actually bought the bike from us or they are reaching out to the wrong dealer."*
 *
 * MEASURED the same morning: we structurally cannot answer that from the store. Tom has no prior
 * conversation; the only contact row was minted by his own form. His purchase predates the store
 * (history starts ~Mar/Apr 2026), so absence proves nothing, and the two Road Kings recorded sold
 * since then both went to 716 Buffalo numbers — he is a 216 Cleveland number, ~200 miles away. He
 * also never once writes that he bought it from US: his wording slides between "they/them" for the
 * selling dealer and "you guys" for whoever he is writing to. The answer lives only in the deal
 * jacket. So the reply must ASK, not assume, and must concede nothing while it asks.
 *
 * ── "ONLY IF IT LOOKS SUSPICIOUS" (Joe's constraint on the build) ─────────────────────────────
 * A customer we can SEE we sold to should not be interrogated about it — that is its own insult.
 * So the verification question is gated on doubt: it fires only when we cannot see the sale on our
 * own books, or when the customer's own words point at another dealer. When both agree the sale is
 * ours, the arm still routes to a human and still says nothing about fault, but it skips the ask.
 *
 * ── FAIL DIRECTION ────────────────────────────────────────────────────────────────────────────
 * Two directions, deliberately opposite:
 *  - DETECTING a complaint fails toward `none` (today's behaviour). A disabled LLM, no key, an
 *    error, or a low confidence all leave the existing routing alone — this arm can never invent a
 *    complaint out of an ordinary sales lead and start asking people to prove they bought a bike.
 *  - Once detected, the arm fails toward `unverified` (ask, concede nothing). `verified` requires
 *    POSITIVE evidence on both sides — the customer says it was us AND we can see it. Anything
 *    short of that asks the question, because the cost of asking a real customer one extra
 *    question is far below the cost of apologising for another dealer's deal.
 *
 * The customer-facing wording is a TEMPLATE, not a generated reply, and that is the point: this
 * arm exists because a generated reply apologised. A template is the only guarantee that the words
 * "we were wrong" cannot appear before a human has pulled the deal.
 */
import { z } from "zod";

export const PastPurchaseComplaintSchema = z.object({
  is_past_purchase_complaint: z
    .boolean()
    .describe(
      "True when the customer is describing a PROBLEM with a motorcycle they already bought — " +
        "condition, prep, service, a repair they had to pay for, or how the sale was handled. " +
        "False for anything a shopper says before buying: price haggling, availability, a bike " +
        "they are considering, or a complaint about a service appointment they have not had yet."
    ),
  purchase_attribution: z
    .enum(["this_dealer", "another_dealer", "unclear"])
    .describe(
      'Whose sale is it, according to the CUSTOMER\'S OWN WORDS in this message? "this_dealer": ' +
        'they address us as the seller ("I bought it from you", "you guys sold me"). ' +
        '"another_dealer": they clearly point at a different store or at Harley corporate. ' +
        '"unclear": they never say. Pay attention to pronouns — a customer who calls the seller ' +
        '"they" or "them" while calling the reader "you" is NOT saying they bought it from us. ' +
        "Do not resolve the ambiguity; report it."
    ),
  bought_as_is: z
    .boolean()
    .describe(
      "True when the customer themselves says the bike was sold as-is, or otherwise takes the " +
        "blame for the condition. This changes what we may promise, so report it even when they " +
        "are complaining in the same breath."
    ),
  confidence: z.number().min(0).max(1)
});

export type PastPurchaseComplaintParse = z.infer<typeof PastPurchaseComplaintSchema>;

/**
 * Strip the JSON-schema keywords OpenAI strict mode rejects (Zod emits `oneOf` for unions, which
 * the API refuses outright and requestStructuredJson turns into null — a parser that looks merely
 * unsure while never having run). Mirrors `visitCommitmentParser.toStrictSchema`.
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

export function pastPurchaseComplaintJsonSchema(): { [key: string]: unknown } {
  return toStrictSchema(z.toJSONSchema(PastPurchaseComplaintSchema, { target: "draft-7" }));
}

/**
 * The floor a complaint read must clear before it takes the turn away from normal routing.
 * Middling by design: too low and an ordinary gripe from a shopper gets asked to produce a stock
 * number; too high and the arm never fires on the long, rambling messages these actually are.
 */
export function pastPurchaseComplaintConfidenceMin(): number {
  const raw = Number(process.env.LLM_PAST_PURCHASE_COMPLAINT_CONFIDENCE_MIN);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.7;
}

export type PastPurchaseComplaintArm =
  | "none"
  /** The sale is ours on both accounts — empathise, hand to a human, ask nothing to prove it. */
  | "service_recovery_verified"
  /** We cannot see the sale, or they point elsewhere — acknowledge, ask the ONE question, concede nothing. */
  | "service_recovery_unverified";

export type PastPurchaseComplaintInput = {
  parse: PastPurchaseComplaintParse | null | undefined;
  confidenceMin: number;
  /**
   * Deterministic store fact, resolved by the caller (`hasPurchaseOnRecord`): can we SEE this sale
   * on our own books? A recorded sold unit for this lead, or a conversation that existed before
   * this one. Never inferred from the customer's text — that is the parser's job, and the whole
   * point is that the two are separate opinions.
   */
  purchaseOnRecord: boolean;
};

export type PastPurchaseComplaintDecision = {
  arm: PastPurchaseComplaintArm;
  /** True on both live arms: this never stays with the bot and never sits in a department queue. */
  handoffToHuman: boolean;
  /** True only on the unverified arm — the ask that resolves whose sale it is. */
  askPurchaseVerification: boolean;
  /** Always true on a live arm. Carried explicitly so the wording gate is readable at the call site. */
  suppressFaultConcession: boolean;
};

/** The "this turn is not a past-purchase complaint" decision — today's behaviour, unchanged. */
export const NO_PAST_PURCHASE_COMPLAINT: PastPurchaseComplaintDecision = {
  arm: "none",
  handoffToHuman: false,
  askPurchaseVerification: false,
  suppressFaultConcession: false
};

const NO_COMPLAINT = NO_PAST_PURCHASE_COMPLAINT;

/**
 * Pure referee — the ONE place the arm is chosen, so ADF intake, live inbound and regenerate
 * cannot drift apart. No LLM, no store, no clock: unit-testable, pinned by
 * `past_purchase_complaint:eval`.
 */
export function decidePastPurchaseComplaintTurn(
  input: PastPurchaseComplaintInput
): PastPurchaseComplaintDecision {
  const parse = input.parse;
  if (!parse || !parse.is_past_purchase_complaint) return NO_COMPLAINT;
  if (!(Number(parse.confidence ?? 0) >= input.confidenceMin)) return NO_COMPLAINT;

  // "Only if it looks suspicious" — both opinions must point at us before we skip the ask.
  const verified = parse.purchase_attribution === "this_dealer" && input.purchaseOnRecord;

  return {
    arm: verified ? "service_recovery_verified" : "service_recovery_unverified",
    handoffToHuman: true,
    askPurchaseVerification: !verified,
    suppressFaultConcession: true
  };
}

/**
 * The customer-facing wording. Deterministic on purpose (AGENTS.md allows deterministic for
 * compliance/safety gates): this arm exists because a GENERATED reply admitted fault on an
 * unverified, explicitly as-is sale. Neither template apologises for anything we did, neither
 * promises remediation, and neither states a figure — a human owns both of those.
 *
 * `agentName`/`dealerCity` come from the dealer profile so this stays portable (the source ratchet
 * counts dealer literals in services/api/src).
 */
export function buildPastPurchaseComplaintReply(args: {
  arm: PastPurchaseComplaintArm;
  firstName?: string | null;
  agentName: string;
  dealerCity?: string | null;
}): string {
  const name = String(args.firstName ?? "").trim();
  const greeting = name ? `Hey ${name}, it's ${args.agentName}` : `Hey, it's ${args.agentName}`;
  if (args.arm === "service_recovery_verified") {
    return (
      `${greeting}. I'm sorry to hear the bike gave you trouble after you took it home, and I ` +
      `appreciate you telling us instead of just walking away. I'm getting this in front of the ` +
      `right person here — can you tell me the best time to reach you?`
    );
  }
  const where = String(args.dealerCity ?? "").trim();
  const askWhere = where ? `, or was that with us here in ${where}?` : ` — and was that purchase with us?`;
  return (
    `${greeting}. I'm sorry to hear the bike gave you trouble after you took it home, and I ` +
    `appreciate you taking the time to tell us. I want to get this in front of the right person ` +
    `here — can you tell me roughly when you bought it and the stock number${askWhere}`
  );
}

/**
 * Reads whether this turn is a complaint about a bike the customer already owns.
 *
 * GATED ON LENGTH, NEVER ON KEYWORDS. A keyword gate would be the exact failure this arm was
 * built to fix — Tom's own message misses an obvious grief-word scan ("surprised", "wouldn't
 * expect", no swearing), and the routing bug that started all this was a lexicon deciding what a
 * message was about. A word count is content-blind, so it cannot systematically miss a complaint
 * for being phrased politely. MEASURED 2026-08-15 over 90 days: 152 of 401 ADF inquiries reach 12
 * words, i.e. ~1.7 extra parser calls a day.
 */
export async function parsePastPurchaseComplaintWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
}): Promise<PastPurchaseComplaintParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_PAST_PURCHASE_COMPLAINT_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const { requestStructuredJson } = await import("./llmDraft.js");
  const primaryModel =
    process.env.OPENAI_PAST_PURCHASE_COMPLAINT_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_PAST_PURCHASE_COMPLAINT_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const history = (args.history ?? []).slice(-6).map(h => `${h.direction}: ${h.body}`);
  const prompt = [
    "You read messages sent to a motorcycle dealership and answer ONE question: is this customer",
    "complaining about a motorcycle they ALREADY BOUGHT? Return only JSON matching the schema.",
    "",
    "Someone shopping for a bike is not this, however unhappy they are — a bad price, a bike that",
    "sold before they got there, a rude experience on the floor. This is specifically a bike that",
    "is already theirs: how it was prepped, what broke, what they had to spend after taking it",
    "home, or how the deal was handled.",
    "",
    "WHOSE SALE IT IS MATTERS MORE THAN THE COMPLAINT. Read the pronouns literally. People write",
    'to a dealership about ANOTHER dealership all the time, and they give it away: the seller is',
    '"they" or "them" while the reader is "you". Only answer "this_dealer" when the customer',
    "actually addresses the reader as the seller. If they never say, answer \"unclear\" — do not",
    "settle it for them, and do not treat a friendly tone or a mention of the reader's name as",
    "proof of who sold the bike.",
    "",
    "Examples:",
    'input: "I ve done business in the past I was trading a bike in I wanted a road king and there was one they advertised for 9999. I had to put $2000 into it once I took it home. The tires were 12 years old. There was nothing serviced on it. I thought you guys kind of prided yourself on at least changing the oils. The brake handle snapped right off. I bought it as it so it s my fault and thank God I like the bike. I ve sent people there in the past because I had a good experience with them last year." output: {"is_past_purchase_complaint":true,"purchase_attribution":"unclear","bought_as_is":true,"confidence":0.93}',
    'input: "I picked up my Street Glide from you guys last month and the front tire was already worn to the bars. Pretty disappointed." output: {"is_past_purchase_complaint":true,"purchase_attribution":"this_dealer","bought_as_is":false,"confidence":0.95}',
    'input: "I bought a bike at a dealer downstate and they never sent the title. Can you help me get corporate involved?" output: {"is_past_purchase_complaint":true,"purchase_attribution":"another_dealer","bought_as_is":false,"confidence":0.94}',
    'input: "Your price on that Road Glide is way over book and nobody called me back. Terrible service." output: {"is_past_purchase_complaint":false,"purchase_attribution":"unclear","bought_as_is":false,"confidence":0.9}',
    'input: "The tires on the Low Rider I am looking at look old. Would you put new ones on before I pick it up?" output: {"is_past_purchase_complaint":false,"purchase_attribution":"unclear","bought_as_is":false,"confidence":0.9}',
    'input: "Second bike I have bought from you and the service has always been great. Just need a part number for the rear brake pads." output: {"is_past_purchase_complaint":false,"purchase_attribution":"this_dealer","bought_as_is":false,"confidence":0.9}',
    'input: "WEB LEAD (ADF) Source: Room58 - Standard Inquiry: Looking for pricing on a 2026 Street Glide" output: {"is_past_purchase_complaint":false,"purchase_attribution":"unclear","bought_as_is":false,"confidence":0.95}',
    "",
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "past_purchase_complaint_parser",
      schema: pastPurchaseComplaintJsonSchema(),
      maxOutputTokens: 90,
      debugTag: "llm-past-purchase-complaint-parser",
      debug: process.env.LLM_PAST_PURCHASE_COMPLAINT_PARSER_DEBUG === "1"
    });

  const raw =
    (await runParse(primaryModel)) ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!raw) return null;
  const result = PastPurchaseComplaintSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/** Below this, a message is too short to be the kind of account these complaints always are. */
export function pastPurchaseComplaintMinWords(): number {
  const raw = Number(process.env.LLM_PAST_PURCHASE_COMPLAINT_MIN_WORDS);
  return Number.isFinite(raw) && raw > 0 ? raw : 12;
}

export function isLongEnoughForPastPurchaseComplaint(text: string | null | undefined): boolean {
  const words = String(text ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return words >= pastPurchaseComplaintMinWords();
}

/**
 * The ONE call ADF intake, live inbound and regenerate all make. Keeps the parse, the confidence
 * floor and the referee in one place so the three paths cannot drift (route-parity law).
 * Any parser failure resolves to `none` — today's behaviour — and can never block a turn.
 */
export async function resolvePastPurchaseComplaintTurn(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  purchaseOnRecord: boolean;
}): Promise<PastPurchaseComplaintDecision> {
  if (!isLongEnoughForPastPurchaseComplaint(args.text)) return NO_COMPLAINT;
  let parse: PastPurchaseComplaintParse | null = null;
  try {
    parse = await parsePastPurchaseComplaintWithLLM({ text: args.text, history: args.history });
  } catch {
    parse = null; // a failed read leaves existing routing standing
  }
  return decidePastPurchaseComplaintTurn({
    parse,
    confidenceMin: pastPurchaseComplaintConfidenceMin(),
    purchaseOnRecord: args.purchaseOnRecord
  });
}

/**
 * Conversation-shaped wrapper for the SMS lanes — resolves the deterministic half (is there a sale
 * on our books?) from the conversation itself, so `index.ts` carries a call rather than a block.
 * `eligible: false` short-circuits before any work (human-owned threads, short acks).
 */
export async function resolveConversationPastPurchaseComplaint(
  conv: any,
  text: string,
  history?: { direction: "in" | "out"; body: string }[],
  opts?: { eligible?: boolean }
): Promise<PastPurchaseComplaintDecision> {
  if (opts?.eligible === false) return NO_COMPLAINT;
  if (!isLongEnoughForPastPurchaseComplaint(text)) return NO_COMPLAINT; // skip the store read too
  const { hasPurchaseOnRecord } = await import("./inventorySolds.js");
  return resolvePastPurchaseComplaintTurn({
    text,
    history,
    purchaseOnRecord: await hasPurchaseOnRecord({
      leadKey: conv?.leadKey,
      convId: conv?.id,
      soldOnThread: !!conv?.sale?.soldAt || conv?.closedReason === "sold"
    })
  });
}

/**
 * The staff-side half of the arm: the manager task that carries what the bot deliberately did NOT
 * say. Shared by all three paths so the queue reads the same however the complaint arrived.
 */
export function buildPastPurchaseComplaintTodoSummary(args: {
  decision: PastPurchaseComplaintDecision;
  customerText?: string | null;
}): string {
  return [
    args.decision.askPurchaseVerification
      ? "Customer complaint about a bike they already own — PURCHASE NOT VERIFIED as ours. Pull the deal jacket before responding; the draft asks them when they bought it and for the stock number."
      : "Customer complaint about a bike they bought from us. Pull the deal jacket before responding.",
    "No fault has been conceded and nothing has been promised in writing.",
    String(args.customerText ?? "").trim()
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Composes the reply AND applies the state both SMS lanes need: the manager task and the handoff.
 * Lives here rather than inline in `index.ts` so the live and regenerate call sites are a call
 * apiece and cannot drift — and so the source-size ratchet stays honest about where new code goes.
 */
export async function applyPastPurchaseComplaintHandoff(
  conv: any,
  decision: PastPurchaseComplaintDecision,
  args: { customerText?: string | null; sourceMessageId?: string | null; fileTask?: boolean }
): Promise<string> {
  const [{ getDealerProfile }, { addTodo, setFollowUpMode }] = await Promise.all([
    import("./dealerProfile.js"),
    import("./conversationStore.js")
  ]);
  const profile = await getDealerProfile();
  if (args.fileTask !== false) {
    addTodo(
      conv,
      "manager",
      buildPastPurchaseComplaintTodoSummary({ decision, customerText: args.customerText }),
      args.sourceMessageId ?? undefined
    );
    setFollowUpMode(conv, "manual_handoff", PAST_PURCHASE_COMPLAINT_HANDOFF_REASON);
  }
  return buildPastPurchaseComplaintReply({
    arm: decision.arm,
    firstName: conv?.lead?.firstName ?? null,
    agentName: String(profile?.agentName ?? "").trim() || "our team",
    dealerCity: String(profile?.address?.city ?? "").trim() || null
  });
}

export const PAST_PURCHASE_COMPLAINT_HANDOFF_REASON = "past_purchase_complaint";

/**
 * Complaint replies that used to sit inline in `index.ts`, moved here so every reply we send to an
 * unhappy customer is written in one place. Behaviour-preserving: same words, same call sites.
 */
export function buildComplaintEmpathyFallbackReply(): string {
  return "Yeah, I hear you — that’s frustrating. A few riders have said the same thing too.";
}

/**
 * "Where is my sale pending?" — a deterministic SAFETY gate (it forces a human handoff), moved
 * here with the other complaint helpers. Fail direction unchanged: a miss falls through to normal
 * routing, never to a wrong answer.
 */
export function isPendingComplaint(text: string): boolean {
  const t = String(text ?? "").trim().toLowerCase();
  return /sale pending|still pending|been pending|pending for|pending too long|what is going on/.test(t);
}

export function buildDataQualityComplaintReply(firstName?: string | null): string {
  const name = String(firstName ?? "").trim();
  const prefix = name ? `Sorry about that, ${name}` : "Sorry about that";
  return `${prefix} — you’re right to call that out. I’ll have the team review the details and follow up with the correct information.`;
}
