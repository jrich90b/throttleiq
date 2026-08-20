/**
 * "Bring in a department" eval — the INVITE, not the handoff.
 *
 * Pins domain/departmentCollaboration.ts plus the four wiring facts that make it different from
 * `POST /conversations/:id/department`. Joe, 2026-08-20, from Christopher Szczesny (+17169400722):
 * a sold SALES lead whose customer asked Scott for taillights. The handoff we already had would
 * have re-labelled his lead as parts, switched the agent off, and — because addTodo drops every
 * non-"call" task on a post_sale lead — filed no task at all. Scott typed the relay himself, 23h
 * later.
 *
 * Every assertion here is either an EXECUTION of the pure logic or a wiring pin that would go red
 * if someone reintroduced the handoff behaviour. The three source pins exist because the difference
 * between an invite and a handoff is precisely a set of calls that are ABSENT — and an absence is
 * exactly what a behavioural test cannot see.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const {
  bringInDepartment,
  handBackDepartment,
  listActiveCollaboratorDepartments,
  isCollaboratorDepartment,
  buildDepartmentCollaborationPromptBlock
} = await import("../services/api/src/domain/departmentCollaboration.ts");

let n = 0;
const ok = (cond: boolean, m: string) => { assert.ok(cond, m); n++; };
const eq = (got: unknown, exp: unknown, m: string) => { assert.deepEqual(got, exp, m); n++; };

const T1 = "2026-08-20T15:00:00.000Z";
const T2 = "2026-08-20T18:00:00.000Z";
const T3 = "2026-08-21T15:00:00.000Z";

// ── Lifecycle ────────────────────────────────────────────────────────────────
eq(listActiveCollaboratorDepartments(undefined), [], "no collaborators on an untouched thread");
eq(listActiveCollaboratorDepartments(null), [], "null tolerated (old stored conversations)");
eq(listActiveCollaboratorDepartments([{ department: "nonsense" }]), [], "junk department ignored");

const invited = bringInDepartment(undefined, {
  department: "parts",
  invitedByName: "Scott Hartrich",
  note: "taillights between saddlebags and fender",
  at: T1
});
ok(invited.added, "bringing parts in reports added");
eq(listActiveCollaboratorDepartments(invited.collaborators), ["parts"], "parts is now active");
eq(invited.collaborators[0].note, "taillights between saddlebags and fender", "the ask is carried");
eq(invited.collaborators[0].invitedByName, "Scott Hartrich", "who brought them in is carried");

// Idempotent: a second click must not mint a second task or re-text the department.
const again = bringInDepartment(invited.collaborators, { department: "parts", at: T2 });
ok(!again.added, "re-inviting an ALREADY ACTIVE department is a no-op (no duplicate notify)");
eq(again.collaborators.length, 1, "…and does not append a second entry");

// A second, different department can sit in the thread at the same time.
const two = bringInDepartment(invited.collaborators, { department: "service", at: T2 });
ok(two.added, "a different department can also be brought in");
eq(listActiveCollaboratorDepartments(two.collaborators), ["parts", "service"], "both active, invite order");

// Hand back closes exactly one department.
const handed = handBackDepartment(two.collaborators, { department: "parts", handedBackByName: "Brandon Hartsch", at: T3 });
ok(handed.handedBack, "handing parts back reports handedBack");
eq(listActiveCollaboratorDepartments(handed.collaborators), ["service"], "only parts left; service still in");
ok(
  handed.collaborators.some(c => c.department === "parts" && c.handedBackAt === T3 && c.handedBackByName === "Brandon Hartsch"),
  "the handed-back entry is RETAINED as history, not deleted"
);
const noop = handBackDepartment(handed.collaborators, { department: "parts", at: T3 });
ok(!noop.handedBack, "handing back a department that is not in the thread is a no-op");

// Re-inviting AFTER a hand-back is a genuinely new request and must go through.
const reinvited = bringInDepartment(handed.collaborators, { department: "parts", note: "wrong part came in", at: T3 });
ok(reinvited.added, "parts can be brought back in after a hand-back");
eq(listActiveCollaboratorDepartments(reinvited.collaborators), ["service", "parts"], "parts active again");

ok(isCollaboratorDepartment("parts") && isCollaboratorDepartment("SERVICE"), "department names are case-insensitive");
ok(!isCollaboratorDepartment("sales") && !isCollaboratorDepartment(""), "sales is not a collaborator department");

// ── The composer fence ───────────────────────────────────────────────────────
eq(buildDepartmentCollaborationPromptBlock([]), "", "NO department engaged => empty block (prompt unchanged)");
eq(buildDepartmentCollaborationPromptBlock(null), "", "null => empty block");
const fence = buildDepartmentCollaborationPromptBlock(["parts"]);
ok(fence.includes("PARTS"), "the fence names the department that is in the thread");
for (const forbidden of ["price", "availability", "fitment", "ETA", "appointment"]) {
  ok(fence.toLowerCase().includes(forbidden.toLowerCase()), `the fence forbids stating ${forbidden}`);
}
ok(
  /may acknowledge/i.test(fence),
  "the fence still lets the agent hold the customer's place — it must not go silent (16.5h, +17169400722::2)"
);
ok(
  /outside their subject/i.test(fence),
  "the fence is scoped: the rest of the conversation is still the agent's"
);

// ── Wiring pin 1: the invite must NOT behave like the handoff ────────────────
// Both live in routes/departmentCollaboration.ts, so the contrast is readable in one file: the
// handoff DOES stop the agent and rewrite classification; the invite must do neither.
const idx = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
const routes = await fs.readFile(path.resolve("services/api/src/routes/departmentCollaboration.ts"), "utf8");
const bringInStart = routes.indexOf('app.post("/conversations/:id/bring-in-department"');
assert.ok(bringInStart > 0, "the bring-in endpoint must exist");
const bringInEnd = routes.indexOf('app.post("/conversations/:id/hand-back-department"', bringInStart);
assert.ok(bringInEnd > bringInStart, "the hand-back endpoint must exist after it");
const bringInBody = routes.slice(bringInStart, bringInEnd);

// The handoff is still a handoff — if this ever stops being true the two endpoints have collapsed
// into one and the invite has silently inherited (or lost) the wrong behaviour.
const handoffBody = routes.slice(
  routes.indexOf('app.post("/conversations/:id/department"'),
  bringInStart
);
assert.ok(handoffBody.length > 0, "the department handoff endpoint must still exist");
assert.match(handoffBody, /stopFollowUpCadence\(/, "the HANDOFF still stops the agent (that is its job)");
assert.match(handoffBody, /conv\.classification\s*=/, "the HANDOFF still re-labels the lead (that is its job)");
n += 2;

// THE POINT OF THE FEATURE: the agent keeps working the thread. Switching it off is what produced
// 16.5 hours of silence on this lead's other thread, and the stale-handoff sweep is not scheduled.
for (const banned of ["stopFollowUpCadence", "stopRelatedCadences", "setFollowUpMode"]) {
  assert.doesNotMatch(
    bringInBody,
    new RegExp(`\\b${banned}\\s*\\(`),
    `bring-in must NOT call ${banned} — an invite keeps the follow-up clock running (that is the whole feature)`
  );
  n++;
}
// And it must not re-label the lead: the sales lead stays a sales lead everywhere downstream.
assert.doesNotMatch(bringInBody, /conv\.classification\s*=/, "bring-in must NOT rewrite conv.classification");
assert.doesNotMatch(bringInBody, /conv\.leadOwner\s*=/, "bring-in must NOT reassign the lead owner");
n += 2;

// Wiring pin 2: the sold-lead trap. addTodo returns null for a non-"call" task on a post_sale lead,
// which is EXACTLY Christopher's thread (sale.soldAt 8/14, cadence post_sale). Without allowSoldLead
// the invite silently files nothing and the department never learns it was invited.
assert.match(
  bringInBody,
  /addTodo\([\s\S]{0,200}allowSoldLead:\s*true/,
  "bring-in must pass allowSoldLead — a sold customer asking about accessories is the whole use case"
);
n++;

// Wiring pin 3: two-path parity. The fence has to reach the composer from BOTH the live webhook and
// regenerate, or a regenerated draft would freelance on parts pricing where a live one would not.
const activeDeptCallSites = idx.match(/activeDepartments:\s*listActiveCollaboratorDepartments\(/g) ?? [];
assert.ok(
  activeDeptCallSites.length >= 2,
  `activeDepartments must be passed from BOTH the live and regenerate orchestrator calls (found ${activeDeptCallSites.length})`
);
n++;

// Wiring pin 4: the composer must actually consume it — a fence nobody injects is inert.
const draft = await fs.readFile(path.resolve("services/api/src/domain/llmDraft.ts"), "utf8");
assert.match(
  draft,
  /\$\{hardshipRules\}\$\{buildDepartmentCollaborationPromptBlock\(ctx\.activeDepartments\)\}/,
  "the composer must build the fence from ctx.activeDepartments AND inject it into the instructions"
);
n++;

console.log(`PASS bring in department eval (${n} assertions)`);
