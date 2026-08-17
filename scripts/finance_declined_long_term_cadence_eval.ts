/**
 * Finance-declined leads belong on the LONG-TERM cadence — decision table.
 *
 * Joe's ruling, 2026-08-01 ("5 yes long term"): a lead whose financing was declined drops to the
 * long-term cadence (FINANCE_DECLINED_DAY_OFFSETS = 30/60/120), not the standard chase.
 * "Someone who just got declined is not a this-week buyer."
 *
 * PRODUCTION FIXTURES (both are live operator reports in the anomaly work order):
 *  - Tyler Boudreau +17169905800 — "this has a not approved outcome. why did it go into a short
 *    term cadence follow up". Recorded decline at 2026-07-30T19:43:45.442Z opened the correct
 *    long_term cadence; 37 seconds later a manual staff text about the co-signer matched
 *    `isManualOutboundCreditAppNeedsMoreInfoText` and `applyManualOutboundCreditAppNeedsMoreInfo`
 *    replaced the whole cadence with kind `engaged`. Rows 1 and 2 pin both halves of that.
 *  - John Geschwender +17166060001 (15d) — "finance application was not approved. shouldn't this
 *    go into a long term cadence?"
 *
 * The decision is deterministic on purpose and legal under AGENTS.md rule 2: it reads only
 * RECORDED STATE (followUp.reason, financeOutcome.status, the appointment outcome) and gates a
 * SIDE EFFECT (which schedule runs). No customer text is read, so no comprehension is involved.
 *
 * FAIL DIRECTION: unknown/blank => NOT declined (keeps today's behavior); the heal never pulls a
 * touch earlier than what was already scheduled.
 */
import assert from "node:assert";
import {
  decideFinanceDeclinedCadence,
  decideEngagedCadenceBump,
  decideCadenceAdvance
} from "../services/api/src/domain/routeStateReducer";

type Row = {
  name: string;
  input: Parameters<typeof decideFinanceDeclinedCadence>[0];
  isFinanceDeclined: boolean;
  blockEngagedDowngrade: boolean;
  needsLongTermHeal: boolean;
};

const ROWS: Row[] = [
  {
    // +17169905800 at 19:43:45 — decline just recorded, long_term cadence open. The manual
    // finance-docs text that arrives 37s later must NOT be allowed to downgrade it.
    name: "declined + long_term cadence -> block the engaged downgrade",
    input: {
      followUpReason: "financing_declined",
      financeOutcomeStatus: "declined",
      cadenceKind: "long_term",
      cadenceStatus: "active"
    },
    isFinanceDeclined: true,
    blockEngagedDowngrade: true,
    needsLongTermHeal: false
  },
  {
    // +17169905800 as production actually found him: engaged/finance_docs on a declined lead.
    name: "declined + engaged cadence -> heal to long_term",
    input: {
      followUpReason: "financing_declined",
      financeOutcomeStatus: "declined",
      cadenceKind: "engaged",
      cadenceStatus: "active"
    },
    isFinanceDeclined: true,
    blockEngagedDowngrade: false,
    needsLongTermHeal: true
  },
  {
    // +17166060001: the operator's 15-day-old report, decline recorded on the appointment outcome.
    name: "appointment outcome financing_declined counts as declined",
    input: {
      appointmentOutcomeStatus: "financing_declined",
      cadenceKind: "engaged",
      cadenceStatus: "active"
    },
    isFinanceDeclined: true,
    blockEngagedDowngrade: false,
    needsLongTermHeal: true
  },
  {
    name: "secondary status finance_not_approved counts as declined",
    input: {
      appointmentOutcomeSecondaryStatus: "finance_not_approved",
      cadenceKind: "standard",
      cadenceStatus: "active"
    },
    isFinanceDeclined: true,
    blockEngagedDowngrade: false,
    needsLongTermHeal: true
  },
  {
    // needs_more_info is a lead being ACTIVELY worked — it keeps the engaged docs cadence.
    name: "needs_more_info is NOT a decline",
    input: {
      followUpReason: "credit_app_needs_info",
      financeOutcomeStatus: "needs_more_info",
      cadenceKind: "engaged",
      cadenceStatus: "active"
    },
    isFinanceDeclined: false,
    blockEngagedDowngrade: false,
    needsLongTermHeal: false
  },
  {
    name: "approved is NOT a decline",
    input: {
      financeOutcomeStatus: "approved",
      cadenceKind: "engaged",
      cadenceStatus: "active"
    },
    isFinanceDeclined: false,
    blockEngagedDowngrade: false,
    needsLongTermHeal: false
  },
  {
    // Fail direction: no recorded signal at all must leave today's behavior alone.
    name: "blank state -> not declined (fail toward current behavior)",
    input: { cadenceKind: "engaged", cadenceStatus: "active" },
    isFinanceDeclined: false,
    blockEngagedDowngrade: false,
    needsLongTermHeal: false
  },
  {
    // They bought in the end — post_sale outranks the decline and is never healed away.
    name: "post_sale cadence is never healed to long_term",
    input: {
      followUpReason: "financing_declined",
      cadenceKind: "post_sale",
      cadenceStatus: "active"
    },
    isFinanceDeclined: true,
    blockEngagedDowngrade: false,
    needsLongTermHeal: false
  },
  {
    // A stopped cadence is not running, so there is nothing to heal — don't resurrect it.
    name: "stopped cadence is not healed (no resurrection)",
    input: {
      followUpReason: "financing_declined",
      cadenceKind: "engaged",
      cadenceStatus: "stopped"
    },
    isFinanceDeclined: true,
    blockEngagedDowngrade: false,
    needsLongTermHeal: false
  }
];

