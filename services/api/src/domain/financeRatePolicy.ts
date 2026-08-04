/**
 * Finance-rate quoting policy — per-dealer, pure, fail-safe.
 *
 * Joe's ruling (2026-08-04, supersedes the 2026-08-03 design's two-mode sketch):
 *   "First I would explain only. If the customer pushes them off the rate floors, as low as 6.59
 *    on new and 8.79 on pre owned, but also mention there are sometimes promotional rates and the
 *    only way to know is to submit an application. We can send them the finance application link
 *    or invite them in."
 *
 * So the shape is THREE modes, not two — the default is a two-stage answer:
 *   - `explain_then_floor` (Joe's choice): first ask gets NO number, just the honest explanation
 *     that the rate comes out of the application. Only when the customer PRESSES for an actual
 *     number does the floor come out, and then always with the promo caveat + the application
 *     disclaimer + a next step (credit app link, or come in).
 *   - `quote_floor`: a dealer that wants the floor in the first reply.
 *   - `handoff`: a dealer that never quotes a rate. UNSET ⇒ this ⇒ today's behavior, so the
 *     mechanism can ship before any dealer fills in numbers.
 *
 * NOTE on the earlier "new bikes can never carry an APR" note: that was about H-D's NATIONAL
 * programs, which advertise new bikes as terms/payment and publish no new-bike APR. 6.59% is
 * AMERICAN'S OWN floor, which is the dealer's to quote. The two are not in conflict — this module
 * quotes the DEALER floor and never a national program rate.
 *
 * AGENTS.md bucket: the disclaimer is a COMPLIANCE/SAFETY gate and the floor lookup is STRUCTURED
 * EXTRACTION off a config file — both deterministic-allowed. Nothing here reads customer intent;
 * whether the customer is PRESSING for a number is comprehension and belongs in a typed parser
 * (see `decideFinanceRateAnswer`'s `customerPressedForNumber` input, which the caller supplies).
 *
 * FAIL DIRECTION, everywhere in this file: toward saying LESS about rates and MORE disclaimer.
 * An unset policy, an unparseable floor, or a stale `asOf` all resolve to "no number". A text we
 * cannot confidently clear gets the disclaimer appended rather than omitted. Over-disclaiming is
 * wordy; under-disclaiming is a compliance problem with Joe's name on it.
 */

export type FinanceRateMode = "explain_then_floor" | "quote_floor" | "handoff";

export type FinanceRatePolicy = {
  mode: FinanceRateMode;
  /** Dealer floor APR for NEW units, as a percent (6.59 = 6.59%). Null ⇒ never quote a new rate. */
  newFloorApr: number | null;
  /** Dealer floor APR for PRE-OWNED units, as a percent. Null ⇒ never quote a used rate. */
  usedFloorApr: number | null;
  /** Mention that promotional rates sometimes run and only an application reveals them. */
  promoNote: boolean;
  /** ISO day the floors were last confirmed by the finance desk. Null ⇒ treated as stale. */
  asOf: string | null;
  /** Suppress the assumed-APR payment calculator on rate/payment turns. */
  suppressCalculatorPaymentRange: boolean;
};

/**
 * How long a quoted floor stays quotable without being re-confirmed. Joe's own recommendation
 * ("use the number the finance desk quotes today, with an asOf date; the guard drops to no-number
 * when it goes stale"). A rate that drifted is worse than no rate.
 */
export const FINANCE_RATE_FLOOR_MAX_AGE_DAYS = 90;

/** The disclaimer Joe requires on ANY outbound that mentions a rate. */
export const FINANCE_RATE_APPLICATION_DISCLAIMER =
  "The only way to know your exact rate is to submit an application.";

const HANDOFF_POLICY: FinanceRatePolicy = {
  mode: "handoff",
  newFloorApr: null,
  usedFloorApr: null,
  promoNote: false,
  asOf: null,
  suppressCalculatorPaymentRange: false
};

function policyCandidates(profile: any): any[] {
  const policies = profile?.policies && typeof profile.policies === "object" ? profile.policies : {};
  return [policies.financeRates, policies.financeRate, policies.rates, profile?.financeRates];
}

function coerceApr(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(String(value ?? "").replace(/[%\s]/g, ""));
  if (!Number.isFinite(n)) return null;
  // Accept either 6.59 or 0.0659; reject anything outside a sane consumer-lending band so a typo
  // (659) can never reach a customer.
  const pct = n > 0 && n < 1 ? n * 100 : n;
  if (pct <= 0 || pct > 36) return null;
  return Math.round(pct * 100) / 100;
}

