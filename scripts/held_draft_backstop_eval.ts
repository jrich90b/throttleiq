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
  buildHeldDraftEscalationSummary,
  HELD_DRAFT_BACKSTOP_TODO_MARKER
} from "../services/api/src/domain/heldDraftBackstop.ts";
import { closingTimeMsForInstant } from "../services/api/src/domain/businessHoursGuard.ts";

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

// ═══ THE FLAG HAS TO LAND WHILE SOMEONE IS THERE (measured 2026-08-09) ═══
// All four escalations this backstop has EVER raised, replayed:
//   Jessica  held Fri 9:12am -> flagged 3:12pm  during open hours  ✓
//   Charles  held Mon 1:21am -> flagged 7:21am  waiting at the door ✓
//   Aaron    held Wed 1:52pm -> flagged 7:52pm  AFTER a 6pm close   ✗
//   Maya     held Fri 1:42pm -> flagged 7:42pm  AFTER a 6pm close   ✗  (still unresolved 2 days on)
// Both failures were held in the EARLY AFTERNOON with four hours of business day left. A flag nobody
// can act on is a flag that did not fire.
const AH_HOURS = {
  monday: { open: "09:00", close: "18:00" },
  tuesday: { open: "09:00", close: "18:00" },
  wednesday: { open: "09:00", close: "18:00" },
  thursday: { open: "09:00", close: "18:00" },
  friday: { open: "09:00", close: "18:00" },
  saturday: { open: "09:00", close: "15:00" }
  // sunday: closed — deliberately absent
};
const TZ = "America/New_York";
const closesFor = (atIso: string) =>
  closingTimeMsForInstant({ atIso, timeZone: TZ, businessHours: AH_HOURS as any });

// Maya's real timeline. 13:42 EDT hold, 18:00 close => actionable-by 17:15 EDT (21:15Z).
const MAYA_HELD = "2026-08-07T17:42:45.673Z";
const mayaConv = { id: "+15854782032", draftHeld: { at: MAYA_HELD, reason: "live_regenerate" }, messages: [] };
const mayaOpts = { closesAtMs: closesFor(MAYA_HELD) };
assert.ok(mayaOpts.closesAtMs, "a hold during open hours resolves that day's closing time");
assert.equal(
  shouldEscalateStaleHeldDraft(mayaConv as any, false, Date.parse("2026-08-07T21:20:00Z"), mayaOpts),
  true,
  "Maya: flagged BEFORE the 6pm close, while a rep can still act (was 7:42pm, to an empty store)"
);
assert.equal(
  shouldEscalateStaleHeldDraft(mayaConv as any, false, Date.parse("2026-08-07T19:00:00Z"), mayaOpts),
  false,
  "…but not the moment it is held — self-heal and a customer reply still get their window"
);
// The minimum soak wins over beating the close: a hold at 5:55pm must not escalate instantly.
const LATE_HELD = "2026-08-07T21:55:00.000Z"; // 17:55 EDT, 5 minutes before close
const lateConv = { id: "+1late", draftHeld: { at: LATE_HELD, reason: "live_regenerate" }, messages: [] };
assert.equal(
  shouldEscalateStaleHeldDraft(lateConv as any, false, Date.parse("2026-08-07T22:00:00Z"), {
    closesAtMs: closesFor(LATE_HELD)
  }),
  false,
  "a hold minutes before closing waits out the minimum soak instead of firing instantly"
);
// Jessica already worked — the change must not disturb her.
const JESS_HELD = "2026-07-17T13:12:13.036Z"; // 9:12am EDT
assert.equal(
  shouldEscalateStaleHeldDraft(
    { id: "+1j", draftHeld: { at: JESS_HELD, reason: "live_regenerate" }, messages: [] } as any,
    false,
    Date.parse("2026-07-17T19:13:00Z"),
    { closesAtMs: closesFor(JESS_HELD) }
  ),
  true,
  "Jessica: the 6h window already landed inside open hours and still fires there"
);
// Charles was held at 1:21am — outside opening hours, so there is no close to beat and the plain
// stale timer governs. Unchanged behaviour.
assert.equal(closesFor("2026-08-03T05:21:31.755Z"), null, "a hold outside opening hours has no closing deadline");
// Sunday has no configured window at all.
assert.equal(closesFor("2026-08-09T17:00:00.000Z"), null, "a day with no hours configured yields no deadline");
// NO closing time supplied => byte-identical to the old behaviour.
const plainHeld = "2026-08-07T17:42:45.673Z";
const plainConv = { id: "+1p", draftHeld: { at: plainHeld, reason: "live_regenerate" }, messages: [] };
assert.equal(
  shouldEscalateStaleHeldDraft(plainConv as any, false, Date.parse("2026-08-07T21:20:00Z")),
  false,
  "with no closesAtMs the plain 6h window governs — the change is a no-op without it"
);
assert.equal(
  shouldEscalateStaleHeldDraft(plainConv as any, false, Date.parse("2026-08-07T23:45:00Z")),
  true,
  "…and the plain 6h window still fires on time"
);
// It can only ever move the flag EARLIER, never later.
assert.equal(
  shouldEscalateStaleHeldDraft(mayaConv as any, false, Date.parse("2026-08-07T23:45:00Z"), mayaOpts),
  true,
  "the closing rule never delays an escalation past where the plain window would have fired"
);

// The staff-facing summary a rep actually reads.
const summary = buildHeldDraftEscalationSummary({ who: "Maya", inboundPreview: "  will I   lose my seat?  " });
assert.ok(summary.startsWith(HELD_DRAFT_BACKSTOP_TODO_MARKER), "the summary carries the dedup marker");
assert.ok(summary.includes("Reply to Maya needs a human"), "the summary names the customer");
assert.ok(summary.includes('They asked: "will I lose my seat?"'), "the summary quotes the ask, whitespace-collapsed");
const noAsk = buildHeldDraftEscalationSummary({ who: "", inboundPreview: null });
assert.ok(noAsk.includes("this lead") && !noAsk.includes("They asked"), "no ask and no name still reads cleanly");

assert.equal(HELD_DRAFT_BACKSTOP_TODO_MARKER, "[held-draft-needs-human]");

console.log(
  "PASS held-draft backstop eval (decision table: stale/window/context-fidelity-skip/real-reply/closed/dedup/re-nudge/garbage/options + sweep + ci:eval source guards)"
);
