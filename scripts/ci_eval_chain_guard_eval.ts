/**
 * ci:eval chain guard — the chain may GROW, never silently shrink.
 *
 * THE FAILURE THIS EXISTS FOR (measured 2026-08-05, three PRs in one merge batch). `ci:eval` is a
 * single 400-plus entry `&&` string in package.json. Every PR that adds an eval rewrites that whole
 * string, so its branch carries a SNAPSHOT of the chain as it stood when the branch was cut. Merge
 * that branch weeks later and git resolves the conflict in favour of one side or the other — and
 * taking the PR's side deletes every eval added to main in between.
 *
 * Nothing goes red when that happens. The deleted eval's script definition is still in package.json,
 * `npm run <name>:eval` still works by hand, the suite still passes. It just never runs again. A
 * dropped eval is a gate that reports green while testing nothing, which is strictly worse than not
 * having it — you keep the confidence and lose the coverage.
 *
 * Concretely, on 2026-08-05: #547's branch was missing `customer_risk_referees` and
 * `cadence_advance`; #551's was missing `customer_risk_referees` and `voice_next_step_promise` —
 * the eval #547 had added TWELVE MINUTES EARLIER. Each was resolved by hand that day. The drop-set
 * changes as main moves, so "resolve it carefully" is not a control: it depends on whoever merges
 * noticing, every time, under conflict-resolution pressure, in a 400-entry string.
 *
 * WHY A MANIFEST AND NOT A COUNT. A floor on the entry count would have caught both real incidents
 * (each netted -1), but not the case that nets zero: drop one, add one. The manifest names every
 * entry, so a drop is caught however it is disguised. Additions are free and need no edit here —
 * the manifest is a floor, not an inventory. Removing an eval is still perfectly allowed; it just
 * has to be a DELIBERATE line in this file's diff, where a reviewer sees it, rather than a merge
 * artifact nobody reads.
 *
 * FAIL DIRECTION: this guard only ever fails a build for having FEWER evals than agreed. It cannot
 * block an addition, cannot block a deliberate removal, and has no opinion about which evals should
 * exist. The worst case of a bug in it is a red build on a legitimate removal, fixed by editing the
 * manifest — never a customer-facing behaviour change.
 *
 * NOT COVERED, deliberately: the 50 eval-ish scripts defined in package.json but not in the chain
 * (`*:audit` diagnostics, manual LLM-priced parser evals). Whether each belongs in the gate is a
 * judgement call per script, not something to infer in bulk, so this guard says nothing about them.
 *
 * Deterministic — always runs. Regenerate the manifest deliberately:
 *   npx tsx scripts/ci_eval_chain_guard_eval.ts --update
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const PKG_PATH = "package.json";
const MANIFEST_PATH = "scripts/ci_eval_chain_manifest.json";

type Manifest = { _why?: string; required: string[] };

export function parseCiEvalChain(ciEval: string): string[] {
  return String(ciEval ?? "")
    .split("&&")
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => part.replace(/^npm run /, "").trim());
}

/** Entries the manifest requires that the chain no longer runs. Empty is the only healthy answer. */
export function findDroppedEntries(chain: string[], required: string[]): string[] {
  const present = new Set(chain);
  return required.filter(name => !present.has(name));
}

export function findDuplicateEntries(chain: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const name of chain) {
    if (seen.has(name)) dupes.add(name);
    seen.add(name);
  }
  return [...dupes];
}

/** A chain entry with no script behind it fails the whole run at that point — catch it here instead. */
export function findUndefinedEntries(chain: string[], scripts: { [k: string]: unknown }): string[] {
  return chain.filter(name => !(name in scripts));
}

function readPkg(): { scripts: { [k: string]: string } } {
  return JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
}

function readManifest(): Manifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

