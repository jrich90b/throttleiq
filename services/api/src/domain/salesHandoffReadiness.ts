/**
 * "We have enough — stop asking, hand them to a person." (Joe, 2026-08-10)
 *
 * ORIGIN — John Zimmerman, +17169902571, 2026-08-10 19:18 ET. He came in on a SUBMITTED HDFS credit
 * application for a 2026 Road Glide. We asked: "Are you looking at the Road Glide, or open to a
 * couple of options?" He answered:
 *
 *     "Couple options"
 *
 * — our own second option, in our own words. The draft back was "Quick check — are you asking about
 * availability, pricing/payments, or scheduling a time to come in?", and the thread was filed
 * `clarify_schedule`. We had a reachable customer, a submitted credit app and a settled bike
 * question, and we asked him what he meant.
 *
 * Joe: *"the agent has to know when we have enough info and to handoff — we don't need the agent to
 * keep asking questions."*
 *
 * ── WHY THIS IS A FIFTH C1.7 EXCEPTION, IN CODE ───────────────────────────────────────────────
 * Charter C1.7 says every reply ends with ONE advancing question. That is right while we are still
 * discovering, and wrong once a salesperson could take the lead as-is: past that point another
 * question is not advancing anything, it is stalling — and it reads as though nobody listened.
 * `advanceEveryReplySuppressed` already holds four exceptions decided in CODE precisely because the
 * same list written as prompt caveats lost to the imperative above it 3 times out of 3. This is the
 * fifth, and it belongs beside them for the same measured reason.
 *
 * ── FAIL DIRECTION ────────────────────────────────────────────────────────────────────────────
 * Unsure ⇒ KEEP ASKING. A premature handoff spends a salesperson's time on a lead that was still
 * qualifying itself; a late one costs one extra question. So every input must be positively known:
 * a missing phone, an unknown money path or an unsettled bike question all mean "not yet".
 */
import { z } from "zod";

/** Has the customer settled the bike question — a specific model, or openness to a shortlist? */
export const BikeScopeSchema = z.object({
  bike_scope: z
    .enum(["specific_bike", "open_to_options", "not_stated"])
    .describe(
      'How the customer has answered WHICH BIKE. "specific_bike": they named or confirmed one ' +
        'particular model. "open_to_options": they said they are open, flexible, want a few to ' +
        'compare, or picked an "or open to a couple of options" style offer we just made — ' +
        '"couple options", "open to anything", "whatever you have", "show me a few". ' +
        '"not_stated": they have not addressed which bike at all this turn or earlier.'
    ),
  confidence: z.number().min(0).max(1)
});

export type BikeScopeParse = z.infer<typeof BikeScopeSchema>;

/**
 * Strip the JSON-schema keywords OpenAI strict mode rejects.
 * Measured 2026-08-10: Zod emits `oneOf` for unions, which the API refuses outright
 * ("'oneOf' is not permitted") and requestStructuredJson turns into null — a parser that looks
 * merely unsure while never having run. An enum needs no rewrite, but `$schema` still goes.
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

export function bikeScopeJsonSchema(): { [key: string]: unknown } {
  return toStrictSchema(z.toJSONSchema(BikeScopeSchema, { target: "draft-7" }));
}

export function bikeScopeConfidenceMin(): number {
  const raw = Number(process.env.LLM_BIKE_SCOPE_CONFIDENCE_MIN);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.7;
}

/**
 * Reads whether the bike question is settled. HISTORY IS REQUIRED, not decoration: "couple options"
 * is meaningless on its own and only resolves against the either/or WE asked on the previous turn.
 */
