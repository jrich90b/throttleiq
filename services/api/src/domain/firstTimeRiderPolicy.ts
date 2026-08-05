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
};

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
    requiresEndorsement:
      p.requiresMotorcycleEndorsementForTestRide !== false && p.testRideRequiresEndorsement !== false,
    jumpstartEnabled: p.jumpstartEnabled === true
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
