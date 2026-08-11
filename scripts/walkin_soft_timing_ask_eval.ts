/**
 * The walk-in first touch asks them back in — softly (Joe, 2026-08-11).
 *
 * Joe, verbatim: *"Dealer lead app are walk ins by the way. The first message should be a little more
 * loose with timing. it should say something like want to set up a time to stop in and check it out?
 * Then continue the ladder from there."*
 *
 * MEASURED before building, live store:
 *  - Dealer Lead App: 66 leads. **35 of 37 first touches in the last 90 days asked NOTHING** — the
 *    reply was "if any questions come up, just text me anytime". It is also the best-converting
 *    volume source we have (14% booked), which is why it was upside rather than a fire.
 *  - **49 of the 66 rode a real bike here** (2 say "None recorded", 15 have no field). Inviting
 *    someone to "come check it out" after they rode it reads as if we were not paying attention, so
 *    the visited wording is "stop BACK in".
 *  - Only **6** of the 66 said they were buying inside 3 months; 15 said "Not Sure", 8 said no.
 *    That is the measured reason the ask must stay SOFT: a hard "Saturday at 4:30?" is the wrong
 *    push for most of this lane.
 *
 * ⭐ RULING 31 IS UPHELD, NOT OVERTURNED. Widening `customerVisitConfirmed` itself was measured on
 * 2026-08-06 at 49 live leads flipping false→true across FOUR draft builders and judged unsafe. It
 * still is. Joe's "these are walk ins" supplied the missing FACT, so this composes the narrow,
 * purpose-built `dealerRecordedDemoRide` in ONE builder instead — and that predicate reads the
 * salesperson's own field plus INBOUND text only, never our own outbound, so the agent can never
 * talk itself into a visit.
 *
 * Run: npx tsx scripts/walkin_soft_timing_ask_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Copied verbatim off a live Dealer Lead App lead — never invented.
const REAL_RODE =
  "Customer Comments: Stone Giuga Marketing Questions: Dealer Lead App - Type: Y SalesPerson: Stone Giuga-Stone Giuga - How many years have you owned your Harley-Davidson motorcycle? 3-4 years - Do you expect to make a motorcycle purchase in the near future? Yes, in 3-12 months - Which model of motorcycle are you interested in? 2025,TOURING,ROAD GLIDE Demo Bikes Ridden: 2025,TOURING,ROAD GLIDE Email Opt-In:Yes-";
const REAL_NONE =
  "Customer Comments: Marketing Questions: Dealer Lead App - Type: Y - Which model of motorcycle are you interested in? 2026,CRUISER,LOW RIDER S Demo Bikes Ridden: None recorded. Email Opt-In:Yes-";

async function main(): Promise<void> {
  const { dealerRecordedDemoRide, buildWalkInSoftTimingAsk, customerVisitConfirmed } = await import(
    "../services/api/src/domain/visitFraming.ts"
  );

  // --- who has actually been in --------------------------------------------------------------
  assert.equal(
    dealerRecordedDemoRide({ lead: { comment: REAL_RODE, source: "Dealer Lead App" }, messages: [] }),
    true,
    "a salesperson-recorded demo ride means they were here"
  );
  assert.equal(
    dealerRecordedDemoRide({ lead: { comment: REAL_NONE, source: "Dealer Lead App" }, messages: [] }),
    false,
    '"None recorded" is NOT a ride — 2 of the 66 look like this'
  );
  assert.equal(
    dealerRecordedDemoRide({ lead: { comment: "Customer Comments: called about pricing", source: "Dealer Lead App" }, messages: [] }),
    false,
    "no demo field at all is not a ride — 15 of the 66 look like this"
  );
  // THE SAFEGUARD: our own outbound must never become the evidence, or the agent talks itself into a
  // visit that never happened. Only the lead record and INBOUND text may count.
  assert.equal(
    dealerRecordedDemoRide({
      lead: { source: "Dealer Lead App" },
      messages: [{ direction: "out", body: `Thanks for coming in! ${REAL_RODE}` }]
    }),
    false,
    "our own outbound can never establish that they visited"
  );
  // And ruling 31 stands: the SHARED predicate is untouched by this slice.
  assert.equal(
    customerVisitConfirmed({ lead: { comment: REAL_RODE, source: "Dealer Lead App" }, messages: [] }),
    false,
    "customerVisitConfirmed is NOT widened — ruling 31 is upheld, the composition happens at one call site"
  );

  // --- the ask itself --------------------------------------------------------------------------
  const variants = [
    ["visited, in stock", buildWalkInSoftTimingAsk(true, true)],
    ["visited, not in stock", buildWalkInSoftTimingAsk(true, false)],
    ["not visited, in stock", buildWalkInSoftTimingAsk(false, true)],
    ["not visited", buildWalkInSoftTimingAsk(false, false)]
  ] as const;

  for (const [label, ask] of variants) {
    assert.ok(ask.includes("?"), `${label}: it must ASK — the old copy ended in a statement`);
    assert.ok(/set up a time/i.test(ask), `${label}: it offers to set up a time`);
    // LOOSE ON TIMING. No day, no clock time on the first touch — that is the whole instruction.
    assert.ok(
      !/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|this week|weekend)\b/i.test(ask),
      `${label}: must not name a DAY on the first touch`
    );
    assert.ok(!/\d\s*(am|pm)|\d:\d\d/i.test(ask), `${label}: must not name a clock TIME on the first touch`);
    assert.ok(
      (ask.match(/\?/g) ?? []).length === 1,
      `${label}: exactly one question — the ceiling is one per message`
    );
  }

  // Someone who already rode it is asked BACK, never to "come check it out" for the first time.
  const visited = buildWalkInSoftTimingAsk(true, true);
  assert.ok(/stop back in/i.test(visited), "a customer who rode it is asked to stop BACK in");
  assert.ok(!/check it out/i.test(visited), "…and never invited to see it as though for the first time");
  assert.ok(/check it out/i.test(buildWalkInSoftTimingAsk(false, false)), "someone who has not been in IS invited to check it out");

  // --- the wiring, at the one call site ---------------------------------------------------------
  const src = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
  assert.ok(
    src.includes("customerVisitConfirmed(args.conv) || dealerRecordedDemoRide(args.conv)"),
    "the walk-in builder composes the narrow predicate with the shared one"
  );
  assert.ok(src.includes("buildWalkInSoftTimingAsk(useVisitFraming, true)"), "the in-stock ending uses the ask");
  assert.ok(src.includes("buildWalkInSoftTimingAsk(useVisitFraming, false)"), "and so does the default ending");
  // The passive endings this replaced must not creep back into this builder.
  assert.ok(
    !src.includes("If any questions come up or you want to come back in and go over options"),
    "the old passive visited ending is gone"
  );

  console.log("PASS walk-in soft timing ask — it asks, it stays loose on timing, and it knows they already rode it.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