function coerceMode(value: unknown): FinanceRateMode | null {
  const t = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (t === "explain_then_floor" || t === "explain_first" || t === "explain_then_quote") {
    return "explain_then_floor";
  }
  if (t === "quote_floor" || t === "quote" || t === "floor") return "quote_floor";
  if (t === "handoff" || t === "explain_only" || t === "none") return "handoff";
  return null;
}

/** Is an `asOf` day recent enough to still quote from? Null/unparseable/future-dated ⇒ false. */
export function isFinanceRateFloorFresh(asOf: string | null | undefined, nowMs: number): boolean {
  const t = String(asOf ?? "").trim();
  if (!t) return false;
  const parsed = Date.parse(t.length <= 10 ? `${t}T00:00:00.000Z` : t);
  if (!Number.isFinite(parsed)) return false;
  const ageMs = nowMs - parsed;
  if (ageMs < -86_400_000) return false; // dated in the future ⇒ not a real confirmation
  return ageMs <= FINANCE_RATE_FLOOR_MAX_AGE_DAYS * 86_400_000;
}

/**
 * Read the dealer's policy. Unset/malformed ⇒ `handoff` (today's behavior, zero change), which is
 * what lets the mechanism ship ahead of any dealer filling in numbers.
 */
export function resolveFinanceRatePolicy(profile: any): FinanceRatePolicy {
  for (const candidate of policyCandidates(profile)) {
    if (!candidate || typeof candidate !== "object") continue;
    const mode = coerceMode(candidate.mode);
    if (!mode) continue;
    return {
      mode,
      newFloorApr: coerceApr(candidate.new?.floorApr ?? candidate.newFloorApr),
      usedFloorApr: coerceApr(
        candidate.used?.floorApr ?? candidate.usedFloorApr ?? candidate.preOwned?.floorApr
      ),
      promoNote: candidate.promoNote !== false,
      asOf: typeof candidate.asOf === "string" && candidate.asOf.trim() ? candidate.asOf.trim() : null,
      suppressCalculatorPaymentRange: candidate.suppressCalculatorPaymentRange !== false
    };
  }
  return HANDOFF_POLICY;
}

/**
 * The quotable floor for a unit condition, or null. Null whenever the policy is handoff, the floor
 * is missing/insane, or the `asOf` has gone stale.
 *
 * UNKNOWN CONDITION QUOTES NOTHING. `leadUnitConditionForOfferMatch` treats unknown as *used* —
 * right for "should we send a promo", backwards here, because used carries the HIGHER floor and
 * quoting it to a new-bike shopper misstates their rate in the direction that loses the deal.
 */
export function financeRateFloorFor(
  policy: FinanceRatePolicy,
  condition: "new" | "used" | null | undefined,
  nowMs: number
): number | null {
  if (policy.mode === "handoff") return null;
  if (!isFinanceRateFloorFresh(policy.asOf, nowMs)) return null;
  if (condition === "new") return policy.newFloorApr;
  if (condition === "used") return policy.usedFloorApr;
  return null;
}

export function formatAprPercent(apr: number): string {
  // 6.59 -> "6.59%", 7 -> "7%" (never "7.00%", which reads like a quoted contract rate)
  const rounded = Math.round(apr * 100) / 100;
  return `${String(rounded)}%`;
}

// ---------------------------------------------------------------------------
// THE INVARIANT: any outbound that mentions a rate carries the application disclaimer.
//
// This is the half that fixes something ALREADY going out the door — measured 2026-08-03, of 54
// live outbound messages that mention a rate, 43 carry no qualifier at all ("we can finance used
// Harleys starting around 7.29% APR", "Financing as low as 2.99%").
// ---------------------------------------------------------------------------

/**
 * Does this text quote a finance RATE? Deliberately narrow: a percentage adjacent to rate/APR
 * language, or an explicit "as low as X%". A bare "%" (a discount, a trade percentage) is not a
 * rate and must not trigger the disclaimer, or every promo text grows a finance sentence.
 *
 * Compliance gate ⇒ deterministic is correct per AGENTS.md. This inspects OUR OWN outbound copy,
 * never customer intent.
 */
export function mentionsFinanceRate(text?: string | null): boolean {
  const t = String(text ?? "");
  if (!t.trim()) return false;
  const pct = /\d+(?:\.\d+)?\s*%/;
  if (!pct.test(t)) return false;
  return /\b(apr|interest rate|rate|financ\w*|as low as)\b/i.test(t);
}

