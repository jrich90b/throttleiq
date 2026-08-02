/**
 * State-writer contention — find the pieces of conversation state that too many places write,
 * with nobody refereeing them.
 *
 * Joe, 2026-08-01: "I want to untangle these as we go along. We need to clean it up so they aren't
 * fighting each other."
 *
 * THE BUG CLASS THIS EXISTS FOR. On 2026-08-01 a lead's financing was declined, the code correctly
 * put him on the slow 30/60/120-day cadence, and 37 SECONDS LATER a different feature in the same
 * file replaced the whole cadence with the fast one (PR #398). Neither side was wrong on its own.
 * They were two of the 68 places that write `followUpCadence`, and nothing decided which one won.
 *
 * That is the shape of nearly every hard bug here, and it is countable BEFORE it bites: a piece of
 * state written from many scattered places with no single decision function is a fight waiting to
 * happen. This ranks that contention so the daily review can un-stack the worst one first.
 *
 * WHAT IT COUNTS: not raw writes — WRITERS. 298 writes to `conv.appointment` collapse to 47
 * independent places, because a run of `…whenText = …`, `…whenIso = …` inside one function executes
 * in sequence and cannot fight itself. Two writers in two functions can.
 *
 * THE FIX PATTERN IT POINTS AT (what "refereed" means): a pure function in
 * `domain/routeStateReducer.ts` — or a domain module — that OWNS the decision, and write sites that
 * ask it instead of deciding for themselves. `decideFinanceDeclinedCadence` (PR #398) is the
 * worked example: two places wanted to set the cadence, so one referee now says which wins and
 * both consult it.
 *
 * NOT a comprehension component. This reads SOURCE CODE, never customer text, so AGENTS.md's
 * comprehend-never-regex rule is not in play — that rule governs how customer intent is read.
 * Static analysis of our own files is exactly where deterministic pattern-matching belongs.
 *
 * FAIL DIRECTION: it UNDER-reports, on three counts. Only assignment forms we can recognize are
 * counted; adjacent writes collapse into one writer (so two genuinely separate writers inside 15
 * lines read as one); and a writer counts as refereed on the mere PRESENCE of a nearby decision
 * call, without proving that call actually governs this field. A field this flags is therefore
 * genuinely contended — but a low score is never proof of safety, and must not be read as one.
 */

export type WriteSite = {
  file: string;
  line: number;
  /** The matched source text, trimmed — enough to see what kind of write it is. */
  snippet: string;
  /** `true` when the whole object is replaced (`x.field = {`), not just a property poked. */
  wholesale: boolean;
  /** Is this write downstream of a `decide*`/`resolve*` call? See isWriteGuarded. */
  guarded: boolean;
  /** Enclosing top-level function — the clustering key (one function = one decision point). */
  fn: string;
  /** Set when the write went through a local alias (`const appt = conv.appointment`). */
  viaAlias: string | null;
};

export type FieldContention = {
  field: string;
  writeSites: WriteSite[];
  files: string[];
  wholesaleWrites: number;
  /** Writes that ARE downstream of a `decide`/`resolve` call. */
  guardedWrites: number;
  /** Writes that decide for themselves. */
  unguardedWrites: number;
  /** writeSites.length — raw, and misleading on its own (see countWriters). */
  writes: number;
  /** INDEPENDENT places that can set this state — adjacent writes collapsed. */
  writers: number;
  /** Independent writers that decide for themselves. THE fight-surface number. */
  unrefereedWriters: number;
  /** One representative site per unrefereed writer — the actual work list. */
  unrefereedWriterSites: WriteSite[];
};

/**
 * Conversation-state roots whose fields we track. Deliberately narrow: these are the objects whose
 * disagreement produces a customer-visible defect (the wrong cadence, the wrong appointment, the
 * wrong mode), not every variable in the codebase.
 */
// `c` is deliberately NOT here. It matches every local named `c` in the codebase and inflated
// `appointment` to 298 writes on the first run — a number that reads as alarming and means nothing.
// An over-counting detector gets ignored, which is the same as not having one.
export const STATE_ROOTS = ["conv", "conversation"];

