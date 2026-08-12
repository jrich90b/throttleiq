import { decideRiderExperiencePersist, resolveRiderExperienceLevel } from "./routeStateReducer.js";
import type { FirstTimeRiderGuidanceParse } from "./llmDraft.js";
import type { RiderCourseClassRow } from "./riderCourseSchedule.js";

/**
 * The dealer's FIRST-TIME-RIDER policy, read once.
 *
 * `policies.firstTimeRider` on the dealer profile drives every reply in the first-time-rider lane
 * (rider-course info, no-endorsement, beginner guidance). The same eight-line read of it —
 * course name, course URL, course price, endorsement requirement — was written out THREE times in
 * `index.ts` (`buildFirstTimeRiderGuidanceReply`, `buildInitialAdfFirstTimeRiderGuidanceReply`,
 * `hasRiderCourseCustomerFacingInfo`), each with its own default. One read, one place.
 *
 * PORTABILITY: everything here is a per-dealer capability, never an American Harley fact. A dealer
 * that has not set the field gets the conservative default, so a new store is correct on day one.
 */

export type FirstTimeRiderPolicy = {
  /** Display name for the dealer's rider-training course. */
  courseName: string;
  /** Public course page, when the dealer has one. */
  courseUrl: string;
  /** Course price as the dealer states it — never computed, never guessed. */
  coursePrice: string;
  /** Does a test ride require a motorcycle endorsement here? Defaults to YES. */
  requiresEndorsement: boolean;
  /**
   * Upcoming classes with per-day times and places. EMPTY today — no feed exists yet, and Joe
   * (2026-08-07) does not want a hand-maintained table. Empty means every class-logistics question
   * hands off to a person, which is the safe default and what happens now.
   */
  classSchedule: RiderCourseClassRow[];
  /**
   * Does this store have a JUMPSTART on site (Joe, 2026-08-05)? The H-D Jumpstart is a real bike
   * locked onto a stationary rig: a rider works the clutch, throttle and gears and feels the bike
   * running without ever leaving the showroom floor or needing an endorsement. Set
   * `policies.firstTimeRider.jumpstartEnabled: true` on a dealer that owns one.
   *
   * DEFAULTS TO FALSE, and that is the whole safety property: the agent must never offer to put
   * someone on equipment the store does not have. Absent, malformed, or non-boolean all read as
   * false — only an explicit `true` turns it on.
   */
  jumpstartEnabled: boolean;
  /**
   * The dealer's own sentence for a NEW course registration — e.g. American Harley's *"Our riding
   * academy manager will send you your e-course link that just needs to be completed prior to your
   * course."* (Joe, 2026-08-05: *"This is dealer specific and maybe each dealer can type their
   * template message in their profile."*) Inserted VERBATIM into the registration reply.
   *
   * Blank ⇒ nothing is added, which is the default and the portable behaviour: a store that has not
   * written one never has words put in its mouth. Capped at REGISTRATION_NOTE_MAX_CHARS — a note
   * longer than that is DROPPED rather than truncated mid-sentence, because half a sentence about
   * someone's course is worse than none.
   */
  registrationNote: string;
  /**
   * How an UNPAID course seat can be settled, in the dealer's words — American Harley's is "at the
   * dealership or over the phone" (Joe, 2026-08-05). Blank ⇒ the agent never raises payment at all.
   * NEVER an amount: this says WHERE to pay, never HOW MUCH.
   */
  unpaidSeatPaymentMethods: string;
};

/**
 * A dealer-typed note goes straight to a customer, so it is length-capped at roughly two SMS
 * sentences. Over the cap it is dropped, not cut: the console also caps the input, so a dealer sees
 * the limit while typing rather than discovering it in a customer's inbox.
 */
export const REGISTRATION_NOTE_MAX_CHARS = 200;

/** Dealer-typed free text, normalised for a single-line SMS and dropped if it runs long. */
function readDealerNote(raw: unknown): string {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.length > REGISTRATION_NOTE_MAX_CHARS) return "";
  return text;
}

