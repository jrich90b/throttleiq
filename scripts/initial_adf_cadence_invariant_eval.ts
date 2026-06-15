/**
 * Initial-ADF cadence invariant. Every branch that sends an opener via
 * queueInitialDraftForPreferredContact must, within that same branch, EITHER
 * start a re-engagement cadence OR put the lead into a deliberate non-cadence
 * state (handoff / hold / paused / a booked appointment / a scheduled long-term
 * follow-up). Otherwise the lead gets one message and then nothing — the
 * "why didn't a follow-up fire?" class (Jason / Meta promo 2026-06-13, and the
 * factory-order siblings).
 *
 * Static guard: for each queue-draft call, scan its branch (from the prior
 * queue-draft or 60 lines back, through the branch's `return res.status(200)`)
 * for one of the accepted signals.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const file = "services/api/src/routes/sendgridInbound.ts";
const lines = fs.readFileSync(path.resolve(file), "utf8").split(/\r?\n/);

const QUEUE = /queueInitialDraftForPreferredContact\(/;
const RETURN = /return res\.status\(200\)/;
const SIGNALS: RegExp[] = [
  /startFollowUpCadence\(/,
  /applyMetaPromoInitialCadence\(/, // shared Meta cadence helper (starts a cadence or pauses)
  /scheduleLongTermFollowUp\(/,
  /setFollowUpMode\(\s*conv,\s*"(manual_handoff|holding_inventory|paused_indefinite)"/,
  /result\.autoClose|closeConversation\(/, // lead is being closed — no follow-up wanted
  /You['’]re booked|booked for |appointment\.bookedEventId|appointment\.status\s*=\s*"confirmed"|insertEvent\(/ // booked appointment
];
// Branches intentionally without a cadence/handoff (with a reason). Keyed by a
// unique substring that appears in the branch window.
const ALLOWLIST: Array<{ needle: string; why: string }> = [];

const queueLines: number[] = [];
lines.forEach((l, i) => {
  if (QUEUE.test(l)) queueLines.push(i);
});
assert.ok(queueLines.length > 0, "expected initial-draft branches to scan");

const violations: string[] = [];
for (let k = 0; k < queueLines.length; k += 1) {
  const L = queueLines[k];
  const floor = Math.max(k > 0 ? queueLines[k - 1] + 1 : 0, L - 60);
  let ret = lines.length - 1;
  for (let j = L; j < Math.min(lines.length, L + 40); j += 1) {
    if (RETURN.test(lines[j])) { ret = j; break; }
  }
  const windowText = lines.slice(floor, ret + 1).join("\n");
  if (SIGNALS.some(re => re.test(windowText))) continue;
  if (ALLOWLIST.some(a => windowText.includes(a.needle))) continue;
  violations.push(`  line ${L + 1}: branch sends an opener with no cadence/handoff/booking signal`);
}

if (violations.length) {
  console.error(`Initial-ADF branches that drop the follow-up (${violations.length}):`);
  for (const v of violations) console.error(v);
  assert.fail("every initial-ADF reply branch must start a cadence or set a deliberate non-cadence state");
}
console.log(`PASS initial-adf cadence invariant — ${queueLines.length} branches all start a cadence or set a deliberate state`);
