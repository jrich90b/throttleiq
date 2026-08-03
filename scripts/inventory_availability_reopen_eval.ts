/**
 * inventory_availability_reopen:eval — ONE referee for "the inventory record that closed this lead
 * is gone; does the conversation REOPEN?"
 *
 * WHAT WAS FIGHTING. One question wearing three Tier-1 fields at once (`hold`/`sale`, `status`,
 * `closedReason`) plus the chase, answered in two places:
 *
 *   clearLinkedInventoryAvailabilityConversations (index.ts ~8630)  staff un-marked a unit as held
 *       or sold, so every lead closed against that unit has to be reconsidered. Two near-identical
 *       arms, hold and sale, that had drifted apart.
 *   processInventoryHolds (index.ts ~7736)  a hold cleared because the unit SOLD. It drops the stale
 *       hold record and deliberately does NOT reopen — right, but previously unstated.
 *
 * FAIL DIRECTION, and it is the unusual one in this codebase. Normally the safe answer is "do less".
 * Here the irreversible thing already happened: we CLOSED a live lead because a bike was spoken for.
 * Staying closed when that turns out to be wrong silently drops a real buyer and no follow-up will
 * ever run again. So for a cause that genuinely frees the unit, REOPENING is safe. What stays
 * conservative is the CAUSE test — an unrecognized cause changes nothing at all.
 *
 * THE TWO PRESERVED DIVERGENCES:
 *   1. `closedReason` matching. The hold arm uses a loose word test (`hold` anywhere in the reason);
 *      the sale arm demands exactly "sold". Tightening the hold arm would strand leads closed with
 *      free-text hold reasons; loosening the sale arm would reopen leads that really did buy.
 *   2. The chase. The sale arm STOPS the post-sale cadence before resuming; the hold arm stops
 *      nothing. A post-sale chase talks about a bike the customer no longer bought and must not keep
 *      running; a hold never started a cadence of its own.
 *
 * Behavior assertions only — no source-text pins (see eval_source_pin_ratchet:eval).
 *
 * Run: npx tsx scripts/inventory_availability_reopen_eval.ts
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH ||
  path.join(os.tmpdir(), `inventory-availability-reopen-eval-${Date.now()}.json`);

const { decideInventoryAvailabilityReopen } = await import(
  "../services/api/src/domain/routeStateReducer.ts"
);
const { applyInventoryAvailabilityReopen } = await import(
  "../services/api/src/domain/conversationStore.ts"
);
const { buildDecisionRegistry } = await import(
  "../services/api/src/domain/decisionFingerprint.ts"
);

let checks = 0;
const ok = (condition: boolean, message: string) => {
  checks += 1;
  assert.ok(condition, message);
};

const CAUSES = ["hold_released", "sale_reversed", "hold_superseded_by_sale"] as const;

// ---------------------------------------------------------------------------------------------
// 1. A LEAD CLOSED AGAINST THE UNIT COMES BACK OPEN. The point of the whole question.
// ---------------------------------------------------------------------------------------------
{
  const held = decideInventoryAvailabilityReopen({
    cause: "hold_released",
    closedReason: "unit on hold",
    followUpReason: "unit_hold"
  });
  ok(held.reopen === true, "hold_released: a lead closed for a hold must reopen when the hold lifts");
  ok(held.clearRecord === true, "hold_released: the stale hold record must be dropped");
  ok(held.resumeFollowUp === true, "hold_released: a hold-reason chase must go back to active");
  ok(held.stopCadence === false, "hold_released: the hold arm stops no cadence (divergence 2)");

  const sold = decideInventoryAvailabilityReopen({
    cause: "sale_reversed",
    closedReason: "sold",
    followUpReason: "post_sale"
  });
  ok(sold.reopen === true, "sale_reversed: a lead closed as sold must reopen when the sale is undone");
  ok(sold.clearRecord === true, "sale_reversed: the stale sale record must be dropped");
  ok(
    sold.stopCadence === true,
    "sale_reversed: the post-sale chase must STOP — it talks about a bike no longer bought"
  );
  ok(sold.resumeFollowUp === true, "sale_reversed: follow-up resumes after the post-sale chase stops");
}

// ---------------------------------------------------------------------------------------------
// 2. A HOLD CLEARED BECAUSE THE UNIT SOLD NEVER REOPENS. The bike is genuinely spoken for; this is
//    the cause whose whole job is to clean up a stale record WITHOUT resurrecting the lead.
// ---------------------------------------------------------------------------------------------
for (const closedReason of ["sold", "unit on hold", "hold - deposit taken", "", null]) {
  const d = decideInventoryAvailabilityReopen({
    cause: "hold_superseded_by_sale",
    closedReason,
    followUpReason: "unit_hold",
    cadenceKind: "post_sale"
  });
  ok(d.clearRecord === true, `hold_superseded_by_sale ("${closedReason}"): still drops the stale hold`);
  ok(d.reopen === false, `hold_superseded_by_sale ("${closedReason}"): must NEVER reopen — the bike sold`);
  ok(d.stopCadence === false, `hold_superseded_by_sale ("${closedReason}"): touches no cadence`);
  ok(d.resumeFollowUp === false, `hold_superseded_by_sale ("${closedReason}"): resumes no chase`);
  ok(
    d.divergence === "hold_cleared_by_a_sale_never_reopens_the_conversation",
    `hold_superseded_by_sale ("${closedReason}"): the "no reopen" answer must be NAMED, not silent`
  );
}

// ---------------------------------------------------------------------------------------------
// 3. DIVERGENCE 1, asserted in both directions — the asymmetric `closedReason` matchers. If a later
//    "cleanup" makes the two arms agree, this fails.
// ---------------------------------------------------------------------------------------------
{
  // The hold arm's LOOSE word test: any reason containing "hold" reopens.
  for (const reason of ["hold", "unit on hold", "HOLD for customer", "on hold - deposit"]) {
    const d = decideInventoryAvailabilityReopen({ cause: "hold_released", closedReason: reason });
    ok(d.reopen === true, `hold_released: loose word match must reopen on "${reason}"`);
  }
  // ...and a reason with no "hold" word in it does NOT reopen, even though the unit is free.
  const noWord = decideInventoryAvailabilityReopen({
    cause: "hold_released",
    closedReason: "not interested"
  });
  ok(noWord.reopen === false, "hold_released: a lead closed for another reason must stay closed");
  ok(noWord.clearRecord === true, "hold_released: the stale record still goes, even without a reopen");

  // The sale arm's EXACT test: only "sold" reopens.
  ok(
    decideInventoryAvailabilityReopen({ cause: "sale_reversed", closedReason: " SOLD " }).reopen === true,
    "sale_reversed: exact match is trimmed and case-insensitive"
  );
  for (const reason of ["sold to another buyer", "unit sold", "sold_elsewhere"]) {
    const d = decideInventoryAvailabilityReopen({ cause: "sale_reversed", closedReason: reason });
    ok(
      d.reopen === false,
      `sale_reversed: must NOT reopen on the wordier reason "${reason}" — exact match only ` +
        "(divergence 1; the hold arm would have reopened here)"
    );
    ok(
      d.divergence === "sale_arm_reopens_only_on_an_exact_sold_closedReason",
      `sale_reversed: the preserved asymmetry must be NAMED on "${reason}"`
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 4. FAIL DIRECTION on the cause test: an unrecognized cause changes NOTHING. A typo'd or renamed
//    cause must never silently reopen closed leads in bulk — this runs over every linked lead.
// ---------------------------------------------------------------------------------------------
for (const cause of ["", "  ", "hold", "sold", "released", "hold_release", "unknown"]) {
  const d = decideInventoryAvailabilityReopen({
    cause,
    closedReason: "unit on hold",
    followUpReason: "unit_hold"
  });
  ok(d.clearRecord === false, `unrecognized cause "${cause}": must not drop any record`);
  ok(d.reopen === false, `unrecognized cause "${cause}": must not reopen`);
  ok(d.stopCadence === false, `unrecognized cause "${cause}": must not touch the cadence`);
  ok(d.resumeFollowUp === false, `unrecognized cause "${cause}": must not resume follow-up`);
}

// ---------------------------------------------------------------------------------------------
// 5. THE WRAPPER WRITES WHAT THE REFEREE DECIDED — the half that catches a call site being unwired.
// ---------------------------------------------------------------------------------------------
{
  const conv: any = {
    id: "r1",
    hold: { stockId: "A1" },
    status: "closed",
    closedAt: "2026-01-01T00:00:00.000Z",
    closedReason: "unit on hold",
    followUp: { reason: "unit_hold", mode: "paused" }
  };
  applyInventoryAvailabilityReopen(conv, { cause: "hold_released" });
  ok(conv.hold === undefined, "wrapper: the stale hold record is dropped");
  ok(conv.status === "open", "wrapper: the lead is reopened");
  ok(conv.closedAt === undefined && conv.closedReason === undefined, "wrapper: the close is cleared");
  ok(conv.followUp?.mode === "active", "wrapper: the chase goes back to active");
}
{
  const conv: any = {
    id: "r2",
    sale: { stockId: "A2" },
    status: "closed",
    closedAt: "2026-01-01T00:00:00.000Z",
    closedReason: "sold",
    followUp: { reason: "post_sale", mode: "paused" },
    followUpCadence: { kind: "post_sale", status: "active" }
  };
  applyInventoryAvailabilityReopen(conv, { cause: "sale_reversed" });
  ok(conv.sale === undefined, "wrapper: the stale sale record is dropped");
  ok(conv.status === "open", "wrapper: the lead is reopened");
  ok(
    conv.followUpCadence?.status === "stopped",
    "wrapper: the post-sale cadence is actually stopped, not just re-moded"
  );
}
{
  // The sold-supersedes cause: record goes, lead STAYS closed.
  const conv: any = {
    id: "r3",
    hold: { stockId: "A3" },
    status: "closed",
    closedAt: "2026-01-01T00:00:00.000Z",
    closedReason: "unit on hold"
  };
  applyInventoryAvailabilityReopen(conv, { cause: "hold_superseded_by_sale" });
  ok(conv.hold === undefined, "wrapper: the stale hold goes even when the lead stays closed");
  ok(conv.status === "closed", "wrapper: a hold cleared by a SALE must leave the lead closed");
  ok(conv.closedReason === "unit on hold", "wrapper: and must not clear the close");
}
{
  // Unrecognized cause: nothing moves at all.
  const conv: any = { id: "r4", hold: { stockId: "A4" }, status: "closed", closedReason: "unit on hold" };
  applyInventoryAvailabilityReopen(conv, { cause: "not_a_cause" });
  ok(conv.hold !== undefined, "wrapper: an unrecognized cause drops nothing");
  ok(conv.status === "closed", "wrapper: an unrecognized cause reopens nothing");
}

// ---------------------------------------------------------------------------------------------
// 6. REGISTERED IN THE DECISION REGISTRY, once per cause — otherwise decision-equivalence is blind
//    to this referee and a future change to it would prove "identical" for free.
// ---------------------------------------------------------------------------------------------
{
  const registry = buildDecisionRegistry();
  const keys = new Set(
    (Array.isArray(registry) ? registry : Object.values(registry ?? {})).map((entry: any) =>
      String(entry?.key ?? entry?.name ?? entry)
    )
  );
  for (const cause of CAUSES) {
    ok(
      keys.has(`inventoryAvailabilityReopen:${cause}`),
      `decision registry must sample inventoryAvailabilityReopen:${cause} — one entry per cause, ` +
        "or the divergences between them are invisible to decision-equivalence"
    );
  }
}

console.log(
  `PASS inventory-availability reopen — one referee for reopening a lead closed against a bike ` +
    `(${checks} checks; both closedReason-matcher divergences preserved and named)`
);
