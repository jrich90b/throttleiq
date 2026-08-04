/**
 * inventory_watch_disarm:eval — the DISARM referee for an inventory watch.
 *
 * The inverse of `inventory_watch_arm:eval`. FOUR places used to answer "a watch is coming OFF this
 * lead; what does the record look like afterwards?" on their own, each with its own copy of the
 * same three-field block: the customer's stop request, our own held-unit heal, and the two worker
 * repair endpoints (model prune, VIN normalize). They now all ask `decideInventoryWatchDisarm` and
 * write through `applyInventoryWatchDisarm`.
 *
 * The un-stacking is BEHAVIOR-PRESERVING and the load-bearing table below is what proves it: the
 * four ORIGINAL inline rules are re-encoded here and the referee must match every one.
 * `decision_equivalence` cannot carry that proof — a brand-new referee has no baseline.
 *
 * THREE DIVERGENCES preserved on purpose and pinned here so a future tidy-up cannot erase them:
 *   D1 — when nothing survives, the heal writes `undefined` and the repairs write the empty array
 *        they computed. 1 lead carries an empty array today; the only reader that treats `[]` as
 *        "has a watch" is a Langfuse telemetry field, so this costs a wrong flag in a trace.
 *   D2 — `inventoryWatchPending` ("waiting to hear WHICH bike"): customer_stop always clears it,
 *        the heal only when nothing survives, the repairs never. 3 leads carry the flag with no
 *        watch at all today.
 *   D3 — the mirror, between the two sibling repair endpoints: `model_prune` repoints only when the
 *        mirror was itself pruned; `vin_normalize` re-derives it from the cleaned model every run.
 *
 * NOT a divergence, pinned as such: the three different aftermaths. customer_stop parks the lead
 * and stops the chase, the heal deliberately does the opposite (its caller resumes), and a repair
 * touches neither. Flattening those into one answer would be the bug.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { decideInventoryWatchDisarm } = await import("../services/api/src/domain/routeStateReducer.ts");
const { rankContention } = await import("../services/api/src/domain/stateWriterContention.ts");

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks += 1;
};

// ---------------------------------------------------------------------------
// LOAD-BEARING: the four ORIGINAL inline rules, re-encoded as a table.
//
// Each row was read off the pre-un-stacking source:
//   customer_stop   (clearInventoryWatchState)      — all three fields undefined, park, stop, step back
//   held_guard_heal (applyStaleHeldUnitWatchHeal)   — collapse to undefined when empty, pending only then
//   model_prune     (/internal/worker/watch-prune)  — store `kept` as-is, mirror only if pruned
//   vin_normalize   (/internal/worker/watch-normalize-vin) — store `next`, re-derive the mirror
// ---------------------------------------------------------------------------
type Lane = "customer_stop" | "held_guard_heal" | "model_prune" | "vin_normalize";

const ORIGINAL: Record<
  Lane,
  {
    emptyListShape: "empty_array" | "undefined";
    mirrorRule: "first" | "only_if_pruned" | "caller_picks";
    /** Does this lane clear the pending ask when watches SURVIVE / when NONE survive? */
    clearsPendingWhenSurvivors: boolean;
    clearsPendingWhenEmpty: boolean;
    parksLead: boolean;
    stopsChase: boolean;
    stepsDialogBack: boolean;
  }
