/**
 * ci:eval runner — run the SAME chain, in the same order, with independent evals overlapped.
 *
 * WHY THIS EXISTS (measured 2026-08-07/08). `npm run ci:eval` is a 457-entry `&&` chain that takes
 * **21.1 minutes**. Almost none of that is work: 379 of the entries finish in under a second, and
 * the ten slowest are only ~36% of the clock. The time is ~80 LLM-backed evals waiting in line for
 * each other, one HTTP round-trip at a time.
 *
 * That wait is not merely annoying — it is the loop's real throughput ceiling, and it corrupts
 * proofs. `main` moves while a gate runs, so a green result can be green about a tree that no
 * longer exists (three consecutive runs on 2026-08-07 were invalidated that way, none of the
 * merges touching the files under test). Shortening the proof window is the fix.
 *
 * WHAT IT DOES NOT DO. It does not decide which evals exist, does not edit the chain, and does not
 * change any eval. `ci:eval` in package.json remains the single source of truth and the definition
 * of the gate; this runner PARSES that string (through `ci_eval_chain.ts`, the same module the
 * chain guard uses, so the two can never drift) and executes the same entries. `npm run ci:eval`
 * still works exactly as before and is the one-word revert.
 *
 * THE ORDERING CONTRACT. Entries listed in SEQUENTIAL_ENTRIES run ALONE, as barriers: everything
 * queued before them finishes first, and nothing starts until they are done. So every ordering
 * relationship that involves a sequential entry is preserved exactly. Within a batch of concurrent
 * entries there is no order — which is precisely the claim SEQUENTIAL_ENTRIES exists to make
 * safe, and why an entry goes on that list on MEASURED evidence (see --audit-writes) rather than
 * on a hunch.
 *
 * THE FAIL DIRECTION, which is the whole reason this is safe to adopt:
 *   - A false RED is caught and repaired: any entry that fails inside a concurrent batch is
 *     RE-RUN ALONE, and only a second failure is reported. A race costs one re-run, not a red gate.
 *   - A false GREEN is what would actually be dangerous, so nothing here can produce one by
 *     skipping work: every entry in the chain is executed exactly once (twice if it fails), and a
 *     missing or undefined entry is a hard error. The runner cannot silently drop an eval — that
 *     is `ci_eval_chain_guard:eval`'s job and it still runs inside this chain.
 *
 * MODES
 *   npx tsx scripts/ci_eval_runner.ts                  # concurrent (default 6)
 *   npx tsx scripts/ci_eval_runner.ts --concurrency 1  # identical to the plain chain
 *   npx tsx scripts/ci_eval_runner.ts --audit-writes    # sequential + attribute shared-file writes
 *   npx tsx scripts/ci_eval_runner.ts --list            # print the partition, run nothing
 *   npx tsx scripts/ci_eval_runner.ts --only a:eval,b:eval
 *   npx tsx scripts/ci_eval_runner.ts --pkg <path> --cwd <dir>   # used by the eval, against a fixture
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

import path from "node:path";

import { parseCiEvalChain } from "./ci_eval_chain.ts";

/**
 * Entries that must run ALONE, with everything before them finished first.
 *
 * MEASURED, not guessed. `--audit-writes` ran the whole chain sequentially on 2026-08-08 and
 * recorded, for every one of the 457 entries, which files under the shared trees (`reports/`,
 * `data/`) it created or modified. Nine distinct files were touched. Seven of them have exactly
 * ONE owner, so no other process can interfere with them. Two are shared:
 *
 *   - **`data/conversations.json` — 7 entries** (the seven below). A shared JSON store that each
 *     one reads, modifies and writes back. Two of those overlapping is a genuine lost update, and
 *     a reader could see a half-written file. THIS is what the list is for. All seven finish in
 *     under 1.2s, so the barriers cost ~nothing.
 *
 *   - **`data/openai_usage/2026-08.jsonl` — 49 entries.** Deliberately NOT here. It is an
 *     append-only accounting ledger: `openaiUsageLogger.ts` writes one line per API call with
 *     `fs.appendFileSync` (O_APPEND, so the offset update is atomic) and swallows every error by
 *     design — "usage logging is accounting support only; never block customer workflows".
 *     Nothing in the chain reads it: `openai_usage_pricing:eval` asserts on the logger's SOURCE,
 *     not on its output. Concurrent appends therefore cannot change any eval's verdict.
 *
 * Things that also turned out NOT to need it, each checked by reading the code:
 *   - `worker_dispatch:eval` binds a port, but `server.listen(0)` takes an ephemeral one.
 *   - The report-writing audits (`answer_correctness`, `context_fidelity`, `intent_handled`,
 *     `compliance`, `voice_charter`, `booking_funnel`, …) all run with `--self-test` in the chain,
 *     which returns before the report-writing path. In the gate they touch nothing shared — the
 *     write audit confirms it: not one of them appears in the touched-file list.
 *   - The ~55 evals that set `CONVERSATIONS_DB_PATH` point it at `os.tmpdir()` under their own
 *     distinct name, and the root `.env` does not pin that variable, so there is no shared store.
 *   - `ci_eval_chain_guard:eval` only writes its manifest under `--update`, which the chain never
 *     passes.
 *
 * Keep this list SHORT and each line justified, and re-derive it with `--audit-writes` rather than
 * adding to it on a hunch. An entry added "just to be safe" costs wall clock on every gate run for
 * everyone, forever.
 */
