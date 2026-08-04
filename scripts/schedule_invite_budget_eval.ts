/**
 * schedule_invite_budget:eval — ONE referee for "how many times may we ask this customer to come
 * in, and what happens once we stop asking?"
 *
 * WHAT WAS FIGHTING — a DUPLICATED CONSTANT, which is the quietest kind of contention. Two places
 * owned the same number, in two different files, with nothing making them agree:
 *
 *   conversationStore.registerScheduleInviteSent   `threshold = 3` — latches `scheduleMuted` once
 *                                                  the invite count reaches it.
 *   index.ts SCHEDULE_INVITE_THRESHOLD = 3         picks the follow-up message POOL: below it the
 *                                                  fresh-info lines, at or above it the soft exits.
 *
 * They agreed at 3, so nothing was broken. But they read the SAME counter for the SAME question, so
 * moving one without the other would silently split the pairing — a customer could be muted and
 * still receiving fresh-info invites, or getting soft-exit lines while the budget said there was
 * room. `decideScheduleInviteBudget` now owns the number and both sides ask it.
 *
 * ALSO REMOVED: `resetScheduleInviteCounter`, a DEAD writer. It set `scheduleInviteCount = 0` and
 * `scheduleMuted = false` and had ZERO callers repo-wide — one occurrence, its own definition. Not
 * behavior, a dormant landmine: the next person needing "start asking this customer again" would
 * have called it and bypassed the arbitration entirely. Same class as the dead
 * `updateAppointmentFromInbound` removed in #461, and the reason the queue was right to count it.
 *
 * FAIL DIRECTION. This budget only ever makes us ask LESS. Getting it wrong toward "too few" costs a
 * softer message; toward "too many" it means pestering someone who has ignored three invitations. So
 * an unresolved count resolves toward SPENT, never toward more asking.
 *
 * Behavior assertions only — no source-text pins (see eval_source_pin_ratchet:eval).
 *
 * Run: npx tsx scripts/schedule_invite_budget_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH ||
  path.join(os.tmpdir(), `schedule-invite-budget-eval-${Date.now()}.json`);

const { decideScheduleInviteBudget, SCHEDULE_INVITE_THRESHOLD } = await import(
  "../services/api/src/domain/routeStateReducer.ts"
);
const store = await import("../services/api/src/domain/conversationStore.ts");
const { registerScheduleInviteSent } = store;

let checks = 0;
const eq = (actual: unknown, expected: unknown, message: string) => {
  assert.deepEqual(actual, expected, message);
  checks++;
};

// --- THE LOAD-BEARING SECTION: the ORIGINAL inline rules, re-encoded as a table ------------------
// Each row is what the code did BEFORE the un-stacking, read off the original source:
//   store:  count = (count ?? 0) + 1;  if (count >= 3) muted = true
//   index:  pool  = (count ?? 0) < 3 ? FRESH_INFO : SOFT_EXIT
// If the referee stops matching a row, the un-stacking silently changed behavior. `decision_
// equivalence` cannot carry this proof — a brand-new referee has no baseline to differ from.
{
  const ORIGINAL_RULES = [
    // count before | next | mute latches (next >= 3) | budget spent at CURRENT count (count >= 3)
    { inviteCount: undefined, next: 1, mute: false, spent: false, note: "never asked" },
    { inviteCount: null, next: 1, mute: false, spent: false, note: "never asked (null)" },
    { inviteCount: 0, next: 1, mute: false, spent: false, note: "first ask" },
    { inviteCount: 1, next: 2, mute: false, spent: false, note: "second ask" },
    { inviteCount: 2, next: 3, mute: true, spent: false, note: "third ask — spends the last of it" },
    { inviteCount: 3, next: 4, mute: true, spent: true, note: "already at the threshold" },
    { inviteCount: 7, next: 8, mute: true, spent: true, note: "well past it" }
  ];

  for (const rule of ORIGINAL_RULES) {
    const d = decideScheduleInviteBudget({ inviteCount: rule.inviteCount });
    eq(d.nextInviteCount, rule.next, `${rule.note}: counts up exactly as the store did before`);
    eq(d.mute, rule.mute, `${rule.note}: latches the mute exactly when the store did before`);
    eq(d.spent, rule.spent, `${rule.note}: picks the same message pool the composer did before`);
    eq(d.threshold, 3, `${rule.note}: against the same threshold both files used`);
  }
}

// --- the two files' constants are now ONE ---------------------------------------------------------
// This is the whole point of the slice. `index.ts` had its own `SCHEDULE_INVITE_THRESHOLD = 3` and
// the store had its own `threshold = 3`; the referee exports the single source and both ask it.
{
  eq(SCHEDULE_INVITE_THRESHOLD, 3, "the budget is three invites, as both originals had it");
  eq(
    decideScheduleInviteBudget({ inviteCount: SCHEDULE_INVITE_THRESHOLD - 1 }).mute,
    true,
    "the invite that reaches the threshold is the one that mutes — latch and constant move together"
  );
  eq(
    decideScheduleInviteBudget({ inviteCount: SCHEDULE_INVITE_THRESHOLD - 1 }).spent,
    false,
    "...and that same invite still comes from the fresh-info pool, not the soft exits"
  );
  eq(
    decideScheduleInviteBudget({ inviteCount: SCHEDULE_INVITE_THRESHOLD }).spent,
    true,
    "the NEXT one after the threshold is the first soft exit — the pairing the two constants had to keep"
  );
}

// --- a caller override still works, and moves BOTH answers together --------------------------------
// `registerScheduleInviteSent` accepted a threshold parameter that nobody ever passed. Kept, because
// a per-dealer budget needs somewhere to land — and because the point of the referee is that an
// override cannot move the latch without also moving the pool switch.
{
  for (const threshold of [1, 2, 5]) {
    const atLimit = decideScheduleInviteBudget({ inviteCount: threshold - 1, threshold });
    eq(atLimit.mute, true, `threshold ${threshold}: the invite that reaches it latches the mute`);
    eq(atLimit.spent, false, `threshold ${threshold}: ...and is still not itself a soft exit`);
    eq(
      decideScheduleInviteBudget({ inviteCount: threshold, threshold }).spent,
      true,
      `threshold ${threshold}: the one after it IS a soft exit — both sides moved together`
    );
  }
  // A junk threshold must not silently disable the budget (that fails toward MORE asking).
  for (const junk of [undefined, NaN, "" as unknown as number]) {
    eq(
      decideScheduleInviteBudget({ inviteCount: 2, threshold: junk as number }).threshold,
      3,
      `a threshold of ${JSON.stringify(junk)} falls back to the real budget, never to "unlimited"`
    );
  }
}

// --- a junk stored count never reads as "still room to ask" ----------------------------------------
{
  for (const junk of [NaN, "" as unknown as number, "abc" as unknown as number]) {
    const d = decideScheduleInviteBudget({ inviteCount: junk as number });
    eq(d.inviteCount, 0, `a stored count of ${JSON.stringify(junk)} reads as zero, not NaN`);
    eq(d.nextInviteCount, 1, "...and counting up from it still produces a real number");
  }
}

// --- the store applies what the referee decided ----------------------------------------------------
{
  const conv: any = { id: "c1", followUpCadence: { status: "active", kind: "standard_ramp" } };
  registerScheduleInviteSent(conv);
  eq(conv.followUpCadence.scheduleInviteCount, 1, "the first invite is counted");
  eq(conv.followUpCadence.scheduleMuted, undefined, "...and does not mute anybody");
  registerScheduleInviteSent(conv);
  eq(conv.followUpCadence.scheduleInviteCount, 2, "the second invite is counted");
  eq(conv.followUpCadence.scheduleMuted, undefined, "...still not muted");
  registerScheduleInviteSent(conv);
  eq(conv.followUpCadence.scheduleInviteCount, 3, "the third invite is counted");
  eq(conv.followUpCadence.scheduleMuted, true, "...and THAT is the one that mutes the schedule ask");
}

{
  // No cadence record = nothing to spend. The original returned early; so must this.
  const conv: any = { id: "c2" };
  registerScheduleInviteSent(conv);
  eq(conv.followUpCadence, undefined, "a lead with no chase running is left completely alone");
}

{
  // An already-muted lead keeps counting up — the original never stopped incrementing, and the
  // composer's pool choice depends on the count continuing past the threshold.
  const conv: any = {
    id: "c3",
    followUpCadence: { status: "active", scheduleInviteCount: 5, scheduleMuted: true }
  };
  registerScheduleInviteSent(conv);
  eq(conv.followUpCadence.scheduleInviteCount, 6, "a muted lead's count keeps rising");
  eq(conv.followUpCadence.scheduleMuted, true, "...and stays muted");
}

{
  // The mute is a LATCH: nothing here ever sets it back to false. (The lanes that legitimately
  // reset the budget — cadence replacement / revival — write the pair through their own referees.)
  const conv: any = {
    id: "c4",
    followUpCadence: { status: "active", scheduleInviteCount: 0, scheduleMuted: true }
  };
  registerScheduleInviteSent(conv);
  eq(
    conv.followUpCadence.scheduleMuted,
    true,
    "recording an invite never UN-mutes a lead, even when the count was reset under it"
  );
}

// --- the dead writer is gone and must not come back ------------------------------------------------
// `resetScheduleInviteCounter` had zero callers. Re-adding an unrefereed reset is exactly how the
// arbitration gets bypassed — the #461 failure mode.
{
  eq(
    (store as Record<string, unknown>).resetScheduleInviteCounter,
    undefined,
    "the dead resetScheduleInviteCounter stays deleted — a reset must go through a referee"
  );
}

// --- THE UNWIRE TEST: no unrefereed writer may spend the schedule-invite budget ---------------------
// Stronger than leaning on the ratchet total, which can cancel a +1 against a -1 and report GREEN on
// a real re-stacking (measured on #462 and #484). This asks the contention analyzer directly and
// names the offender.
{
  const { rankContention } = await import("../services/api/src/domain/stateWriterContention.ts");
  const ROOT = path.resolve("services/api/src");
  const files: Array<{ path: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        files.push({ path: path.relative(process.cwd(), full), text: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(ROOT);
  assert.ok(files.length > 50, "unwire test: that is not the real tree — an empty scan must never pass");
  const ranked = rankContention(files as any, { minWrites: 1 });
  const row = ranked.find((r: any) => r.field === "followUpCadence");
  assert.ok(row, "unwire test: the analyzer no longer sees `followUpCadence` — the scan is broken");
  checks++;

  const offenders = ((row as any).unrefereedWriterSites ?? [])
    .map((s: any) => `${s.path ?? s.file}:${s.line}`)
    .filter((site: string) => {
      const snippet =
        ((row as any).unrefereedWriterSites ?? []).find(
          (s: any) => `${s.path ?? s.file}:${s.line}` === site
        )?.snippet ?? "";
      return /scheduleInviteCount|scheduleMuted/.test(String(snippet));
    });
  eq(
    offenders,
    [],
    `no unrefereed writer may spend the invite budget — every one must ask decideScheduleInviteBudget. Found: ${offenders.join(", ")}`
  );
}

// --- the referee is registered with the equivalence harness ----------------------------------------
// An un-stacking whose referee is missing from buildDecisionRegistry ships with no evidence behind
// it: decision_equivalence would report IDENTICAL because it never looked.
{
  const reducer = await import("../services/api/src/domain/routeStateReducer.ts");
  const { buildDecisionRegistry } = await import("../services/api/src/domain/decisionFingerprint.ts");
  const registry = buildDecisionRegistry(reducer as any);
  const covered = registry.filter((entry: any) =>
    (entry.covers ?? []).includes("decideScheduleInviteBudget")
  );
  eq(covered.length, 1, "the budget referee is sampled by the equivalence harness");
  eq(covered[0]?.name, "scheduleInviteBudget", "...under the name the harness reports");

  // ...and the sampler must actually project off STORED state. One that returns undefined for every
  // lead, or a constant, would make the harness report IDENTICAL while comparing nothing.
  const ctx = { nowMs: Date.parse("2026-08-03T16:00:00.000Z"), timeZone: "America/New_York" };
  const belowBudget = { followUpCadence: { scheduleInviteCount: 1 } } as any;
  const overBudget = { followUpCadence: { scheduleInviteCount: 4 } } as any;
  eq(
    covered[0].sample(belowBudget, ctx)?.spent,
    false,
    "a lead with room left projects as not-spent"
  );
  eq(
    covered[0].sample(overBudget, ctx)?.spent,
    true,
    "...and one past the budget projects as spent — the projection tracks stored state"
  );
  eq(
    covered[0].sample({} as any, ctx),
    undefined,
    "a lead with no chase running projects nothing, rather than a fabricated answer"
  );
}

console.log(`PASS schedule invite budget — one referee for how often we ask (${checks} checks)`);
