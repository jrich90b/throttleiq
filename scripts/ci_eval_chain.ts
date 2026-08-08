/**
 * The one parser for the `ci:eval` chain string.
 *
 * Two things read that 457-entry `&&` string for different reasons — `ci_eval_chain_guard_eval.ts`
 * (which proves no eval was silently dropped) and `ci_eval_runner.ts` (which executes them with
 * independent entries overlapped). If they ever disagreed about what the chain contains, the
 * runner could skip an eval the guard believes is protected: a green gate over a hole, which is
 * the exact failure the guard was written for.
 *
 * So the parse lives here, once, and both import it. It is deliberately a plain module with no
 * top-level side effects, so importing it can never run anything.
 */

/** Split the chain on `&&` and strip the `npm run ` prefix, yielding bare script names in order. */
export function parseCiEvalChain(ciEval: string): string[] {
  return String(ciEval ?? "")
    .split("&&")
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => part.replace(/^npm run /, "").trim());
}
