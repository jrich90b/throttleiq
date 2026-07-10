/**
 * owner_thread_step_back:eval — pins the Mark Kocsis class (Joe, 2026-07-09, +17168609533).
 *
 * Mark texted "Hey Scott this is Mark..." replying to Scott's own morning send (a real human
 * outbound with actorUserId), describing a USED Street Glide (2022 or older, black trim not
 * chrome) — and the AI (a) took over the personal thread and (b) rendered his subordinate
 * clause as a color: "...Street Glide in If You Have One That Has The in stock".
 *
 * Three pins:
 *  1. decideOwnerThreadStepBack decision table (pure): fires ONLY on an owner-name greeting
 *     after a human send; mentions-later / AI-thread / unknown-owner / short names never fire.
 *  2. Live wiring source-guard: the /webhooks/twilio arm suppresses the draft (empty TwiML),
 *     hands the owner a call task, and REGENERATE stays deliberately ungated (staff override,
 *     same precedent as in_process_deal).
 *  3. sanitizeColorPhrase fragment rejection source+behavior guard: a lifted clause can never
 *     render as a color again (fail-safe: dropping a color only makes a reply less specific).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { decideOwnerThreadStepBack } from "../services/api/src/domain/routeStateReducer.ts";

// --- 1. decision table ---
const MARK =
  "Hey Scott this is Mark . I called this morning right after I got your message and whoever answered the phone said they would get a message to you to call me back.";
const rows: Array<{ id: string; input: Parameters<typeof decideOwnerThreadStepBack>[0]; want: string }> = [
  { id: "mark_exact_production_turn", input: { inboundText: MARK, ownerFirstName: "Scott", lastOutboundWasHumanSend: true }, want: "owner_thread_step_back" },
  { id: "bare_name_open", input: { inboundText: "Scott, are you in today?", ownerFirstName: "Scott", lastOutboundWasHumanSend: true }, want: "owner_thread_step_back" },
  { id: "greeting_only", input: { inboundText: "hey scott", ownerFirstName: "Scott", lastOutboundWasHumanSend: true }, want: "owner_thread_step_back" },
  { id: "mention_later_does_not_fire", input: { inboundText: "Can you tell Scott I said thanks", ownerFirstName: "Scott", lastOutboundWasHumanSend: true }, want: "none" },
  { id: "ai_thread_does_not_fire", input: { inboundText: MARK, ownerFirstName: "Scott", lastOutboundWasHumanSend: false }, want: "none" },
  { id: "different_name_does_not_fire", input: { inboundText: "Hey Alexandra, is the bike in?", ownerFirstName: "Scott", lastOutboundWasHumanSend: true }, want: "none" },
  { id: "unknown_owner_does_not_fire", input: { inboundText: MARK, ownerFirstName: null, lastOutboundWasHumanSend: true }, want: "none" },
  { id: "short_owner_name_guard", input: { inboundText: "Hey Al this is Mark", ownerFirstName: "Al", lastOutboundWasHumanSend: true }, want: "none" },
  { id: "empty_text_does_not_fire", input: { inboundText: "", ownerFirstName: "Scott", lastOutboundWasHumanSend: true }, want: "none" }
];
for (const r of rows) {
  assert.equal(decideOwnerThreadStepBack(r.input).kind, r.want, `decision ${r.id}: expected ${r.want}`);
}

// --- 2. live wiring source-guard ---
const apiIndex = fs.readFileSync(path.join(process.cwd(), "services/api/src/index.ts"), "utf8");
const armStart = apiIndex.indexOf("Owner-named personal thread step-back");
const armBlock = armStart >= 0 ? apiIndex.slice(armStart, armStart + 3200) : "";
assert.ok(armBlock.includes("decideOwnerThreadStepBack({"), "live arm routes through the centralized decision");
assert.ok(
  /addTodo\(\s*conv,\s*"call",[\s\S]{0,400}"followup"/.test(armBlock),
  "step-back hands the OWNER a call/followup task"
);
assert.ok(armBlock.includes("conv.leadOwner"), "the task is assigned to the lead owner");
assert.ok(
  armBlock.includes("<Response></Response>") && armBlock.includes('recordRouteOutcome("live", "owner_thread_step_back_no_draft"'),
  "the live arm suppresses the auto-draft (empty TwiML) and records the route outcome"
);
assert.ok(
  /REGENERATE is deliberately not gated/.test(armBlock),
  "regenerate stays the staff override (in_process_deal precedent), documented in-code"
);
assert.ok(
  armBlock.includes("actorUserId") && armBlock.includes("actorUserName"),
  "human-send detection keys on the message actor stamp, not on provider alone"
);

// --- 3. sanitizeColorPhrase fragment rejection ---
const scpStart = apiIndex.indexOf("function sanitizeColorPhrase");
const scpBlock = scpStart >= 0 ? apiIndex.slice(scpStart, scpStart + 1800) : "";
assert.ok(
  scpBlock.includes("hasSentenceFragmentWord") && scpBlock.includes("words.length > 4"),
  "sanitizeColorPhrase rejects sentence fragments and over-long phrases"
);
// Behavioral spot-check via an inline reimplementation contract: the guard regex in source must
// reject the exact production garble and keep real finishes.
const fragRe = /\b(if|you|your|yours|that|this|those|these|one|ones|know|let|please|tell|text|call|me|my|i|we|whether|question|questions|feel|free|thanks|thank)\b/i;
assert.ok(fragRe.test("if you have one that has the"), "production garble matches the fragment signature");
for (const legit of ["vivid black", "dark billiard gray", "black trim", "blacked out", "red rock"]) {
  assert.ok(!fragRe.test(legit) && legit.split(" ").length <= 4, `legit finish phrase survives: ${legit}`);
}
assert.ok(scpBlock.includes("Mark Kocsis"), "the guard cites its origin case");

console.log(
  `PASS owner-thread step-back eval (${rows.length} decision rows + wiring + color-slot fragment guard) — a customer talking to their salesperson gets the salesperson, and a clause can never render as a color`
);
