/**
 * inventory_watch_arm:eval — the ARM referee for an inventory watch.
 *
 * SIX places used to answer "a watch is being set on this lead; what does the conversation record
 * look like afterwards?" on their own, each carrying its own copy of the same block across THREE
 * Tier-2 fields (`inventoryWatches`, `inventoryWatch`, `inventoryWatchPending`) plus the dialog
 * state / follow-up mode / chase aftermath. They now all ask `decideInventoryWatchArm` and write
 * through `applyInventoryWatchArm`.
 *
 * The un-stacking is BEHAVIOR-PRESERVING, and the load-bearing section below is what proves it:
 * the six ORIGINAL inline rules are re-encoded here as a lookup table and the referee must match
 * every one. `decision_equivalence` cannot carry that proof — a brand-new referee has no baseline.
 *
 * TWO DIVERGENCES are preserved on purpose and pinned here so a future "tidy-up" cannot erase them:
 *   1. `console_hold_resolution` sets NO dialog state at all.
 *   2. `email_inbound` writes `conv.dialogState` DIRECTLY, so `setDialogState`'s side effects —
 *      above all `clearInventoryWatchOptOut` — never run. A lead who once opted out of watch
 *      alerts and later re-subscribes by email gets a watch that `isInventoryWatchOptedOut` keeps
 *      silent forever. ZERO leads carry that flag today (802 conversations, 89 with a watch), so
 *      this is a PORTABILITY defect; the fix is its own PR.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const {
  decideInventoryWatchArm
} = await import("../services/api/src/domain/routeStateReducer.ts");
const { rankContention } = await import("../services/api/src/domain/stateWriterContention.ts");

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks += 1;
};

// ---------------------------------------------------------------------------
// LOAD-BEARING: the six ORIGINAL inline rules, re-encoded as a table.
// ---------------------------------------------------------------------------
type Lane =
  | "voice_summary"
  | "context_note"
  | "watch_confirmation"
  | "console_watch_set"
  | "console_hold_resolution"
  | "held_unit_guard"
  | "manual_outbound"
  | "email_inbound"
  | "email_walk_in"
  | "email_adf_unavailable";

const ORIGINAL: Record<
  Lane,
  {
    /** What the inline block did about the dialog state, read off the pre-un-stacking source. */
    dialogRoute: "helper" | "direct" | "none";
    clearsPending: boolean;
    followUpMode: "holding_inventory";
    stopsChase: boolean;
  }
> = {
  // index.ts voice-summary watch: setDialogState(conv, "inventory_watch_active")
  voice_summary: { dialogRoute: "helper", clearsPending: true, followUpMode: "holding_inventory", stopsChase: true },
  // index.ts staff context note: setDialogState(...)
  context_note: { dialogRoute: "helper", clearsPending: true, followUpMode: "holding_inventory", stopsChase: true },
  // index.ts applyInventoryWatchConfirmation (the shared choke point): setDialogState(...)
  watch_confirmation: { dialogRoute: "helper", clearsPending: true, followUpMode: "holding_inventory", stopsChase: true },
  // index.ts manual-outbound watch: setDialogState(...)
  manual_outbound: { dialogRoute: "helper", clearsPending: true, followUpMode: "holding_inventory", stopsChase: true },
  // index.ts console watch-set endpoint: setDialogState(...), just written LAST rather than first.
  console_watch_set: { dialogRoute: "helper", clearsPending: true, followUpMode: "holding_inventory", stopsChase: true },
  // index.ts console hold-resolution endpoint: NO dialog-state line at all. Divergence 1.
  console_hold_resolution: { dialogRoute: "none", clearsPending: true, followUpMode: "holding_inventory", stopsChase: true },
  // index.ts held-unit auto-guard: no dialog-state line either, and deliberately so.
  held_unit_guard: { dialogRoute: "none", clearsPending: true, followUpMode: "holding_inventory", stopsChase: true },
  // sendgridInbound.ts: conv.dialogState = { name: "inventory_watch_active", updatedAt: nowIso }.
  // Divergence 2 — the helper's opt-out reversal and lastIntent stamp never run.
  email_inbound: { dialogRoute: "direct", clearsPending: true, followUpMode: "holding_inventory", stopsChase: true },
  // sendgridInbound.ts walk-in arm: the same direct write, same divergence.
  email_walk_in: { dialogRoute: "direct", clearsPending: true, followUpMode: "holding_inventory", stopsChase: true },
  // sendgridInbound.ts initial-ADF unavailable arm: the same direct write again.
  email_adf_unavailable: { dialogRoute: "direct", clearsPending: true, followUpMode: "holding_inventory", stopsChase: true }
};

