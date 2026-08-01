/**
 * held_draft_release:eval — one referee for releasing a "being fixed" hold.
 *
 * `draftHeld` was SET in one place but CLEARED in six, each patched separately after its own
 * incident (the conversationStore comments still name Nicholas Braun 2026-06-24 and s R Gurajala
 * 2026-06-25). Two of them disagreed on the same trigger: the appendOutbound site released ONLY a
 * `context_fidelity` hold, the console-send site released ANY hold. So a draft-quality hold survived
 * a real reply on one path and the card never cleared — live on 2026-08-01 as
 * "draft is stuck on being fixed" (+17167134728) and "says the ai's draft is being fixed, but no fix
 * happened" (+17164785613).
 *
 * FAIL DIRECTION: releasing costs nothing customer-facing — the marker is staff-only UI and clearing
 * it does NOT restore the withheld draft. Leaving it stuck hides a live lead behind a permanent
 * "being fixed" card. So ambiguity releases; only an AI re-publish and an internal log never do.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { decideHeldDraftRelease, isRealReplyProvider } from "../services/api/src/domain/routeStateReducer.ts";

// Nothing held => nothing to release, whatever happens.
for (const kind of [null, undefined, ""]) {
  assert.equal(
    decideHeldDraftRelease({ heldKind: kind as any, event: "real_reply" }).release,
    false,
    "no hold => nothing to release"
  );
}

// THE FIGHT THIS FIXES: a real reply releases EVERY kind of hold, not just context_fidelity.
for (const kind of ["context_fidelity", "draft_quality", "draft_truncated", "something_new"]) {
  assert.equal(
    decideHeldDraftRelease({ heldKind: kind, event: "real_reply" }).release,
    true,
    `a real reply releases a ${kind} hold (the appendOutbound site used to release only context_fidelity)`
  );
}

// The other legitimate releases.
assert.equal(decideHeldDraftRelease({ heldKind: "draft_quality", event: "operator_draft" }).release, true);
assert.equal(decideHeldDraftRelease({ heldKind: "draft_quality", event: "ai_draft_passed" }).release, true);
assert.equal(decideHeldDraftRelease({ heldKind: "draft_quality", event: "escalated_to_human" }).release, true);

// THE ONE THAT MUST NEVER RELEASE: the same AI marking its own homework.
assert.equal(
  decideHeldDraftRelease({ heldKind: "context_fidelity", event: "ai_republish" }).release,
  false,
  "the AI that could not answer this turn must never self-clear the hold"
);
assert.equal(
  decideHeldDraftRelease({ heldKind: "draft_quality", event: "internal_log" }).release,
  false,
  "an internal/system log entry is not a reply"
);

// Unknown event => release (fail direction: a stuck card hides a live lead).
assert.equal(
  decideHeldDraftRelease({ heldKind: "draft_quality", event: "brand_new_event" as any }).release,
  true,
  "an unrecognized event fails toward releasing"
);

// Provider helper — what counts as actually reaching the customer.
for (const p of ["human", "twilio", "sendgrid", "TWILIO"]) {
  assert.equal(isRealReplyProvider(p), true, `${p} is a real reply provider`);
}
for (const p of ["draft_ai", "voice_call", "voice_summary", "web_widget", "", null, undefined]) {
  assert.equal(isRealReplyProvider(p as any), false, `${String(p)} is NOT a real reply provider`);
}

// WIRING — the invariant that makes this an un-stacking rather than a rename: there is exactly ONE
// place in the codebase that clears the flag (releaseHeldDraft), and every former clear-site calls it.
// Counting call sites would not prove that; counting ASSIGNMENTS does.
{
  const store = fs.readFileSync(path.resolve("services/api/src/domain/conversationStore.ts"), "utf8");
  const index = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");

  const assignments = (src: string) =>
    (src.match(/(?:\(conv as any\)|conv|args\.conv)\.draftHeld\s*=\s*null/g) ?? []).length;
  assert.equal(
    assignments(store),
    1,
    "conversationStore clears draftHeld in exactly ONE place — releaseHeldDraft, the referee"
  );
  assert.equal(assignments(index), 0, "index.ts never clears draftHeld directly; it asks releaseHeldDraft");

  assert.ok(/export function releaseHeldDraft/.test(store), "the single release helper is exported");
  assert.ok(
    (store.match(/releaseHeldDraft\(/g) ?? []).length >= 5,
    "all four former conversationStore clear-sites route through it (plus its own definition)"
  );
  assert.ok(
    (index.match(/releaseHeldDraft\(/g) ?? []).length >= 2,
    "both index.ts clear-sites route through it"
  );

  // The disagreement itself must be gone.
  assert.ok(
    !/heldKind === "context_fidelity"/.test(store),
    "the context_fidelity-only condition is gone — that WAS the fight"
  );
  // And the referee is consulted exactly once, inside the helper — not re-implemented anywhere.
  assert.equal(
    (store.match(/decideHeldDraftRelease\(/g) ?? []).length,
    1,
    "the referee is consulted in ONE place; no site re-implements the decision"
  );
}

console.log("PASS held draft release — one referee, six sites, AI never self-clears");