export async function parseBikeScopeWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
}): Promise<BikeScopeParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_BIKE_SCOPE_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const { requestStructuredJson } = await import("./llmDraft.js");
  const primaryModel = process.env.OPENAI_BIKE_SCOPE_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_BIKE_SCOPE_PARSER_MODEL_FALLBACK || (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const history = (args.history ?? []).slice(-6).map(h => `${h.direction}: ${h.body}`);
  const prompt = [
    "You read SMS in a Harley dealership sales thread and decide ONLY whether the customer has",
    "settled WHICH BIKE they are after. Return only JSON matching the schema.",
    "",
    "The customer's reply often only makes sense against OUR previous turn. If we asked",
    '"Are you looking at the Road Glide, or open to a couple of options?" and they answer',
    '"couple options", they have chosen our second option: that is "open_to_options", not a',
    "non-answer and not a question about anything.",
    "",
    'Answer "not_stated" when they have genuinely not addressed which bike — a question about hours,',
    "a trade, financing terms, or small talk. Be conservative: unsure is \"not_stated\".",
    "",
    history.length ? `Recent thread (oldest first):\n${history.join("\n")}` : "",
    `Customer message: ${text}`
  ]
    .filter(Boolean)
    .join("\n");

  const run = async (model: string) =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "bike_scope_parser",
      schema: bikeScopeJsonSchema(),
      maxOutputTokens: 80,
      debugTag: "llm-bike-scope-parser",
      debug: process.env.LLM_BIKE_SCOPE_PARSER_DEBUG === "1"
    });

  const raw = (await run(primaryModel)) ?? (fallbackModel && fallbackModel !== primaryModel ? await run(fallbackModel) : null);
  if (!raw) return null;
  const checked = BikeScopeSchema.safeParse(raw);
  return checked.success ? checked.data : null;
}

/**
 * The hand-off reply. Deliberately ends WITHOUT a question — that is the whole point of the rule,
 * and why the suppression lives in code beside C1.7's other four exceptions. It promises only a
 * person, never a figure, a bike we may not have, or a time nobody has checked.
 *
 * It names the FINANCE TEAM, not "a salesperson" (Joe, 2026-08-11), for two reasons. The first ack
 * on these threads already says "I'll have our finance team reach out" — naming anyone else
 * contradicts, in our own words, what the customer was told an hour earlier. And the gate requires a
 * SUBMITTED credit application, so every lead that can reach this reply is a finance lead by
 * construction. If the readiness rule is ever widened past `moneyPathIsKnown`, this sentence must be
 * revisited in the same change.
 */
export function buildEnoughInfoHandoffReply(firstName?: string | null): string {
  const name = String(firstName ?? "").trim();
  const opener = name ? `Thanks ${name}` : "Thanks";
  return (
    `${opener} — that's everything I need. I'm handing this to our finance team now; ` +
    `they'll line up a couple of options and take it from here. They'll be in touch shortly.`
  );
}

/**
 * PURE. Everything about "may we hand off?" that does not need index.ts-local helpers.
 *
 * The cheap state gates run FIRST so an ordinary lead never costs a parser call: only a submitted
 * credit application gets that far. Returns null when the caller should carry on as today.
 */
export function evaluateEnoughInfoHandoff(args: {
  cta?: string | null;
  leadPhone?: string | null;
  leadEmail?: string | null;
  leadKey?: string | null;
  followUpMode?: string | null;
  hasAppointment?: boolean | null;
  firstName?: string | null;
  scopeParse?: BikeScopeParse | null;
  decide: (input: {
    contactable: boolean;
    moneyPathKnown: boolean;
    bikeScopeSettled: boolean;
    alreadyHandedOff: boolean;
    appointmentBooked: boolean;
  }) => { kind: string; reason: string };
}): { reply: string; reason: string } | null {
  const decision = args.decide({
    contactable: !!(args.leadPhone || args.leadEmail || args.leadKey),
    moneyPathKnown: moneyPathIsKnown(args.cta),
    bikeScopeSettled: bikeScopeIsSettled(args.scopeParse),
    alreadyHandedOff: String(args.followUpMode ?? "") === "manual_handoff",
    appointmentBooked: !!args.hasAppointment
  });
  if (decision.kind !== "handoff") return null;
  return { reply: buildEnoughInfoHandoffReply(args.firstName), reason: decision.reason };
}

/** A real finance ARTEFACT — a SUBMITTED credit app — never a prequal ORIGIN label. */
export function moneyPathIsKnown(cta?: string | null): boolean {
  const value = String(cta ?? "").trim().toLowerCase();
  return value === "hdfs_coa" || value === "hdfs_coa_online";
}

export function bikeScopeIsSettled(parse?: BikeScopeParse | null): boolean {
  if (!parse) return false;
  if (!Number.isFinite(parse.confidence) || parse.confidence < bikeScopeConfidenceMin()) return false;
  return parse.bike_scope === "specific_bike" || parse.bike_scope === "open_to_options";
}
