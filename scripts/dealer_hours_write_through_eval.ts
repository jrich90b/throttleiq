/**
 * dealer_hours_write_through:eval
 *
 * Joe, 2026-08-15: "I've asked before, she keeps losing the hours."
 *
 * Nothing was ever lost. The console has TWO screens labelled "Business hours". Scheduler settings
 * writes `scheduler_config.businessHours` — the ONLY hours any customer-facing answer reads
 * (formatBusinessHoursForReply, formatHoursRange, the draft prompt's `dealerHoursToday`) and the
 * only hours the booking engine offers slots from. Settings -> dealer profile writes
 * `dealer_profile.hours`, which the backend reads NOWHERE except its own save merge. Hours typed
 * into the profile screen save, persist, and render back to Joe — and the agent goes on quoting the
 * other file.
 *
 * Measured on the LIVE store 2026-08-16, both stores written from those two screens:
 *   dealer_profile.hours.monday   = { open: "09:00", close: "06:00" }   <- closes 3h before it opens
 *   scheduler_config.monday       = { open: "09:00", close: "18:00" }   <- what customers are told
 * Same intent, two save paths. The console's `normalizeBusinessHours` repairs a close that lands at
 * or before its open by 12 hours, and it was wired into the SCHEDULER save only; the profile save
 * stored the raw pick. `dealer_profile.hours` also carries a nested `sales` sub-block (a second
 * writer, different shape) whose Saturday close is 16:00 against the top level's 15:00.
 *
 * This eval executes the SHIPPED functions (`services/api/src/domain/schedulerConfig.ts`) against a
 * throwaway scheduler_config file. It asserts the DECISION — which days reach the system of record
 * and with what values — never a log line or a source string.
 *
 * FAIL DIRECTION under test (case 3 is the one that matters most): both screens are live, and the
 * profile screen loads its hours from `dealer_profile.hours`. An unrelated profile save must NOT
 * push its stale copy over a fresher scheduler value, so only the days THIS request changed
 * propagate. A day that is invalid even after the 12-hour repair propagates nothing at all — the
 * system of record keeps the sane value it already had.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dealer-hours-eval-"));
const cfgPath = path.join(tmpDir, "scheduler_config.json");
process.env.SCHEDULER_CONFIG_PATH = cfgPath;

const {
  normalizeBusinessHoursMap,
  mergeDealerProfileHours,
  reconcileDealerProfileHours,
  getSchedulerConfig,
  saveSchedulerConfig
} = await import("../services/api/src/domain/schedulerConfig.js");

/** The live scheduler_config.businessHours as of 2026-08-16 — no sunday key at all. */
const LIVE_SCHEDULER_HOURS = {
  monday: { open: "09:00", close: "18:00" },
  tuesday: { open: "09:00", close: "18:00" },
  wednesday: { open: "09:00", close: "18:00" },
  thursday: { open: "09:00", close: "18:00" },
  friday: { open: "09:00", close: "18:00" },
  saturday: { open: "09:00", close: "15:00" }
};

/** The live dealer_profile.hours as of 2026-08-16, verbatim shape including the `sales` sub-block. */
const LIVE_PROFILE_HOURS = {
  sales: {
    monday: { open: "09:00", close: "18:00" },
    saturday: { open: "09:00", close: "16:00" },
    sunday: { open: null, close: null }
  },
  monday: { open: "09:00", close: "06:00" },
  tuesday: { open: "09:00", close: "18:00" },
  wednesday: { open: "09:00", close: "18:00" },
  thursday: { open: "09:00", close: "18:00" },
  friday: { open: "09:00", close: "18:00" },
  saturday: { open: "09:00", close: "15:00" }
};

async function seedScheduler(businessHours: Record<string, any>) {
  // saveSchedulerConfig writes the file AND drops the module cache, so each case starts clean.
  await saveSchedulerConfig({ timezone: "America/New_York", businessHours } as any);
}

