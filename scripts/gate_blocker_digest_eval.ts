/**
 * Gate-blocker digest eval. The end-of-day staff digest must mirror the
 * release gate's two staff-process checks EXACTLY (agent_actions_audit
 * "recent" windows), send at most once per local day inside the send window,
 * and fail toward NOT sending. Origin: Joe 2026-07-05 — turn the clean-day
 * streak's staff blockers (unactioned drafts, missing appointment outcomes)
 * into a same-day checklist instead of a next-morning report.
 *
 * Pure-function eval over the domain helpers — no live store, no LLM.
 */
import assert from "node:assert/strict";

const {
  GATE_DRAFT_UNACTIONED_MAX,
  GATE_APPT_OUTCOME_MISSING_MAX,
  DEFAULT_DIGEST_SEND_MINUTES,
  gateAppointmentOutcomeRecorded,
  collectGateBlockers,
  shouldSendGateBlockerDigest,
  buildGateBlockerDigestMessage
} = await import("../services/api/src/domain/gateBlockerDigest.ts");

let passed = 0;
const fail: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (e: any) {
    fail.push(`${name}: ${e?.message ?? e}`);
    console.log(`FAIL ${name}: ${e?.message ?? e}`);
  }
}

const NOW = Date.parse("2026-07-06T20:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const draftConv = (id: string, ageDays: number, opts: { closed?: boolean; name?: string } = {}) => ({
  id,
  status: opts.closed ? "closed" : "open",
  lead: { firstName: opts.name ?? "Lead", lastName: id.slice(-4) },
  messages: [
    { direction: "in", provider: "twilio", body: "hi", at: iso(ageDays * DAY + DAY) },
    { direction: "out", provider: "draft_ai", body: "draft", at: iso(ageDays * DAY) }
  ]
});

const apptConv = (id: string, startedDaysAgo: number, outcome: any = undefined) => ({
  id,
  status: "open",
  lead: { firstName: "Visitor", lastName: id.slice(-4) },
  messages: [],
  appointment: {
    status: "confirmed",
    start: iso(startedDaysAgo * DAY),
    staffNotify: outcome ? { outcome } : {}
  }
});

check("thresholds mirror the release gate defaults (drafts ≤2, outcomes 0)", () => {
  assert.equal(GATE_DRAFT_UNACTIONED_MAX, 2);
  assert.equal(GATE_APPT_OUTCOME_MISSING_MAX, 0);
  assert.equal(DEFAULT_DIGEST_SEND_MINUTES, 17 * 60);
});

check("draft blocker windows mirror the audit: >1.5d and ≤7d, open convs, draft-last only", () => {
  const r = collectGateBlockers(
    [
      draftConv("+1", 3), // in window
      draftConv("+2", 1), // too fresh — not yet a gate item
      draftConv("+3", 9), // legacy (>7d) — not "recent", gate ignores it
      draftConv("+4", 3, { closed: true }), // closed conv — audit skips
      {
        id: "+5",
        status: "open",
        lead: {},
        // newest message is a SENT reply, draft already consumed — not pending
        messages: [
          { direction: "out", provider: "draft_ai", body: "d", at: iso(3 * DAY) },
          { direction: "out", provider: "twilio", body: "sent", at: iso(2 * DAY) }
        ]
      }
    ] as any,
    NOW
  );
  assert.deepEqual(
    r.drafts.map(b => b.convId),
    ["+1"]
  );
});

check("a dismissed (draftStatus stale) draft is NOT a blocker — console hides it (Zachary Bushey)", () => {
  const r = collectGateBlockers(
    [
      {
        id: "+20",
        status: "open",
        lead: { firstName: "Zachary", lastName: "Bushey" },
        messages: [
          { direction: "out", provider: "twilio", body: "sent", at: iso(8 * DAY) },
          { direction: "out", provider: "draft_ai", body: "draft", at: iso(3 * DAY), draftStatus: "stale" }
        ]
      }
    ] as any,
    NOW
  );
  assert.deepEqual(r.drafts, []);
});

check("a stale trailing draft does not MASK an older still-pending draft (getLatestPendingDraft parity)", () => {
  const r = collectGateBlockers(
    [
      {
        id: "+21",
        status: "open",
        lead: { firstName: "Mae" },
        messages: [
          { direction: "out", provider: "twilio", body: "sent", at: iso(8 * DAY) },
          { direction: "out", provider: "draft_ai", body: "live draft", at: iso(3 * DAY) },
          { direction: "out", provider: "draft_ai", body: "retired", at: iso(2 * DAY), draftStatus: "stale" }
        ]
      }
    ] as any,
    NOW
  );
  assert.deepEqual(
    r.drafts.map(b => b.convId),
    ["+21"]
  );
});

check("appointment blocker windows mirror the audit: >3d and ≤14d, booked/confirmed, unrecorded", () => {
  const r = collectGateBlockers(
    [
      apptConv("+10", 5), // in window, no outcome → blocker
      apptConv("+11", 2), // too recent (grace) — not yet flagged
      apptConv("+12", 20), // legacy — not "recent"
      apptConv("+13", 5, { status: "no_show" }), // status-only outcome IS recorded (6/29 lesson)
      apptConv("+14", 5, { note: "showed, buying next week" }) // note outcome recorded
    ] as any,
    NOW
  );
  assert.deepEqual(
    r.outcomes.map(b => b.convId),
    ["+10"]
  );
});

