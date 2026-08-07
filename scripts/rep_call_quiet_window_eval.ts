/**
 * REP-CALL QUIET WINDOW eval (2026-08-06).
 *
 * Pins `decideRepCallQuietWindow` (services/api/src/domain/repCallQuietWindow.ts) and its ONE call
 * site in the proactive-cadence loop. The defect it guards: a rep phones the customer and the
 * automated cadence texts them minutes later, because every "a human already reached out" check
 * read TYPED messages only (+17164815358, a cadence touch 48 minutes after a voicemail).
 *
 * EXECUTED, not asserted from source text. Part 1 runs the decider against message fixtures built
 * relative to a pinned NOW, so it cannot go red at midnight. Part 2 pins the WIRING — the exact
 * call shape in index.ts — because tsc does not prove a guard is still reached, and a guard that
 * is computed and never consumed is the failure this eval exists to catch.
 *
 * Run: npx tsx scripts/rep_call_quiet_window_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
  decideRepCallQuietWindow,
  REP_CALL_QUIET_WINDOW_MS
} = await import("../services/api/src/domain/repCallQuietWindow.ts");

let n = 0;
const ok = (cond: boolean, msg: string) => {
  assert.equal(cond, true, msg);
  n++;
};

// Clock-safe: every fixture timestamp is derived from this pinned NOW, never from the wall clock.
const NOW = Date.parse("2026-07-21T16:42:21.080Z");
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const call = (ms: number, extra: Record<string, unknown> = {}) => ({
  direction: "out",
  provider: "voice_call",
  at: ago(ms),
  ...extra
});

ok(REP_CALL_QUIET_WINDOW_MS === 24 * HOUR, "the quiet window is the same 24h the manual-send pause uses");

// ---------------------------------------------------------------------------
// PART 1 — the decision itself
// ---------------------------------------------------------------------------

// The real miss: Gio's voicemail at 15:54Z, the cadence touch at 16:42Z.
const gary = decideRepCallQuietWindow({ messages: [call(48 * 60 * 1000)], nowMs: NOW });
ok(gary.quiet === true, "a rep call 48 minutes ago quiets this tick's proactive touch");
ok(gary.callAt === ago(48 * 60 * 1000), "the decision names the call that caused it");
ok(
  gary.quietUntilMs === NOW - 48 * 60 * 1000 + 24 * HOUR,
  "the quiet window ends 24h after the CALL, not 24h after now"
);

// It defers, it never drops: the window is finite and in the future but under a day out.
ok(
  gary.quietUntilMs !== null && gary.quietUntilMs > NOW && gary.quietUntilMs - NOW < 24 * HOUR,
  "a quieted touch comes back inside a day — this guard delays, it cannot silence a lead"
);

const stale = decideRepCallQuietWindow({ messages: [call(25 * HOUR)], nowMs: NOW });
ok(stale.quiet === false, "a call older than the window is today's behaviour exactly — send");
ok(stale.quietUntilMs === null, "no window when nothing quiets");

const edge = decideRepCallQuietWindow({ messages: [call(24 * HOUR)], nowMs: NOW });
ok(edge.quiet === false, "exactly one day old is OUT of the window (half-open), so the touch fires");

// Notes about a call are written after the fact and must not start a second window of their own.
for (const provider of ["voice_summary", "voice_transcript"]) {
  const note = decideRepCallQuietWindow({
    messages: [{ direction: "out", provider, at: ago(10 * 60 * 1000) }],
    nowMs: NOW
  });
  ok(note.quiet === false, `a ${provider} row is our own note, not contact — it never quiets`);
}

// Only OUR placed call counts. Nothing else on the thread does.
for (const msg of [
  { direction: "in", provider: "voice_call", at: ago(HOUR) },
  { direction: "out", provider: "twilio", at: ago(HOUR) },
  { direction: "out", provider: "draft_ai", at: ago(HOUR) },
  { direction: "out", provider: "voice_call", at: ago(HOUR), delivered: false }
]) {
  const d = decideRepCallQuietWindow({ messages: [msg], nowMs: NOW });
  ok(d.quiet === false, `does not quiet on ${msg.direction}/${msg.provider}/delivered=${(msg as any).delivered}`);
}

// Absent `delivered` means delivered — 543 of 543 live voice_call rows carry no marker.
const unmarked = decideRepCallQuietWindow({ messages: [call(HOUR)], nowMs: NOW });
ok(unmarked.quiet === true, "an unmarked voice_call is delivered (pre-marker history), so it quiets");

// The MOST RECENT qualifying call wins, whatever order the rows arrive in.
const many = decideRepCallQuietWindow({
  messages: [call(20 * HOUR), call(2 * HOUR), call(30 * HOUR)],
  nowMs: NOW
});
ok(many.callAt === ago(2 * HOUR), "the newest in-window call sets the window");
ok(many.quietUntilMs === NOW - 2 * HOUR + 24 * HOUR, "the window is measured from the newest call");

// Garbage in never produces a quiet — the fail direction is toward sending.
for (const messages of [null, undefined, [], [null], [{ direction: "out", provider: "voice_call", at: "not-a-date" }]]) {
  const d = decideRepCallQuietWindow({ messages: messages as any, nowMs: NOW });
  ok(d.quiet === false, "unusable input falls through to today's behaviour (send)");
}
const future = decideRepCallQuietWindow({ messages: [call(-2 * HOUR)], nowMs: NOW });
ok(future.quiet === false, "a call stamped in the FUTURE is a clock artefact, not contact");
const badNow = decideRepCallQuietWindow({ messages: [call(HOUR)], nowMs: Number.NaN });
ok(badNow.quiet === false, "an unusable clock never quiets a touch");

// ---------------------------------------------------------------------------
// PART 2 — the wiring. A decider nothing consumes is the bug, not the fix.
// ---------------------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const api = fs.readFileSync(path.join(here, "../services/api/src/index.ts"), "utf8");

ok(
  api.includes('import { decideRepCallQuietWindow } from "./domain/repCallQuietWindow.js";'),
  "index.ts imports the decider from the domain module"
);

// The EXACT call shape: the live message rows and the loop's own clock. A guard fed a fixture, a
// stale timestamp, or a renamed key would still typecheck and would still be dead.
const callSite =
  "const repCallQuiet = decideRepCallQuietWindow({ messages: conv.messages, nowMs: now.getTime() });";
ok(api.includes(callSite), "the cadence loop calls the decider with the conversation's rows and its own clock");

// CONSUMED: the result must reach setBlockUntil, which bumps nextDueAt without advancing the step.
const consumption = api.slice(api.indexOf(callSite) + callSite.length, api.indexOf(callSite) + callSite.length + 220);
ok(
  /if \(repCallQuiet\.quiet && repCallQuiet\.quietUntilMs != null\) \{\s*setBlockUntil\(new Date\(repCallQuiet\.quietUntilMs\)\);/.test(
    consumption
  ),
  "the decision is consumed by setBlockUntil — deferring the touch, never advancing past it"
);

// It must NOT drop the touch: no advance/stop between the call site and its consumption.
ok(
  !/advanceFollowUpCadence|stopFollowUpCadence/.test(consumption),
  "the guard never advances or stops the cadence — a deferred touch must come back"
);

// Scope: exactly one call site, inside the `if (!isPostSale)` block, matching the manual-send pause.
ok(
  api.split("decideRepCallQuietWindow(").length - 1 === 1,
  "exactly one call site — a second copy is the inline-writer pattern this repo un-stacks"
);
const preamble = api.slice(0, api.indexOf(callSite));
ok(
  preamble.lastIndexOf("if (!isPostSale) {") > preamble.lastIndexOf("if (isPostSale)"),
  "the guard sits inside the !isPostSale block, the same scope pauseCadenceAfterManualOutbound uses"
);

console.log(`rep_call_quiet_window_eval: PASS (${n} assertions)`);
