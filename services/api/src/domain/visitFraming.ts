/**
 * Phantom-visit guard — the single biggest "answering out of context" cluster in production (a
 * full-store sweep found 19+ conversations / 25+ AI drafts asserting "thanks again for coming in /
 * for the test ride / coming to see us" on leads where NO physical visit happened). The framing was
 * hardcoded into four draft builders (buildDealerLeadAppPostRideReply ×2, buildDealerRideOutcomeCustomerDraft,
 * the post-sale cadence) regardless of whether the customer actually came in.
 *
 * KEY LESSON (Steven Knighton + 5 others): `sold` / credit-app / post-sale do NOT imply a physical
 * visit — HDFS online deals get "thanks for coming to see us" with no visit. So the confirmed-visit
 * signal must key on an ACTUAL visit: a SHOWED appointment/ride outcome, a walk-in, or the customer's
 * own words — never the sale flag.
 *
 * This module is the pure decision (visit confirmed?) + the dark flag. Fail-direction is safe: when
 * unsure it returns false (no visit), so a draft falls back to a visit-neutral intro rather than
 * fabricating a visit. Ships DARK behind PHANTOM_VISIT_GUARD (the live context-fidelity hold already
 * backstops these drafts; this fixes them at the source so the customer gets a correct initial touch).
 */

import { extractDealerLeadAppDemoBikeLabel } from "./workflowRegressionGuards.js";

/** Customer's own words that confirm they physically came in / completed a ride. */
const CUSTOMER_CONFIRMED_VISIT =
  /\b(i (stopped|came) (in|by)|stopped in|came in (today|yesterday|earlier)|was (in|there) (today|yesterday)|test ?rode|test ?drove|rode it|came down|made it in)\b/i;

/**
 * Did the customer physically visit / complete a ride? Precise by design — a SHOWED appointment-or-ride
 * outcome (sold/hold imply showed), a walk-in, or the customer saying so. A merely-booked appointment,
 * a sale, a credit app, or a post-sale state are NOT visits (the Knighton class). Pure.
 */
export function customerVisitConfirmed(conv: any): boolean {
  const outcome = conv?.appointment?.staffNotify?.outcome ?? null;
  const primary = String(outcome?.primaryStatus ?? "").trim().toLowerCase();
  const status = String(outcome?.status ?? "").trim().toLowerCase();
  if (primary === "showed" || status === "showed" || status === "showed_up") return true;

  if (String(conv?.dialogState?.name ?? "") === "walk_in_active") return true;
  if (/walk[\s_-]*in|traffic log pro|dealership visit/i.test(String(conv?.lead?.source ?? ""))) return true;

  const msgs = Array.isArray(conv?.messages) ? conv.messages : [];
  if (msgs.some((m: any) => m?.direction === "in" && CUSTOMER_CONFIRMED_VISIT.test(String(m?.body ?? "")))) return true;

  return false;
}

/**
 * Did the DEALER's own Dealer Lead App record name a specific bike this customer rode?
 *
 * This is the dealership's structured post-interaction log, filled in by the salesperson — the
 * "Demo Bikes Ridden" field. It is actively curated, not an echo of the interest model: across the
 * live store 17 of 75 Dealer Lead App leads name a DIFFERENT bike than the one the customer said
 * they were interested in, and 6 say "None recorded." (which extractDealerLeadAppDemoBikeLabel
 * already resolves to null). So a named bike here is real evidence a ride happened.
 *
 * Read scope is deliberately narrow: the lead comment plus INBOUND message bodies only. Never our
 * own outbound — an agent draft that mentions a ride must not become the evidence that the ride
 * happened (the "read our own words back as the customer's" class).
 *
 * NOTE this is evidence for the JUDGE's anchor, NOT a visit-confirmation for the draft builders:
 * customerVisitConfirmed deliberately does not consult it, because flipping it there would newly
 * assert "thanks again for coming in" on ~49 live leads — expansion in the unsafe direction, which
 * needs its own slice and its own canary. Pure.
 */
/**
 * ⭐ WHY THIS EXISTS RATHER THAN A WIDER `customerVisitConfirmed` (ruling 31, 2026-08-06, upheld
 * 2026-08-11). Widening the shared predicate was MEASURED at **49 live leads** flipping false→true,
 * newly asserting "thanks again for coming in" across FOUR draft builders — unsafe, and still is.
 *
 * On 2026-08-11 Joe supplied the fact that ruling was missing: **"Dealer lead app are walk ins."**
 * So a Dealer Lead App lead carrying the salesperson's own `Demo Bikes Ridden` really has been in,
 * and the walk-in first-touch builder composes THIS narrow predicate with the shared one instead of
 * widening the shared one. Measured on the live store: 49 of 66 name a real bike, 2 say "None
 * recorded", 15 have no field — and 17 name a DIFFERENT bike than the interest model, which is what
 * proves the field is curated by a person rather than echoing the lead.
 *
 * It reads the lead comment and INBOUND messages ONLY. Our own outbound must never become the
 * evidence, or the agent can talk itself into a visit that never happened.
 */
