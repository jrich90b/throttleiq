/**
 * Stale held-draft backstop eval (2026-07-13) — pins the actuation half of the draft-quality hold.
 *
 * Root cause (James Browne +12543831187, 7/12): a Service quote request got a limp auto-draft, the
 * quality gate held it, self-heal couldn't fix it (re-draft runs the same code), and with
 * DRAFT_QUALITY_HOLD_CLASS_ONLY=0 the unhealable draft PARKED on "being fixed" — no clear path fires
 * without a passing AI re-draft or a real human reply, so it sat silent ~14h. The backstop pulls a
 * human in after a stale window.
 *
 * Pins the pure decision shouldEscalateStaleHeldDraft (fail-direction: unsure => don't escalate) +
 * ci:eval wiring + the sweep source guard.
 *
 * Run: npx tsx scripts/held_draft_backstop_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  shouldEscalateStaleHeldDraft,
  HELD_DRAFT_BACKSTOP_TODO_MARKER
} from "../services/api/src/domain/heldDraftBackstop.ts";

const NOW = Date.parse("2026-07-13T12:00:00.000Z");
const hr = (n: number) => n * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

const held = (over: any = {}) => ({
  id: "+12543831187",
  draftHeld: { at: iso(NOW - hr(8)), reason: "live_regenerate", channel: "sms", ...over.draftHeld },
  messages: over.messages ?? [],
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "draftHeld" && k !== "messages"))
});
const out = (atMs: number, provider = "twilio") => ({ direction: "out", provider, at: iso(atMs) });

// --- Decision table ---

// The James shape: draft-quality hold, held 8h ago, never answered => escalate.
assert.equal(
  shouldEscalateStaleHeldDraft(held(), false, NOW),
  true,
  "a draft-quality hold stale past the window with no reply => escalate to a human"
);

// Inside the stale window => wait (self-heal / a same-window customer reply may still resolve it).
assert.equal(
  shouldEscalateStaleHeldDraft(held({ draftHeld: { at: iso(NOW - hr(2)) } }), false, NOW),
  false,
  "a freshly-held draft inside the stale window is not escalated yet"
);

// No draftHeld => nothing to escalate.
assert.equal(
  shouldEscalateStaleHeldDraft({ id: "+1", draftHeld: null, messages: [] }, false, NOW),
  false,
  "no held draft => nothing to escalate"
);

// Context-fidelity holds already raise their own todo at hold-time => the backstop skips them.
assert.equal(
  shouldEscalateStaleHeldDraft(held({ draftHeld: { heldKind: "context_fidelity" } }), false, NOW),
  false,
  "context-fidelity holds get their own todo — the backstop does not double-surface them"
);

// A real reply went out AFTER the hold => resolved, never chase it.
assert.equal(
  shouldEscalateStaleHeldDraft(held({ messages: [out(NOW - hr(1), "human")] }), false, NOW),
  false,
  "a real human/twilio/sendgrid reply after the hold resolves it"
);
// A draft_ai row (never sent) does NOT count as a reply.
assert.equal(
  shouldEscalateStaleHeldDraft(held({ messages: [out(NOW - hr(1), "draft_ai")] }), false, NOW),
  true,
  "an unsent draft_ai row is not a real reply — still escalate"
);

// Closed / sold leads don't need a reply chased.
assert.equal(
  shouldEscalateStaleHeldDraft(held({ closedAt: iso(NOW - hr(1)) }), false, NOW),
  false,
  "a closed lead is not escalated"
);
assert.equal(
  shouldEscalateStaleHeldDraft(held({ sale: { at: iso(NOW - hr(1)) } }), false, NOW),
  false,
  "a sold lead is not escalated"
);

// Already-open escalation todo => don't stack duplicates.
assert.equal(
  shouldEscalateStaleHeldDraft(held(), true, NOW),
  false,
  "an already-open escalation todo suppresses a duplicate"
);

// Re-nudge: escalated recently (within window) => wait; escalated long ago + still held => re-surface.
assert.equal(
  shouldEscalateStaleHeldDraft(held({ heldDraftEscalatedAt: iso(NOW - hr(3)) }), false, NOW),
  false,
  "a recent escalation is not re-fired inside the re-nudge window"
);
assert.equal(
  shouldEscalateStaleHeldDraft(held({ heldDraftEscalatedAt: iso(NOW - hr(30)) }), false, NOW),
  true,
  "a still-held draft re-surfaces after the re-nudge window (never forgotten)"
);

// Unparseable hold stamp => skip (never escalate on uncertainty).
assert.equal(
  shouldEscalateStaleHeldDraft(held({ draftHeld: { at: "garbage" } }), false, NOW),
  false,
  "a garbage hold timestamp never escalates"
);

// Options are honored.
assert.equal(
  shouldEscalateStaleHeldDraft(held({ draftHeld: { at: iso(NOW - hr(4)) } }), false, NOW, { staleHours: 2 }),
  true,
  "a shorter staleHours escalates sooner"
);

// --- Source guards ---
const indexSrc = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
assert.match(
  indexSrc,
  /shouldEscalateStaleHeldDraft\(/,
  "the [state-reconcile] sweep calls shouldEscalateStaleHeldDraft"
);
assert.ok(
  indexSrc.includes("HELD_DRAFT_BACKSTOP_TODO_MARKER"),
  "the sweep dedups + tags the escalation todo with HELD_DRAFT_BACKSTOP_TODO_MARKER"
);
assert.match(
  indexSrc,
  /shouldEscalateStaleHeldDraft[\s\S]{0,1500}heldDraftEscalatedAt =/,
  "the sweep stamps heldDraftEscalatedAt when it escalates (one-time marker)"
);
assert.match(
  indexSrc,
  /held_draft_escalated_to_human/,
  "the sweep records the escalation outcome"
);

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
assert.ok(
  String(pkg.scripts?.["ci:eval"] ?? "").includes("held_draft_backstop:eval"),
  "held_draft_backstop:eval is wired into ci:eval"
);

assert.equal(HELD_DRAFT_BACKSTOP_TODO_MARKER, "[held-draft-needs-human]");

console.log(
  "PASS held-draft backstop eval (decision table: stale/window/context-fidelity-skip/real-reply/closed/dedup/re-nudge/garbage/options + sweep + ci:eval source guards)"
);
