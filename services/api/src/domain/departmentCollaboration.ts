/**
 * Department collaboration — "bring Parts into this conversation" WITHOUT handing the lead over.
 * Pure + deterministic (conversation state + an authorization input; AGENTS.md allows deterministic
 * for side-effect/state transitions and invariant guards). Nothing here reads customer language.
 *
 * WHY THIS EXISTS (Joe, 2026-08-20). Christopher Szczesny (+17169400722) bought a Road Glide from
 * Scott, then texted the SAME thread: "looking for taillights to go between saddlebags and fender
 * have anything?" — a Parts question on a Sales lead. The only tool we had was
 * `POST /conversations/:id/department` ("Reassign lead" → Departments), which is a HANDOFF:
 *   - it overwrites `classification.bucket` with the department, so a sales lead BECOMES a parts
 *     lead for every downstream reader, and there is no way back;
 *   - it calls `setFollowUpMode(manual_handoff)` + `stopFollowUpCadence`, so the agent stops working
 *     the thread entirely.
 * Scott used neither. He typed the relay himself — 23 hours after the customer asked.
 *
 * So this is an INVITE, not a transfer. The lead owner, the lead's classification, and the follow-up
 * clock are all untouched; the invited department is simply ADDED, and can be handed back when done.
 *
 * FAIL DIRECTION, per field:
 *  - **Collaborator list**: purely additive state. Retiring it returns to today's handoff-or-nothing
 *    choice; it cannot invent a new customer-facing failure because it composes no customer text.
 *  - **Access (`listActiveCollaboratorDepartments` feeding `decideConversationAccess`)**: this WIDENS
 *    an authorization gate, so it is deliberately narrow — it grants exactly the departments a staff
 *    user with console access explicitly invited, and only to users whose ROLE is that department. It
 *    can never widen access for a salesperson, an unknown role, or an uninvited department.
 *  - **The prompt fence**: subtractive only. It can stop the composer asserting a parts/service fact;
 *    it can never make it go silent, close a lead, or suppress a side effect.
 *
 * WHY THE FOLLOW-UP CLOCK KEEPS RUNNING. Measured on this dealership: the failure mode of switching
 * the agent off is silence, not safety. Christopher's other thread (`+17169400722::2`) was born with
 * the agent switched off and sat 16.5 HOURS with zero outbound against a 3.0h p90 for its task class.
 * The stale-handoff report that would otherwise catch a parked department thread is not on a
 * schedule today, so there is no net underneath it either.
 *
 * WHY THE FENCE IS PROMPT-SIDE AND NOT A HOLD. Production runs in suggest mode — a human approves
 * every draft, nothing auto-sends — so a draft asserting a wrong part price is caught by the rep
 * before the customer ever sees it. The cost of a fenceless composer is the REP'S TIME, which is
 * exactly what the 2026-08-20 rework readout measured: the single largest cause of staff rewriting a
 * draft (~43% of them) is the agent stating a dealership fact it could not know — parts prices,
 * stock, order dates. Adding a second deterministic hold on top of human approval would add process
 * without removing work.
 */

export type CollaboratorDepartment = "service" | "parts" | "apparel";

export const COLLABORATOR_DEPARTMENTS: readonly CollaboratorDepartment[] = [
  "service",
  "parts",
  "apparel"
] as const;

export type DepartmentCollaborator = {
  department: CollaboratorDepartment;
  /** Who brought them in — a staff user, never the customer. */
  invitedByUserId?: string;
  invitedByName?: string;
  invitedAt: string;
  /** What they were brought in FOR, in the inviting rep's words. Shown in the thread + the todo. */
  note?: string;
  /** Set when the department hands the thread back; an entry with this set is no longer active. */
  handedBackAt?: string;
  handedBackByName?: string;
  /**
   * DELIVERY state of the staff notification, recorded by the caller after it tries to send.
   * `notifiedCount: 0` means the invite reached NOBODY — the state a repeat invite must be allowed
   * to retry. Absent on entries written before 2026-08-20 (treated as "never attempted").
   */
  notifiedAt?: string;
  notifiedCount?: number;
};

export function isCollaboratorDepartment(value: unknown): value is CollaboratorDepartment {
  const v = String(value ?? "").trim().toLowerCase();
  return (COLLABORATOR_DEPARTMENTS as readonly string[]).includes(v);
}

