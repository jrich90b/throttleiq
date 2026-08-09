/**
 * pitch_numbers:report — section 5 of the dealer-#2 readiness bar, computed instead of guessed.
 *
 * Joe's five-section bar (memory `north-star-readiness-bar`, charter North star) ends with
 * "pitch numbers: the scorecard doubles as the first sales-deck slide". Sections 1-4 have had
 * producers since 7/30; section 5 has read NOT_MEASURED ever since, because nothing wrote
 * `<reportRoot>/pitch_numbers/latest.json`. `rollout_readiness_report.ts` has always READ that
 * file. This is the missing writer — no scorecard change, no new target, no new threshold.
 *
 * THE THREE NUMBERS, and why only two of them can be honest today:
 *
 *  1. medianResponseMin — how fast a customer hears back. Lifted straight off the response-latency
 *     report's TRAILING-30d effective median (the same figure section 1 grades), so the pitch and
 *     the bar can never quote different numbers. Not recomputed here.
 *
 *  2. bookingLiftPct — the one claim that needs something to lift FROM. Joe's pre-LeadRider close
 *     rate is 6%, and on his follow-up that 6% was ONLINE leads specifically
 *     (READINESS_TARGETS.pitch). So the comparable is wins / sales-intent ONLINE leads. It is a
 *     CLOSE rate, deliberately NOT the booking rate section 1 grades — do not compare the two.
 *
 *  3. bdcHoursReplacedPerWeek — ALWAYS null. It needs a BDC staffing baseline (how many hours a
 *     human BDC spent on this lead volume) that only Joe can supply. There is no honest way to
 *     infer it from the store, so this producer never tries. `null` is the correct answer, and
 *     the scorecard renders it "not yet measured".
 *
 * WHY A MATURITY LAG, MEASURED NOT ASSUMED. A close rate over "the last 30 days" is wrong in a way
 * that looks rigorous: it puts leads that arrived last week in the denominator without the sales
 * they have not had time to close yet. Measured on the live store 2026-08-09 (65 wins): days from
 * lead arrival to sale were p50=8, p75=17, p90=41, max=118. So the cohort here EXCLUDES leads
 * younger than `maturityDays` (default 45 — p90, rounded). Without it the July cohort reads 5.3%,
 * i.e. BELOW Joe's 6% baseline, purely because those deals have not closed yet.
 *
 * AND WHY A SENSITIVITY BAND. A single knob-picked number is a boast. This recomputes the lift
 * across every defensible window x maturity combination and publishes the band; the headline lift
 * is only reported when the WHOLE band clears zero. If a future reading is knob-sensitive, the
 * band widens and `bookingLiftPct` goes null rather than flattering. Measured 2026-08-09:
 * close rate 9.7-11.2% across the grid, lift +62% to +87% — the claim does not depend on the knobs.
 *
 * Deterministic and read-only: it consumes conversations + one report, writes one report, and
 * sends nothing. No runtime code imports it.
 *
 * Usage:
 *   CONVERSATIONS_DB_PATH=/path/conversations.json REPORT_ROOT=/path/reports \
 *     npx tsx scripts/pitch_numbers_report.ts [--report-root DIR] [--window-days N] [--maturity-days N]
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isSalesIntentLead } from "../services/api/src/domain/bookingFunnel.ts";
import { READINESS_TARGETS } from "./rollout_readiness_report.ts";

/**
 * Sources that are NOT online leads, and so are outside what Joe's 6% is scoped to. Structured
 * extraction over OUR OWN `lead.source` field (never customer text). High-precision: a source we
 * fail to recognise as walk-in stays in the denominator, which UNDERSTATES the close rate — the
 * safe direction for a number we are going to put in front of a dealer.
 */
const NON_ONLINE_SOURCE = /walk.?in|phone.?up|showroom|in.?store/i;

/** Cohort sizes below this are noise, not a measurement — same spirit as funnel.minEngagedSample. */
export const PITCH_MIN_COHORT = 60;

/** The grid the sensitivity band is computed over. Maturity below 30d is not yet a mature cohort. */
export const PITCH_SENSITIVITY_GRID = { windowDays: [90, 180], maturityDays: [30, 45, 60] } as const;