for (const lane of Object.keys(ORIGINAL) as Lane[]) {
  const want = ORIGINAL[lane];
  const got = decideInventoryWatchArm({ lane, watchCount: 1 });
  ok(got.arm === true, `${lane}: a supplied watch must arm`);
  ok(got.dialogRoute === want.dialogRoute, `${lane}: dialog route must stay ${want.dialogRoute}, got ${got.dialogRoute}`);
  ok(got.clearPending === want.clearsPending, `${lane}: the pending ask must ${want.clearsPending ? "" : "not "}clear`);
  ok(got.followUpMode === want.followUpMode, `${lane}: follow-up mode must stay ${want.followUpMode}`);
  ok(got.followUpModeReason === "inventory_watch", `${lane}: the mode reason must stay "inventory_watch"`);
  ok(got.stopCadenceReason === "inventory_watch", `${lane}: the chase must stop with reason "inventory_watch"`);
  ok(
    got.dialogState === (want.dialogRoute === "none" ? null : "inventory_watch_active"),
    `${lane}: dialog state must be ${want.dialogRoute === "none" ? "null" : "inventory_watch_active"}`
  );
  // The opt-out reversal is a SIDE EFFECT of the shared helper and of nothing else.
  ok(
    got.reversesWatchOptOut === (want.dialogRoute === "helper"),
    `${lane}: only the shared setDialogState route may reverse a durable watch opt-out`
  );
}

// The two divergences must stay NAMED, not merely present.
ok(
  decideInventoryWatchArm({ lane: "console_hold_resolution", watchCount: 1 }).divergence ===
    "two_console_lanes_disagree_on_whether_arming_a_watch_enters_the_active_dialog_state",
  "divergence 1 must be named on the decision"
);
// The held-unit auto-guard skips the dialog state BY DESIGN — it must not be filed as a divergence,
// or the fix PR would "repair" the one lane that is deliberately silent.
ok(
  decideInventoryWatchArm({ lane: "held_unit_guard", watchCount: 1 }).divergence === null,
  "the held-unit auto-guard's silence is intentional and must not read as a divergence"
);
ok(
  decideInventoryWatchArm({ lane: "held_unit_guard", watchCount: 1 }).reversesWatchOptOut === false,
  "the held-unit auto-guard must never reverse a durable watch opt-out — that is what makes it durable"
);
for (const lane of ["email_inbound", "email_walk_in", "email_adf_unavailable"] as const) {
  ok(
    decideInventoryWatchArm({ lane, watchCount: 1 }).divergence ===
      "email_lane_writes_the_dialog_state_directly_so_a_durable_watch_opt_out_survives",
    `divergence 2 must be named on the ${lane} decision`
  );
}
for (const lane of [
  "voice_summary",
  "context_note",
  "watch_confirmation",
  "manual_outbound",
  "console_watch_set"
] as const) {
  ok(decideInventoryWatchArm({ lane, watchCount: 1 }).divergence === null, `${lane}: must carry no divergence`);
}

// ---------------------------------------------------------------------------
// SHAPE: junk and empty inputs must fail toward NOT arming.
// ---------------------------------------------------------------------------
for (const watchCount of [0, -1, Number.NaN] as const) {
  const got = decideInventoryWatchArm({ lane: "voice_summary", watchCount });
  ok(got.arm === false, `watchCount ${String(watchCount)}: must not arm`);
  ok(got.clearPending === false, `watchCount ${String(watchCount)}: must not clear the pending ask`);
  ok(got.dialogRoute === "none", `watchCount ${String(watchCount)}: must not touch the dialog state`);
}
ok(
  decideInventoryWatchArm({ lane: "voice_summary", watchCount: undefined as unknown as number }).arm === false,
  "a missing watchCount must not arm"
);

