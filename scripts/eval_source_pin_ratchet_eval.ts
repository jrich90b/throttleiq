/**
 * Eval source-pin ratchet (Joe, 2026-08-01).
 *
 * WHY THIS EXISTS. Un-stacking contended state means restructuring `index.ts`,
 * `conversationStore.ts` and `routeStateReducer.ts` — and 127 evals read those files' SOURCE TEXT.
 * On the very first (small) un-stacking, THREE sibling evals broke because they pinned exact source
 * lines like `if ((conv as any).draftHeld) (conv as any).draftHeld = null;`. Each had to be re-pinned
 * to behavior, and the first re-pin was TOO WEAK — deleting the call it was meant to guard still
 * passed, because a second site matched the same pattern. It only surfaced by deliberately
 * sabotaging the code.
 *
 * That is the expensive failure: not a red build, but a GREEN one that no longer guards anything.
 *
 * WHAT THIS RATCHETS. Assertions that pin CODE SYNTAX — an `assert.match`/`assert.ok` whose regex
 * escapes a paren, i.e. it is matching source structure rather than behavior. RATCHET DOWN ONLY.
 *
 * TO ADD A GUARD: pin the BEHAVIOR. Call the function and assert its result; or assert ORDERING via
 * `indexOf` positions (see `conversation_outcome_audit_eval.ts`, which now asserts that the
 * isMaterial guard sits between the judge call and the persist, instead of matching one literal
 * line). If a source assertion is genuinely the only option, lower another one to pay for it.
 *
 * TO LOWER THE BASELINE: convert a pin to a behavior assertion, verify the replacement still fails
 * when you delete the thing it guards, then drop the number here.
 *
 * FAIL DIRECTION: counts only a narrow, unambiguous signature, so it UNDER-reports. It cannot force
 * existing pins to be fixed — it only stops the pile growing, exactly like the source-size ceiling.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Measured 2026-08-01 across scripts/*_eval.ts. RATCHET DOWN ONLY.
// 317: baseline at introduction (86 eval files carry at least one).
// 317 -> 316. The gold-corpus scorer's first draft pinned the runner's SOURCE (three greps for the
// eval-split filter, the read-only guard, and the report path). The ratchet caught it, which is
// exactly its job: those break on any refactor and a sloppy re-pin passes while guarding nothing.
// Replaced by `selectScoreableEvalItems` — a pure selector the eval CALLS with fixtures, so the
// same rule is pinned by behaviour and the runner cannot drift away from it silently.
// 316 -> 315. schedule_day_capture:eval and twilio_visit_commitment_routing:eval both pinned the
// schedule-status reply builder's SOURCE (the `Perfect, you're set for ${inboundDay}!` literal) and
// then re-implemented its logic by hand to test it. The builder moved to a pure domain module
// (scheduleStatusReply.ts), so both evals now CALL it — which is also what let the +17167130279
// parsed-day fix be pinned by behaviour instead of a fourth grep.
const BASELINE = 315;

const SIGNATURE = /assert\.(?:match|ok).*\\\(/;

const dir = path.resolve("scripts");
const files = fs
  .readdirSync(dir)
  .filter(name => name.endsWith("_eval.ts"))
  .sort();

assert.ok(files.length > 0, "eval source-pin ratchet: no *_eval.ts files found — the scan is broken");

let total = 0;
const byFile: { file: string; count: number }[] = [];
for (const name of files) {
  const text = fs.readFileSync(path.join(dir, name), "utf8");
  const count = text.split("\n").filter(line => SIGNATURE.test(line)).length;
  if (count > 0) byFile.push({ file: name, count });
  total += count;
}

byFile.sort((a, b) => b.count - a.count);

if (total > BASELINE) {
  console.error(
    `  FAIL eval source-pin ratchet: ${total} code-syntax assertions, baseline ${BASELINE} (+${total - BASELINE}).\n` +
      "       A new assertion is pinning SOURCE TEXT rather than behavior. Those break on every\n" +
      "       legitimate refactor, and — worse — a sloppy re-pin passes while guarding nothing.\n" +
      "       Pin the behavior instead: call the function and assert its result, or assert ORDERING\n" +
      "       via indexOf positions. If a source assertion is truly unavoidable, lower another to\n" +
      "       pay for it. Do NOT raise this number.\n" +
      `       Heaviest files: ${byFile.slice(0, 5).map(f => `${f.file}(${f.count})`).join(", ")}`
  );
  process.exit(1);
}

console.log(`eval_source_pin_ratchet:eval OK (${total} / ${BASELINE} code-syntax assertions)`);
if (BASELINE - total >= 10) {
  console.log(`  NOTE: ${BASELINE - total} under baseline — lower BASELINE to ${total} to keep the grip.`);
}
