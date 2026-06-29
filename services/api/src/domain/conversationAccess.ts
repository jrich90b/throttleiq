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
 */

export type ConversationAccessInput = {
  role: string;
  canViewAllLeads: boolean;
  canViewAllTasks: boolean;
  isLeadOwner: boolean;
  hasOwner: boolean; // the lead has SOME owner assigned (vs the unassigned shared pool)
  department: string | null; // "service" | "parts" | "apparel" for departmental leads; null/"" = sales
  hasOpenTodo: boolean; // used only with canViewAllTasks
};

export function decideConversationAccess(input: ConversationAccessInput): boolean {
  const role = String(input.role ?? "").toLowerCase();
  const dept = String(input.department ?? "").toLowerCase();

  if (role === "manager") return true;
  if (input.canViewAllLeads) return true;
  if (input.canViewAllTasks && input.hasOpenTodo) return true;
  if (input.isLeadOwner) return true;

  // Departmental staff see only their own department's leads.
  if (role === "service" || role === "parts" || role === "apparel") {
    return dept === role;
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
