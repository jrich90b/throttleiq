/**
 * Conversation access matrix eval.
 *
 * Pins decideConversationAccess (domain/conversationAccess.ts) — the authorization rule for "can this
 * staff user see this conversation". The headline fix (Joe, 2026-06-29): a salesperson WITHOUT
 * canViewAllLeads must NOT see another salesperson's assigned leads (Giovanni's inbox was flooded with
 * the whole team's pipeline). A salesperson sees their OWN leads + the UNASSIGNED shared pool only.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const { decideConversationAccess } = await import("../services/api/src/domain/conversationAccess.ts");

const base = {
  role: "salesperson",
  canViewAllLeads: false,
  canViewAllTasks: false,
  isLeadOwner: false,
  hasOwner: false,
  department: null as string | null,
  hasOpenTodo: false,
  activeCollaboratorDepartments: [] as string[]
};
const can = (over: Partial<typeof base>) => decideConversationAccess({ ...base, ...over });
let n = 0;
const eq = (got: boolean, exp: boolean, m: string) => { assert.equal(got, exp, m); n++; };

// ── THE FIX: a plain salesperson and another rep's assigned lead.
eq(can({ role: "salesperson", hasOwner: true, isLeadOwner: false }), false,
  "salesperson, NOT owner, lead owned by someone else => HIDDEN (no flooding)");
eq(can({ role: "salesperson", hasOwner: false }), true,
  "salesperson, UNASSIGNED lead (shared pool) => visible (no black hole)");
eq(can({ role: "salesperson", isLeadOwner: true, hasOwner: true }), true,
  "salesperson, their OWN lead => visible");

// ── canViewAllLeads restores full visibility for a salesperson.
eq(can({ role: "salesperson", canViewAllLeads: true, hasOwner: true, isLeadOwner: false }), true,
  "salesperson + canViewAllLeads => sees another rep's lead");

// ── Manager always sees everything.
eq(can({ role: "manager", hasOwner: true, department: "service" }), true, "manager => all leads incl. dept");

// ── canViewAllTasks grants access only to conversations with an open todo.
eq(can({ role: "salesperson", canViewAllTasks: true, hasOwner: true, hasOpenTodo: true }), true,
  "canViewAllTasks + open todo => visible even if owned by another rep");
eq(can({ role: "salesperson", canViewAllTasks: true, hasOwner: true, hasOpenTodo: false }), false,
  "canViewAllTasks but NO open todo => still hidden (other rep's lead)");

// ── Departmental staff see only their own department.
eq(can({ role: "service", department: "service" }), true, "service sees service leads");
eq(can({ role: "service", department: "parts" }), false, "service does NOT see parts leads");
eq(can({ role: "service", department: null }), false, "service does NOT see general sales leads");
eq(can({ role: "salesperson", department: "service", hasOwner: false }), false,
  "salesperson does NOT see departmental leads (even unassigned)");

// ── Owner of a departmental lead still sees it (ownership wins).
eq(can({ role: "salesperson", isLeadOwner: true, department: "service" }), true,
  "owner sees their lead regardless of department");

// ── INVITED DEPARTMENTS (Joe, 2026-08-20): a SALES lead a department was brought into.
// Christopher Szczesny (+17169400722): Scott's sold sales lead, Parts invited for a taillight ask.
eq(can({ role: "parts", department: null, hasOwner: true, activeCollaboratorDepartments: ["parts"] }), true,
  "invited parts staff SEE the sales thread they were brought into");
eq(can({ role: "parts", department: null, hasOwner: true, activeCollaboratorDepartments: [] }), false,
  "parts staff do NOT see a sales thread they were not invited to (unchanged)");
eq(can({ role: "service", department: null, hasOwner: true, activeCollaboratorDepartments: ["parts"] }), false,
  "an invite for PARTS does not let SERVICE in");
eq(can({ role: "parts", department: null, hasOwner: true, activeCollaboratorDepartments: ["PARTS"] }), true,
  "collaborator matching is case-insensitive");

// The invite must not leak into any OTHER branch — this is a widening of an authorization gate.
eq(can({ role: "salesperson", hasOwner: true, isLeadOwner: false, activeCollaboratorDepartments: ["parts"] }), false,
  "a parts invite does NOT expose another rep's lead to a salesperson");
eq(can({ role: "salesperson", department: "service", hasOwner: false, activeCollaboratorDepartments: ["parts"] }), false,
  "a parts invite does NOT give a salesperson a departmental lead");

// Handing back revokes it: an inactive collaborator is absent from the list the caller passes.
eq(can({ role: "parts", department: null, hasOwner: true, activeCollaboratorDepartments: [] }), false,
  "after hand-back (no active collaborators) parts loses access again");

// Omitting the field entirely must reproduce the pre-invite matrix exactly.
eq(decideConversationAccess({ ...base, role: "parts", department: "parts" }), true,
  "field omitted: departmental staff still see their own department's leads");

// ── Source pin: the HTTP gate delegates to the pure decision.
const idx = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
assert.match(
  idx,
  /function canUserAccessConversation[\s\S]{0,800}return decideConversationAccess\(/,
  "canUserAccessConversation must delegate to decideConversationAccess"
);
// And the old blanket salesperson grant must be gone.
assert.doesNotMatch(idx, /if \(role === "salesperson"\) return !dept;/, "the old blanket salesperson grant must be removed");
// The gate must actually FEED the collaborator list — a widened rule nobody passes inputs to is inert.
assert.match(
  idx,
  /return decideConversationAccess\(\{[\s\S]{0,400}activeCollaboratorDepartments: listActiveCollaboratorDepartments\(/,
  "canUserAccessConversation must pass the conversation's active collaborator departments"
);

console.log(`PASS conversation access eval (${n} assertions)`);
