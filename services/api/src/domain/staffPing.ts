/**
 * Manager "Ping" — the manual counterpart to the automatic staff nudges (Joe, 2026-07-27).
 *
 * The dealership already gets nudged on a timer: the callback reminder texts the assigned
 * rep, and the task-escalation digest texts the manager once a card sits past the threshold
 * (`domain/taskEscalation.ts`). What was missing is the manual one — a manager looking at a
 * thread that is plainly sitting there, wanting to poke the rep RIGHT NOW. This module owns
 * that decision: who gets the text, whether we're allowed to send it yet, and what it says.
 *
 * INTERNAL STAFF ONLY. Nothing here reaches a customer and nothing here reads customer
 * language — it is a deterministic side-effect/notification decision (AGENTS.md: deterministic
 * is the correct tool for side effects and structured extraction), NOT comprehension. There is
 * no parser to route to; the inputs are task records and staff assignments, not free text.
 *
 * Pure decision logic so the target-selection and cooldown behavior is testable without the
 * API (same split as taskEscalation/gateBlockerDigest). The endpoint in index.ts owns clock
 * resolution, user lookup, SMS sending, and persistence.
 */
import type { TodoTask } from "./conversationStore.js";

/** A second ping to the same rep inside this window is refused (Joe default, 2026-07-27). */
export const DEFAULT_STAFF_PING_COOLDOWN_MINUTES = 120;
/** Task lines listed in the SMS before it collapses to "+N more". */
export const STAFF_PING_MAX_TASK_LINES = 3;
/** Per-conversation ping records retained for the audit trail. */
export const STAFF_PING_HISTORY_LIMIT = 10;

const SUMMARY_MAX_CHARS = 70;

/**
 * The manager's own words on the ping, capped so one pasted paragraph can't blow up the SMS
 * (Joe, 2026-08-04).
 *
 * Christopher Szczesny +17169400722: the thread had no open task, so the ping collapsed to
 * "LeadRider: Joe asked you to take a look at Christopher Szczesny." Stone got poked with no idea
 * why. The note is that missing reason.
 *
 * PERSON-ONLY, deliberately (Joe's ruling, 2026-08-04): the note reaches the staff SMS and the
 * audit trail and NOWHERE else. It is never written to agent context and never becomes draft
 * steering — a manager's aside to a rep must not silently change what the agent says to a
 * customer. Making it steer is a separate, gated decision; `staff_ping:eval` pins that boundary.
 */
export const STAFF_PING_NOTE_MAX_CHARS = 220;

export type StaffPingOwnerSource = "task_owner" | "lead_owner";

/** Who the ping is aimed at, before the user store has been consulted. */
export type StaffPingOwnerRef = {
  id: string;
  name: string;
  source: StaffPingOwnerSource;
};

/** One ping, as recorded on the conversation. */
export type StaffPingRecord = {
  at: string;
  byUserId?: string;
  byUserName: string;
  toUserId?: string;
  toUserName: string;
  taskIds: string[];
  delivered: boolean;
  /** The manager's reason, as it was sent. Audit trail only — never read back into a draft. */
  note?: string;
};

/** Trim + cap a manager note; empty/blank collapses to "" so callers can treat it as absent. */
export function normalizeStaffPingNote(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, STAFF_PING_NOTE_MAX_CHARS);
}

export type StaffPingDecision =
  | { kind: "disabled" }
  | { kind: "no_target" }
  | { kind: "no_phone"; targetName: string }
  | { kind: "cooldown"; targetName: string; minutesRemaining: number; lastPingedAt: string }
  | {
      kind: "send";
      targetId: string;
      targetName: string;
      targetPhone: string;
      message: string;
      taskIds: string[];
      /** Normalized manager note actually included in `message` (""when none). */
      note: string;
    };