/** `x.field = ` / `x.field.sub = ` / `(x as any).field = `, but never `==`, `=>`, `>=` etc. */
function buildAssignmentPattern(root: string): RegExp {
  return new RegExp(
    // optional `(conv as any)` wrapper, then .field, then optional .sub chain, then a bare `=`
    `(?:\\(\\s*${root}\\s+as\\s+any\\s*\\)|\\b${root})\\.([A-Za-z_][A-Za-z0-9_]*)((?:\\??\\.[A-Za-z_][A-Za-z0-9_]*)*)\\s*(\\??\\?)?=(?!=|>)`,
    "g"
  );
}

/**
 * Fields that are not shared state and would only add noise: bookkeeping stamps every writer
 * legitimately touches, and the audit trail. `updatedAt` is written everywhere BY DESIGN.
 */
const IGNORED_FIELDS = new Set([
  "updatedAt",
  "createdAt",
  "id",
  "leadKey",
  "messages",
  "length",
  "at"
]);

export type SourceFile = { path: string; text: string };

/**
 * ALIAS BINDINGS — the biggest thing the first cut missed.
 *
 * A huge amount of state is mutated through a local alias: `const appt = conv.appointment;` then
 * `appt.status = "none"`. That mutates `conv.appointment` exactly as surely as writing the long
 * path, but a pattern keyed on `conv.` never sees it. `index.ts` alone has 11 such bindings for
 * `appointment` and 4 for `followUpCadence`, and — the reason this matters — **four of the six
 * appointment teardown sites are alias-only**, so the cancel path was invisible to the queue.
 *
 * Only OBJECT aliases count. `const stockId = conv.lead.stockId` binds a scalar; reassigning it
 * cannot mutate the conversation (and `const` forbids it anyway). The detectable shape is
 * `alias.<prop> = …`, which is a mutation of the aliased object.
 *
 * An alias is attributed to the MOST RECENT preceding binding of that name in the same file, so a
 * name reused across functions resolves to the right field instead of leaking across scopes.
 *
 * SCOPE. A binding only reaches writes inside the SAME enclosing function. Without that, the
 * "most recent preceding binding in the file" rule leaked across function boundaries: the
 * `const existing = conv.followUpCadence` inside `applyManualCadenceRestart` was still the live
 * binding 1,200 lines later, so `addTodo`'s completely unrelated `existing.reason = reason` (a
 * TODO, not a cadence) scored as a competing writer of the follow-up cadence. A name as common as
 * `existing`/`cad`/`appt` is reused constantly, so this was not a one-off.
 */
function collectAliasBindings(lines: string[]): { line: number; alias: string; field: string }[] {
  const bindings: { line: number; alias: string; field: string }[] = [];
  const pattern = new RegExp(
    `\\b(?:const|let)\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(?:${STATE_ROOTS.join("|")})\\??\\.([A-Za-z_][A-Za-z0-9_]*)\\s*(?:;|$|\\?\\?|\\|\\|)`
  );
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    const match = pattern.exec(trimmed);
    if (match && !IGNORED_FIELDS.has(match[2])) {
      bindings.push({ line: i, alias: match[1], field: match[2] });
    }
  }
  return bindings;
}

/**
 * Top-level function boundaries, used to cluster writes by DECISION POINT rather than by line
 * distance.
 *
 * This replaced a 15-line proximity heuristic, which got `financeOutcome` wrong: its three writes
 * are the three mutually-exclusive branches of ONE `if/else` inside
 * `applyFinanceOutcomeStatusFromSignal` — i.e. the referee's own implementation — and the detector
 * scored them as three competing writers. Branches inside one function cannot fight each other; a
 * caller invokes the function as a unit. The contention that matters is between CALL SITES.
 */
