/**
 * Inventory-hold TTL decision-table eval (2026-07-17).
 *
 * Pins the fail-safe reconcile heal for the `holding_inventory` freeze: a watch-fire hold
 * whose watch never re-fires left an engaged lead's ACTIVE cadence frozen with a past-due
 * nextDueAt FOREVER (the cadence tick skips holding_inventory convs; live census 7/17:
 * 11 conversations, worst 104 days overdue — Cory Fiegel +17169490089, held since a 6/5
 * watch fire, 41 days overdue, zero touches on an engaged test-ride lead).
 *
 * Contract pinned (pure decision, domain/cadenceHoldTtl.ts):
 *  (a) hold older than the TTL + no watch re-fire + open engaged conv => resume ONE
 *      future-dated gentle step (mode -> active, reason inventory_hold_expired);
 *  (b) hold still inside the TTL (or the watch re-fired inside it) => stays held;
 *  (c) every excluded state — closed, opted-out/suppressed, call_only, human mode,
 *      manual_handoff / paused_indefinite, post-sale, booked appointment, non-active
 *      cadence — is NEVER resumed;
 *  (d) a resumed nextDueAt is STRICTLY in the future (no send-now burst), and an
 *      already-future nextDueAt is never pulled earlier.
 * Plus: the env TTL override parse, the reconciler apply-site source guard, and the
 * `followUpHold` display-honesty helper (a held cadence must not render as overdue).
 *
 * Run: npx tsx scripts/cadence_hold_ttl_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  CADENCE_HOLD_INVENTORY_TTL_DAYS_DEFAULT,
  decideCadenceHoldTtlResume,
  isFollowUpCadenceHeld,
  resolveCadenceHoldInventoryTtlDays,
  type CadenceHoldTtlInput
} from "../services/api/src/domain/cadenceHoldTtl.ts";

let n = 0;
const ok = (c: boolean, m: string) => {
  assert.equal(c, true, m);
  n++;
};

// The operator-reported census case, verbatim shape: hold since the 6/5 watch fire,
// nextDueAt frozen at 6/6, "now" = the 7/17 census (41 days held).
const NOW_MS = Date.parse("2026-07-17T15:00:00.000Z");
const coryBase = (): CadenceHoldTtlInput => ({
  followUpMode: "holding_inventory",
  followUpUpdatedAt: "2026-06-05T18:30:00.000Z",
  watchLastNotifiedAts: ["2026-06-05T18:30:00.000Z"],
  conversationStatus: "open",
  closedAt: null,
  closedReason: null,
  soldAt: null,
  suppressed: false,
  contactPreference: null,
  conversationMode: "suggest",
  appointmentBookedEventId: null,
  cadenceStatus: "active",
  cadenceKind: "engaged",
  cadenceNextDueAt: "2026-06-06T14:00:00.000Z",
  nowMs: NOW_MS,
  ttlDays: CADENCE_HOLD_INVENTORY_TTL_DAYS_DEFAULT
});

// --- (a) Expired hold on an open engaged conv => resume one gentle future step. ---
{
  const d = decideCadenceHoldTtlResume(coryBase());
  ok(d.resume === true, "Cory census fixture: 41d-old hold with no re-fire resumes");
  if (d.resume) {
    ok(d.reason === "inventory_hold_expired", "resume reason is inventory_hold_expired");
    ok(Date.parse(d.nextDueAtIso) > NOW_MS, "(d) resumed nextDueAt is strictly in the future");
    ok(
      Date.parse(d.nextDueAtIso) <= NOW_MS + 25 * 60 * 60 * 1000,
      "resume is ONE gentle near-term step (~24h), not a far deferral"
    );
    ok(d.heldDays === 41, `heldDays computed from the hold start (got ${d.heldDays})`);
  }
}

// --- (b) Hold still inside the TTL => stays held. ---
{
  const d = decideCadenceHoldTtlResume({
    ...coryBase(),
    followUpUpdatedAt: new Date(NOW_MS - 5 * 24 * 60 * 60 * 1000).toISOString(),
    watchLastNotifiedAts: []
  });
  ok(!d.resume && d.reason === "within_ttl", "a 5-day-old hold (TTL 14) is still held");
}
// A watch RE-FIRE inside the TTL resets the clock even when the hold itself is old.
{
  const d = decideCadenceHoldTtlResume({
    ...coryBase(),
    watchLastNotifiedAts: [new Date(NOW_MS - 3 * 24 * 60 * 60 * 1000).toISOString()]
  });
  ok(!d.resume && d.reason === "within_ttl", "a watch re-fire 3d ago keeps the hold alive");
}
// Boundary: exactly at the TTL resumes (>= ttlDays).
{
  const d = decideCadenceHoldTtlResume({
    ...coryBase(),
    followUpUpdatedAt: new Date(NOW_MS - 14 * 24 * 60 * 60 * 1000).toISOString(),
    watchLastNotifiedAts: []
  });
  ok(d.resume === true, "a hold exactly at the 14d TTL resumes");
}

// --- (c) Excluded states are NEVER resumed, even with an ancient hold. ---
const excluded: Array<[string, Partial<CadenceHoldTtlInput>, string]> = [
  ["closed status", { conversationStatus: "closed" }, "closed"],
  ["closedAt stamped", { closedAt: "2026-07-01T00:00:00.000Z" }, "closed"],
  ["closedReason stamped", { closedReason: "not_interested" }, "closed"],
  ["opted-out / suppressed", { suppressed: true }, "suppressed"],
  ["call_only", { contactPreference: "call_only" }, "call_only"],
  ["human (staff-owned) mode", { conversationMode: "human" }, "human_mode"],
  ["manual_handoff", { followUpMode: "manual_handoff" }, "not_holding_inventory"],
  ["paused_indefinite", { followUpMode: "paused_indefinite" }, "not_holding_inventory"],
  ["active (no hold at all)", { followUpMode: "active" }, "not_holding_inventory"],
  ["post-sale (sold)", { soldAt: "2026-06-20T00:00:00.000Z" }, "post_sale"],
  ["post-sale cadence kind", { cadenceKind: "post_sale" }, "post_sale"],
  ["booked appointment", { appointmentBookedEventId: "evt_123" }, "appointment_booked"],
  ["stopped cadence", { cadenceStatus: "stopped" }, "cadence_not_active"],
  ["no cadence", { cadenceStatus: null }, "cadence_not_active"]
];
for (const [label, patch, expectedReason] of excluded) {
  const d = decideCadenceHoldTtlResume({ ...coryBase(), ...patch });
  ok(!d.resume, `${label}: never resumed`);
  ok(
    !d.resume && d.reason === expectedReason,
    `${label}: refusal reason is ${expectedReason} (got ${(d as any).reason})`
  );
}

// --- (d) An already-FUTURE nextDueAt is never pulled earlier by the resume. ---
{
  const future = new Date(NOW_MS + 10 * 24 * 60 * 60 * 1000).toISOString();
  const d = decideCadenceHoldTtlResume({ ...coryBase(), cadenceNextDueAt: future });
  ok(d.resume === true, "expired hold with a future-dated nextDueAt still resumes the mode");
  if (d.resume) {
    ok(
      Date.parse(d.nextDueAtIso) === Date.parse(future),
      "a future-dated nextDueAt stands (never pulled earlier)"
    );
  }
}
// Corrupt/undatable hold anchor: stay conservative (no resume we can't justify).
{
  const d = decideCadenceHoldTtlResume({
    ...coryBase(),
    followUpUpdatedAt: "not-a-date",
    watchLastNotifiedAts: [null, "garbage"]
  });
  ok(!d.resume && d.reason === "no_hold_anchor", "undatable hold anchor => no resume");
}

// --- Env TTL override parse. ---
ok(resolveCadenceHoldInventoryTtlDays("30") === 30, "env TTL '30' parses to 30");
ok(
  resolveCadenceHoldInventoryTtlDays(undefined) === CADENCE_HOLD_INVENTORY_TTL_DAYS_DEFAULT,
  "unset env falls back to the 14d default"
);
ok(
  resolveCadenceHoldInventoryTtlDays("garbage") === CADENCE_HOLD_INVENTORY_TTL_DAYS_DEFAULT &&
    resolveCadenceHoldInventoryTtlDays("-3") === CADENCE_HOLD_INVENTORY_TTL_DAYS_DEFAULT,
  "garbage / non-positive env values fall back to the default"
);
{
  const d = decideCadenceHoldTtlResume({
    ...coryBase(),
    followUpUpdatedAt: new Date(NOW_MS - 20 * 24 * 60 * 60 * 1000).toISOString(),
    watchLastNotifiedAts: [],
    ttlDays: 30
  });
  ok(!d.resume && d.reason === "within_ttl", "a 20d hold under a 30d env TTL is still held");
}

// --- Display honesty: followUpHold flags a held cadence; post_sale keeps running through holds. ---
ok(isFollowUpCadenceHeld("holding_inventory", "engaged") === true, "holding_inventory => held");
ok(isFollowUpCadenceHeld("manual_handoff", "standard") === true, "manual_handoff => held");
ok(isFollowUpCadenceHeld("paused_indefinite", null) === true, "paused_indefinite => held");
ok(
  isFollowUpCadenceHeld("holding_inventory", "post_sale") === false,
  "post_sale cadence runs THROUGH a hold — not flagged held"
);
ok(isFollowUpCadenceHeld("active", "engaged") === false, "active mode => not held");
ok(isFollowUpCadenceHeld(null, null) === false, "no mode => not held");

// --- Source guards: the 60s reconcile tick applies the heal; the console serializers expose the flag. ---
const api = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(
  api,
  /decideCadenceHoldTtlResume\(\{/,
  "the reconcile tick calls the pure TTL decision"
);
assert.match(
  api,
  /setFollowUpMode\(conv, "active", "inventory_hold_expired"\)/,
  "an expired hold resumes to active with the inventory_hold_expired annotation"
);
n += 2;
const store = fs.readFileSync("services/api/src/domain/conversationStore.ts", "utf8");
assert.match(
  store,
  /followUpHold: isFollowUpCadenceHeld\(/,
  "the conversation list serializer exposes followUpHold for display honesty"
);
n += 1;

console.log(`PASS cadence-hold-ttl eval (${n} assertions)`);
