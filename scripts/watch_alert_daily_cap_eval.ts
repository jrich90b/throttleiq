/**
 * Per-conversation daily watch-alert cap + bundling eval (Joe ruling 2026-07-23).
 *
 * Production shape (MD, +19292685345): one phone call created 8 inventory watches; the customer
 * then got 2 alert texts on 7/22 and 3 more on 7/23 — two of them minutes apart — because the
 * 24h cooldown was per-WATCH only. Joe's ruling: max ONE watch-alert text per customer per day;
 * multiple same-day matches bundle into a single message; the remainder queues and goes out
 * (bundled) the next day.
 *
 * Layer 1 — the pure cap/queue logic (domain/watchAlertDailyCap.ts) + the bundle composer
 * (agentVoice.buildWatchAvailableBundleReply). Layer 2 — source guards that the ENGINE
 * (index.ts) wires the cap into BOTH fire paths (arrival cron + hold-release) and delivers the
 * queue.
 *
 * Fail direction: HOLD BACK. The cap only ever delays/bundles a send; it can never produce an
 * extra or wrong alert. The group-aware watch_fire_miss detector is the recovery net.
 *
 * Run: npx tsx scripts/watch_alert_daily_cap_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  WATCH_ALERT_DAILY_CAP_MS,
  PENDING_WATCH_ALERT_TTL_MS,
  PENDING_WATCH_ALERT_MAX,
  conversationWatchAlertBlocked,
  lastConversationWatchAlertMs,
  recordConversationWatchAlert,
  queuePendingWatchAlert,
  takeDuePendingWatchAlerts,
  hasPendingWatchAlerts
} from "../services/api/src/domain/watchAlertDailyCap.ts";
import {
  buildWatchAvailableReply,
  buildWatchAvailableBundleReply
} from "../services/api/src/domain/agentVoice.ts";

const HOUR = 60 * 60 * 1000;
const now = Date.parse("2026-07-23T17:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

// ---------- Layer 1a: the cap decision ----------

// Fresh conversation → not blocked.
assert.equal(conversationWatchAlertBlocked({}, now), false, "no alert history → not blocked");

// Conversation-level stamp inside the window → blocked; outside → open.
assert.equal(
  conversationWatchAlertBlocked({ lastWatchAlertAt: iso(now - 1 * HOUR) }, now),
  true,
  "an alert 1h ago blocks the rest of the day"
);
assert.equal(
  conversationWatchAlertBlocked({ lastWatchAlertAt: iso(now - 25 * HOUR) }, now),
  false,
  "the window expires after 24h"
);

// BACKFILL (the MD shape): pre-existing conversations only carry per-WATCH lastNotifiedAt stamps.
// The cap must read those too, so it works retroactively with no migration.
const mdShape = {
  inventoryWatches: [
    { model: "Fat Boy", status: "active", createdAt: "", lastNotifiedAt: iso(now - 48 * 60 * 1000) },
    { model: "Nightster", status: "active", createdAt: "" },
    { model: "50th Anv Sportster", status: "active", createdAt: "" }
  ]
};
assert.equal(
  conversationWatchAlertBlocked(mdShape, now),
  true,
  "a per-watch lastNotifiedAt 48min ago blocks the conversation (MD +19292685345: two alerts minutes apart must be impossible)"
);
assert.equal(
  lastConversationWatchAlertMs(mdShape),
  now - 48 * 60 * 1000,
  "conversation-level last-alert unions the per-watch stamps"
);
// The singular legacy `inventoryWatch` counts too (collectInventoryWatches union).
assert.equal(
  conversationWatchAlertBlocked(
    { inventoryWatch: { model: "Breakout", status: "active", createdAt: "", lastNotifiedAt: iso(now - 2 * HOUR) } },
    now
  ),
  true,
  "the singular legacy watch's stamp also blocks"
);

// recordConversationWatchAlert starts the window.
{
  const conv: any = {};
  recordConversationWatchAlert(conv, iso(now));
  assert.equal(conversationWatchAlertBlocked(conv, now + 1 * HOUR), true, "stamped conversation is blocked an hour later");
  assert.equal(conversationWatchAlertBlocked(conv, now + 25 * HOUR), false, "and open again the next day");
}

// ---------- Layer 1b: the pending queue ----------

const entry = (stockId: string, model: string, queuedAt: string) => ({
  watchModel: model,
  stockId,
  model,
  availability: "new" as const,
  queuedAt
});

{
  const conv: any = { lastWatchAlertAt: iso(now - 1 * HOUR) };
  assert.equal(queuePendingWatchAlert(conv, entry("STK-1", "Fat Boy", iso(now))), "queued", "capped match queues");
  assert.equal(
    queuePendingWatchAlert(conv, entry("STK-1", "Fat Boy", iso(now))),
    "duplicate",
    "the same unit re-matching on the next 5-minute sweep queues ONCE"
  );
  assert.equal(queuePendingWatchAlert(conv, entry("STK-2", "Nightster", iso(now))), "queued", "a different unit queues too");
  assert.equal(hasPendingWatchAlerts(conv), true, "queue is visible");

  // Still blocked → nothing drains, queue intact.
  assert.deepEqual(takeDuePendingWatchAlerts(conv, now), [], "nothing drains while the cap window is live");
  assert.equal(conv.pendingWatchAlerts.length, 2, "queue is untouched while blocked");

  // Next day → the whole remainder drains at once (bundled by the caller).
  const due = takeDuePendingWatchAlerts(conv, now + 25 * HOUR);
  assert.equal(due.length, 2, "the remainder goes out the NEXT DAY (Joe's ruling), all at once");
  assert.equal(conv.pendingWatchAlerts.length, 0, "queue is drained after take");
}

// TTL backstop: an entry stuck in the queue past the TTL is dropped, not sent.
{
  const conv: any = {
    pendingWatchAlerts: [
      entry("STK-9", "Road King", iso(now - PENDING_WATCH_ALERT_TTL_MS - 1 * HOUR)),
      entry("STK-10", "Street Bob", iso(now - 2 * HOUR))
    ]
  };
  const due = takeDuePendingWatchAlerts(conv, now);
  assert.equal(due.length, 1, "TTL-expired entry is dropped (stale 'just came in' would be a lie)");
  assert.equal(due[0].stockId, "STK-10", "the fresh entry survives");
}

// Hard cap on queue growth.
{
  const conv: any = { lastWatchAlertAt: iso(now - 1 * HOUR) };
  for (let i = 0; i < PENDING_WATCH_ALERT_MAX; i++) {
    assert.equal(queuePendingWatchAlert(conv, entry(`STK-${100 + i}`, `Model ${i}`, iso(now))), "queued");
  }
  assert.equal(
    queuePendingWatchAlert(conv, entry("STK-999", "Overflow", iso(now))),
    "capped",
    "queue growth is bounded"
  );
}

// Sanity on the constants the behavior above encodes.
assert.equal(WATCH_ALERT_DAILY_CAP_MS, 24 * HOUR, "daily cap window is one day");
assert.ok(PENDING_WATCH_ALERT_TTL_MS >= 24 * HOUR, "TTL cannot be shorter than the cap window");

// ---------- Layer 1c: the bundle composer ----------

// One bike delegates to the pinned single-alert copy (watch_available_reply:eval owns that shape).
assert.equal(
  buildWatchAvailableBundleReply({
    firstName: "Mark",
    bikes: [{ bikeLabel: "2025 Harley-Davidson Breakout", unitColor: "Billiard Gray" }],
    availability: "new"
  }),
  buildWatchAvailableReply({
    firstName: "Mark",
    bikeLabel: "2025 Harley-Davidson Breakout",
    unitColor: "Billiard Gray",
    availability: "new"
  }),
  "a single-bike bundle is exactly the pinned single-alert reply"
);

// Two bikes → ONE message naming both, with the still-looking ask + clean opt-out tail intact.
{
  const r = buildWatchAvailableBundleReply({
    firstName: "MD",
    bikes: [
      { bikeLabel: "2016 Harley-Davidson Fat Boy", unitColor: "Black" },
      { bikeLabel: "2012 Harley-Davidson Iron 1200" }
    ],
    availability: "new"
  });
  assert.ok(/MD/.test(r), "names the customer");
  assert.ok(/2016 Harley-Davidson Fat Boy in Black/.test(r), "names the first unit + color");
  assert.ok(/2012 Harley-Davidson Iron 1200/.test(r), "names the second unit");
  assert.ok(/couple of bikes/.test(r), "reads as one bundled heads-up, not a drip");
  assert.ok(/just came in/.test(r), "new arrivals => 'just came in'");
  assert.ok(/still looking/i.test(r), "keeps the still-looking ask");
  assert.ok(/take you off the list/i.test(r), "keeps the clean opt-out (watch-opt-out parser backs it)");
  assert.ok(!/undefined|null/.test(r), "no template junk");
}

// Three bikes + availability variants + nameless lead.
{
  const r = buildWatchAvailableBundleReply({
    bikes: [{ bikeLabel: "Fat Boy" }, { bikeLabel: "Nightster" }, { bikeLabel: "Road King" }],
    availability: "in_stock"
  });
  assert.ok(/few bikes/.test(r), "3+ => 'a few bikes'");
  assert.ok(/are in stock now/.test(r), "in_stock => plural 'are in stock now'");
  assert.ok(/Fat Boy/.test(r) && /Nightster/.test(r) && /Road King/.test(r), "every bundled unit is named");
  assert.ok(!/undefined|null/.test(r), "nameless lead stays clean");
  assert.ok(
    /are available again/.test(
      buildWatchAvailableBundleReply({ bikes: [{ bikeLabel: "A" }, { bikeLabel: "B" }], availability: "again" })
    ),
    "again => plural 'are available again'"
  );
}

// ---------- Layer 2: engine wiring (source guards) ----------

const idx = fs.readFileSync("services/api/src/index.ts", "utf8");

// The cap gates all three watch-text sources: arrival-cron matches, the hold-release path, and
// the sibling-scope ask.
assert.ok(
  (idx.match(/conversationWatchAlertBlocked\(conv, Date\.now\(\)\)/g) ?? []).length >= 3,
  "engine checks the daily cap at the cron path, the hold-release path, AND the sibling-scope ask"
);
// Capped matches QUEUE (both fire paths), never silently drop.
assert.ok(
  (idx.match(/queuePendingWatchAlert\(/g) ?? []).length >= 2,
  "both fire paths queue capped-off matches for next-day delivery"
);
// Every alert-text send stamps the conversation-level window (cron send, hold-release send,
// sibling ask, and the pending-queue delivery).
assert.ok(
  (idx.match(/recordConversationWatchAlert\(conv, /g) ?? []).length >= 4,
  "every watch-text send site stamps the conversation-level daily-cap window"
);
// The queue is actually delivered: the cron sweep flushes due pending alerts (bundled)...
assert.match(idx, /deliverDuePendingWatchAlerts\(conv, \{/, "the cron sweep delivers due pending alerts");
assert.match(idx, /takeDuePendingWatchAlerts\(conv, Date\.now\(\)\)/, "delivery drains via the cap-aware take");
// ...and delivery re-verifies availability (hold/sold + still-in-feed) so a queued unit that got
// sold overnight is dropped, never announced.
assert.match(
  idx,
  /normalizeInventoryHoldKey\(entry\.stockId \?\? null, entry\.vin \?\? null\)/,
  "pending delivery rechecks holds"
);
assert.match(
  idx,
  /normalizeInventorySoldKey\(entry\.stockId \?\? null, entry\.vin \?\? null\)/,
  "pending delivery rechecks solds"
);
// Same-sweep multi-watch matches bundle into ONE text instead of first-match-wins.
assert.match(idx, /buildWatchAvailableBundleReply\(\{/, "the engine composes bundles via the shared builder");
// The cron no longer bails before the conversation loop when nothing new arrived — pending
// delivery must run on ordinary quiet sweeps.
assert.ok(
  !/const newItemKeys = new Set\(newItems\.map\(i => inventoryKey\(i\)\)\.filter\(Boolean\)\);\s*\n\s*if \(!candidateItems\.length\) return;/.test(idx) &&
    /if \(!candidateItems\.length\) continue; \/\/ flush-only sweep/.test(idx),
  "quiet sweeps still deliver the pending queue (flush-only pass)"
);

console.log(
  "PASS watch-alert daily cap eval — one alert text per conversation per day (per-watch stamps backfill the window), capped matches queue + bundle next day with availability recheck, both fire paths + sibling ask gated, composer keeps the still-looking ask + opt-out."
);
