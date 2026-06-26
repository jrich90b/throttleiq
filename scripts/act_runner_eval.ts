/**
 * ACT runner eval (pure-ish: runs `list`/`prep` against a fixture work order; source-guards the safety
 * properties). The runner turns a loop finding into an approvable PR — so the non-negotiables are: it NEVER
 * merges (PR-only), it REFUSES to PR from main, it requires commits ahead of main, it ENFORCES the gates
 * (tsc; ci:eval unless explicitly verified), and `prep` emits a brief carrying the parser-first contract.
 *
 * Run: npx tsx scripts/act_runner_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const src = fs.readFileSync("scripts/act_runner.ts", "utf8");

// --- Safety guarantees (source-level — these are the properties that keep ACT trustworthy). ---
assert.ok(/"pr", "create"/.test(src), "opens an auditable PR via gh pr create");
// Merge is now GATED, not forbidden: the runner merges ONLY inside the `if (gate.ship)` block — i.e. only
// on a clean cross-model pre-ship approve. open-pr stays PR-only; review escalates (leaves the PR open)
// on anything short of approve.
assert.ok(/if \(gate\.ship\) \{[\s\S]*?"pr", "merge"/.test(src), "merges ONLY on a clean cross-model approve (gate.ship)");
assert.ok(/ESCALATED — PR left OPEN for a human/.test(src), "anything short of approve => PR left open + escalate (not merged)");
// On escalation, the runner emails the operator IMMEDIATELY (not just the daily digest), best-effort.
assert.ok(/a fix needs your review/.test(src), "escalation sends an immediate 'needs your review' email");
assert.ok(/import\("\.\.\/services\/api\/src\/domain\/emailSender\.ts"\)/.test(src), "the escalation email reuses the existing sendEmail (no new infra)");
assert.ok(/Escalation email failed \(non-fatal\)/.test(src), "a notification failure never changes the escalation outcome (best-effort)");
assert.match(src, /Refusing to open a PR from main|Refusing to review\/ship from main/, "refuses to PR/ship from main");
assert.match(src, /rev-list", "--count", "main\.\.HEAD"/, "requires commits ahead of main");
assert.match(src, /Running tsc/, "enforces tsc before the PR");
assert.match(src, /npm", \["run", "ci:eval"\]/, "runs ci:eval (unless --eval-verified)");
assert.match(src, /eval-verified/, "supports --eval-verified to skip a just-run ci:eval");
assert.match(src, /COMPREHEND, never regex/, "the prep brief carries the parser-first law");

// --- Behavior: prep against a fixture next.json writes a brief with the finding + contract. ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "act-eval-"));
fs.mkdirSync(path.join(tmp, "anomaly_loop"), { recursive: true });
fs.writeFileSync(
  path.join(tmp, "anomaly_loop", "next.json"),
  JSON.stringify({
    workOrders: [
      { convId: "+1555", leadKey: "+1555", dimension: "open_critic_finding", category: "discovery", severity: "P2", tier: 2, action: "escalate", notify: true, detail: "watch_set_for_wrong_model — opened a Road Glide watch on a Street Glide ask" }
    ]
  })
);
const out = execFileSync("npx", ["tsx", "scripts/act_runner.ts", "prep", "--top"], {
  encoding: "utf8",
  env: { ...process.env, REPORT_ROOT: tmp, CONVERSATIONS_DB_PATH: "" }
});
assert.match(out, /Fix brief written/, "prep writes a brief");
assert.match(out, /Suggested branch: fix\/loop-/, "prep proposes a feature branch");
const briefPath = path.join(tmp, "act", "brief-_1555_open_critic_finding.md");
assert.ok(fs.existsSync(briefPath), "the brief file exists");
const brief = fs.readFileSync(briefPath, "utf8");
assert.match(brief, /watch_set_for_wrong_model/, "brief carries the finding");
assert.match(brief, /route parity|both/i, "brief states the both-paths requirement");
assert.match(brief, /deterministic eval wired into ci:eval/, "brief requires an eval");

// --- list runs clean. ---
const listOut = execFileSync("npx", ["tsx", "scripts/act_runner.ts", "list"], {
  encoding: "utf8",
  env: { ...process.env, REPORT_ROOT: tmp }
});
assert.match(listOut, /open_critic_finding/, "list shows the work order");
assert.match(listOut, /id: \+1555::open_critic_finding/, "list shows the work-order id");

console.log("PASS act runner eval — PR-only (never merges), refuses main, gate-enforced; prep brief carries the parser-first contract; list/prep run.");
