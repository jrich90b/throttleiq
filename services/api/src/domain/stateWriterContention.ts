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
 * `x.field = x.field ?? {}` / `|| {}` — idempotent lazy-init, not a value write. Counting these
 * produced pure noise: every `financeOutcomeNotify` and `crm` "writer" was one of these.
 */
function isLazyInit(trimmed: string, field: string): boolean {
  return new RegExp(`\\.${field}\\s*=\\s*[^=]*\\.${field}\\s*(?:\\?\\?|\\|\\|)\\s*\\{\\s*\\}`).test(trimmed);
}

export function findWriteSites(files: SourceFile[]): Map<string, WriteSite[]> {
  const byField = new Map<string, WriteSite[]>();
  const push = (field: string, site: WriteSite) => {
    const existing = byField.get(field);
    if (existing) existing.push(site);
    else byField.set(field, [site]);
  };

  for (const file of files) {
    const lines = file.text.split("\n");
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
          if (isLazyInit(trimmed, field)) continue;
          const site = makeSite(field, null);
          site.wholesale = !match[2] && /=\s*\{/.test(trimmed);
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
        const aliasWrite = new RegExp(
          `\\b${binding.alias}\\.[A-Za-z_][A-Za-z0-9_]*(?:\\??\\.[A-Za-z_][A-Za-z0-9_]*)*\\s*\\??=(?!=|>)`
        );
        if (!aliasWrite.test(trimmed)) continue;
        if (isLazyInit(trimmed, binding.field)) continue;
        push(binding.field, makeSite(binding.field, binding.alias));
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

export function isWriteGuarded(
  lines: string[],
  lineIndex: number,
  lookback: number = REFEREE_LOOKBACK_LINES
): boolean {
  const start = Math.max(0, lineIndex - lookback);
  for (let i = lineIndex; i >= start; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (REFEREE_CALL.test(trimmed)) return true;
  }
  return false;
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
