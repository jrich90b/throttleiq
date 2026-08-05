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
import {
  decideRidingAcademyTurn,
  decideNonBuyerSurveyTurn,
  decideJumpstartInviteTurn
} from "./routeStateReducer.js";
import {
  buildRidingAcademyEnrollmentAck,
  buildNonBuyerSurveyAck,
  buildJumpstartOneOnOneInvite,
  buildJumpstartRegistrationInvite,
  buildUnpaidSeatLine
} from "./agentVoice.js";
import {
  readFirstTimeRiderPolicy,
  readEnrollmentCourseName,
  readEnrollmentRidingHistory,
  enrollmentSeatIsUnpaid
} from "./firstTimeRiderPolicy.js";

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
  provider?: string | null;
  messages?: unknown;
  eventPromoKind?: string | null;
  leadSource?: string | null;
  inquiry?: string | null;
  purchaseTimeframe?: string | null;
}): { isAdfFirstTouch: boolean; kind: AdfFirstTouchAckKind } {
  const isAdfFirstTouch =
    isAdfFirstTouchRegen({ provider: input.provider, messages: input.messages }) &&
    String(input.eventPromoKind ?? "") !== "event_promo_ack";
  if (!isAdfFirstTouch) return { isAdfFirstTouch, kind: "none" };
  if (
    decideRidingAcademyTurn({ leadSource: input.leadSource, inquiry: input.inquiry }).kind ===
    "riding_academy_enrollment_ack"
  ) {
    return { isAdfFirstTouch, kind: "riding_academy_enrollment_ack" };
  }
  if (
    decideNonBuyerSurveyTurn({ purchaseTimeframe: input.purchaseTimeframe }).kind ===
    "non_buyer_survey_ack"
  ) {
    return { isAdfFirstTouch, kind: "non_buyer_survey_ack" };
  }
  return { isAdfFirstTouch, kind: "none" };
}

/** The approved copy for a resolved first-touch ack kind. */
export function buildAdfFirstTouchAck(
  kind: Exclude<AdfFirstTouchAckKind, "none">,
  args: {
    firstName: string | null;
    agentName: string;
    dealerName: string;
    jumpstartInvite?: string;
    registrationNote?: string;
    unpaidSeatLine?: string;
  }
): string {
  return kind === "riding_academy_enrollment_ack"
    ? buildRidingAcademyEnrollmentAck(args.firstName, args.agentName, args.dealerName, {
        registrationNote: args.registrationNote,
        unpaidSeatLine: args.unpaidSeatLine,
        jumpstartInvite: args.jumpstartInvite
      })
    : buildNonBuyerSurveyAck(args.firstName, args.agentName, args.dealerName);
}

/**
 * The Jumpstart offer for a RIDING ACADEMY REGISTRATION, or "" when it does not apply (Joe,
 * 2026-08-05). One place, so the live intake and the regen path cannot drift: read the store's
 * capability and the enrollment record's own course/history fields, ask the reducer, and return
 * either the approved sentence or nothing.
 *
 * FAIL DIRECTION unchanged from the reducer: no Jumpstart in the profile, or no plain beginner
 * signal, ⇒ "" ⇒ the registration reply is exactly the intro Joe approved, byte for byte.
 */
export function resolveEnrollmentJumpstartInvite(dealerProfile: any, inquiry?: string | null): string {
  const policy = readFirstTimeRiderPolicy(dealerProfile);
  const decision = decideJumpstartInviteTurn({
    dealerHasJumpstart: policy.jumpstartEnabled,
    enrolledCourse: readEnrollmentCourseName(inquiry),
    ridingHistory: readEnrollmentRidingHistory(inquiry)
  });
  return decision.kind === "jumpstart_one_on_one_invite" ? buildJumpstartOneOnOneInvite() : "";
}

/**
 * Everything the registration reply adds beyond the intro, resolved in ONE place so the live
 * intake and the regen path cannot drift: the dealer's e-course note, the unpaid-seat line, and
 * the (short) Jumpstart offer. The ack itself enforces "unpaid OR Jumpstart, never both".
 *
 * Every piece is blank-by-default: an unconfigured dealer gets the plain intro, unchanged.
 */
export function resolveEnrollmentAckExtras(
  dealerProfile: any,
  inquiry?: string | null
): { registrationNote: string; unpaidSeatLine: string; jumpstartInvite: string } {
  const policy = readFirstTimeRiderPolicy(dealerProfile);
  const jumpstart =
    decideJumpstartInviteTurn({
      dealerHasJumpstart: policy.jumpstartEnabled,
      enrolledCourse: readEnrollmentCourseName(inquiry),
      ridingHistory: readEnrollmentRidingHistory(inquiry)
    }).kind === "jumpstart_one_on_one_invite"
      ? buildJumpstartRegistrationInvite()
      : "";
  return {
    registrationNote: policy.registrationNote,
    unpaidSeatLine: enrollmentSeatIsUnpaid(inquiry)
      ? buildUnpaidSeatLine(policy.unpaidSeatPaymentMethods)
      : "",
    jumpstartInvite: jumpstart
  };
}
