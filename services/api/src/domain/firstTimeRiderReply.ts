/**
 * The first-time-rider REPLY surface: the two builders that compose what a new rider is told, plus
 * the two text guards they read. Lifted verbatim out of index.ts by the de-tangle program — index.ts
 * was sitting on its size ceiling, and this is reply COMPOSITION, which belongs in a domain module
 * next to the policy it reads (firstTimeRiderPolicy.ts) rather than in the inbound handler.
 *
 * Nothing here changed in the move except the export keyword: same branches, same copy, same order.
 */
import type { FirstTimeRiderGuidanceParse } from "./llmDraft.js";
import { readFirstTimeRiderPolicy } from "./firstTimeRiderPolicy.js";
import { decideJumpstartInviteTurn } from "./routeStateReducer.js";
import { buildJumpstartOneOnOneInvite, buildFirstTimeRiderBeginnerReply } from "./agentVoice.js";
import { resolveRiderCourseLogisticsReply } from "./riderCourseSchedule.js";

/**
 * The class-logistics reply hands the question to a person; this is the staff task that makes that
 * promise true. Null for every other first-time-rider intent, so the caller stays two lines.
 */
export function riderCourseLogisticsTodoSummary(
  decision: { intent?: string | null; asksClassLogistics?: boolean } | null | undefined
): string | null {
  if (!decision) return null;
  if (decision.intent !== "enrolled_class_logistics" && !decision.asksClassLogistics) return null;
  return "Riding Academy student asked about their class (time, place or what to bring) - confirm and reply.";
}

export function hasExplicitRiderCourseInfoText(text: string | null | undefined): boolean {
  const t = String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return false;
  return (
    /\b(msf|riding academy|rider academy|learn to ride|riding school|rider school|riding course|rider course|motorcycle class|motorcycle course)\b/.test(
      t
    ) ||
    /\b(course|class)\b[\s\S]{0,80}\b(?:get|getting|obtain|earn)\s+(?:my\s+|a\s+)?(?:motorcycle\s+)?(?:license|licence|endorsement|permit)\b/.test(
      t
    ) ||
    /\b(?:motorcycle\s+)?(?:license|licence|endorsement|permit)\b[\s\S]{0,80}\b(course|class)\b/.test(
      t
    ) ||
    /\bcourse\s+motorcycle\b/.test(t)
  );
}

export function hasAmbiguousRiderCourseInfoText(text: string | null | undefined): boolean {
  const t = String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t || hasExplicitRiderCourseInfoText(t)) return false;
  return (
    /\b(?:your|the|this|that|our)\s+course\b/.test(t) ||
    /\bcourse\b[\s\S]{0,50}\b(price|pricing|cost|how much|tuition|fee|fees|rate)\b/.test(t) ||
    /\b(price|pricing|cost|how much|tuition|fee|fees|rate)\b[\s\S]{0,50}\bcourse\b/.test(t)
  );
}

