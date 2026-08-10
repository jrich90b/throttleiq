/**
 * Unanswered inventory-watch alerts → pause the watches, raise a person (Joseph +17163308822).
 *
 * Production shape: Joseph asked on 2026-05-05 to be told when a 2026 Road Glide landed and never
 * wrote again. Four more alerts followed — 05-07, 06-05, 07-03, 07-23 — each on a genuinely
 * different arriving unit, each fired once, each inside the one-alert-per-day cap. Every individual
 * send was correct. The engine had no read on whether anyone was still on the other end, because
 * every existing suppression is EXPLICIT (opt-out, suppression list, held lead, same-unit dedupe)
 * and silence is none of those.
 *
 * Layer 1 — the pure decision (domain/watchAlertUnansweredPause.ts), executed on fixtures.
 * Layer 2 — the copy contract: every watch-alert builder still emits the marker the counter reads,
 *           so a copy edit breaks THIS eval instead of silently blinding the detector.
 * Layer 3 — engine wiring: BOTH fire paths call the apply helper and record why they stopped.
 *
 * Fail direction: the rule can only ever STOP an outbound text and hand the lead to a person. It
 * cannot cause a send, and one inbound message of any kind resets the run to zero. The compensating
 * control is the staff task — the alert is not dropped, it changes hands.
 *
 * Blast radius, measured against the live store 2026-08-10 with the predicate below: at the default
 * limit of 3, ZERO conversations pause today (nobody is silenced retroactively); at limit 2 it would
 * be 3, all of them silent 2-3 months. The limit is env-tunable (WATCH_UNANSWERED_ALERT_PAUSE_LIMIT).
 *
 * Clock-safe: the decision compares ISO strings only and never reads a clock, so the fixtures below
 * are fixed dates and can never age out at midnight.
 *
 * Run: npx tsx scripts/watch_alert_unanswered_pause_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  DEFAULT_UNANSWERED_WATCH_ALERT_LIMIT,
  WATCH_ALERT_OPT_OFF_MARKER,
  WATCH_ALERT_WATCHING_FOR_MARKER,
  WATCH_CLOSE_OUT_MARKER,
  countUnansweredDeliveredWatchAlerts,
  decideUnansweredWatchAlertPause,
  hasSentWatchCloseOut,
  isInventoryWatchAlertBody,
  isInventoryWatchCloseOutBody,
  lastInboundAt,
  unansweredWatchAlertLimit
} from "../services/api/src/domain/watchAlertUnansweredPause.ts";
import {
  buildWatchAvailableReply,
  buildWatchAvailableBundleReply,
  buildCholoWatchAvailableReply,
  buildUnansweredWatchCloseOutReply
} from "../services/api/src/domain/agentVoice.ts";

const alertBody = buildWatchAvailableReply({
  firstName: "Joseph",
  bikeLabel: "2026 Harley-Davidson Road Glide",
  unitColor: "Vivid Black",
  availability: "new"
});

const inbound = (at: string, body = "yes still looking") => ({ direction: "in", provider: "twilio", at, body });
const sentAlert = (at: string) => ({ direction: "out", provider: "twilio", at, body: alertBody });
const draftAlert = (at: string) => ({ direction: "out", provider: "draft_ai", at, body: alertBody, draftStatus: "pending" });
const staleAlert = (at: string) => ({ direction: "out", provider: "twilio", at, body: alertBody, draftStatus: "stale" });
const failedAlert = (at: string) => ({ direction: "out", provider: "twilio", at, body: alertBody, deliveredToCustomer: false });
const ordinaryReply = (at: string) => ({ direction: "out", provider: "twilio", at, body: "Yes that Street Glide is still available. Want to stop in?" });

// ---------- Layer 1a: what counts ----------

assert.equal(DEFAULT_UNANSWERED_WATCH_ALERT_LIMIT, 3, "default allowance is three delivered alerts");
assert.equal(unansweredWatchAlertLimit({}), 3, "no env override → the default");
assert.equal(unansweredWatchAlertLimit({ WATCH_UNANSWERED_ALERT_PAUSE_LIMIT: "2" }), 2, "env tunes the limit");
assert.equal(unansweredWatchAlertLimit({ WATCH_UNANSWERED_ALERT_PAUSE_LIMIT: "junk" }), 3, "garbage falls back to the default");
assert.equal(unansweredWatchAlertLimit({ WATCH_UNANSWERED_ALERT_PAUSE_LIMIT: "0" }), 3, "a zero limit would mute everyone — refused");

assert.equal(isInventoryWatchAlertBody(alertBody), true, "the real alert copy is recognised");
assert.equal(
  isInventoryWatchAlertBody("Yes that Street Glide is still available. Want to stop in?"),
  false,
  "an ordinary availability answer is NOT a watch alert (it would pause a watch on a message that never was one)"
);
assert.equal(isInventoryWatchAlertBody(""), false, "empty body is not an alert");
assert.equal(isInventoryWatchAlertBody(undefined), false, "missing body is not an alert");

// ---------- Layer 1b: DELIVERED only ----------
{
  const at = "2026-07-01T12:00:00.000Z";
  assert.equal(countUnansweredDeliveredWatchAlerts({ messages: [sentAlert(at)] }), 1, "a sent alert counts");
  assert.equal(
    countUnansweredDeliveredWatchAlerts({ messages: [draftAlert(at)] }),
    0,
    "a draft awaiting staff approval never reached the customer — it cannot be evidence they ignored us"
  );
  assert.equal(countUnansweredDeliveredWatchAlerts({ messages: [staleAlert(at)] }), 0, "a stale draft never went out");
  assert.equal(
    countUnansweredDeliveredWatchAlerts({ messages: [failedAlert(at)] }),
    0,
    "a send that failed (deliveredToCustomer:false) never reached them"
  );
  assert.equal(countUnansweredDeliveredWatchAlerts({ messages: [ordinaryReply(at)] }), 0, "ordinary outbound is not an alert");
}

// ---------- Layer 1c: the run resets on ANY inbound ----------
{
  // Joseph's real shape, reduced: last inbound 05-05, then alerts on 07-03 and 07-23.
  const conv = {
    messages: [
      inbound("2026-05-05T13:06:00.000Z"),
      sentAlert("2026-07-03T14:16:00.000Z"),
      sentAlert("2026-07-23T16:13:00.000Z")
    ]
  };
  assert.equal(lastInboundAt(conv), "2026-05-05T13:06:00.000Z", "the run is measured from the last thing they said");
  assert.equal(countUnansweredDeliveredWatchAlerts(conv), 2, "two delivered alerts since they last spoke");
  assert.equal(decideUnansweredWatchAlertPause(conv).pause, false, "two is inside the allowance — keep alerting");

  const third = { messages: [...conv.messages, sentAlert("2026-08-09T15:00:00.000Z")] };
  const decision = decideUnansweredWatchAlertPause(third);
  assert.equal(decision.pause, true, "the third unanswered delivered alert stops the fourth text");
  assert.equal(decision.delivered, 3, "the decision reports the count it acted on");
  assert.equal(decision.limit, 3, "the decision reports the limit it applied");
  assert.ok(decision.summary.includes("2026-05-05"), "the staff task states when we last heard from them");
  assert.ok(/call/i.test(decision.summary), "the staff task asks for a call, not another text");

  // One word back from the customer clears the whole run — even mid-sequence.
  const answered = { messages: [...third.messages, inbound("2026-08-09T16:00:00.000Z", "yes!")] };
  assert.equal(countUnansweredDeliveredWatchAlerts(answered), 0, "any inbound resets the run to zero");
  assert.equal(decideUnansweredWatchAlertPause(answered).pause, false, "an answered customer keeps their alerts");

  // ...and a later alert after that reply starts counting from one again.
  const afterReply = { messages: [...answered.messages, sentAlert("2026-08-10T09:00:00.000Z")] };
  assert.equal(countUnansweredDeliveredWatchAlerts(afterReply), 1, "counting restarts after the reply, it does not resume");
}

// ---------- Layer 1d: a lead who has NEVER written ----------
{
  // An ADF/web lead we opened the conversation on: no inbound at all, so every alert counts.
  const conv = {
    messages: [sentAlert("2026-06-01T12:00:00.000Z"), sentAlert("2026-07-01T12:00:00.000Z"), sentAlert("2026-08-01T12:00:00.000Z")]
  };
  assert.equal(lastInboundAt(conv), "", "no inbound → empty marker");
  const decision = decideUnansweredWatchAlertPause(conv);
  assert.equal(decision.pause, true, "three alerts at someone who has never written stops the fourth");
  assert.ok(decision.summary.includes("never"), "the staff task says we have never heard from them");
}

// Empty / malformed conversations are inert (never pause on nothing).
assert.equal(decideUnansweredWatchAlertPause({}).pause, false, "no messages → no pause");
assert.equal(decideUnansweredWatchAlertPause({ messages: null } as any).pause, false, "null messages → no pause");
assert.equal(countUnansweredDeliveredWatchAlerts({ messages: [{} as any] }), 0, "a junk row is not an alert");

// ---------- Layer 2: the copy contract ----------
// Every builder that can produce a watch alert must still carry a marker the counter reads. If this
// fails, the copy moved and the detector went blind — fix BOTH together.
{
  const bodies = [
    buildWatchAvailableReply({ firstName: "Joseph", bikeLabel: "2026 Road Glide", unitColor: "Vivid Black", availability: "new" }),
    buildWatchAvailableReply({ bikeLabel: "2026 Road Glide", unitColor: "Teal", watchedColor: "Black", availability: "in_stock" }),
    buildWatchAvailableBundleReply({
      firstName: "MD",
      bikes: [{ bikeLabel: "2016 Fat Boy" }, { bikeLabel: "2012 Iron 1200" }],
      availability: "new"
    }),
    buildCholoWatchAvailableReply({ firstName: "Luis", bikeLabel: "2020 Road King", availability: "again" })
  ];
  for (const body of bodies) {
    assert.ok(
      isInventoryWatchAlertBody(body),
      `every watch-alert builder must stay recognisable to the unanswered counter: ${body.slice(0, 60)}...`
    );
  }
  assert.ok(
    bodies.every(b => b.toLowerCase().includes(WATCH_ALERT_OPT_OFF_MARKER)),
    "the opt-off tail is the primary marker and every builder emits it"
  );
  assert.ok(
    bodies.some(b => b.toLowerCase().includes(WATCH_ALERT_WATCHING_FOR_MARKER)),
    "the 'you were watching for' claim is the secondary marker (it predates the current tail)"
  );
}

// ---------- Layer 3: engine wiring ----------
const idx = fs.readFileSync("services/api/src/index.ts", "utf8");
const store = fs.readFileSync("services/api/src/domain/conversationStore.ts", "utf8");
const pure = fs.readFileSync("services/api/src/domain/watchAlertUnansweredPause.ts", "utf8");

// BOTH fire paths call it — exactly two sites, one per path. A count, not a substring: an unwired
// site sits beside other guards and would otherwise pass unnoticed.
assert.equal(
  (idx.match(/applyUnansweredWatchAlertPause\(conv, /g) ?? []).length,
  2,
  "the arrival cron AND the hold-release path both stop on an unanswered run (2 call sites)"
);
// Each stop records WHY, so a paused watch is never an invisible silence.
assert.equal(
  (idx.match(/inventory_watch_paused_unanswered/g) ?? []).length,
  2,
  "both stops record a route outcome naming the reason"
);
// The cron stop sits ABOVE the pending-queue flush, or a capped-off alert would still slip out.
// Both anchors must be FOUND first: `indexOf` returns -1 for a missing string, and -1 < anything is
// true, so an unanchored comparison would pass vacuously the moment either call site is reworded.
const stopAt = idx.indexOf("applyUnansweredWatchAlertPause(conv, nowIso)");
const flushAt = idx.indexOf("deliverDuePendingWatchAlerts(conv, {");
assert.ok(stopAt >= 0, "the cron stop call site is present (verbatim) — the ordering check needs an anchor");
assert.ok(flushAt >= 0, "the pending-queue flush call site is present — the ordering check needs an anchor");
assert.ok(stopAt < flushAt, "the stop is checked before yesterday's queued alerts are flushed");
// The pause reuses the existing referee rather than writing watch state inline.
assert.ok(
  /export function applyUnansweredWatchAlertPause\(/.test(store) && /const paused = pauseInventoryWatches\(conv\);/.test(store),
  "the pause goes through pauseInventoryWatches — no new writer of inventoryWatches"
);
// A staff task replaces the text, so the alert changes hands instead of being dropped.
assert.ok(
  /addTodo\(conv, "call", decision\.summary/.test(store),
  "a staff task is raised in place of the suppressed text"
);
// The decision module must stay import-free: importing conversationStore creates the JSON store on
// load, which would make this eval a shared-file barrier in the gate chain.
assert.equal(
  (pure.match(/^import\s/gm) ?? []).length,
  0,
  "watchAlertUnansweredPause.ts stays import-free (no store side effect on load)"
);

// ═══ THE CLOSE-OUT (Joe, 2026-08-10) ═══════════════════════════════════════════════════
// "Should there be a close out text leaving the floor open to keep the watch or let us know if
// they are looking for something different?" — yes. A silent pause drops the lead invisibly.
{
  const closeOut = buildUnansweredWatchCloseOutReply({
    firstName: "Joseph",
    bikeLabel: "2026 Road Glide"
  });

  // ── The invariant that makes the whole thing safe: our own sign-off is NOT an alert. ──
  // Without this the goodbye text counts itself, so on a lead who never replies the run reads
  // one higher than the customer's real silence.
  assert.equal(
    isInventoryWatchAlertBody(closeOut),
    false,
    "the close-out must NEVER be counted as a watch alert — it is our sign-off, not an arrival"
  );
  assert.equal(isInventoryWatchCloseOutBody(closeOut), true, "the close-out carries its own marker");
  assert.ok(
    closeOut.toLowerCase().includes(WATCH_CLOSE_OUT_MARKER),
    "the marker must be the literal copy, so a reword breaks this eval instead of blinding the guard"
  );
  // The exclusion must actually WORK, not merely be unreachable because today's wording happens
  // to avoid the alert markers. A sign-off is a natural place to write "take you off the list",
  // so pin the precedence directly: close-out marker present => NOT an alert, whatever else the
  // sentence says. (A sabotage that deleted the exclusion passed until this assertion existed.)
  const closeOutBorrowingAlertWords =
    `Hey Joseph — a 2026 Road Glide you were watching for came in, but I'll ${WATCH_CLOSE_OUT_MARKER}. ` +
    `Just let me know and I'll take you off the list. Keep an eye out, or something different?`;
  assert.equal(
    isInventoryWatchCloseOutBody(closeOutBorrowingAlertWords),
    true,
    "a close-out is a close-out even when it borrows alert wording"
  );
  assert.equal(
    isInventoryWatchAlertBody(closeOutBorrowingAlertWords),
    false,
    "the close-out marker must OUTRANK both alert markers, or our sign-off counts as a 4th alert"
  );
  assert.equal(
    countUnansweredDeliveredWatchAlerts({
      messages: [
        { direction: "in", at: "2026-05-05T00:00:00Z", body: "let me know" },
        { direction: "out", at: "2026-05-07T00:00:00Z", provider: "twilio", body: alertBody },
        { direction: "out", at: "2026-06-05T00:00:00Z", provider: "twilio", body: closeOutBorrowingAlertWords }
      ]
    }),
    1,
    "one alert plus a marker-borrowing close-out is ONE alert"
  );

  // Belt and braces: the two alert markers must be absent outright, not merely out-ranked.
  for (const marker of [WATCH_ALERT_OPT_OFF_MARKER, WATCH_ALERT_WATCHING_FOR_MARKER]) {
    assert.ok(
      !closeOut.toLowerCase().includes(marker),
      `the close-out must not borrow the alert marker ${JSON.stringify(marker)}`
    );
  }

  // ── Charter C1.7 on the template: end by ASKING, one question, a choice of two. ──
  assert.ok(closeOut.trim().endsWith("?"), "C1.7: the close-out must end by asking");
  assert.equal((closeOut.match(/\?/g) ?? []).length, 1, "exactly one question");
  assert.ok(closeOut.includes(" or "), "C1.7 prefers a choice of two");

  // ── The promise is scoped to what we control. ──
  // A quiet thread still gets marketing campaigns, and the cadence ladder already has form for
  // promising quiet and texting on. Claiming total silence would put a lie in a customer's hand.
  for (const overclaim of [
    "you won't hear from",
    "you will not hear from",
    "stop texting you",
    "no more texts",
    "remove you from our list",
    "take you off the list"
  ]) {
    assert.ok(
      !closeOut.toLowerCase().includes(overclaim),
      `the close-out must not promise more silence than we can keep: ${JSON.stringify(overclaim)}`
    );
  }
  assert.ok(
    /alerts/i.test(closeOut),
    "it must say what actually stops — the ALERTS — rather than gesture at silence"
  );

  // ── It leaves the floor open BOTH ways, which is the whole point of Joe's ask. ──
  assert.ok(/keep an eye out/i.test(closeOut), "offers to keep the watch running");
  assert.ok(/something different/i.test(closeOut), "invites them to say the spec changed");

  // ── Never names a bike the customer did not ask for; generic when we do not know. ──
  assert.ok(closeOut.includes("2026 Road Glide"), "names the watched model when there is exactly one");
  const generic = buildUnansweredWatchCloseOutReply({ firstName: "Joseph", bikeLabel: null });
  assert.ok(
    !/\b(19|20)\d{2}\b/.test(generic),
    "with no single watched model the close-out names no bike at all"
  );
  assert.ok(generic.trim().endsWith("?"), "the generic form still ends by asking");

  // ── Sent once, ever. ──
  assert.equal(hasSentWatchCloseOut({ messages: [] }), false, "no close-out on a fresh thread");
  assert.equal(
    hasSentWatchCloseOut({ messages: [{ direction: "out", provider: "twilio", body: closeOut }] }),
    true,
    "a delivered close-out is remembered, so the pause cannot queue a second one"
  );
  assert.equal(
    hasSentWatchCloseOut({ messages: [{ direction: "out", provider: "draft_ai", body: closeOut }] }),
    true,
    "a close-out still awaiting staff approval also blocks a second one"
  );
  assert.equal(
    hasSentWatchCloseOut({
      messages: [{ direction: "out", provider: "draft_ai", draftStatus: "stale", body: closeOut }]
    }),
    false,
    "a STALE close-out never reached the customer, so it must not block the real one"
  );
  assert.equal(
    hasSentWatchCloseOut({ messages: [{ direction: "in", body: closeOut }] }),
    false,
    "a customer quoting our text back is not us having sent it"
  );

  // ── The counter still sees the alerts themselves when a close-out sits among them. ──
  const alertsPlusCloseOut = {
    messages: [
      { direction: "in", at: "2026-05-05T00:00:00Z", body: "let me know when one lands" },
      { direction: "out", at: "2026-05-07T00:00:00Z", provider: "twilio", body: alertBody },
      { direction: "out", at: "2026-06-05T00:00:00Z", provider: "twilio", body: alertBody },
      { direction: "out", at: "2026-07-03T00:00:00Z", provider: "twilio", body: alertBody },
      { direction: "out", at: "2026-07-23T00:00:00Z", provider: "twilio", body: closeOut }
    ]
  };
  assert.equal(
    countUnansweredDeliveredWatchAlerts(alertsPlusCloseOut),
    3,
    "three alerts and one close-out counts as THREE — the sign-off is not a fourth alert"
  );
}

console.log(
  "PASS watch-alert unanswered pause eval — after 3 DELIVERED alerts with no reply the watches pause and a staff task replaces the text; drafts/stale/failed sends never count, any inbound resets the run, both fire paths wired and both record why."
);
