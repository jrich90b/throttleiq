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

/**
 * A lead with a first outbound, optionally asking, optionally replied to, optionally booked.
 *
 * CONTACTABLE BY DEFAULT, because every real lane but one is: measured 2026-08-11, every lane in the
 * 30-day window ran ~100% reachable except AutoDealers.Digital, at 0 of 18. Pass `unreachable: true`
 * for that shape.
 */
const lead = (
  source: string,
  ageDays: number,
  opts: { asks?: boolean; replied?: boolean; booked?: boolean; unreachable?: boolean } = {}
) => ({
  id: `c_${source}_${ageDays}_${Math.random()}`,
  createdAt: daysAgo(ageDays),
  lead: opts.unreachable ? { source } : { source, phone: "+17165550101" },
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

  // --- A LANE THAT NEVER HAD A LADDER -----------------------------------------------------------
  // Reachable leads that nobody asked anything => write the copy.
  const never = Array.from({ length: 12 }, (_, i) => lead("Lane C", 3 + i * 2, { asks: false }));
  const laneC = assessLadderHealth({ conversations: never, now: NOW }).lanes.find(l => l.source === "Lane C")!;
  assert.equal(laneC.alarm, "never_asks", "a lane that has never asked anything must alarm");
  assert.equal(laneC.recent.contactable, 12, "…and every one of those leads WAS reachable");

  // --- A LANE WITH NOBODY TO REACH (the real AutoDealers.Digital shape) -------------------------
  // MEASURED 2026-08-11: 18 of 18 recent AutoDealers.Digital leads carried no phone and no email —
  // the ADF is a name, a stock number and "Inquiry: Lead arrived". Reported as `never_asks` it sent a
  // run hunting for missing copy; no wording reaches someone with no address. Separate alarm, because
  // the fix is in the vendor feed, not in our templates.
  const unreachable = Array.from({ length: 12 }, (_, i) => lead("Lane F", 3 + i * 2, { asks: false, unreachable: true }));
  const laneF = assessLadderHealth({ conversations: unreachable, now: NOW }).lanes.find(l => l.source === "Lane F")!;
  assert.equal(laneF.alarm, "uncontactable", "a lane whose leads carry no phone and no email is a FEED defect");
  assert.equal(laneF.recent.contactable, 0, "…and the reach count proves it");
  assert.ok(/phone or an email/i.test(laneF.why), "…and the reason names the real cause in words");
  assert.ok(/feed defect/i.test(laneF.why), "…and points at the feed, not at our copy");
  // It still ALARMS — an unreachable lane is a real problem, not something to quiet.
  assert.equal(
    assessLadderHealth({ conversations: unreachable, now: NOW }).alarms.length,
    1,
    "uncontactable is a LOUDER diagnosis, not a suppression"
  );
  // FAIL DIRECTION: one reachable lead is enough to fall back to today's `never_asks` diagnosis, so a
  // lane we simply have not written copy for can never hide behind the contact excuse.
  const oneReachable = [
    ...Array.from({ length: 11 }, (_, i) => lead("Lane G", 3 + i * 2, { asks: false, unreachable: true })),
    lead("Lane G", 4, { asks: false })
  ];
  const laneG = assessLadderHealth({ conversations: oneReachable, now: NOW }).lanes.find(l => l.source === "Lane G")!;
  assert.equal(laneG.alarm, "never_asks", "a single reachable lead falls back to the missing-ladder diagnosis");

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
  // The list is a coverage registry: a lane either asks, or is declared with a reason, or alarms.
  assert.ok(laneHasNoLadderByDesign("Ride Challenge"), "marketing signups are declared");
  assert.ok(laneHasNoLadderByDesign("Riding Academy - Enrolled"), "course enrolment is declared");
  assert.equal(laneHasNoLadderByDesign("Room58 - Request details"), null, "a real sales lane is NOT declared");
  const signup = Array.from({ length: 20 }, (_, i) => lead("Ride Challenge", 3 + i, { asks: false }));
  const signupLane = assessLadderHealth({ conversations: signup, now: NOW }).lanes.find(l => l.source === "Ride Challenge")!;
  assert.equal(signupLane.alarm, null, "a declared no-ladder lane never alarms");
  assert.ok(/by design/i.test(signupLane.why), "…and its row says why, so nobody re-investigates it");

  // --- THE WALK-IN FAMILY MUST STAY VISIBLE -----------------------------------------------------
  // `Traffic Log Pro`, `Walk In` and `Dealer Lead App` are ONE family (`WALK_IN_SOURCE_RE` in
  // conversationStore.ts). Two of the three were declared no-ladder here, on reasons measurement
  // killed on 2026-08-11: Traffic Log Pro sent a REAL customer-facing text to 16 of 22 leads (only 5
  // of those asked anything), and "they are already standing in the store" is the assumption Joe
  // overruled in #655 — 49 of 66 had ridden a bike here and still get asked back in. Net effect: 28
  // of 30 family leads were invisible to the one net built to catch a lane that stopped advancing
  // leads, in the best-converting volume source we own.
  //
  // ⚠️ REGRESSION GUARD, not decoration. Re-declaring any of the three re-blinds the sweep to the
  // exact failure mode it exists for, and the row would look perfectly reasonable on its own.
  for (const source of ["Traffic Log Pro", "Walk In", "Dealer Lead App"]) {
    assert.equal(
      laneHasNoLadderByDesign(source),
      null,
      `${source} is a walk-in lane that DOES get texted — it must never be declared silent by design`
    );
  }
  // Not just the declaration: the lane genuinely reaches an alarm on the never-asks shape.
  const walkInFamily = Array.from({ length: 12 }, (_, i) => lead("Traffic Log Pro", 3 + i * 2, { asks: false }));
  const familyLane = assessLadderHealth({ conversations: walkInFamily, now: NOW }).lanes.find(
    l => l.source === "Traffic Log Pro"
  )!;
  assert.equal(familyLane.alarm, "never_asks", "a walk-in lane nobody asks anything must surface as a build candidate");
  // FAIL DIRECTION: the ladder clears the alarm, never the suppression list. A walk-in lane that DOES
  // ask is silent, so the only way to quiet this row is to actually start asking.
  const walkInAsking = Array.from({ length: 12 }, (_, i) => lead("Traffic Log Pro", 3 + i * 2, { asks: true }));
  assert.equal(
    assessLadderHealth({ conversations: walkInAsking, now: NOW }).alarms.length,
    0,
    "a walk-in lane that asks is silent — the ladder clears the alarm, not the suppression list"
  );

  // --- IT COUNTS THE OTHER COLUMNS TOO ----------------------------------------------------------
  const mixed = [
    lead("Lane E", 3, { asks: true, replied: true, booked: true }),
    lead("Lane E", 4, { asks: true, replied: true }),
    lead("Lane E", 5, {})
  ];
  const laneE = assessLadderHealth({ conversations: mixed, now: NOW }).lanes.find(l => l.source === "Lane E")!;
  assert.deepEqual(
    {
      leads: laneE.recent.leads,
      asked: laneE.recent.asked,
      replied: laneE.recent.replied,
      booked: laneE.recent.booked,
      contactable: laneE.recent.contactable
    },
    { leads: 3, asked: 2, replied: 2, booked: 1, contactable: 3 },
    "leads / reach / asked / replied / booked are all counted"
  );

  // --- WHOSE FIRST TOUCH, AND WAS IT EVER SENT (2026-08-12) -------------------------------------
  // The ask rate answers "does OUR LADDER advance this lane?". Three populations used to ride in on
  // the looser reading (the first outbound ROW, whoever wrote it and whether or not it was sent):
  // drafts sitting in the approval box (`draft_ai` was the first outbound row on 108 of ~475 leads in
  // 90 days), messages a salesperson typed themselves, and leads nobody ever texted.
  //
  // Each of these EXECUTES the assessor — a source-text assertion could not tell the difference.
  const outRow = (over: Record<string, unknown>) => ({ direction: "out", at: daysAgo(3), ...over });
  const withFirstTouch = (source: string, ageDays: number, msgs: Record<string, unknown>[]) => ({
    id: `c_${source}_${ageDays}_${Math.random()}`,
    createdAt: daysAgo(ageDays),
    lead: { source, phone: "+17165550101" },
    messages: msgs
  });

  // (1) A DRAFT IS NOT A TOUCH. The draft asks nothing and the delivered message does; the lane must
  //     be graded on the one the customer actually read.
  const draftThenSend = assessLadderHealth({
    conversations: [
      withFirstTouch("Lane Draft", 3, [
        outRow({ provider: "draft_ai", draftStatus: "stale", body: "Thanks, I'll be in touch." }),
        outRow({ provider: "twilio", body: "Thanks — want to stop in and check it out?" })
      ])
    ],
    now: NOW
  }).lanes.find(l => l.source === "Lane Draft")!;
  assert.equal(draftThenSend.recent.agentFirstTouches, 1, "the delivered message is the first touch");
  assert.equal(draftThenSend.recent.asked, 1, "…and it is what gets graded, not the draft above it");

  // …and a lead whose ONLY outbound is a draft was never texted at all. It must not read as a first
  // touch that asked nothing — that is a rung nobody sent, which no wording change can fix.
  const draftOnly = assessLadderHealth({
    conversations: [
      withFirstTouch("Lane Unsent", 3, [outRow({ provider: "draft_ai", draftStatus: "stale", body: "Thanks." })])
    ],
    now: NOW
  }).lanes.find(l => l.source === "Lane Unsent")!;
  assert.equal(draftOnly.recent.neverTexted, 1, "a lead whose only outbound is a draft was never texted");
  assert.equal(draftOnly.recent.agentFirstTouches, 0, "…so it is not one of our first touches");
  assert.equal(draftOnly.askRateRecent, null, "…and it cannot drag an ask rate down");

  // (2) A SALESPERSON'S OWN TEXT IS NOT OUR LADDER — counted, never graded.
  const staffTyped = assessLadderHealth({
    conversations: [
      withFirstTouch("Lane Staff", 3, [
        outRow({ provider: "twilio", actorUserName: "Scott Hartrich", body: "https://www.dragspecialties.com/search/parts/18002744" })
      ])
    ],
    now: NOW
  }).lanes.find(l => l.source === "Lane Staff")!;
  assert.equal(staffTyped.recent.staffFirstTouches, 1, "a message staff typed is attributed to staff");
  assert.equal(staffTyped.recent.agentFirstTouches, 0, "…and never to the agent");
  assert.equal(staffTyped.askRateRecent, null, "…so it cannot score against our ladder");

  // (3) …but an agent draft staff EDITED stays OURS. The agent wrote the rung; if it shipped without
  //     an ask, that is our miss. `originalDraftBody` is what holds that line.
  const editedDraft = assessLadderHealth({
    conversations: [
      withFirstTouch("Lane Edited", 3, [
        outRow({
          provider: "twilio",
          actorUserName: "Scott Hartrich",
          originalDraftBody: "Hi Larry — this is Scott at American Harley-Davidson. Thanks for stopping in today - I'll follow up about pre-owned trikes.",
          body: "Hi Larry — this is Scott at American Harley-Davidson. Thanks for chatting on SAturday - I'll follow up about pre-owned trikes."
        })
      ])
    ],
    now: NOW
  }).lanes.find(l => l.source === "Lane Edited")!;
  assert.equal(editedDraft.recent.agentFirstTouches, 1, "an agent draft staff edited is still the agent's rung");
  assert.equal(editedDraft.recent.asked, 0, "…and it asked nothing, which is ours to answer for");

  // (4) THE NEW ALARM: a lane a salesperson opens. It still alarms — a lane the agent never opens is
  //     worth a decision — but it must NOT send the next run to write copy nobody will send.
  const staffLane = assessLadderHealth({
    conversations: [
      ...Array.from({ length: 7 }, (_, i) =>
        withFirstTouch("Lane StaffOwned", 3 + i, [
          outRow({ provider: "twilio", actorUserName: "Scott Hartrich", body: "Thanks for your time today." })
        ])
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        withFirstTouch("Lane StaffOwned", 12 + i, [outRow({ provider: "twilio", body: "Thanks, I'll be in touch." })])
      )
    ],
    now: NOW
  }).lanes.find(l => l.source === "Lane StaffOwned")!;
  assert.equal(staffLane.alarm, "staff_owned_first_touch", "a lane staff open themselves gets its own diagnosis");
  assert.ok(staffLane.why.includes("typed by staff"), "…and the reason names who is writing");
  assert.ok(
    !staffLane.why.includes("may have no ladder"),
    "…and must NOT read as missing copy — that is the wrong building, which is the whole point"
  );

  // (5) THE FINDING THIS CHANGE CAME FROM MUST SURVIVE THE SHARPENING. Traffic Log Pro's real 30-day
  //     shape, measured 2026-08-12: 5 pure agent sends, 9 agent drafts staff edited, 5 staff-typed,
  //     4 never texted — and 0 of the 14 agent-owned first touches asked anything. The count moves
  //     from 0/23 to 0/14; the alarm, and the build candidate, stay exactly where they were.
  //     If sharpening a count makes a finding vanish, re-read the finding before believing it.
  const tlpReal = [
    ...Array.from({ length: 5 }, (_, i) =>
      withFirstTouch("Traffic Log Pro", 3 + i, [outRow({ provider: "twilio", body: "Thanks for stopping in, I'll keep an eye out." })])
    ),
    ...Array.from({ length: 9 }, (_, i) =>
      withFirstTouch("Traffic Log Pro", 9 + i, [
        outRow({
          provider: "twilio",
          actorUserName: "Scott Hartrich",
          originalDraftBody: "Hi — this is Scott at American Harley-Davidson. Thanks for stopping in today.",
          body: "Hi — this is Scott at American Harley-Davidson. Thanks for chatting Saturday."
        })
      ])
    ),
    ...Array.from({ length: 5 }, (_, i) =>
      withFirstTouch("Traffic Log Pro", 19 + i, [
        outRow({ provider: "twilio", actorUserName: "Scott Hartrich", body: "Thank you for your time over the phone." })
      ])
    ),
    ...Array.from({ length: 4 }, (_, i) =>
      withFirstTouch("Traffic Log Pro", 25 + i, [outRow({ provider: "draft_ai", draftStatus: "stale", body: "Thanks." })])
    )
  ];
  const tlpLane = assessLadderHealth({ conversations: tlpReal, now: NOW }).lanes.find(
    l => l.source === "Traffic Log Pro"
  )!;
  assert.deepEqual(
    {
      leads: tlpLane.recent.leads,
      ours: tlpLane.recent.agentFirstTouches,
      staff: tlpLane.recent.staffFirstTouches,
      none: tlpLane.recent.neverTexted,
      asked: tlpLane.recent.asked
    },
    { leads: 23, ours: 14, staff: 5, none: 4, asked: 0 },
    "the live Traffic Log Pro shape splits 14 ours / 5 staff / 4 never texted"
  );
  assert.equal(tlpLane.alarm, "never_asks", "and it STILL alarms — sharpening the count did not erase the finding");
  assert.ok(tlpLane.why.includes("14 agent-owned"), "…on the honest denominator, not on all 23 leads");
  assert.ok(
    tlpLane.why.includes("5 were staff-typed and 4 never texted"),
    "…and the row says what it left out, so nobody has to re-derive the split"
  );

  // (6) ORDERING: a lane with nobody to reach is a FEED defect first. `uncontactable` has no delivered
  //     outbound at all, so it would otherwise fall into the staff/never-texted arms and be renamed.
  const unreachableLane = assessLadderHealth({
    conversations: Array.from({ length: 12 }, (_, i) => lead("Lane Feed", 3 + i, { unreachable: true }))
  , now: NOW }).lanes.find(l => l.source === "Lane Feed")!;
  assert.equal(unreachableLane.alarm, "uncontactable", "a feed defect keeps its diagnosis — it is checked first for a reason");

  // --- a lead with no source still gets counted, never dropped ----------------------------------
  const noSource = assessLadderHealth({ conversations: [{ createdAt: daysAgo(2), messages: [] }], now: NOW });
  assert.ok(noSource.lanes.some(l => l.source === "(no source)"), "unsourced leads are a lane, not a hole");

  console.log("PASS ladder health — a lane going dark alarms, a healthy one is silent, and the lanes that should never ask say why.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
