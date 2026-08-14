/**
 * Email/ADF-lane draft judge — SHADOW (Joe approved Step 2, 2026-08-02: "Ok sure").
 *
 * THE GAP THIS CLOSES. The sendgrid/ADF lane writes its drafts straight into the thread with
 * `appendOutbound(..., "draft_ai")` and never touches `publishCustomerReplyDraft`, where the
 * draft-quality judge and the context-fidelity hold live. Measured over the week to 8/2: **29 of
 * 61 AI drafts (48%) were written by this lane** — including the first message every new web lead
 * receives — with no judge on any of them. The unjudged lane is also the WORSE lane: on the 8/2
 * backtest even the lenient incumbent rated only 40.6% of its drafts "good" (vs 68.9% on SMS).
 *
 * WHY SONNET, WHY SHADOW. The 3-model bake-off (draft_judge_model_compare.ts, n=77 staff-sent
 * drafts) found gpt-5-mini rating "good, conf 0.9" on fabricated-visit drafts — the known-real
 * Knighton/Krugov class — while claude-sonnet-5 and claude-opus-5 both held them. Sonnet caught
 * the whole two-model consensus (26 shared holds) adding just 1 unilateral hold to Opus's 14, at
 * ~60% of Opus's latency and a fraction of the cost. But Sonnet's overall block rate on this lane
 * was 75%: flipping enforcement on blind would bury staff. So: judge every draft, WRITE DOWN the
 * verdict, act on nothing. The week's JSONL is the evidence for the enforce decision (Step 3 —
 * Joe's call, with the would-have-held list in hand).
 *
 * NON-BLOCKING BY CONSTRUCTION: returns void, never awaited, swallows its own errors, and is
 * capped per UTC day. Worst case is a missing log line. There is deliberately NO OpenAI fallback:
 * a shadow that silently switched models would poison the very measurement it exists to make (the
 * lesson of the claude-opus-5 temperature 400) — a failed call logs verdict:null instead.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveReportDir } from "./reportPaths.js";
import { anthropicMessagesRequest, extractAnthropicToolInput } from "./anthropicRequest.js";
import {
  DRAFT_QUALITY_JUDGE_JSON_SCHEMA,
  buildDraftQualityJudgePrompt,
  coerceDraftQualityOverall
} from "./draftQualityJudgePrompt.js";

/** Default ON — Joe approved the watch step explicitly. `EMAIL_LANE_JUDGE_SHADOW=0` disables. */
export function isEmailLaneJudgeShadowEnabled(): boolean {
  return String(process.env.EMAIL_LANE_JUDGE_SHADOW ?? "1").trim() !== "0";
}

/** Sonnet per the bake-off; overridable so the model question stays a config knob, not a deploy. */
export function emailLaneJudgeModel(): string {
  return String(process.env.EMAIL_LANE_JUDGE_MODEL ?? "").trim() || "claude-sonnet-5";
}

export function emailLaneJudgeDailyCap(): number {
  const raw = Number(process.env.EMAIL_LANE_JUDGE_DAILY_CAP ?? 150);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 150;
}

export function emailLaneJudgeShadowDir(): string {
  // Was `EMAIL_LANE_JUDGE_SHADOW_DIR || cwd/reports/...`, which skipped REPORT_ROOT entirely — so
  // every verdict this judge produced (including the correct HOLD on Lococo's fabricated price)
  // landed in the code tree, unread. See reportPaths.ts.
  return resolveReportDir("email_lane_judge", "EMAIL_LANE_JUDGE_SHADOW_DIR");
}

/** In-process spend counter, reset on the UTC date roll. Pure claim fn so the eval can pin it. */
let spendDay = "";
let spendCount = 0;
export function claimEmailLaneJudgeSlot(todayUtc: string, cap: number): boolean {
  if (todayUtc !== spendDay) {
    spendDay = todayUtc;
    spendCount = 0;
  }
  if (spendCount >= cap) return false;
  spendCount += 1;
  return true;
}
export function resetEmailLaneJudgeSpend(): void {
  spendDay = "";
  spendCount = 0;
}

export type EmailLaneJudgeShadowRecord = {
  at: string;
  convId: string;
  model: string;
  /** null = the judge call failed — never counted as a verdict, never as agreement with anything. */
  verdict: "good" | "needs_regenerate" | "hold" | null;
  confidence: number | null;
  reason: string | null;
  draft: string;
  inbound: string;
  ms: number;
  status: number;
  /**
   * The API's own words when the call failed; null on success.
   *
   * WHY (measured 2026-08-14): every call from 2026-08-10 on came back `400` and the record kept
   * only the number — 1,569 failures over five days that read, field for field, exactly like a
   * quiet week. The reason was one sentence the API had been saying all along ("Your credit
   * balance is too low…"), and nothing wrote it down. A `verdict: null` says the judge produced
   * nothing; only this field says WHY, which is the difference between a five-minute fix and a
   * five-day outage. Same lesson as the open critic's LOUD-on-failure line: a silent instrument
   * reports fine while measuring nothing.
   */
  error: string | null;
};

/** Truncated so one pathological error body can never bloat the JSONL. */
const MAX_ERROR_CHARS = 240;