// ---------------------------------------------------------------------------
// LOAD-BEARING: no unrefereed writer may ARM a watch any more.
//
// Asks the contention analyzer directly rather than leaning on the ratchet TOTAL, which can cancel
// a +1 against a -1 and report green on a genuine re-stacking (measured twice: PRs #462 and #484).
// The ARM SIGNATURE is all three watch fields set within one short window — that is precisely the
// block this un-stacking removed, and it is what a re-stacking would look like.
// ---------------------------------------------------------------------------
const ROOT = path.resolve("services/api/src");
const sources: { path: string; text: string }[] = [];
const walk = (dir: string): void => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full);
    } else if (entry.name.endsWith(".ts")) {
      sources.push({ path: path.relative(process.cwd(), full), text: fs.readFileSync(full, "utf8") });
    }
  }
};
assert.ok(fs.existsSync(ROOT), `inventory_watch_arm: ${ROOT} not found — the scan is broken`);
walk(ROOT);
assert.ok(sources.length > 50, `inventory_watch_arm: only ${sources.length} file(s) scanned — that is not the real tree`);

// The ARM SIGNATURE, read per LINE so a prune (`= remaining.length ? remaining : undefined`) and a
// clear (`= undefined`) are not mistaken for it: a real value assigned to BOTH the plural list and
// the singular mirror, plus the pending ask cleared, all inside a 4-line window.
const armsValue = (line: string, field: "inventoryWatches" | "inventoryWatch"): boolean => {
  const m = new RegExp(`\\.${field}\\s*=\\s*(.+)$`).exec(line);
  return !!m && !/\bundefined\b/.test(m[1]);
};
const WINDOW = 4;
const armOffenders: string[] = [];
for (const source of sources) {
  const lines = source.text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!/\.inventoryWatchPending\s*=\s*undefined/.test(lines[i])) continue;
    const from = Math.max(0, i - WINDOW);
    const window = lines.slice(from, Math.min(lines.length, i + WINDOW + 1));
    if (window.some(l => armsValue(l, "inventoryWatches")) && window.some(l => armsValue(l, "inventoryWatch"))) {
      armOffenders.push(`${source.path}:${i + 1}`);
    }
  }
}
// Exactly ONE arm block may exist tree-wide, and it is the applier's.
ok(
  armOffenders.length === 1 && armOffenders[0].startsWith("services/api/src/domain/conversationStore.ts:"),
  `the ONLY place that may ARM a watch (both watch fields set to a real value + the pending ask ` +
    `cleared) is applyInventoryWatchArm in conversationStore.ts — found: ${armOffenders.join(", ")}`
);
// …and the contention analyzer must agree that block is refereed.
const ranked = rankContention(
  sources.map(s => ({ path: s.path, text: s.text })),
  { minWrites: 1 }
);
for (const field of ["inventoryWatch", "inventoryWatches", "inventoryWatchPending"] as const) {
  const entry = ranked.find(f => f.field === field);
  const offending = (entry?.unrefereedWriterSites ?? []).filter(
    site => site.file.endsWith("conversationStore.ts") && Math.abs(site.line - Number(armOffenders[0].split(":")[1])) <= WINDOW
  );
  ok(offending.length === 0, `${field}: the applier's own arm write must read as REFEREED, not as a fresh fight`);
}

// ---------------------------------------------------------------------------
// The referee must be REGISTERED, or the next un-stacking ships with no evidence for it.
// ---------------------------------------------------------------------------
{
  const { buildDecisionRegistry } = await import("../services/api/src/domain/decisionFingerprint.ts");
  const reducer = await import("../services/api/src/domain/routeStateReducer.ts");
  const registry = buildDecisionRegistry(reducer as any);
  const covered = registry.some(entry => (entry.covers ?? []).includes("decideInventoryWatchArm"));
  ok(covered, "decideInventoryWatchArm must be sampled in buildDecisionRegistry");
  const lanesSampled = registry.filter(entry => entry.name.startsWith("inventoryWatchArm:")).length;
  ok(lanesSampled === 10, `all ten arm lanes must be sampled separately, found ${lanesSampled}`);
}

console.log(`inventory_watch_arm:eval OK (${checks} checks)`);
