/**
 * CHALLENGER SHADOW ARM for the per-turn judges (Joe, 2026-08-02).
 *
 * Joe asked why the per-turn judges shouldn't just go to the biggest model. Then he found the
 * counter-evidence himself — the widely-cited result that **Claude 3 Opus was not worth it as an
 * LLM judge over Claude 3.5 Sonnet**: slower, dearer, no measurable gain in evaluation accuracy.
 * That pair is two generations behind what we would actually run (Opus 5 vs Sonnet 4.6), so it is
 * not a verdict on today's models — but the SHAPE of it is the point, and it matches what we have
 * already measured on our own stack: on 2026-07-31 `gpt-5` beat `gpt-5-mini` on exactly nothing
 * (both 3/3 on two comprehension evals). **Bigger is a hypothesis, not an upgrade.**
 *
 * Hence this module: it does not pick a winner, it runs a bake-off. Every configured challenger
 * answers the SAME prompt the shipped judge just answered, and both verdicts are logged side by
 * side. After a week the disagreement list decides — including the entirely live possibility that
 * the incumbent `gpt-5-mini` holds and we change nothing.
 *
 * The two reasons this had to be a shadow rather than a switch, both measured on the box:
 *   1. LATENCY. These judges are `await`ed inside the reply path. claude-opus-5 answered a trivial
 *      prompt in 2,806ms against claude-sonnet-4-6's 923ms. Invisible while staff approve every
 *      draft; not invisible once first-touch auto-send flips (median 61min vs a 15min target).
 *   2. THE RULER. Three of these judges are called live inside `ci:eval`. Changing the judge model
 *      changes the ruler and the thing it measures in one move.
 *
 * **NON-BLOCKING BY CONSTRUCTION.** `runJudgeShadowArm` returns void and is never awaited — the
 * shipped verdict is already computed and returned before any challenger resolves. A shadow arm
 * that added seconds to a customer's wait would break the very thing it exists to measure. Each
 * call still times itself, so we learn a challenger's latency without paying it.
 *
 * **CAPPED.** `JUDGE_SHADOW_DAILY_CAP` (default 300 challenger calls per UTC day, in-process, and
 * counted PER CALL so adding a second challenger halves the turns covered rather than doubling the
 * bill). The human-thread nudge shipped uncapped LLM cost once and had to be reverted.
 *
 * FAIL DIRECTION: this module cannot change any customer-visible outcome. It never returns a
 * verdict to a caller, it swallows its own errors, and with the flag unset it does nothing at all.
 * The worst case is a missing log line.
 */
import fs from "node:fs";

import { anthropicMessagesRequest, extractAnthropicToolInput } from "./anthropicRequest.js";

/**
 * Sonnet FIRST, deliberately. Joe's second finding — that the Sonnet tier carries the reasoning
 * density for multi-turn conversations plus a long enough window to audit a whole chat session in
 * one pass — describes the judging job better than "use the biggest model" does. Opus 5 stays in
 * the list as the control on that claim, not as the favourite. If Sonnet 5 matches it on our
 * disagreements, Sonnet wins on latency and cost and the decision is made for us.
 *
 * **AND THE BIGGER PRIZE IS CONTEXT, NOT TIER — the next experiment, deliberately not this one.**
 * Every judge here sees a SLICE, never the thread: the draft-quality judge gets the last 8 messages
 * (`buildDraftJudgeHistory(conv, 8)`), the cadence judge similar, most parsers `.slice(-4)`. Now
 * look at what our judges actually get wrong. #431 graded an April reply against a June one. #418
 * chased a bike that had already sold. Larry's walk-in note was judged as customer speech. Those
 * are not failures of reasoning power — they are failures of a judge that could not see far enough
 * back to know better, and a bigger model reading the same 8 messages fixes none of them. Widening
 * the window is its own PR with its own token-cost question; this arm exists so that when we run
 * it we already know what the model tier alone is worth.
 */
export const JUDGE_SHADOW_DEFAULT_MODELS = ["claude-sonnet-5", "claude-opus-5"];

