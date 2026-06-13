/**
 * Stale manual-handoff safety-net eval. Production fixture: Mike +17163686204,
 * 2026-06-13 — web-text-widget sales lead, priced + sent pics by staff (Scott),
 * then left in manual_handoff with followUpCadence: null and no follow-up todo.
 * A handed-off lead that goes quiet must surface ONE staff "follow up" todo (no
 * auto-send), without ever flooding the task inbox.
 */
import assert from "node:assert/strict";
import { shouldNudgeStaleHandoffLead } from "../services/api/src/domain/conversationStore.ts";

const NOW = new Date("2026-06-13T20:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function lead(overrides: any = {}): any {
  return {
    id: "+17163686204",
    leadKey: "+17163686204",
    followUp: { mode: "manual_handoff", reason: "web_text_widget_sales", updatedAt: daysAgo(4) },
    followUpCadence: null,
    messages: [
      { direction: "in", body: "price of the 2013 street glide?", at: daysAgo(4.2) },
      { direction: "out", body: "We will be asking $11,995", at: daysAgo(4.1) },
      { direction: "in", body: "send pics?", at: daysAgo(4) },
      { direction: "out", body: "[mms]", at: daysAgo(4) }
    ],
    ...overrides
  };
}

// Mike's exact shape: handed off, no cadence, 4 days idle, has inbound, no open todo → nudge.
assert.equal(shouldNudgeStaleHandoffLead(lead(), false, NOW), true, "stale handoff lead must be surfaced");

// Dedupe + safety guards — each must suppress the nudge.
assert.equal(shouldNudgeStaleHandoffLead(lead(), true, NOW), false, "lead with an open todo is already covered");
assert.equal(
  shouldNudgeStaleHandoffLead(lead({ followUpCadence: { status: "active" } }), false, NOW),
  false,
  "active cadence already follows up"
);
assert.equal(
  shouldNudgeStaleHandoffLead(lead({ staleHandoffNudgedAt: daysAgo(1) }), false, NOW),
  false,
  "already nudged once — never re-nudge"
);
assert.equal(
  shouldNudgeStaleHandoffLead(lead({ closedAt: daysAgo(1) }), false, NOW),
  false,
  "closed lead"
);
assert.equal(
  shouldNudgeStaleHandoffLead(lead({ sale: { soldAt: daysAgo(1) } }), false, NOW),
  false,
  "sold lead"
);
assert.equal(
  shouldNudgeStaleHandoffLead(lead({ followUp: { mode: "active", updatedAt: daysAgo(4) } }), false, NOW),
  false,
  "only manual_handoff leads (a human owns it) qualify"
);

// Idle window: too fresh and too stale both decline.
assert.equal(
  shouldNudgeStaleHandoffLead(
    lead({ messages: [{ direction: "in", body: "hi", at: daysAgo(1) }] }),
    false,
    NOW
  ),
  false,
  "still fresh (<3 days) — give the human time"
);
assert.equal(
  shouldNudgeStaleHandoffLead(
    lead({ messages: [{ direction: "in", body: "hi", at: daysAgo(40) }] }),
    false,
    NOW
  ),
  false,
  "too stale (>21 days) — outside the re-engageable window"
);

// No real customer inbound → not a lead worth a follow-up task.
assert.equal(
  shouldNudgeStaleHandoffLead(
    lead({ messages: [{ direction: "out", body: "promo", at: daysAgo(4) }] }),
    false,
    NOW
  ),
  false,
  "no inbound from the customer"
);

// Custom idle window honored.
assert.equal(
  shouldNudgeStaleHandoffLead(
    lead({ messages: [{ direction: "in", body: "hi", at: daysAgo(2) }] }),
    false,
    NOW,
    { minIdleDays: 1, maxIdleDays: 30 }
  ),
  true,
  "respects a custom idle window"
);

console.log("PASS stale handoff follow-up eval");