function normalizeList(collaborators: unknown): DepartmentCollaborator[] {
  if (!Array.isArray(collaborators)) return [];
  return collaborators.filter(
    (c): c is DepartmentCollaborator => !!c && typeof c === "object" && isCollaboratorDepartment((c as any).department)
  );
}

export function isCollaboratorActive(entry: DepartmentCollaborator | null | undefined): boolean {
  if (!entry) return false;
  return !String(entry.handedBackAt ?? "").trim();
}

/**
 * The departments currently sitting in this conversation. Order-stable (invite order) and
 * de-duplicated, so it is safe to render and safe to compare in an eval.
 */
export function listActiveCollaboratorDepartments(collaborators: unknown): CollaboratorDepartment[] {
  const seen = new Set<CollaboratorDepartment>();
  const out: CollaboratorDepartment[] = [];
  for (const entry of normalizeList(collaborators)) {
    if (!isCollaboratorActive(entry)) continue;
    const dept = String(entry.department).trim().toLowerCase() as CollaboratorDepartment;
    if (seen.has(dept)) continue;
    seen.add(dept);
    out.push(dept);
  }
  return out;
}

export type BringInResult = {
  collaborators: DepartmentCollaborator[];
  /** A NEW collaborator entry was appended (the department was not already in the thread). */
  added: boolean;
  /**
   * The caller MUST attempt the staff notification. True for a new invite, and ALSO true when the
   * department is already active but its last attempt reached nobody.
   *
   * WHY THIS IS SEPARATE FROM `added` (live defect, 2026-08-20, first real use of this feature):
   * the guard used to return on `added === false` ABOVE the notify block, so a notification that
   * failed could never be retried by clicking again — permanently. Joe invited Parts for Christopher
   * Szczesny (+17169400722) seconds after a deploy restart; both texts died on a transient Twilio
   * module error, `notified: 0` was recorded, and his second click was silently a no-op. The task
   * and the shared thread are the parts that ARE already durable; the TEXT is the part a repeat
   * click can never recover. An idempotency guard must key on the side effect that can FAIL, not on
   * the state that already succeeded.
   */
  shouldNotify: boolean;
  /**
   * The caller MUST file the department's task. True for a new invite, and ALSO true when the
   * department is already in the thread but has NO open task any more.
   *
   * THE SAME LESSON AS `shouldNotify`, second instance (live defect, 2026-08-22, +17163164302
   * Robert Guarino): the task is not permanent state either. The fulfillment judge closed Robert's
   * Parts task 54 seconds after Joe filed it, and because this function reported a flat no-op on an
   * already-active department, clicking "bring in Parts" again could never restore it — the one
   * recovery Joe had was gone, and the thread was invisible to Brandon with the invite still showing
   * as active. An idempotency guard must key on the side effect that can DISAPPEAR, not on the state
   * that already succeeded.
   */
  shouldFileTask: boolean;
};

/**
 * Bring a department in. Idempotent on purpose: inviting Parts twice must not mint a SECOND todo
 * beside a live one or text Brandon again, so a repeat invite while both side effects still exist is
 * a no-op that reports `added: false`. Re-inviting AFTER a hand-back is a genuinely new request and
 * does add an entry. `hasOpenDepartmentTask` is what the caller knows and this function cannot: it is
 * asked, not assumed, because "already invited" and "still has a task" stopped being the same thing
 * the day something else closed the task.
 */
export function bringInDepartment(
  collaborators: unknown,
  input: {
    department: CollaboratorDepartment;
    invitedByUserId?: string | null;
    invitedByName?: string | null;
    note?: string | null;
    at: string;
    /** Does an OPEN task for this department exist on the thread right now? */
    hasOpenDepartmentTask?: boolean;
  }
): BringInResult {
  const list = normalizeList(collaborators);
  const department = String(input.department).trim().toLowerCase() as CollaboratorDepartment;
  if (!isCollaboratorDepartment(department)) {
    return { collaborators: list, added: false, shouldNotify: false, shouldFileTask: false };
  }
  if (listActiveCollaboratorDepartments(list).includes(department)) {
    // Already in the thread: never append a second entry. But the two side effects that can go away
    // on their own are still owed — a notification that reached NOBODY, and a task that no longer
    // exists.
    const active = list.filter(e => isCollaboratorActive(e) && e.department === department);
    const everReached = active.some(e => Number(e.notifiedCount ?? 0) > 0);
    return {
      collaborators: list,
      added: false,
      shouldNotify: !everReached,
      shouldFileTask: input.hasOpenDepartmentTask === false
    };
  }
  const entry: DepartmentCollaborator = {
    department,
    invitedAt: String(input.at),
    invitedByUserId: String(input.invitedByUserId ?? "").trim() || undefined,
    invitedByName: String(input.invitedByName ?? "").trim() || undefined,
    note: String(input.note ?? "").trim() || undefined
  };
  return { collaborators: [...list, entry], added: true, shouldNotify: true, shouldFileTask: true };
}