> = {
  customer_stop: {
    emptyListShape: "undefined",
    mirrorRule: "first",
    clearsPendingWhenSurvivors: true,
    clearsPendingWhenEmpty: true,
    parksLead: true,
    stopsChase: true,
    stepsDialogBack: true
  },
  held_guard_heal: {
    emptyListShape: "undefined",
    mirrorRule: "first",
    // The original was literally `if (!remaining.length) conv.inventoryWatchPending = undefined;`
    clearsPendingWhenSurvivors: false,
    clearsPendingWhenEmpty: true,
    parksLead: false,
    stopsChase: false,
    stepsDialogBack: false
  },
  model_prune: {
    emptyListShape: "empty_array",
    mirrorRule: "only_if_pruned",
    clearsPendingWhenSurvivors: false,
    clearsPendingWhenEmpty: false,
    parksLead: false,
    stopsChase: false,
    stepsDialogBack: false
  },
  vin_normalize: {
    emptyListShape: "empty_array",
    mirrorRule: "caller_picks",
    clearsPendingWhenSurvivors: false,
    clearsPendingWhenEmpty: false,
    parksLead: false,
    stopsChase: false,
    stepsDialogBack: false
  }
};

for (const [lane, original] of Object.entries(ORIGINAL) as [Lane, (typeof ORIGINAL)[Lane]][]) {
  // Enumerate BOTH sides of every "when empty" rule, plus a middle value. Impossible-looking
  // combinations are where a referee's SHAPE goes wrong, as opposed to its rules (see #468).
  for (const remainingCount of [0, 1, 3]) {
    const d = decideInventoryWatchDisarm({ lane, remainingCount });
    const expectPending =
      remainingCount === 0 ? original.clearsPendingWhenEmpty : original.clearsPendingWhenSurvivors;
    ok(
      d.emptyListShape === original.emptyListShape,
      `${lane}@${remainingCount}: empty-list shape must stay ${original.emptyListShape}, got ${d.emptyListShape}`
    );
    ok(
      d.mirrorRule === original.mirrorRule,
      `${lane}@${remainingCount}: mirror rule must stay ${original.mirrorRule}, got ${d.mirrorRule}`
    );
    ok(
      d.clearPending === expectPending,
      `${lane}@${remainingCount}: clearPending must be ${expectPending}, got ${d.clearPending}`
    );
    ok(
      (d.followUpMode === "paused_indefinite") === original.parksLead,
      `${lane}@${remainingCount}: parking the lead must stay ${original.parksLead}`
    );
    ok(
      d.stopCadence === original.stopsChase,
      `${lane}@${remainingCount}: stopping the chase must stay ${original.stopsChase}`
    );
    ok(
      d.stepDialogBack === original.stepsDialogBack,
      `${lane}@${remainingCount}: stepping the dialog back must stay ${original.stepsDialogBack}`
    );
    ok(typeof d.why === "string" && d.why.includes(lane), `${lane}@${remainingCount}: why must name the lane`);
  }
}

// JUNK INPUT targets the referee's SHAPE, not its rules (the technique that caught a
// "mute everyone on their first invite" default in #493). A missing or nonsense count must not
// silently become "everything survives" — it must read as empty, the conservative answer.
for (const junk of [undefined, null, Number.NaN, -5, "3"] as unknown[]) {
  const d = decideInventoryWatchDisarm({ lane: "held_guard_heal", remainingCount: junk as number });
  ok(
    typeof d.clearPending === "boolean" && d.emptyListShape === "undefined",
    `junk remainingCount ${String(junk)} must still produce a well-formed decision`
  );
}
ok(
  decideInventoryWatchDisarm({ lane: "held_guard_heal", remainingCount: Number.NaN }).clearPending === true,
  "an uncountable survivor list reads as EMPTY (clears the pending ask), never as 'watches survive'"
);

// D1/D2/D3 must remain VISIBLE on the decision — a divergence nobody names is one the next reader
// silently "fixes".
ok(
  decideInventoryWatchDisarm({ lane: "model_prune", remainingCount: 0 }).divergence ===
    "model_prune_stores_an_empty_array_and_leaves_the_pending_flag_standing",
  "D1+D2 must stay named on the model_prune decision when nothing survives"
);
ok(
  decideInventoryWatchDisarm({ lane: "vin_normalize", remainingCount: 2 }).divergence ===
    "vin_normalize_rederives_the_mirror_where_its_sibling_repair_leaves_a_survivor_alone",
  "D3 must stay named on the vin_normalize decision"
);
ok(
  decideInventoryWatchDisarm({ lane: "customer_stop", remainingCount: 0 }).divergence === null &&
    decideInventoryWatchDisarm({ lane: "held_guard_heal", remainingCount: 0 }).divergence === null,
  "the customer and heal lanes agree with each other — naming a divergence there would be false"
);

