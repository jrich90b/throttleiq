/**
 * state_writer_contention:eval — pins the un-stacking queue's detector.
 *
 * Joe, 2026-08-01: "I want to untangle these as we go along. We need to clean it up so they aren't
 * fighting each other." This detector ranks WHAT to un-stack next; the daily anomaly review works
 * the top item, one per run.
 *
 * The detector is only useful if it is honest, and the first two cuts were not:
 *  - cut 1 called a field "refereed" when ANY domain function merely NAMED it, and duly reported
 *    that `followUpCadence` had nine referees. PR #398 is proof it had none.
 *  - cut 2 counted raw writes, making `conv.appointment` a 298-alarm when most of those are
 *    consecutive property sets inside one owning function that cannot fight itself.
 * Both failure modes produce a number nobody can act on. These rows exist to keep them dead.
 */
import assert from "node:assert/strict";
import {
  countWriters,
  findWriteSites,
  isWriteGuarded,
  rankContention,
  unstackingQueue,
  WRITER_CLUSTER_GAP_LINES,
  type SourceFile
} from "../services/api/src/domain/stateWriterContention.ts";

const file = (path: string, text: string): SourceFile => ({ path, text });

// --- write-site detection ---
{
  const sites = findWriteSites([
    file(
      "a.ts",
      [
        'conv.followUpCadence = { status: "active" };', // 1 wholesale
        "conv.followUpCadence.kind = \"long_term\";", // 2 property
        "(conv as any).humanCorrection = { at: now };", // 3 the `as any` form
        "conversation.dialogState = next;", // 4 the other root
        "if (conv.followUpCadence === prior) return;", // NOT a write (==)
        "const f = (conv) => conv.followUpCadence;", // NOT a write (=>)
        "// conv.followUpCadence = {} in a comment", // NOT a write (comment)
        "if (conv.status >= 3) return;" // NOT a write (>=)
      ].join("\n")
    )
  ]);
  assert.equal(sites.get("followUpCadence")?.length, 2, "counts both the wholesale and property write, and nothing else");
  assert.equal(sites.get("humanCorrection")?.length, 1, "the `(conv as any).field =` form is a write");
  assert.equal(sites.get("dialogState")?.length, 1, "`conversation.` is a tracked root");
  assert.equal(sites.get("status"), undefined, "`>=` is not an assignment");
  assert.equal(sites.get("followUpCadence")?.[0].wholesale, true, "a `= {` line is a wholesale replacement");
  assert.equal(sites.get("followUpCadence")?.[1].wholesale, false, "a property poke is not wholesale");
}

// A local named `c` must NOT be treated as conversation state — it matched everything and inflated
// `appointment` to a meaningless 298 on the first run.
{
  const sites = findWriteSites([file("b.ts", "for (const c of rows) { c.appointment = null; }")]);
  assert.equal(sites.get("appointment"), undefined, "`c.` is not a tracked state root (over-counting guard)");
}

// Bookkeeping stamps every writer legitimately touches must not read as contention.
{
  const sites = findWriteSites([file("c.ts", "conv.updatedAt = nowIso();\nconv.createdAt = nowIso();")]);
  assert.equal(sites.size, 0, "updatedAt/createdAt are ignored — they are written everywhere by design");
}

// --- guarded vs unguarded: the cut-1 failure mode ---
{
  const lines = ["const d = decideFinanceDeclinedCadence({});", "conv.followUpCadence = {};"];
  assert.equal(isWriteGuarded(lines, 1), true, "a write right after a decide* call is refereed");
}
{
  const lines = ["const x = 1;", "conv.followUpCadence = {};"];
  assert.equal(isWriteGuarded(lines, 1), false, "a write with no decision above it is NOT refereed");
}
{
  // Out of range: a decision 41 lines up does not govern this write.
  const lines = ["const d = decideThing();", ...Array(41).fill("noop();"), "conv.followUpCadence = {};"];
  assert.equal(isWriteGuarded(lines, lines.length - 1), false, "the lookback window is bounded");
}
{
  // `should*` / `is*` must NOT count — they are predicates used everywhere, and accepting them is
  // exactly how cut 1 concluded that everything was already refereed.
  const lines = ["if (shouldSuppressThing(conv)) return;", "conv.followUpCadence = {};"];
  assert.equal(isWriteGuarded(lines, 1), false, "should*/is* predicates are not referees");
}

// --- writer clustering: the cut-2 failure mode ---
{
  const sites = [
    { file: "a.ts", line: 10, snippet: "", wholesale: false, guarded: false },
    { file: "a.ts", line: 11, snippet: "", wholesale: false, guarded: false },
    { file: "a.ts", line: 12, snippet: "", wholesale: false, guarded: false },
    { file: "a.ts", line: 400, snippet: "", wholesale: false, guarded: false },
    { file: "b.ts", line: 11, snippet: "", wholesale: false, guarded: false }
  ];
  const writers = countWriters(sites);
  assert.equal(writers.length, 3, "consecutive writes collapse to ONE writer; a far-away one and another file are separate");
  assert.equal(writers[0].line, 10, "the first site of a cluster represents it");
  // Same file, just past the gap => a separate writer.
  const split = countWriters([
    { file: "a.ts", line: 10, snippet: "", wholesale: false, guarded: false },
    { file: "a.ts", line: 10 + WRITER_CLUSTER_GAP_LINES + 1, snippet: "", wholesale: false, guarded: false }
  ]);
  assert.equal(split.length, 2, "writes further apart than the gap are independent writers");
}

