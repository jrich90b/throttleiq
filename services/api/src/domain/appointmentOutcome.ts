/**
 * The appointment-outcome vocabulary: what a rep can say happened at an appointment, and how those
 * answers map onto the legacy single-status field every older reader still consults.
 *
 * WHY IT LIVES HERE. Extracted verbatim from `index.ts` (which sits on its size ceiling) so the
 * vocabulary can grow without the ceiling deciding product questions. Pure — no IO, no store, no
 * clock. `decideAppointmentOutcomeRecord` in routeStateReducer owns what happens to a STORED
 * outcome; this module owns what the words mean.
 *
 * ── "Rescheduled" (Joe, 2026-08-18, +17165230421 Jason Marshall) ──────────────────────────────
 * The Attendance dropdown offered Showed / Did not show / Cancelled, and the fourth thing that
 * actually happens had no word: the appointment MOVED. Jason had a Tue 4:30 PM visit booked for the
 * CVO Road Glide ST; that morning he wrote that he was free today or tomorrow, staff replied "if you
 * have availability for tomorrow, let's shoot for then", and staff promised to call in the morning
 * to set the time. The 4:30 slot came and went, the outcome nag fired at 5:45 PM, and none of the
 * three options was true.
 *
 * That is not a cosmetic gap. Recording the nearest wrong answer has TWO live consequences:
 *   1. `did_not_show` / `cancelled` are what `isMissedAppointmentOutcome` reads, so the agent gains
 *      permission to tell a customer we missed them — on a customer who is coming tomorrow.
 *   2. `did_not_show`/`cancelled` + `needs_follow_up` is exactly the pair that queues an automatic
 *      "sorry we missed you, want to rebook?" text (`maybeQueueAppointmentOutcomeRescheduleDraft`),
 *      i.e. the wrong option does not merely mis-record — it drafts a wrong message to a customer.
 *
 * FAIL DIRECTION, and why `rescheduled` is safe by construction: every miss/show predicate uses an
 * explicit allow-list (`isShowedAppointmentOutcome`, `isMissedAppointmentOutcome`), so a new value
 * reads as attendance "unknown" — we can never ASSERT a miss or a show off it. The reschedule-draft
 * gate is likewise an allow-list of did_not_show/cancelled, so `rescheduled` queues nothing. Both
 * are pinned as negative fixtures in appointment_outcome_rescheduled:eval rather than left to luck.
 *
 * It maps to the legacy status `follow_up` — deliberately NOT `cancelled`. The appointment did not
 * die, it moved, and the lead is still live.
 */

export type AppointmentPrimaryOutcome = "showed" | "did_not_show" | "cancelled" | "rescheduled";
export type AppointmentSecondaryOutcome =
  | "sold"
  | "hold"
  | "needs_follow_up"
  | "lost"
  | "finance_not_approved"
  | "finance_needs_info"
  | "not_ready"
  | "no_change"
  | "other";
export type LegacyAppointmentOutcomeStatus =
  | "showed_up"
  | "no_show"
  | "cancelled"
  | "sold"
  | "hold"
  | "financing_declined"
  | "financing_needs_info"
  | "bought_elsewhere"
  | "lost"
  | "follow_up"
  | "no_change"
  | "other";

export const APPOINTMENT_SECONDARY_OPTIONS: Record<AppointmentPrimaryOutcome, Set<AppointmentSecondaryOutcome>> = {
  showed: new Set([
    "sold",
    "hold",
    "needs_follow_up",
    "lost",
    "finance_not_approved",
    "finance_needs_info",
    "not_ready",
    "no_change",
    "other"
  ]),
  did_not_show: new Set(["needs_follow_up", "lost", "not_ready", "other"]),
  cancelled: new Set(["needs_follow_up", "lost", "not_ready", "other"]),
  // A moved appointment is still a live lead: the only honest dispositions are "still working it"
  // and "other". `lost`/`not_ready` are deliberately absent — those are outcomes of a visit that
  // happened or died, and this one has not happened yet.
  rescheduled: new Set(["needs_follow_up", "other"])
};

