/**
 * "What I can spend depends on the financing" — a typed parser (2026-08-10).
 *
 * ORIGIN (+17164208660, Franklin, live 2026-08-10 12:03 ET). He came in on an HDFS credit
 * application for a Street Bob 114. We asked "do you want new, used, or both, and what budget
 * should I target?" and he answered:
 *
 *     "No I want used and I don't know it depends on how much money I have to put down"
 *
 * He answered BOTH halves — used, and "I can't give you a number until I know the down payment"
 * — and the next draft asked "any budget range I should target before I pull the short list?".
 * The clarifier's budget hint is a six-word list ($, under, over, around, about, max) and it
 * scored his sentence as "budget not discussed". A rep took the thread over before it sent.
 *
 * JOE RULED IT, 2026-08-10: *"it should probably hand it to finance, only finance can handle
 * that info."* That is the whole behavior — when what a customer can spend is gated on the
 * financing (down payment, monthly payment, what they qualify for, what the bank says), the
 * agent must stop asking for a number it cannot help them arrive at, and put the finance
 * manager on it.
 *
 * WHY A PARSER AND NOT A LONGER WORD LIST: this is a comprehension judgement — "did the
 * customer answer the budget question by telling us it depends on financing?" — and per
 * AGENTS.md that belongs to a typed parser. The hint below is only a cheap pre-filter GATE so
 * the LLM does not run on every turn; a hint miss falls through to existing behavior, which is
 * the safe direction (one redundant question, not a wrong handoff).
 */
// llmDraft.ts constructs the OpenAI client at module load, so it is imported LAZILY, inside the
// parse call. That keeps this module's pure half — the gate, the confidence floor, the reply copy
// and the schema — importable by budget_gated_on_financing:eval without credentials, so the eval
// stays deterministic. index.ts loads llmDraft eagerly anyway, so this costs the runtime nothing.
type RequestStructuredJson = (typeof import("./llmDraft.js"))["requestStructuredJson"];

export type BudgetFinancingDeferralIntent = "budget_gated_on_financing" | "none";

export type BudgetFinancingDeferralParse = {
  intent: BudgetFinancingDeferralIntent;
  confidence: number;
};

export const BUDGET_FINANCING_DEFERRAL_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "confidence"],
  properties: {
    intent: { type: "string", enum: ["budget_gated_on_financing", "none"] },
    confidence: { type: "number" }
  }
};

/**
 * Cheap pre-filter so the parser only runs on plausible phrasings. A GATE, NOT comprehension:
 * a miss falls through to today's behavior, and the parser — never this regex — owns the
 * gated-vs-not decision. Deliberately broad; precision is the parser's job.
 */
const BUDGET_FINANCING_HINT_RE =
  /\b(put(?:ting)?\s+down|down\s*payment|financ(?:e|ing|ed)|monthly|payment|afford|qualify|approved|pre[-\s]?approved|budget|bank|lender|credit|trade[-\s]?in value|depends)\b/i;

export function budgetFinancingDeferralHint(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  return BUDGET_FINANCING_HINT_RE.test(t);
}

/** Confidence floor for the handoff (default 0.7). */
export function budgetGatedOnFinancingConfidenceMin(): number {
  const raw = Number(process.env.LLM_BUDGET_GATED_ON_FINANCING_CONFIDENCE_MIN);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.7;
}

/**
 * The handoff copy. NO figures — only finance quotes numbers (rate policy / charter C1.6) — and
 * it must END BY ASKING: charter C1.7 binds our deterministic templates exactly as it binds the
 * LLM composer, so this closes on a choice of two that drives an appointment rather than on a
 * statement ("...they'll reach out shortly"), which is what left the older acks non-compliant.
 */
export function buildBudgetGatedOnFinancingReply(): string {
  return (
    "Totally fair — what you put down changes the whole picture, and our finance manager is the " +
    "one who can walk you through it properly. I'll get them looped in. Would you rather they " +
    "reach out first, or come in and go over it in person?"
  );
}

export async function parseBudgetFinancingDeferralWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
}): Promise<BudgetFinancingDeferralParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_BUDGET_FINANCING_DEFERRAL_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const primaryModel =
    process.env.OPENAI_BUDGET_FINANCING_DEFERRAL_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_BUDGET_FINANCING_DEFERRAL_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-6).map(h => `${h.direction}: ${h.body}`);
  const prompt = [
    "You read SMS in a Harley dealership sales thread. We often ask a shopper what budget we",
    "should target before pulling a list of bikes. Decide whether the customer has told us that",
    "what they can spend DEPENDS ON THE FINANCING — the down payment, the monthly payment, what",
    "they qualify for, or what a lender/bank says — rather than giving or withholding a number.",
    "Only the finance manager can answer that, so the agent must hand off instead of asking again.",
    "Return only JSON that matches the provided schema.",
    "",
    "Classify intent:",
    '- "budget_gated_on_financing": the customer ties their spending limit to financing terms, or',
    "  says they cannot name a budget until the financing is known. Examples: it depends on how",
    "  much I put down; whatever my monthly payment works out to; depends what the bank approves",
    "  me for; I need to know what I qualify for first; depends on my down payment.",
    '- "none": everything else — a stated budget or range ("around 15k", "under $20,000", "as',
    '  cheap as possible"), a refusal to discuss money, a question about the financing PROCESS',
    "  (another handler owns that), or any turn not about what they can spend. A customer merely",
    "  MENTIONING financing while giving a real number is \"none\".",
    "",
    "confidence: 0..1, how sure you are. Be conservative — when the turn is ambiguous, answer",
    '"none" with a low confidence, because a wrong handoff pulls a person into a thread that did',
    "not need one.",
    "",
    history.length ? `Recent thread (oldest first):\n${history.join("\n")}` : "",
    `Customer message: ${text}`
  ]
    .filter(Boolean)
    .join("\n");

  const requestStructuredJson: RequestStructuredJson = (await import("./llmDraft.js"))
    .requestStructuredJson;
  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "budget_financing_deferral_parser",
      schema: BUDGET_FINANCING_DEFERRAL_JSON_SCHEMA,
      maxOutputTokens: 80,
      debugTag: "llm-budget-financing-deferral-parser",
      debug: process.env.LLM_BUDGET_FINANCING_DEFERRAL_PARSER_DEBUG === "1"
    });

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const intent: BudgetFinancingDeferralIntent =
    String(parsed.intent ?? "").toLowerCase() === "budget_gated_on_financing"
      ? "budget_gated_on_financing"
      : "none";
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;
  return { intent, confidence };
}
