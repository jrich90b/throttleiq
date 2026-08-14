/**
 * turn_response_tripwire:eval — pins Joe's per-message tripwire ruling (2026-08-14 evening):
 * minutes after every customer message, if NOTHING responded (no outbound, no draft, no task,
 * no watch), mint ONE merged owner task — silence is the one outcome that is never right.
 *
 * The decision table is EXECUTED (decideTurnResponseTripwire + hasResponseArtifactSince are
 * pure); the wiring is pinned across all three registration points, because a task that exists
 * in the dispatch map but not the minute lane (or the worker schedule) silently never runs —
 * the exact drift the shared WORKER_MINUTE_LANE_TASKS list now prevents on the API side.
 *
 * Fixtures are the REAL shapes from the leads that proved the class:
 *  - Rick Williamson +17168609581, 8/13 21:48: a flex-financing question, agent mode, no
 *    artifact for 16h — the tripwire would have fired at minute 10.
 *  - The deliberate-silence taxonomy (8/14: 11 of 12 silent threads were CORRECTLY silent):
 *    bare acks, tapbacks, human-mode threads (#707's backstop owns those), closed, suppressed.
 */
import assert from "node:assert/strict";

import {
  TURN_TRIPWIRE_MIN_AGE_MS_DEFAULT,
  TURN_TRIPWIRE_MAX_AGE_MS_DEFAULT,
  decideTurnResponseTripwire,
  hasResponseArtifactSince
} from "../services/api/src/domain/turnResponseTripwire.ts";
import { WORKER_MINUTE_LANE_TASKS, WORKER_TICK_TASKS } from "../services/api/src/domain/workerTasks.ts";
import { WORKER_SCHEDULES } from "../services/worker/src/config.ts";

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0);
const MIN = 60_000;

function base(overrides: Record<string, unknown> = {}) {
  return {
    nowMs: NOW,
    conversationStatus: null,
    mode: "suggest",
    suppressed: false,
    lastMessage: {
      direction: "in",
      provider: "twilio",
      body: "What is the lowest interest rate you can get me on the flex financing on the 36 and the 48 month?",
      at: new Date(NOW - 30 * MIN).toISOString(),
      id: "msg_rick_flex"
    },
    hasResponseArtifact: false,
    alreadyFiredForMessageId: null,
    ...overrides
  } as Parameters<typeof decideTurnResponseTripwire>[0];
}

// 1. THE MISS: Rick's shape fires, with the message id and a usable excerpt.
{
  const d = decideTurnResponseTripwire(base());
  assert.ok(d.fire, "an aged, unanswered, artifact-less customer SMS fires the tripwire (Rick +17168609581)");
  if (d.fire) {
    assert.equal(d.messageId, "msg_rick_flex");
    assert.equal(d.ageMinutes, 30);
    assert.ok(d.excerpt.includes("flex financing"), "the excerpt carries the customer's own words");
  }
}

// 2. THE TAXONOMY — every deliberately-silent class stays silent.
const NO_FIRE: Array<[string, Record<string, unknown>, string]> = [
  ["young turn (pipeline still working)", { lastMessage: { ...base().lastMessage, at: new Date(NOW - 5 * MIN).toISOString() } }, "too_young"],
  ["old turn (daily sweeps own it)", { lastMessage: { ...base().lastMessage, at: new Date(NOW - 30 * 60 * MIN).toISOString() } }, "too_old_daily_sweeps_own_it"],
  ["artifact exists (draft/task/watch/outbound)", { hasResponseArtifact: true }, "response_artifact_exists"],
  ["human-mode thread (#707 backstop owns it)", { mode: "human" }, "human_mode_backstop_owns_it"],
  ["closed conversation", { conversationStatus: "closed" }, "conversation_closed"],
  ["suppressed / opted out", { suppressed: true }, "suppressed"],
  ["bare courtesy ack", { lastMessage: { ...base().lastMessage, body: "Ok thanks" } }, "bare_acknowledgement"],
  ["tapback reaction", { lastMessage: { ...base().lastMessage, body: 'Liked "See you Saturday at 10!"' } }, "tapback_reaction"],
  ["ADF form blob is not an SMS turn", { lastMessage: { ...base().lastMessage, provider: "sendgrid_adf" } }, "provider_sendgrid_adf"],
  ["voice artifact is not an SMS turn", { lastMessage: { ...base().lastMessage, provider: "voice_transcript" } }, "provider_voice_transcript"],
  ["outbound last (thread answered)", { lastMessage: { ...base().lastMessage, direction: "out" } }, "last_message_not_inbound"],
  ["already fired for this message", { alreadyFiredForMessageId: "msg_rick_flex" }, "already_fired"],
  ["undatable message (never fire on uncertainty)", { lastMessage: { ...base().lastMessage, at: "not-a-date" } }, "undatable_message"],
  ["no message id (no idempotence receipt possible)", { lastMessage: { ...base().lastMessage, id: "" } }, "no_message_id"]
];
for (const [label, over, reason] of NO_FIRE) {
  const d = decideTurnResponseTripwire(base(over));
  assert.ok(!d.fire, `${label} must NOT fire`);
  if (!d.fire) assert.equal(d.reason, reason, `${label}: expected reason ${reason}, got ${d.reason}`);
}

