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
  buildRidingAcademyWaitlistAck,
  buildRidingAcademyWaitlistToEnrolledAck,
  buildRidingAcademyCompletionAck,
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
  | "riding_academy_waitlist_ack"
  | "riding_academy_waitlist_to_enrolled_ack"
  | "riding_academy_completion_ack"
  | "riding_academy_unknown_status"
  | "non_buyer_survey_ack"
  | "none";

/**
 * The status the school last told us this person was in — read off the PREVIOUS enrollment record on
 * the thread, never off anything the customer wrote. `decideRidingAcademyTurn` needs it to tell "you
 * are enrolled" (a first record) from "a seat opened up" (wait list, then enrolled), and it has to be
 * supplied by the caller so the reducer stays pure.
 *
 * The lead's own `source`/`inquiry` are overwritten by the NEWEST record, so this history exists only
 * in the message rows. Walks the inbound ADF rows and returns the most recent status that is not the
 * record being answered right now.
 */
export function readPriorRidingAcademyStatus(input: {
  messages?: unknown;
  excludeProviderMessageId?: string | null;
}): string | null {
  const rows = Array.isArray(input?.messages) ? (input.messages as any[]) : [];
  const exclude = String(input?.excludeProviderMessageId ?? "").trim();
  const adfs = rows.filter(
    m =>
      m?.direction === "in" &&
      String(m?.provider ?? "") === "sendgrid_adf" &&
      String(m?.body ?? "").trim()
  );
  // Drop the record being answered: by id when we have one, otherwise the newest row (the event is
  // appended before the draft is composed).
  const prior = exclude
    ? adfs.filter(m => String(m?.providerMessageId ?? "") !== exclude)
    : adfs.slice(0, -1);
  for (let i = prior.length - 1; i >= 0; i -= 1) {
    const body = String(prior[i]?.body ?? "");
    const recorded = body.match(/\benrollment status:\s*([^-\n]+)/i);
    if (recorded?.[1]) return recorded[1].trim().toLowerCase();
    const suffix = body.match(/\briding academy\s*[-–]\s*(.+)$/im);
    if (suffix?.[1]) return suffix[1].trim().toLowerCase();
  }
  return null;
}

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
  const academy = decideRidingAcademyTurn({
    leadSource: input.leadSource,
    inquiry: input.inquiry,
    // A SECOND record from the school is news about her status, not a customer reply — so the
    // transition (wait list -> a seat) has to be visible here too, or regen would answer Maya's
    // "Enrolled" notice as if it were her first.
    priorStatus: readPriorRidingAcademyStatus({ messages: input.messages })
  });
  if (academy.kind !== "none") {
    return { isAdfFirstTouch, kind: academy.kind };
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
    course?: string | null;
    startDate?: string | null;
    /** False once the customer has genuinely RECEIVED something from us (Joe, 2026-08-07). */
    introduce?: boolean;
  }
): string {
  if (kind === "riding_academy_waitlist_to_enrolled_ack") {
    return buildRidingAcademyWaitlistToEnrolledAck(args.firstName, args.agentName, args.dealerName, {
      course: args.course,
      startDate: args.startDate,
      registrationNote: args.registrationNote,
      introduce: args.introduce
    });
  }
  if (kind === "riding_academy_completion_ack") {
    return buildRidingAcademyCompletionAck(args.firstName, args.agentName, args.dealerName, {
      course: args.course,
      introduce: args.introduce
    });
  }
  if (kind === "riding_academy_enrollment_ack") {
    return buildRidingAcademyEnrollmentAck(args.firstName, args.agentName, args.dealerName, {
      registrationNote: args.registrationNote,
      unpaidSeatLine: args.unpaidSeatLine,
      jumpstartInvite: args.jumpstartInvite
    });
  }
  if (kind === "riding_academy_waitlist_ack") {
    // No seat yet, so no registration note and no unpaid-seat line — both are about a seat he does
    // not have. The Jumpstart stays, as an offer.
    return buildRidingAcademyWaitlistAck(args.firstName, args.agentName, args.dealerName, {
      course: args.course,
      startDate: args.startDate,
      jumpstartInvite: args.jumpstartInvite
    });
  }
  return buildNonBuyerSurveyAck(args.firstName, args.agentName, args.dealerName);
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

/**
 * Did the CUSTOMER ask to try the Jumpstart before their course?
 *
 * The explicit words always count. The looser reading — a Riding Academy mention plus
 * "prior / before / prep / practice / experience" — is written for customer PROSE, and it must not
 * be run against a Riding Academy enrollment record, because that record is a form and its FIELD
 * LABELS satisfy it on their own:
 *
 *   Enrollment Status: Wait List-Course: New Rider Course - eCourse + Range-Class Start Date:
 *   8/15/2026-Gender: Male-Motivation: Learn to ride-Motorcycle Riding History: I have ridden only
 *   as a passenger-Training Experience: No-...
 *
 * "Motivation: Learn to ride" + "Training Experience: No" — two labels, no request — and on
 * 2026-08-06 igor yuzbashev was told "I saw you want to do the Jumpstart experience before the
 * course." He had said nothing of the kind.
 *
 * FAIL DIRECTION: on a machine record we require the explicit Jumpstart words. Getting it wrong now
 * means we do not claim he asked for something — the Jumpstart is still offered on the reply side,
 * as an offer. The old behaviour put words in a customer's mouth, which is the costlier error.
 */
const ADF_ENROLLMENT_RECORD_MARKER = /\benrollment status:\s*/i;

export function isJumpStartExperienceRequestText(text: string | null | undefined): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  if (/\bjump\s*start\b|\bjumpstart\b|\bjump-start\b/.test(t)) return true;
  if (ADF_ENROLLMENT_RECORD_MARKER.test(t)) return false;
  return (
    /\b(riding academy|rider academy|learn to ride)\b/.test(t) &&
    /\b(prior|before|prep|practice|experience)\b/.test(t)
  );
}

/**
 * The course name and class start date off a Riding Academy enrollment record.
 *
 * Structured extraction from a MACHINE record, not comprehension: the body is a `-`-joined list of
 * `Label: Value` pairs, and the values themselves contain hyphens
 * ("Course: New Rider Course - eCourse + Range"), so it splits only before a capitalised label
 * followed by a colon. Returns nulls when a field is absent — the waitlist reply then says
 * "the Riding Academy" rather than inventing a class.
 */
export function readRidingAcademyRecordFields(inquiry?: string | null): {
  course: string | null;
  startDate: string | null;
} {
  const raw = String(inquiry ?? "").trim();
  if (!raw) return { course: null, startDate: null };
  const fields = new Map<string, string>();
  for (const part of raw.split(/-(?=[A-Z][A-Za-z ]{2,40}:)/)) {
    const m = /^\s*([^:]{2,40}):\s*(.*)$/.exec(part);
    if (m) fields.set(m[1].trim().toLowerCase(), m[2].trim());
  }
  const course = fields.get("course") || null;
  const startDate = fields.get("class start date") || fields.get("start date") || null;
  return { course, startDate };
}
