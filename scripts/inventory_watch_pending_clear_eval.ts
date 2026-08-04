/**
 * inventory_watch_pending_clear:eval — ONE question: may this inbound drop the pending
 * inventory-watch prompt (`conv.inventoryWatchPending`)?
 *
 * Two places used to answer it independently (un-stacking slice, 2026-08-04):
 *
 *   A. `reduceStaleWorkflowStateForInbound` (index.ts) — asked the guarded rule:
 *      clear only when there is no reason to KEEP (not `holding_inventory`, the follow-up
 *      reason is not itself the watch, not `pending_used_followup`), the customer shows NO
 *      watch intent this turn, and then only on a manual handoff / a context shift / a
 *      pending older than 24h.
 *
 *   B. `applyConversationStateReducer` (index.ts) — cleared on
 *      `state.clearInventoryWatchPending || state.departmentIntent !== "none"`, with NO guards
 *      at all.
 *
 * THE DIVERGENCE WAS REAL AND FAIL-UNSAFE. B dropped the watch on a bare department mention
 * even when the lead was parked in `holding_inventory`, even when the follow-up reason WAS the
 * inventory watch, and even when the same turn asked about the watch — i.e. a customer who said
 * "tell me when a low-mile Road Glide lands" and then asked one service question was silently
 * forgotten. B also read the RAW `departmentIntent`, not the `explicitRequest`-gated value the
 * same function uses for department ROUTING, so an incidental mention was enough.
 *
 * RULING (AGENTS.md fail-direction, recorded in the joe-autonomous-rulings memory): the guarded
 * rule wins. Failing toward KEEPING the pending watch is recoverable — we re-ask. Failing toward
 * clearing it is not: nobody ever hears about the bike. Both sites now ask
 * `resolveInventoryWatchPendingClear`.
 *
 * BLAST RADIUS MEASURED BEFORE SHIPPING, on the live americanharley store (counts only, no PII
 * copied): 808 conversations, 3 carry a pending watch, and **0** of those 3 sit in a state where
 * the two rules disagree. The rule difference is real; no lead is in it today. That is why this
 * lands as a behavior change rather than waiting.
 *
 * The parser's explicit `clearInventoryWatchPending` signal is PRESERVED as a reason to clear —
 * it is a genuine "the customer moved on" reading — but it is now subject to the same keep-guards
 * rather than bypassing them.
 */
import assert from "node:assert/strict";

const { resolveInventoryWatchPendingClear, reduceStaleStateForInbound } = await import(
  "../services/api/src/domain/routeStateReducer.ts"
);
const {
  applyInventoryWatchPendingClear,
  applyInventoryWatchPendingClearForStateParse,
  applyInventoryWatchPendingClearForIntentHints
} = await import("../services/api/src/domain/conversationStore.ts");
const { rankContention } = await import("../services/api/src/domain/stateWriterContention.ts");

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks += 1;
};

type Case = {
  name: string;
  input: Parameters<typeof resolveInventoryWatchPendingClear>[0];
  clear: boolean;
  prompt: boolean;
};

// ---------------------------------------------------------------------------
// TABLE 1 — the KEEP-guards. Every row here is a case writer B used to clear and the
// referee now refuses. Break any guard and these go red.
// ---------------------------------------------------------------------------
const KEEP_CASES: Case[] = [
  {
    name: "holding_inventory lead, department mention — the lead is PARKED on inventory",
    input: {
      followUpMode: "holding_inventory",
      followUpReason: "none",
      dialogState: "inventory_watch_prompted",
      hasInventoryWatchPending: true,
      hasDepartmentIntent: true
    },
    clear: false,
    prompt: true
  },
  {
    name: "follow-up reason IS the inventory watch, department mention",
    input: {
      followUpMode: "active",
      followUpReason: "inventory_watch_followup",
      dialogState: "inventory_watch_prompted",
      hasInventoryWatchPending: true,
      hasDepartmentIntent: true
    },
    clear: false,
    prompt: true
  },
  {
    name: "pending_used_followup reason, department mention",
    input: {
      followUpMode: "active",
      followUpReason: "pending_used_followup",
      dialogState: "inventory_watch_prompted",
      hasInventoryWatchPending: true,
      hasDepartmentIntent: true
    },
    clear: false,
    prompt: true
  },
  {
    name: "SAME-TURN watch intent alongside the department question",
    input: {
      followUpMode: "active",
      followUpReason: "none",
      dialogState: "inventory_watch_prompted",
      hasInventoryWatchPending: true,
      hasDepartmentIntent: true,
      hasWatchIntent: true
    },
    clear: false,
    prompt: false
  },
  {
    name: "same-turn watch intent beats the parser's clear signal",
    input: {
      followUpMode: "active",
      followUpReason: "none",
      dialogState: "inventory_watch_prompted",
      hasInventoryWatchPending: true,
      hasWatchIntent: true,
      parserRequestedClear: true
    },
    clear: false,
    prompt: false
  },
  {
    name: "parser clear signal does NOT override a holding_inventory park",
    input: {
      followUpMode: "holding_inventory",
      followUpReason: "none",
      dialogState: "inventory_watch_prompted",
      hasInventoryWatchPending: true,
      parserRequestedClear: true
    },
    clear: false,
    prompt: false
  },
  {
    name: "no pending watch at all — nothing to clear",
    input: {
      followUpMode: "active",
      followUpReason: "none",
      dialogState: "none",
      hasInventoryWatchPending: false,
      hasDepartmentIntent: true,
      parserRequestedClear: true
    },
    clear: false,
    prompt: false
  },
  {
    name: "quiet turn, pending only 5h old — too young to expire",
    input: {
      followUpMode: "active",
      followUpReason: "none",
      dialogState: "inventory_watch_prompted",
      hasInventoryWatchPending: true,
      inventoryWatchPendingAgeHours: 5
    },
    clear: false,
    prompt: false
  }
];

