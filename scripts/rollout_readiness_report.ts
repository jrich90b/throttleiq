/**
 * Rollout-readiness scorecard — THE dealer-#2 bar, as one machine-readable number.
 *
 * Joe confirmed 2026-07-29 (docs/policy_charter.md "North star"; memory
 * `north-star-readiness-bar`) that dealer #2 triggers on a READINESS BAR, not a sales
 * conversation. The bar's four artifacts already existed but were scattered across four
 * reports nobody joined, so "how close are we?" was a research project instead of a number.
 * This joins them and writes ONE verdict the loop digest can print daily.
 *
 * The four gates (all must be MET):
 *   1. checklist      — every docs/dealer_ready_checklist.md capability row reads WORKING
 *   2. release_gate   — reports/release_gate/release_gate_report.json clean-day streak >= target (7)
 *   3. no_p0_p1       — reports/agent_manager/agent_manager_report.json has no open P0/P1 task
 *   4. eval_portability — no `universal` ci:eval asserts a dealer-OUTPUT fact (the same scan
 *                         eval_suite_manifest:eval ENFORCES — shared definition, so the gate and
 *                         the scorecard can never disagree)
 *
 * Read-only: it consumes reports, never conversations, and sends nothing.
 *
 * Usage:
 *   npx tsx scripts/rollout_readiness_report.ts [--report-root DIR] [--checklist PATH]
 *   REPORT_ROOT=/home/ubuntu/leadrider-runtime/americanharley/reports npm run rollout_readiness:report
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type ChecklistRow = { capability: string; status: string; evidence: string };

export type ReadinessGate = {
  id: "checklist" | "release_gate" | "no_p0_p1" | "eval_portability";
  label: string;
  met: boolean;
  detail: string;
  blockers: string[];
};

export type ReadinessInput = {
  checklistRows: ChecklistRow[];
  releaseGate: { verdict?: string | null; cleanStreakDays?: number | null; streakTarget?: number | null } | null;
  agentManagerTasks: Array<{ priority?: string | null; title?: string | null }> | null;
  portability: { universal: number; dealer: number; violations: string[] } | null;
};

export type ReadinessScore = {
  verdict: "MET" | "NOT_MET";
  gatesMet: number;
  gatesTotal: number;
  score: number; // 0-100, gates met as a percentage
  checklistWorkingPct: number | null;
  gates: ReadinessGate[];
  blockers: string[];
};

/**
 * Parse the capability table out of docs/dealer_ready_checklist.md.
 *
 * Only the FIRST markdown table is the capability matrix — the doc also carries prose
 * ("Open verification items", "Resolved") that must never be graded. Header/separator rows
 * and any row whose status cell is not a bare status word are skipped.
 */
export function parseChecklistRows(md: string): ChecklistRow[] {
  const rows: ChecklistRow[] = [];
  let seenHeader = false;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("|")) {
      // A blank/prose line AFTER the table has started ends the capability matrix.
      if (seenHeader && rows.length) break;
      continue;
    }
    const cells = line.split("|").slice(1, -1).map(c => c.trim());
    if (cells.length < 2) continue;
    if (/^-+$/.test(cells[0].replace(/[\s:]/g, "")) || cells.every(c => /^:?-{2,}:?$/.test(c))) continue;
    if (!seenHeader) {
      // The header row is "| Capability | Status | ... |".
      if (/^capability$/i.test(cells[0])) seenHeader = true;
      continue;
    }
    const status = cells[1];
    if (!/^[A-Z_]+$/.test(status)) continue; // WORKING / SHADOW / UNVERIFIED — never prose
    rows.push({ capability: cells[0], status, evidence: cells[2] ?? "" });
  }
  return rows;
}