if (process.argv.includes("--update")) {
  const chain = parseCiEvalChain(readPkg().scripts["ci:eval"]);
  const manifest = readManifest();
  const added = chain.filter(name => !manifest.required.includes(name));
  const removed = manifest.required.filter(name => !chain.includes(name));
  manifest.required = chain;
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `ci_eval_chain_manifest updated: ${chain.length} entries (+${added.length} / -${removed.length})`
  );
  if (removed.length) console.log(`  REMOVED (make sure this is deliberate): ${removed.join(", ")}`);
  process.exit(0);
}

const pkg = readPkg();
const manifest = readManifest();
const chain = parseCiEvalChain(pkg.scripts["ci:eval"]);

// --- The guard itself -------------------------------------------------------------------------
const dropped = findDroppedEntries(chain, manifest.required);
assert.deepEqual(
  dropped,
  [],
  `ci:eval LOST ${dropped.length} eval(s): ${dropped.join(", ")}\n` +
    "  These are still defined in package.json but no longer run, so the suite is green and blind.\n" +
    "  This is almost always a stale chain merged from an older branch — rebuild the chain from\n" +
    "  main's order and re-insert only your new entry. If the removal IS deliberate, remove it from\n" +
    `  ${MANIFEST_PATH} in the same commit so a reviewer sees it.`
);

const dupes = findDuplicateEntries(chain);
assert.deepEqual(dupes, [], `ci:eval runs the same eval twice: ${dupes.join(", ")}`);

const undefinedEntries = findUndefinedEntries(chain, pkg.scripts);
assert.deepEqual(
  undefinedEntries,
  [],
  `ci:eval references script(s) that do not exist: ${undefinedEntries.join(", ")}`
);

assert.ok(
  chain.length >= manifest.required.length,
  `ci:eval has ${chain.length} entries but the manifest requires ${manifest.required.length}`
);

// The guard has to be in the chain it guards, or it never runs to notice its own removal.
assert.ok(
  chain.includes("ci_eval_chain_guard:eval"),
  "ci_eval_chain_guard:eval must itself be wired into ci:eval"
);

// --- The unit cases, so the helpers are pinned independently of today's package.json ------------
assert.deepEqual(
  parseCiEvalChain("npm run a:eval && npm run b:eval  &&  npm run c:eval"),
  ["a:eval", "b:eval", "c:eval"],
  "the chain parses on && and strips the npm run prefix"
);
assert.deepEqual(parseCiEvalChain(""), [], "an empty chain parses to nothing rather than throwing");

// THE EXACT 2026-08-05 INCIDENTS, as unit cases.
assert.deepEqual(
  findDroppedEntries(["a:eval", "voice_next_step_promise:eval"], ["a:eval", "customer_risk_referees:eval"]),
  ["customer_risk_referees:eval"],
  "#547: a branch missing customer_risk_referees is caught even though it ADDS an eval"
);
assert.deepEqual(
  findDroppedEntries(["a:eval"], ["a:eval", "customer_risk_referees:eval", "voice_next_step_promise:eval"]),
  ["customer_risk_referees:eval", "voice_next_step_promise:eval"],
  "#551: both drops named, including the eval its sibling PR added minutes earlier"
);
// The case a simple entry COUNT would miss: drop one, add one, net zero.
assert.deepEqual(
  findDroppedEntries(["a:eval", "new:eval"], ["a:eval", "old:eval"]),
  ["old:eval"],
  "a drop disguised by an equal-sized addition is still caught — this is why it is not a count"
);
// Additions are free.
assert.deepEqual(
  findDroppedEntries(["a:eval", "b:eval", "c:eval"], ["a:eval", "b:eval"]),
  [],
  "growing the chain needs no manifest edit"
);
assert.deepEqual(findDuplicateEntries(["a:eval", "b:eval", "a:eval"]), ["a:eval"]);
assert.deepEqual(findDuplicateEntries(["a:eval", "b:eval"]), []);
assert.deepEqual(findUndefinedEntries(["a:eval", "ghost:eval"], { "a:eval": "x" }), ["ghost:eval"]);

console.log(
  `PASS ci:eval chain guard (${chain.length} entries, ${manifest.required.length} required; no drops, no duplicates, all defined)`
);