// ---------------------------------------------------------------------------
// TABLE 2 — the CLEAR cases both writers already agreed on, plus the preserved parser signal.
// These prove the un-stacking did not quietly turn the rule off.
// ---------------------------------------------------------------------------
const CLEAR_CASES: Case[] = [
  {
    name: "manual handoff — a human owns the thread now",
    input: {
      followUpMode: "manual_handoff",
      followUpReason: "credit_app",
      dialogState: "inventory_watch_prompted",
      hasInventoryWatchPending: true
    },
    clear: true,
    prompt: true
  },
  {
    name: "context shift to a department, no keep-reason",
    input: {
      followUpMode: "active",
      followUpReason: "none",
      dialogState: "inventory_watch_prompted",
      hasInventoryWatchPending: true,
      hasDepartmentIntent: true
    },
    clear: true,
    prompt: true
  },
  {
    name: "context shift to finance",
    input: {
      followUpMode: "active",
      followUpReason: "none",
      dialogState: "none",
      hasInventoryWatchPending: true,
      hasFinanceIntent: true
    },
    clear: true,
    prompt: false
  },
  {
    name: "context shift to scheduling",
    input: {
      followUpMode: "active",
      followUpReason: "none",
      dialogState: "none",
      hasInventoryWatchPending: true,
      hasSchedulingIntent: true
    },
    clear: true,
    prompt: false
  },
  {
    name: "expired — pending 25h with no other signal",
    input: {
      followUpMode: "active",
      followUpReason: "none",
      dialogState: "none",
      hasInventoryWatchPending: true,
      inventoryWatchPendingAgeHours: 25
    },
    clear: true,
    prompt: false
  },
  {
    name: "parser said the customer moved off the watch, no keep-reason",
    input: {
      followUpMode: "active",
      followUpReason: "none",
      dialogState: "inventory_watch_prompted",
      hasInventoryWatchPending: true,
      inventoryWatchPendingAgeHours: 1,
      parserRequestedClear: true
    },
    clear: true,
    // the prompt goes with it: once the watch is cleared there is nothing left to answer
    prompt: true
  }
];

for (const c of [...KEEP_CASES, ...CLEAR_CASES]) {
  const d = resolveInventoryWatchPendingClear(c.input);
  ok(
    d.clearInventoryWatchPending === c.clear,
    `${c.name}: expected clear=${c.clear}, got ${d.clearInventoryWatchPending} (${d.reasons.join(",")})`
  );
  ok(
    d.clearInventoryWatchPrompt === c.prompt,
    `${c.name}: expected prompt-clear=${c.prompt}, got ${d.clearInventoryWatchPrompt}`
  );
}

// ---------------------------------------------------------------------------
// TABLE 3 — the OLD writer-B rule, re-encoded, so the fix cannot silently regress to it.
// For every row where the two rules differ, the referee must NOT clear.
// ---------------------------------------------------------------------------
{
  const oldWriterBWouldClear = (parserClear: boolean, hasDepartment: boolean): boolean =>
    parserClear || hasDepartment;

  let divergences = 0;
  for (const c of KEEP_CASES) {
    if (!c.input.hasInventoryWatchPending) continue;
    const oldSays = oldWriterBWouldClear(
      !!c.input.parserRequestedClear,
      !!c.input.hasDepartmentIntent
    );
    if (!oldSays) continue;
    divergences += 1;
    ok(
      resolveInventoryWatchPendingClear(c.input).clearInventoryWatchPending === false,
      `the old ungated rule cleared "${c.name}" — the referee must keep the watch`
    );
  }
  ok(
    divergences >= 5,
    `expected the old rule to disagree on at least 5 guarded cases, saw ${divergences}`
  );
}