export function buildFirstTimeRiderGuidanceReply(args: {
  parsed: FirstTimeRiderGuidanceParse;
  dealerProfile: any;
  text?: string | null;
  ridingHistory?: string | null;
  /** For the class-logistics hand-off below. Both optional — absent degrades to a hand-off. */
  firstName?: string | null;
  studentClassDate?: string | null;
}): string {
  const parsed = args.parsed;
  const policy = readFirstTimeRiderPolicy(args.dealerProfile);
  const requiresEndorsement = policy.requiresEndorsement;
  const courseName = policy.courseName || "a motorcycle safety course";
  const courseUrl = policy.courseUrl;
  const courseText = courseUrl ? `${courseName}: ${courseUrl}` : courseName;
  const courseDetails = courseUrl ? ` Course details are here: ${courseUrl}` : "";
  const coursePrice = policy.coursePrice;
  // Joe, 2026-08-05: a store with a Jumpstart offers an inexperienced rider 1-on-1 time on it.
  const jumpstartInvite =
    decideJumpstartInviteTurn({
      dealerHasJumpstart: policy.jumpstartEnabled,
      riderIntent: parsed.intent,
      hasEndorsement: parsed.hasEndorsement ?? null,
      ridingHistory: args.ridingHistory ?? null
    }).kind === "jumpstart_one_on_one_invite"
      ? buildJumpstartOneOnOneInvite()
      : "";

  // ALREADY IN A CLASS, asking about the class itself. Checked BEFORE rider_course_info, which is
  // SIGN-UP copy: an enrolled student asking "what time do I show up?" was answered with "the Riding
  // Academy course is the best place to start. The current price is $321." — quoting the price at
  // somebody who has already paid (Maya Iversen, +15854782032, 2026-08-07). With no class table
  // configured (today) this always hands off to a person, which needs no schedule data at all; if a
  // feed ever fills the rows in, the same call starts answering from them with no other change.
  const classLogistics = resolveRiderCourseLogisticsReply({
    intent: parsed.intent,
    asksClassLogistics: parsed.asksClassLogistics,
    firstName: args.firstName ?? null,
    rows: policy.classSchedule,
    studentClassDate: args.studentClassDate ?? null,
    nowMs: Date.now()
  });
  if (classLogistics.handled) return classLogistics.reply;

  if (parsed.intent === "rider_course_info" || parsed.asksRiderCourse) {
    const isAmbiguous = hasAmbiguousRiderCourseInfoText(args.text);
    const ambiguousPriceLine = coursePrice
      ? `the current price is ${coursePrice}.`
      : courseUrl
        ? `course details and pricing are here: ${courseUrl}`
        : "I’ll have the team confirm current class pricing and availability and follow up.";
    if (isAmbiguous) {
      return `Good question. If you mean our ${courseName}, ${ambiguousPriceLine}${coursePrice ? courseDetails : ""}`;
    }
    const intro = courseName.match(/^(a|an|the)\b/i)
      ? courseName
      : `the ${courseName}`;
    const introSentence = intro.charAt(0).toUpperCase() + intro.slice(1);
    const directPriceLine = coursePrice
      ? ` The current price is ${coursePrice}.`
      : courseUrl
        ? ` Course details and pricing are here: ${courseUrl}`
        : " I’ll have the team confirm current class pricing and availability and follow up.";
    return `Good question. ${introSentence} is the best place to start.${directPriceLine}${coursePrice ? courseDetails : ""}`;
  }
  if (parsed.hasEndorsement === false || parsed.intent === "no_motorcycle_endorsement") {
    const requirement = requiresEndorsement
      ? "For test rides, we do need a motorcycle endorsement."
      : "Before a test ride, I’d still want to make sure the bike is a safe fit for your experience.";
    return buildFirstTimeRiderBeginnerReply({
      branch: "no_endorsement",
      jumpstartInvite,
      requirement,
      courseText
    });
  }
  if (parsed.hasEndorsement === true) {
    return "That makes sense. Since you have your endorsement, I’d still start by making sure the bike feels manageable: seat height, weight, and comfort. What kind of riding are you hoping to do?";
  }
  if (parsed.asksTestRide) {
    return buildFirstTimeRiderBeginnerReply({ branch: "asks_test_ride", jumpstartInvite });
  }
  return buildFirstTimeRiderBeginnerReply({ branch: "general", jumpstartInvite });
}

export function buildInitialAdfFirstTimeRiderGuidanceReply(args: {
  parsed: FirstTimeRiderGuidanceParse;
  dealerProfile: any;
  text?: string | null;
  ridingHistory?: string | null;
}): string {
  const parsed = args.parsed;
  const adfPolicy = readFirstTimeRiderPolicy(args.dealerProfile);
  const courseName = adfPolicy.courseName || "Riding Academy course";
  const coursePrice = adfPolicy.coursePrice;
  const courseUrl = adfPolicy.courseUrl;
  if (parsed.intent === "rider_course_info" || parsed.asksRiderCourse) {
    const isAmbiguous = hasAmbiguousRiderCourseInfoText(args.text);
    const ambiguousPriceLine = coursePrice
      ? `the current price is ${coursePrice}.`
      : courseUrl
        ? `course details and pricing are here: ${courseUrl}`
        : "I’ll have the team confirm current class pricing and availability and follow up shortly.";
    const urlLine = courseUrl ? ` Course details are here: ${courseUrl}` : "";
    if (isAmbiguous) {
      return `Thanks for asking. If you mean our ${courseName}, ${ambiguousPriceLine}${coursePrice ? urlLine : ""}`;
    }
    const directPriceLine = coursePrice
      ? `The current price is ${coursePrice}.`
      : courseUrl
        ? `Course details and pricing are here: ${courseUrl}`
        : "I’ll have the team confirm current class pricing and availability and follow up shortly.";
    return `Thanks for asking about our ${courseName}. ${directPriceLine}${coursePrice ? urlLine : ""}`;
  }
  return buildFirstTimeRiderGuidanceReply(args);
}
