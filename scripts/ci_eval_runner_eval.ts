/**
 * ci:eval runner guard — deterministic, no network, no LLM.
 *
 * WHAT IS AT RISK. `scripts/ci_eval_runner.ts` runs the gate. A bug in it does not produce a wrong
 * reply to a customer — it produces a GREEN GATE THAT CHECKED LESS THAN IT CLAIMED, which is the
 * one failure mode nothing downstream can catch. So this file does not assert on the runner's
 * source text (a source assertion cannot prove a script still executes — measured 2026-08-05, when
 * a `ReferenceError` killed a watchdog while every text assertion stayed green). It BUILDS A
 * FIXTURE REPO and RUNS the real runner against it as a child process, then reads what actually
 * happened.
 *
 * The four properties worth paying for, each proved by execution:
 *   1. EVERY entry runs, exactly once. The fixture scripts append to a log; the log is counted.
 *   2. A failure inside a concurrent batch is RE-RUN ALONE before it is believed. The fixture's
 *      `flaky:eval` fails its first run and passes its second, and the whole run must exit 0.
 *   3. A REAL failure still fails. `bad:eval` always exits 1 and the runner must exit 1 — this is
 *      the assertion that stops the re-run mechanism from becoming a way to swallow red.
 *   4. A sequential entry is a BARRIER: nothing queued before it is still running when it starts,
 *      and nothing after it starts until it is done — proved with a slow neighbour, so a runner
 *      that ignored the barrier would interleave and be caught.
 *
 * Plus one property about the refactor that made the runner possible: `parseCiEvalChain` moved out
 * of `ci_eval_chain_guard_eval.ts` into `ci_eval_chain.ts`. If that move had quietly stopped the
 * guard running, the manifest protection would be gone with nothing red. So the guard is executed
 * here too, against a fixture, in both directions: clean manifest ⇒ exit 0, dropped entry ⇒ non-zero.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCiEvalChain } from "./ci_eval_chain.ts";
import {
  SEQUENTIAL_ENTRIES,
  batchOrder,
  buildEntries,
  planBatches,
} from "./ci_eval_runner.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, "ci_eval_runner.ts");
const GUARD = path.join(HERE, "ci_eval_chain_guard_eval.ts");

let checks = 0;
const check = (label: string, fn: () => void) => {
  fn();
  checks += 1;
  console.log(`  ok  ${label}`);
};

// --- 1. Batching, as plain functions ------------------------------------------------------------

const entriesFrom = (names: string[], sequential: string[] = []) =>
  buildEntries(
    names,
    Object.fromEntries(names.map(n => [n, `echo ${n}`])),
    sequential
  );

check("consecutive independent entries collapse into ONE concurrent batch", () => {
  const batches = planBatches(entriesFrom(["a", "b", "c"]));
  assert.equal(batches.length, 1);
  assert.equal(batches[0].kind, "concurrent");
  assert.equal(batches[0].entries.length, 3);
});

check("a sequential entry splits the run into before / it / after", () => {
  const batches = planBatches(entriesFrom(["a", "b", "wall", "c"], ["wall"]));
  assert.deepEqual(
    batches.map(b => `${b.kind}:${b.entries.map(e => e.name).join("+")}`),
    ["concurrent:a+b", "sequential:wall", "concurrent:c"]
  );
});

check("a sequential entry always runs ALONE, never beside a neighbour", () => {
  const batches = planBatches(entriesFrom(["w1", "w2"], ["w1", "w2"]));
  assert.deepEqual(batches.map(b => b.entries.length), [1, 1]);
  assert.ok(batches.every(b => b.kind === "sequential"));
});

check("batching never drops, duplicates, or reorders an entry", () => {
  const names = ["a", "b", "wall", "c", "d", "wall2", "e"];
  const order = batchOrder(planBatches(entriesFrom(names, ["wall", "wall2"])));
  assert.deepEqual(order, names, "the flattened plan is the chain, unchanged");
});

check("an entry with no script behind it is a hard error, never a silent skip", () => {
  assert.throws(
    () => buildEntries(["ghost:eval"], { "a:eval": "echo a" }),
    /does not exist: ghost:eval/
  );
});

// --- 2. The declared sequential set is real -----------------------------------------------------

check("every name in SEQUENTIAL_ENTRIES is actually in the chain", () => {
  const chain = new Set(parseCiEvalChain(JSON.parse(fs.readFileSync("package.json", "utf8")).scripts["ci:eval"]));
  const stale = SEQUENTIAL_ENTRIES.filter(name => !chain.has(name));
  assert.deepEqual(
    stale,
    [],
    `SEQUENTIAL_ENTRIES names ${stale.join(", ")}, which the chain no longer runs — a renamed eval ` +
      "would otherwise keep a barrier that protects nothing while reading as if it did"
  );
});

// --- 3. Fixture: run the REAL runner and read what happened -------------------------------------

/** A throwaway repo with a `ci:eval` chain of shell one-liners. `--pkg`/`--cwd` point the runner at
 *  it, so nothing here touches the real chain. */
function makeFixture(chain: string[], scripts: { [k: string]: string }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-eval-runner-fixture-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ scripts: { ...scripts, "ci:eval": chain.map(n => `npm run ${n}`).join(" && ") } }, null, 2)
  );
  return dir;
}

