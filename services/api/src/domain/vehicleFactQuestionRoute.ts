/**
 * Who wins when the typed vehicle-fact parser and the legacy keyword fallback disagree.
 *
 * The vehicle-fact route ("what year is it?", "how many miles?") is decided by a typed LLM
 * parser. Behind it sits a keyword fallback that stamps `confidence: 0` on a bare word match
 * (`\bmiles\b`, `\bcolor\b`, ...). That fallback exists for ONE reason: a parser OUTAGE must
 * still answer a real question. It was never meant to overrule a parser that ran.
 *
 * It did anyway. Measured on the live route audit (86 days, `reports/route_audit`):
 * 34 of 48 vehicle-fact routes were decided by the fallback at `confidence: 0`, and EVERY
 * fallback fire on a genuinely live inbound (zero lag between the customer's text and the
 * route) was a false positive:
 *
 *   +14805441825  "Bikes never seen rain above 20,000 miles plus the original seat"
 *                 -> fallback said `mileage` -> we replied "It has about 20,000 miles."
 *                    The customer was describing THEIR OWN bike; we handed their number back
 *                    as a dealership fact. Reported twice in 12 minutes on 2026-08-16.
 *   +15857552622  "Color doesn't matter. 2014-2016 does matter."
 *                 -> fallback said `color` -> we would have answered with a colour.
 *
 * Replaying the real parser over those turns (3 runs each) shows it already gets them right,
 * and that the discriminator is `explicitRequest`, NOT confidence:
 *
 *   every false positive -> explicitRequest FALSE   (incl. `mileage@0.35-0.72` on "About 20k
 *                                                    miles", which `questionType === "none"`
 *                                                    can never catch)
 *   every true positive  -> explicitRequest TRUE    ("Price ?" 0.98, "what's the price on both
 *                                                    of them?" 0.90-0.98, "what can we do out
 *                                                    the door?" 0.45-0.78)
 *
 * So the rule below is simply AGENTS.md's "comprehend, never regex" applied to the tie-break:
 * when the parser RAN and affirmatively said the customer is not requesting this fact, a
 * confidence-0 keyword match does not get to claim the turn.
 *
 * FAIL DIRECTION (why this is safe): blocking the fallback returns `null`, and the turn falls
 * through to the general draft pipeline, which still replies — it just replies with something
 * that comprehends the message instead of a canned fact answer plus a spurious staff todo and
 * a `manual_handoff` flip. We fail toward NOT asserting a fact we were never asked for. A real
 * parser outage (`parsed === null`) is untouched: the keyword fallback remains the fail-safe,
 * exactly as designed.
 *
 * SCOPE — the money types are deliberately NOT covered here. `price`, `otd_total` and
 * `finance_program_eligibility` keep today's behaviour byte for byte, because changing whether
 * we quote a figure is approve-first work. Not one measured false positive was on a money type
 * (both live ones were `mileage` and `color`), so holding that slice back costs nothing we can
 * measure. See MONEY_VEHICLE_FACT_QUESTION_TYPES.
 *
 * Shared by every vehicle-fact door so they cannot drift: `resolveVehicleFactQuestionDecision`
 * (index.ts — serves BOTH /webhooks/twilio and /conversations/:id/regenerate) and
 * `resolveAdfVehicleFactDecision` (routes/sendgridInbound.ts).
 */

/** The shape this referee needs from a vehicle-fact parse. Structural on purpose: the eval
 *  drives it with plain objects and never boots the draft stack. */
export type VehicleFactQuestionParseLike = {
  questionType?: string | null;
  explicitRequest?: boolean | null;
  confidence?: number | null;
};

/**
 * Vehicle-fact question types that quote or imply a FIGURE. Changing whether these answer is a
 * money-path behaviour change (approve-first), so the parser-beats-keyword rule below leaves
 * them alone and only the pre-existing confident-"none" rule applies to them.
 */
export const MONEY_VEHICLE_FACT_QUESTION_TYPES: ReadonlySet<string> = new Set([
  "price",
  "otd_total",
  "finance_program_eligibility"
]);

export const DEFAULT_VEHICLE_FACT_CONFIDENCE_MIN = 0.74;

export function vehicleFactConfidenceMin(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.LLM_VEHICLE_FACT_CONFIDENCE_MIN ?? DEFAULT_VEHICLE_FACT_CONFIDENCE_MIN);
  return Number.isFinite(raw) ? raw : DEFAULT_VEHICLE_FACT_CONFIDENCE_MIN;
}

/**
 * May the confidence-0 keyword fallback claim this turn as `candidateQuestionType`?
 *
 * Returns false (blocked) when the parser RAN and contradicted it:
 *   1. confident "none"        — questionType "none" at >= the confidence floor. Pre-existing
 *                                rule (the adf_ref_11422 replay miss); applies to ALL types,
 *                                money included, exactly as before.
 *   2. not an explicit request — the parser set `explicitRequest: false`, whatever questionType
 *                                it chose. NEW, and non-money types only.
 *
 * Returns true (allowed) when there is no parse at all (outage), or the parser did not
 * contradict the keyword — so every turn the parser calls a real request keeps today's answer.
 */
export function isVehicleFactKeywordFallbackAllowed(args: {
  parsed: VehicleFactQuestionParseLike | null | undefined;
  candidateQuestionType: string;
  minConfidence?: number;
}): boolean {
  const parsed = args.parsed;
  // Parser outage: the keyword fallback is the fail-safe. This is the case it exists for.
  if (!parsed) return true;

  const min = typeof args.minConfidence === "number" ? args.minConfidence : vehicleFactConfidenceMin();
  const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;

  // (1) A confident "none" suppresses the keyword fallback for every question type.
  if (parsed.questionType === "none" && confidence >= min) return false;

  // (2) The parser ran and said this turn is not a request for a fact. Believe it — but only
  //     for the non-money types; the money slice is held for approve-first review.
  if (parsed.explicitRequest === false && !MONEY_VEHICLE_FACT_QUESTION_TYPES.has(args.candidateQuestionType)) {
    return false;
  }

  return true;
}