export function normalizeAppointmentPrimaryOutcome(raw: string): AppointmentPrimaryOutcome | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return null;
  if (value === "showed" || value === "showed_up") return "showed";
  if (value === "did_not_show" || value === "no_show") return "did_not_show";
  if (value === "cancelled" || value === "canceled") return "cancelled";
  if (value === "rescheduled" || value === "re-scheduled" || value === "reschedule") return "rescheduled";
  return null;
}

export function normalizeAppointmentSecondaryOutcome(raw: string): AppointmentSecondaryOutcome | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return null;
  if (value === "sold") return "sold";
  if (value === "hold") return "hold";
  if (value === "needs_follow_up" || value === "follow_up") return "needs_follow_up";
  if (value === "lost" || value === "bought_elsewhere") return "lost";
  if (value === "finance_not_approved" || value === "financing_declined") return "finance_not_approved";
  if (value === "finance_needs_info" || value === "financing_needs_info") return "finance_needs_info";
  if (value === "not_ready") return "not_ready";
  if (value === "no_change" || value === "already_on_hold" || value === "already hold" || value === "already on hold") {
    return "no_change";
  }
  if (value === "other") return "other";
  return null;
}

export function mapLegacyAppointmentOutcome(
  statusRaw: string
): { primaryStatus: AppointmentPrimaryOutcome; secondaryStatus: AppointmentSecondaryOutcome; legacyStatus: LegacyAppointmentOutcomeStatus } {
  const status = String(statusRaw ?? "").trim().toLowerCase();
  if (status === "sold") {
    return { primaryStatus: "showed", secondaryStatus: "sold", legacyStatus: "sold" };
  }
  if (status === "hold") {
    return { primaryStatus: "showed", secondaryStatus: "hold", legacyStatus: "hold" };
  }
  if (status === "financing_declined") {
    return { primaryStatus: "showed", secondaryStatus: "finance_not_approved", legacyStatus: "financing_declined" };
  }
  if (status === "financing_needs_info") {
    return { primaryStatus: "showed", secondaryStatus: "finance_needs_info", legacyStatus: "financing_needs_info" };
  }
  if (status === "bought_elsewhere" || status === "lost") {
    return { primaryStatus: "showed", secondaryStatus: "lost", legacyStatus: status === "lost" ? "lost" : "bought_elsewhere" };
  }
  if (status === "other") {
    return { primaryStatus: "showed", secondaryStatus: "other", legacyStatus: "other" };
  }
  if (status === "no_change" || status === "already_on_hold") {
    return { primaryStatus: "showed", secondaryStatus: "no_change", legacyStatus: "no_change" };
  }
  if (status === "cancelled" || status === "canceled") {
    return { primaryStatus: "cancelled", secondaryStatus: "needs_follow_up", legacyStatus: "cancelled" };
  }
  if (status === "no_show") {
    return { primaryStatus: "did_not_show", secondaryStatus: "needs_follow_up", legacyStatus: "no_show" };
  }
  if (status === "showed_up") {
    return { primaryStatus: "showed", secondaryStatus: "needs_follow_up", legacyStatus: "showed_up" };
  }
  return { primaryStatus: "showed", secondaryStatus: "needs_follow_up", legacyStatus: "follow_up" };
}

export function mapPrimarySecondaryToLegacy(
  primaryStatus: AppointmentPrimaryOutcome,
  secondaryStatus: AppointmentSecondaryOutcome
): LegacyAppointmentOutcomeStatus {
  if (primaryStatus === "did_not_show") return "no_show";
  if (primaryStatus === "cancelled") return "cancelled";
  // The visit MOVED — it neither happened nor died, so it must not land on a legacy status any
  // miss/close reader treats as a failed appointment.
  if (primaryStatus === "rescheduled") return "follow_up";
  if (secondaryStatus === "sold") return "sold";
  if (secondaryStatus === "hold") return "hold";
  if (secondaryStatus === "finance_not_approved") return "financing_declined";
  if (secondaryStatus === "finance_needs_info") return "financing_needs_info";
  if (secondaryStatus === "lost") return "bought_elsewhere";
  if (secondaryStatus === "no_change") return "no_change";
  if (secondaryStatus === "other") return "other";
  return "follow_up";
}