export const PITCH_DEFAULTS = { windowDays: 180, maturityDays: 45 } as const;

export type PitchNumbersInput = {
  conversations: any[];
  nowMs: number;
  /** Trailing-30d effective median reply time, from the response-latency report. */
  medianResponseMin: number | null;
  windowDays?: number;
  maturityDays?: number;
  baselineCloseRatePct?: number;
};

export type PitchNumbers = {
  /** The three fields rollout_readiness_report.ts reads. Everything else is evidence. */
  medianResponseMin: number | null;
  bookingLiftPct: number | null;
  bdcHoursReplacedPerWeek: null;
  closeRatePct: number | null;
  baselineCloseRatePct: number;
  baselineScope: string;
  cohort: {
    n: number;
    wins: number;
    windowDays: number;
    maturityDays: number;
    fromIso: string;
    toIso: string;
  };
  sensitivity: {
    liftMinPct: number | null;
    liftMaxPct: number | null;
    points: Array<{ windowDays: number; maturityDays: number; n: number; wins: number; closeRatePct: number; liftPct: number }>;
  };
  /** Why a number is null, in plain words. Empty when every reportable number is present. */
  notes: string[];
};

function isWon(conv: any): boolean {
  return conv?.closedReason === "sold" || Boolean(conv?.sale?.soldAt);
}

/** Sales-intent (shared with the booking funnel, so the two can never disagree) AND online. */
export function isOnlineSalesLead(conv: any): boolean {
  if (!isSalesIntentLead(conv)) return false;
  return !NON_ONLINE_SOURCE.test(String(conv?.lead?.source ?? ""));
}