function cleanText(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The open tasks on this conversation that a rep could actually act on. Mirrors the
 * escalation digest's exclusions: `note` cards are informational, not rep actions.
 * `convKeys` carries both the conversation id and its leadKey — todos are written
 * against either depending on the era of the record.
 */
export function collectPingableTasks(todos: TodoTask[], convKeys: string[]): TodoTask[] {
  const keys = new Set(convKeys.map(k => String(k ?? "").trim()).filter(Boolean));
  if (!keys.size) return [];
  const out = (todos ?? []).filter(todo => {
    if (!todo || todo.status !== "open") return false;
    if (String(todo.reason ?? "") === "note") return false;
    return keys.has(String(todo.convId ?? "").trim()) || keys.has(String(todo.leadKey ?? "").trim());
  });
  // Soonest-due first (an overdue card is the one the manager is staring at), undated after,
  // then oldest-created. Deterministic so the SMS body is stable for a given store state.
  return out.sort((a, b) => {
    const dueA = Date.parse(String(a.dueAt ?? ""));
    const dueB = Date.parse(String(b.dueAt ?? ""));
    const hasA = Number.isFinite(dueA);
    const hasB = Number.isFinite(dueB);
    if (hasA && hasB && dueA !== dueB) return dueA - dueB;
    if (hasA !== hasB) return hasA ? -1 : 1;
    const createdA = Date.parse(String(a.createdAt ?? "")) || 0;
    const createdB = Date.parse(String(b.createdAt ?? "")) || 0;
    if (createdA !== createdB) return createdA - createdB;
    return String(a.id ?? "").localeCompare(String(b.id ?? ""));
  });
}

/**
 * Who owns the work. Joe's ruling (2026-07-27): ping whoever owns the TASK, since that is
 * the person who has to do something — the lead owner is only the fallback when no open task
 * names anybody. Among several task owners, the one carrying the most open cards wins; ties
 * break to the owner of the earliest-created task so the answer never flickers.
 */
export function resolveStaffPingOwnerRef(
  tasks: TodoTask[],
  conv: { leadOwner?: { id?: string; name?: string } | null } | null | undefined
): StaffPingOwnerRef | null {
  const tally = new Map<string, { id: string; name: string; count: number; firstCreatedMs: number }>();
  for (const todo of tasks ?? []) {
    const id = String(todo?.ownerId ?? "").trim();
    const name = cleanText(todo?.ownerName);
    if (!id && !name) continue;
    const key = id || name.toLowerCase();
    const createdMs = Date.parse(String(todo?.createdAt ?? "")) || Number.MAX_SAFE_INTEGER;
    const prev = tally.get(key);
    if (prev) {
      prev.count += 1;
      prev.firstCreatedMs = Math.min(prev.firstCreatedMs, createdMs);
      if (!prev.name && name) prev.name = name;
      continue;
    }
    tally.set(key, { id, name, count: 1, firstCreatedMs: createdMs });
  }
  const ranked = [...tally.values()].sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    if (a.firstCreatedMs !== b.firstCreatedMs) return a.firstCreatedMs - b.firstCreatedMs;
    return (a.id || a.name).localeCompare(b.id || b.name);
  });
  const top = ranked[0];
  if (top) return { id: top.id, name: top.name, source: "task_owner" };

  const leadOwnerId = String(conv?.leadOwner?.id ?? "").trim();
  const leadOwnerName = cleanText(conv?.leadOwner?.name);
  if (leadOwnerId || leadOwnerName) {
    return { id: leadOwnerId, name: leadOwnerName, source: "lead_owner" };
  }
  return null;
}

export function evaluateStaffPingCooldown(args: {
  lastPingedAt?: string | null;
  nowMs: number;
  cooldownMinutes: number;
}): { allowed: boolean; minutesRemaining: number } {
  const lastMs = Date.parse(String(args.lastPingedAt ?? ""));
  if (!Number.isFinite(lastMs)) return { allowed: true, minutesRemaining: 0 };
  const cooldownMs = Math.max(0, args.cooldownMinutes) * 60_000;
  const elapsed = args.nowMs - lastMs;
  if (elapsed >= cooldownMs) return { allowed: true, minutesRemaining: 0 };
  return { allowed: false, minutesRemaining: Math.max(1, Math.ceil((cooldownMs - elapsed) / 60_000)) };
}

