/**
 * End-of-day "clean-day blocker" digest — tells staff exactly which pending
 * drafts and unrecorded appointment outcomes will grade TODAY as DIRTY on the
 * dealer-rollout release gate, while there's still time to clear them.
 *
 * Origin (Joe, 2026-07-05): the release gate needs 7 consecutive clean days to
 * declare dealer-rollout READY, and the two metrics that block it are STAFF
 * process, not agent behavior — `draft_unactioned` recent > 2 (failed 14/14
 * days) and `appointment_outcome_missing` recent > 0 (failed 7/14). The nightly
 * report grades yesterday after the fact; this digest turns the same checks
 * into a same-day checklist sent to the manager phone before close.
 *
 * The blocker collection MIRRORS scripts/agent_actions_audit.ts exactly (same
 * age windows, same recorded-outcome test) — if the two ever disagree, staff
 * clears the list and the gate still grades dirty, which kills trust in the
 * digest. Keep them in lockstep; the eval pins both windows.
 *
 * Pure decision logic (testable without the API). The runner in index.ts owns
 * clock resolution, manager lookup, SMS sending, and once-per-day state.
 */

type AnyObj = Record<string, any>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Release-gate thresholds the digest guards (RELEASE_GATE_DRAFT_UNACTIONED_MAX default). */
export const GATE_DRAFT_UNACTIONED_MAX = 2;
export const GATE_APPT_OUTCOME_MISSING_MAX = 0;

/** Local send window opens at 17:00 dealership time by default. */
export const DEFAULT_DIGEST_SEND_MINUTES = 17 * 60;

export type GateBlocker = {
  kind: "draft_unactioned" | "appointment_outcome_missing";
  convId: string;
  name: string;
  detail: string;
};

export type GateBlockerReport = {
  drafts: GateBlocker[];
  outcomes: GateBlocker[];
  /** True when the counts would fail the release gate today. */
  gateDirty: boolean;
};

function leadName(conv: AnyObj): string {
  const lead = conv?.lead ?? {};
  return (
    [String(lead?.firstName ?? "").trim(), String(lead?.lastName ?? "").trim()]
      .filter(Boolean)
      .join(" ") || String(conv?.id ?? "")
  );
}

function parseMs(raw: unknown): number | null {
  const ms = Date.parse(String(raw ?? ""));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Mirror of agent_actions_audit's appointmentOutcomeRecorded: any recorded
 * status (including status-only no_show/showed rows) counts as recorded.
 */
export function gateAppointmentOutcomeRecorded(appt: AnyObj | null): boolean {
  const o = appt?.staffNotify?.outcome;
  if (!o || typeof o !== "object") return false;
  return Boolean(
    String(o.note ?? "").trim() ||
      String(o.status ?? "").trim() ||
      String(o.primaryStatus ?? "").trim() ||
      String(o.secondaryStatus ?? "").trim()
  );
}

/**
 * Collect today's gate blockers from the live conversations. Windows are the
 * audit's "recent" windows — the ones the release gate grades:
 *  - draft_unactioned: OPEN conv whose newest message is a pending draft
 *    (provider "draft_ai"), older than 1.5d and within 7d.
 *  - appointment_outcome_missing: booked/confirmed appointment that started
 *    more than 3d ago (within 14d) with no outcome recorded.
 */
export function collectGateBlockers(convs: AnyObj[], nowMs: number): GateBlockerReport {
  const drafts: GateBlocker[] = [];
  const outcomes: GateBlocker[] = [];
  for (const conv of convs ?? []) {
    if (!conv?.id) continue;
    const open = conv.status !== "closed";

    if (open) {
      // Mirror the console's pending-draft semantics (conversationStore
      // getLatestPendingDraft): the newest NON-STALE draft counts only when it's
      // newer than the last real send. A draftStatus "stale" draft was already
      // dismissed/superseded — the console hides it, and a digest naming a draft
      // staff cannot see or clear kills trust in the checklist (Zachary Bushey
      // +17169013675, 2026-07-05).
      const msgs: AnyObj[] = Array.isArray(conv.messages) ? conv.messages : [];
      let lastDraftIdx = -1;
      let lastSentIdx = -1;
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (m?.direction !== "out") continue;
        if (m?.provider === "draft_ai" && m?.draftStatus !== "stale") lastDraftIdx = i;
        if (m?.provider === "human" || m?.provider === "twilio" || m?.provider === "sendgrid") {
          lastSentIdx = i;
        }
      }
      const pending = lastDraftIdx > lastSentIdx ? msgs[lastDraftIdx] : null;
      if (pending) {
        const draftMs = parseMs(pending.at);
        if (draftMs != null) {
          const ageDays = (nowMs - draftMs) / DAY_MS;
          if (ageDays > 1.5 && ageDays <= 7) {
            drafts.push({
              kind: "draft_unactioned",
              convId: String(conv.id),
              name: leadName(conv),
              detail: `draft waiting ${Math.round(ageDays)}d — send, edit, or dismiss it`
            });
          }
        }
      }
    }

    const appt = conv.appointment ?? null;
    const apptStatus = String(appt?.status ?? "");
    if (
      (apptStatus === "booked" || apptStatus === "confirmed") &&
      !gateAppointmentOutcomeRecorded(appt)
    ) {
      const startMs = parseMs(appt?.matchedSlot?.start ?? appt?.start);
      if (startMs != null && nowMs - startMs > 3 * DAY_MS && nowMs - startMs <= 14 * DAY_MS) {
        outcomes.push({
          kind: "appointment_outcome_missing",
          convId: String(conv.id),
          name: leadName(conv),
          detail: `visit ${new Date(startMs).toISOString().slice(0, 10)} — record showed / no-show`
        });
      }
    }
  }
  const gateDirty =
    drafts.length > GATE_DRAFT_UNACTIONED_MAX || outcomes.length > GATE_APPT_OUTCOME_MISSING_MAX;
  return { drafts, outcomes, gateDirty };
}

