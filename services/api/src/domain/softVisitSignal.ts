import type { AppointmentTimingParse } from "./llmDraft.js";
import { visitCommitmentConfidenceMin, type VisitCommitmentParse } from "./visitCommitmentParser.js";

/**
 * Parser-driven soft-visit commitment signal (Todd Herian +15673079691, Ref 11438,
 * 2026-06-15: "Ok I will be there for the taste of country pre party on Saturday 👍").
 * The customer commits to coming in on a day/event WITHOUT booking a time — the
 * appointment-timing parser already classifies this as intent:none + requested.day +
 * normalizedText "committing to a ... visit" (the prompt rule keeps it `none` so the
 * soft-visit handler owns it). This makes the soft-visit cadence window parser-driven
 * instead of relying on the legacy `detectSoftVisitIntent` regex (which missed weekday /
 * event phrasings). Fail-safe: over-firing only DELAYS a follow-up (never sends wrong
 * content), and it is OR'd with the regex, so it strictly broadens recall.
 *
 * Pure (LLM parse is passed in) + dependency-light (type-only import of the parse shape)
 * so it is unit-testable without the LLM client — pinned by soft_visit_commitment:eval.
 */
// The one visit-commitment verb list, shared by the day-anchored and conditional signals.
// "be in" excludes "be in touch" — a contact deferral ("I'll be in touch Monday"), not a visit.
const VISIT_COMMITMENT_VERBS =
  /\b(?:commit|visit|see (?:you|ya|y'all)|be back|be there|be in(?!\s+touch)|get there|make it (?:in|out)|stop(?:ping)? (?:by|in)|com(?:e|ing) (?:in|by|out)|rid(?:e|ing) (?:up|in|over)|driv(?:e|ing) (?:up|in|over)|head(?:ing|ed)? (?:up|in|over)|swing(?:ing)? (?:by|in|up)|roll(?:ing)? (?:in|up|by)|pull(?:ing)? (?:in|up)|run(?:ning)? (?:up|in|by))\b/;

/**
 * The gates shared by the day-only and timed visit-commitment reads: the parser saw a
 * commitment (intent:none, no explicit request) anchored to a named DAY, and its own
 * normalizedText carries a visit verb. What separates the two is only whether a concrete
 * TIME came with it.
 */
function isDayAnchoredVisitCommitment(parse: AppointmentTimingParse | null | undefined): boolean {
  if (!parse) return false;
  if (parse.intent !== "none") return false; // actionable scheduling intents are handled by their own arms
  if (parse.explicitRequest) return false;
  if (!String(parse.requested?.day ?? "").trim()) return false; // must reference a committed day
  const nt = String(parse.normalizedText ?? "").toLowerCase();
  return VISIT_COMMITMENT_VERBS.test(nt);
}

function hasConcreteCommittedTime(parse: AppointmentTimingParse | null | undefined): boolean {
  return !!String(parse?.requested?.timeText ?? "").trim();
}

export function isParserSoftVisitCommitment(parse: AppointmentTimingParse | null | undefined): boolean {
  if (!parse) return false;
  if (parse.intent !== "none") return false; // actionable scheduling intents are handled by their own arms
  if (parse.explicitRequest) return false;
  if (!String(parse.requested?.day ?? "").trim()) return false; // must reference a committed day
  // A commitment that NAMED A TIME is not "soft" — see isParserTimedVisitCommitment. This
  // function is the DAY-ONLY read (the docblock above says so, and the sibling arrival-window
  // signal in index.ts already required an empty timeText); Terry Majchrzak +17166091289
  // ("I could be there today between 4 and 5", 2026-07-27) proved the omission: he was filed
  // as a loose "might stop by" and never reached the schedule, which staff reported.
  if (hasConcreteCommittedTime(parse)) return false;
  const nt = String(parse.normalizedText ?? "").toLowerCase();
  // Visit-commitment verbs in the parser's own normalizedText. The gate already requires
  // intent:none + a committed day + !explicitRequest, so an en-route arrival_update ("on my
  // way by 5:30") or an availability ask ("what's open Saturday") never reaches here — which
  // is why we can safely broaden past "come in" to the casual ride/drive/head-in phrasings
  // staff kept hand-fixing (Jessica Ornce "riding up there in the morning tomorrow", 2026-07-11).
  // "see you {day}" / "be back {day}" added 2026-07-19 (Joe ruling, Peter Meredith
  // +17168303999: "Sounds good see you Monday" fell through every recognizer and drew the
  // "I'll check that time and follow up" deflection — a day-only commitment is a SOFT
  // APPOINTMENT, never a time-check).
  return VISIT_COMMITMENT_VERBS.test(nt);
}

/**
 * TIMED visit commitment (Joe ruling 2026-07-28 — Terry Majchrzak +17166091289,
 * 2026-07-27 13:33Z: "I could be there today between 4 and 5").
 *
 * Same shape as the soft-visit commitment above — the parser reads it as intent:none with a
 * committed day and a visit verb in its normalizedText — EXCEPT the customer also named a
 * concrete time. That is a bookable commitment, not a loose "might stop by": Terry's turn drew
 * a warm "Ok See you then", a cadence hold and an outcome todo, but nothing ever reached the
 * calendar, and staff filed it as a miss the same morning.
 *
 * The caller routes this to the SAME book-or-offer resolver a proposed day+time uses
 * (`propose_booking`), so there is no new send behavior and no new arm — only the recognition
 * that a named time belongs on the schedule. The open-ended-bound veto still applies upstream
 * ("today after 3" offers slots, never books AT the bound — Kody +17163975098).
 *
 * Structured extraction over the PARSER's own output (AGENTS.md "comprehend, never regex").
 *
 * FAIL DIRECTION: a miss is exactly today's behavior (the soft-visit hold). An over-fire books
 * a customer who named a day and a time to come in — recoverable, staff-visible, and in suggest
 * mode a draft either way. Pinned by `soft_visit_commitment:eval` +
 * `scheduling_turn_decision:eval`.
 */
export function isParserTimedVisitCommitment(parse: AppointmentTimingParse | null | undefined): boolean {
  if (!isDayAnchoredVisitCommitment(parse)) return false;
  return hasConcreteCommittedTime(parse);
}

/**
 * Fail-safe HINT gate (eligibility only) for the conditional visit-commitment shape: does
 * the raw inbound look like it could carry "once <condition> I'll be in"? The
 * appointment-timing parser is hint-gated in both paths, and Michael's turn matched none
 * of the existing hint tokens ("be in" is not "be there"), so the parser never ran and the
 * comprehension below could never fire. This widens ELIGIBILITY only — comprehension stays
 * with the parser (AGENTS.md fallback policy: hint gates are the allowed deterministic
 * bucket). Fail direction: a hint miss = today's behavior (parser not consulted); an
 * over-trigger only costs one extra parser call.
 */
export function hasConditionalVisitCommitmentHintText(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!/\b(?:once|when|whenever|as soon as|after)\b/.test(t)) return false;
  return /\b(?:i'?ll|i\s+will|we'?ll|we\s+will|gonna|going\s+to)\s+(?:be\s+in\b(?!\s+touch)|come\s+(?:in|by|out)|stop\s+(?:by|in)|swing\s+(?:by|in)|make\s+it\s+(?:in|out)|head\s+(?:up|in|over)|ride\s+(?:up|in|over)|drive\s+(?:up|in|over))\b/.test(
    t
  );
}

/**
 * CONDITIONAL (day-less) visit commitment (Michael Siejka +17169906333, 2026-06-25:
 * "Beautiful thank you so much, currently cleaning the carbs on my bike but once she's
 * back on the road i'll be in."). The appointment-timing parser reads these correctly —
 * intent:none, no requested day, normalizedText like "will come in once bike is back on
 * the road" — but isParserSoftVisitCommitment requires a committed DAY, so the turn fell
 * through every recognizer and the generic orchestrator improvised (the corpus replay
 * judge flagged a photo-appreciation-flavored draft instead of a visit ack + patience).
 *
 * Same bucket as isParserSoftVisitCommitment: structured extraction over the PARSER's own
 * normalizedText (the parser comprehended the turn; this only reads its output — AGENTS.md
 * "comprehend, never regex"). Requires a visit-commitment verb AND a conditional/deferral
 * marker ("once/when/after/as soon as <condition>"), so a bare day-less "I'll come by"
 * (too vague) or "I'll let you know when I'm ready" (no visit verb) never fires.
 *
 * Fail direction: over-firing sends a warm no-rush ack + soft cadence cooldown (never a
 * booking, never a claim); a miss = today's improvised generic draft. Fail-safe.
 */
export function isParserConditionalVisitCommitment(
  parse: AppointmentTimingParse | null | undefined
): boolean {
  if (!parse) return false;
  if (parse.intent !== "none") return false; // actionable scheduling intents keep their own arms
  if (parse.explicitRequest) return false;
  if (String(parse.requested?.day ?? "").trim()) return false; // day-anchored commitments use isParserSoftVisitCommitment
  const nt = String(parse.normalizedText ?? "").toLowerCase();
  if (!VISIT_COMMITMENT_VERBS.test(nt)) return false;
  return /\b(?:once|when|whenever|as soon as|after)\b/.test(nt);
}

/**
 * ── THE SOFT-VISIT REFEREE ────────────────────────────────────────────────────────────────────
 * The ONE place that decides whether a turn arms the soft-visit cadence window, shared by
 * `/webhooks/twilio` and `/conversations/:id/regenerate`. Pure: every reading is passed in.
 *
 * It exists for two measured reasons (both 2026-08-14, live store, 1,910 inbound turns / 90d):
 *
 * 1. THE TWO PATHS DISAGREED. Live OR'd the legacy keyword rule with the parser signal; regen
 *    used the parser signal ALONE. The keyword rule fires on 45 turns/90d and the parser signal
 *    agrees on 5, so ~40 turns/90d armed a cadence hold on the live SMS lane that a regenerate
 *    would never arm — a two-path parity break against the CLAUDE.md non-negotiable. One referee,
 *    both paths, fixes that by construction.
 *
 * 2. A KEYWORD RULE WAS OVERRULING A PARSER VERDICT THAT EXISTED — what AGENTS.md
 *    "Fallback-vs-Parser Precedence" (Joe, 2026-08-06) forbids. Michelle Hyjek `+17163164854`
 *    told us she was out of town at a wedding and back Monday; the rule saw `come` + `monday`
 *    and produced a staff task claiming she had said she'd come in. See visitCommitmentParser.ts.
 *
 * THE TABLE, in order:
 *   - The parser signal fires (day-anchored or conditional)  → ARM, source `parser`.
 *   - The parser read an ACTIONABLE scheduling intent (`intent !== "none"`) → DO NOT arm, source
 *     `parser_actionable_intent`: that turn belongs to the booking/offer/arrival arms, and the
 *     keyword rule must not drag it sideways into a soft hold.
 *   - The keyword rule fires and a confident visit-commitment `no` came back → DO NOT arm,
 *     source `visit_parser_veto`. This is the ONLY suppression the new parser can cause.
 *   - The keyword rule fires and nothing contradicts it → ARM, source `legacy_regex`. This is the
 *     gap-fill the fallback policy allows, and it is what preserves the ~40 real commitments the
 *     day-anchored verb list misses ("I'll come this weekend", "going to stop up there tomorrow").
 *   - Nothing fires → DO NOT arm.
 *
 * FAIL DIRECTION: the veto is the only new way to LOSE a hold, and it needs an explicit `no`
 * above `visitCommitmentConfidenceMin()`. A disabled LLM, a missing key, an error, `unclear`, or
 * a hedged `no` all leave today's behaviour untouched. Nothing here can create a new send.
 * Pinned by `soft_visit_precedence:eval`.
 */
export type SoftVisitSource =
  | "parser"
  | "parser_actionable_intent"
  | "visit_parser_veto"
  | "legacy_regex"
  | "none";

export type SoftVisitDecision = {
  /** Arm the soft-visit cadence window (quiet window + dialog state + outcome todo). */
  arm: boolean;
  /** True only for the day-less "once she's back on the road I'll be in" shape. */
  conditional: boolean;
  source: SoftVisitSource;
};

export function resolveSoftVisitCommitment(input: {
  /** `detectSoftVisitIntent(inboundText)` — the legacy keyword rule. */
  legacySignal: boolean;
  /** The appointment-timing reading for this turn (null when the parser did not run). */
  parse: AppointmentTimingParse | null | undefined;
  /** Callers that must not take the conditional arm (a pending inventory watch owns the turn). */
  conditionalAllowed?: boolean;
  /** The tiebreaker reading — only ever consulted on a disputed turn (see resolver order). */
  visitCommitment?: VisitCommitmentParse | null;
}): SoftVisitDecision {
  if (isParserSoftVisitCommitment(input.parse)) {
    return { arm: true, conditional: false, source: "parser" };
  }
  if (input.conditionalAllowed !== false && isParserConditionalVisitCommitment(input.parse)) {
    return { arm: true, conditional: true, source: "parser" };
  }
  if (!input.legacySignal) return { arm: false, conditional: false, source: "none" };
  // A reading EXISTS and it is an actionable scheduling intent — its own arm owns this turn.
  if (input.parse && input.parse.intent !== "none") {
    return { arm: false, conditional: false, source: "parser_actionable_intent" };
  }
  const vc = input.visitCommitment;
  if (vc && vc.visit_commitment === "no" && vc.confidence >= visitCommitmentConfidenceMin()) {
    return { arm: false, conditional: false, source: "visit_parser_veto" };
  }
  return { arm: true, conditional: false, source: "legacy_regex" };
}

/**
 * Does this turn need the tiebreaker parse at all? Only when the keyword rule is about to decide
 * ALONE — the parser signal declined and there is no actionable intent to defer to. Keeps the
 * extra round-trip on ~40 turns/90d (about one every other day) instead of every turn.
 */
export function needsVisitCommitmentTiebreak(input: {
  legacySignal: boolean;
  parse: AppointmentTimingParse | null | undefined;
  conditionalAllowed?: boolean;
}): boolean {
  if (!input.legacySignal) return false;
  if (isParserSoftVisitCommitment(input.parse)) return false;
  if (input.conditionalAllowed !== false && isParserConditionalVisitCommitment(input.parse)) return false;
  if (input.parse && input.parse.intent !== "none") return false;
  return true;
}