function collectFunctionBoundaries(lines: string[]): { line: number; name: string }[] {
  const out: { line: number; name: string }[] = [];
  const decl =
    /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)|^(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\(/;
  for (const [i, line] of lines.entries()) {
    const match = decl.exec(line);
    if (match) out.push({ line: i, name: match[1] ?? match[2] ?? "?" });
  }
  return out;
}

function enclosingFunction(boundaries: { line: number; name: string }[], lineIndex: number): string {
  let name = "(top-level)";
  for (const b of boundaries) {
    if (b.line <= lineIndex) name = b.name;
    else break;
  }
  return name;
}

/**
 * The assigned left-hand path on this line — `conv.appointment.staffNotify` out of
 * `conv.appointment.staffNotify = …`. Whitespace-normalized so it can be compared to the
 * right-hand side. Returns null for anything that is not a plain path assignment (declarations,
 * `(conv as any).x = …`, destructuring), which keeps those COUNTED — the conservative direction.
 */
function assignedPath(trimmed: string): string | null {
  const match = /^([A-Za-z_$][A-Za-z0-9_$]*(?:\s*\??\.\s*[A-Za-z_$][A-Za-z0-9_$]*)+)\s*=(?!=|>)/.exec(
    stripAsAny(trimmed)
  );
  return match ? match[1].replace(/\s+/g, "") : null;
}

/**
 * `(conv as any).x` → `conv.x`. Production writes this constantly, and without unwrapping it the
 * line no longer STARTS with a plain path, so every such default-init read as a real writer.
 */
function stripAsAny(text: string): string {
  return text.replace(/\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+any\s*\)/g, "$1");
}

/** Everything after the first `=` of an assignment, whitespace-stripped. */
function assignedValue(trimmed: string): string {
  const normalized = stripAsAny(trimmed);
  const eq = normalized.search(/=(?!=|>)/);
  return eq < 0 ? "" : normalized.slice(eq + 1).replace(/\s+/g, "");
}

/**
 * CUT 3 (2026-08-01): a write that CANNOT ARBITRATE is not a writer.
 *
 * Cuts 1 and 2 (see the eval header) killed two ways of over-reporting. This kills the third, and
 * it is the one that was keeping the queue from ever reaching zero: the detector was counting
 * bookkeeping as contention. Two shapes, both provably unable to fight anyone:
 *
 *  1. VALUE-PRESERVING DEFAULT — `x.y = x.y ?? …` / `|| …`. Idempotent: it only ever fills a blank,
 *     and can never overwrite what another writer decided. The previous test only caught the
 *     literal `?? {}` form, so the far more common
 *     `conv.appointment = conv.appointment ?? { status: "none", updatedAt: nowIso() }` sailed
 *     through and scored as a contended writer — five times over, on `appointment` alone. It also
 *     checked the ALIAS's root field rather than the path actually being assigned, so
 *     `appt.staffNotify = appt.staffNotify ?? {}` was never recognized either.
 *  2. CLOCK TOUCH — `…At = nowIso()` / `new Date().toISOString()`. Stamping "when did this change"
 *     is bookkeeping, not a decision about the lead. Deliberately TIGHT: the value must be a bare
 *     fresh-clock read, so a computed date like `nextDueAt = computeFollowUpDueAt(...)` — which IS
 *     a real decision about when we next touch a customer — keeps counting.
 *
 * CUT 4 (2026-08-02): two more shapes of the same bookkeeping.
 *
 * The booking-endpoint un-stacking (PR #455) removed three unrefereed writers and the queue fell by
 * only ONE, because pulling those blocks out un-collapsed two `appointment.updatedAt` stamps the
 * adjacency rule had been hiding inside them. Both are bookkeeping by cut 3's own reasoning; cut 3
 * simply could not see them.
 *
 *  3. GUARDED ON ONE LINE — `if (conv.appointment) conv.appointment.updatedAt = new Date()…`. The
 *     line no longer STARTS with the assigned path, so it did not parse as an assignment at all.
 *     Stripping a leading same-line `if (…)` is purely a parsing fix: the write it guards is the
 *     same write, and a guard makes it strictly LESS able to fight anyone, never more.
 *  4. `updatedAt` / `createdAt` AS A LEAF, whatever the value is spelled like. These two names are
 *     already in IGNORED_FIELDS at the ROOT (`conv.updatedAt`) for a reason that does not stop
 *     being true one level down: "when did this record last change" is modification metadata, not
 *     a decision about the lead. There is no such thing as two writers DISAGREEING about it —
 *     every writer stamps it and last-write-wins is correct by definition. Cut 3 required the
 *     value to be a literal fresh-clock read, so the extremely common handler idiom
 *     `const nowIso = new Date().toISOString()` … `conv.appointment.updatedAt = nowIso` kept
 *     counting as a contended writer.
 *
 *     Note this widens ONLY those two exact names. Every other `…At` leaf still has to show a
 *     literal clock read, because a computed one like `nextDueAt = computeFollowUpDueAt(...)` IS a
 *     real decision about when we next touch a customer, and must keep counting.
 *
 *     REJECTED, and worth recording so nobody rebuilds it: a first pass tried to excuse any bare
 *     identifier this FILE proves is a frozen clock read. It refused to fire — `index.ts` binds the
 *     name `nowIso` three different ways (a lambda, a computed `atIso ?? now` fallback, and the
 *     plain read) — which is the disqualifier working correctly, but it left machinery that never
 *     ran. The leaf-name rule is both simpler and stronger, and it does not depend on what the
 *     local happens to be called.
 *
 * FAIL DIRECTION: excluding a write can only REMOVE work from the queue, so the bar is "provably
 * non-contending", never "probably harmless". Anything this cannot parse stays counted.
 */