/**
 * Once per local calendar day, at/after the send-window minute, and only while
 * the dealership is still open (a digest after close is a morning surprise,
 * not a checklist). FAIL DIRECTION: toward NOT sending — this is a nudge, and
 * a duplicate or after-hours ping erodes trust faster than a missed day.
 */
export function shouldSendGateBlockerDigest(args: {
  gateDirty: boolean;
  minutesSinceMidnight: number;
  closeMinutes: number | null;
  sendAtMinutes?: number;
  todayKey: string;
  lastSentDayKey: string | null;
}): boolean {
  if (!args.gateDirty) return false;
  if (args.lastSentDayKey === args.todayKey) return false;
  if (args.closeMinutes == null) return false; // closed today — nobody to act
  const sendAt = args.sendAtMinutes ?? DEFAULT_DIGEST_SEND_MINUTES;
  if (args.minutesSinceMidnight < sendAt) return false;
  if (args.minutesSinceMidnight >= args.closeMinutes) return false;
  return true;
}

const MAX_LINES_PER_SECTION = 6;

/** Manager SMS: what blocks today's clean day, named, with the action. */
export function buildGateBlockerDigestMessage(report: GateBlockerReport): string {
  const lines: string[] = [];
  lines.push("LeadRider clean-day check: today grades DIRTY unless these clear before close.");
  if (report.drafts.length > GATE_DRAFT_UNACTIONED_MAX) {
    lines.push(
      `Pending drafts ${report.drafts.length} (gate allows ${GATE_DRAFT_UNACTIONED_MAX}):`
    );
    for (const b of report.drafts.slice(0, MAX_LINES_PER_SECTION)) {
      lines.push(`• ${b.name}: ${b.detail}`);
    }
    if (report.drafts.length > MAX_LINES_PER_SECTION) {
      lines.push(`…and ${report.drafts.length - MAX_LINES_PER_SECTION} more in the console.`);
    }
  }
  if (report.outcomes.length > GATE_APPT_OUTCOME_MISSING_MAX) {
    lines.push(`Appointment outcomes missing ${report.outcomes.length}:`);
    for (const b of report.outcomes.slice(0, MAX_LINES_PER_SECTION)) {
      lines.push(`• ${b.name}: ${b.detail}`);
    }
    if (report.outcomes.length > MAX_LINES_PER_SECTION) {
      lines.push(`…and ${report.outcomes.length - MAX_LINES_PER_SECTION} more in the console.`);
    }
  }
  lines.push("Clear these and today counts toward the 7-day rollout streak.");
  return lines.join("\n");
}