/**
 * Record what the notification attempt actually achieved, on every ACTIVE entry for that department.
 * Pure. `notified` is the number of staff who were successfully texted; 0 is a meaningful value and
 * is exactly what makes the next invite retry instead of no-op.
 */
export function recordDepartmentNotification(
  collaborators: unknown,
  input: { department: CollaboratorDepartment; notified: number; at: string }
): DepartmentCollaborator[] {
  const list = normalizeList(collaborators);
  const department = String(input.department).trim().toLowerCase() as CollaboratorDepartment;
  const notified = Number.isFinite(input.notified) ? Math.max(0, Math.trunc(input.notified)) : 0;
  return list.map(entry =>
    isCollaboratorActive(entry) && entry.department === department
      ? { ...entry, notifiedAt: String(input.at), notifiedCount: notified }
      : entry
  );
}

export type HandBackResult = {
  collaborators: DepartmentCollaborator[];
  /** False when that department was not in the thread — nothing to hand back. */
  handedBack: boolean;
};

/** Hand the thread back to the lead owner. Closes every active entry for that department. */
export function handBackDepartment(
  collaborators: unknown,
  input: { department: CollaboratorDepartment; handedBackByName?: string | null; at: string }
): HandBackResult {
  const list = normalizeList(collaborators);
  const department = String(input.department).trim().toLowerCase() as CollaboratorDepartment;
  if (!listActiveCollaboratorDepartments(list).includes(department)) {
    return { collaborators: list, handedBack: false };
  }
  const handedBackByName = String(input.handedBackByName ?? "").trim() || undefined;
  const next = list.map(entry =>
    isCollaboratorActive(entry) && entry.department === department
      ? { ...entry, handedBackAt: String(input.at), handedBackByName }
      : entry
  );
  return { collaborators: next, handedBack: true };
}

const DEPARTMENT_SUBJECT_LABEL: Record<CollaboratorDepartment, string> = {
  service: "service work (repairs, diagnostics, labour, shop scheduling)",
  parts: "parts and accessories (fitment, part numbers, stock, order times)",
  apparel: "apparel and MotorClothes (sizes, stock, what's on the rack)"
};

/**
 * The composer fence. While a department is sitting in the thread, the agent may hold the customer's
 * place — and must not answer FOR that department, because we have no parts catalog, no pricing, and
 * no service scheduling data anywhere in the system (`partsCatalogLexicon.ts` is a word list for
 * RECOGNIZING these questions, not a catalog). Wording mirrors the already-proven HARD RULES in
 * `buildDepartmentHandoffAckWithLLM`, which was written for exactly this no-DMS constraint.
 *
 * Returns "" when no department is engaged, so the prompt is byte-identical to today on every other
 * thread — the property the eval pins.
 */
export function buildDepartmentCollaborationPromptBlock(
  activeDepartments: readonly CollaboratorDepartment[] | null | undefined
): string {
  const departments = (activeDepartments ?? []).filter(isCollaboratorDepartment);
  if (!departments.length) return "";
  const names = departments.map(d => d.toUpperCase()).join(" + ");
  const subjects = departments.map(d => `- ${DEPARTMENT_SUBJECT_LABEL[d]}`).join("\n");
  return `
DEPARTMENT IN THE THREAD (${names}) — a teammate from ${names} has been brought into THIS conversation and is handling their part of it:
- You may acknowledge the customer and tell them ${names} is on it and will follow up. Keep their place; do not leave them hanging.
- You must NOT answer for ${names}. Never state or imply a price, dollar amount, estimate, part number, fitment, availability, stock, ETA, lead time, or appointment slot for:
${subjects}
- You do NOT have this data — there is no parts catalog, pricing, or service schedule available to you. Anything you state here would be invented.
- Keep answering everything OUTSIDE their subject exactly as you normally would; the rest of the conversation is still yours.
`;
}
