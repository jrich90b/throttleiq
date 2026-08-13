/**
 * Parser stability + perturbation sweep — the I/O half. Pure logic lives in
 * services/api/src/domain/parserStability.ts (and is what ci:eval pins).
 *
 * Answers one question the 494-eval gate structurally cannot: **does a reader give the same answer
 * twice, and does it survive a customer typing the same thing slightly differently?** Every eval in
 * the gate asks its question ONCE, with one wording. Two production misses in one week lived in
 * exactly that blind spot — McGary's identical text flipping 2 runs in 10, and a job applicant lost
 * to a missing question mark.
 *
 * ⚠️ NOT IN ci:eval, on purpose. Repeat-sampling an LLM is probabilistic; a probabilistic assertion
 * in the merge gate red-lines main on bad luck for every other actor. This REPORTS. Cases graduate
 * into the gate one at a time, once measured stable.
 *
 * Usage:
 *   set -a; source .env; set +a
 *   LLM_ENABLED=1 npx tsx scripts/parser_stability_sweep.ts [--runs 6] [--case <id>] [--json]
 *
 * Env: OPENAI_API_KEY (required), REPORT_ROOT (optional; defaults to ./reports).
 * Cost: runs x (1 + perturbations) parser calls per case. At the default 6 runs and 6
 * perturbations that is 12 calls per case on gpt-5-mini — cents, not dollars.
 */
import fs from "node:fs";
import path from "node:path";
import {
  PERTURBATIONS,
  rankVerdicts,
  summarizeCase,
  summarizeSweep,
  type EvidenceScope,
  type StabilityObservation
} from "../services/api/src/domain/parserStability.ts";
import {
  classifyDeptWidgetBikeInterestWithLLM,
  parseBookingIntentWithLLM,
  parseCustomerDispositionWithLLM
} from "../services/api/src/domain/llmDraft.ts";
import { decideDeptWidgetBikeClarify } from "../services/api/src/domain/webWidgetDeptBikeClarify.ts";

type SweepCase = {
  id: string;
  /** Where this text came from in production — never an invented sentence. */
  provenance: string;
  text: string;
  scope: EvidenceScope;
  /** The BRANCH the system takes, never the raw label — a reader has several ways to say one thing. */
  expected: string;
  run: (text: string) => Promise<string>;
};

const dept = (deptLabel: string) => async (text: string): Promise<string> => {
  const parse = await classifyDeptWidgetBikeInterestWithLLM({ message: text, deptLabel });
  if (!parse) return "parse_failed";
  return decideDeptWidgetBikeClarify({ parse, firstName: "X", deptLabel }) ? "bike_clarify" : "plain_dept_ack";
};

const disposition = async (text: string): Promise<string> => {
  const parse = await parseCustomerDispositionWithLLM({ text });
  if (!parse) return "parse_failed";
  // The branch that matters is "does this close/step-back the lead", not which flavour of it.
  return parse.disposition && parse.disposition !== "none" ? "disposition_recorded" : "no_disposition";
};

const booking = async (text: string): Promise<string> => {
  const parse = await parseBookingIntentWithLLM({ text });
  if (!parse) return "parse_failed";
  return parse.intent === "schedule" || parse.intent === "reschedule" ? "wants_a_time" : "no_booking_intent";
};

/**
 * The cases. Every `text` is a real production message (redacted where needed) — an invented
 * sentence would measure our imagination, not the reader. Start narrow and deep: the three readers
 * that decide the most, plus both known production failures as permanent regression sentinels.
 */