const FRESH_CLOCK_VALUE = /^(?:nowIso\(\)|newDate\(\)\.toISOString\(\))[;,)]?$/;

/** Modification metadata — bookkeeping at any depth, never an arbitration. See cut 4. */
const BOOKKEEPING_LEAVES = new Set(["updatedAt", "createdAt"]);

/** `if (cond) x.y = …` → `x.y = …`. Cut 4: a same-line guard hid the assignment from the parser. */
function stripLeadingGuard(text: string): string {
  const guarded = /^if\s*\((?:[^()]|\([^()]*\))*\)\s*(?!\{)(.+)$/.exec(text.trim());
  return guarded ? guarded[1].trim() : text;
}

export function isNonContendingWrite(trimmed: string): boolean {
  const unguarded = stripLeadingGuard(trimmed);
  const path = assignedPath(unguarded);
  if (!path) return false;
  const value = assignedValue(unguarded);
  if (!value) return false;

  // 1) `x.y = x.y ?? …` / `x.y = x.y || …`
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`^${escaped}(?:\\?\\?|\\|\\|)`).test(value)) return true;

  const leaf = path.split(".").pop() ?? "";

  // 2) `x.updatedAt = <anything>` — modification metadata at any depth (cut 4).
  if (BOOKKEEPING_LEAVES.has(leaf)) return true;

  // 3) any other `…At = nowIso()` — a stamp, but only when the value is a literal clock read, so a
  //    computed due-date stays counted (cut 3).
  if (/At$/.test(leaf) && FRESH_CLOCK_VALUE.test(value)) return true;

  return false;
}