export const SEQUENTIAL_ENTRIES: readonly string[] = [
  // All seven read-modify-write the shared `data/conversations.json`.
  "finance_rate_policy:eval",
  "parts_turn_precedence:eval",
  "test_ride_stock_check_first:eval",
  "failed_manual_send_provenance:eval",
  "manual_quote_followup:eval",
  "cadence_manual_advance:eval",
  "meta_promo_followup_cadence:eval",
];

export type ChainEntry = { name: string; command: string; sequential: boolean };
export type Batch = { kind: "concurrent" | "sequential"; entries: ChainEntry[] };

/**
 * Group the chain into runnable batches, IN ORDER. Consecutive concurrent entries collapse into
 * one batch; each sequential entry becomes its own batch, which is what makes it a barrier.
 */
export function planBatches(entries: ChainEntry[]): Batch[] {
  const batches: Batch[] = [];
  for (const entry of entries) {
    if (entry.sequential) {
      batches.push({ kind: "sequential", entries: [entry] });
      continue;
    }
    const last = batches[batches.length - 1];
    if (last && last.kind === "concurrent") last.entries.push(entry);
    else batches.push({ kind: "concurrent", entries: [entry] });
  }
  return batches;
}

/** The flattened running order — used to prove no entry is dropped, duplicated, or reordered
 *  across a barrier. */
export function batchOrder(batches: Batch[]): string[] {
  return batches.flatMap(b => b.entries.map(e => e.name));
}

export function buildEntries(
  chain: string[],
  scripts: { [k: string]: string },
  sequentialNames: readonly string[] = SEQUENTIAL_ENTRIES
): ChainEntry[] {
  const sequential = new Set(sequentialNames);
  return chain.map(name => {
    const command = scripts[name];
    if (!command) throw new Error(`ci:eval references a script that does not exist: ${name}`);
    return { name, command, sequential: sequential.has(name) };
  });
}

export type RunResult = {
  name: string;
  ok: boolean;
  ms: number;
  code: number | null;
  output: string;
  rerunAlone: boolean;
};

function runOne(entry: ChainEntry, cwd: string): Promise<RunResult> {
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(entry.command, {
      cwd,
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const capture = (chunk: Buffer) => {
      output += chunk.toString();
      // Bound the buffer: a runaway eval must not take the runner down with it.
      if (output.length > 400_000) output = `${output.slice(0, 200_000)}\n…[truncated]…\n`;
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", err => {
      resolve({
        name: entry.name,
        ok: false,
        ms: Date.now() - started,
        code: null,
        output: `${output}\nspawn failed: ${String(err)}`,
        rerunAlone: false,
      });
    });
    child.on("close", code => {
      resolve({
        name: entry.name,
        ok: code === 0,
        ms: Date.now() - started,
        code,
        output,
        rerunAlone: false,
      });
    });
  });
}

/** Run a list of entries with at most `limit` in flight. Resolves when all have finished — this
 *  never short-circuits, because a batch that abandoned its siblings would leave the chain
 *  half-run and the summary would be a lie about what was checked. */
async function runPool(entries: ChainEntry[], limit: number, cwd: string, onDone: (r: RunResult) => void) {
  const queue = [...entries];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      onDone(await runOne(next, cwd));
    }
  });
  await Promise.all(workers);
}

// --- shared-write attribution (--audit-writes) --------------------------------------------------

const SHARED_TREES = ["reports", "data"];

function snapshotShared(cwd: string): Map<string, number> {
  const seen = new Map<string, number>();
  const walk = (dir: string) => {
    let listing: fs.Dirent[];
    try {
      listing = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of listing) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else {
        try {
          seen.set(full, fs.statSync(full).mtimeMs);
        } catch {
          /* raced away; nothing to attribute */
        }
      }
    }
  };
  for (const tree of SHARED_TREES) walk(path.join(cwd, tree));
  return seen;
}

function diffShared(before: Map<string, number>, after: Map<string, number>): string[] {
  const touched: string[] = [];
  for (const [file, mtime] of after) {
    const prior = before.get(file);
    if (prior === undefined || prior !== mtime) touched.push(file);
  }
  for (const file of before.keys()) if (!after.has(file)) touched.push(`${file} (removed)`);
  return touched.sort();
}

// --- main ---------------------------------------------------------------------------------------

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