async function schedulerHours() {
  const cfg = await getSchedulerConfig();
  return cfg.businessHours ?? {};
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}: ${err?.message ?? err}`);
  }
}

// 1. The nested `sales` sub-block is a second writer, not a day. It must never be mistaken for one,
//    or its 16:00 Saturday would overwrite the 15:00 the dealer actually keeps.
await check("normalize keeps only real weekdays and drops the `sales` sub-block", async () => {
  const normalized = normalizeBusinessHoursMap(LIVE_PROFILE_HOURS);
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, "sales"), false);
  assert.deepEqual(Object.keys(normalized).sort(), [
    "friday",
    "monday",
    "saturday",
    "thursday",
    "tuesday",
    "wednesday"
  ]);
  assert.deepEqual(normalized.saturday, { open: "09:00", close: "15:00" });
});

// 2. The live defect. A 6 PM pick stored as "06:00" is repaired to "18:00" — the value the scheduler
//    screen already holds — rather than propagated as a range that closes before it opens.
await check("a close before its open is repaired by 12 hours, not propagated raw", async () => {
  const normalized = normalizeBusinessHoursMap({ monday: { open: "09:00", close: "06:00" } });
  assert.deepEqual(normalized.monday, { open: "09:00", close: "18:00" });
});

// 3. THE FAIL-DIRECTION CASE. Both screens are live. A profile save that did not touch hours posts
//    its own stored copy back; it must not overwrite a scheduler value edited more recently.
await check("an unrelated profile save propagates nothing", async () => {
  await seedScheduler({ ...LIVE_SCHEDULER_HOURS, monday: { open: "10:00", close: "19:00" } });
  await reconcileDealerProfileHours(LIVE_PROFILE_HOURS, LIVE_PROFILE_HOURS);
  const after = await schedulerHours();
  assert.deepEqual(
    after.monday,
    { open: "10:00", close: "19:00" },
    "a fresher scheduler-screen edit was overwritten by the profile screen's stale copy"
  );
});

// 4. The whole point: a real edit on the profile screen reaches the store the agent reads.
await check("a real hours edit on the profile screen reaches scheduler_config", async () => {
  await seedScheduler(LIVE_SCHEDULER_HOURS);
  await reconcileDealerProfileHours(LIVE_PROFILE_HOURS, {
    ...LIVE_PROFILE_HOURS,
    saturday: { open: "09:00", close: "17:00" }
  });
  const after = await schedulerHours();
  assert.deepEqual(after.saturday, { open: "09:00", close: "17:00" });
  // Untouched days keep the system of record's value.
  assert.deepEqual(after.friday, { open: "09:00", close: "18:00" });
});

// 5. Closing a day is a real answer, not a gap — it must propagate, or the agent keeps offering slots
//    on a day the dealer just closed.
await check("explicitly closing a day propagates as closed", async () => {
  await seedScheduler(LIVE_SCHEDULER_HOURS);
  await reconcileDealerProfileHours(LIVE_PROFILE_HOURS, {
    ...LIVE_PROFILE_HOURS,
    saturday: { open: null, close: null }
  });
  const after = await schedulerHours();
  assert.deepEqual(after.saturday, { open: null, close: null });
});

// 6. Un-repairable garbage propagates nothing. "09:00"-"09:00" bumps to "21:00" and would be a
//    12-hour Sunday; a half-filled day has no range at all. Both keep the existing value instead.
await check("a day that is still invalid after the repair propagates nothing", async () => {
  await seedScheduler(LIVE_SCHEDULER_HOURS);
  await reconcileDealerProfileHours(LIVE_PROFILE_HOURS, {
    ...LIVE_PROFILE_HOURS,
    friday: { open: "09:00", close: null }
  });
  const after = await schedulerHours();
  assert.deepEqual(after.friday, { open: "09:00", close: "18:00" });
});

// 7. The second, independent "losing the hours" mechanism: `hours` was the one profile field that
//    took the incoming object wholesale while address/policies/voice/followUp all spread-merge, so a
//    partial save wiped every day it did not send.
await check("a partial save keeps the days it did not send", async () => {
  const merged = mergeDealerProfileHours(LIVE_PROFILE_HOURS, {
    monday: { open: "09:00", close: "18:00" }
  });
  assert.deepEqual(merged.friday, { open: "09:00", close: "18:00" });
  assert.deepEqual(merged.saturday, { open: "09:00", close: "15:00" });
  assert.ok(merged.sales, "the sales sub-block was dropped by a partial save");
  assert.deepEqual(merged.monday, { open: "09:00", close: "18:00" });
});

// 8. The merged profile hours are what the caller stores, so the profile keeps its own full copy.
await check("reconcile returns the merged profile hours for the profile to store", async () => {
  await seedScheduler(LIVE_SCHEDULER_HOURS);
  const returned = await reconcileDealerProfileHours(LIVE_PROFILE_HOURS, {
    saturday: { open: "09:00", close: "17:00" }
  });
  assert.deepEqual(returned.saturday, { open: "09:00", close: "17:00" });
  assert.deepEqual(returned.friday, { open: "09:00", close: "18:00" });
  assert.ok(returned.sales);
});

await fs.rm(tmpDir, { recursive: true, force: true });

if (failures) {
  console.error(`\ndealer_hours_write_through: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\ndealer_hours_write_through: all checks passed");