export function findWriteSites(files: SourceFile[]): Map<string, WriteSite[]> {
  const byField = new Map<string, WriteSite[]>();
  const push = (field: string, site: WriteSite) => {
    const existing = byField.get(field);
    if (existing) existing.push(site);
    else byField.set(field, [site]);
  };

  // Which fields does each function write? Needed to prove an applier arbitrates the field it is
  // being credited for. Filled as we go, then used in the second pass below.
  const fieldsWrittenByFn = new Map<string, Set<string>>();
  const noteFieldWrite = (fileKey: string, fn: string, field: string) => {
    const key = `${fileKey}::${fn}`;
    const existing = fieldsWrittenByFn.get(key);
    if (existing) existing.add(field);
    else fieldsWrittenByFn.set(key, new Set([field]));
  };
  const linesByFile = new Map<string, string[]>();

  for (const file of files) {
    const lines = file.text.split("\n");
    linesByFile.set(file.path, lines);
    const aliases = collectAliasBindings(lines);
    const boundaries = collectFunctionBoundaries(lines);

    for (const [i, line] of lines.entries()) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue; // comments are not writes

      const makeSite = (field: string, viaAlias: string | null): WriteSite => ({
        file: file.path,
        line: i + 1,
        snippet: trimmed.slice(0, 140),
        // Wholesale = the whole field is replaced with a fresh object, no sub-path. Must catch
        // BOTH shapes: multi-line `conv.x = {` AND single-line
        // `conv.appointment = { status: "none", updatedAt: nowIso() };` — production is full of
        // the latter, and an end-of-line-only test scored every one of them as a harmless poke.
        wholesale: false,
        guarded: isWriteGuarded(lines, i),
        fn: enclosingFunction(boundaries, i),
        viaAlias
      });

      // 1) Direct writes: conv.field = / conv.field.sub = / (conv as any).field =
      for (const root of STATE_ROOTS) {
        const pattern = buildAssignmentPattern(root);
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line))) {
          const field = match[1];
          if (IGNORED_FIELDS.has(field)) continue;
          if (isNonContendingWrite(trimmed)) continue;
          const site = makeSite(field, null);
          site.wholesale = !match[2] && /=\s*\{/.test(trimmed);
          noteFieldWrite(file.path, site.fn, field);
          push(field, site);
        }
      }

      // 2) Aliased writes: `const appt = conv.appointment` … `appt.status = …`
      for (const binding of aliases) {
        if (binding.line >= i) continue; // the binding must precede the write
        // most-recent binding of this alias name wins
        const shadowed = aliases.some(
          other => other.alias === binding.alias && other.line > binding.line && other.line < i
        );
        if (shadowed) continue;
        // …and it must still be IN SCOPE: a local binding cannot reach into another function.
        if (enclosingFunction(boundaries, binding.line) !== enclosingFunction(boundaries, i)) continue;
        const aliasWrite = new RegExp(
          `\\b${binding.alias}\\.[A-Za-z_][A-Za-z0-9_]*(?:\\??\\.[A-Za-z_][A-Za-z0-9_]*)*\\s*\\??=(?!=|>)`
        );
        if (!aliasWrite.test(trimmed)) continue;
        if (isNonContendingWrite(trimmed)) continue;
        const site = makeSite(binding.field, binding.alias);
        noteFieldWrite(file.path, site.fn, binding.field);
        push(binding.field, site);
      }
    }
  }

  // SECOND PASS — the referee one level down. Now that we know which fields each function writes,
  // an `apply*` that both consults a referee AND owns the field can vouch for its call sites. This
  // has to run after the whole corpus is scanned: the applier lives in conversationStore.ts and
  // the call sites it referees live in index.ts.
  const refereeAppliers = collectRefereeConsultingAppliers(files, fieldsWrittenByFn);
  if (refereeAppliers.size) {
    for (const [field, sites] of byField) {
      for (const site of sites) {
        if (site.guarded) continue;
        const lines = linesByFile.get(site.file);
        if (!lines) continue;
        if (isWriteGuarded(lines, site.line - 1, REFEREE_LOOKBACK_LINES, refereeAppliers, field)) {
          site.guarded = true;
        }
      }
    }
  }
  return byField;
}

/**
 * Is THIS write downstream of a decision?
 *
 * The first cut of this asked a much weaker question — "does any `decide`/`resolve`/`should`/`is`
 * function in the domain layer mention this field name?" — and duly reported that
 * `followUpCadence` had NINE referees. PR #398 is proof it had none: two writers disagreed and
 * nothing arbitrated. A domain function merely NAMING a field says nothing about whether the code
 * that writes it ever asks.
 *
 * So the test is per-WRITE-SITE and local: within the preceding `lookback` lines, does this code
 * consult a `decide*`/`resolve*` function? That is the actual pattern we want
 * (`decideFinanceDeclinedCadence` called immediately before the cadence is set), and its absence
 * is exactly the "everyone writes, nobody referees" shape.
 *
 * `should*`/`is*` are NOT accepted: they are predicates used everywhere for every purpose, and
 * counting them would re-open the same false-comfort hole.
 */
export const REFEREE_LOOKBACK_LINES = 40;