// ---------------------------------------------------------------------------
// TABLE 4 — the OTHER caller is unchanged. `reduceStaleStateForInbound` now delegates to the
// referee; with no parser signal its answers must match the referee exactly, so the two write
// sites cannot drift apart again.
// ---------------------------------------------------------------------------
for (const c of [...KEEP_CASES, ...CLEAR_CASES]) {
  if (c.input.parserRequestedClear) continue; // that caller has no parser signal to pass
  const outer = reduceStaleStateForInbound({
    followUpMode: c.input.followUpMode,
    followUpReason: c.input.followUpReason,
    dialogState: c.input.dialogState,
    hasInventoryWatchPending: c.input.hasInventoryWatchPending,
    inventoryWatchPendingAgeHours: c.input.inventoryWatchPendingAgeHours,
    hasWatchIntent: c.input.hasWatchIntent,
    hasFinanceIntent: c.input.hasFinanceIntent,
    hasSchedulingIntent: c.input.hasSchedulingIntent,
    hasDepartmentIntent: c.input.hasDepartmentIntent
  });
  ok(
    outer.clearInventoryWatchPending === c.clear,
    `reduceStaleStateForInbound disagreed with the referee on "${c.name}"`
  );
}

// ---------------------------------------------------------------------------
// TABLE 5 — THE WRITE ITSELF. The rule tables above only prove the referee is right; this
// proves the field actually obeys it. `applyInventoryWatchPendingClear` is the one function
// that drops `conv.inventoryWatchPending`, so a write site that stops asking it — or an
// apply* that stops asking the referee — fails here on the conversation object, not on a
// static scan. (The contention analyzer alone cannot carry this: its 40-line lookback still
// sees a nearby referee call when the write next to it is re-inlined.)
// ---------------------------------------------------------------------------
{
  const makeConv = (mode: string, reason: string) => ({
    id: "c1",
    followUp: { mode, reason },
    inventoryWatchPending: { askedAt: new Date(Date.now() - 36e5).toISOString(), model: "Road Glide" }
  });

  // The lead is parked on inventory and asks one service question: the watch SURVIVES.
  const parked = makeConv("holding_inventory", "none");
  const parkedResult = applyInventoryWatchPendingClear(parked, {
    followUpMode: parked.followUp.mode,
    followUpReason: parked.followUp.reason,
    dialogState: "inventory_watch_prompted",
    hasDepartmentIntent: true
  });
  ok(!parkedResult.cleared, "a holding_inventory lead must keep its pending watch");
  ok(!!parked.inventoryWatchPending, "the pending watch must still be on the conversation");

  // Same turn, but the lead is not parked: the watch clears, as both writers always agreed.
  const shifted = makeConv("active", "none");
  const shiftedResult = applyInventoryWatchPendingClear(shifted, {
    followUpMode: shifted.followUp.mode,
    followUpReason: shifted.followUp.reason,
    dialogState: "inventory_watch_prompted",
    hasDepartmentIntent: true
  });
  ok(shiftedResult.cleared, "a plain department shift must still clear the pending watch");
  ok(!shifted.inventoryWatchPending, "the pending watch must be gone from the conversation");
  ok(shiftedResult.clearPrompt, "and the prompt must fall back to none");

  // The customer asks about the watch in the same breath: it SURVIVES.
  const alsoAsking = makeConv("active", "none");
  applyInventoryWatchPendingClear(alsoAsking, {
    followUpMode: alsoAsking.followUp.mode,
    followUpReason: alsoAsking.followUp.reason,
    dialogState: "inventory_watch_prompted",
    hasDepartmentIntent: true,
    hasWatchIntent: true
  });
  ok(
    !!alsoAsking.inventoryWatchPending,
    "a same-turn watch question must not let a department mention drop the watch"
  );

  // Age is read off the conversation, not passed in: a 30h-old prompt expires on a quiet turn.
  const stale = {
    id: "c2",
    followUp: { mode: "active", reason: "none" },
    inventoryWatchPending: { askedAt: new Date(Date.now() - 30 * 36e5).toISOString() }
  };
  applyInventoryWatchPendingClear(stale, {
    followUpMode: stale.followUp.mode,
    followUpReason: stale.followUp.reason,
    dialogState: "none"
  });
  ok(!stale.inventoryWatchPending, "a 30h-old pending prompt must expire");
}