let failures = 0;
for (const row of ROWS) {
  const decision = decideFinanceDeclinedCadence(row.input);
  try {
    assert.equal(decision.isFinanceDeclined, row.isFinanceDeclined, `${row.name}: isFinanceDeclined`);
    assert.equal(
      decision.blockEngagedDowngrade,
      row.blockEngagedDowngrade,
      `${row.name}: blockEngagedDowngrade`
    );
    assert.equal(decision.needsLongTermHeal, row.needsLongTermHeal, `${row.name}: needsLongTermHeal`);
    console.log(`  ok  ${row.name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${row.name}: ${err?.message ?? err}`);
  }
}

// The wiring itself: both index.ts call sites must exist, or the decision is dead code and the
// operator reports come straight back.
import fs from "node:fs";
import path from "node:path";
const indexSource = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
for (const marker of [
  "blockEngagedDowngrade",
  "needsLongTermHeal",
  "manual_outbound_finance_docs_declined_long_term_kept"
]) {
  if (!indexSource.includes(marker)) {
    failures += 1;
    console.error(`  FAIL index.ts is missing the finance-declined wiring marker "${marker}"`);
  }
}

// ── THE ENGAGEMENT BUMP MUST ASK THIS REFEREE (2026-08-17, +17163135464 / +17167995566) ──────
// The cadence tick promoted leads onto the faster `engaged` ladder inline, without ever asking
// decideFinanceDeclinedCadence. On a declined lead that fought the heal above and produced a
// LOOP: bump -> engaged, send at rung 0, heal -> long_term + stepIndex 0, repeat every ~24h.
// Two live leads were in it, each with two delivered touches 24h apart and a third queued.
type BumpRow = { name: string; input: Parameters<typeof decideEngagedCadenceBump>[0]; bump: boolean };

const BASE_BUMP: Parameters<typeof decideEngagedCadenceBump>[0] = {
  cadenceKind: "long_term",
  hasEngagementSignal: true,
  isPostSale: false,
  isTradeNoInterest: false,
  isTradeInAppraisalLead: false,
  isSellMyBikeLead: false,
  cadenceTempoCapped: false,
  isFinanceDeclined: false
};