const REFEREE_CALL = /\b(?:decide|resolve)[A-Z][A-Za-z0-9_]*\s*\(/;

/**
 * THE REFEREE ONE LEVEL DOWN — why a direct `decide*` match is not enough.
 *
 * Every un-stacking so far landed the same shape: the referee is a pure `decide*` in
 * routeStateReducer.ts, and the write sites do not call it directly — they call a thin
 * `apply*` wrapper (`applyAppointmentTeardown`, `applyCadenceQuietWindow`,
 * `applyManualCadenceRestart`) that asks the referee and then performs the writes. So a call site
 * that has been PROPERLY un-stacked, and any cause-specific write it does immediately after,
 * still read as "decides for itself". Finished work scored as outstanding work, which is how the
 * queue could never reach zero however much of it got fixed.
 *
 * WHY THIS IS NOT A LOOSENING. The tempting version — "accept any `apply*`" — would be a
 * disaster, and measurably so: 39 of the 177 unrefereed writes have SOME `apply*` within 40 lines
 * above them, but almost all of those are the enclosing function's own declaration line
 * (`async function applyOutcomeSold(`) or an unrelated helper (`applyWatchFieldHygiene`,
 * `applyDeterministicToneOverrides`) that arbitrates nothing. Accepting them would reinstate
 * exactly the false comfort cut 1 was built to remove.
 *
 * So the credit is PROVEN, not assumed, on three counts:
 *   1. the applier's OWN BODY must contain a `decide*`/`resolve*` call — derived from the source,
 *      never a hand-maintained allowlist that would rot;
 *   2. the applier must itself WRITE THE FIELD IN QUESTION, so it is arbitrating THIS state and
 *      not merely standing nearby. Without this the rule mis-credits fast: `maybeStartCadence`
 *      calls `applyPendingIncomingInventoryState` (a referee-consulting applier, but for
 *      inventory state) fourteen lines above its own hand-built `conv.followUpCadence = {…}`,
 *      and that unrefereed cadence writer would have silently left the queue; and
 *   3. the matched line must be a CALL, not that applier's declaration — otherwise every write
 *      anywhere inside a long applier would be credited by its own signature line, which is the
 *      leak `isWriteGuarded`'s function-boundary stop was added to close.
 * `should*`/`is*` remain rejected at every level: a predicate is not an arbiter.
 *
 * FAIL DIRECTION: crediting can only REMOVE work from the queue, so every one of those three is a
 * proof obligation, never a heuristic. When in doubt the write stays counted.
 */
export type RefereeApplierIndex = ReadonlyMap<string, ReadonlySet<string>>;

/** `apply*` functions that consult a referee — mapped to the state fields they actually write. */
export function collectRefereeConsultingAppliers(
  files: SourceFile[],
  fieldsWrittenByFn: ReadonlyMap<string, ReadonlySet<string>>
): RefereeApplierIndex {
  const out = new Map<string, Set<string>>();
  for (const file of files) {
    const lines = file.text.split("\n");
    const boundaries = collectFunctionBoundaries(lines);
    for (const [i, line] of lines.entries()) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      if (!REFEREE_CALL.test(trimmed)) continue;
      const fn = enclosingFunction(boundaries, i);
      if (!/^apply[A-Z]/.test(fn)) continue;
      const fields = fieldsWrittenByFn.get(`${file.path}::${fn}`);
      if (!fields || !fields.size) continue; // consults a referee but writes no tracked state
      const existing = out.get(fn);
      if (existing) for (const f of fields) existing.add(f);
      else out.set(fn, new Set(fields));
    }
  }
  return out;
}

export function isWriteGuarded(
  lines: string[],
  lineIndex: number,
  lookback: number = REFEREE_LOOKBACK_LINES,
  refereeAppliers?: RefereeApplierIndex,
  field?: string
): boolean {
  const start = Math.max(0, lineIndex - lookback);
  // Only appliers that arbitrate THIS field can vouch for this write.
  const owners = field
    ? [...(refereeAppliers?.keys() ?? [])].filter(fn => refereeAppliers!.get(fn)!.has(field))
    : [];
  const applierCall = owners.length ? new RegExp(`\\b(${owners.join("|")})\\s*\\(`) : null;
  for (let i = lineIndex; i >= start; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    // STOP AT THE FUNCTION BOUNDARY. A column-0 `}` closes the PREVIOUS top-level function, so
    // anything above it is a different function and cannot be refereeing this write. Without this
    // the lookback leaks: a new unrefereed write parked a few lines below someone else's
    // `decide*` call read as guarded, which is how a re-stack could slip past the ratchet
    // (found by sabotage-testing it, 2026-08-01).
    if (/^\}/.test(line)) return false;
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (REFEREE_CALL.test(trimmed)) return true;
    // …or a call to an applier that asks a referee on this code's behalf. A declaration line is
    // not a call: `function applyCadenceQuietWindow(` must never credit its own body.
    if (applierCall && applierCall.test(trimmed) && !isFunctionDeclarationLine(trimmed)) return true;
  }
  return false;
}