// ---------------------------------------------------------------------------
// LOAD-BEARING: no unrefereed writer may DISARM a watch any more.
//
// Asks the contention analyzer directly rather than leaning on the ratchet TOTAL, which can cancel
// a +1 against a -1 and report green on a genuine re-stacking (measured on #462 and #484).
//
// The DISARM SIGNATURE is the plural list and the singular mirror written in the same short window
// where at least one of them is being emptied or replaced wholesale — precisely the block this
// un-stacking removed. Read per LINE, because a block-level regex mistakes a prune for a clear.
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
assert.ok(fs.existsSync(ROOT), `inventory_watch_disarm: ${ROOT} not found — the scan is broken`);
walk(ROOT);
assert.ok(
  sources.length > 50,
  `inventory_watch_disarm: only ${sources.length} file(s) scanned — that is not the real tree`
);

const WINDOW = 5;
const writesField = (line: string, field: "inventoryWatches" | "inventoryWatch"): boolean =>
  new RegExp(`\\.${field}\\s*=[^=]`).test(line);
const disarmOffenders: string[] = [];
for (const source of sources) {
  const lines = source.text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!writesField(lines[i], "inventoryWatches")) continue;
    const window = lines.slice(Math.max(0, i - WINDOW), Math.min(lines.length, i + WINDOW + 1));
    if (!window.some(l => writesField(l, "inventoryWatch"))) continue;
    disarmOffenders.push(`${source.path}:${i + 1}`);
  }
}
// Exactly ONE such block may exist tree-wide, and it is the applier's. (The ARM applier writes both
// fields too, so its own block is the second permitted one — both live in conversationStore.ts.)
ok(
  disarmOffenders.length > 0 && disarmOffenders.every(o => o.startsWith("services/api/src/domain/conversationStore.ts:")),
  `the ONLY places that may write both watch-list fields together are the arm/disarm appliers in ` +
    `conversationStore.ts — found: ${disarmOffenders.join(", ")}`
);

// …and the contention analyzer must agree the applier's own writes read as refereed.
const ranked = rankContention(
  sources.map(s => ({ path: s.path, text: s.text })),
  { minWrites: 1 }
);
for (const field of ["inventoryWatch", "inventoryWatches"] as const) {
  const entry = ranked.find(f => f.field === field);
  const offending = (entry?.unrefereedWriterSites ?? []).filter(site =>
    site.file.endsWith("conversationStore.ts")
  );
  ok(
    offending.length === 0,
    `${field}: the appliers' own writes must read as REFEREED, not as a fresh fight — ` +
      offending.map(s => `${s.file}:${s.line}`).join(", ")
  );
}

// ---------------------------------------------------------------------------
// The referee must be REGISTERED, or the next un-stacking ships with no evidence for it.
// ---------------------------------------------------------------------------
{
  const { buildDecisionRegistry } = await import("../services/api/src/domain/decisionFingerprint.ts");
  const reducer = await import("../services/api/src/domain/routeStateReducer.ts");
  const registry = buildDecisionRegistry(reducer as any);
  ok(
    registry.some(entry => (entry.covers ?? []).includes("decideInventoryWatchDisarm")),
    "decideInventoryWatchDisarm must be sampled in buildDecisionRegistry"
  );
  const lanesSampled = registry.filter(entry => entry.name.startsWith("inventoryWatchDisarm:")).length;
  ok(lanesSampled === 4, `all four disarm lanes must be sampled separately, found ${lanesSampled}`);
}

console.log(`inventory_watch_disarm:eval OK (${checks} checks)`);