const BUMP_ROWS: BumpRow[] = [
  { name: "engagement on an ordinary lead -> bump to engaged", input: { ...BASE_BUMP }, bump: true },
  {
    // THE FIX. Robert Cloud's live shape.
    name: "declined lead with engagement -> NEVER bump (Joe 2026-08-01, 5 yes long term)",
    input: { ...BASE_BUMP, isFinanceDeclined: true },
    bump: false
  },
  {
    // THE NEAR-MISS. Gating on blockEngagedDowngrade instead of isFinanceDeclined would read
    // FALSE here (kind is not long_term yet) and leave the loop running. Pin the mid-heal tick.
    name: "declined lead ALREADY flipped to engaged mid-loop -> still never bump",
    input: { ...BASE_BUMP, cadenceKind: "engaged", isFinanceDeclined: true },
    bump: false
  },
  { name: "no engagement signal -> no bump", input: { ...BASE_BUMP, hasEngagementSignal: false }, bump: false },
  { name: "post_sale outranks the bump", input: { ...BASE_BUMP, isPostSale: true }, bump: false },
  { name: "4+ month stated timeframe caps the tempo", input: { ...BASE_BUMP, cadenceTempoCapped: true }, bump: false },
  { name: "trade lead with no vehicle interest", input: { ...BASE_BUMP, isTradeNoInterest: true }, bump: false },
  { name: "trade-in appraisal lead", input: { ...BASE_BUMP, isTradeInAppraisalLead: true }, bump: false },
  { name: "sell-my-bike lead", input: { ...BASE_BUMP, isSellMyBikeLead: true }, bump: false },
  { name: "already engaged, ordinary lead -> nothing to do", input: { ...BASE_BUMP, cadenceKind: "engaged" }, bump: false }
];

for (const row of BUMP_ROWS) {
  try {
    assert.equal(decideEngagedCadenceBump(row.input).bump, row.bump, `${row.name}: bump`);
    console.log(`  ok  bump: ${row.name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL bump: ${row.name}: ${err?.message ?? err}`);
  }
}

// CONVERGENCE, EXECUTED — the assertion the loop actually needed. Run the three referees in the
// order the cadence tick runs them, over several ticks, against Robert Cloud's real live values.
// The ladder must CLIMB. A decision table alone cannot catch this: every individual verdict above
// was already "correct" while the composition of them span forever.
{
  let kind = "long_term";
  let stepIndex = 0;
  let delivered = 2;
  const steps: number[] = [];
  const ladders: string[] = [];
  for (let i = 0; i < 4; i++) {
    const fd = decideFinanceDeclinedCadence({
      followUpReason: "financing_declined",
      financeOutcomeStatus: "declined",
      cadenceKind: kind,
      cadenceStatus: "active"
    });
    if (fd.needsLongTermHeal) {
      kind = "long_term";
      stepIndex = 0;
    }
    if (
      decideEngagedCadenceBump({ ...BASE_BUMP, cadenceKind: kind, isFinanceDeclined: fd.isFinanceDeclined }).bump
    ) {
      kind = "engaged";
    }
    const adv = decideCadenceAdvance({
      kind,
      followUpReason: "financing_declined",
      stepIndex,
      deliveredTouchesBefore: delivered,
      delivered: true,
      customerEngaged: true,
      taperAfterTouches: 4
    });
    stepIndex = adv.nextStepIndex;
    delivered = adv.deliveredTouchesAfter;
    steps.push(stepIndex);
    ladders.push(adv.ladder);
  }
  try {
    assert.deepEqual(steps, [1, 2, 3, 4], `the declined ladder must CLIMB across ticks, got ${steps.join(",")}`);
    assert.ok(
      ladders.every(l => l === "finance_declined_long_term"),
      `every tick must run the finance-declined long-term ladder, got ${ladders.join(",")}`
    );
    console.log("  ok  convergence: the declined ladder climbs 1,2,3,4 and never leaves finance_declined_long_term");
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL convergence: ${err?.message ?? err}`);
  }
}

// The bump must be REFEREED at the call site, not decided inline again.
if (!indexSource.includes("decideEngagedCadenceBump")) {
  failures += 1;
  console.error('  FAIL index.ts no longer asks decideEngagedCadenceBump for the engagement bump');
}

if (failures) {
  console.error(`finance_declined_long_term_cadence:eval FAILED (${failures})`);
  process.exit(1);
}
console.log(
  `finance_declined_long_term_cadence:eval OK (${ROWS.length} rows, ${BUMP_ROWS.length} bump rows, convergence)`
);