/** `export function applyX(` / `const applyX = (` — a definition, not a call site. */
function isFunctionDeclarationLine(trimmed: string): boolean {
  return /^(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_]|^(?:export\s+)?const\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:async\s*)?\(/.test(
    trimmed
  );
}

/**
 * Collapse adjacent writes into WRITERS.
 *
 * Raw write counts over-report badly: `conv.appointment` takes 298 of them, but most are
 * `conv.appointment.whenText = …`, `…whenIso = …` on consecutive lines inside ONE function that
 * legitimately owns the appointment. Those cannot fight each other — they run in sequence.
 *
 * A fight needs two INDEPENDENT places that can each set the state, which is what today's bug was:
 * the To-Do outcome handler and the manual-outbound handler, in different functions, 37 seconds
 * apart. So writes within `gap` lines of each other in the same file collapse to a single writer.
 *
 * FAIL DIRECTION: this UNDER-counts (two genuinely separate writers inside the same 15 lines read
 * as one). Under-counting suits a work queue — every field it surfaces is real.
 */
export const WRITER_CLUSTER_GAP_LINES = 15;

export function countWriters(sites: WriteSite[], gap: number = WRITER_CLUSTER_GAP_LINES): WriteSite[] {
  const sorted = [...sites].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const leaders: WriteSite[] = [];
  const seenFn = new Set<string>();
  let lastFile = "";
  let lastLine = -Infinity;
  for (const site of sorted) {
    // PRIMARY: one enclosing function = one writer, however many branches it contains. A caller
    // invokes it as a unit, so its internal branches cannot disagree with each other.
    const fnKey = `${site.file}::${site.fn}`;
    if (site.fn && site.fn !== "(top-level)") {
      if (seenFn.has(fnKey)) continue;
      seenFn.add(fnKey);
      leaders.push(site);
      lastFile = site.file;
      lastLine = site.line;
      continue;
    }
    // FALLBACK: no resolvable enclosing function — fall back to line proximity.
    if (site.file !== lastFile || site.line - lastLine > gap) leaders.push(site);
    lastFile = site.file;
    lastLine = site.line;
  }
  return leaders;
}

export function rankContention(files: SourceFile[], opts?: { minWrites?: number }): FieldContention[] {
  const minWrites = opts?.minWrites ?? 5;
  const byField = findWriteSites(files);
  const out: FieldContention[] = [];
  for (const [field, sites] of byField) {
    if (sites.length < minWrites) continue;
    const files_ = [...new Set(sites.map(s => s.file))].sort();
    const guardedWrites = sites.filter(s => s.guarded).length;
    const writerSites = countWriters(sites);
    const unrefereedWriterSites = writerSites.filter(s => !s.guarded);
    out.push({
      field,
      writeSites: sites,
      files: files_,
      wholesaleWrites: sites.filter(s => s.wholesale).length,
      guardedWrites,
      unguardedWrites: sites.length - guardedWrites,
      writes: sites.length,
      writers: writerSites.length,
      unrefereedWriters: unrefereedWriterSites.length,
      unrefereedWriterSites
    });
  }
  // Worst first by UNREFEREED WRITERS — independent places that can each set the state and none of
  // them asking anyone. That is the fight surface; raw write counts are noise beside it.
  return out.sort(
    (a, b) => b.unrefereedWriters - a.unrefereedWriters || b.files.length - a.files.length
  );
}

/**
 * The un-stacking queue: fields with a real fight surface, worst first. This is what the daily
 * review works — one per run.
 *
 * `minUnguarded` is 2 because one writer cannot fight anything; contention needs two that can
 * disagree.
 */
export function unstackingQueue(
  ranked: FieldContention[],
  opts?: { minUnguarded?: number }
): FieldContention[] {
  const minUnguarded = opts?.minUnguarded ?? 2;
  return ranked.filter(f => f.unrefereedWriters >= minUnguarded);
}