/** Does the text already tell the customer an application decides the exact rate? */
export function hasRateApplicationDisclaimer(text?: string | null): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  const application = /\b(applicat\w+|credit app\b|apply|pre[-\s]?qualif\w*|submit.{0,20}\bapp\b)/.test(t);
  if (!application) return false;
  return /\b(exact|actual|your rate|final rate|know your|depends|determine\w*|qualify|based on)\b/.test(t);
}

/**
 * Append the disclaimer to any rate-quoting text that lacks it. Idempotent; returns the text
 * unchanged when no rate is mentioned or the disclaimer is already there.
 */
export function enforceFinanceRateDisclaimer(text?: string | null): string {
  const t = String(text ?? "");
  if (!mentionsFinanceRate(t)) return t;
  if (hasRateApplicationDisclaimer(t)) return t;
  const trimmed = t.replace(/\s+$/, "");
  const joiner = /[.!?]$/.test(trimmed) ? " " : ". ";
  return `${trimmed}${joiner}${FINANCE_RATE_APPLICATION_DISCLAIMER}`;
}

// ---------------------------------------------------------------------------
// The two answer arms.
// ---------------------------------------------------------------------------

export type FinanceRateAnswerArm = "explain_only" | "quote_floor" | "handoff";

/**
 * Which arm does this turn get? PURE — the caller supplies `customerPressedForNumber`, which is
 * COMPREHENSION and must come from a typed parser, never from keyword matching here.
 *
 * FAIL DIRECTION: anything uncertain lands on `explain_only`, which quotes no number. The worst
 * case is a customer who wanted a figure getting an honest explanation plus a next step.
 */
export function decideFinanceRateAnswer(input: {
  policy: FinanceRatePolicy;
  condition: "new" | "used" | null | undefined;
  customerPressedForNumber: boolean;
  nowMs: number;
}): { arm: FinanceRateAnswerArm; floorApr: number | null; reason: string } {
  const { policy } = input;
  if (policy.mode === "handoff") return { arm: "handoff", floorApr: null, reason: "policy_handoff" };
  const floor = financeRateFloorFor(policy, input.condition, input.nowMs);
  if (floor == null) {
    const reason = !isFinanceRateFloorFresh(policy.asOf, input.nowMs)
      ? "floor_stale"
      : input.condition == null
        ? "condition_unknown"
        : "no_floor_configured";
    return { arm: "explain_only", floorApr: null, reason };
  }
  if (policy.mode === "quote_floor") return { arm: "quote_floor", floorApr: floor, reason: "policy_quote_floor" };
  if (input.customerPressedForNumber) {
    return { arm: "quote_floor", floorApr: floor, reason: "customer_pressed" };
  }
  return { arm: "explain_only", floorApr: null, reason: "first_ask_explains" };
}

/**
 * The next step Joe named: the credit app link, or come in.
 *
 * Joe, 2026-08-04: "the agent should offer a time to schedule not just stop in." A vague "stop in"
 * asks the customer to do the work of picking a moment; a booking link hands them real availability.
 *
 * WHY `mayOfferTime` IS AN INPUT AND NOT DECIDED HERE: how often we may ask a lead to come in is
 * owned by ONE referee, `decideScheduleInviteBudget` (routeStateReducer, PR #493) — it caps at 3 and
 * latches `scheduleMuted` after. Deciding it locally would be the fourth place asking the same
 * question on the same counter, which is the exact re-stacking the un-stack loop exists to prevent.
 * The caller asks the referee and passes the answer down. This module never writes the counter
 * either: a booking link inside a finance answer the customer ASKED for is not a fresh proactive
 * invite, so it reads the budget without spending it.
 *
 * FAIL DIRECTION: no booking URL, or a spent/muted budget, falls back to today's "stop in" wording —
 * we never invent a link and never pester someone who has already ignored three invitations.
 */
export type FinanceNextStepOptions = {
  /** From decideScheduleInviteBudget: is there still room to ask this lead to come in? */
  mayOfferTime?: boolean;
  /** dealerProfile.bookingUrl — real availability, so the customer picks a slot that exists. */
  bookingUrl?: string | null;
};