export function readFirstTimeRiderPolicy(dealerProfile: any): FirstTimeRiderPolicy {
  const policies = dealerProfile?.policies ?? {};
  const p =
    policies?.firstTimeRider && typeof policies.firstTimeRider === "object"
      ? policies.firstTimeRider
      : {};
  return {
    courseName:
      String(p.riderCourseName ?? "").trim() || String(p.trainingCourseName ?? "").trim() || "",
    courseUrl: String(p.riderCourseUrl ?? "").trim() || String(p.trainingCourseUrl ?? "").trim(),
    coursePrice:
      String(p.riderCoursePrice ?? "").trim() || String(p.trainingCoursePrice ?? "").trim(),
    // Both legacy keys must be explicitly false to drop the requirement (unchanged behaviour).
    classSchedule: Array.isArray(p.classSchedule) ? (p.classSchedule as RiderCourseClassRow[]) : [],
    requiresEndorsement:
      p.requiresMotorcycleEndorsementForTestRide !== false && p.testRideRequiresEndorsement !== false,
    jumpstartEnabled: p.jumpstartEnabled === true,
    registrationNote: readDealerNote(p.registrationNote),
    unpaidSeatPaymentMethods: readDealerNote(p.unpaidSeatPaymentMethods)
  };
}

/** Is there anything customer-facing to say about the course (a price or a link)? */
export function hasRiderCoursePublicInfo(dealerProfile: any): boolean {
  const policy = readFirstTimeRiderPolicy(dealerProfile);
  return !!(policy.coursePrice || policy.courseUrl);
}

/**
 * The rider-training enrollment record's own `Motorcycle Riding History:` field, when this lead
 * carries one. A machine enum inside a machine record (structured extraction, not comprehension) —
 * customer prose is read by the typed first_time_rider parser, never here. Returns "" when the
 * lead has no enrollment record, which the reducer treats as "unknown", not "beginner".
 */
export function readEnrollmentRidingHistory(inquiry?: string | null): string {
  // The record packs `Field: value-Field: value-…` onto one line, and hyphens also appear INSIDE
  // values ("on-road", "eCourse + Range"). So stop at the next FIELD boundary — a hyphen followed
  // by a capitalised label and a colon — not at the next hyphen.
  const hit = String(inquiry ?? "").match(
    /\bmotorcycle riding history:\s*(.+?)(?=-[A-Z][A-Za-z /]*:|\n|$)/i
  );
  return hit?.[1] ? hit[1].trim() : "";
}

/**
 * The enrollment record's `Course:` field — which course they signed up for. Same machine record,
 * same field-boundary rule as the riding-history read (values contain hyphens: "New Rider Course -
 * eCourse + Range").
 */
export function readEnrollmentCourseName(inquiry?: string | null): string {
  const hit = String(inquiry ?? "").match(/\bcourse:\s*(.+?)(?=-[A-Z][A-Za-z /]*:|\n|$)/i);
  return hit?.[1] ? hit[1].trim() : "";
}

/**
 * The enrollment record's `Class Start Date:` — the day their course begins, as the riding school
 * wrote it (`M/D/YYYY`). Same machine record, same field-boundary rule as the reads above.
 *
 * Returns epoch ms for the END of that calendar day, or null when the lead has no enrollment
 * record or the date is unreadable. Null means "we do not know", never "already happened".
 */
export function readEnrollmentClassStartMs(inquiry?: string | null): number | null {
  const hit = String(inquiry ?? "").match(
    /\bclass start date:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})(?=-[A-Z][A-Za-z /]*:|\D|$)/i
  );
  if (!hit) return null;
  const [month, day, year] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  // Round-trip the calendar so an impossible day (2/31) reads as UNKNOWN rather than silently
  // rolling into the next month and stretching the window.
  const start = new Date(year, month - 1, day);
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) return null;
  // END of the class day, not its start: the seat is still ahead of them for the whole of it, and
  // a suppression that errs a few hours long fails toward NOT texting — the safe direction.
  const end = new Date(year, month - 1, day + 1).getTime();
  return Number.isFinite(end) ? end : null;
}

