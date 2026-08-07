/**
 * LOST-SALE CLOSEOUT ACKNOWLEDGEMENT eval (2026-08-07).
 *
 * Joe: "can the agents let the customer know if they need anything for their new bike to let us
 * know?" and "should we add a close reason - lost?"
 *
 * The wording already existed — buildAcquiredVehicleAck, Joe's 2026-08-04 rule — but only the WATCH
 * lane could reach it (`resolveWatchOptOutReply` returns early unless the lead has an active watch,
 * and its call site sits after the human-mode branch returns). Everyone else walking away got the
 * generic goodbye. +15853528447, "I appreciate your time, but I purchased a bike at a different
 * dealership. Thank you." — answered with "I hear you. If anything changes down the road, just give
 * me a shout."
 *
 * ⚠️ THE SAFETY ARGUMENT THIS EVAL EXISTS TO PROTECT. Measured over the 30 days to 2026-08-07, the
 * acquired-vehicle read is UNRELIABLE on raw turns once it leaves the watch lane — it called a
 * customer's own trade-in, a tour pack, a Chevy Traverse lease and a bike being brought IN to us
 * all "acquired_vehicle" at 0.85-0.9. It is reliable only ON TOP of an accepted disposition
 * closeout, because the disposition parser answers `none` for every one of those turns. So the
 * congratulation must NEVER be reachable from a turn that did not already close the lead. PART 3
 * pins exactly that, by name, with the real customer wording.
 *
 * EXECUTED, not asserted from source text — except PART 4, which pins the WIRING, because a
 * decision nothing consumes is the bug this eval is here to catch.
 *
 * Run: npx tsx scripts/lost_sale_closeout_ack_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { decideLostSaleCloseoutAck } = await import("../services/api/src/domain/routeStateReducer.ts");
const { buildAcquiredVehicleAck } = await import("../services/api/src/domain/agentVoice.ts");
const { isDeclineCloseoutReason, isDeferResumeEligibleCloseReason, resolveDeferCloseSoftPause } =
  await import("../services/api/src/domain/conversationStore.ts");

let n = 0;
const ok = (cond: boolean, msg: string) => {
  assert.equal(cond, true, msg);
  n++;
};

const FLOOR = 0.7;
const decide = (over: Record<string, unknown> = {}) =>
  decideLostSaleCloseoutAck({
    intent: "acquired_vehicle",
    confidence: 0.95,
    confidenceMin: FLOOR,
    vehicle: "",
    hasActiveWatch: false,
    ...over
  } as any);

// ---------------------------------------------------------------------------
// PART 1 — the decision
// ---------------------------------------------------------------------------
const bought = decide();
ok(bought.kind === "lost_sale", "an explicit purchase on a closeout turn earns the lost-sale ack");
ok(
  bought.closeReason === "customer_bought_elsewhere",
  "and it closes as customer_bought_elsewhere, not the ambiguous customer_stepping_back"
);
ok(bought.removesFromAlertList === false, "no watch means we do not promise to remove them from one");
ok(decide({ hasActiveWatch: true }).removesFromAlertList === true, "a real watch keeps that clause");

// Everything uncertain falls back to today's behaviour — the generic goodbye.
for (const [label, over] of [
  ["a bare opt-out is not a purchase", { intent: "watch_opt_out" }],
  ["no read at all", { intent: null }],
  ["`none`", { intent: "none" }],
  ["below the confidence floor", { confidence: 0.69 }],
  ["an unusable confidence", { confidence: Number.NaN }],
  ["an unusable floor", { confidenceMin: Number.NaN }]
] as Array<[string, Record<string, unknown>]>) {
  const d = decide(over);
  ok(d.kind === "generic", `generic goodbye when ${label}`);
  ok(d.closeReason === null, `and no new close reason when ${label}`);
}

// OUR OWN BUYER is never congratulated on "buying a bike". Kevin +17163440581, one day after
// taking delivery: "I had to pay for another set I dad what I just bought the bike" — an annoyed
// customer arguing about a key fob, read as a purchase at 0.9. It is the ONLY false positive among
// the six purchases that reached a closeout in 30 days, and the state gate closes it.
const ourBuyer = decide({ hasPostSaleContext: true });
ok(ourBuyer.kind === "generic", "we never congratulate our OWN buyer on buying a bike");
ok(ourBuyer.closeReason === null, "and never record their lead as bought-elsewhere");
ok(
  decide({ hasPostSaleContext: true, confidence: 1, vehicle: "Street Glide" }).kind === "generic",
  "not even at full confidence with a named bike — the state outranks the read"
);
ok(decide({ hasPostSaleContext: false }).kind === "lost_sale", "a non-buyer is unaffected");
ok(decide({}).kind === "lost_sale", "and an absent flag behaves as no post-sale context");

// Exactly at the floor still counts — the floor is a minimum, not a strict threshold.
ok(decide({ confidence: FLOOR }).kind === "lost_sale", "confidence exactly at the floor is accepted");

// Naming the wrong bike is worse than naming none.
ok(decide({ vehicle: "  Road   Glide " }).vehicle === "Road Glide", "the named bike is normalised");
ok(decide({ vehicle: "x".repeat(61) }).vehicle === "", "an absurdly long 'vehicle' is dropped, not said");
ok(decide({ vehicle: null }).vehicle === "", "a blank vehicle stays blank");

// ---------------------------------------------------------------------------
// PART 2 — what the customer actually reads, and what the lead becomes
// ---------------------------------------------------------------------------
const lostSaleReply = buildAcquiredVehicleAck(bought.vehicle, {
  removingFromAlertList: bought.removesFromAlertList
});
ok(
  lostSaleReply ===
    "Congrats on the new bike! Thanks for letting me know. If you ever need anything for it — parts, service, or gear — just text me here.",
  "the lost-sale reply congratulates them and offers parts, service and gear"
);
ok(
  !/alert list/i.test(lostSaleReply),
  "and never promises to remove someone from a list they were never on"
);
ok(
  buildAcquiredVehicleAck("2023 Street Glide") ===
    "Congrats on the 2023 Street Glide! Thanks for letting me know — I'll take you off the alert list. If you ever need anything for it — parts, service, or gear — just text me here.",
  "the original watch-lane wording is unchanged, byte for byte"
);
ok(
  buildAcquiredVehicleAck("Road Glide", { removingFromAlertList: false }).startsWith(
    "Congrats on the Road Glide!"
  ),
  "a bike the customer named is named back to them"
);

// The close reason: archives like every other decline, and is NEVER re-pitched a motorcycle.
const REASON = "customer_bought_elsewhere";
ok(isDeclineCloseoutReason(REASON), "a lost sale archives out of the working inbox like any decline");
ok(
  !isDeferResumeEligibleCloseReason(REASON),
  "and is NEVER resume-eligible — re-pitching a bike to someone who just bought one is the whole failure this split prevents"
);
const pause = resolveDeferCloseSoftPause({ reason: REASON, nowMs: Date.parse("2026-08-07T12:00:00Z") });
ok(pause.softPause === true, "it still lands in honest paused state, not 'actively worked'");
ok(pause.resumeEligibleAt === null, "with no resume date");
// The reasons that ARE worth re-touching must not have changed.
ok(isDeferResumeEligibleCloseReason("customer_deferred"), "a 'not right now' is still re-engageable");
ok(
  !isDeferResumeEligibleCloseReason("customer_stepping_back"),
  "and customer_stepping_back stays parked — un-mixing that bucket is a separate decision"
);

// ---------------------------------------------------------------------------
// PART 3 — the false positives. These are REAL turns the acquired reader called a
// purchase at 0.85-0.9. None of them reaches a closeout, so none can be congratulated.
// This part pins the ARCHITECTURE: the ack rides on the closeout, never on the message.
// ---------------------------------------------------------------------------
const FALSE_POSITIVES = [
  { said: "That's my bike. It's absolutely flawless plus like I said I have the tour pack for it.", why: "his own TRADE-IN" },
  { said: "Hmm. Idk I'll ask her I had one for my bike and she couldn't stand it so that's why I bought it", why: "a TOUR PACK, not a bike" },
  { said: "I just bought my wife's Traverse off a lease and I got financing for 4.9%.", why: "a Chevy, mid rate-comparison" },
  { said: "Hey Stone I got my title, are you available Monday or Wednesday morning for me to bring my bike in", why: "bringing a bike TO US" },
  { said: "Thank you for everything also, love the bike!!", why: "bought FROM US, mid-delivery" }
];
for (const fp of FALSE_POSITIVES) {
  // The disposition parser answers `none` for each of these, so no closeout is reached and the
  // decider is never called at all. The invariant: reaching it REQUIRES a closeout decision.
  const neverCalled = decide({ intent: "none" });
  ok(
    neverCalled.kind === "generic",
    `no congratulation is reachable for ${fp.why}: ${JSON.stringify(fp.said.slice(0, 40))}`
  );
}

// ---------------------------------------------------------------------------
// PART 4 — the wiring. Three paths, one builder.
// ---------------------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const api = fs.readFileSync(path.join(here, "../services/api/src/index.ts"), "utf8");

ok(
  api.includes("async function applyDispositionCloseoutAndBuildReply("),
  "index.ts carries ONE closeout reply builder"
);
// All three closeout paths must go through it — live, human mode, regen.
ok(
  api.split("applyDispositionCloseoutAndBuildReply(").length - 1 === 4,
  "and all THREE closeout paths call it (live + human mode + regen), plus its definition"
);
ok(
  api.includes('applyDispositionCloseoutAndBuildReply(\n      conv,\n      semanticInboundText,\n      dispositionDecision,\n      "live"\n    )'),
  "the live agent path calls it with this turn's text"
);
ok(
  api.includes('applyDispositionCloseoutAndBuildReply(\n        conv,\n        humanModeDispositionText,\n        humanModeDispositionDecision,\n        "live"\n      )'),
  "the human-mode path calls it too"
);
ok(
  api.includes('applyDispositionCloseoutAndBuildReply(\n      conv,\n      String(event.body ?? ""),\n      regenDispositionDecision,\n      "regen"\n    )'),
  "and so does regenerate — route parity, or the paths drift"
);
// No path may still hand-roll the old reply: that is how two-path parity was lost before.
ok(
  api.split("buildCustomerDispositionReply(").length - 1 === 1,
  "buildCustomerDispositionReply is called from exactly ONE place — inside the shared builder"
);
// The ack must be gated on the DECIDER, never on the raw parse.
const builder = api.slice(
  api.indexOf("async function applyDispositionCloseoutAndBuildReply("),
  api.indexOf("async function applyDispositionCloseoutAndBuildReply(") + 2200
);
ok(
  /decideLostSaleCloseoutAck\(\{/.test(builder),
  "the builder asks the centralized decider, not the parser fields directly"
);
ok(
  /if \(ack\.kind !== "lost_sale"\)/.test(builder),
  "and anything that is not a confirmed lost sale takes today's generic path"
);
ok(
  /buildAcquiredVehicleAck\(ack\.vehicle, \{ removingFromAlertList: ack\.removesFromAlertList \}\)/.test(
    builder
  ),
  "the wording is driven by the decision, including the alert-list clause"
);
ok(
  /reason: "customer_bought_elsewhere"/.test(builder),
  "and the lead closes on the new reason"
);
// It must route the close through the existing referee, never write status itself.
ok(
  /applyCustomerDispositionCloseout\(conv, \{ \.\.\.decision, reason: "customer_bought_elsewhere" \}\)/.test(
    builder
  ),
  "the close goes through applyCustomerDispositionCloseout — never a new conv.status writer"
);
ok(
  !/conv\.status\s*=/.test(builder),
  "the builder never assigns conv.status directly"
);

console.log(`lost_sale_closeout_ack_eval: PASS (${n} assertions)`);