function buildNextStepLine(
  creditAppUrl?: string | null,
  opts?: FinanceNextStepOptions
): string {
  const url = String(creditAppUrl ?? "").trim();
  const booking = String(opts?.bookingUrl ?? "").trim();
  const timeOffer =
    opts?.mayOfferTime && booking
      ? `If you'd rather do it in person, you can grab a time here: ${booking}.`
      : opts?.mayOfferTime
        ? "If you'd rather do it in person, what day works for you and I'll get you on the schedule?"
        : "Or stop in and we'll run it with you.";
  if (url) return `You can start the application here: ${url}. ${timeOffer}`;
  return `I can send you the application. ${timeOffer}`;
}

/**
 * The FIRST answer: no number, just the honest reason and a next step. Deliberately does NOT
 * mention a percentage, so the disclaimer invariant has nothing to attach to.
 */
export function buildFinanceRateExplainReply(
  args?: { creditAppUrl?: string | null } & FinanceNextStepOptions
): string {
  return (
    "I don't want to quote you a rate that isn't real — yours comes out of the credit application, " +
    `so anything I put in a text now would be a guess. ${buildNextStepLine(args?.creditAppUrl, args)}`
  );
}

/**
 * The PUSHED answer: the floor, the promo caveat, the application disclaimer, and a next step.
 * Always run through `enforceFinanceRateDisclaimer` by construction (the disclaimer is inline),
 * so this text is compliant on its own.
 */
export function buildFinanceRateFloorReply(args: {
  floorApr: number;
  condition: "new" | "used";
  promoNote: boolean;
  creditAppUrl?: string | null;
} & FinanceNextStepOptions): string {
  const unit = args.condition === "new" ? "new" : "pre-owned";
  const promo = args.promoNote
    ? " There are promotional rates that run sometimes too, so it's worth checking."
    : "";
  return (
    `Our rates on ${unit} bikes start as low as ${formatAprPercent(args.floorApr)} APR for well-qualified buyers.` +
    `${promo} ${FINANCE_RATE_APPLICATION_DISCLAIMER} ${buildNextStepLine(args.creditAppUrl, args)}`
  );
}

/**
 * The APR band the payment calculator should run on.
 *
 * Joe, 2026-08-04: "I want the range based off the numbers in the calculator" — the payment RANGE
 * stays; what changes is where its rates come from. `buildMonthlyPaymentLine` (orchestrator.ts)
 * hardcoded its own band — 6–8% new, 8–9% used — and rendered the result as "based on your APR".
 * Those rates were never the dealer's. Now the LOW end is the dealer's real floor, so the bottom of
 * every quoted range is a rate American actually offers.
 *
 * The spread above the floor preserves today's band WIDTH (2 points new, 1 point used) so the
 * output stays a genuine range rather than collapsing to a single number — the same reason the
 * endpoints are rounded outward (Ryan Tower, LEA-238).
 *
 * Returns null when there is no quotable floor (policy unset, stale `asOf`, or no number for this
 * condition). FAIL DIRECTION: null means the caller keeps TODAY's behavior exactly — this can never
 * make the calculator worse than it already is.
 */
const CALCULATOR_SPREAD_POINTS_NEW = 2;
const CALCULATOR_SPREAD_POINTS_USED = 1;

export function resolveCalculatorAprBand(
  policy: FinanceRatePolicy,
  isUsed: boolean,
  nowMs: number
): { minApr: number; maxApr: number } | null {
  const floor = financeRateFloorFor(policy, isUsed ? "used" : "new", nowMs);
  if (floor == null) return null;
  const spread = isUsed ? CALCULATOR_SPREAD_POINTS_USED : CALCULATOR_SPREAD_POINTS_NEW;
  // Round away binary-float noise (8.79 / 100 = 0.08789999999999999) so the band is exactly the
  // rate the dealer typed — these values are compared and logged, not just amortized.
  const toRate = (pct: number) => Math.round((pct / 100) * 1e6) / 1e6;
  return { minApr: toRate(floor), maxApr: toRate(floor + spread) };
}

/**
 * The disclaimer line appended to a payment range. The range is DERIVED from a rate, so it carries
 * the same obligation as quoting one outright — even though it never prints a percentage (which is
 * why `mentionsFinanceRate` alone would not catch it).
 */
export function buildPaymentRangeDisclaimerLine(
  creditAppUrl?: string | null,
  opts?: FinanceNextStepOptions
): string {
  return `That's off our best rate — ${FINANCE_RATE_APPLICATION_DISCLAIMER.charAt(0).toLowerCase()}${FINANCE_RATE_APPLICATION_DISCLAIMER.slice(
    1
  )} ${buildNextStepLine(creditAppUrl, opts)}`;
}
