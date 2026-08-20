/**
 * Conversation access decision — the single, legible, eval-pinned matrix for "can this staff user see
 * this conversation". Pure + deterministic (an authorization invariant; AGENTS.md allows deterministic
 * for safety gates). The HTTP layer (canUserAccessConversation in index.ts) computes the inputs and
 * delegates here so the rule is testable in isolation and can't drift across the list endpoint, the
 * single-conversation middleware, and the other gated routes that all share it.
 *
 * Salesperson visibility (Joe, 2026-06-29): a salesperson should NOT have their inbox flooded with the
 * rest of the team's pipeline. So a salesperson sees their OWN leads + the UNASSIGNED shared pool, but
 * never a lead already owned by ANOTHER salesperson. canViewAllLeads restores full visibility. The
 * unassigned pool stays visible to everyone so a brand-new/unclaimed lead is never hidden from the whole
 * sales floor (no lead black hole).
 *
 * Invited departments (Joe, 2026-08-20): a SALES lead can have a department brought INTO it without
 * being handed over — a sold customer asking Parts about taillights on the thread his salesperson
 * owns (`domain/departmentCollaboration.ts`). The invited department must be able to read that
 * thread, so `activeCollaboratorDepartments` widens the departmental branch ONLY. It is deliberately
 * the narrowest widening that works: it grants a user whose ROLE is that department access to a
 * thread a console user explicitly invited them to, and it is reachable from no other branch — a
 * salesperson, a manager-less unknown role, and an uninvited department are all decided exactly as
 * before. The lead's own `department` is NOT set by an invite, which is what keeps the lead a sales
 * lead everywhere else in the system.
 */

export type ConversationAccessInput = {
  role: string;
  canViewAllLeads: boolean;
  canViewAllTasks: boolean;
  isLeadOwner: boolean;
  hasOwner: boolean; // the lead has SOME owner assigned (vs the unassigned shared pool)
  department: string | null; // "service" | "parts" | "apparel" for departmental leads; null/"" = sales
  hasOpenTodo: boolean; // used only with canViewAllTasks
  /**
   * Departments currently brought into this conversation as collaborators (never set by classification
   * — only by an explicit console invite). Absent/empty on every thread that has not been invited to,
   * which is why omitting it reproduces the pre-2026-08-20 matrix exactly.
   */
  activeCollaboratorDepartments?: readonly string[] | null;
};

export function decideConversationAccess(input: ConversationAccessInput): boolean {
  const role = String(input.role ?? "").toLowerCase();
  const dept = String(input.department ?? "").toLowerCase();

  if (role === "manager") return true;
  if (input.canViewAllLeads) return true;
  if (input.canViewAllTasks && input.hasOpenTodo) return true;
  if (input.isLeadOwner) return true;

  // Departmental staff see their own department's leads, plus any thread their department was
  // explicitly invited into. Both are "this is your department's work"; only the second one leaves
  // the lead itself in sales.
  if (role === "service" || role === "parts" || role === "apparel") {
    if (dept === role) return true;
    return (input.activeCollaboratorDepartments ?? []).some(d => String(d ?? "").toLowerCase() === role);
  }

  // Salesperson (not the owner — owner already returned above): department leads belong to that
  // department; for sales leads, show ONLY the unassigned shared pool, never another rep's assigned lead.
  if (role === "salesperson") {
    if (dept) return false;
    return !input.hasOwner;
  }

  // Unknown role: conservative legacy default (visible). Narrow later if a new role is added.
  return true;
}