// ---------------------------------------------------------------------------
// TABLE 6 — THE TWO LANE ADAPTERS. index.ts calls these, not the writer directly, so a bad
// mapping here would reintroduce the bug with the referee still innocent. The conversation-state
// lane is the one that used to read the RAW departmentIntent with no guards.
// ---------------------------------------------------------------------------
{
  const conv = (mode: string, reason: string) => ({
    id: "c3",
    followUp: { mode, reason },
    inventoryWatchPending: { askedAt: new Date(Date.now() - 36e5).toISOString() }
  });

  // Parser lane: department intent on a PARKED lead must not clear.
  const parked = conv("holding_inventory", "none");
  applyInventoryWatchPendingClearForStateParse(
    parked,
    { stateIntent: "service_request", departmentIntent: "service", clearInventoryWatchPending: false },
    "inventory_watch_prompted"
  );
  ok(!!parked.inventoryWatchPending, "state-parse lane: a parked lead keeps its watch");

  // Parser lane: `inventory_watch` stateIntent must register as watch intent.
  const asking = conv("active", "none");
  applyInventoryWatchPendingClearForStateParse(
    asking,
    { stateIntent: "inventory_watch", departmentIntent: "parts", clearInventoryWatchPending: true },
    "inventory_watch_prompted"
  );
  ok(
    !!asking.inventoryWatchPending,
    "state-parse lane: stateIntent inventory_watch must count as watch intent"
  );

  // Parser lane: the ordinary shift still clears.
  const shifting = conv("active", "none");
  applyInventoryWatchPendingClearForStateParse(
    shifting,
    { stateIntent: "service_request", departmentIntent: "service", clearInventoryWatchPending: false },
    "inventory_watch_prompted"
  );
  ok(!shifting.inventoryWatchPending, "state-parse lane: a plain department shift still clears");

  // Hint lane: the same two rulings.
  const hintParked = conv("holding_inventory", "none");
  applyInventoryWatchPendingClearForIntentHints(hintParked, "inventory_watch_prompted", {
    hasDepartmentIntent: true
  });
  ok(!!hintParked.inventoryWatchPending, "hint lane: a parked lead keeps its watch");

  const hintShift = conv("active", "none");
  const hintResult = applyInventoryWatchPendingClearForIntentHints(
    hintShift,
    "inventory_watch_prompted",
    { hasDepartmentIntent: true }
  );
  ok(!hintShift.inventoryWatchPending, "hint lane: a plain department shift still clears");
  ok(hintResult.cleared, "hint lane reports the clear back to its caller's `changed` flag");
}

// ---------------------------------------------------------------------------
// WIRING: no unrefereed writer of `inventoryWatchPending` may survive.
// ---------------------------------------------------------------------------
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve("services/api/src");
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (entry.name.endsWith(".ts")) {
        files.push({ path: path.relative(process.cwd(), full), text: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(root);
  const ranked = rankContention(files, { minWrites: 1 });
  const entry = ranked.find(f => f.field === "inventoryWatchPending");
  ok(
    (entry?.writeSites ?? []).length > 0,
    "the analyzer must still see inventoryWatchPending writes at all — a zero count would make this vacuous"
  );
  ok(
    (entry?.unrefereedWriterSites ?? []).length === 0,
    "every inventoryWatchPending writer must ask a referee — unrefereed: " +
      (entry?.unrefereedWriterSites ?? []).map(s => `${s.file}:${s.line}`).join(", ")
  );
}

// ---------------------------------------------------------------------------
// The referee must be REGISTERED, or the next un-stacking ships with no equivalence evidence.
// ---------------------------------------------------------------------------
{
  const { buildDecisionRegistry } = await import("../services/api/src/domain/decisionFingerprint.ts");
  const reducer = await import("../services/api/src/domain/routeStateReducer.ts");
  const registry = buildDecisionRegistry(reducer as any);
  ok(
    registry.some(e => (e.covers ?? []).includes("resolveInventoryWatchPendingClear")),
    "resolveInventoryWatchPendingClear must be sampled in buildDecisionRegistry"
  );
  ok(
    registry.filter(e => e.name.startsWith("inventoryWatchPendingClear:")).length >= 6,
    "each decisive state — the keep-guards, the shift, the parser signal — must be sampled separately"
  );
}

console.log(`inventory_watch_pending_clear:eval OK (${checks} checks)`);
