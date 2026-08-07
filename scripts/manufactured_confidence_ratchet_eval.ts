/**
 * Manufactured-confidence ratchet (pure, no LLM).
 *
 * THE SMELL: a deterministic fallback that hardcodes a `confidence:` literal — usually chosen to sit
 * just above the accept floor it is bypassing (0.76 against a 0.74 gate, 0.79 against 0.78). Nobody
 * measured those numbers; they were picked to pass. On 2026-08-06 that signature marked three routes
 * where a keyword scan was overruling a correct parser: a buyer asking our price was lectured about
 * private sellers (#573), an experienced owner was offered a beginner Jumpstart (#574), and a buyer
 * negotiating rates was closed as "stepping back" (#579) — 516 parser calls on that last route with
 * ZERO ever accepted.
 *
 * THE RULE (AGENTS.md "Fallback-vs-Parser Precedence"): a fallback may not manufacture a confidence.
 * This ratchet makes the rule bind every PR mechanically: the inventory below may SHRINK, never grow.
 * Same contract as source_size_ratchet — do NOT add an entry to land a change; that is the one thing
 * this guard exists to stop. If a new deterministic path genuinely must express certainty, it should
 * declare its own source field rather than a number the accept gate will mistake for a measurement,
 * and the precedence belongs in a `resolve*Source` referee (inboundPipeline.ts) so a parser verdict
 * cannot be overruled by it.
 *
 * Baseline taken 2026-08-07. Every entry is a KNOWN site, kept only because its reachability is now
 * bounded: the three fixed routes only reach their fallback when NO parse exists at all.
 *
 * Run: npx tsx scripts/manufactured_confidence_ratchet_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** file → max allowed `confidence: <literal>` occurrences. Shrink freely; never raise. */
const BASELINE: Record<string, number> = {
  "services/api/src/index.ts": 5,
  // llmDraft's six are the MILD shape: the LLM answered in prose (SMALL_TALK / freeform backup)
  // and deterministic code stamps a nominal score while converting the answer to a struct. The LLM
  // did read the text, so no parser is being overruled — but the numbers are still invented, so
  // they stay counted and may only shrink.
  "services/api/src/domain/llmDraft.ts": 6,
  "services/api/src/domain/manualQuoteFollowUp.ts": 1,
  "services/api/src/domain/manualCadenceContext.ts": 1,
  "services/api/src/domain/dealerTransactionPolicy.ts": 1,
  "services/api/src/routes/sendgridInbound.ts": 1
};

const LITERAL = /confidence:\s*0\.\d+/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

let total = 0;
const over: string[] = [];
for (const file of walk("services/api/src")) {
  const rel = file.split(path.sep).join("/");
  const count = (fs.readFileSync(file, "utf8").match(LITERAL) ?? []).length;
  if (count === 0) continue;
  total += count;
  const allowed = BASELINE[rel] ?? 0;
  if (count > allowed) {
    over.push(`${rel}: ${count} confidence literals, baseline ${allowed}`);
  }
}

assert.deepEqual(
  over,
  [],
  `NEW manufactured confidence literal(s):\n  ${over.join("\n  ")}\n` +
    `A hardcoded confidence chosen to clear an accept floor is not a measurement — it is a way ` +
    `through the gate (AGENTS.md: Fallback-vs-Parser Precedence). Do NOT raise the baseline to ` +
    `land a change. Route precedence through a resolve*Source referee instead.`
);

// The baseline itself must not rot: an entry for a file with fewer literals than allowed means the
// count shrank — tighten the number so the headroom cannot be silently reclaimed later.
const stale: string[] = [];
for (const [rel, allowed] of Object.entries(BASELINE)) {
  const count = fs.existsSync(rel) ? (fs.readFileSync(rel, "utf8").match(LITERAL) ?? []).length : 0;
  if (count < allowed) stale.push(`${rel}: baseline ${allowed} but only ${count} remain — lower the baseline`);
}
assert.deepEqual(stale, [], `ratchet has slack — tighten it:\n  ${stale.join("\n  ")}`);

console.log(
  `PASS manufactured-confidence ratchet (${total} known literals across ${Object.keys(BASELINE).length} files; ceiling held, no slack)`
);