function runRunner(dir: string, extra: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(
      "npx",
      ["tsx", RUNNER, "--pkg", path.join(dir, "package.json"), "--cwd", dir, ...extra],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

check("EXECUTED: every entry runs exactly once, and the runner exits 0", () => {
  const dir = makeFixture(
    ["a:eval", "b:eval", "c:eval"],
    {
      "a:eval": "echo a >> ran.log",
      "b:eval": "echo b >> ran.log",
      "c:eval": "echo c >> ran.log",
    }
  );
  const { code, out } = runRunner(dir, ["--concurrency", "3"]);
  const ran = fs.readFileSync(path.join(dir, "ran.log"), "utf8").trim().split("\n").sort();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 0, `runner should pass a clean chain\n${out}`);
  assert.deepEqual(ran, ["a", "b", "c"], "each entry ran once — not zero times, not twice");
});

check("EXECUTED: a failure inside a concurrent batch is RE-RUN ALONE and the run still passes", () => {
  // Fails while its marker is absent, creates it, so the second attempt succeeds. This is exactly
  // the shape of a race: unreproducible when run on its own.
  const dir = makeFixture(
    ["a:eval", "flaky:eval"],
    {
      "a:eval": "echo a >> ran.log",
      "flaky:eval": "if [ -f marker ]; then echo flaky-passed >> ran.log; else touch marker; exit 1; fi",
    }
  );
  const { code, out } = runRunner(dir, ["--concurrency", "2"]);
  const ran = fs.readFileSync(path.join(dir, "ran.log"), "utf8");
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 0, `a failure that does not reproduce alone must not redden the gate\n${out}`);
  assert.ok(out.includes("re-running alone"), "the re-run must be announced, not silent");
  assert.ok(ran.includes("flaky-passed"), "the re-run actually executed the entry again");
  assert.ok(
    out.includes("1 concurrent failure(s) cleared on re-run"),
    "the summary must say a re-run happened, so a chain quietly full of races is visible"
  );
});

check("EXECUTED: a REAL failure still fails — the re-run cannot swallow red", () => {
  const dir = makeFixture(
    ["a:eval", "bad:eval"],
    { "a:eval": "echo a", "bad:eval": "echo the-real-reason >&2; exit 1" }
  );
  const { code, out } = runRunner(dir, ["--concurrency", "2"]);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 1, "an eval that fails both times must fail the run");
  assert.ok(out.includes("FAIL (real)"), "the second failure is reported as real");
  assert.ok(out.includes("the-real-reason"), "the failing eval's own output is printed, not swallowed");
});

check("EXECUTED: a sequential entry is a barrier — nothing overlaps it in either direction", () => {
  // `slow:eval` sleeps, so a runner that ignored the barrier would start `wall:eval` (and `after`)
  // while it was still going, and the order log would interleave.
  const dir = makeFixture(
    ["slow:eval", "quick:eval", "wall:eval", "after:eval"],
    {
      "slow:eval": "sleep 1; echo slow-end >> order.log",
      "quick:eval": "echo quick-end >> order.log",
      "wall:eval": "echo wall-start >> order.log; echo wall-end >> order.log",
      "after:eval": "echo after-end >> order.log",
    }
  );
  const { code, out } = runRunner(dir, ["--concurrency", "4", "--sequential-entries", "wall:eval"]);
  const order = fs.readFileSync(path.join(dir, "order.log"), "utf8").trim().split("\n");
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 0, out);
  assert.deepEqual(
    order,
    ["quick-end", "slow-end", "wall-start", "wall-end", "after-end"],
    "the slow neighbour FINISHES before the barrier starts, and the barrier finishes before what follows"
  );
});

// --- 4. The refactor did not switch the chain guard off -----------------------------------------

function makeGuardFixture(chainNames: string[], manifestNames: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-eval-guard-fixture-"));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      scripts: {
        ...Object.fromEntries(chainNames.map(n => [n, "true"])),
        "ci:eval": chainNames.map(n => `npm run ${n}`).join(" && "),
      },
    })
  );
  fs.writeFileSync(
    path.join(dir, "scripts", "ci_eval_chain_manifest.json"),
    JSON.stringify({ required: manifestNames })
  );
  return dir;
}

function runGuard(dir: string): number {
  try {
    execFileSync("npx", ["tsx", GUARD], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
}

check("EXECUTED: the chain guard still passes a healthy chain after the parser moved out", () => {
  const dir = makeGuardFixture(["ci_eval_chain_guard:eval", "a:eval"], ["ci_eval_chain_guard:eval", "a:eval"]);
  const code = runGuard(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 0, "a chain matching its manifest is green");
});

check("EXECUTED: the chain guard still CATCHES a dropped eval — the move did not disable it", () => {
  const dir = makeGuardFixture(["ci_eval_chain_guard:eval"], ["ci_eval_chain_guard:eval", "a:eval"]);
  const code = runGuard(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.notEqual(code, 0, "dropping an eval the manifest requires must still be a hard failure");
});

console.log(`PASS ci:eval runner (${checks} checks)`);