/** The pure grader — every gate decided from already-collected inputs, no I/O. */
export function evaluateReadiness(input: ReadinessInput): ReadinessScore {
  const gates: ReadinessGate[] = [];

  // 1) Checklist — every capability row WORKING.
  const rows = input.checklistRows ?? [];
  const working = rows.filter(r => r.status.toUpperCase() === "WORKING");
  const notWorking = rows.filter(r => r.status.toUpperCase() !== "WORKING");
  gates.push({
    id: "checklist",
    label: "Dealer-ready checklist: every capability WORKING",
    // No rows parsed means the doc moved or the table shape changed — that is NOT a pass.
    met: rows.length > 0 && notWorking.length === 0,
    detail: rows.length
      ? `${working.length}/${rows.length} capability rows WORKING`
      : "no capability rows parsed from the checklist (doc moved or table shape changed)",
    blockers: rows.length
      ? notWorking.map(r => `${r.capability}: ${r.status}`)
      : ["dealer_ready_checklist.md produced no capability rows"]
  });

  // 2) Release gate — consecutive clean-day streak has reached its target.
  const rg = input.releaseGate;
  const streak = Number(rg?.cleanStreakDays ?? 0);
  const target = Number(rg?.streakTarget ?? 7);
  gates.push({
    id: "release_gate",
    label: "Release gate: clean-day streak at target",
    met: Boolean(rg) && streak >= target,
    detail: rg ? `${streak}/${target} consecutive clean days (verdict ${rg.verdict ?? "?"})` : "no release-gate report found",
    blockers: !rg
      ? ["release_gate_report.json missing — run release_gate:report"]
      : streak >= target
        ? []
        : [`clean streak ${streak}/${target} days`]
  });

  // 3) No open P0/P1 in the agent-manager report.
  const tasks = input.agentManagerTasks;
  const p0p1 = (tasks ?? []).filter(t => {
    const p = String(t?.priority ?? "").toUpperCase();
    return p === "P0" || p === "P1";
  });
  gates.push({
    id: "no_p0_p1",
    label: "Agent manager: no open P0/P1",
    met: Array.isArray(tasks) && p0p1.length === 0,
    detail: Array.isArray(tasks) ? `${p0p1.length} open P0/P1 of ${tasks.length} task(s)` : "no agent-manager report found",
    blockers: !Array.isArray(tasks)
      ? ["agent_manager_report.json missing — run agent_manager:report"]
      : p0p1.map(t => `${String(t.priority).toUpperCase()}: ${t.title ?? "(untitled)"}`)
  });

  // 4) Eval-suite portability — no universal eval is secretly AH-pinned.
  const port = input.portability;
  gates.push({
    id: "eval_portability",
    label: "Eval suite: universal tier is dealer-portable",
    met: Boolean(port) && port!.violations.length === 0 && port!.universal > 0,
    detail: port
      ? `${port.universal} universal / ${port.dealer} dealer-pinned, ${port.violations.length} portability violation(s)`
      : "portability scan unavailable",
    blockers: !port
      ? ["eval-suite portability scan unavailable"]
      : port.universal === 0
        ? ["no universal evals classified — the split is not wired"]
        : port.violations.slice(0, 10)
  });

  const gatesMet = gates.filter(g => g.met).length;
  return {
    verdict: gatesMet === gates.length ? "MET" : "NOT_MET",
    gatesMet,
    gatesTotal: gates.length,
    score: Math.round((gatesMet / gates.length) * 100),
    checklistWorkingPct: rows.length ? Math.round((working.length / rows.length) * 100) : null,
    gates,
    blockers: gates.filter(g => !g.met).flatMap(g => g.blockers)
  };
}

/** One line for the operator digest — the whole bar, skimmable. */
export function formatReadinessLine(score: ReadinessScore): string {
  const head = `Dealer-#2 readiness: ${score.verdict} — ${score.gatesMet}/${score.gatesTotal} gates (${score.score}%)`;
  if (score.verdict === "MET") return `${head}. The bar is met.`;
  const open = score.gates.filter(g => !g.met).map(g => g.id).join(", ");
  return `${head}. Open: ${open}.`;
}

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const reportRoot = arg("--report-root") || process.env.REPORT_ROOT || path.resolve(process.cwd(), "reports");
  const checklistPath = arg("--checklist") || path.resolve(process.cwd(), "docs/dealer_ready_checklist.md");
  const outDir = path.join(reportRoot, "rollout_readiness");

  const checklistRows = fs.existsSync(checklistPath) ? parseChecklistRows(fs.readFileSync(checklistPath, "utf8")) : [];
  const releaseGate = readJson(path.join(reportRoot, "release_gate", "release_gate_report.json"));
  const agentManager = readJson(path.join(reportRoot, "agent_manager", "agent_manager_report.json"));

  let portability: ReadinessInput["portability"] = null;
  try {
    const { scanUniversalEvalPortability } = await import("./eval_suite.manifest.ts");
    portability = scanUniversalEvalPortability();
  } catch {
    portability = null;
  }

  const score = evaluateReadiness({
    checklistRows,
    releaseGate: releaseGate
      ? {
          verdict: releaseGate.verdict,
          cleanStreakDays: releaseGate.cleanStreakDays,
          streakTarget: releaseGate.streakTarget
        }
      : null,
    agentManagerTasks: Array.isArray(agentManager?.tasks) ? agentManager.tasks : null,
    portability
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    dealer: process.env.DEALER_LABEL || process.env.DEALER_ID || "americanharley",
    ...score,
    sources: {
      checklist: checklistPath,
      releaseGate: path.join(reportRoot, "release_gate", "release_gate_report.json"),
      agentManager: path.join(reportRoot, "agent_manager", "agent_manager_report.json"),
      evalSuite: "scripts/eval_suite.manifest.ts"
    }
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(payload, null, 2));

  const md = [
    `# Dealer-#2 rollout readiness — ${score.verdict}`,
    "",
    `${formatReadinessLine(score)}`,
    "",
    "| Gate | Status | Detail |",
    "| --- | --- | --- |",
    ...score.gates.map(g => `| ${g.label} | ${g.met ? "MET" : "OPEN"} | ${g.detail} |`),
    "",
    ...(score.blockers.length ? ["## Blockers", ...score.blockers.map(b => `- ${b}`)] : ["No blockers."])
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "latest.md"), md + "\n");

  console.log(formatReadinessLine(score));
  for (const g of score.gates) console.log(`  [${g.met ? "MET " : "OPEN"}] ${g.label} — ${g.detail}`);
  console.log(JSON.stringify({ ok: true, verdict: score.verdict, gatesMet: score.gatesMet, outDir }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
