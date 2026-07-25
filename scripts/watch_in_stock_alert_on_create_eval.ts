/**
 * watch_in_stock_alert_on_create:eval — pins the watch-fire-miss forward fix (approve-first,
 * DEFAULT OFF): when a watch is created and a matching unit is ALREADY in stock, run the existing
 * in-stock review pass so the watcher gets a DRAFT alert (the ordinary cron only fires on NEW
 * arrivals, so an already-on-the-lot match was never notified — +17166887637 Street Glide T37-26).
 *
 * Safety invariants pinned here (this is customer-send behavior):
 *  - LIVE-ONLY: the trigger fires only when a caller passes scope:"live". Regenerate must never
 *    fan out notifications (same rule as the post-broaden in-stock pass), so the two regen callers
 *    do NOT pass scope:"live".
 *  - DEFAULT OFF: gated on WATCH_IN_STOCK_ALERT_ON_CREATE === "1", so merging is a no-op until Joe
 *    reviews the stale-inventory freshness bound and enables it.
 *  - Reuses the existing guarded, drafts-only pass (processInventoryWatchlist … includeInStock).
 *
 * Source-guard style (same as prequal_normal_followup:eval / call_only_lead_silence:eval).
 * Run: npx tsx scripts/watch_in_stock_alert_on_create_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.join(process.cwd(), "services/api/src/index.ts"), "utf8");

// --- the choke point fires the in-stock review only on scope:"live" AND the default-off flag ---
const fnStart = src.indexOf("function applyInventoryWatchConfirmation(");
assert.ok(fnStart >= 0, "applyInventoryWatchConfirmation must exist");
const fnEnd = src.indexOf("\nfunction ", fnStart + 1);
const fnBody = src.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 2000);

assert.match(
  fnBody,
  /opts\?: \{ scope\?: "live" \| "regen" \}/,
  "the choke point must accept an optional scope so the trigger can be live-only"
);
assert.match(
  fnBody,
  /if \(opts\?\.scope === "live" && process\.env\.WATCH_IN_STOCK_ALERT_ON_CREATE === "1"\) \{[\s\S]{0,220}processInventoryWatchlist\(conv\.id, \{ includeInStock: true \}\)/,
  "the in-stock review must fire only on scope:'live' AND the default-off flag, reusing the includeInStock pass"
);

// --- LIVE callers (in the twilio webhook) pass scope:"live"; REGEN callers must NOT ---
const regenStart = src.indexOf('app.post("/conversations/:id/regenerate"');
const twilioStart = src.indexOf('app.post("/webhooks/twilio"');
assert.ok(regenStart >= 0 && twilioStart > regenStart, "handler boundaries must be locatable");
const regenBlock = src.slice(regenStart, twilioStart);
const twilioBlock = src.slice(twilioStart);

// Regen must never fan out notifications: neither regen caller passes scope:"live".
assert.ok(
  !/applyInventoryWatchConfirmation\(conv, [^)]*, \{ scope: "live" \}\)/.test(regenBlock),
  "the regenerate path must NOT pass scope:'live' (regen must not fan out watch notifications)"
);
assert.match(
  regenBlock,
  /applyInventoryWatchConfirmation\(conv, watchForAck\);/,
  "regen watchForAck caller stays scope-less"
);

// Every live caller in the twilio webhook opts in.
const liveCalls = twilioBlock.match(/applyInventoryWatchConfirmation\(conv, [^)]*\)/g) ?? [];
assert.ok(liveCalls.length >= 5, `expected >=5 live watch-confirmation callers, found ${liveCalls.length}`);
for (const call of liveCalls) {
  assert.ok(
    /\{ scope: "live" \}/.test(call),
    `live watch-confirmation caller must pass scope:'live' — found: ${call}`
  );
}

console.log(
  "PASS watch_in_stock_alert_on_create eval — in-stock review at watch creation is live-only + default-off, regen never fans out, all live callers opt in."
);
