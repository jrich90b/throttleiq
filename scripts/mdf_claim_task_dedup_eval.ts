/**
 * MDF claim-task dedup eval (deterministic — no LLM, no browser, no store I/O).
 *
 * Pins the idempotent-create guard for "Start portal draft"
 * (findActivePortalDraftTask / shouldCreatePortalDraftTask in
 * services/api/src/domain/agentTaskStore.ts, applied in POST
 * /mdf/claims/:id/portal-task). Origin (2026-07-17): THREE identical portal-draft
 * tasks were created for ONE claim within 10 minutes (claim mdf_498ac7ea88726 —
 * tasks at 13:53 / 14:03:04 / 14:03:14; the last two 10 seconds apart, a
 * double-click), inflating the anomaly feed 3x and, had the session been live,
 * risking two runners racing the same Ansira form.
 *
 * The guard must (a) block a duplicate while a task for the claim is ACTIVE —
 * queued/running, or needs_approval that has NOT run yet (no run output), mirroring
 * the runner's run-once pick rule in scripts/mdf_portal_runner.ts chooseTask —
 * (b) NEVER block a legitimate fresh Start: after a terminal task
 * (completed/failed/blocked), after a finished run awaiting review (needs_approval
 * WITH output), for a different claim, or for non-portal task kinds, and
 * (c) attach to the newest active task so the console shows the one the runner
 * will actually pick.
 */
import assert from "node:assert/strict";

const { findActivePortalDraftTask, mdfPortalClaimMarker, shouldCreatePortalDraftTask } = await import(
  "../services/api/src/domain/agentTaskStore.ts"
);

const CLAIM = "mdf_498ac7ea88726";
const OTHER_CLAIM = "mdf_0ther111";

type Snap = {
  id: string;
  kind: string;
  status: string;
  instructions: string;
  output?: { summary?: string | null } | null;
};

function portalTask(partial: Partial<Snap> & { id: string }): Snap {
  return {
    kind: "mdf_portal",
    status: "needs_approval",
    instructions: `${mdfPortalClaimMarker(CLAIM)}\nUse browser-use or logged-in Chrome browser control to prepare an H-D MDF portal draft.`,
    ...partial
  };
}

// The marker matches what the endpoint writes and what both runners parse
// (index.ts mdfPortalClaimIdFromTask, mdf_portal_runner.ts claimIdFromTask).
assert.equal(mdfPortalClaimMarker(CLAIM), `[mdf-portal:${CLAIM}]`, "marker shape matches the instruction format");

// 1) Empty store → create.
assert.equal(shouldCreatePortalDraftTask([], CLAIM), true, "no tasks at all → create");
assert.equal(findActivePortalDraftTask([], CLAIM), null, "no tasks at all → nothing to attach to");

// 2) THE 7/17 incident: a fresh needs_approval task (no run output — the state a
//    just-created portal task sits in) blocks the double-click AND the re-press.
const fresh = portalTask({ id: "agent_first" });
assert.equal(shouldCreatePortalDraftTask([fresh], CLAIM), false, "a pending (not-yet-run) needs_approval task blocks a duplicate");
assert.equal(findActivePortalDraftTask([fresh], CLAIM)?.id, "agent_first", "the duplicate press attaches to the existing task");
// Second press 10s later, third press — still the same single task.
assert.equal(findActivePortalDraftTask([fresh], CLAIM)?.id, "agent_first", "a triple-press still resolves to one task");

// 3) queued (approval granted, waiting for the runner) is active.
assert.equal(
  shouldCreatePortalDraftTask([portalTask({ id: "agent_q", status: "queued" })], CLAIM),
  false,
  "a queued task blocks a duplicate"
);

// 4) running (an in-flight run — the racing-two-runners risk) is active, even
//    though the runner has stamped output ("MDF portal runner started.").
assert.equal(
  shouldCreatePortalDraftTask(
    [portalTask({ id: "agent_r", status: "running", output: { summary: "MDF portal runner started." } })],
    CLAIM
  ),
  false,
  "a running task blocks a duplicate"
);

// 5) needs_approval WITH run output = post-run review; the runner will never pick
//    it again (run-once rule), so a fresh Start MUST be allowed.
assert.equal(
  shouldCreatePortalDraftTask(
    [
      portalTask({
        id: "agent_done",
        status: "needs_approval",
        output: { summary: "MDF portal draft run completed. Review the portal before any final submit." }
      })
    ],
    CLAIM
  ),
  true,
  "a finished run awaiting review does not block a re-run"
);

// 6) Terminal states never block — a retry after a failure stays one click. This is
//    the 7/17 session-expired flow: blocked task → operator logs in → Start again.
for (const status of ["completed", "failed", "blocked"]) {
  assert.equal(
    shouldCreatePortalDraftTask(
      [portalTask({ id: `agent_${status}`, status, output: { summary: "The MDF runner hit the Ansira/H-DNet sign-in screen." } })],
      CLAIM
    ),
    true,
    `a ${status} task does not block a fresh Start`
  );
}

// 7) An active task for a DIFFERENT claim never blocks this one.
assert.equal(
  shouldCreatePortalDraftTask(
    [portalTask({ id: "agent_other", instructions: `${mdfPortalClaimMarker(OTHER_CLAIM)}\nprepare draft` })],
    CLAIM
  ),
  true,
  "an active task for another claim does not block"
);

// 8) Non-portal kinds — including the H-DNet login opener task ([mdf-login]) and an
//    email task that happens to mention the claim id — never block.
assert.equal(
  shouldCreatePortalDraftTask(
    [
      { id: "agent_login", kind: "mdf_portal", status: "needs_approval", instructions: "[mdf-login]\nOpen https://h-dnet.com" },
      { id: "agent_mail", kind: "email", status: "queued", instructions: `${mdfPortalClaimMarker(CLAIM)} follow up on the claim` }
    ],
    CLAIM
  ),
  true,
  "login-opener and non-portal kinds never block a portal-draft create"
);

// 9) Newest-first attach: with an old finished task and a new pending one, the
//    pending one wins (listAgentTasks returns newest first).
const newestFirst = [
  portalTask({ id: "agent_new_pending" }),
  portalTask({ id: "agent_old_done", output: { summary: "MDF portal draft run completed." } })
];
assert.equal(findActivePortalDraftTask(newestFirst, CLAIM)?.id, "agent_new_pending", "attaches to the newest ACTIVE task");

// 10) Degenerate inputs fail toward creating (the endpoint's 404 guard owns bad
//     claim ids; the dedup must never wedge creation shut on garbage).
assert.equal(shouldCreatePortalDraftTask([portalTask({ id: "agent_x" })], ""), true, "empty claim id never dedups");
assert.equal(
  shouldCreatePortalDraftTask([{ id: "agent_junk", kind: "mdf_portal", status: "queued", instructions: "" }], CLAIM),
  true,
  "a portal task with no claim marker never blocks"
);

console.log("PASS mdf claim task dedup eval");
