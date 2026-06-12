/**
 * Task escalation — manager gets a digest when rep task cards sit untouched
 * past a threshold during business hours (competitive parity, 2026-06-11:
 * dealershipaccelerator.io's headline configurable is a 50-minute manager
 * ping; our nightly actions audit only catches this at 36h granularity).
 *
 * Pure decision logic so the threshold/business-hours behavior is testable
 * without the API. The runner in index.ts owns clock resolution, manager
 * lookup, SMS sending, and marking todos escalated.
 */
import type { TodoTask } from "./conversationStore.js";

export type EscalationConfig = {
  thresholdMinutes: number;
  lookbackHours: number;
  maxPerDigest: number;
};

export const DEFAULT_ESCALATION_CONFIG: EscalationConfig = {
  thresholdMinutes: 60,
  lookbackHours: 48,
  maxPerDigest: 6
};

export type BusinessClock = {
  /** Minutes since local midnight at the dealership. */
  minutesSinceMidnight: number;
  /** Today's opening time in minutes since midnight, or null when closed. */
  openMinutes: number | null;
  /** Today's closing time in minutes since midnight, or null when closed. */
  closeMinutes: number | null;
};

export function parseBusinessMinutes(raw: unknown): number | null {
  const text = String(raw ?? "").trim();
  const m = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return Number.isFinite(minutes) ? minutes : null;
}

export function isClockWithinBusinessHours(clock: BusinessClock): boolean {
  if (clock.openMinutes == null || clock.closeMinutes == null) return false;
  if (clock.closeMinutes <= clock.openMinutes) return false;
  return (
    clock.minutesSinceMidnight >= clock.openMinutes &&
    clock.minutesSinceMidnight < clock.closeMinutes
  );
}

export type EscalationCandidate = {
  todo: TodoTask;
  waitingMinutes: number;
};

export function resolveEscalationCandidates(args: {
  todos: TodoTask[];
  nowMs: number;
  clock: BusinessClock;
  cfg?: Partial<EscalationConfig>;
}): EscalationCandidate[] {
  const cfg = { ...DEFAULT_ESCALATION_CONFIG, ...(args.cfg ?? {}) };
  if (!isClockWithinBusinessHours(args.clock)) return [];
  const minutesSinceOpen = args.clock.minutesSinceMidnight - (args.clock.openMinutes ?? 0);
  const out: EscalationCandidate[] = [];
  for (const todo of args.todos ?? []) {
    if (!todo || todo.status !== "open") continue;
    // Internal notes are informational cards, not rep actions.
    if (String(todo.reason ?? "") === "note") continue;
    if ((todo as any).escalatedAt) continue;
    const createdMs = Date.parse(String(todo.createdAt ?? ""));
    if (!Number.isFinite(createdMs)) continue;
    if (args.nowMs - createdMs > cfg.lookbackHours * 60 * 60 * 1000) continue;
    const dueMs = Date.parse(String(todo.dueAt ?? ""));
    // Scheduled tasks (reminders, future appointments) only count once due.
    if (Number.isFinite(dueMs) && dueMs > args.nowMs) continue;
    const anchorMs = Number.isFinite(dueMs) ? Math.max(dueMs, createdMs) : createdMs;
    const ageMinutes = (args.nowMs - anchorMs) / 60_000;
    // A task created overnight starts its clock at opening time.
    const waitingMinutes = Math.floor(Math.min(ageMinutes, minutesSinceOpen));
    if (waitingMinutes < cfg.thresholdMinutes) continue;
    out.push({ todo, waitingMinutes });
  }
  out.sort((a, b) => b.waitingMinutes - a.waitingMinutes);
  return out.slice(0, cfg.maxPerDigest);
}

function waitingLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function buildEscalationDigest(
  candidates: EscalationCandidate[],
  leadNameByConvId: Map<string, string>,
  thresholdMinutes: number = DEFAULT_ESCALATION_CONFIG.thresholdMinutes
): string {
  const lines = candidates.map(({ todo, waitingMinutes }) => {
    const name =
      String(leadNameByConvId.get(todo.convId) ?? "").trim() || String(todo.leadKey ?? todo.convId);
    const owner = String(todo.ownerName ?? "").trim();
    const summary = String(todo.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 70);
    return `• ${name} (${waitingLabel(waitingMinutes)}${owner ? `, ${owner}` : ", unassigned"}): ${summary}`;
  });
  const head =
    candidates.length === 1
      ? `LeadRider: 1 task has been waiting over ${thresholdMinutes} min:`
      : `LeadRider: ${candidates.length} tasks have been waiting over ${thresholdMinutes} min:`;
  return [head, ...lines].join("\n");
}
