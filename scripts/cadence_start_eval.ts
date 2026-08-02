/**
 * cadence_start:eval — ONE referee for "may we lay a brand-new follow-up chase over this lead
 * right now, and what does the new one inherit from the one it replaces?"
 *
 * WHAT WAS FIGHTING. Three exported entry points in conversationStore build a whole fresh
 * `followUpCadence` object, and each carried its own hand-written admission test:
 *
 *   startFollowUpCadence      the day-one ramp (and its long_term variant)
 *   startPostSaleCadence      the after-the-sale owner sequence
 *   scheduleLongTermFollowUp  a dated "check back with me in the spring" touch
 *
 * They disagree, and several call sites branch straight between two of them on the SAME turn
 * (`if (nearTerm) startFollowUpCadence(...) else scheduleLongTermFollowUp(...)`). So a lead six
 * touches into a live chase who says "now" keeps that chase, while the same lead saying "in the
 * spring" has the whole record thrown away and rebuilt at step 0 — same decision point, opposite
 * answers, decided only by which branch the turn fell into.
 *
 * THE DIVERGENCES, PINNED AS-IS (preserved by the un-stacking, NOT fixed by it):
 *
 *   1. startFollowUpCadence never overwrites an existing cadence — active OR stopped. The other
 *      two always do, without looking. For post-sale that is correct and load-bearing: the
 *      customer has bought, so the pre-sale chase MUST die. It is also why post-sale is the one
 *      lane that ignores `conv.status === "closed"` — a sold conversation IS closed (reason
 *      "sold"), and refusing there would leave every buyer with no owner sequence at all.
 *
 *   2. All three lanes open the new cadence with the invite budget back at zero. On the two
 *      replacing lanes that means a customer muted for having already been asked three times
 *      "what time works for you?" becomes askable again once the chase is re-shaped.
 *
 *      RULED CORRECT 2026-08-02 — see decideCadenceStart's comment for the full reasoning. In
 *      short: the mute never silences a touch (it only softens that touch's content, so clearing
 *      it cannot fail toward messaging); both replacing lanes produce a `post_sale`/`long_term`
 *      cadence, and every schedule-invite path returns early on exactly those kinds, so the flag
 *      is cleared into a state nothing reads; and the only way it ever surfaces is after the
 *      customer has come BACK and been promoted to `engaged`, where asking them what time suits
 *      is the right move. The divergence stays NAMED because the state is worth seeing — as a
 *      known-and-accepted difference, not as work waiting to be done.
 *
 * FAIL DIRECTION. Refusing to start is the SAFE answer: a chase that never starts costs the lead
 * some nurture, while a chase started wrongly texts a customer who should have been left alone.
 * So anything unrecognized must REFUSE.
 *
 * Behavior assertions only — no source-text pins (see eval_source_pin_ratchet:eval).
 *
 * Run: npx tsx scripts/cadence_start_eval.ts
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH ||
  path.join(os.tmpdir(), `cadence-start-eval-${Date.now()}.json`);

const { decideCadenceStart } = await import("../services/api/src/domain/routeStateReducer.ts");
const { startFollowUpCadence, startPostSaleCadence, scheduleLongTermFollowUp } = await import(
  "../services/api/src/domain/conversationStore.ts"
);

let checks = 0;
const eq = (actual: unknown, expected: unknown, message: string) => {
  assert.deepEqual(actual, expected, message);
  checks++;
};

const NOW = "2026-08-02T15:00:00.000Z";
const LATER = "2026-11-02T15:00:00.000Z";
const TZ = "America/New_York";

const activeCadence = (over: Record<string, unknown> = {}) => ({
  status: "active",
  anchorAt: "2026-07-01T15:00:00.000Z",
  nextDueAt: "2026-08-03T15:00:00.000Z",
  stepIndex: 6,
  kind: "engaged",
  scheduleInviteCount: 3,
  scheduleMuted: true,
  ...over
});

// =================================================================================================
// THE REFEREE — the arbitration itself
// =================================================================================================

// --- the day-one ramp refuses to overwrite ANY cadence record it finds --------------------------
{
  const onActive = decideCadenceStart({
    lane: "standard_ramp",
    conversationStatus: "open",
    existing: activeCadence()
  });
  eq(onActive.start, false, "standard_ramp refuses when a live chase already owns the lead");

  const onStopped = decideCadenceStart({
    lane: "standard_ramp",
    conversationStatus: "open",
    existing: activeCadence({ status: "stopped" })
  });
  eq(onStopped.start, false, "standard_ramp refuses on a STOPPED chase too — someone ended it");

  const onNone = decideCadenceStart({
    lane: "standard_ramp",
    conversationStatus: "open",
    existing: null
  });
  eq(onNone.start, true, "standard_ramp starts when the lead has no chase at all");
  eq(onNone.replacesActiveCadence, false, "...and it is not replacing anything");

  const onClosed = decideCadenceStart({
    lane: "standard_ramp",
    conversationStatus: "closed",
    existing: null
  });
  eq(onClosed.start, false, "standard_ramp refuses on a closed conversation");
}

// --- post-sale replaces a live chase on purpose, and works on a CLOSED conversation --------------
{
  const sold = decideCadenceStart({
    lane: "post_sale",
    conversationStatus: "closed", // a sold conversation IS closed, reason "sold"
    existing: activeCadence(),
    sold: true
  });
  eq(sold.start, true, "post_sale starts even though the conversation is closed — it sold");
  eq(sold.replacesActiveCadence, true, "...and it deliberately replaces the live pre-sale chase");

  const notSold = decideCadenceStart({
    lane: "post_sale",
    conversationStatus: "open",
    existing: null,
    sold: false
  });
  eq(notSold.start, false, "post_sale refuses when nothing says this lead bought");
}

// --- the deferred check-back replaces a live chase, but still respects a closed thread ----------
{
  const open = decideCadenceStart({
    lane: "deferred_long_term",
    conversationStatus: "open",
    existing: activeCadence()
  });
  eq(open.start, true, "deferred_long_term schedules the dated touch");
  eq(open.replacesActiveCadence, true, "...replacing the chase that was running");

  const closed = decideCadenceStart({
    lane: "deferred_long_term",
    conversationStatus: "closed",
    existing: null
  });
  eq(closed.start, false, "deferred_long_term refuses on a closed conversation");
}

// --- DIVERGENCE 2: a replacing lane re-opens a MUTED invite budget (ruled CORRECT, still named) --
{
  const replacingAMutedChase = decideCadenceStart({
    lane: "deferred_long_term",
    conversationStatus: "open",
    existing: activeCadence({ scheduleMuted: true })
  });
  eq(
    replacingAMutedChase.divergence,
    "replacing_lane_reopens_a_muted_schedule_invite_budget",
    "replacing a muted chase is NAMED as a divergence so the state stays visible"
  );
  eq(replacingAMutedChase.scheduleMuted, false, "...and today's behaviour is preserved: un-muted");

  const replacingAnUnmutedChase = decideCadenceStart({
    lane: "deferred_long_term",
    conversationStatus: "open",
    existing: activeCadence({ scheduleMuted: false })
  });
  eq(
    replacingAnUnmutedChase.divergence,
    null,
    "no divergence when the chase being replaced was never muted"
  );

  const startingFresh = decideCadenceStart({
    lane: "standard_ramp",
    conversationStatus: "open",
    existing: null
  });
  eq(startingFresh.divergence, null, "a lane that never replaces cannot trip the divergence");
}

// --- FAIL DIRECTION: an unrecognized lane refuses ------------------------------------------------
{
  const unknown = decideCadenceStart({
    lane: "something_nobody_wired_yet",
    conversationStatus: "open",
    existing: null
  });
  eq(unknown.start, false, "an unrecognized lane refuses to start a chase — fail toward silence");
}

// =================================================================================================
// THE WRITE SITES — each one actually asks the referee
// =================================================================================================

// --- startFollowUpCadence honours the refusal ----------------------------------------------------
{
  const conv: any = { id: "s1", status: "open", followUpCadence: activeCadence() };
  startFollowUpCadence(conv, NOW, TZ);
  eq(conv.followUpCadence.stepIndex, 6, "the live chase is left exactly where it was");
  eq(conv.followUpCadence.scheduleMuted, true, "...mute intact");

  const closed: any = { id: "s2", status: "closed" };
  startFollowUpCadence(closed, NOW, TZ);
  eq(closed.followUpCadence, undefined, "a closed conversation gets no chase");

  const fresh: any = { id: "s3", status: "open" };
  startFollowUpCadence(fresh, NOW, TZ);
  eq(fresh.followUpCadence.status, "active", "a lead with no chase gets one");
  eq(fresh.followUpCadence.stepIndex, 0, "...at day one");
  eq(fresh.followUpCadence.scheduleInviteCount, 0, "...with a zeroed invite counter");
  eq(fresh.followUpCadence.scheduleMuted, false, "...and un-muted");
}

// --- startPostSaleCadence honours the sold test, and replaces on a closed-sold thread ------------
{
  const notSold: any = { id: "p1", status: "open" };
  startPostSaleCadence(notSold, NOW, TZ);
  eq(notSold.followUpCadence, undefined, "no owner sequence on a lead that never bought");

  const sold: any = {
    id: "p2",
    status: "closed",
    closedReason: "sold",
    followUpCadence: activeCadence()
  };
  startPostSaleCadence(sold, NOW, TZ);
  eq(sold.followUpCadence.kind, "post_sale", "the buyer gets the owner sequence");
  eq(sold.followUpCadence.stepIndex, 0, "...at step 0, replacing the pre-sale chase");

  const soldByRecord: any = { id: "p3", status: "closed", sale: { soldAt: NOW } };
  startPostSaleCadence(soldByRecord, NOW, TZ);
  eq(soldByRecord.followUpCadence.kind, "post_sale", "a sale record counts as sold too");
}

// --- scheduleLongTermFollowUp honours the closed test, and replaces a live chase -----------------
{
  const closed: any = { id: "l1", status: "closed" };
  scheduleLongTermFollowUp(closed, LATER, "future_timeframe");
  eq(closed.followUpCadence, undefined, "no dated touch scheduled on a closed conversation");

  const live: any = { id: "l2", status: "open", followUpCadence: activeCadence() };
  scheduleLongTermFollowUp(live, LATER, "future_timeframe");
  eq(live.followUpCadence.kind, "long_term", "the deferred touch takes the chase over");
  eq(live.followUpCadence.nextDueAt, LATER, "...due on the date the caller asked for");
  eq(live.followUpCadence.stepIndex, 0, "...re-anchored at step 0");
  // Divergence 2: the mute is cleared. Ruled CORRECT — a long_term cadence never reaches the
  // schedule-invite path anyway, and by the time one could, the customer has re-engaged.
  eq(live.followUpCadence.scheduleMuted, false, "...and the invite budget re-opens (divergence 2)");
}

// --- a non-sales lead is refused by every customer-chase lane -----------------------------------
// Jessica Miller +12168596131 (2026-07-31): a B2B virtual-assistant pitch arrived as a Room58
// "Contact Us" ADF and was enrolled in the standard day-one ramp. It was still generating sales
// follow-ups two days after a human had replied "we're not looking to buy virtual assistant
// services". The parser now marks such a lead `vendor_inquiry`; the REFEREE is what makes the
// refusal a ruling instead of a side effect of whichever branch happened to return first.
{
  const vendor: any = {
    id: "+12168596131",
    status: "open",
    followUp: { mode: "manual_handoff", reason: "vendor_inquiry" }
  };
  startFollowUpCadence(vendor, NOW, TZ);
  eq(vendor.followUpCadence, undefined, "a vendor solicitation gets no day-one sales ramp");

  scheduleLongTermFollowUp(vendor, LATER, "future_timeframe");
  eq(vendor.followUpCadence, undefined, "...and no dated check-back touch either");

  // The hiring lane's suppression used to depend on an early return plus a mode-setter side
  // effect. Now it is the same ruling, reachable from any caller.
  const jobSeeker: any = {
    id: "h1",
    status: "open",
    followUp: { mode: "manual_handoff", reason: "hiring_manager_inquiry" }
  };
  startFollowUpCadence(jobSeeker, NOW, TZ);
  eq(jobSeeker.followUpCadence, undefined, "a job seeker gets no sales chase");

  const spam: any = { id: "s1", status: "open", followUp: { mode: "active", reason: "spam" } };
  startFollowUpCadence(spam, NOW, TZ);
  eq(spam.followUpCadence, undefined, "spam gets no sales chase");

  // THE CHECK THAT MATTERS MOST. The costly failure here is not a vendor slipping through — it is
  // a real buyer going silent. Every reason outside the set, and a lead with no reason at all,
  // must still start exactly as before.
  const ordinary: any = { id: "o1", status: "open" };
  startFollowUpCadence(ordinary, NOW, TZ);
  eq(ordinary.followUpCadence?.kind, "standard", "an ordinary lead still gets the day-one ramp");

  const otherReason: any = {
    id: "o2",
    status: "open",
    followUp: { mode: "manual_handoff", reason: "service_request" }
  };
  startFollowUpCadence(otherReason, NOW, TZ);
  eq(
    otherReason.followUpCadence?.kind,
    "standard",
    "a department handoff is still a sales lead — it keeps its chase"
  );

  // Unknown/blank reasons fail toward TODAY'S behavior, not toward silence.
  for (const reason of [undefined, null, "", "  ", "not_a_known_reason"]) {
    const conv: any = { id: `u-${String(reason)}`, status: "open", followUp: { reason } };
    startFollowUpCadence(conv, NOW, TZ);
    eq(
      conv.followUpCadence?.kind,
      "standard",
      `an unrecognized follow-up reason (${JSON.stringify(reason)}) still starts the ramp`
    );
  }

  // Case/whitespace must not be a way around the refusal.
  const shouty: any = {
    id: "v2",
    status: "open",
    followUp: { mode: "manual_handoff", reason: "  Vendor_Inquiry  " }
  };
  startFollowUpCadence(shouty, NOW, TZ);
  eq(shouty.followUpCadence, undefined, "the reason match is case- and whitespace-insensitive");

  // The referee's own words, so the ops log and the equivalence harness can see WHY.
  const decision = decideCadenceStart({
    lane: "standard_ramp",
    conversationStatus: "open",
    followUpReason: "vendor_inquiry"
  });
  eq(decision.start, false, "the referee refuses the standard ramp for a non-sales lead");
  eq(
    /non-sales class \(vendor_inquiry\)/.test(decision.why),
    true,
    "...and names the class in its reason"
  );
}

// --- one list, not two --------------------------------------------------------------------------
// The scoring exclusion and the cadence referee must read the SAME set. They were separate copies,
// which is exactly how `vendor_inquiry` came to be listed for scoring while nothing ever wrote it.
{
  const { NON_SALES_CADENCE_REASONS } = await import(
    "../services/api/src/domain/routeStateReducer.ts"
  );
  const { isNonSalesConversation } = await import(
    "../services/api/src/domain/scoringExclusions.ts"
  );
  for (const reason of NON_SALES_CADENCE_REASONS) {
    eq(
      isNonSalesConversation({ followUp: { reason } }),
      true,
      `the tone scorer excludes ${reason} — the same set the referee refuses`
    );
  }
  eq(
    isNonSalesConversation({ followUp: { reason: "service_request" } }),
    false,
    "a department handoff is still graded as a sales conversation"
  );
}

console.log(`cadence_start:eval OK — ${checks} checks`);