async function main() {
  const cwd = arg("--cwd") ?? process.cwd();
  const pkgPath = arg("--pkg") ?? path.join(cwd, "package.json");
  const auditWrites = process.argv.includes("--audit-writes");
  const concurrency = auditWrites ? 1 : Number(arg("--concurrency", "6"));
  const only = arg("--only");

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { scripts: { [k: string]: string } };
  let chain = parseCiEvalChain(pkg.scripts["ci:eval"]);
  if (only) {
    const wanted = new Set(only.split(",").map(s => s.trim()).filter(Boolean));
    chain = chain.filter(name => wanted.has(name));
  }
  // `--sequential-entries` exists so the barrier can be exercised against a fixture chain; the real
  // gate takes SEQUENTIAL_ENTRIES and passes nothing.
  const overrideSequential = arg("--sequential-entries");
  const sequentialNames = overrideSequential
    ? overrideSequential.split(",").map(s => s.trim()).filter(Boolean)
    : SEQUENTIAL_ENTRIES;
  const entries = buildEntries(chain, pkg.scripts, sequentialNames);
  const batches = planBatches(entries);

  if (process.argv.includes("--list")) {
    for (const batch of batches) {
      console.log(`${batch.kind}(${batch.entries.length}): ${batch.entries.map(e => e.name).join(", ")}`);
    }
    console.log(`\n${entries.length} entries, ${batches.length} batches, concurrency ${concurrency}`);
    return;
  }

  console.log(
    `ci:eval runner — ${entries.length} entries, ${batches.length} batch(es), concurrency ${concurrency}` +
      `${auditWrites ? " (write-attribution mode: sequential)" : ""}`
  );

  const results: RunResult[] = [];
  const writeAttribution: { name: string; touched: string[] }[] = [];
  const started = Date.now();
  let finished = 0;

  const report = (r: RunResult) => {
    finished += 1;
    const mark = r.ok ? "ok  " : "FAIL";
    console.log(
      `  [${String(finished).padStart(3)}/${entries.length}] ${mark} ${(r.ms / 1000).toFixed(1)}s  ${r.name}`
    );
  };

  for (const batch of batches) {
    if (auditWrites) {
      for (const entry of batch.entries) {
        const before = snapshotShared(cwd);
        const result = await runOne(entry, cwd);
        const touched = diffShared(before, snapshotShared(cwd));
        if (touched.length) writeAttribution.push({ name: entry.name, touched });
        results.push(result);
        report(result);
      }
      continue;
    }
    if (batch.kind === "sequential") {
      const result = await runOne(batch.entries[0], cwd);
      results.push(result);
      report(result);
      continue;
    }
    const batchResults: RunResult[] = [];
    await runPool(batch.entries, concurrency, cwd, r => {
      batchResults.push(r);
      report(r);
    });
    // A failure inside a concurrent batch is SUSPECT, not a verdict: re-run it alone before
    // believing it. This is what keeps a race from ever reddening the gate.
    for (const suspect of batchResults) {
      if (suspect.ok) {
        results.push(suspect);
        continue;
      }
      console.log(`  re-running alone (was it a race?): ${suspect.name}`);
      const entry = batch.entries.find(e => e.name === suspect.name)!;
      const alone = await runOne(entry, cwd);
      results.push({ ...alone, rerunAlone: true });
      console.log(`  ${alone.ok ? "ok   (race — the concurrent failure was not real)" : "FAIL (real)"}  ${suspect.name}`);
    }
  }

  const wallMs = Date.now() - started;
  const failures = results.filter(r => !r.ok);
  const races = results.filter(r => r.rerunAlone && r.ok);

  console.log("\n--- slowest 10 ---");
  for (const r of [...results].sort((a, b) => b.ms - a.ms).slice(0, 10)) {
    console.log(`  ${(r.ms / 1000).toFixed(1).padStart(7)}s  ${r.name}`);
  }

  if (writeAttribution.length) {
    console.log("\n--- entries that touched a shared tree (reports/, data/) ---");
    for (const row of writeAttribution) {
      console.log(`  ${row.name}`);
      for (const file of row.touched.slice(0, 6)) console.log(`      ${path.relative(cwd, file)}`);
      if (row.touched.length > 6) console.log(`      …and ${row.touched.length - 6} more`);
    }
    console.log(
      "\n  Any FILE named by two different entries above means those entries must be listed in" +
        "\n  SEQUENTIAL_ENTRIES. A file named by only one entry is that entry's own business."
    );
  }

  console.log(
    `\nci:eval runner: ${results.length - failures.length}/${results.length} passed in ` +
      `${(wallMs / 60000).toFixed(1)} min (${races.length} concurrent failure(s) cleared on re-run)`
  );

  if (failures.length) {
    console.log(`\n${failures.length} eval(s) FAILED:`);
    for (const f of failures) {
      console.log(`\n===== ${f.name} (exit ${f.code}) =====\n${f.output.slice(-4000)}`);
    }
    process.exit(1);
  }
}

// Run only when invoked, so `ci_eval_runner:eval` can import the planning functions above without
// kicking off a 457-entry gate run.
if (path.basename(process.argv[1] ?? "") === "ci_eval_runner.ts") await main();