check("status-only outcomes count as recorded (appointment_outcome_missing 6/29 lesson)", () => {
  assert.equal(gateAppointmentOutcomeRecorded({ staffNotify: { outcome: { status: "no_show" } } }), true);
  assert.equal(
    gateAppointmentOutcomeRecorded({ staffNotify: { outcome: { primaryStatus: "showed" } } }),
    true
  );
  assert.equal(gateAppointmentOutcomeRecorded({ staffNotify: { outcome: {} } }), false);
  assert.equal(gateAppointmentOutcomeRecorded(null), false);
});

check("gateDirty matches the gate: 3 drafts dirty, 2 drafts clean; any missing outcome dirty", () => {
  const three = collectGateBlockers([draftConv("+1", 2), draftConv("+2", 2), draftConv("+3", 2)] as any, NOW);
  assert.equal(three.gateDirty, true);
  const two = collectGateBlockers([draftConv("+1", 2), draftConv("+2", 2)] as any, NOW);
  assert.equal(two.gateDirty, false);
  const oneOutcome = collectGateBlockers([apptConv("+10", 5)] as any, NOW);
  assert.equal(oneOutcome.gateDirty, true);
});

const sendArgs = (over: Partial<Parameters<typeof shouldSendGateBlockerDigest>[0]> = {}) => ({
  gateDirty: true,
  minutesSinceMidnight: 17 * 60 + 5,
  closeMinutes: 18 * 60,
  todayKey: "2026-07-06",
  lastSentDayKey: null,
  ...over
});

check("sends inside the window on a dirty day", () => {
  assert.equal(shouldSendGateBlockerDigest(sendArgs()), true);
});

check("never sends on a clean day (no nag when there's nothing to do)", () => {
  assert.equal(shouldSendGateBlockerDigest(sendArgs({ gateDirty: false })), false);
});

check("at most once per local day", () => {
  assert.equal(shouldSendGateBlockerDigest(sendArgs({ lastSentDayKey: "2026-07-06" })), false);
  assert.equal(shouldSendGateBlockerDigest(sendArgs({ lastSentDayKey: "2026-07-05" })), true);
});

check("never before the send hour, never after close, never on a closed day", () => {
  assert.equal(shouldSendGateBlockerDigest(sendArgs({ minutesSinceMidnight: 16 * 60 })), false);
  assert.equal(shouldSendGateBlockerDigest(sendArgs({ minutesSinceMidnight: 18 * 60 })), false);
  assert.equal(shouldSendGateBlockerDigest(sendArgs({ closeMinutes: null })), false);
});

check("custom send hour respected", () => {
  assert.equal(
    shouldSendGateBlockerDigest(sendArgs({ sendAtMinutes: 16 * 60, minutesSinceMidnight: 16 * 60 + 1 })),
    true
  );
});

check("message names each blocker with the action, caps long lists, and states the stake", () => {
  const report = collectGateBlockers(
    [
      draftConv("+1", 3, { name: "Zachary" }),
      draftConv("+2", 2, { name: "Mark" }),
      draftConv("+3", 4, { name: "Annie" }),
      apptConv("+10", 5)
    ] as any,
    NOW
  );
  const msg = buildGateBlockerDigestMessage(report);
  assert.ok(msg.includes("DIRTY"), "states the stake");
  assert.ok(msg.includes("Zachary"), "names the lead");
  assert.ok(/send, edit, or dismiss/.test(msg), "draft line carries the action");
  assert.ok(/record showed \/ no-show/.test(msg), "outcome line carries the action");
  assert.ok(msg.includes("7-day rollout streak"), "ties to the goal");
  const big = {
    drafts: Array.from({ length: 9 }, (_, i) => ({
      kind: "draft_unactioned" as const,
      convId: `+${i}`,
      name: `Lead${i}`,
      detail: "draft waiting 3d — send, edit, or dismiss it"
    })),
    outcomes: [],
    gateDirty: true
  };
  const bigMsg = buildGateBlockerDigestMessage(big);
  assert.ok(bigMsg.includes("…and 3 more"), "caps at 6 lines with an overflow count");
});

check("a clean-drafts section is omitted when only outcomes block (no noise)", () => {
  const report = collectGateBlockers([draftConv("+1", 2), apptConv("+10", 5)] as any, NOW);
  const msg = buildGateBlockerDigestMessage(report);
  assert.ok(!msg.includes("Pending drafts"), "1 draft ≤ threshold — not listed as a blocker");
  assert.ok(msg.includes("Appointment outcomes missing 1"), "the actual blocker is listed");
});

console.log(`\nGate blocker digest: ${passed} checks passed`);
if (fail.length) {
  console.error(`\n${fail.length} failures`);
  process.exit(1);
}
console.log("PASS gate blocker digest eval");
