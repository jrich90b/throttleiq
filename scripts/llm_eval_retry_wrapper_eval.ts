/**
 * Every LLM-backed eval in `ci:eval` must run under the retry wrapper.
 *
 * WHY. An LLM-judged eval fails on luck. Unwrapped, one unlucky call red-lines the whole gate — and
 * because the chain is a single `&&`, everything AFTER it never runs. MEASURED 2026-08-20:
 * `manual_outbound_appointment:eval` was failing ~1 run in 3 on clean `main` (9-run paired A/B), and
 * it sits at position ~45 of 549, so each flake threw away ~92% of the suite and ~45 minutes. A
 * second one, `established_stock_blocks_incoming_arm:eval`, was running with NO wrapper at all at
 * position ~100.
 *
 * The wrapper is not a cure for a bad eval — the day-carry miss behind that 1-in-3 was fixed at the
 * parser, which is the right fix. The wrapper is the floor underneath every OTHER stochastic eval,
 * so a single unlucky sample can never silently skip the back half of the gate.
 *
 * DETECTION IS BY WHAT THE SCRIPT DOES, NOT BY ITS COMMAND. The first sweep for this missed
 * `established_stock_blocks_incoming_arm:eval` precisely because it does not set `LLM_ENABLED=1` in
 * its npm command — it enables the parser inside the script. So this reads each eval's SOURCE and
 * asks whether it can reach a model.
 *
 * FAIL DIRECTION: this can only ever demand MORE retries, never fewer. It cannot make a real
 * regression pass — the wrapper still fails an eval that fails twice.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/**
 * name → why it is deliberately unwrapped. Keep the reason specific: the point is that an exception
 * is a decision somebody wrote down, not an accident nobody noticed.
 */
const EXCLUDED: Record<string, string> = {
  // Empty on purpose, and verified empty: the first draft of this file excluded
  // `parser_stability_sweep:eval` on the reasoning that a wobble-measuring eval must not be retried.
  // That reason was WRONG — the chain entry is the eval's DETERMINISTIC pin (`tsx
  // parser_stability_sweep_eval.ts`, no model call), so it is never flagged, and the LLM-priced sweep
  // is deliberately not in `ci:eval` at all. A plausible-sounding exception that guards nothing is
  // worse than none, so it is gone. Add an entry only after checking the guard actually flags it.
};

/**
 * "Does this eval actually CALL a model at runtime?"
 *
 * Detecting by mention is useless here: dozens of deterministic evals name `requestStructuredJson`
 * or `...WithLLM` inside source-pin assertions about index.ts, and a first pass at this guard
 * flagged 75 of them. So the test is a CALL SITE (`await someThingWithLLM(`) or an explicit LLM
 * flag on the npm command — the two things that make a run stochastic.
 */
const LLM_CALL_PATTERNS: RegExp[] = [
  /await\s+[A-Za-z0-9_.]*WithLLM\s*\(/,
  /await\s+requestStructuredJson\s*\(/,
  /await\s+[A-Za-z0-9_.]*\.(?:judge|classify|parse)[A-Za-z0-9_]*WithLLM\s*\(/
];

const chain = String(pkg.scripts["ci:eval"] ?? "");
assert.ok(chain, "ci:eval must exist");
const names = chain
  .split("&&")
  .map(s => s.trim().replace(/^npm run /, ""))
  .filter(Boolean);
assert.ok(names.length > 100, `ci:eval should list the whole suite; parsed ${names.length}`);

const offenders: string[] = [];
let llmBacked = 0;
let wrapped = 0;

for (const name of names) {
  const cmd = String(pkg.scripts[name] ?? "");
  if (!cmd) continue;
  // Resolve the eval script the command runs.
  const m = cmd.match(/scripts\/([A-Za-z0-9_.-]+\.ts)/);
  if (!m) continue;
  const file = path.join(repoRoot, "scripts", m[1]);
  if (!fs.existsSync(file)) continue;
  // This file itself always matches: a detector that DESCRIBES call patterns necessarily contains
  // them. It makes no model call, so skip it rather than adding a misleading EXCLUDED entry.
  if (path.resolve(file) === path.resolve(import.meta.filename)) continue;
  const src = fs.readFileSync(file, "utf8");
  const reachesModel = LLM_CALL_PATTERNS.some(re => re.test(src)) || /\bLLM_[A-Z0-9_]+=1\b/.test(cmd);
  if (!reachesModel) continue;
  llmBacked += 1;
  if (cmd.includes("retry_llm_eval.sh")) {
    wrapped += 1;
    continue;
  }
  if (EXCLUDED[name]) continue;
  offenders.push(`${name} -> ${cmd}`);
}

assert.equal(
  offenders.length,
  0,
  `LLM-backed eval(s) in ci:eval with no retry wrapper — one unlucky call red-lines the gate and ` +
    `skips everything after it:\n  ${offenders.join("\n  ")}\n` +
    `Fix: prefix the command with "bash scripts/retry_llm_eval.sh", or add it to EXCLUDED here with a reason.`
);

// The wrapper itself must still FAIL a real regression — a wrapper that retried forever would turn
// the gate green on genuinely broken code, which is far worse than a flake.
const wrapperSrc = fs.readFileSync(path.join(repoRoot, "scripts", "retry_llm_eval.sh"), "utf8");
assert.match(wrapperSrc, /retrying ONCE/i, "the wrapper must retry ONCE, not indefinitely");
assert.ok(
  /exit\s+"?\$\{?(second_exit|first_exit)/.test(wrapperSrc) || /exit\s+\$\{?second_exit/.test(wrapperSrc),
  "the wrapper must propagate the failing exit code when the retry also fails"
);

console.log(
  `PASS llm eval retry wrapper (${wrapped}/${llmBacked} LLM-backed evals wrapped, ` +
    `${Object.keys(EXCLUDED).length} deliberately excluded)`
);
