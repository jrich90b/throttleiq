/**
 * Rollout-readiness scorecard — THE dealer-#2 bar, as one machine-readable number.
 *
 * Joe confirmed 2026-07-29 (docs/policy_charter.md "North star"; memory
 * `north-star-readiness-bar`) that dealer #2 triggers on a READINESS BAR, not a sales
 * conversation, and on 2026-07-30 ("Ok") confirmed the bar's FIVE-SECTION definition:
 *
 *   1. funnel        — answer / book / show rates vs the 58/16/27 baseline + first-touch latency
 *   2. portability   — universal-vs-dealer eval split + AH-hardcodes-in-universal-paths count
 *   3. operability   — checklist rows WORKING, release-gate clean streak, open P0/P1
 *   4. stranger_test — has a fresh synthetic "dealer #2" been provisioned from config alone and
 *                      passed the gates cold? (yes/no + date; starts "not yet attempted")
 *   5. pitch_numbers — response time, booking lift, BDC hours replaced (starts "not yet measured")
 *
 * THE SCORE MUST NOT FLATTER (Joe's words, 7/30). Two rules enforce that:
 *   - All five sections are ALWAYS present. A section with no usable source reads
 *     NOT_MEASURED — it is never omitted, and never silently treated as a pass.
 *   - The bar is MET only when every section is MET. NOT_MEASURED blocks the bar exactly
 *     like OPEN does, so "we never measured it" can never round up to "we're ready."
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

/**
 * DEFAULT TARGETS — proposed by the loop for Joe's VETO, not invented by him.
 *
 * The funnel baseline (americanharley, 30d, 6/16, sales-scoped) was offered 58% / booked 16% /
 * offer->book 27%. Holding offered-rate flat and roughly doubling the two conversion numbers is
 * what "better than a BDC" has to mean for the pitch; the latency target is the lever
 * first-touch auto-send exists to move (effective median is ~90min today).
 *
 * Change a number here and the bar changes with it — this is the one place to argue with.
 */
export const READINESS_TARGETS = {
  funnel: {
    offeredRatePct: 58, // hold the baseline — never regress the ask
    bookRatePct: 25, // up from the 16% baseline
    offerToBookPct: 40, // up from the 27% baseline
    firstTouchMedianMin: 15, // effective median reply time
    minEngagedSample: 30 // below this the window is noise, not a measurement
  },
  portability: {
    evalViolations: 0,
    // Ratchet, not a wish: the count measured when this section shipped (2026-07-30). It may
    // only go DOWN. Every AH literal removed from services/api/src lowers the budget.
    ahHardcodeBudget: 112
  },
  operability: {
    cleanStreakDays: 7,
    maxOpenP0P1: 0
  }
} as const;

export type ChecklistRow = { capability: string; status: string; evidence: string };

export type SectionStatus = "MET" | "OPEN" | "NOT_MEASURED";

/** One line of evidence inside a section. `met: null` = informational, does not gate. */
export type ReadinessMetric = { label: string; value: string; target: string; met: boolean | null };

export type ReadinessSection = {
  id: "funnel" | "portability" | "operability" | "stranger_test" | "pitch_numbers";
  label: string;
  status: SectionStatus;
  detail: string;
  metrics: ReadinessMetric[];
  blockers: string[];
};

export type ReadinessInput = {
  /** Section 1 — from reports/booking_funnel + reports/response_latency. */
  bookingFunnel: {
    engaged?: number | null;
    offeredRatePct?: number | null;
    bookRatePct?: number | null;
    offerToBookPct?: number | null;
    showed?: number | null;
    sinceDays?: number | null;
  } | null;
  latency: { effectiveMedianMin?: number | null; under5minPct?: number | null } | null;
  /** Section 2 — the eval split scan + a source-literal count. */
  portability: { universal: number; dealer: number; violations: string[] } | null;
  ahHardcodes: number | null;
  /** Section 3. */
  checklistRows: ChecklistRow[];
  releaseGate: { verdict?: string | null; cleanStreakDays?: number | null; streakTarget?: number | null } | null;
  agentManagerTasks: Array<{ priority?: string | null; title?: string | null }> | null;
  /** Section 4 — absent until a synthetic dealer #2 has actually been stood up cold. */
  strangerTest: { passed?: boolean | null; at?: string | null; detail?: string | null } | null;
  /** Section 5 — absent until the pitch numbers are actually computed. */
  pitchNumbers: {
    medianResponseMin?: number | null;
    bookingLiftPct?: number | null;
    bdcHoursReplacedPerWeek?: number | null;
  } | null;
};

