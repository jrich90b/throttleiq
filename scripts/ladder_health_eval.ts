/**
 * Ladder health — the counter that notices a lane going dark (Joe, 2026-08-11).
 *
 * WHY IT EXISTS. The loop's three nets all ask "was this reply WRONG?" — state contradictions, an
 * open critic, an intent judge. A broken ladder is none of those: the state is consistent and the
 * reply is polite and on-topic. **MEASURED that day: the work queue was EMPTY while 35 of 37 walk-in
 * first touches asked nothing, 11 approved credit apps had booked zero, and 8% of conversations were
 * repeating a question verbatim.** Months of it, invisible, because every net was per-conversation.
 *
 * Everything here EXECUTES the real assessor against synthetic conversations. A source-text eval
 * cannot prove a script still runs, and `tsc` does not cover `scripts/`.
 *
 * CLOCK-SAFE: every fixture timestamp is built RELATIVE to a pinned `now`, so this cannot go red at
 * midnight.
 *
 * Run: npx tsx scripts/ladder_health_eval.ts
 */
import assert from "node:assert/strict";

const NOW = Date.parse("2026-08-11T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

/** A lead with a first outbound, optionally asking, optionally replied to, optionally booked. */
const lead = (source: string, ageDays: number, opts: { asks?: boolean; replied?: boolean; booked?: boolean } = {}) => ({
  id: `c_${source}_${ageDays}_${Math.random()}`,
  createdAt: daysAgo(ageDays),
  lead: { source },
  appointment: opts.booked ? { status: "confirmed", whenIso: daysAgo(-3) } : undefined,
  messages: [
    { direction: "out", at: daysAgo(ageDays), body: opts.asks ? "Thanks — want to stop in and check it out?" : "Thanks, I'll be in touch." },
    ...(opts.replied ? [{ direction: "in", at: daysAgo(ageDays - 0.5), body: "sounds good" }] : [])
  ]
});

async function main(): Promise<void> {
  const { assessLadderHealth, messageAsksSomething, laneHasNoLadderByDesign, LADDER_MIN_RECENT_LEADS } =
    await import("../services/api/src/domain/ladderHealth.ts");

  // --- what counts as "asked" -------------------------------------------------------------------
  assert.equal(messageAsksSomething("Want to stop in and check it out?"), true);
  assert.equal(messageAsksSomething("Thanks, I'll be in touch."), false);
  // ⚠️ A link carries "?dealerid=" and is NOT a question — the trap that made an earlier detector
  // count every credit-application link as an ask.
  assert.equal(
    messageAsksSomething("Apply here: https://creditapplication.harley-davidson.com/us/en/?dealerid=3436"),
    false,
    "a URL query string is not a question"
  );

  // --- THE ALARM THAT MATTERS: a lane that used to ask, and stopped ------------------------------
  const collapsed = [
    ...Array.from({ length: 10 }, (_, i) => lead("Lane A", 50 + i, { asks: true })), // baseline: asked
    ...Array.from({ length: 8 }, (_, i) => lead("Lane A", 5 + i, { asks: false })) // recent: stopped
  ];
  const r1 = assessLadderHealth({ conversations: collapsed, now: NOW });
  const laneA = r1.lanes.find(l => l.source === "Lane A")!;
  assert.equal(laneA.alarm, "ask_rate_collapsed", "a lane that stopped asking must alarm");
  assert.ok(/used to ask/i.test(laneA.why), "and the reason says so in words");
  assert.equal(r1.alarms.length, 1, "and it is surfaced in the alarms list");

  // A lane that KEPT asking is silent — the counter must not cry wolf on a healthy lane.
  const healthy = [
    ...Array.from({ length: 10 }, (_, i) => lead("Lane B", 50 + i, { asks: true })),
    ...Array.from({ length: 8 }, (_, i) => lead("Lane B", 5 + i, { asks: true }))
  ];
  assert.equal(assessLadderHealth({ conversations: healthy, now: NOW }).alarms.length, 0, "a healthy lane is silent");

  // --- A LANE THAT NEVER HAD A LADDER (the AutoDealers.Digital shape) ----------------------------
  const never = Array.from({ length: 12 }, (_, i) => lead("Lane C", 3 + i * 2, { asks: false }));
  const laneC = assessLadderHealth({ conversations: never, now: NOW }).lanes.find(l => l.source === "Lane C")!;
  assert.equal(laneC.alarm, "never_asks", "a lane that has never asked anything must alarm");

  // --- SMALL LANES NEVER ALARM ------------------------------------------------------------------
  // MEASURED PRECEDENT: the canary's ratio rule tripped on a healthy build off ~2 drafts. Most lanes
  // here run single digits a month, so the floor is absolute.
  // ⚠️ LITERAL counts, never `LADDER_MIN_RECENT_LEADS - 1`. The first cut sized this fixture off the
  // constant it was testing, so lowering the floor to 1 shrank the fixture to zero leads and the
  // assertion still passed — a test defined in terms of the thing it checks cannot detect a change to
  // that thing.
  assert.ok(LADDER_MIN_RECENT_LEADS >= 5, "the alarm floor must stay at 5 or more recent leads");
  const tiny = Array.from({ length: 4 }, (_, i) => lead("Lane D", 3 + i, { asks: false }));
  assert.equal(assessLadderHealth({ conversations: tiny, now: NOW }).alarms.length, 0, "4 leads is below the floor — never an alarm");
  const sevenQuiet = Array.from({ length: 7 }, (_, i) => lead("Lane D2", 3 + i, { asks: false }));
  assert.equal(
    assessLadderHealth({ conversations: sevenQuiet, now: NOW }).alarms.length,
    0,
    "7 quiet leads with no history is still below the never-asks floor of 8"
  );

  // --- DECLARED NO-LADDER LANES ARE SILENT, AND SAY WHY -----------------------------------------
  // Without this the sweep flags the VOICE lane on every run, and an instrument that always shows a
  // false alarm gets ignored — which is worse than no instrument.
  assert.ok(laneHasNoLadderByDesign("Traffic Log Pro"), "the voice lane is declared");
  assert.ok(laneHasNoLadderByDesign("Walk In"), "walk-ins are declared — they are already here");
  assert.ok(laneHasNoLadderByDesign("Ride Challenge"), "marketing signups are declared");
  assert.equal(laneHasNoLadderByDesign("Room58 - Request details"), null, "a real sales lane is NOT declared");
  const voice = Array.from({ length: 20 }, (_, i) => lead("Traffic Log Pro", 3 + i, { asks: false }));
  const voiceLane = assessLadderHealth({ conversations: voice, now: NOW }).lanes.find(l => l.source === "Traffic Log Pro")!;
  assert.equal(voiceLane.alarm, null, "a declared no-ladder lane never alarms");
  assert.ok(/by design/i.test(voiceLane.why), "…and its row says why, so nobody re-investigates it");

  // --- IT COUNTS THE OTHER COLUMNS TOO ----------------------------------------------------------
  const mixed = [
    lead("Lane E", 3, { asks: true, replied: true, booked: true }),
    lead("Lane E", 4, { asks: true, replied: true }),
    lead("Lane E", 5, {})
  ];
  const laneE = assessLadderHealth({ conversations: mixed, now: NOW }).lanes.find(l => l.source === "Lane E")!;
  assert.deepEqual(
    { leads: laneE.recent.leads, asked: laneE.recent.asked, replied: laneE.recent.replied, booked: laneE.recent.booked },
    { leads: 3, asked: 2, replied: 2, booked: 1 },
    "leads / asked / replied / booked are all counted"
  );

  // --- a lead with no source still gets counted, never dropped ----------------------------------
  const noSource = assessLadderHealth({ conversations: [{ createdAt: daysAgo(2), messages: [] }], now: NOW });
  assert.ok(noSource.lanes.some(l => l.source === "(no source)"), "unsourced leads are a lane, not a hole");

  console.log("PASS ladder health — a lane going dark alarms, a healthy one is silent, and the lanes that should never ask say why.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
