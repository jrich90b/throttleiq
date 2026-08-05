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
import fs from "node:fs";
import path from "node:path";
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

// =================================================================================================
// CUT 4 — THE REFEREE ONE LEVEL DOWN.
//
// Every un-stacking so far lands the same way: the referee is a pure `decide*` in
// routeStateReducer.ts, and the call sites do not call it directly — they call a thin `apply*`
// wrapper that asks the referee and then writes. So properly un-stacked call sites still scored
// "decides for itself", i.e. FINISHED WORK read as outstanding work.
//
// The danger here is over-correcting. Accepting any `apply*` would be a disaster, and it is
// measurable: 37 of the unrefereed writes have SOME `apply*` within 40 lines above them, and
// nearly all of those are the enclosing function's own declaration line or an unrelated helper
// (`applyWatchFieldHygiene`, `applyDeterministicToneOverrides`) that arbitrates nothing. So the
// credit carries three proof obligations, and these rows exist to keep each one enforced.
{
  const store = file(
    "store.ts",
    [
      "export function applyCadenceQuietWindow(conv, input) {",
      "  const decision = decideCadenceQuietWindow(input);",
      "  conv.followUpCadence.pausedUntil = input.quietUntilIso;",
      "}"
    ].join("\n")
  );
  // (1) the applier consults a referee AND writes this field => its call site is refereed.
  const caller = file(
    "caller.ts",
    [
      "function handleWatchAlert(conv) {",
      "  applyCadenceQuietWindow(conv, {});",
      '  conv.followUpCadence.pauseReason = "watch";',
      "}"
    ].join("\n")
  );
  const sites = findWriteSites([store, caller]);
  const callSite = sites.get("followUpCadence")!.find(s => s.file === "caller.ts")!;
  assert.equal(callSite.guarded, true, "a write downstream of a referee-consulting applier IS refereed");

  // (2) FIELD SCOPE. The same applier must not vouch for a field it does not arbitrate — the real
  // miss this caught: `maybeStartCadence` calls `applyPendingIncomingInventoryState` (a
  // referee-consulting applier, but for inventory state) fourteen lines above its own hand-built
  // `conv.followUpCadence = {…}`, and that unrefereed cadence writer would have left the queue.
  const otherField = file(
    "other.ts",
    [
      "function maybeStart(conv) {",
      "  applyCadenceQuietWindow(conv, {});",
      '  conv.appointment = { status: "none" };',
      "}"
    ].join("\n")
  );
  const otherSites = findWriteSites([store, otherField]);
  assert.equal(
    otherSites.get("appointment")!.find(s => s.file === "other.ts")!.guarded,
    false,
    "an applier only referees the fields it actually writes — never a neighbouring one"
  );

  // (3) A PLAIN `apply*` IS NOT A REFEREE. Same shape, but the applier arbitrates nothing.
  const dumb = file(
    "dumb.ts",
    ["export function applyFieldHygiene(conv) {", '  conv.followUpCadence.kind = "engaged";', "}"].join("\n")
  );
  const dumbCaller = file(
    "dumbcaller.ts",
    ["function handler(conv) {", "  applyFieldHygiene(conv);", "  conv.followUpCadence.stepIndex = 0;", "}"].join("\n")
  );
  assert.equal(
    findWriteSites([dumb, dumbCaller]).get("followUpCadence")!.find(s => s.file === "dumbcaller.ts")!.guarded,
    false,
    "an apply* that consults no referee cannot vouch for anyone — the false-comfort guard"
  );

  // (4) A DECLARATION IS NOT A CALL. `export function applyCadenceQuietWindow(` matches the same
  // name pattern as a call to it, so without this an applier's own signature line would vouch for
  // every write in its body — INCLUDING one that runs BEFORE the arbitration, which is precisely
  // an unrefereed write. That write must stay counted.
  const preArbitration = file(
    "pre.ts",
    [
      "export function applyCadenceQuietWindow(conv, input) {",
      "  conv.followUpCadence.stepIndex = 0;",
      "  const decision = decideCadenceQuietWindow(input);",
      "  conv.followUpCadence.pausedUntil = input.quietUntilIso;",
      "}"
    ].join("\n")
  );
  const pre = findWriteSites([preArbitration]).get("followUpCadence")!;
  assert.equal(
    pre[0].guarded,
    false,
    "a write ABOVE the referee call is not refereed by the applier's own signature line"
  );
  assert.equal(pre[1].guarded, true, "the write below the referee call is refereed");
}