export function isJudgeShadowArmEnabled(): boolean {
  return String(process.env.JUDGE_SHADOW_ARM ?? "").trim() === "1";
}

export function judgeShadowModels(): string[] {
  const configured = String(process.env.JUDGE_SHADOW_MODELS ?? "")
    .split(",")
    .map(m => m.trim())
    .filter(Boolean);
  return configured.length ? configured : [...JUDGE_SHADOW_DEFAULT_MODELS];
}

export function judgeShadowDailyCap(): number {
  const raw = Number(process.env.JUDGE_SHADOW_DAILY_CAP ?? 300);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 300;
}

/** In-process spend counter, reset when the UTC date rolls. */
let spendDay = "";
let spendCount = 0;

/**
 * Pure so the eval can exercise the cap with no clock and no network: returns whether this single
 * challenger call is allowed, and increments when it is.
 */
export function claimJudgeShadowSlot(todayUtc: string, cap: number): boolean {
  if (todayUtc !== spendDay) {
    spendDay = todayUtc;
    spendCount = 0;
  }
  if (spendCount >= cap) return false;
  spendCount += 1;
  return true;
}

/** Test seam: forget today's spend. */
export function resetJudgeShadowSpend(): void {
  spendDay = "";
  spendCount = 0;
}

export function judgeShadowSpendCount(): number {
  return spendCount;
}

/**
 * Compare a shipped verdict against a challenger's. `null` on either side means "no comparison
 * available" and must NEVER read as agreement — a challenger that failed to answer would otherwise
 * inflate the agreement rate and argue for changing nothing.
 */
export function judgeVerdictsAgree(
  primary: string | null | undefined,
  shadow: string | null | undefined
): boolean | null {
  if (primary === null || primary === undefined || primary === "") return null;
  if (shadow === null || shadow === undefined || shadow === "") return null;
  return String(primary) === String(shadow);
}

/**
 * WHERE THE VERDICT PAIRS GO — a durable JSONL file, not just the pm2 log.
 *
 * The arm's whole purpose is a comparison read a WEEK after it starts, and `console.log` cannot
 * survive that trip: pm2 lines truncate and the log rotates. That exact artifact already produced
 * one wrong conclusion on this codebase — the self-heal review read "~21 events in 5 weeks" off the
 * pm2 tail when the real volume was 4-8 a day. A shadow arm whose evidence evaporates before the
 * readout is worse than no arm, because it looks like it ran.
 *
 * Same shape and same fail-direction as `parserCapture.ts`: daily files, every error swallowed,
 * nothing the reply path can ever depend on. Disabled by the same flag as the arm itself, so with
 * `JUDGE_SHADOW_ARM` unset this writes nothing at all.
 */
export function resolveJudgeShadowDir(env: {
  JUDGE_SHADOW_DIR?: string;
  REPORT_ROOT?: string;
}): string | null {
  const explicit = String(env.JUDGE_SHADOW_DIR ?? "").trim();
  if (explicit) return explicit;
  const root = String(env.REPORT_ROOT ?? "").trim();
  if (root) return `${root}/judge_shadow`;
  return null;
}

export type JudgeShadowRecord = {
  at: string;
  operation: string;
  primaryModel: string;
  primaryVerdict: string | null;
  shadowModel: string;
  shadowVerdict: string | null;
  /**
   * NULL is a third state and the readout must not flatten it: it means the two verdicts were not
   * COMPARABLE (the challenger errored, or returned nothing), which is neither agreement nor
   * disagreement. Counting a null as "agree" would quietly inflate the incumbent's score by exactly
   * the number of times the challenger failed to answer.
   */
  agree: boolean | null;
  shadowMs: number | null;
  status: number | null;
  retriedWithoutTemperature: boolean;
};

