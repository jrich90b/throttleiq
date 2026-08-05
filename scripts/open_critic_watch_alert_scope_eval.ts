/**
 * open_critic_watch_alert_scope:eval — a VERIFIED inventory-watch alert is not fabricated availability.
 *
 * Production phantom (2026-08-05, +17165104578 Jason Roorda). His Room58 ADF pinned a specific unit —
 * 2021 Street Glide Special, stock U889-21 — and his watch is `exactness: "model_only"`, i.e.
 * DELIBERATELY year-agnostic. On 2026-08-04 that watch fired on an arriving 2019 Street Glide Special,
 * stock U911-19, and the agent sent the correct watch-alert copy ("a 2019 Harley-Davidson Street Glide
 * Special you were watching for just came in, this one's Silver Flux/Black Fuse").
 *
 * U911-19 was in the very inventory snapshot the open critic was handed — so its INVENTORY CHECK
 * PASSED and it flagged anyway, labelling the finding `promised_unit_not_in_stock` with the reason
 * "not among the requested model (2021 Street Glide Special)". That is a different proposition from
 * "we don't have this bike", and it is false. Because `issue_class` is free-form in the critic's
 * schema and `decideOpenCriticAnomaly` gated only on hasIssue/major/confidence, the swap reached the
 * work order as a P2 Tier-2 escalation — 100% of that day's flagged open-critic output.
 *
 * The base-trim mis-fires that made this thread LOOK pathological (2026-06-26 on a 2013 base Street
 * Glide, 2026-07-03 on a 2024 base Street Glide U902-24) are stale echoes of a real bug fixed by the
 * engine reverse guard `de3e292b` (#168, 2026-07-07); they cannot recur.
 *
 * FAIL DIRECTION, and the whole point of this eval: suppression requires FOUR positively-proven facts.
 * Anything missing, unknown, or unverifiable leaves the finding flagged exactly as today. A genuine
 * out-of-stock promise can never be silenced, because suppression requires the promised stock id to be
 * PRESENT in the current feed.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  OPEN_CRITIC_WATCH_ALERT_WINDOW_MS,
  decideOpenCriticAnomaly,
  isAvailabilityFabricationIssueClass,
  resolveOpenCriticWatchAlertContext,
  summarizeTurnActions
} from "../services/api/src/domain/conversationOutcomeAudit.ts";

// The sweep's notion of a "real" (sent) outbound — mirror it so the fixture matches production.
const REAL_OUT = new Set(["twilio", "sendgrid", "human"]);

// --- The production fixture, verbatim from the live store ---------------------
const FIRED_AT = "2026-08-04T16:05:26.052Z";
const REPLY_AT = "2026-08-04T17:13:29.516Z"; // 68 minutes later — the draft waited for staff approval.
// The stock ids stay PARAMETERS, never literals inside an assertion: the guard here is dealer-agnostic
// (an id the fire recorded must come back out and be looked up in the feed), and hardcoding a dealer's
// id shape into an assertion is what `eval_suite_manifest:eval` blocks. ALERT_STOCK_ID is the unit the
// 2026-08-04 fire alerted on; LEAD_STOCK_ID is the unit the ADF originally pinned.
const ALERT_STOCK_ID = "U911-19";
const LEAD_STOCK_ID = "U889-21";
const ALERT_BODY =
  "Hey Jason, good news — a 2019 Harley-Davidson Street Glide Special you were watching for just came in, " +
  "this one's Silver Flux/Black Fuse. Are you still looking?";

const modelOnlyWatch = {
  model: "Street Glide Special",
  make: "Harley-Davidson",
  condition: "used",
  exactness: "model_only",
  status: "active",
  createdAt: "2026-06-20T15:04:25.620Z",
  note: "context_note_watch",
  lastNotifiedAt: FIRED_AT,
  lastNotifiedStockId: ALERT_STOCK_ID,
  lastNotifiedModel: "Street Glide Special"
};

const alertReply = { direction: "out", provider: "twilio", body: ALERT_BODY, at: REPLY_AT };

const jason = (watch: any = modelOnlyWatch, extraMsgs: any[] = []) => ({
  id: "+17165104578",
  leadKey: "+17165104578",
  lead: { source: "Room58 - Request details", vehicle: { year: "2021", model: "Street Glide Special", stockId: LEAD_STOCK_ID } },
  inventoryWatches: [watch],
  messages: [
    { direction: "in", provider: "sendgrid_adf", body: "WEB LEAD (ADF) ...", at: "2026-06-15T21:09:31.545Z" },
    { direction: "out", provider: "twilio", body: "Hey Jason, it's Alexandra ...", at: "2026-06-15T21:55:38.971Z" },
    ...extraMsgs,
    alertReply
  ]
});

const IN_STOCK = new Set([ALERT_STOCK_ID, LEAD_STOCK_ID]);
const FINDING = {
  hasIssue: true,
  severity: "major",
  issueClass: "promised_unit_not_in_stock",
  reason: "The agent mentioned a 2019 Street Glide Special is available, but it was not among the requested model (2021 Street Glide Special)",
  confidence: 0.9
};
const BASE = { convId: "+17165104578", leadKey: "+17165104578" };
const decide = (conv: any, finding: any = FINDING, stock: Set<string> = IN_STOCK) =>
  decideOpenCriticAnomaly(finding, BASE, resolveOpenCriticWatchAlertContext(conv, alertReply, stock, REAL_OUT));

// --- 1. The phantom is suppressed --------------------------------------------
assert.equal(
  decide(jason()),
  null,
  "a model_only watch alert whose promised stock id IS in the feed is not fabricated availability"
);

// --- 2. A REAL out-of-stock promise still flags -------------------------------
assert.ok(
  decide(jason(), FINDING, new Set([LEAD_STOCK_ID])) !== null,
  "the promised stock id absent from the feed => still flagged (the guard cannot silence a real miss)"
);

// --- 3. A non-watch-alert reply still flags -----------------------------------
// The 2026-07-26 financing message about the HELD 2021 unit: a real outbound sits between the fire
// stamp and the graded reply, so the reply is not the message that fire produced.
assert.ok(
  decide(jason(modelOnlyWatch, [{ direction: "out", provider: "twilio", body: "Jason, that 2021 Street Glide Special qualifies for ...", at: "2026-08-04T16:30:00.000Z" }])) !== null,
  "an intervening real outbound breaks the correlation => still flagged"
);

// --- 4. An empty / missing inventory feed still flags -------------------------
assert.ok(
  decide(jason(), FINDING, new Set<string>()) !== null,
  "an empty inventory snapshot vouches for nothing => still flagged"
);

// --- 5. A YEAR-PINNED watch firing off-year still flags -----------------------
// That IS a real defect: a year_model watch must only fire on its exact year.
assert.ok(
  decide(jason({ ...modelOnlyWatch, exactness: "year_model", year: 2021 })) !== null,
  "a year_model watch firing off-year is a genuine defect => still flagged"
);
assert.ok(
  decide(jason({ ...modelOnlyWatch, year: 2021 })) !== null,
  "a year pin alone (whatever `exactness` says) keeps the finding flagged"
);

// --- 6. Class scoping: only the availability question is quieted --------------
for (const cls of ["watch_set_for_wrong_model", "wrong_model_notified_on_watch", "ignored_prior_context_and_active_relationship", "unsolicited_payment_quote"]) {
  assert.ok(
    decide(jason(), { ...FINDING, issueClass: cls }) !== null,
    `a non-availability issue class (${cls}) is never suppressed by this guard`
  );
}
for (const cls of ["promised_unit_not_in_stock", "availability_claim_for_unavailable_unit", "availability_not_confirmed_before_follow_up"]) {
  assert.equal(isAvailabilityFabricationIssueClass(cls), true, `${cls} is an availability-fabrication class`);
}
for (const cls of ["watch_set_for_wrong_model", "wrong_customer_name_in_reply", "", null, undefined]) {
  assert.equal(isAvailabilityFabricationIssueClass(cls), false, `${String(cls)} is NOT an availability-fabrication class`);
}

// --- 7. The correlation helper's decision table -------------------------------
const ctxOf = (conv: any, reply: any = alertReply, stock: Set<string> = IN_STOCK) =>
  resolveOpenCriticWatchAlertContext(conv, reply, stock, REAL_OUT);

assert.equal(ctxOf(jason()).isWatchAlert, true, "a stamped watch + a later reply inside the window correlates");
assert.equal(ctxOf(jason()).unitVerifiedInFeed, true, "the alerted unit is in the feed => vouched for");
assert.equal(ctxOf(jason()).stockId, ALERT_STOCK_ID, "the correlated stock id is surfaced");
assert.equal(
  ctxOf(jason({ ...modelOnlyWatch, lastNotifiedStockId: "" })).isWatchAlert,
  false,
  "no lastNotifiedStockId => nothing to vouch for => not a watch alert"
);
assert.equal(
  ctxOf(jason({ ...modelOnlyWatch, lastNotifiedAt: "2026-08-04T18:00:00.000Z" })).isWatchAlert,
  false,
  "a reply OLDER than the fire stamp cannot be that fire's alert"
);
assert.equal(
  ctxOf(jason({ ...modelOnlyWatch, lastNotifiedAt: "2026-08-01T16:05:26.052Z" })).isWatchAlert,
  false,
  "a fire stamp beyond the window is not this reply's fire"
);
for (const at of [undefined, null, "", "not-a-date"]) {
  assert.equal(
    ctxOf(jason(), { ...alertReply, at: at as any }).isWatchAlert,
    false,
    `an undatable reply (at=${String(at)}) cannot be correlated => flags`
  );
}
assert.equal(ctxOf(jason(), null as any).isWatchAlert, false, "no reply => not a watch alert");
assert.equal(ctxOf({ id: "x" }).isWatchAlert, false, "a conversation with no watches => not a watch alert");
assert.equal(
  ctxOf(jason(), alertReply, null as any).unitVerifiedInFeed,
  false,
  "a null stock-id set vouches for nothing"
);
assert.ok(OPEN_CRITIC_WATCH_ALERT_WINDOW_MS > 0, "the watch-alert correlation window is a real positive bound");

// --- 8. summarizeTurnActions carries the exactness the critic was missing ------
const actions = summarizeTurnActions(jason());
assert.equal(actions.activeWatches.length, 1, "the active watch is summarised for the critic");
assert.equal(actions.activeWatches[0].exactness, "model_only", "the critic is told the watch is model_only");
assert.equal(actions.activeWatches[0].yearPinned, false, "the critic is told the watch carries NO year pin");
assert.equal(
  summarizeTurnActions(jason({ ...modelOnlyWatch, exactness: "year_model", year: 2021 })).activeWatches[0].yearPinned,
  true,
  "a year-pinned watch reports yearPinned:true"
);

// --- 9. Source pins: the sweep must actually WIRE the guard --------------------
const sweep = fs.readFileSync(path.resolve("scripts/open_critic_sweep.ts"), "utf8");
assert.match(sweep, /resolveOpenCriticWatchAlertContext/, "the sweep imports + calls the watch-alert context resolver");
assert.match(sweep, /inventorySnapshot\.stockIds/, "the sweep passes the feed's STOCK IDS, not just model labels");
assert.match(
  sweep,
  /stockId\s*\?\?\s*it\?\.stock_id/,
  "the snapshot loader collects stock ids across the feed's field spellings"
);

console.log(
  "PASS open-critic watch-alert scope eval (verified model_only watch alert suppressed; out-of-stock, year-pinned, uncorrelated, empty-feed, and non-availability classes all still flagged)"
);