const CASES: SweepCase[] = [
  {
    id: "dept_widget_owned_unit_mcgary",
    provenance: "+17165502654, Service widget, 2026-08-12 — the reader flipped 2 runs in 10 pre-fix (#678)",
    text: "Can I ask what is going on with my 2026 street glide?",
    scope: "single_turn",
    expected: "plain_dept_ack",
    run: dept("Service")
  },
  {
    id: "dept_widget_bike_james_brown",
    provenance: "+15415147201, Motor Clothes widget — Joe ruling 2026-07-26 #4",
    text: "Checking out Pan America HD",
    scope: "single_turn",
    expected: "bike_clarify",
    run: dept("Motor Clothes")
  },
  {
    id: "dept_widget_owner_also_shopping",
    provenance: "the #678 carve-out: an owner asking about a DIFFERENT bike still clarifies",
    text: "While my Road King is in for service, do you have a Low Rider ST on the floor?",
    scope: "single_turn",
    expected: "bike_clarify",
    run: dept("Service")
  },
  {
    id: "dept_widget_pure_apparel",
    provenance: "the apparel negative that must never trip the clarify",
    text: "Do you carry XL leather riding gloves?",
    scope: "single_turn",
    expected: "plain_dept_ack",
    run: dept("Motor Clothes")
  },
  {
    id: "disposition_better_offer",
    provenance: "#588 — the courtesy word 'Thanks' stopped the disposition parser listening",
    text: "Found a better offer. Thanks",
    scope: "single_turn",
    expected: "disposition_recorded",
    run: disposition
  },
  {
    id: "disposition_night_shift_not_a_signoff",
    provenance: "a live credit-app deal that got SILENCE — 'just got up' is not a goodbye",
    text: "just got up I work over nights",
    scope: "single_turn",
    expected: "no_disposition",
    run: disposition
  },
  {
    id: "booking_explicit_day_time",
    provenance: "+17165230421, 2026-08-12 — the customer naming his own arrival time",
    text: "Let's shoot for next Tuesday. I get out of work at 4 o'clock and I can leave straight after that and be there by 4:30.",
    scope: "single_turn",
    expected: "wants_a_time",
    run: booking
  },
  {
    id: "booking_deferral_is_not_a_booking",
    provenance: "the fail-unsafe direction: a promise to get back to us must NOT book anything",
    text: "I'll let you know later this week once I know my schedule",
    scope: "single_turn",
    expected: "no_booking_intent",
    run: booking
  }
];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 ? String(argv[i + 1] ?? "") : null;
  };
  const runs = Math.max(1, Number(arg("--runs") ?? 6) || 6);
  const only = arg("--case");
  const asJson = argv.includes("--json");

  if (!process.env.OPENAI_API_KEY) {
    console.error("parser_stability_sweep: no OPENAI_API_KEY — nothing measured (this is not a pass).");
    process.exit(2);
  }
  process.env.LLM_ENABLED = "1";
  // Match PRODUCTION's parser flags, so the sweep measures the readers rather than a dev box's
  // switches. Without this the booking parser returns null on a laptop and the first run of this
  // sweep called that "stably WRONG" — see PARSE_FAILED.
  for (const flag of ["LLM_BOOKING_PARSER_ENABLED", "LLM_DEPT_WIDGET_BIKE_INTEREST_ENABLED"]) {
    if (!process.env[flag]) process.env[flag] = "1";
  }

  const cases = only ? CASES.filter(c => c.id === only) : CASES;
  if (!cases.length) {
    console.error(`parser_stability_sweep: no case matches --case ${only}`);
    process.exit(2);
  }

  const observations: StabilityObservation[] = [];
  for (const c of cases) {
    // Base: the unchanged text, N times. This is the WOBBLE measurement.
    for (let i = 0; i < runs; i++) {
      observations.push({ caseId: c.id, variantId: "base", decision: await c.run(c.text) });
    }
    // Perturbed: each surface rewrite once. This is the FRAGILITY measurement.
    for (const p of PERTURBATIONS) {
      const text = p.apply(c.text);
      if (text === c.text) continue; // a no-op rewrite proves nothing
      observations.push({ caseId: c.id, variantId: p.id, decision: await c.run(text) });
    }
  }

  const verdicts = rankVerdicts(
    cases.map(c => summarizeCase({ caseId: c.id, scope: c.scope, expected: c.expected, observations }))
  );
  const summary = summarizeSweep(verdicts);

  const reportRoot = process.env.REPORT_ROOT || path.resolve("reports");
  const dir = path.join(reportRoot, "parser_stability");
  fs.mkdirSync(dir, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    runsPerCase: runs,
    perturbations: PERTURBATIONS.map(p => p.id),
    summary,
    verdicts,
    provenance: Object.fromEntries(cases.map(c => [c.id, c.provenance]))
  };
  fs.writeFileSync(path.join(dir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(
    `Parser stability — ${summary.cases} case(s), ${runs} runs each + ${PERTURBATIONS.length} perturbations.`
  );
  console.log(
    `  ${summary.clean} clean | ${summary.fragile} fragile | ${summary.stablyWrong} stably WRONG | ` +
      `${summary.wobbling} WOBBLING | ${summary.notMeasured} not measured`
  );
  for (const scope of ["single_turn", "needs_history"] as EvidenceScope[]) {
    const s = summary.byScope[scope];
    if (s.cases) console.log(`  evidence scope ${scope}: ${s.notClean} of ${s.cases} not clean`);
  }
  console.log("");
  for (const v of verdicts) {
    const flag = !v.measured
      ? "NOT-MEA"
      : !v.stable
        ? "WOBBLE "
        : !v.correct
          ? "WRONG  "
          : v.fragileUnder.length
            ? "FRAGILE"
            : "ok     ";
    const base = Object.entries(v.baseDecisions)
      .map(([d, n]) => `${d} x${n}`)
      .join(", ");
    console.log(`  ${flag} ${v.caseId}`);
    console.log(`          unchanged text (${v.baseRuns} runs): ${base}   [want ${v.expected}]`);
    if (!v.measured) {
      console.log("          reader did not run — a flag is off or a key is missing. NOT a wrong answer.");
    }
    if (v.fragileUnder.length) console.log(`          breaks under: ${v.fragileUnder.join(", ")}`);
  }
  console.log(`\nReport written: ${path.join(dir, "latest.json")}`);
  // Always exit 0: this is an instrument, not a gate. A finding here opens a slice, it does not
  // block anyone's merge.
}

await main();