/**
 * Build the record, separately from writing it — the same split as
 * `buildParserCaptureRecord` / `appendParserCaptureRecord`.
 *
 * This exists so the NULL rule is testable. `judgeVerdictsAgree` returns null when the two verdicts
 * are not comparable (the challenger errored or returned nothing), and that must reach the file as
 * null. Coercing it to `false` invents a disagreement; coercing it to `true` credits the incumbent
 * for a call that never happened. Both quietly decide the very question the arm was built to answer,
 * and neither is visible once the row is on disk — which is why it is pinned here rather than
 * trusted to a reviewer.
 */
export function buildJudgeShadowRecord(args: {
  at: string;
  operation: string;
  primaryModel: string;
  primaryVerdict: string | null | undefined;
  shadowModel: string;
  shadowVerdict: string | null;
  shadowMs?: number | null;
  status?: number | null;
  retriedWithoutTemperature?: boolean | null;
}): JudgeShadowRecord {
  return {
    at: args.at,
    operation: args.operation,
    primaryModel: args.primaryModel,
    primaryVerdict: args.primaryVerdict ?? null,
    shadowModel: args.shadowModel,
    shadowVerdict: args.shadowVerdict,
    agree: judgeVerdictsAgree(args.primaryVerdict, args.shadowVerdict),
    shadowMs: args.shadowMs ?? null,
    status: args.status ?? null,
    retriedWithoutTemperature: !!args.retriedWithoutTemperature
  };
}

export function appendJudgeShadowRecord(record: JudgeShadowRecord): void {
  try {
    const dir = resolveJudgeShadowDir(process.env as any);
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    const day = record.at.slice(0, 10).replace(/-/g, "") || "unknown";
    fs.appendFileSync(`${dir}/judge_shadow_${day}.jsonl`, `${JSON.stringify(record)}\n`);
  } catch {
    // best-effort by design — the arm must never disturb the live path
  }
}

/**
 * Fire the same judgment at every challenger and log the answers beside the shipped one. Returns
 * void deliberately — nothing may consume a shadow verdict.
 */
export function runJudgeShadowArm(args: {
  /** e.g. "draft_quality_judge" — the log key we group disagreements by. */
  operation: string;
  /** The EXACT prompt the shipped judge used, so the comparison is apples to apples. */
  prompt: string;
  schemaName: string;
  schema: { [key: string]: unknown };
  maxOutputTokens?: number;
  /** The shipped judge's model and its headline verdict, for the side-by-side. */
  primaryModel: string;
  primaryVerdict: string | null | undefined;
  /** Which field of the challenger payload carries the comparable headline verdict. */
  verdictField: string;
}): void {
  try {
    if (!isJudgeShadowArmEnabled()) return;
    const apiKey = String(process.env.ANTHROPIC_API_KEY ?? "").trim();
    if (!apiKey) return;

    const today = new Date().toISOString().slice(0, 10);
    const cap = judgeShadowDailyCap();

    for (const model of judgeShadowModels()) {
      if (!claimJudgeShadowSlot(today, cap)) return;
      void anthropicMessagesRequest({
        apiKey,
        model,
        maxTokens: args.maxOutputTokens ?? 400,
        temperature: 0,
        toolName: args.schemaName,
        inputSchema: args.schema,
        messages: [{ role: "user", content: args.prompt }]
      })
        .then(result => {
          const payload = result.ok ? extractAnthropicToolInput(result.data, args.schemaName) : null;
          const shadowVerdict = payload ? String((payload as any)[args.verdictField] ?? "") : null;
          const record = buildJudgeShadowRecord({
            at: new Date().toISOString(),
            operation: args.operation,
            primaryModel: args.primaryModel,
            primaryVerdict: args.primaryVerdict,
            shadowModel: model,
            shadowVerdict,
            shadowMs: result.elapsedMs,
            status: result.status,
            retriedWithoutTemperature: result.retriedWithoutTemperature
          });
          // The pm2 line stays for live tailing; the JSONL is what the readout reads.
          console.log("[judge_shadow_arm]", record);
          appendJudgeShadowRecord(record);
        })
        .catch(() => {
          // A shadow arm must never surface an error into the reply path.
        });
    }
  } catch {
    /* never throw into the caller */
  }
}