// 3. The default window is the agreed one: opens at 10 minutes, closes at 24 hours.
assert.equal(TURN_TRIPWIRE_MIN_AGE_MS_DEFAULT, 10 * 60 * 1000);
assert.equal(TURN_TRIPWIRE_MAX_AGE_MS_DEFAULT, 24 * 60 * 60 * 1000);

// 4. The artifact checker: any of the four artifact kinds suppresses; undatable rows suppress
//    (fail toward NOT firing); an empty world does not.
const T0 = NOW - 30 * MIN;
assert.equal(hasResponseArtifactSince({ inboundAtMs: T0, messagesAfter: [], todos: [], watches: [] }), false, "no artifacts anywhere ⇒ nothing responded");
assert.equal(
  hasResponseArtifactSince({ inboundAtMs: T0, messagesAfter: [{ direction: "out", at: new Date(T0 + MIN).toISOString(), body: "draft text" }], todos: [], watches: [] }),
  true,
  "an out row (including a draft_ai row — it is in the approval box) is a response"
);
assert.equal(
  hasResponseArtifactSince({ inboundAtMs: T0, messagesAfter: [], todos: [{ createdAt: new Date(T0 + MIN).toISOString() }], watches: [] }),
  true,
  "a task minted since the inbound is a response"
);
assert.equal(
  hasResponseArtifactSince({ inboundAtMs: T0, messagesAfter: [], todos: [{ createdAt: new Date(T0 - 60 * MIN).toISOString() }], watches: [] }),
  false,
  "a task from BEFORE the inbound is not a response to it"
);
assert.equal(
  hasResponseArtifactSince({ inboundAtMs: T0, messagesAfter: [], todos: [{ createdAt: null }], watches: [] }),
  true,
  "an undatable task counts as a response — uncertainty never fires the tripwire"
);
assert.equal(
  hasResponseArtifactSince({ inboundAtMs: T0, messagesAfter: [], todos: [], watches: [{ createdAt: new Date(T0 + MIN).toISOString() }] }),
  true,
  "a watch created since the inbound is a response"
);

// 5. WIRING — the task must exist at all three registration points, or it silently never runs.
assert.ok((WORKER_TICK_TASKS as readonly string[]).includes("turn-tripwire"), "turn-tripwire is a registered worker tick task");
assert.ok((WORKER_MINUTE_LANE_TASKS as readonly string[]).includes("turn-tripwire"), "turn-tripwire runs on the API's minute lane");
const minuteSchedule = WORKER_SCHEDULES.find(s => s.cron === "* * * * *");
assert.ok(minuteSchedule && minuteSchedule.tasks.includes("turn-tripwire"), "turn-tripwire is on the worker's minute schedule");
// And every minute-lane task is dispatchable — a name in the lane but not the registry would throw at tick time.
for (const name of WORKER_MINUTE_LANE_TASKS) {
  assert.ok((WORKER_TICK_TASKS as readonly string[]).includes(name), `minute-lane task ${name} is a registered tick task`);
}

console.log("PASS turn_response_tripwire:eval — 1 fire + 14 taxonomy holds + artifact table + 3-point wiring");
