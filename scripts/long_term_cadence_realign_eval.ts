/**
 * Mis-deferred long_term cadence re-align eval (2026-06-25).
 *
 * `realignMisdeferredLongTermCadence` (conversationStore) heals a lead that was wrongly pushed to a
 * long_term (months-out) first touch when its STRUCTURED purchase timeframe actually resolves to the
 * STANDARD day-1 ramp — e.g. Richard Tait (+17162893849): a "3-12 Months" (start=3) marketplace lead
 * deferred ~3 months by the old inline `monthsStart >= 1` gate. The cron reconcile runs it so existing
 * leads (created before the intake fix) get their initial nurture now, not in 3 months.
 *
 * Tight gate (fail-direction safe — only ever moves the next touch SOONER): ACTIVE long_term cadence,
 * OPEN + never-contacted + non-handoff/-watch/-booked lead, timeframe resolves to "standard".
 *
 * Run: npx tsx scripts/long_term_cadence_realign_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH || path.join(os.tmpdir(), `lt-realign-eval-${Date.now()}.json`);
const { realignMisdeferredLongTermCadence, upsertConversationByLeadKey } = await import(
  "../services/api/src/domain/conversationStore.ts"
);

const TZ = "America/New_York";
const NOW = new Date("2026-06-25T15:00:00.000Z");
let n = 0;

// A long_term cadence whose timeframe is actually standard (3-12mo, start=3), never contacted → heal.
const mk = (key: string, over: any = {}) => {
  const c: any = upsertConversationByLeadKey(key, "suggest");
  c.lead = { purchaseTimeframe: "3-12 Months", purchaseTimeframeMonthsStart: 3, ...(over.lead ?? {}) };
  c.followUpCadence = {
    status: "active",
    kind: "long_term",
    anchorAt: "2026-09-25T10:30:00.000Z",
    nextDueAt: "2026-09-25T13:00:00.000Z",
    stepIndex: 0,
    deferredMessage: "Hi, this is Brooke...",
    ...(over.followUpCadence ?? {})
  };
  c.messages = over.messages ?? [{ direction: "in", provider: "sendgrid_adf", body: "WEB LEAD", at: "2026-06-24T23:13:00.000Z" }];
  Object.assign(c, over.conv ?? {});
  return c;
};

// --- POSITIVE: the Richard case re-anchors to a standard day-1 ramp. ---
const richard = mk("+15550000001");
assert.equal(realignMisdeferredLongTermCadence(richard, TZ, NOW), true, "3-12mo, never-contacted long_term => re-aligned");
assert.equal(richard.followUpCadence.kind, "standard", "kind flipped to standard");
assert.ok(Date.parse(richard.followUpCadence.nextDueAt) < Date.parse("2026-07-15T00:00:00Z"), "next touch is now days out, not months");
assert.equal(richard.followUpCadence.stepIndex, 0, "re-anchored from the top");
n += 4;

// --- NEGATIVES: never touch a genuinely far-out or otherwise-held lead. ---
assert.equal(
  realignMisdeferredLongTermCadence(mk("+15550000002", { lead: { purchaseTimeframe: "7-12 Months", purchaseTimeframeMonthsStart: 7 } }), TZ, NOW),
  false,
  "genuinely far-out (7mo) long_term stays deferred"
);
assert.equal(
  realignMisdeferredLongTermCadence(mk("+15550000003", { lead: { purchaseTimeframe: "1-3 Years", purchaseTimeframeMonthsStart: undefined } }), TZ, NOW),
  false,
  "multi-year stays deferred"
);
// The initial opener is SEPARATE from the cadence — a lead whose opener was sent but whose long_term
// nurture (stepIndex 0) hasn't fired is still re-aligned (the Richard case once his email went out).
const contactedRichard = mk("+15550000004", {
  messages: [
    { direction: "in", provider: "sendgrid_adf", body: "WEB LEAD", at: "2026-06-24T23:13:00.000Z" },
    { direction: "out", provider: "sendgrid", body: "Hi richard, thanks for your inquiry...", at: "2026-06-25T11:34:00.000Z" }
  ]
});
assert.equal(realignMisdeferredLongTermCadence(contactedRichard, TZ, NOW), true, "opener sent but nurture not started (stepIndex 0) => still re-aligned");
assert.equal(contactedRichard.followUpCadence.kind, "standard", "contacted-but-unnurtured lead flips to standard");
// But a cadence already mid-nurture (a long_term step fired) is left alone — re-anchoring is disruptive.
assert.equal(
  realignMisdeferredLongTermCadence(mk("+15550000009", { followUpCadence: { stepIndex: 1 } }), TZ, NOW),
  false,
  "long_term cadence already mid-nurture (stepIndex>0) => left alone"
);
n += 1;
assert.equal(
  realignMisdeferredLongTermCadence(mk("+15550000005", { conv: { closedReason: "sold" } }), TZ, NOW),
  false,
  "closed/sold => left alone"
);
assert.equal(
  realignMisdeferredLongTermCadence(mk("+15550000006", { conv: { followUp: { mode: "manual_handoff" } } }), TZ, NOW),
  false,
  "manual_handoff => left alone"
);
assert.equal(
  realignMisdeferredLongTermCadence(mk("+15550000007", { conv: { appointment: { bookedEventId: "evt1" } } }), TZ, NOW),
  false,
  "already booked => left alone"
);
// A standard cadence is not in scope (only long_term mis-deferrals).
assert.equal(
  realignMisdeferredLongTermCadence(mk("+15550000008", { followUpCadence: { kind: "standard" } }), TZ, NOW),
  false,
  "a standard cadence is not re-aligned"
);
n += 7;

// --- Source guard: the cron reconcile runs the heal. ---
const api = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(api, /realignMisdeferredLongTermCadence\(conv, cfg\.timezone, now\)/, "reconcile runs the heal");
assert.match(api, /long_term_cadence_realigned_to_standard/, "route outcome recorded");
n += 2;

console.log(`PASS long_term cadence re-align eval (${n} assertions)`);