/**
 * Is this thread quiet because the customer is WAITING FOR A CLASS THEY ALREADY BOOKED?
 *
 * Joe, operator report on Savannah Niver +13155211619 (2026-08-10): *"between the sign up date and
 * the class, there really should not be a follow up cadence for riding academy regsitrations."*
 * She enrolled, we acked, and three quiet days later the nudge drafted *"Quick check — any
 * questions about the Riding Academy before class starts, Savannah?"*. Nothing has happened yet
 * and nothing is expected to: the next event on that thread is the class itself.
 *
 * DATE-AWARE ON PURPOSE, not a lane exclusion. Joe's rule has two ends — "between the sign up date
 * AND the class" — so once the class day is behind them the thread is an ordinary quiet thread
 * again and the nudge is welcome. Measured by executing decideHumanThreadNudge against the live
 * store 2026-08-12: three enrolled leads are nudge-eligible, and advancing the clock five days
 * turns two of them into `nudge:true` — one legitimately (class already past), one not (Ulises
 * +17167857284, class still five days out). A blanket lane bail would have eaten both.
 *
 * FAIL DIRECTION: unknown / unreadable / no enrollment record all return false, so the nudge keeps
 * its current behaviour everywhere it cannot read a class date.
 */
export function isThreadParkedOnUpcomingClass(conv: any, nowMs: number): boolean {
  const classEndMs = readEnrollmentClassStartMs(conv?.lead?.inquiry);
  return classEndMs !== null && Number.isFinite(nowMs) && nowMs < classEndMs;
}

/**
 * Does the enrollment record plainly say the seat is NOT settled?
 *
 * ALLOWLIST of not-paid wordings, on purpose. Across the whole americanharley store there are
 * exactly two `Payment Status` values — "Failed" and "Awaiting Payment at Dealer" — and NO example
 * of what a PAID one looks like, so "not one of the unpaid words" is the only thing we can read
 * safely. Unknown, blank, and any future "Paid"/"Complete" all return false.
 *
 * FAIL DIRECTION: telling someone their payment failed when it did not is alarming and wrong, so
 * silence is the default and only an explicit not-paid wording speaks up.
 */
export function enrollmentSeatIsUnpaid(inquiry?: string | null): boolean {
  const hit = String(inquiry ?? "").match(/\bpayment status:\s*(.+?)(?=-[A-Z][A-Za-z /]*:|\n|$)/i);
  const status = hit?.[1] ? hit[1].trim().toLowerCase() : "";
  if (!status) return false;
  return /\b(failed|declined|unpaid|awaiting payment|payment due|not paid|pending payment)\b/.test(status);
}

/**
 * Persist what this turn told us about the lead's riding experience — the ONE writer of
 * `conv.riderExperience`, refereed by `decideRiderExperiencePersist` (monotonic; it refuses to
 * demote an experienced rider). Reads the SAME two sources the reply side already uses: the typed
 * first_time_rider_guidance parse, and the riding school's machine enrollment record.
 *
 * Called from applyFirstTimeRiderGuidanceState in index.ts so it inherits that function's three call
 * sites —
 * live twilio, regenerate, and the initial-ADF regenerate — rather than becoming a fourth writer
 * someone has to keep in sync.
 */
export function applyRiderExperienceState(conv: any, parsed?: FirstTimeRiderGuidanceParse | null) {
  const ridingHistory = readEnrollmentRidingHistory(conv?.lead?.inquiry);
  const enrolledCourse = readEnrollmentCourseName(conv?.lead?.inquiry);
  const observed = resolveRiderExperienceLevel({
    riderIntent: parsed?.intent ?? null,
    hasEndorsement: parsed?.hasEndorsement ?? null,
    ridingHistory,
    enrolledCourse
  });
  const decision = decideRiderExperiencePersist({
    current: conv?.riderExperience ?? null,
    observed,
    // The enrollment record is a machine field; anything else came from the typed parse.
    source: ridingHistory || enrolledCourse ? "enrollment" : "parser",
    nowIso: new Date().toISOString()
  });
  if (decision.write) conv.riderExperience = decision.next;
}