export function dealerRecordedDemoRide(conv: any): boolean {
  const msgs = Array.isArray(conv?.messages) ? conv.messages : [];
  const text = [
    conv?.lead?.comment,
    conv?.latestLead?.comment,
    ...msgs.filter((m: any) => m?.direction === "in").map((m: any) => m?.body)
  ]
    .filter(Boolean)
    .join("\n");
  return !!extractDealerLeadAppDemoBikeLabel(text);
}

/** A recorded dealer-ride / appointment OUTCOME implies the customer showed (you can only sell/hold/
 *  decline-finance after they came in for the ride). Used by the outcome-draft builder, which has the
 *  outcome in hand. `did_not_show` / `cancelled` are NOT a visit. */
export function rideOutcomeImpliesVisit(primaryStatus?: string | null, secondaryStatus?: string | null, legacy?: string | null): boolean {
  const p = String(primaryStatus ?? "").trim().toLowerCase();
  if (p === "showed" || p === "showed_up") return true;
  const s = String(secondaryStatus ?? "").trim().toLowerCase();
  const l = String(legacy ?? "").trim().toLowerCase();
  return ["sold", "hold", "finance_not_approved", "financing_declined"].some(k => s === k || l === k);
}

/** Reads PHANTOM_VISIT_GUARD. Default OFF (dark) — the live cutover is approve-first. When off, the
 *  builders keep their original (phantom) intro, identical to today. */
export function phantomVisitGuardEnabled(): boolean {
  const raw = String(process.env.PHANTOM_VISIT_GUARD ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Output repair for the LLM generator (the builders use customerVisitConfirmed at construction; the
 * LLM-composed draft can still FABRICATE a visit — Tim Williams, 6/25: a fresh ADF lead got "thanks
 * again for coming in for the test ride … congrats on the Street Glide 3 Limited", which the
 * context-fidelity judge HELD). When the customer has NOT actually visited, rewrite a phantom
 * "thanks for coming in / for the test ride" into a visit-neutral interest line and drop a fabricated
 * purchase "congrats". Reads OUR OWN draft text (an output guard, not customer-intent comprehension) +
 * the structured visit signal; fail-direction safe (when a visit IS confirmed, the text is untouched).
 * Pure.
 */
export function stripPhantomVisitFraming(text: string, conv: any): string {
  const src = String(text ?? "");
  if (!src.trim() || customerVisitConfirmed(conv)) return src;
  let out = src;
  // "Thanks (again) for coming in for the test ride (on the <model>)." → "Thanks for your interest in the <model>."
  out = out.replace(
    /\bthank(?:s| you)(?: again)? for coming (?:in|by|down) for (?:the |a |another )?(?:test ride|ride|demo)(?:\s+on)?\s*(?:the |your )?([^.!?]*?)\s*([.!?])/gi,
    (_m, model, end) => (model && model.trim() ? `Thanks for your interest in the ${model.trim()}${end}` : `Thanks for your interest${end}`)
  );
  // Generic phantom-visit thanks ("for coming in / stopping in / coming to see us …") → "Thanks for reaching out."
  out = out.replace(
    /\bthank(?:s| you)(?: again)? for (?:coming (?:in|by|down)|stopping (?:in|by)|coming to see us|making it in)\b[^.!?]*([.!?])/gi,
    (_m, end) => `Thanks for reaching out${end}`
  );
  // Fabricated purchase congrats ("congrats on the/your/getting <X>.") — no confirmed sale → drop it.
  out = out.replace(/\bcongrat(?:s|ulations)?\b[^.!?]*\bon\b[^.!?]*[.!?]\s*/gi, "");
  return out.replace(/\s{2,}/g, " ").replace(/\s+([.!?])/g, "$1").trim();
}

/**
 * The walk-in first touch's closing ask (Joe, 2026-08-11: *"The first message should be a little more
 * loose with timing. It should say something like want to set up a time to stop in and check it out?
 * Then continue the ladder from there."*).
 *
 * SOFT ON PURPOSE — no day, no clock time. The concrete slot comes on their reply, where the
 * scheduling flow already owns it. Measured reason it must be soft: of 66 Dealer Lead App leads only
 * **6** said they were buying inside 3 months, **15** said "Not Sure" and **8** said no. A hard
 * "Saturday at 4:30?" is the wrong push for most of this lane.
 *
 * `alreadyVisited` changes the WORDS, not the pressure: 49 of those 66 already rode a bike here, and
 * inviting someone to "come check it out" after they rode it reads as if we were not paying
 * attention. They get "stop BACK in" instead.
 *
 * Replaces the old passive endings ("if any questions come up, just text me anytime"), which were
 * measured asking nothing on 35 of 37 first touches in this lane.
 */
export function buildWalkInSoftTimingAsk(alreadyVisited: boolean, inStock: boolean): string {
  if (alreadyVisited) return " Want to set up a time to stop back in and go over it?";
  return inStock
    ? " It's in stock — want to set up a time to stop in and check it out?"
    : " Want to set up a time to stop in and check it out?";
}