// ALIAS SCOPE — a local binding cannot reach into another function.
//
// The "most recent preceding binding in the file" rule leaked across function boundaries, so the
// `const existing = conv.followUpCadence` inside `applyManualCadenceRestart` was still the live
// binding 1,200 lines later, and `addTodo`'s unrelated `existing.reason = reason` (a TODO, not a
// cadence) scored as a competing writer of the follow-up cadence. Names like `existing`/`cad`/
// `appt` are reused constantly, so this inflated the queue with work that does not exist.
{
  const sites = findWriteSites([
    file(
      "scope.ts",
      [
        "function ownsTheCadence(conv) {",
        "  const existing = conv.followUpCadence;",
        "  existing.stepIndex = 0;",
        "}",
        "function ownsATodo(todo) {",
        "  const existing = todo.record;",
        "  existing.reason = reason;",
        "}"
      ].join("\n")
    )
  ]);
  assert.equal(
    sites.get("followUpCadence")?.length,
    1,
    "only the write inside the binding's OWN function counts — an out-of-scope name reuse is not a writer"
  );
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

  // CUT 3 (2026-08-01): the same idempotent shape with a NON-empty default. This is what was
  // actually in production — five times on `appointment` alone — and the `?? {}`-only test above
  // sailed straight past it, which is a large part of why the queue could never reach zero.
  assert.equal(
    findWriteSites([
      file("lazy2.ts", 'conv.appointment = conv.appointment ?? { status: "none", updatedAt: nowIso() };')
    ]).get("appointment"),
    undefined,
    "`x = x ?? <non-empty default>` only ever fills a blank — it cannot overwrite another writer"
  );

  // ...and through an ALIAS. The old test asked about the alias's ROOT field (`appointment`)
  // rather than the path actually assigned (`appt.staffNotify`), so this was never recognized.
  assert.equal(
    findWriteSites([
      file("lazy3.ts", ["const appt = conv.appointment;", "appt.staffNotify = appt.staffNotify ?? {};"].join("\n"))
    ]).get("appointment"),
    undefined,
    "a value-preserving default through an alias is not contention either"
  );

  // CLOCK TOUCH: stamping when something changed is bookkeeping, not a decision about the lead.
  assert.equal(
    findWriteSites([
      file("clock.ts", ["const appt = conv.appointment;", "appt.confirmedAt = nowIso();"].join("\n"))
    ]).get("appointment"),
    undefined,
    "`...At = nowIso()` is a timestamp stamp, not an arbitration"
  );

  // ...but the exclusion is TIGHT: a COMPUTED date is a real decision about when we next touch a
  // customer, and must keep counting. This is the assertion that stops rule 2 from eating the queue.
  assert.equal(
    (findWriteSites([
      file("due.ts", "conv.followUpCadence.nextDueAt = computeFollowUpDueAt(anchorAt, offset, tz);")
    ]).get("followUpCadence") ?? []).length,
    1,
    "a COMPUTED due date is a real decision and still counts"
  );

  // CUT 4a (2026-08-02): a same-line `if (…)` guard hid the assignment from the parser entirely,
  // so the write did not even register as a write. The guard makes it strictly LESS able to fight.
  assert.equal(
    findWriteSites([
      file("guarded.ts", "if (conv.appointment) conv.appointment.updatedAt = new Date().toISOString();")
    ]).get("appointment"),
    undefined,
    "a same-line if-guard must not hide a bookkeeping stamp from the non-contending test"
  );
  // ...and the guard must not become a way to SMUGGLE a real write past the detector.
  assert.equal(
    (findWriteSites([
      file("guarded2.ts", 'if (conv.appointment) conv.appointment.status = "confirmed";')
    ]).get("appointment") ?? []).length,
    1,
    "an if-guarded REAL write still counts — stripping the guard is a parsing fix, not an excuse"
  );
  // A guard introducing a BLOCK is a different shape and must be left alone.
  assert.equal(
    (findWriteSites([
      file("guarded3.ts", ['if (conv.appointment) {', '  conv.appointment.status = "confirmed";', "}"].join("\n"))
    ]).get("appointment") ?? []).length,
    1,
    "an if-BLOCK is untouched — only a same-line statement guard is stripped"
  );

  // CUT 4b: `updatedAt`/`createdAt` as a LEAF is modification metadata at any depth — the same
  // reason they are already ignored at the root. Cut 3 demanded a literal clock read, so the
  // ubiquitous handler idiom (`const nowIso = …` once, then several stamps) kept counting.
  assert.equal(
    findWriteSites([file("stamp.ts", "conv.appointment.updatedAt = nowIso;")]).get("appointment"),
    undefined,
    "`x.updatedAt = <a frozen clock local>` is bookkeeping — two writers cannot disagree about it"
  );
  assert.equal(
    findWriteSites([file("stamp2.ts", "conv.followUpCadence.createdAt = someOtherTimestamp;")]).get("followUpCadence"),
    undefined,
    "createdAt is bookkeeping too, whatever the value is spelled like"
  );
  // ...and cut 4b widens ONLY those two exact names. Every other `…At` leaf still needs a literal
  // clock read, or the computed-due-date assertion above would be silently defeated.
  assert.equal(
    (findWriteSites([
      file("stamp3.ts", "conv.followUpCadence.nextDueAt = nowIso;")
    ]).get("followUpCadence") ?? []).length,
    1,
    "a bare identifier does NOT excuse a non-bookkeeping `…At` leaf — only updatedAt/createdAt widen"
  );

  // CUT 5 (2026-08-04) — `const alias = (conv.field = conv.field ?? {})`, the initialise-and-bind
  // idiom. It has TWO halves and they only tell the truth together: 5a stops the ROOT default from
  // counting (cut 3 already excuses that exact write when it stands alone), and 5b binds the alias
  // so the SUB-KEY writes that follow start counting. Ship 5a alone and a field drops toward zero
  // while a live disagreement on its sub-keys stays invisible — which is what
  // `financeOutcomeNotify` looked like before this: eight identical defaults counted, two
  // competing `status` writers not.
  assert.equal(
    findWriteSites([
      file("wrap.ts", "const notifyState = ((conv as any).financeOutcomeNotify = (conv as any).financeOutcomeNotify ?? {});")
    ]).get("financeOutcomeNotify"),
    undefined,
    "cut 5a: the wrapped idempotent default is the same non-write cut 3 already excuses"
  );
  assert.equal(
    (findWriteSites([
      file(
        "wrap2.ts",
        [
          "function markPending(conv: any) {",
          "  const notifyState = ((conv as any).financeOutcomeNotify = (conv as any).financeOutcomeNotify ?? {});",
          '  notifyState.status = "pending";',
          "}"
        ].join("\n")
      )
    ]).get("financeOutcomeNotify") ?? []).length,
    1,
    "cut 5b: a sub-key write through the wrapped alias IS contention and must be counted"
  );
  // 5a adds no NEW excuse — the unwrapped text meets the same three rules. A real decision wearing
  // the wrapper still counts, which is what stops this from becoming a way to hide a write.
  assert.equal(
    (findWriteSites([
      file("wrap3.ts", 'const s = (conv.status = "closed");')
    ]).get("status") ?? []).length,
    1,
    "cut 5a must not peel a wrapper around a REAL assignment into an excuse"
  );
  // ...and cut 5b is strictly ADDITIVE to the alias pass: the plain binding form it sits beside
  // must keep working. It is tried first and the wrapped form only as a fallback, so a regression
  // here would silently drop every alias-only writer the queue has ever found.
  assert.equal(
    (findWriteSites([
      file(
        "wrap4.ts",
        ["function f(conv: any) {", "  const cad = conv.followUpCadence;", '  cad.status = "stopped";', "}"].join("\n")
      )
    ]).get("followUpCadence") ?? []).length,
    1,
    "cut 5b must not displace the plain alias binding it falls back from"
  );

  // A genuine overwrite must never be excluded — that is the whole fight surface.
  assert.equal(
    (findWriteSites([file("real.ts", 'conv.appointment = { status: "confirmed" };')]).get("appointment") ?? []).length,
    1,
    "a plain wholesale write is still contention"
  );
  assert.equal(
    (findWriteSites([file("real2.ts", "conv.followUpCadence.status = \"stopped\";")]).get("followUpCadence") ?? []).length,
    1,
    "a plain property write is still contention"
  );
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

// =================================================================================================
// THE RE-STACKING RATCHET (Joe, 2026-08-01: "I don't need this conflicting with what the
// un-sticking is trying to clean up").
//
// THE PROBLEM IT SOLVES. The un-stack loop removes fights; four OTHER routines add code to the same
// files every day, and until now none of them knew this program existed. Nothing stopped a routine
// from bolting a fresh unrefereed write onto a field that had just been given a referee — silently
// undoing an un-stacking, with the PR looking perfectly reasonable on its own.
//
// Telling the routines is necessary but weak: instructions are read by a model that may or may not
// weigh them, and a new routine written next month starts blind again. So this is STRUCTURAL. Any
// change that raises the number of unrefereed writers fails `ci:eval`, whoever wrote it and whether
// or not they ever heard of the un-stack loop. Same mechanism as `source_size_ratchet` and
// `eval_source_pin_ratchet`, both of which already work exactly this way.
//
// WHAT THE NUMBER MEANS: independent places that can each set a piece of conversation state with
// nobody arbitrating between them. It goes DOWN as the loop referees them. It should never go up.
//
// TO ADD A WRITE LEGITIMATELY: ask the field's referee (a `decide*`/`resolve*` call within 40 lines
// above the write) instead of deciding for yourself — that is what "refereed" means here, and a
// refereed write does not count. If the field has no referee yet, that is the signal it needs one:
// leave the work to the un-stack loop rather than adding the Nth competing writer.
//
// TO LOWER IT: un-stack something, then drop the number here and say what you refereed.
//
// TO RAISE IT: don't. A change that genuinely cannot be refereed is the strongest possible argument
// that the field is already too contended to touch safely.
//
// THE HOLE THIS USED TO HAVE, and how it was closed. "Refereed" means a `decide*`/`resolve*` call
// sits within 40 lines ABOVE the write. That lookback used to run straight past the end of the
// enclosing function, so a new unrefereed write parked a few lines BELOW someone else's referee
// call read as guarded and slipped through — a simulated re-stack under `applyCadenceQuietWindow`
// did not move this number at all. `isWriteGuarded` now stops at a column-0 `}`, which is the
// previous top-level function closing, so a referee only ever guards writes in its OWN function.
// Same sabotage now moves the count (177 -> 178).
//
// WHEN THIS NUMBER MAY GO UP — the ONLY case, and it is not this one's escape hatch: the DETECTOR's
// own logic changed and is now measuring more honestly. That re-baseline must land in the SAME
// commit as the logic change, with the delta explained (168 -> 164 when #425 stopped counting
// writes that cannot arbitrate; 164 -> 177 when the lookback stopped leaking across functions).
// A number that rises because someone added CODE is a re-stack, full stop — fix the code.
//
// FAIL DIRECTION: a scan that finds nothing FAILS rather than passing silently — a ratchet that
// quietly stops measuring is worse than no ratchet, because it reads as "no re-stacking happened".
const CONTENTION_ROOT = path.resolve("services/api/src");
// Measured 2026-08-01 against a CLEAN origin/main (7b679fbb), after PRs #411/#414/#420/#421/#423
// refereed draftHeld, the cadence quiet window, the appointment teardown, the appointment outcome
// record, and the manual cadence restart. Take this number from a clean checkout, never from the
// shared anomaly-review tree — that clone is often mid-edit by the loop and reads ~4 lower.
// 168 -> 164: PR #425 taught the detector that a write which cannot arbitrate is not a writer.
// 164 -> 177: the referee lookback stopped leaking across function boundaries — 13 writes were
// being credited to a referee in a DIFFERENT function. A measurement fix, not a regression.
// 177 -> 168: two more measurement fixes, both DOWN (this commit).
//   - alias scope (8 of the 9): a `const existing = conv.followUpCadence` was still the live
//     binding 1,200 lines later, so unrelated writes through a reused name — `addTodo`'s
//     `existing.reason` — counted as cadence writers. Those writers do not exist.
//   - the referee one level down (1 of the 9): a call to an `apply*` that consults a referee AND
//     writes the field now counts as refereed, because that is where every un-stacking so far put
//     the arbitration. Field-scoped and call-only, so it credits exactly one write today
//     (`conv.scheduleSoft` under `applySoftVisitCadenceWindow`) rather than the 37 a loose
//     "any apply*" rule would have waved through.
// 168 -> 165: the cadence-START un-stacking (this commit). startFollowUpCadence,
//   startPostSaleCadence and scheduleLongTermFollowUp each carried their own admission test for
//   "may I lay a new chase over this lead?"; all three now ask `decideCadenceStart`. A CODE change,
//   not a measurement change — the detector is untouched. Measured on this branch with nothing else
//   modified in the tree (`git status` showed only the four files of this PR).
// 165 -> 162: the appointment-CONFIRM un-stacking (this commit). The slot-match confirm
//   (conversationStore), the confirm-book path and the voice post-summary path (index.ts) each
//   decided the confirmed record's companion fields for themselves; all three now ask
//   `decideAppointmentConfirmRecord`. A CODE change, not a measurement change.
// 162 -> 158: the cadence-REVIVAL un-stacking (this commit). Four re-engagement triggers each
//   carried their own test for "which chases are dead enough to throw away?" before blanking the
//   record to defeat startFollowUpCadence's own guard — the health-recovery delay and the customer
//   deferral (index.ts), the finance no-contact voicemail (index.ts) and the walk-in hold-clear
//   (sendgridInbound.ts). All four now ask `decideCadenceRevival` through `applyCadenceRevival`.
//   `followUpCadence` 17 -> 13 unrefereed, and it drops from 3 contended files to 2. A CODE change,
//   not a measurement change — the detector is untouched.
// 158 -> 153: the SOLD-closeout un-stacking (this commit). `applyOutcomeSold` and the console's
//   sold button (POST /conversations/:id/close, reason "sold") were hand-maintained copies of the
//   same closeout, down to a five-line hold-match condition duplicated character for character.
//   Both now ask `decideSoldCloseout` through `applySoldCloseout`. `status` 6 -> 5, `closedReason`
//   6 -> 5, `hold` 6 -> 5. A CODE change, not a measurement change.
// 153 -> 152: the booking-ENDPOINT un-stacking (this commit). The three HTTP endpoints that create
//   a calendar event (/scheduler/book, /public/booking/book, /conversations/:id/appointment) each
//   ran their own copy of the same "write the confirmed record" field list; all three now ask
//   `decideAppointmentBookingRecord` through `applyAppointmentBookingRecord`. A CODE change, not a
//   measurement change.
//   ONLY -1, and the reason is worth recording rather than hiding: THREE unrefereed writers went
//   away, but removing those blocks un-collapsed two bare `appointment.updatedAt = <now>` stamps
//   (index.ts ~39731, ~41973) that had been merged into them by the adjacency rule, so they now
//   count as writers in their own right. `appointment` 15 -> 14. A modification timestamp cannot
//   fight another writer over a DECISION — every writer stamps it and last-write-wins is exactly
//   right — so this is the same BOOKKEEPING-counted-as-contention class the detector's CUT 3
//   already fixed for value-preserving defaults. Filed as detector CUT 4; NOT folded in here,
//   because a measurement change and a code change in one commit make the ratchet unreadable.
// 152 -> 150: detector CUT 4 (this commit) — a MEASUREMENT change, NOT a code change, and the only
//   entry in this list that is. Two shapes of bookkeeping the detector was counting as contention:
//   a stamp hidden behind a same-line `if (…)` guard (the line did not parse as a write at all),
//   and `updatedAt`/`createdAt` as a LEAF — already ignored at the root for a reason that does not
//   stop being true one level down, since two writers cannot disagree about when a record last
//   changed. This does not un-stack anything; it stops the queue counting work that does not exist,
//   which #455 exposed when removing three writers moved the number by one.
// 150 -> 148: the DEAD keyword appointment writer, deleted (this commit). A CODE change.
//   `updateAppointmentFromInbound` (conversationStore) decided the appointment record from keyword
//   regexes over raw customer text — "cancel|reschedule" wiped it to `status: "none"`, a bare
//   weekday+clock match asserted `status: "confirmed", confirmedBy: "customer"` — and it had ZERO
//   callers anywhere in the tracked tree. So it never fought anyone; it was a dormant landmine that
//   the queue was, correctly, counting as two independent writers of a Tier-1 field. Removing it is
//   provably behaviour-preserving (nothing in the serving path imported it) and closes the two
//   whole-record `conv.appointment = {...}` writes. `appointment` 13 -> 11.
// 148 -> 146: the reschedule-latch ARM un-stacking (this commit). A CODE change. Three places armed
//   `appointment.reschedulePending` on their own preconditions — the outcome-reschedule draft, the
//   staff context note, and the customer's own cancel/reschedule message — while the two existing
//   referees only ever owned CLEARING it. All three now ask `decideReschedulePendingLatch` through
//   `applyReschedulePendingLatch`. Memory's slicing advice was followed: "who may ARM the latch"
//   is its own PR, separate from "who must CLEAR it".
//   ONLY -2 for three writers removed, and the reason is the same one #455 recorded rather than
//   hid: taking the arm site out of index.ts ~61080 un-collapsed a neighbouring CLEAR write
//   (`if (conv.appointment) conv.appointment.reschedulePending = false;`, ~62947) that the
//   adjacency rule had been folding into the block above it, so it now counts in its own right.
//   `appointment` 11 -> 9. It belongs to the CLEAR question and is queued with it, not lost.
// 146 -> 139: the inventory-availability REOPEN un-stacking (this commit). A CODE change, and the
//   biggest single move so far because it is one question wearing three Tier-1 fields at once.
//   `clearLinkedInventoryAvailabilityConversations` (staff un-marks a unit as held/sold) ran two
//   near-identical arms that had drifted, and `processInventoryHolds` (a hold cleared because the
//   unit SOLD) answered the same question a third way; all three now ask
//   `decideInventoryAvailabilityReopen` through `applyInventoryAvailabilityReopen`.
//   `hold` 5 -> 0 and OFF the queue entirely — the first Tier-1 field fully cleared. `status` 5 -> 4,
//   `closedReason` 5 -> 4. The cluster heuristic this memory recorded paid off exactly as predicted:
//   several fields' writers sitting within a few lines of each other were ONE question, worth more
//   per PR than the biggest single field.
// 139 -> 132: the CLOSEOUT-REVERSAL un-stacking (this commit) — the companion question to the one
//   above, for every reopen cause that is NOT an inventory record disappearing. Four places un-did a
//   closeout inline on their own reading: `appendInbound` (a customer texted a closed thread),
//   `POST /conversations/:id/reopen` (staff pressed Reopen) and the two walk-in hold notes in
//   sendgridInbound. All four now ask `decideCloseoutReversal` through `applyCloseoutReversal`.
//   `status` 4 -> 2, `closedReason` 4 -> 2, `closedAt` 3 -> 1 — and what is LEFT on those fields is
//   the sibling question (closing a lead), not this one. Same cluster heuristic again: three fields
//   whose writers sat on consecutive lines were one question.
// 132 -> 128: the CADENCE LIFECYCLE un-stacking (this commit). `followUpCadence` is the field that
//   TEXTS people, and four callers moved it between active, paused and stopped on their own
//   preconditions: `stopFollowUpCadence`, `pauseFollowUpCadence`, `resumeFollowUpCadence` and an
//   inline stop inside `closeConversation` that bypassed the stop verb entirely. All four now ask
//   `decideCadenceLifecycle` through `applyCadenceLifecycle`. `followUpCadence` 13 -> 9.
//   A FIFTH pause writer is deliberately NOT in this slice: the health-recovery pause extension
//   (index.ts ~9347) stamps `pausedUntil`/`pauseReason` on a chase whatever its status, where the
//   `pause` verb requires "active". Sibling question, queued, not silently folded in.
// 128 -> 124: the CADENCE REPLACEMENT un-stacking (this commit). The companion to the lifecycle
//   slice: four places MINT a whole new `followUpCadence` object over whatever is running, so
//   `decideCadenceStart`'s "refuse when a cadence already exists" guard never applies to them —
//   finance declined, the licence/credit-pending staff note, the manual-outbound seller-photo
//   request, and the over-eager-engaged healer. All four now ask `decideCadenceReplacement` through
//   `applyCadenceReplacement`. `followUpCadence` 9 -> 5. Three divergences preserved and named.
// 124 -> 122: the appointment-ATTRIBUTION un-stacking (this commit). Two writers of
//   `appointment.bookedBy` answering different halves of one question — `setAppointmentBookedBy`
//   stores an attribution a booking path hands in, `onAppointmentBooked` INFERS one from
//   `confirmedBy` when nobody did (the live path for 11 of the 18 booking call sites). Both now ask
//   `decideAppointmentAttribution` through `applyAppointmentAttribution`. `appointment` 9 -> 7.
// 122 -> 116: the LEAD-closeout un-stacking (this commit). "When a lead's thread closes, what else
//   has to settle?" was answered in three places: `closeConversation` (the generic close) and TWO
//   hand-maintained copies of the appointment-outcome "sold" lane — the conversation header and the
//   to-do endpoint — each hand-writing `status`/`closedAt`/`closedReason` and bypassing
//   `closeConversation` entirely. All three now ask `decideLeadCloseout` through `applyLeadCloseout`.
//   THREE Tier-1 fields cleared to ZERO at once: `status` 2 -> 0, `closedReason` 2 -> 0,
//   `closedAt` 1 -> 0. The second sold copy was INVISIBLE to the queue until the first was rewired
//   (the collapse artifact #455/#462 both recorded) — re-measure after every rewire, never assume
//   the listed sites are all of them.
// 116 -> 114: the inventory-HOLD-record un-stacking (this commit). "Who may put a bike on hold for
//   a lead, and what does that hold record say?" was answered twice — `applyOutcomeHold` (a rep
//   records the appointment outcome as "held") and the console's manual-resolution endpoint — as
//   hand-maintained copies of the same fourteen-field block plus the same cadence/mode aftermath.
//   Both now ask `decideInventoryHoldRecord` through `applyInventoryHoldRecord`. `hold` 2 -> 0, the
//   Tier-1 field cleared. Two divergences preserved and named (the outcome lane's unconditional
//   mode stomp over a human handoff; the null vs dropped `key` on an on-order hold).
//   Baseline MEASURED on the pre-change commit 46ba0e1d (= 116), not carried from this constant —
//   see the "a ratchet baseline is a ceiling, not a measurement" lesson on the 122 -> 116 entry.
// 114 -> 112: the SCHEDULE-INVITE-BUDGET un-stacking (this commit). "How many times may we ask this
//   customer to come in?" was owned by a DUPLICATED CONSTANT — `threshold = 3` inside
//   `registerScheduleInviteSent` (which latches `scheduleMuted`) and `SCHEDULE_INVITE_THRESHOLD = 3`
//   in index.ts (which picks the follow-up message pool). Same counter, same question, two files,
//   nothing keeping them equal. Both now ask `decideScheduleInviteBudget`, which owns the number.
//   The second writer, `resetScheduleInviteCounter`, was DELETED outright: zero callers repo-wide,
//   a dormant bypass of the arbitration (the #461 class). `followUpCadence` 5 -> 3.
// 112 -> 111: the two remaining CALENDAR-WRITE lanes joined `decideAppointmentBookingRecord` (this
//   commit). Two places still stamped `appointment.status = "confirmed"` off their own copy of the
//   field list: the manual-outbound send that books a time staff just texted, and the staff calendar
//   edit (PATCH /calendar/events). Both now ask the referee. Two divergences preserved and named —
//   neither lane stamps `confirmedBy` (both hand attribution in via `setAppointmentBookedBy`, and
//   `confirmedBy` feeds the KPI appointment-setter label, so stamping it would move a reported
//   number), and the edit lane never refreshes `acknowledged` (staff dragging an event is not the
//   customer agreeing to the new hour). `appointment` 6 -> 5, NOT 6 -> 4: the manual-outbound
//   function still holds ANOTHER unrefereed appointment write (the staff-inferred confirm at
//   index.ts ~53370), so that cluster's leader moved rather than disappearing — the #455/#462
//   collapse artifact again, MEASURED on the pre-change tree rather than assumed. That leader is
//   the next slice.
// RATCHET DOWN ONLY.
// 111 -> 93. The inventory-watch ARM un-stacking (2026-08-04). The three watch fields
// (`inventoryWatches`, `inventoryWatch`, `inventoryWatchPending`) were always decided in the SAME
// BREATH by the same block, which is why their unrefereed writers sat on adjacent line numbers —
// one question wearing three fields. Ten arm lanes now ask `decideInventoryWatchArm` and write
// through `applyInventoryWatchArm`. Watch fields 29 -> 13. The site list was a LOWER BOUND as usual:
// the queue named six lanes and `inventory_watch_arm:eval`'s arm-signature scan found FOUR more the
// analyzer had collapsed (a second voice arm in the same function, the console watch-set endpoint,
// the walk-in email arm, and the initial-ADF unavailable arm). MEASURED on the post-change tree.
// 92 -> 90. Detector CUT 5 (2026-08-04) — a MEASUREMENT change, not a code change, and one that
// moves the number in BOTH directions on purpose. 5a stops the wrapped idempotent default
// (`const alias = (conv.field = conv.field ?? {})`) from counting; 5b binds that alias so the
// sub-key writes after it start counting. `financeOutcomeNotify` went 7 unrefereed writers -> 5,
// and the five it names now are entirely different sites: the eight it used to name were eight
// copies of the same harmless default, while the actual disagreement — two lanes writing
// `notifyState.status`, one of them bypassing `applyFinanceOutcomeStatusFromSignal` outright — was
// invisible. Shipping 5a without 5b would have dropped the field toward zero and hidden that.
// Same standard as cut 4: the cut had to go both ways or it would have been dishonest.
// 90 -> 81. The inventory-watch DISARM un-stacking (2026-08-04) — the INVERSE of #500's arm
// referee, and the same cluster tell: the three watch fields' unrefereed writers sat on adjacent
// lines inside four functions. Four lanes now ask `decideInventoryWatchDisarm` and write through
// `applyInventoryWatchDisarm`: the customer's stop request, our own held-unit heal, and the two
// worker repair endpoints. `inventoryWatches` 5 -> 2, `inventoryWatch` 4 -> 1, `inventoryWatchPending`
// 4 -> 2. The FOURTH lane (`vin_normalize`) was invisible to the queue until the third was refereed
// — refereeing one write un-collapses its neighbours, the adjacency artifact this program has now
// hit five times. MEASURED on the post-change tree.
// 81 -> 76. The finance-outcome-NOTIFY un-stacking (2026-08-04) — the whole Tier-2 field, cleared.
// Detector cut 5 (#510) had just made these five sites visible for the first time; seven places
// hand-wrote the business-manager notification record and now all ask `decideFinanceOutcomeNotifyState`
// through `applyFinanceOutcomeNotifyState`. `financeOutcomeNotify` 5 -> 0. The two staff-SMS lanes
// were NOT in the queue's five — they sat within 40 lines of an `applyFinanceOutcomeStatusFromSignal`
// call and so read as refereed by an applier that never actually decided these fields. Wired anyway:
// the queue is a lower bound every time. MEASURED on the post-change tree.
// RATCHET DOWN ONLY.
// 76 -> 74. The appointment-PROMPT un-stacking (2026-08-04): the two marks that stop us asking the
// same question twice — the 24h YES/NO confirmation record and the internal attendance question —
// now have one referee (`decideAppointmentPromptRecord`) and one writer
// (`applyAppointmentPromptRecord`). EIGHT lanes, where the queue could see two: six of them were
// byte-identical copies inside one function, which `countWriters` collapses to a single writer.
// `appointment` 4 -> 2. MEASURED on the post-change tree.
// RATCHET DOWN ONLY.
// 74 -> 72. The watch-RECORD-SHAPE un-stacking (2026-08-04): `inventoryWatches` 2 -> 0. Two alert
// paths hand-wrote the same prefer-list / wrap-singular / backfill block; they now ask
// `resolveInventoryWatchListNormalization`. Shipped alongside the exactness ladder (10 copies, 3
// shapes, both disagreements preserved) — which moved the ratchet by 0, because refereeing
// `inventoryWatch`'s only unrefereed writer UN-COLLAPSED a neighbour ~20 lines above
// (`pref.watch.make = leadVehicle.make`, a fill-a-blank backfill). Seventh sighting of that
// artifact; the neighbour is scoped as the next slice. MEASURED on the post-change tree.
// RATCHET DOWN ONLY.
// 72 -> 70. The pending-WATCH-CLEAR un-stacking (2026-08-04): `inventoryWatchPending` 2 -> 0, which
// clears the LAST Tier-2 field on the triage queue. The two writers genuinely DISAGREED — the
// conversation-state path cleared on a bare `departmentIntent !== "none"` with none of the
// keep-guards the stale-state path applied, so a lead parked in `holding_inventory`, or one asking
// about the watch in the same breath, lost it. Ruled toward KEEPING (AGENTS.md fail-direction);
// both sites now write through `applyInventoryWatchPendingClear`, which asks
// `resolveInventoryWatchPendingClear`. MEASURED on the post-change tree.
// RATCHET DOWN ONLY.
// 70 -> 70, UNCHANGED, and the zero is the finding. The rebook-latch SETTLEMENT un-stacking
// (2026-08-05): the three places that took `appointment.reschedulePending` off WITHOUT a new booking
// — a stale reschedule slot, a settled past appointment, and a staff note recording the customer as
// showed-up — now ask `decideReschedulePendingClear` through `applyReschedulePendingClear`. That is
// the last unowned half of the latch; the booking referees already owned clearing it when a new time
// goes on the calendar. Three inline writers went away and the number did not move: refereeing the
// inbound-handler site UN-COLLAPSED the auto-reschedule booking block a few lines below
// (index.ts ~62781), one of SEVEN hand-maintained copies of `decideAppointmentBookingRecord`'s
// question, which is the next slice. EIGHTH sighting of the collapse artifact, and the first time it
// has eaten a delta whole. MEASURED on the post-change tree with the eval's own `minWrites: 4` scan —
// a different filter reports different totals, so only this one may be quoted here.
// RATCHET DOWN ONLY.
// 70 -> 68, and `appointment` reaches ZERO — the second Tier-1 field cleared. The CONVERSATION-TURN
// booking un-stacking (2026-08-05): the seven hand-maintained copies of "a real calendar event now
// holds this lead's time" that lived inside the inbound handler joined
// `decideAppointmentBookingRecord` as four new lanes. They were invisible to the queue as seven —
// `countWriters` collapses one enclosing function to one writer — which is why the previous slice
// moved the number by 0 and this one moves it by 2. FOUR divergences preserved and named: the
// matched-slot lane confirms with no fresh hour or attribution, the exact-slot arm alone records
// whose calendar holds the event, a MOVE keeps the event it already holds where a CREATE clears a
// missing one to null, and the suggested-slot autobook records the matched slot where its console
// siblings do not. MEASURED on the post-change tree with the eval's own `minWrites: 4` scan.
// RATCHET DOWN ONLY.
// 68 -> 67. The RUNG BURN un-stacking (2026-08-05): `advanceFollowUpCadence` was the last
// unrefereed writer of `followUpCadence` carrying real logic — six ladders behind four `kind`
// values, the silent-rung rule, and two completely different ways for a ladder to end, all living
// only inside its own body. It now asks `decideCadenceAdvance`; the day-offset tables stay in the
// store behind one `CADENCE_LADDER_DAY_OFFSETS` map the referee's ladder key indexes.
// `followUpCadence` 3 -> 2, and conversationStore drops off its file list entirely.
// MEASURED on the post-change tree with the eval's own `minWrites: 4` scan.
// RATCHET DOWN ONLY.
const UNREFEREED_WRITER_BASELINE = 67;

{
  const sourceFiles: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        sourceFiles.push(file(path.relative(process.cwd(), full), fs.readFileSync(full, "utf8")));
      }
    }
  };
  assert.ok(fs.existsSync(CONTENTION_ROOT), `contention ratchet: ${CONTENTION_ROOT} not found — the scan is broken`);
  walk(CONTENTION_ROOT);
  assert.ok(
    sourceFiles.length > 50,
    `contention ratchet: only ${sourceFiles.length} source file(s) scanned — that is not the real tree, and an empty scan must never pass`
  );

  const queue = unstackingQueue(rankContention(sourceFiles, { minWrites: 4 }));
  const total = queue.reduce((n, f) => n + f.unrefereedWriters, 0);
  assert.ok(total > 0, "contention ratchet: zero unrefereed writers found — the detector broke, this is not a clean codebase");

  if (total > UNREFEREED_WRITER_BASELINE) {
    const worst = [...queue].sort((a, b) => b.unrefereedWriters - a.unrefereedWriters).slice(0, 5);
    console.error(
      `  FAIL re-stacking ratchet: ${total} unrefereed writers, baseline ${UNREFEREED_WRITER_BASELINE} ` +
        `(+${total - UNREFEREED_WRITER_BASELINE}).\n` +
        "       Something added a place that sets conversation state with nobody arbitrating — which is\n" +
        "       what the un-stack loop exists to remove. ASK THE FIELD'S REFEREE instead (a decide*/\n" +
        "       resolve* call above the write); a refereed write does not count here. If the field has\n" +
        "       no referee yet, leave it to the un-stack loop rather than adding the Nth writer.\n" +
        "       Do NOT raise this number.\n" +
        `       Most contended: ${worst.map(f => `${f.field}(${f.unrefereedWriters})`).join(", ")}`
    );
    process.exit(1);
  }

  console.log(
    `state_writer_contention:eval re-stacking ratchet OK (${total} / ${UNREFEREED_WRITER_BASELINE} unrefereed writers across ${queue.length} field(s))`
  );
  if (UNREFEREED_WRITER_BASELINE - total >= 5) {
    console.log(
      `  NOTE: ${UNREFEREED_WRITER_BASELINE - total} under baseline — lower UNREFEREED_WRITER_BASELINE to ${total} to keep the grip.`
    );
  }
}

console.log("PASS state-writer contention — writer clustering, referee proof, over-count guards, queue ordering");
