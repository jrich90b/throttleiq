/**
 * Cadence-ack human-guard eval.
 *
 * The console pause/stop-cadence button sends a warm closer ("I'll be here when you're
 * ready…") — right for a customer deferral, wrong when a human is mid-conversation.
 * Production case: Bill +17166090270 (2026-07-17) — a rep manually texted "send pictures
 * of the bike and the title" and hit pause 9s later; the auto-ack then told the customer
 * "no rush." `shouldSuppressCadenceAck` suppresses the ack when a manual/human outbound
 * landed within the active-human window, and leaves it ON otherwise.
 */
import assert from "node:assert/strict";

import {
  shouldSuppressCadenceAck,
  CADENCE_ACK_ACTIVE_HUMAN_WINDOW_MS
} from "../services/api/src/domain/cadenceAckGate.ts";

const nowMs = Date.parse("2026-07-17T14:55:03.000Z");

// 1) The Bill case — a rep manually texted 9s before the pause → SUPPRESS.
assert.equal(
  shouldSuppressCadenceAck(
    {
      messages: [
        { direction: "out", provider: "human", at: "2026-07-17T14:54:54.000Z" }
      ]
    },
    nowMs
  ),
  true,
  "recent manual/human outbound (9s ago) must suppress the auto cadence-ack"
);

// 2) Intended feature preserved — customer deferred, staff paused, no recent human send → SEND.
assert.equal(
  shouldSuppressCadenceAck(
    {
      messages: [
        { direction: "in", provider: "twilio", at: "2026-07-17T14:50:00.000Z" },
        { direction: "out", provider: "draft_ai", at: "2026-07-10T10:00:00.000Z" }
      ]
    },
    nowMs
  ),
  false,
  "no recent human outbound → cadence-ack still sends (intended warm closer)"
);

// 3) Stale human outbound (well outside the window) → SEND (a person is not actively driving).
assert.equal(
  shouldSuppressCadenceAck(
    { messages: [{ direction: "out", provider: "human", at: "2026-07-17T14:20:00.000Z" }] },
    nowMs
  ),
  false,
  "human outbound 35 min ago is outside the active-human window → do not suppress"
);

// 4) Manual-outbound context stamped recently (secondary signal) → SUPPRESS.
assert.equal(
  shouldSuppressCadenceAck(
    { messages: [], manualContext: { source: "manual_outbound", updatedAt: "2026-07-17T14:54:57.000Z" } },
    nowMs
  ),
  true,
  "recent manual_outbound context must suppress the auto cadence-ack"
);

// 5) An automated/agent outbound is NOT a human send → SEND.
assert.equal(
  shouldSuppressCadenceAck(
    { messages: [{ direction: "out", provider: "twilio", at: "2026-07-17T14:54:59.000Z" }] },
    nowMs
  ),
  false,
  "an automated (twilio) outbound is not a human at the keyboard → do not suppress"
);

// 6) Edge: empty/undefined conversation, and a future-dated message (clock skew) → SEND.
assert.equal(shouldSuppressCadenceAck(null, nowMs), false, "no conversation → do not suppress");
assert.equal(
  shouldSuppressCadenceAck(
    { messages: [{ direction: "out", provider: "human", at: "2026-07-17T15:10:00.000Z" }] },
    nowMs
  ),
  false,
  "a future-dated human message (clock skew) must not suppress"
);

// 7) Boundary — exactly at the window edge counts as active.
assert.equal(
  shouldSuppressCadenceAck(
    {
      messages: [
        { direction: "out", provider: "human", at: new Date(nowMs - CADENCE_ACK_ACTIVE_HUMAN_WINDOW_MS).toISOString() }
      ]
    },
    nowMs
  ),
  true,
  "a human outbound exactly at the window edge still counts as active"
);

console.log("PASS cadence-ack human-guard eval");