/**
 * Build one shadow record. PURE, and exported so the eval pins it by EXECUTION rather than by
 * reading the source — the failure path is the half that was never exercised in production.
 */
export function buildEmailLaneJudgeShadowRecord(args: {
  at: string;
  convId: string;
  model: string;
  /** The judge's tool input, or null when the call failed / returned nothing usable. */
  parsed: any | null;
  draft: string;
  inbound: string;
  ms: number;
  status: number;
  /** Raw error body from the API response, if any. */
  errorMessage?: string | null;
}): EmailLaneJudgeShadowRecord {
  const p = args.parsed;
  const errorText = String(args.errorMessage ?? "").trim();
  return {
    at: args.at,
    convId: args.convId,
    model: args.model,
    verdict: p ? coerceDraftQualityOverall(p.overall) : null,
    confidence: p && typeof p.confidence === "number" ? Math.max(0, Math.min(1, p.confidence)) : null,
    reason: p && typeof p.reason === "string" ? p.reason.slice(0, 240) : null,
    draft: args.draft.slice(0, 300),
    inbound: args.inbound.slice(0, 200),
    ms: args.ms,
    status: args.status,
    // A successful call has nothing to explain; a failed one must never be able to hide.
    error: p ? null : errorText ? errorText.slice(0, MAX_ERROR_CHARS) : `no verdict (status ${args.status})`
  };
}

/** Append one record as JSONL. Wrapped so it can NEVER throw into the inbound path. */
function appendShadowRecord(record: EmailLaneJudgeShadowRecord): void {
  try {
    const dir = emailLaneJudgeShadowDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "email_lane_judge_shadow.jsonl"), `${JSON.stringify(record)}\n`);
  } catch {
    /* best-effort; the console line below is the fallback surface */
  }
}

/**
 * Judge a just-appended email-lane draft, in shadow. Fire-and-forget: call it bare (never
 * `await`) right after the `appendOutbound(..., "draft_ai")` it watches.
 *
 * Takes the CONV so every call site stays one line; the replied-to inbound and the history window
 * are derived here, mirroring what the SMS lane's judge sees (last inbound + last 8 turns).
 */
export function runEmailLaneJudgeShadow(conv: any, draft: string): void {
  try {
    if (!isEmailLaneJudgeShadowEnabled()) return;
    if (!String(process.env.ANTHROPIC_API_KEY ?? "").trim()) return;
    const draftText = String(draft ?? "").trim();
    if (!draftText || !conv?.id) return;

    const msgs: any[] = Array.isArray(conv.messages) ? conv.messages : [];
    // The draft was just appended; walk back past it to the most recent inbound.
    let inbound = "";
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.direction === "in" && String(m?.body ?? "").trim()) {
        inbound = String(m.body).trim();
        break;
      }
    }
    if (!inbound) return; // proactive/cadence draft — not this judge's domain (same rule as SMS)
    if (!claimEmailLaneJudgeSlot(new Date().toISOString().slice(0, 10), emailLaneJudgeDailyCap())) return;

    const historyLines = msgs
      .slice(-9, -1) // the 8 turns before the just-appended draft — the SMS judge's window
      .filter(m => String(m?.body ?? "").trim())
      .map(m => `${m.direction}: ${String(m.body).trim()}`);
    const model = emailLaneJudgeModel();
    const prompt = buildDraftQualityJudgePrompt({
      draft: draftText,
      inbound,
      historyLines,
      leadModel: conv?.lead?.vehicle?.model ?? conv?.lead?.vehicle?.description ?? null,
      leadSource: conv?.lead?.source ?? null,
      channel: "email"
    });

    void anthropicMessagesRequest({
      apiKey: String(process.env.ANTHROPIC_API_KEY ?? ""),
      model,
      maxTokens: 400,
      temperature: 0,
      toolName: "draft_quality_judge",
      inputSchema: DRAFT_QUALITY_JUDGE_JSON_SCHEMA,
      messages: [{ role: "user", content: prompt }]
    })
      .then(result => {
        const p = result.ok ? extractAnthropicToolInput(result.data, "draft_quality_judge") : null;
        const record = buildEmailLaneJudgeShadowRecord({
          at: new Date().toISOString(),
          convId: String(conv.id),
          model,
          parsed: p,
          draft: draftText,
          inbound,
          ms: result.elapsedMs,
          status: result.status,
          errorMessage: result.data?.error?.message ?? null
        });
        appendShadowRecord(record);
        if (!p) {
          // LOUD on failure, exactly like the open critic's Claude arm: the quiet log line below
          // is indistinguishable from a healthy no-op, which is how five days of 400s went unseen.
          console.warn("[email_lane_judge shadow] judge call FAILED — no verdict", {
            convId: record.convId,
            model,
            status: record.status,
            error: record.error
          });
          return;
        }
        console.log("[email_lane_judge shadow]", {
          convId: record.convId,
          verdict: record.verdict,
          confidence: record.confidence,
          ms: record.ms
        });
      })
      .catch(() => {
        /* a shadow must never surface an error into the inbound path */
      });
  } catch {
    /* never throw into the caller */
  }
}
