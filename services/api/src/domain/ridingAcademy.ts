/**
 * Riding Academy ENROLLMENT lane (Joe, 2026-08-05).
 *
 * The rider-training school files an ADF when someone REGISTERS for a course:
 * `Source: Riding Academy - Enrolled` plus a machine enrollment record ("Enrollment Status:
 * Enrolled-Course: …-Class Start Date: …-Payment Status: …"). It is not a sales inquiry and it is
 * not prose — nobody typed it. The first two ever (Savannah Niver +13155211619, Donald Rawson
 * +17165344986, both 2026-08-04) each got the generic ADF opener, which quoted course pricing back
 * at two people who had already bought a seat.
 *
 * Joe's ruling: send an introduction, thank them, and say the agent is there to help with anything
 * about the course. The decision itself is `decideRidingAcademyTurn` (routeStateReducer, structured
 * routing off fixed ADF enum fields); the copy is `buildRidingAcademyEnrollmentAck` (agentVoice).
 * This module holds the REGEN-side gate so `index.ts` carries the call and not the reasoning —
 * per the source-size ratchet, new logic lands in `domain/`, never inline in the router.
 *
 * Pinned by `riding_academy_enrollment_ack:eval`.
 */
import { decideRidingAcademyTurn, decideNonBuyerSurveyTurn } from "./routeStateReducer.js";
import { buildRidingAcademyEnrollmentAck, buildNonBuyerSurveyAck } from "./agentVoice.js";

/** Which approved first-touch ack (if any) replaces the generic sales opener on an ADF lead. */
export type AdfFirstTouchAckKind =
  | "riding_academy_enrollment_ack"
  | "non_buyer_survey_ack"
  | "none";

/**
 * The shared "this regen target is the ADF FIRST touch" predicate: the event being regenerated is
 * the ADF submission itself AND the customer has not texted back yet. Extracted so the initial-ADF
 * overrides (non-buyer survey, riding-academy enrollment) test it ONE way instead of each carrying
 * its own copy of the same `messages.some(...)` scan.
 */
export function isAdfFirstTouchRegen(input: {
  provider?: string | null;
  messages?: unknown;
}): boolean {
  if (String(input.provider ?? "") !== "sendgrid_adf") return false;
  const messages = Array.isArray(input.messages) ? (input.messages as any[]) : [];
  return !messages.some(
    m => m?.direction === "in" && String(m?.provider ?? "").toLowerCase() === "twilio"
  );
}

/**
 * WHICH approved ack replaces the generic sales opener on an ADF FIRST touch — one ordered
 * decision instead of a chain of near-identical inline gates. The riding-academy enrollment wins
 * over the non-buyer survey ack: a course registration is the more specific fact about the lead,
 * and its reply is the one Joe wrote for it. The caller supplies `isAdfFirstTouch` (which already
 * folds in event_promo's precedence). Fail direction: anything unclear returns "none" and the turn
 * routes normally.
 */
export function resolveAdfFirstTouchAckKind(input: {
  isAdfFirstTouch: boolean;
  leadSource?: string | null;
  inquiry?: string | null;
  purchaseTimeframe?: string | null;
}): AdfFirstTouchAckKind {
  if (!input.isAdfFirstTouch) return "none";
  if (
    decideRidingAcademyTurn({ leadSource: input.leadSource, inquiry: input.inquiry }).kind ===
    "riding_academy_enrollment_ack"
  ) {
    return "riding_academy_enrollment_ack";
  }
  if (
    decideNonBuyerSurveyTurn({ purchaseTimeframe: input.purchaseTimeframe }).kind ===
    "non_buyer_survey_ack"
  ) {
    return "non_buyer_survey_ack";
  }
  return "none";
}

/** The approved copy for a resolved first-touch ack kind. */
export function buildAdfFirstTouchAck(
  kind: Exclude<AdfFirstTouchAckKind, "none">,
  args: { firstName: string | null; agentName: string; dealerName: string }
): string {
  return kind === "riding_academy_enrollment_ack"
    ? buildRidingAcademyEnrollmentAck(args.firstName, args.agentName, args.dealerName)
    : buildNonBuyerSurveyAck(args.firstName, args.agentName, args.dealerName);
}
