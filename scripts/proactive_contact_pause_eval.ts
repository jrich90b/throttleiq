/**
 * Proactive-contact pause gate eval — a held lead must be off PROACTIVE outreach
 * (inventory watch-fire alerts and cadence touches). Pins the shared predicate
 * both watch-fire engines and the cadence dispatch consult.
 *
 * Production cases (2026-06-30):
 *  - Mark Scoville +17164815673: paused_indefinite, yet a watch-fire "good news —
 *    we have a Breakout in stock" draft generated.
 *  - Kevin Short +17166035402: paused_indefinite, yet a "just checking in" cadence
 *    draft generated.
 * Both engines only skipped `manual_handoff`; `paused_indefinite` leaked through.
 */
import assert from "node:assert/strict";
import { isProactiveContactPaused } from "../services/api/src/domain/proactiveContactPause.ts";

// Held: staff own it, or the lead is on an explicit hold — no proactive outreach.
assert.equal(isProactiveContactPaused({ followUp: { mode: "manual_handoff" } }), true);
assert.equal(isProactiveContactPaused({ followUp: { mode: "paused_indefinite" } }), true);
assert.equal(isProactiveContactPaused({ followUp: { mode: "PAUSED_INDEFINITE" } }), true); // case-insensitive

// NOT held: holding_inventory is the legit watch-fire case (the lead WANTS the
// "your unit is available again / a match arrived" alert) — must still fire.
assert.equal(isProactiveContactPaused({ followUp: { mode: "holding_inventory" } }), false);
assert.equal(isProactiveContactPaused({ followUp: { mode: "active" } }), false);

// Missing / empty mode is not held (normal proactive cadence applies).
assert.equal(isProactiveContactPaused({ followUp: { mode: null } }), false);
assert.equal(isProactiveContactPaused({ followUp: {} }), false);
assert.equal(isProactiveContactPaused({}), false);
assert.equal(isProactiveContactPaused(null), false);

console.log("PASS proactive-contact pause gate eval (held = manual_handoff + paused_indefinite; holding_inventory still fires)");
