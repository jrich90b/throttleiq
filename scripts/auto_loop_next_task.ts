/**
 * DETECT block of the autonomous coding loop (docs/autonomous_coding_loop.md).
 *
 * Picks the single highest-value next task for one detect->plan->build->verify
 * ->ship pass, or emits a STOP signal when the dealer is "high level usable":
 * every dealer_ready_checklist row verified WORKING and no open P0/P1 in the
 * agent-manager report.
 *
 * It does NOT write code. It reads the authoritative product checklist plus the
 * ranked task candidates the existing feedback loop already produces, merges and
 * ranks them, and emits the next task as JSON to stdout and to
 * reports/auto_loop/next_task.json. That JSON is the prompt seed the loop hands
 * to the BUILD agent ("the loop prompts the agents").
 */
import fs from "node:fs";
import path from "node:path";

type AnyObj = Record<string, any>;

type Source = "checklist" | "agent_manager";

type LoopTask = {
  id: string;
  source: Source;
  priority: "P0" | "P1" | "P2" | "P3";
  area: string;
  title: string;
  signal: string;
  recommendedAction: string;
  /** True when the task is fixed by editing code (loop-shippable); false for pure ops/verify cutovers. */
  codeable: boolean;
  evidence: AnyObj;
};

type SelectorResult = {
  generatedAt: string;
  stop: boolean;
  stopReason: string | null;
  task: LoopTask | null;
  checklistOpenCount: number;
  agentManagerP0P1Count: number;
  backlog: Array<Pick<LoopTask, "id" | "priority" | "title" | "source" | "codeable">>;
  skippedSweepChecks: string[];
};

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function readJson(p: string): AnyObj | null {
  const raw = readText(p);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Pure ops cutovers / external-credential verifications the coding loop should not auto-ship. */
function classifyChecklistCodeable(capability: string, status: string): boolean {
  const c = capability.toLowerCase();
  const s = status.toLowerCase();
  if (/dual-write|read-flip|dispatcher|tick.?flip|shadow/.test(`${c} ${s}`)) return false;
  if (/docusign|stripe|deposit|payment/.test(c)) return false; // need live external probes, not a code edit
  return true;
}

/**
 * Parse the dealer-ready checklist: any row whose Status is not a clean
 * "WORKING" (so WORKING*, UNVERIFIED, SHADOW, etc.) plus every numbered
 * "Open verification items" entry becomes a candidate task.
 */
function parseChecklistTasks(md: string): LoopTask[] {
  const tasks: LoopTask[] = [];
  const lines = md.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.split("|").slice(1, -1).map(c => c.trim());
    if (cells.length < 2) continue;
    const [capability, status, evidence = "", notes = ""] = cells;
    if (/^capability$/i.test(capability) || /^-+$/.test(capability)) continue; // header / separator
    const cleanWorking = /^working$/i.test(status);
    if (cleanWorking) continue;
    const caveated = /working\*/i.test(status);
    tasks.push({
      id: `checklist:${capability.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`,
      source: "checklist",
      priority: caveated ? "P1" : "P2",
      area: "dealer_ready",
      title: `Drive checklist row to verified: ${capability}`,
      signal: `Checklist status "${status}" (evidence: ${evidence || "n/a"}; notes: ${notes || "n/a"})`,
      recommendedAction: notes || `Verify or fix "${capability}" until status is a clean WORKING.`,
      codeable: classifyChecklistCodeable(capability, status),
      evidence: { capability, status, evidence, notes }
    });
  }
  // "## Open verification items" numbered list.
  const openSection = md.split(/##\s*Open verification items/i)[1];
  if (openSection) {
    const stop = openSection.search(/\n##\s/);
    const body = stop >= 0 ? openSection.slice(0, stop) : openSection;
    for (const m of body.matchAll(/^\s*\d+\.\s+(.*\S)\s*$/gm)) {
      const text = m[1].trim();
      const labelKey = text.split(/[:.]/)[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      tasks.push({
        id: `checklist-open:${labelKey}`,
        source: "checklist",
        priority: "P1",
        area: "dealer_ready",
        title: `Close open verification item: ${text.split(/[:.]/)[0].trim()}`,
        signal: text,
        recommendedAction: text,
        codeable: /report|join|count|fix|parser|guard|bug/i.test(text) && !/docusign|stripe/i.test(text),
        evidence: { item: text }
      });
    }
  }
  return tasks;
}

function parseAgentManagerTasks(report: AnyObj | null): LoopTask[] {
  if (!report || !Array.isArray(report.tasks)) return [];
  return report.tasks.map((t: AnyObj): LoopTask => ({
    id: `agent_manager:${String(t.id ?? "task")}`,
    source: "agent_manager",
    priority: (["P0", "P1", "P2", "P3"].includes(String(t.priority)) ? t.priority : "P2") as LoopTask["priority"],
    area: String(t.area ?? "ops"),
    title: String(t.title ?? "Agent-manager task"),
    signal: String(t.signal ?? ""),
    recommendedAction: String(t.recommendedAction ?? ""),
    // Routing/tone/voice/evals tasks are code; ops "restore file / confirm path" tasks usually are not.
    codeable: !/restore|confirm|missing source|env|path/i.test(`${t.title} ${t.recommendedAction}`),
    evidence: (t.evidence as AnyObj) ?? {}
  }));
}

/**
 * A sweep check is "guarded" once an eval pins its canonical case in ci:eval —
 * a green gate then proves the current code handles it, so any remaining
 * findings are historical replies that predate the fix (Todd Herian 2026-06-13:
 * owned_bike_offered was already fixed in d9bc78e4 + owned_bike_model_guard:eval,
 * yet the 30-day sweep still surfaced his pre-fix reply). Map each check to the
 * eval that guards it; checks with no mapping are genuinely unguarded and still
 * surface as real candidates.
 */
const GUARDED_CHECK_EVALS: Record<string, string> = {
  owned_bike_offered: "owned_bike_model_guard:eval",
  requested_day_reasked: "schedule_day_capture:eval"
};

function ciEvalScriptSet(): Set<string> {
  const pkg = readJson(path.join(process.cwd(), "package.json"));
  const chain = String(pkg?.scripts?.["ci:eval"] ?? "");
  const set = new Set<string>();
  for (const m of chain.matchAll(/npm run ([\w:-]+)/g)) set.add(m[1]);
  return set;
}

/**
 * Continuous-mode fuel: turn production agent-quality audit findings into
 * codeable reply-quality tasks (the Al-Davis class of bug). Reads the
 * deterministic answer_correctness sweep; each graded check with findings
 * becomes one task, carrying a concrete inbound/reply example so the BUILD
 * agent has a reproduction. Recent findings (active regression) rank as P1.
 *
 * Skips checks that are (a) already guarded by an eval in ci:eval — presumed
 * fixed — or (b) purely historical (no recent finding), so the loop never
 * re-fixes a ghost. Skipped checks are reported for transparency.
 */
function parseSweepTasks(reportRoot: string, opts?: { skipped?: string[] }): LoopTask[] {
  const summary = readJson(path.join(reportRoot, "answer_correctness", "answer_correctness_summary.json"));
  const findings = Array.isArray(summary?.findings) ? summary!.findings : [];
  if (!findings.length) return [];
  const guardingEvals = ciEvalScriptSet();
  const byCheck = new Map<string, { count: number; recent: number; sample: AnyObj }>();
  for (const f of findings) {
    const check = String(f?.check ?? "uncategorized");
    const entry = byCheck.get(check) ?? { count: 0, recent: 0, sample: f };
    entry.count += 1;
    if (f?.recent) entry.recent += 1;
    // Prefer a recent sample for the reproduction.
    if (f?.recent && !entry.sample?.recent) entry.sample = f;
    byCheck.set(check, entry);
  }
  const tasks: LoopTask[] = [];
  for (const [check, entry] of byCheck) {
    const guardEval = GUARDED_CHECK_EVALS[check];
    if (guardEval && guardingEvals.has(guardEval)) {
      opts?.skipped?.push(`${check} (guarded by ${guardEval})`);
      continue;
    }
    if (entry.recent === 0) {
      opts?.skipped?.push(`${check} (no recent findings — historical)`);
      continue;
    }
    const s = entry.sample ?? {};
    tasks.push({
      id: `sweep:answer_correctness:${check}`,
      source: "agent_manager",
      priority: entry.recent > 0 ? "P1" : "P2",
      area: "reply_quality",
      title: `Fix reply-quality gap: ${check} (${entry.count} findings, ${entry.recent} recent)`,
      signal: `answer_correctness flagged "${check}" — e.g. ${String(s.detail ?? "").slice(0, 160)}`,
      recommendedAction: `Reproduce ${check} on conv ${String(s.convId ?? "?")} parser-first (both reply paths), add an eval pinning the production turn, wire into ci:eval.`,
      codeable: true,
      evidence: {
        check,
        convId: s.convId ?? null,
        inbound: String(s.inbound ?? "").slice(0, 240),
        reply: String(s.reply ?? "").slice(0, 240),
        detail: s.detail ?? null,
        totalFindings: entry.count,
        recentFindings: entry.recent
      }
    });
  }
  return tasks;
}

/** Lower is more urgent. P0 first, then P1, then codeable checklist gaps, then the rest. */
function rankOf(task: LoopTask): number {
  const base = { P0: 0, P1: 10, P2: 20, P3: 30 }[task.priority];
  // Prefer code-shippable work the loop can actually close this pass.
  const codeableBonus = task.codeable ? 0 : 5;
  // A caveated/working* checklist row that misleads the gate itself is worth doing early.
  const gateTrustBonus = /report|join|count|mislead/i.test(`${task.title} ${task.signal}`) ? -2 : 0;
  return base + codeableBonus + gateTrustBonus;
}

function main(): void {
  const repoRoot = process.cwd();
  const reportRoot = process.env.REPORT_ROOT || path.join(repoRoot, "reports");
  const checklistPath =
    process.env.DEALER_READY_CHECKLIST_PATH || path.join(repoRoot, "docs", "dealer_ready_checklist.md");
  const agentManagerPath =
    process.env.AGENT_MANAGER_REPORT_PATH ||
    path.join(reportRoot, "agent_manager", "agent_manager_report.json");

  const checklistMd = readText(checklistPath) ?? "";
  const checklistTasks = parseChecklistTasks(checklistMd);
  const agentManagerTasks = parseAgentManagerTasks(readJson(agentManagerPath));
  const skippedSweepChecks: string[] = [];
  const sweepTasks = parseSweepTasks(reportRoot, { skipped: skippedSweepChecks });

  const all = [...agentManagerTasks, ...sweepTasks, ...checklistTasks];
  const p0p1 = all.filter(t => t.priority === "P0" || t.priority === "P1");
  const checklistOpen = checklistTasks.length;
  const nonCodeable = all.filter(t => !t.codeable);

  const ranked = all
    .map(t => ({ t, r: rankOf(t) }))
    .sort((a, b) => a.r - b.r || a.t.id.localeCompare(b.t.id))
    .map(x => x.t);
  const rankedCodeable = ranked.filter(t => t.codeable);

  // STOP/checkpoint: the loop only ships code, so it halts when no CODEABLE work
  // remains. If non-codeable items are still open (DocuSign/Stripe live verifies,
  // ops cutovers) the loop cannot close them autonomously — that needs the user.
  const stop = rankedCodeable.length === 0;
  const stopReason = stop
    ? nonCodeable.length > 0
      ? `no codeable work left; ${nonCodeable.length} item(s) need the user (external verify / ops cutover): ${nonCodeable
          .slice(0, 5)
          .map(t => t.title)
          .join("; ")}`
      : "dealer_ready_checklist fully verified, no open P0/P1, and production sweeps are clean"
    : null;

  const result: SelectorResult = {
    generatedAt: new Date().toISOString(),
    stop,
    stopReason,
    task: stop ? null : rankedCodeable[0] ?? null,
    checklistOpenCount: checklistOpen,
    agentManagerP0P1Count: p0p1.length,
    backlog: ranked.slice(0, 12).map(t => ({
      id: t.id,
      priority: t.priority,
      title: t.title,
      source: t.source,
      codeable: t.codeable
    })),
    skippedSweepChecks
  };

  const outDir = path.join(reportRoot, "auto_loop");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "next_task.json"), JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main();
