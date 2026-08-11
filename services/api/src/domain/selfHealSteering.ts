import { isEchoedInboundOpening, repeatsAQuestionFromHistory } from "./leadInGuards.js";
/**
 * What the draft-repair step is told when it rewrites a draft the quality judge held.
 *
 * MEASURED 2026-08-07 across 184 before/after repair pairs: **40 rewrites deleted the closing
 * question and only 15 added one** — 2.7 to 1 against the single thing the business is gated on.
 * 16 of the 40 were the appointment-time class that PR #605 closed from the judge's side. The other
 * 24 were plain qualifying questions, and their steering was EMPTY — nothing had asked for the
 * question's removal. The rewrite simply lost it, over and over turning an ask into a statement:
 *
 *   "Do you want me to line up delivery for mid next week?"
 *     -> "Once it's confirmed, I can line up mid-next-week delivery."
 *   "I'll have a sales manager call you today — what's the best number to reach you?"
 *     -> "If you want a call to go over details, I can ring you at <number> today."
 *   "...I can set that up for 5/29 for a Road Glide — do you have a motorcycle endorsement?"
 *     -> "...I can reserve a test-ride window once you confirm or answer any questions."
 *
 * Each leaves the customer with nothing to answer. Joe, 2026-08-07: "asking questions would really
 * be a way to control the flow of the conversation" — a repair that quietly drops the ask hands
 * that control back.
 *
 * WHY STEERING AND NOT A VETO. The obvious guard is to reject a rewrite that lost the question.
 * That returns `still_failing`, which makes the publish gate HOLD the draft — staff get nothing to
 * approve instead of a weaker draft, which is a worse trade. So this fixes the REPAIRER: it tells
 * the rewrite what the draft it is replacing was asking for, and lets it keep it.
 */

/** The closing ask of a draft: the last sentence, when the draft ends by asking something. */
export function extractClosingQuestion(draft: string): string | null {
  const text = String(draft ?? "")
    .replace(/\s*Reply STOP.*$/i, "")
    .trim();
  if (!text.endsWith("?")) return null;
  // Split on sentence ends, keeping the question mark. The last piece is the ask.
  const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const last = (parts[parts.length - 1] ?? "").trim();
  if (!last.endsWith("?") || last.length < 6) return null;
  return last.length > 220 ? last.slice(-220) : last;
}

export function buildSelfHealSteering(args: {
  original: string;
  judgeSteering: string;
  echoesInbound: boolean;
  /**
   * The draft asks a question we have already sent this customer VERBATIM (Joe, 2026-08-11 — measured
   * at 8% of active conversations). Unlike every other trigger, the fix here is NOT to keep the ask
   * as-is: it is to ask for the same thing in different words, so the steering below deliberately
   * overrides the "keep the ask" clause rather than sitting beside it.
   */
  repeatsOwnQuestion?: boolean;
}): string {
  const base = args.echoesInbound
    ? "Do NOT open by repeating the customer's own words back — rewrite the opening in your own words (e.g. 'Tomorrow after work works great —'), keeping the same meaning."
    : String(args.judgeSteering ?? "").trim();
  const ask = extractClosingQuestion(args.original);
  if (args.repeatsOwnQuestion) {
    const reword =
      (ask ? `You have already sent this customer that exact question ("${ask}"). ` : "You have already sent this customer that exact question. ") +
      "Ask for the SAME thing a different way — shorter, from another angle, or as a choice of two. " +
      "Do not repeat the sentence word for word, and do not drop the question: they must still be " +
      "left with something to answer.";
    return base ? `${base} ${reword}` : reword;
  }
  if (!ask) return base;
  // The judge's own complaint still wins: if the correction is ABOUT that question, the rewrite
  // must be free to change or drop it. Otherwise the ask survives the repair.
  const keep =
    `The draft you are replacing ended by asking: "${ask}" — unless the correction above is ` +
    "specifically about that question, your rewrite must ALSO end by asking for the same thing. " +
    "Rephrase it if you like, but do not turn it into a statement: the customer must be left with " +
    "something to answer.";
  return base ? `${base} ${keep}` : keep;
}

/**
 * The DETERMINISTIC self-heal triggers, in one place.
 *
 * The LLM judge misses two classes reliably, so each is caught by a rule instead:
 *  - `echoesInbound` — the reply parrots the customer's own opening words back (Joe, 2026-07-27).
 *  - `repeatsOwnQuestion` — the reply asks a question we have already sent this customer VERBATIM
 *    (Joe, 2026-08-11; measured at 8% of conversations touched in 45 days).
 *
 * Both only ever TRIGGER a re-draft — neither can hold or block a reply — which is the fail direction
 * that makes deterministic text rules acceptable here. `stillTriggered` answers the other half: a
 * judge-"good" re-roll that did not actually fix what fired is not a heal.
 */
export type SelfHealTriggers = { echoesInbound: boolean; repeatsOwnQuestion: boolean; any: boolean };

export function deterministicHealTriggers(args: {
  draft: string;
  inbound: string;
  history?: { direction: "in" | "out"; body: string }[] | null;
}): SelfHealTriggers {
  const echoesInbound = isEchoedInboundOpening(args.draft, args.inbound);
  const repeatsOwnQuestion = repeatsAQuestionFromHistory(args.draft, args.history);
  return { echoesInbound, repeatsOwnQuestion, any: echoesInbound || repeatsOwnQuestion };
}

export function stillTriggered(
  triggers: SelfHealTriggers,
  args: { draft: string; inbound: string; history?: { direction: "in" | "out"; body: string }[] | null }
): boolean {
  if (triggers.echoesInbound && isEchoedInboundOpening(args.draft, args.inbound)) return true;
  if (triggers.repeatsOwnQuestion && repeatsAQuestionFromHistory(args.draft, args.history)) return true;
  return false;
}