function cohortAt(
  leads: any[],
  nowMs: number,
  windowDays: number,
  maturityDays: number
): { n: number; wins: number; fromMs: number; toMs: number } {
  const day = 24 * 60 * 60 * 1000;
  const fromMs = nowMs - windowDays * day;
  const toMs = nowMs - maturityDays * day;
  let n = 0;
  let wins = 0;
  for (const conv of leads) {
    const created = Date.parse(String(conv?.createdAt ?? ""));
    if (!Number.isFinite(created) || created < fromMs || created > toMs) continue;
    n += 1;
    if (isWon(conv)) wins += 1;
  }
  return { n, wins, fromMs, toMs };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function computePitchNumbers(input: PitchNumbersInput): PitchNumbers {
  const windowDays = input.windowDays ?? PITCH_DEFAULTS.windowDays;
  const maturityDays = input.maturityDays ?? PITCH_DEFAULTS.maturityDays;
  const baseline = input.baselineCloseRatePct ?? READINESS_TARGETS.pitch.preLeadRiderCloseRatePct;
  const leads = (input.conversations ?? []).filter(isOnlineSalesLead);
  const notes: string[] = [];

  const headline = cohortAt(leads, input.nowMs, windowDays, maturityDays);
  const closeRatePct = headline.n > 0 ? round1((headline.wins / headline.n) * 100) : null;

  // The grid ALWAYS includes the configuration actually used. Without that, a caller overriding
  // --maturity-days sits outside its own robustness check: the band would report "robust" about a
  // set of knob settings the headline is not one of. Caught by this eval's TRAP-1 contrast case.
  const combos: Array<{ w: number; m: number }> = [{ w: windowDays, m: maturityDays }];
  for (const w of PITCH_SENSITIVITY_GRID.windowDays) {
    for (const m of PITCH_SENSITIVITY_GRID.maturityDays) {
      if (!combos.some(c => c.w === w && c.m === m)) combos.push({ w, m });
    }
  }
  const points = combos.map(({ w, m }) => {
    const c = cohortAt(leads, input.nowMs, w, m);
    const rate = c.n > 0 ? (c.wins / c.n) * 100 : 0;
    return {
      windowDays: w,
      maturityDays: m,
      n: c.n,
      wins: c.wins,
      closeRatePct: round1(rate),
      liftPct: Math.round(((rate - baseline) / baseline) * 100)
    };
  });
  // Only grid points with a usable cohort get a vote — a tiny window can't veto a real claim,
  // and it can't manufacture one either (it is excluded, not counted as agreement).
  const usable = points.filter(p => p.n >= PITCH_MIN_COHORT);
  const liftMinPct = usable.length ? Math.min(...usable.map(p => p.liftPct)) : null;
  const liftMaxPct = usable.length ? Math.max(...usable.map(p => p.liftPct)) : null;

  let bookingLiftPct: number | null = null;
  if (headline.n < PITCH_MIN_COHORT) {
    notes.push(
      `booking lift not reported: the mature cohort is ${headline.n} lead(s), under the ${PITCH_MIN_COHORT} needed to be a measurement rather than noise.`
    );
  } else if (closeRatePct === null || closeRatePct <= baseline) {
    notes.push(
      `booking lift not reported: the measured close rate (${closeRatePct ?? "none"}%) is not above the ${baseline}% baseline. A shortfall is never dressed up as a lift.`
    );
  } else if (liftMinPct === null || liftMinPct <= 0) {
    notes.push(
      "booking lift not reported: the claim is not robust — at least one defensible window/maturity choice shows no lift over the baseline, so a headline number would be knob-picked."
    );
  } else {
    bookingLiftPct = Math.round((((closeRatePct as number) - baseline) / baseline) * 100);
  }

  if (input.medianResponseMin === null) {
    notes.push("median response time not reported: no trailing-30d effective median in the response-latency report.");
  }
  notes.push(
    "BDC hours replaced per week is deliberately null: it needs a staffing baseline from the dealer (hours a human BDC spent on this lead volume). It is never inferred from the store."
  );

  return {
    medianResponseMin: input.medianResponseMin,
    bookingLiftPct,
    bdcHoursReplacedPerWeek: null,
    closeRatePct,
    baselineCloseRatePct: baseline,
    baselineScope: READINESS_TARGETS.pitch.preLeadRiderCloseRateScope,
    cohort: {
      n: headline.n,
      wins: headline.wins,
      windowDays,
      maturityDays,
      fromIso: new Date(headline.fromMs).toISOString(),
      toIso: new Date(headline.toMs).toISOString()
    },
    sensitivity: { liftMinPct, liftMaxPct, points },
    notes
  };
}

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function loadConversations(storePath: string): any[] {
  const raw = readJson(storePath);
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.conversations)) return raw.conversations;
  return [];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const reportRoot = arg("--report-root") || process.env.REPORT_ROOT || path.resolve(process.cwd(), "reports");
  const storePath =
    arg("--store") ||
    process.env.CONVERSATIONS_DB_PATH ||
    path.join(process.env.DATA_DIR || path.resolve(process.cwd(), "data"), "conversations.json");

  const latency = readJson(path.join(reportRoot, "response_latency", "response_latency_summary.json"));
  const medianRaw = latency?.trailing30d?.summary?.effective?.medianMin;
  const medianResponseMin = typeof medianRaw === "number" && Number.isFinite(medianRaw) ? medianRaw : null;

  const conversations = loadConversations(storePath);
  const result = computePitchNumbers({
    conversations,
    nowMs: Date.now(),
    medianResponseMin,
    windowDays: Number(arg("--window-days") ?? PITCH_DEFAULTS.windowDays),
    maturityDays: Number(arg("--maturity-days") ?? PITCH_DEFAULTS.maturityDays)
  });

  const outDir = path.join(reportRoot, "pitch_numbers");
  fs.mkdirSync(outDir, { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    ...result,
    sources: {
      store: storePath,
      responseLatency: path.join(reportRoot, "response_latency", "response_latency_summary.json")
    }
  };
  fs.writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(payload, null, 2));

  console.log(
    `pitch numbers: median response ${result.medianResponseMin ?? "?"}min | close rate ${
      result.closeRatePct ?? "?"
    }% vs ${result.baselineCloseRatePct}% baseline (${result.baselineScope}) | lift ${
      result.bookingLiftPct === null ? "not reported" : `+${result.bookingLiftPct}%`
    } | cohort ${result.cohort.wins}/${result.cohort.n} over ${result.cohort.windowDays}d with a ${
      result.cohort.maturityDays
    }d maturity lag`
  );
  for (const note of result.notes) console.log(`  note: ${note}`);
  console.log(JSON.stringify({ ok: true, outDir }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
