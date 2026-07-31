/**
 * Cadence-ack human-guard eval.
 *
 * The console pause/stop-cadence button sends a warm closer ("I'll be here when you're
 * ready…") — right for a customer deferral, wrong when a human is mid-conversation.
 * Production case: Bill +17166090270 (2026-07-17) — a rep manually texted "send pictures
 * of the bike and the title" and hit pause 9s later; the auto-ack then told the customer
 * "no rush." `shouldSuppressCadenceAck` suppresses the ack when a manual/human outbound
 * landed within the active-human window, and leaves it ON otherwise.
 *
 * Second suppression reason — `no_customer_turn`. Production case: Dominic +17169309966
 * (2026-07-20). Staff paused a thread whose newest customer message was 17 days old and
 * already answered by a later outbound. The ack fired with nothing to acknowledge, and the
 * lead-in normalizer opened it "You're welcome." off that stale inbound's "thanks". He
 * replied "??" and a rep had to apologize for the text. `hasNoCustomerTurnToAcknowledge`
 * suppresses the closer when no unanswered customer turn exists;
 * `resolveCadenceAckSuppression` combines both reasons for the single console call site.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  shouldSuppressCadenceAck,
  hasNoCustomerTurnToAcknowledge,
  resolveCadenceAckSuppression,
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

// ── Dominic +17169309966 (American Harley, 2026-07-20) ────────────────────────────────
// The repro: newest inbound (7/02) already answered by a later outbound (7/03 watch alert),
// staff paused on 7/20 → nothing to acknowledge.
const dominicNowMs = Date.parse("2026-07-20T10:37:28.000Z");
const dominicThread = {
  messages: [
    { direction: "in", provider: "twilio", at: "2026-07-02T15:04:00.000Z" },
    { direction: "out", provider: "twilio", at: "2026-07-03T16:42:57.000Z" }
  ]
};

// 8) The pinned production turn.
assert.equal(
  hasNoCustomerTurnToAcknowledge(dominicThread),
  true,
  "last customer turn was already answered 17 days ago → nothing to acknowledge"
);
assert.deepEqual(
  resolveCadenceAckSuppression(dominicThread, dominicNowMs),
  { suppress: true, reason: "no_customer_turn" },
  "Dominic +17169309966 2026-07-20: cadence-ack must not fire on a thread with no open customer turn"
);

// 9) Intended case preserved — the customer's defer is the newest turn → SEND.
//    Note the deliberately out-of-order array: the predicate must compare TIMESTAMPS,
//    not array position.
assert.deepEqual(
  resolveCadenceAckSuppression(
    {
      messages: [
        { direction: "in", provider: "twilio", at: "2026-07-17T14:50:00.000Z" },
        { direction: "out", provider: "draft_ai", at: "2026-07-10T10:00:00.000Z" }
      ]
    },
    nowMs
  ),
  { suppress: false, reason: null },
  "customer's defer is the newest turn → the warm closer is still the right touch"
);

// 10) Precedence — an active human thread keeps reporting active_human_thread (the Bill case).
assert.deepEqual(
  resolveCadenceAckSuppression(
    { messages: [{ direction: "out", provider: "human", at: "2026-07-17T14:54:54.000Z" }] },
    nowMs
  ),
  { suppress: true, reason: "active_human_thread" },
  "a rep texting 9s ago must still report active_human_thread, not no_customer_turn"
);

// 11) Edges.
assert.equal(
  hasNoCustomerTurnToAcknowledge(null),
  false,
  "no conversation → do not suppress"
);
assert.equal(
  hasNoCustomerTurnToAcknowledge({ messages: [] }),
  false,
  "no messages at all → nothing sent yet, do not suppress on this reason"
);
assert.equal(
  hasNoCustomerTurnToAcknowledge({
    messages: [{ direction: "in", provider: "twilio", at: "2026-07-20T09:00:00.000Z" }]
  }),
  false,
  "inbound-only thread → the customer's turn is live, send the closer"
);
assert.equal(
  hasNoCustomerTurnToAcknowledge({
    messages: [{ direction: "out", provider: "twilio", at: "2026-07-20T09:00:00.000Z" }]
  }),
  true,
  "we spoke and the customer never did → nothing to acknowledge"
);
assert.equal(
  hasNoCustomerTurnToAcknowledge({
    messages: [
      { direction: "in", provider: "twilio", at: "2026-07-20T09:00:00.000Z" },
      { direction: "out", provider: "twilio", at: "2026-07-20T09:00:00.000Z" }
    ]
  }),
  false,
  "equal timestamps fail toward today's behavior (send)"
);
assert.equal(
  hasNoCustomerTurnToAcknowledge({
    messages: [
      { direction: "in", provider: "twilio", at: "not-a-date" },
      { direction: "out", provider: "twilio", at: "2026-07-20T09:00:00.000Z" }
    ]
  }),
  true,
  "an unparseable inbound timestamp is ignored, not treated as newest"
);

// 12) Wiring guard — exactly ONE call site, so a future sender cannot route around the gate.
const apiSrc = readFileSync("services/api/src/index.ts", "utf8");
assert.equal(
  (apiSrc.match(/resolveCadenceAckSuppression\(/g) ?? []).length,
  1,
  "the cadence-ack gate must stay single-call-site (console /followup-action only)"
);
assert.equal(
  (apiSrc.match(/shouldSuppressCadenceAck\(/g) ?? []).length,
  0,
  "index.ts must go through resolveCadenceAckSuppression, never the human-only gate directly"
);

console.log("PASS cadence-ack human-guard eval");