// --- ranking + the queue ---
{
  const contended = [
    "conv.thing = 1;",
    ...Array(30).fill("noop();"),
    "conv.thing = 2;",
    ...Array(30).fill("noop();"),
    "conv.thing = 3;",
    ...Array(30).fill("noop();"),
    "conv.thing = 4;"
  ].join("\n");
  const refereed = [
    "const d = decideQuiet(conv);",
    "conv.quiet = 1;",
    ...Array(30).fill("noop();"),
    "const e = decideQuiet(conv);",
    "conv.quiet = 2;",
    ...Array(30).fill("noop();"),
    "const f = decideQuiet(conv);",
    "conv.quiet = 3;",
    ...Array(30).fill("noop();"),
    "const g = decideQuiet(conv);",
    "conv.quiet = 4;"
  ].join("\n");
  const ranked = rankContention([file("x.ts", contended), file("y.ts", refereed)], { minWrites: 4 });
  const thing = ranked.find(f => f.field === "thing");
  const quiet = ranked.find(f => f.field === "quiet");
  assert.ok(thing && quiet, "both fields clear the minWrites floor");
  assert.equal(thing!.unrefereedWriters, 4, "four independent unrefereed writers");
  assert.equal(quiet!.unrefereedWriters, 0, "every write refereed => zero fight surface");
  assert.equal(ranked[0].field, "thing", "worst fight surface ranks first");

  const queue = unstackingQueue(ranked);
  assert.ok(queue.some(f => f.field === "thing"), "the contended field is queued for un-stacking");
  assert.ok(!queue.some(f => f.field === "quiet"), "a fully refereed field is NOT queued");
  // One writer cannot fight anything.
  const single = rankContention([file("z.ts", Array(4).fill("conv.solo = 1;").join("\n"))], { minWrites: 4 });
  assert.equal(unstackingQueue(single).length, 0, "a single clustered writer is not contention");
}

// --- ALIAS WRITES (added 2026-08-01): the biggest blind spot of the first cut ---
// Four of the six appointment teardown sites mutate through `const appt = conv.appointment`, so a
// pattern keyed on `conv.` never saw the cancel path at all.
{
  const sites = findWriteSites([
    file(
      "alias.ts",
      [
        "function cancelIt(conv) {",
        "  const appt = conv.appointment;",
        '  appt.status = "none";',
        "  appt.bookedEventId = null;",
        "}"
      ].join("\n")
    )
  ]);
  const appointment = sites.get("appointment") ?? [];
  assert.equal(appointment.length, 2, "writes through an object alias are attributed to the field");
  assert.equal(appointment[0].viaAlias, "appt", "the alias is recorded for diagnosis");
}
{
  // A SCALAR alias cannot mutate the conversation — `const` forbids reassignment anyway.
  const sites = findWriteSites([
    file("scalar.ts", ["const stockId = conv.lead.stockId;", "let x = 1;", "x = 2;"].join("\n"))
  ]);
  assert.equal(sites.get("lead"), undefined, "a scalar alias is not a write surface");
}
{
  // Re-binding the same name in a later function must not leak the earlier field.
  const sites = findWriteSites([
    file(
      "shadow.ts",
      [
        "function a(conv) {",
        "  const x = conv.appointment;",
        '  x.status = "none";',
        "}",
        "function b(conv) {",
        "  const x = conv.scheduler;",
        '  x.mode = "off";',
        "}"
      ].join("\n")
    )
  ]);
  assert.equal((sites.get("appointment") ?? []).length, 1, "first binding attributed correctly");
  assert.equal((sites.get("scheduler") ?? []).length, 1, "re-bound alias resolves to the NEW field, not the old one");
}

// --- LAZY INIT is not a value write ---
// Every `financeOutcomeNotify` and `crm` "writer" was one of these; counting them was pure noise.
{
  const sites = findWriteSites([
    file("lazy.ts", "(conv as any).financeOutcomeNotify = (conv as any).financeOutcomeNotify ?? {};")
  ]);
  assert.equal(sites.get("financeOutcomeNotify"), undefined, "idempotent `x = x ?? {}` init is not contention");
}

// --- BRANCHES INSIDE ONE FUNCTION ARE ONE WRITER ---
// financeOutcome's three writes are the three arms of one if/else inside
// applyFinanceOutcomeStatusFromSignal — the referee's own implementation. A caller invokes the
// function as a unit, so its branches cannot disagree with each other.
{
  const body = [
    "function applyOutcome(conv, status) {",
    '  if (status === "declined") {',
    "    conv.financeOutcome = { status };",
    ...Array(20).fill("    noop();"),
    '  } else if (status === "needs_info") {',
    "    conv.financeOutcome = { status };",
    ...Array(20).fill("    noop();"),
    "  } else {",
    "    conv.financeOutcome = { status };",
    "  }",
    "}",
    "function somethingElse(conv) {",
    "  conv.financeOutcome = { status: 2 };",
    "}"
  ].join("\n");
  const ranked = rankContention([file("fn.ts", body)], { minWrites: 3 });
  const finance = ranked.find(f => f.field === "financeOutcome")!;
  assert.equal(finance.writes, 4, "all four raw writes are seen");
  assert.equal(
    finance.writers,
    2,
    "three branches of one function collapse to ONE writer; the separate function is the second"
  );
}

console.log("PASS state-writer contention — writer clustering, referee proof, over-count guards, queue ordering");
