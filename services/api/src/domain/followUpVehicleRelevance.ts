// Should a lead-attached vehicle be named in a follow-up task label?
//
// ADF web forms (e.g. Room58 "Book test ride") attach a Vehicle to the lead even
// when the customer's actual inquiry is about something else — a Harley-Davidson
// Jumpstart simulator session or an MSF / rider course before they buy anything.
// For those experiential / rider-education leads the specific bike is noise: pasting
// "follow up on the 2026 Breakout" onto a Jumpstart lead is the over-attached-model
// failure (the customer never referenced a Breakout — it rode in on the form).
//
// This is the relevance guard for the staff-facing follow-up LABEL only. Its
// fail-direction is safe: a wrong "not relevant" just makes the task label generic
// ("Call customer and update status."), it never changes a customer reply. The
// rider-experience/education signal is the same one the routing layer already uses
// (see isJumpStartExperienceText in index.ts and the MSF/rider-course detectors).

const JUMPSTART_RE = /\bjump\s*start\b|\bjumpstart\b|\bjump-start\b/i;
const RIDING_ACADEMY_RE = /\b(riding academy|rider academy|learn to ride)\b/i;
const ACADEMY_PREP_RE = /\b(prior|before|prep|practice|experience)\b/i;
const RIDER_COURSE_RE =
  /\b(msf|riding academy|rider academy|learn to ride|riding school|rider school|riding course|rider course|motorcycle class|motorcycle course)\b/i;

export function isRiderExperienceOrEducationText(text: string | null | undefined): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  if (JUMPSTART_RE.test(t)) return true;
  if (RIDING_ACADEMY_RE.test(t) && ACADEMY_PREP_RE.test(t)) return true;
  if (RIDER_COURSE_RE.test(t)) return true;
  return false;
}

// The customer-authored text for this lead: the ADF inquiry/comments plus every
// inbound message body. NOT the lead source string (a "Book test ride" form name
// must not look like a vehicle-shopping signal here).
function leadCustomerText(conv: any): string {
  const parts: Array<string | null | undefined> = [conv?.lead?.inquiry, conv?.lead?.comments];
  for (const m of conv?.messages ?? []) {
    if (m?.direction === "in") parts.push(m?.body);
  }
  return parts.filter(Boolean).join(" \n ");
}

export function leadVehicleRelevantToFollowUp(conv: any): boolean {
  // Experiential / rider-education leads are not about the attached bike.
  if (isRiderExperienceOrEducationText(leadCustomerText(conv))) return false;
  return true;
}