export type ReadinessScore = {
  verdict: "MET" | "NOT_MET";
  sectionsMet: number;
  sectionsTotal: number;
  score: number; // 0-100, sections MET as a percentage
  checklistWorkingPct: number | null;
  sections: ReadinessSection[];
  notMeasured: string[];
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

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A gating metric: `met` is false whenever the value is missing, so absence never passes. */
function atLeast(label: string, value: number | null, target: number, unit = "%"): ReadinessMetric {
  return {
    label,
    value: value === null ? "unmeasured" : `${value}${unit}`,
    target: `>= ${target}${unit}`,
    met: value !== null && value >= target
  };
}

function atMost(label: string, value: number | null, target: number, unit = ""): ReadinessMetric {
  return {
    label,
    value: value === null ? "unmeasured" : `${value}${unit}`,
    target: `<= ${target}${unit}`,
    met: value !== null && value <= target
  };
}

/** Roll a section's gating metrics up into its status + blocker list. */
function settle(
  section: Omit<ReadinessSection, "status" | "blockers">,
  opts: { measured: boolean; unmeasuredReason?: string; extraBlockers?: string[] }
): ReadinessSection {
  if (!opts.measured) {
    return {
      ...section,
      status: "NOT_MEASURED",
      blockers: [`${section.label}: ${opts.unmeasuredReason ?? "not yet measured"}`]
    };
  }
  const failed = section.metrics.filter(m => m.met === false);
  const blockers = [...(opts.extraBlockers ?? []), ...failed.map(m => `${m.label} ${m.value} (target ${m.target})`)];
  return { ...section, status: blockers.length ? "OPEN" : "MET", blockers };
}

/** The pure grader — every section decided from already-collected inputs, no I/O. */
export function evaluateReadiness(input: ReadinessInput): ReadinessScore {
  const T = READINESS_TARGETS;
  const sections: ReadinessSection[] = [];

  // --- 1) FUNNEL — is the agent actually out-selling the baseline? ---
  const bf = input.bookingFunnel;
  const engaged = num(bf?.engaged);
  const funnelSampled = Boolean(bf) && engaged !== null && engaged >= T.funnel.minEngagedSample;
  const latencyMedian = num(input.latency?.effectiveMedianMin);
  sections.push(
    settle(
      {
        id: "funnel",
        label: "Funnel: answer -> book, better than the baseline",
        detail: funnelSampled
          ? `${engaged} engaged over ${num(bf?.sinceDays) ?? "?"}d — offered ${num(bf?.offeredRatePct) ?? "?"}%, booked ${num(bf?.bookRatePct) ?? "?"}%, offer->book ${num(bf?.offerToBookPct) ?? "?"}%`
          : "funnel not measured on a large enough window",
        metrics: [
          atLeast("Offered a time (of engaged)", num(bf?.offeredRatePct), T.funnel.offeredRatePct),
          atLeast("Booked (of engaged)", num(bf?.bookRatePct), T.funnel.bookRatePct),
          atLeast("Offer -> book conversion", num(bf?.offerToBookPct), T.funnel.offerToBookPct),
          atMost("First-touch effective median", latencyMedian, T.funnel.firstTouchMedianMin, "min"),
          { label: "Showed", value: num(bf?.showed) === null ? "unmeasured" : String(num(bf?.showed)), target: "tracked", met: null }
        ]
      },
      {
        measured: funnelSampled,
        unmeasuredReason: !bf
          ? "no booking-funnel summary — run booking_funnel:audit into reports/booking_funnel"
          : `sample too small (${engaged ?? 0} engaged over ${num(bf?.sinceDays) ?? "?"}d, need >= ${T.funnel.minEngagedSample}) — run the audit over a 30-day window`
      }
    )
  );

  // --- 2) PORTABILITY — would this work at a dealer we've never met? ---
  const port = input.portability;
  const hardcodes = num(input.ahHardcodes);
  const portMetrics: ReadinessMetric[] = [
    atMost("Universal evals asserting a dealer fact", port ? port.violations.length : null, T.portability.evalViolations),
    atMost("AH literals in services/api/src", hardcodes, T.portability.ahHardcodeBudget),
    {
      label: "Eval split",
      value: port ? `${port.universal} universal / ${port.dealer} dealer-pinned` : "unmeasured",
      target: "universal tier wired (> 0)",
      met: port ? port.universal > 0 : false
    }
  ];
  sections.push(
    settle(
      {
        id: "portability",
        label: "Portability: the universal tier is dealer-agnostic",
        detail: port
          ? `${port.universal} universal / ${port.dealer} dealer-pinned, ${port.violations.length} eval violation(s), ${hardcodes ?? "?"} AH literals in api source`
          : "portability scan unavailable",
        metrics: portMetrics
      },
      {
        measured: Boolean(port),
        unmeasuredReason: "eval-suite portability scan unavailable",
        extraBlockers: port ? port.violations.slice(0, 10) : []
      }
    )
  );

  // --- 3) OPERABILITY — does it run without an owner in the daily loop? ---
  const rows = input.checklistRows ?? [];
  const working = rows.filter(r => r.status.toUpperCase() === "WORKING");
  const notWorking = rows.filter(r => r.status.toUpperCase() !== "WORKING");
  const rg = input.releaseGate;
  const streak = rg ? num(rg.cleanStreakDays) ?? 0 : null;
  const streakTarget = num(rg?.streakTarget) ?? T.operability.cleanStreakDays;
  const tasks = input.agentManagerTasks;
  const p0p1 = (tasks ?? []).filter(t => {
    const p = String(t?.priority ?? "").toUpperCase();
    return p === "P0" || p === "P1";
  });
  const opsMeasured = rows.length > 0 || Boolean(rg) || Array.isArray(tasks);
  sections.push(
    settle(
      {
        id: "operability",
        label: "Operability: runs clean without an owner in the loop",
        detail: `${working.length}/${rows.length} checklist rows WORKING, streak ${streak ?? "?"}/${streakTarget}, ${p0p1.length} open P0/P1`,
        metrics: [
          {
            label: "Checklist rows WORKING",
            value: rows.length ? `${working.length}/${rows.length}` : "unmeasured",
            target: "all rows",
            // 0 rows means the doc moved or the table shape changed — that is NOT a pass.
            met: rows.length > 0 && notWorking.length === 0
          },
          atLeast("Release-gate clean streak", streak, streakTarget, " days"),
          {
            label: "Open P0/P1",
            value: Array.isArray(tasks) ? String(p0p1.length) : "unmeasured",
            target: `<= ${T.operability.maxOpenP0P1}`,
            met: Array.isArray(tasks) && p0p1.length <= T.operability.maxOpenP0P1
          }
        ]
      },
      {
        measured: opsMeasured,
        unmeasuredReason: "no checklist, release-gate, or agent-manager report found",
        extraBlockers: [
          ...(rows.length ? notWorking.map(r => `${r.capability}: ${r.status}`) : ["dealer_ready_checklist.md produced no capability rows"]),
          ...p0p1.map(t => `${String(t.priority).toUpperCase()}: ${t.title ?? "(untitled)"}`)
        ]
      }
    )
  );

  // --- 4) STRANGER TEST — a dealer we've never met, provisioned from config alone. ---
  const st = input.strangerTest;
  sections.push(
    settle(
      {
        id: "stranger_test",
        label: "Stranger test: a synthetic dealer #2 stood up cold from config",
        detail: st
          ? `${st.passed ? "PASSED" : "ATTEMPTED, FAILED"}${st.at ? ` ${st.at}` : ""}${st.detail ? ` — ${st.detail}` : ""}`
          : "not yet attempted",
        metrics: [
          {
            label: "Provisioned from config alone and passed the gates cold",
            value: st ? (st.passed ? `yes (${st.at ?? "date unknown"})` : `no (attempted ${st.at ?? "?"})`) : "not yet attempted",
            target: "yes",
            met: Boolean(st?.passed)
          }
        ]
      },
      {
        measured: Boolean(st),
        unmeasuredReason: "not yet attempted — no synthetic dealer #2 has been provisioned cold"
      }
    )
  );

  // --- 5) PITCH NUMBERS — what we can actually claim to dealer #2. ---
  const pn = input.pitchNumbers;
  const pitchResponse = num(pn?.medianResponseMin);
  const pitchLift = num(pn?.bookingLiftPct);
  const pitchHours = num(pn?.bdcHoursReplacedPerWeek);
  const pitchMeasured = Boolean(pn) && (pitchResponse !== null || pitchLift !== null || pitchHours !== null);
  sections.push(
    settle(
      {
        id: "pitch_numbers",
        label: "Pitch numbers: the claims we can make to dealer #2",
        detail: pitchMeasured
          ? `response ${pitchResponse ?? "?"}min, booking lift ${pitchLift ?? "?"}%, BDC hours replaced ${pitchHours ?? "?"}/wk`
          : "not yet measured",
        metrics: [
          atMost("Median response time", pitchResponse, T.funnel.firstTouchMedianMin, "min"),
          {
            label: "Booking lift vs pre-LeadRider",
            value: pitchLift === null ? "not yet measured" : `${pitchLift}%`,
            target: "> 0%, measured",
            met: pitchLift !== null && pitchLift > 0
          },
          {
            label: "BDC hours replaced per week",
            value: pitchHours === null ? "not yet measured" : String(pitchHours),
            target: "> 0, measured",
            met: pitchHours !== null && pitchHours > 0
          }
        ]
      },
      {
        measured: pitchMeasured,
        unmeasuredReason: "not yet measured — no pitch-numbers source (needs a pre-LeadRider baseline to compare against)"
      }
    )
  );

  const sectionsMet = sections.filter(s => s.status === "MET").length;
  return {
    // NOT_MEASURED blocks the bar exactly like OPEN — an unmeasured section is not a pass.
    verdict: sectionsMet === sections.length ? "MET" : "NOT_MET",
    sectionsMet,
    sectionsTotal: sections.length,
    score: Math.round((sectionsMet / sections.length) * 100),
    checklistWorkingPct: rows.length ? Math.round((working.length / rows.length) * 100) : null,
    sections,
    notMeasured: sections.filter(s => s.status === "NOT_MEASURED").map(s => s.id),
    blockers: sections.filter(s => s.status !== "MET").flatMap(s => s.blockers)
  };
}

/**
 * One line for the operator digest — the whole bar, skimmable.
 *
 * Tolerates a scorecard written by the older four-gate version (the digest reads whatever
 * latest.json is on the box, which can lag a deploy by one cron cycle).
 */
export function formatReadinessLine(score: Partial<ReadinessScore> & { gates?: Array<{ id: string; met: boolean }>; gatesMet?: number; gatesTotal?: number }): string {
  const met = score.sectionsMet ?? score.gatesMet ?? 0;
  const total = score.sectionsTotal ?? score.gatesTotal ?? 0;
  const pct = score.score ?? (total ? Math.round((met / total) * 100) : 0);
  const head = `Dealer-#2 readiness: ${score.verdict ?? "NOT_MET"} — ${met}/${total} sections (${pct}%)`;
  if (score.verdict === "MET") return `${head}. The bar is met.`;
  const open = (score.sections ?? []).filter(s => s.status !== "MET").map(s => `${s.id}${s.status === "NOT_MEASURED" ? " (unmeasured)" : ""}`);
  const legacyOpen = (score.gates ?? []).filter(g => !g.met).map(g => g.id);
  const list = open.length ? open : legacyOpen;
  return list.length ? `${head}. Open: ${list.join(", ")}.` : `${head}.`;
}

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Count AH-specific literals left in the API source — the portability debt, as a ratchet.
 *
 * Deliberately crude and deliberately over-inclusive: a dealer-name fallback is still a
 * literal a stranger dealer inherits. Comment-only lines are excluded so prose about
 * American Harley doesn't inflate the debt. Returns null if the tree isn't there.
 */
export function countAhHardcodes(root = "services/api/src"): number | null {
  const AH = /american harley|north tonawanda/i;
  const COMMENT = /^\s*(\/\/|\*|\/\*)/;
  if (!fs.existsSync(root)) return null;
  let count = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        for (const line of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
          if (!COMMENT.test(line) && AH.test(line)) count += 1;
        }
      }
    }
  };
  walk(root);
  return count;
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
  const funnel = readJson(path.join(reportRoot, "booking_funnel", "booking_funnel_summary.json"));
  const latency = readJson(path.join(reportRoot, "response_latency", "response_latency_summary.json"));
  const strangerTest = readJson(path.join(reportRoot, "stranger_test", "latest.json"));
  const pitchNumbers = readJson(path.join(reportRoot, "pitch_numbers", "latest.json"));

  let portability: ReadinessInput["portability"] = null;
  try {
    const { scanUniversalEvalPortability } = await import("./eval_suite.manifest.ts");
    portability = scanUniversalEvalPortability();
  } catch {
    portability = null;
  }

  const score = evaluateReadiness({
    bookingFunnel: funnel?.summary
      ? {
          engaged: funnel.summary.engaged,
          offeredRatePct: funnel.summary.offeredRatePct,
          bookRatePct: funnel.summary.bookRatePct,
          offerToBookPct: funnel.summary.offerToBookPct,
          showed: funnel.summary.showed,
          sinceDays: funnel.sinceDays
        }
      : null,
    latency: latency?.summary?.effective
      ? { effectiveMedianMin: latency.summary.effective.medianMin, under5minPct: latency.summary.effective.under5minPct }
      : null,
    portability,
    ahHardcodes: countAhHardcodes(),
    checklistRows,
    releaseGate: releaseGate
      ? {
          verdict: releaseGate.verdict,
          cleanStreakDays: releaseGate.cleanStreakDays,
          streakTarget: releaseGate.streakTarget
        }
      : null,
    agentManagerTasks: Array.isArray(agentManager?.tasks) ? agentManager.tasks : null,
    strangerTest: strangerTest ? { passed: strangerTest.passed, at: strangerTest.at, detail: strangerTest.detail } : null,
    pitchNumbers: pitchNumbers
      ? {
          medianResponseMin: pitchNumbers.medianResponseMin,
          bookingLiftPct: pitchNumbers.bookingLiftPct,
          bdcHoursReplacedPerWeek: pitchNumbers.bdcHoursReplacedPerWeek
        }
      : null
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    dealer: process.env.DEALER_LABEL || process.env.DEALER_ID || "americanharley",
    ...score,
    targets: READINESS_TARGETS,
    sources: {
      checklist: checklistPath,
      releaseGate: path.join(reportRoot, "release_gate", "release_gate_report.json"),
      agentManager: path.join(reportRoot, "agent_manager", "agent_manager_report.json"),
      bookingFunnel: path.join(reportRoot, "booking_funnel", "booking_funnel_summary.json"),
      responseLatency: path.join(reportRoot, "response_latency", "response_latency_summary.json"),
      strangerTest: path.join(reportRoot, "stranger_test", "latest.json"),
      pitchNumbers: path.join(reportRoot, "pitch_numbers", "latest.json"),
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
    "| Section | Status | Detail |",
    "| --- | --- | --- |",
    ...score.sections.map(s => `| ${s.label} | ${s.status} | ${s.detail} |`),
    "",
    "## Metrics",
    "",
    "| Section | Metric | Value | Target | |",
    "| --- | --- | --- | --- | --- |",
    ...score.sections.flatMap(s =>
      s.metrics.map(m => `| ${s.id} | ${m.label} | ${m.value} | ${m.target} | ${m.met === null ? "info" : m.met ? "ok" : "OPEN"} |`)
    ),
    "",
    ...(score.blockers.length ? ["## Blockers", ...score.blockers.map(b => `- ${b}`)] : ["No blockers."])
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "latest.md"), md + "\n");

  console.log(formatReadinessLine(score));
  for (const s of score.sections) console.log(`  [${s.status.padEnd(12)}] ${s.label} — ${s.detail}`);
  console.log(JSON.stringify({ ok: true, verdict: score.verdict, sectionsMet: score.sectionsMet, outDir }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
