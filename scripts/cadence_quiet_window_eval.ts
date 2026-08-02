/**
 * cadence_quiet_window:eval — ONE referee for how long the follow-up cadence goes quiet after the
 * agent has just reached out.
 *
 * WHAT WAS FIGHTING. Four places in index.ts each decided this for themselves, three of them
 * byte-identical copy-paste:
 *
 *   deliverDuePendingWatchAlerts            "we just texted them the bike they were watching"
 *   processInventoryWatchlist               same, from the feed sweep
 *   notifyInventoryWatchersForAvailableItem same, from a hold/sold clearing
 *   applySoftVisitCadenceWindow             "they said they'd stop by Saturday"
 *
 * Nothing arbitrated, so fixing one left the other three behind. That is the exact shape that
 * produced PR #398 (two writers of `followUpCadence` disagreeing 37 seconds apart, putting a
 * just-declined customer back on the fast chase).
 *
 * FAIL DIRECTION. Quieting only ever DELAYS a proactive touch — it never sends one — and we have
 * just messaged this customer, so the failure to avoid is chasing them on top of that message.
 * Ambiguity therefore quiets. The one thing it must never do is resurrect a cadence that is not
 * running: the quiet is applied only to a cadence that is genuinely active.
 *
 * THE STOPPED-CADENCE RULING (Joe, 2026-08-01: "make it match the other paths").
 * A customer who said "I'll be there Saturday" on a STOPPED cadence used to get nothing: the
 * soft-visit path never blanked the stopped cadence, so startFollowUpCadence refused to overwrite
 * it and silently no-op'd — no day-before "still planning to stop by?" reminder, and no follow-up
 * after the visit day. Soft visits now revive a stopped cadence exactly like the watch paths do.
 *
 * ONE CARVE-OUT, and it is load-bearing. `setFollowUpMode(conv, "manual_handoff")` stops the
 * cadence on purpose — "a handed-off lead must not keep an ACTIVE customer cadence — otherwise it
 * can auto-text the customer mid-handoff (audited contradiction class)". The watch paths escape
 * that by flipping the mode to `holding_inventory` first; the soft-visit path deliberately
 * PRESERVES `manual_handoff`. So a literal match would leave a human-owned thread carrying a live
 * automated cadence. `manual_handoff` and `paused_indefinite` therefore keep their stopped cadence.
 * Fail direction of the carve-out is safe: it only ever means FEWER proactive touches.
 *
 * STILL DIVERGENT BY DESIGN: only the soft-visit path re-opens the schedule-invite budget (a fresh
 * visit commitment earns a fresh "what time works?"). The watch paths leave the counter alone.
 *
 * Behavior assertions only — no source-text pins (see eval_source_pin_ratchet:eval).
 *
 * Run: npx tsx scripts/cadence_quiet_window_eval.ts
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH ||
  path.join(os.tmpdir(), `cadence-quiet-window-eval-${Date.now()}.json`);

const { decideCadenceQuietWindow } = await import(
  "../services/api/src/domain/routeStateReducer.ts"
);
const { applyCadenceQuietWindow, upsertConversationByLeadKey } = await import(
  "../services/api/src/domain/conversationStore.ts"
);

const TZ = "America/New_York";
const QUIET_UNTIL = "2026-08-08T14:30:00.000Z";
const ANCHOR = "2026-08-01T14:30:00.000Z";

let checks = 0;
const ok = (condition: boolean, message: string) => {
  assert.equal(condition, true, message);
  checks++;
};
const eq = (actual: unknown, expected: unknown, message: string) => {
  assert.deepEqual(actual, expected, message);
  checks++;
};

// ---------------------------------------------------------------------------
// 1. THE DECISION TABLE. status x trigger -> restart / clear-stopped / quiet.
// ---------------------------------------------------------------------------
type Row = {
  trigger: "inventory_watch_alert" | "soft_visit_window";
  status: string | null;
  mode?: string | null;
  restartCadence: boolean;
  clearStoppedCadenceFirst: boolean;
  resetScheduleInvites: boolean;
  note: string;
};

const TABLE: Row[] = [
  // A running cadence: quiet it in place, never restart it (restarting would reset stepIndex and
  // walk the ramp from the top — the customer would be re-chased from day 1).
  {
    trigger: "inventory_watch_alert",
    status: "active",
    restartCadence: false,
    clearStoppedCadenceFirst: false,
    resetScheduleInvites: false,
    note: "watch alert on a running cadence — hold it where it is"
  },
  {
    trigger: "soft_visit_window",
    status: "active",
    restartCadence: false,
    clearStoppedCadenceFirst: false,
    resetScheduleInvites: true,
    note: "soft visit on a running cadence — hold it, and re-open the invite budget"
  },
  // No cadence at all: a lead we just alerted deserves one, so start it, then quiet it.
  {
    trigger: "inventory_watch_alert",
    status: null,
    restartCadence: true,
    clearStoppedCadenceFirst: true,
    resetScheduleInvites: false,
    note: "watch alert with no cadence — start one, then hold it"
  },
  {
    trigger: "soft_visit_window",
    status: null,
    restartCadence: true,
    clearStoppedCadenceFirst: true,
    resetScheduleInvites: true,
    note: "soft visit with no cadence — start one, then hold it"
  },
  // THE RULING: a stopped cadence is now revived by BOTH triggers.
  {
    trigger: "inventory_watch_alert",
    status: "stopped",
    restartCadence: true,
    clearStoppedCadenceFirst: true,
    resetScheduleInvites: false,
    note: "watch alert on a stopped cadence — blank it so the restart actually takes"
  },
  {
    trigger: "soft_visit_window",
    status: "stopped",
    restartCadence: true,
    clearStoppedCadenceFirst: true,
    resetScheduleInvites: true,
    note: "soft visit on a stopped cadence — now revives it too (Joe 8/1: make it match)"
  },
  // THE CARVE-OUT: never revive a chase a human owns or a deliberate pause ended.
  {
    trigger: "soft_visit_window",
    status: "stopped",
    mode: "manual_handoff",
    restartCadence: false,
    clearStoppedCadenceFirst: false,
    resetScheduleInvites: true,
    note: "soft visit on a HUMAN-OWNED thread — the stopped cadence stays stopped"
  },
  {
    trigger: "soft_visit_window",
    status: "stopped",
    mode: "paused_indefinite",
    restartCadence: false,
    clearStoppedCadenceFirst: false,
    resetScheduleInvites: true,
    note: "soft visit on a deliberately paused thread — the stopped cadence stays stopped"
  },
  {
    trigger: "soft_visit_window",
    status: "stopped",
    mode: "holding_inventory",
    restartCadence: true,
    clearStoppedCadenceFirst: true,
    resetScheduleInvites: true,
    note: "holding_inventory is NOT a block — a watch hold still earns the visit reminder"
  },
  // The carve-out is soft-visit only: the watch paths flip the mode themselves, so a handoff
  // mode reaching them is already on its way to holding_inventory and must not block the revival.
  {
    trigger: "inventory_watch_alert",
    status: "stopped",
    mode: "manual_handoff",
    restartCadence: true,
    clearStoppedCadenceFirst: true,
    resetScheduleInvites: false,
    note: "watch alert ignores the mode — it sets holding_inventory itself before quieting"
  },
  // A completed cadence is neither running nor stopped: nothing restarts it, and the quiet is
  // applied only if it turns out to be active (it is not), so this lead is left alone.
  {
    trigger: "inventory_watch_alert",
    status: "completed",
    restartCadence: false,
    clearStoppedCadenceFirst: false,
    resetScheduleInvites: false,
    note: "watch alert on a completed cadence — no restart"
  }
];

for (const row of TABLE) {
  const decision = decideCadenceQuietWindow({
    trigger: row.trigger,
    cadenceStatus: row.status,
    followUpMode: row.mode ?? null
  });
  eq(decision.restartCadence, row.restartCadence, `${row.note}: restartCadence`);
  eq(
    decision.clearStoppedCadenceFirst,
    row.clearStoppedCadenceFirst,
    `${row.note}: clearStoppedCadenceFirst`
  );
  eq(
    decision.resetScheduleInvites,
    row.resetScheduleInvites,
    `${row.note}: resetScheduleInvites`
  );
  eq(decision.quiet, true, `${row.note}: quieting is the safe direction — always decided`);
}

// Reasons: the trigger's own default, overridable by the caller (the hold/sold-clearing path
// passes its own reason through).
eq(
  decideCadenceQuietWindow({ trigger: "inventory_watch_alert", cadenceStatus: "active" }).reason,
  "inventory_watch_match",
  "watch alerts record inventory_watch_match"
);
eq(
  decideCadenceQuietWindow({ trigger: "soft_visit_window", cadenceStatus: "active" }).reason,
  "soft_visit_window",
  "soft visits record soft_visit_window"
);
eq(
  decideCadenceQuietWindow({
    trigger: "inventory_watch_alert",
    cadenceStatus: "active",
    reason: "inventory_hold_cleared"
  }).reason,
  "inventory_hold_cleared",
  "a caller-supplied reason wins over the trigger default"
);
for (const blank of [null, undefined, "", "   "]) {
  eq(
    decideCadenceQuietWindow({
      trigger: "inventory_watch_alert",
      cadenceStatus: "active",
      reason: blank as any
    }).reason,
    "inventory_watch_match",
    "a blank reason falls back to the trigger default rather than recording an empty reason"
  );
}

// Status is read case/whitespace-insensitively — a stored "Active" must not read as "no cadence"
// and trigger a restart that resets the ramp.
for (const messy of ["ACTIVE", " active ", "Active"]) {
  eq(
    decideCadenceQuietWindow({ trigger: "inventory_watch_alert", cadenceStatus: messy })
      .restartCadence,
    false,
    `"${messy}" is a running cadence — no restart`
  );
}

// ---------------------------------------------------------------------------
// 2. THE APPLIER, against a real conversation store.
// ---------------------------------------------------------------------------
let seq = 0;
const mkConv = (cadence: any): any => {
  const conv: any = upsertConversationByLeadKey(
    `+1555300${String(seq++).padStart(4, "0")}`,
    "suggest"
  );
  conv.status = "open";
  conv.followUpCadence = cadence;
  return conv;
};

const ACTIVE = () => ({
  status: "active",
  kind: "standard",
  stepIndex: 3,
  anchorAt: "2026-07-20T14:00:00.000Z",
  nextDueAt: "2026-08-02T14:30:00.000Z",
  scheduleInviteCount: 2,
  scheduleMuted: true
});

// A running cadence is held in place: same step, same anchor, new quiet window.
{
  const conv = mkConv(ACTIVE());
  applyCadenceQuietWindow(conv, {
    trigger: "inventory_watch_alert",
    quietUntilIso: QUIET_UNTIL,
    anchorAtIso: ANCHOR,
    timeZone: TZ
  });
  eq(conv.followUpCadence.pausedUntil, QUIET_UNTIL, "watch alert sets the quiet window");
  eq(conv.followUpCadence.pauseReason, "inventory_watch_match", "and records why");
  eq(conv.followUpCadence.nextDueAt, QUIET_UNTIL, "the next touch moves to the end of the window");
  eq(conv.followUpCadence.stepIndex, 3, "the ramp position is NOT reset — no re-chase from day 1");
  eq(conv.followUpCadence.anchorAt, "2026-07-20T14:00:00.000Z", "the anchor is untouched");
  eq(conv.followUpCadence.scheduleInviteCount, 2, "the watch path leaves the invite budget alone");
  eq(conv.followUpCadence.scheduleMuted, true, "including the mute");
}

// DIVERGENCE (2): a soft visit re-opens the invite budget on the same cadence.
{
  const conv = mkConv(ACTIVE());
  applyCadenceQuietWindow(conv, {
    trigger: "soft_visit_window",
    quietUntilIso: QUIET_UNTIL,
    anchorAtIso: ANCHOR,
    timeZone: TZ
  });
  eq(conv.followUpCadence.pauseReason, "soft_visit_window", "soft visit records its own reason");
  eq(conv.followUpCadence.scheduleInviteCount, 0, "a fresh visit commitment re-opens the budget");
  eq(conv.followUpCadence.scheduleMuted, false, "and un-mutes the invite");
  eq(conv.followUpCadence.stepIndex, 3, "still no ramp reset");
}

// No cadence at all: both triggers start one and then quiet it.
for (const trigger of ["inventory_watch_alert", "soft_visit_window"] as const) {
  const conv = mkConv(undefined);
  applyCadenceQuietWindow(conv, {
    trigger,
    quietUntilIso: QUIET_UNTIL,
    anchorAtIso: ANCHOR,
    timeZone: TZ
  });
  ok(!!conv.followUpCadence, `${trigger}: a cadence now exists`);
  eq(conv.followUpCadence.status, "active", `${trigger}: it is running`);
  eq(conv.followUpCadence.pausedUntil, QUIET_UNTIL, `${trigger}: and immediately quiet`);
}

// THE RULING, executed end-to-end: a STOPPED cadence is revived by BOTH triggers now.
{
  const stopped = () => ({
    status: "stopped",
    kind: "standard",
    stepIndex: 2,
    anchorAt: "2026-07-20T14:00:00.000Z",
    stopReason: "ack_after_soft_close"
  });

  const watchConv = mkConv(stopped());
  applyCadenceQuietWindow(watchConv, {
    trigger: "inventory_watch_alert",
    quietUntilIso: QUIET_UNTIL,
    anchorAtIso: ANCHOR,
    timeZone: TZ
  });
  eq(
    watchConv.followUpCadence.status,
    "active",
    "watch alert revives a stopped cadence (it blanks it first)"
  );
  eq(watchConv.followUpCadence.pausedUntil, QUIET_UNTIL, "and quiets the revived cadence");

  // THE FIX: this used to leave the lead stopped with no quiet window at all, so the customer
  // never got the day-before "still planning to stop by?" reminder.
  const visitConv = mkConv(stopped());
  applyCadenceQuietWindow(visitConv, {
    trigger: "soft_visit_window",
    quietUntilIso: QUIET_UNTIL,
    anchorAtIso: ANCHOR,
    timeZone: TZ
  });
  eq(
    visitConv.followUpCadence.status,
    "active",
    "soft visit now revives a stopped cadence too (Joe 8/1)"
  );
  eq(
    visitConv.followUpCadence.pausedUntil,
    QUIET_UNTIL,
    "and holds it until the day-before reminder — the reminder the customer used to never get"
  );

  // THE CARVE-OUT, executed: a human owns this thread, so the cadence stays dead. Reviving it
  // would re-create the contradiction setFollowUpMode guards against (auto-texting mid-handoff).
  for (const mode of ["manual_handoff", "paused_indefinite"]) {
    const guarded = mkConv(stopped());
    guarded.followUp = { mode, updatedAt: ANCHOR };
    applyCadenceQuietWindow(guarded, {
      trigger: "soft_visit_window",
      quietUntilIso: QUIET_UNTIL,
      anchorAtIso: ANCHOR,
      timeZone: TZ
    });
    eq(
      guarded.followUpCadence.status,
      "stopped",
      `a ${mode} thread keeps its stopped cadence — no automated chase revived under a human`
    );
    eq(
      guarded.followUpCadence.pausedUntil,
      undefined,
      `and no quiet window is written on the ${mode} thread`
    );
  }
}

// A CLOSED conversation is never resurrected: startFollowUpCadence refuses, and the quiet is only
// ever applied to an active cadence. This is the invariant that keeps the cleanup safe.
{
  const conv = mkConv(undefined);
  conv.status = "closed";
  applyCadenceQuietWindow(conv, {
    trigger: "inventory_watch_alert",
    quietUntilIso: QUIET_UNTIL,
    anchorAtIso: ANCHOR,
    timeZone: TZ
  });
  eq(conv.followUpCadence, undefined, "a closed lead gets no cadence and no quiet window");
}

console.log(`PASS cadence quiet window — one referee, four former sites (${checks} checks)`);