export function buildStaffPingMessage(args: {
  managerName: string;
  customerName: string;
  tasks: TodoTask[];
  link?: string | null;
  /** The manager's reason for poking. Rendered above the link so it survives a truncated preview. */
  note?: string | null;
}): string {
  const manager = cleanText(args.managerName) || "A manager";
  const customer = cleanText(args.customerName) || "a lead";
  const tasks = args.tasks ?? [];
  const lines: string[] = [];
  if (tasks.length) {
    lines.push(`LeadRider: ${manager} pinged you — ${customer}.`);
    for (const todo of tasks.slice(0, STAFF_PING_MAX_TASK_LINES)) {
      const summary = cleanText(todo?.summary).slice(0, SUMMARY_MAX_CHARS);
      lines.push(`• ${summary || "Open task"}`);
    }
    const extra = tasks.length - STAFF_PING_MAX_TASK_LINES;
    if (extra > 0) lines.push(`+${extra} more`);
  } else {
    // No open card on the thread — the manager still wants eyes on it (Joe default #3).
    lines.push(`LeadRider: ${manager} asked you to take a look at ${customer}.`);
  }
  // The manager's own words go ABOVE the link: a phone notification preview truncates from the
  // end, and the reason is the part the rep needs to see without opening anything.
  const note = normalizeStaffPingNote(args.note);
  if (note) lines.push(`Note: ${note}`);
  const link = cleanText(args.link);
  if (link) lines.push(`Open: ${link}`);
  return lines.join("\n");
}

export function decideStaffPing(args: {
  enabled: boolean;
  nowMs: number;
  cooldownMinutes: number;
  ownerRef: StaffPingOwnerRef | null;
  /** Resolved staff record for ownerRef; null when the name matches nobody in the user store. */
  target: { id?: string; name?: string; phone?: string } | null;
  lastPingedAt?: string | null;
  managerName: string;
  customerName: string;
  tasks: TodoTask[];
  link?: string | null;
  /** Optional manager reason, straight from the Ping dialog. Staff-facing only. */
  note?: string | null;
}): StaffPingDecision {
  if (!args.enabled) return { kind: "disabled" };
  if (!args.ownerRef) return { kind: "no_target" };

  const targetName =
    cleanText(args.target?.name) || cleanText(args.ownerRef.name) || "the assigned rep";
  const phone = String(args.target?.phone ?? "").trim();
  // No number on file can never succeed — say so plainly instead of hiding it behind a
  // cooldown or a silent no-op (Joe default #2).
  if (!phone) return { kind: "no_phone", targetName };

  const cooldown = evaluateStaffPingCooldown({
    lastPingedAt: args.lastPingedAt,
    nowMs: args.nowMs,
    cooldownMinutes: args.cooldownMinutes
  });
  if (!cooldown.allowed) {
    return {
      kind: "cooldown",
      targetName,
      minutesRemaining: cooldown.minutesRemaining,
      lastPingedAt: String(args.lastPingedAt ?? "")
    };
  }

  const note = normalizeStaffPingNote(args.note);
  return {
    kind: "send",
    targetId: String(args.target?.id ?? args.ownerRef.id ?? "").trim(),
    targetName,
    targetPhone: phone,
    message: buildStaffPingMessage({
      managerName: args.managerName,
      customerName: args.customerName,
      tasks: args.tasks,
      link: args.link,
      note
    }),
    taskIds: (args.tasks ?? []).map(t => String(t?.id ?? "").trim()).filter(Boolean),
    note
  };
}

/**
 * Build the audit record for a ping that was just attempted. Lives here, next to the type it
 * builds, so index.ts is not the place that decides what a ping record contains.
 */
export function buildStaffPingRecord(args: {
  nowIso: string;
  actorId?: string | null;
  managerName: string;
  decision: Extract<StaffPingDecision, { kind: "send" }>;
  delivered: boolean;
}): StaffPingRecord {
  return {
    at: args.nowIso,
    byUserId: String(args.actorId ?? "").trim() || undefined,
    byUserName: args.managerName,
    toUserId: args.decision.targetId || undefined,
    toUserName: args.decision.targetName,
    taskIds: args.decision.taskIds,
    delivered: args.delivered,
    note: args.decision.note || undefined
  };
}

/** Append a ping to the conversation's audit trail, keeping the newest N. */
export function appendStaffPingRecord(
  history: StaffPingRecord[] | undefined,
  record: StaffPingRecord,
  limit: number = STAFF_PING_HISTORY_LIMIT
): StaffPingRecord[] {
  const next = [...(history ?? []), record];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** When the rep on this thread was last pinged — drives the cooldown and the greyed button. */
export function lastStaffPingAt(history: StaffPingRecord[] | undefined): string | null {
  const delivered = (history ?? []).filter(r => r?.delivered && String(r?.at ?? "").trim());
  if (!delivered.length) return null;
  return delivered[delivered.length - 1].at;
}
