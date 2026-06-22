import { strict as assert } from "node:assert";
import fs from "node:fs";

/**
 * Task auto-close BACKFILL eval. The send/inbound triggers only fire on NEW activity, so a task
 * fulfilled with no trailing message stays open forever (Paul Foley 6/22: parts question answered,
 * customer thanked, then quiet). The maintenance tick re-checks open eligible tasks against their
 * conversation window and closes the fulfilled ones — throttled (12h re-check, capped per tick,
 * requires a prior dealer outbound) so it never floods or over-spends. The 0.85 classifier still
 * owns each close. THIS eval pins the deterministic surface (loop + throttle + cap + gate).
 */

const idx = fs.readFileSync("services/api/src/index.ts", "utf8");

// Runs inside the maintenance tick (processDueFollowUpsUnlocked), gated by the live flag.
const tick = idx.slice(idx.indexOf("async function processDueFollowUpsUnlocked"));
assert.ok(tick.length > 0, "processDueFollowUpsUnlocked must exist");

assert.ok(/AUTOCLOSE_BACKFILL_PER_TICK/.test(tick), "backfill must cap how many convs it re-checks per tick");
assert.ok(/AUTOCLOSE_BACKFILL_RECHECK_MS/.test(tick), "backfill must throttle re-checks (12h marker)");
assert.ok(
  /isTaskFulfillmentAutoCloseEnabled\(\)/.test(tick),
  "backfill must be gated by the live auto-close flag"
);
assert.ok(
  /isAutoCloseEligibleTask\(/.test(tick) && /autoCloseCheck\?\.at/.test(tick),
  "backfill must only re-check eligible tasks and use autoCloseCheck.at as the throttle marker"
);
assert.ok(
  /m\?\.direction === "out"/.test(tick),
  "backfill must require a prior dealer outbound before re-checking"
);
assert.ok(
  /backfillOrder/.test(tick) && /lastMsgMs\(b\) - lastMsgMs\(a\)/.test(tick),
  "backfill must sweep FRESHEST-first (recently-answered tasks shouldn't wait behind old leads)"
);
assert.ok(
  /runTaskFulfillmentAutoClose\(conv, \{\s*channel: "sms",\s*text: "\(auto-close backfill re-check\)",\s*direction: "in"/.test(
    tick.replace(/\s+/g, " ")
  ) || /\(auto-close backfill re-check\)/.test(tick),
  "backfill must re-run the auto-close classifier on the conversation window"
);

console.log("task_autoclose_backfill:eval ok");
