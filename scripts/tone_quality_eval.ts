import fs from "node:fs";
import path from "node:path";
import { evaluateTurnToneQuality, normalizeText } from "./lib/toneQuality.ts";
import { matchInboundReply } from "./lib/toneResponseMatch.ts";
import {
  isAutomatedSenderInbound,
  isClosingAckNoAction,
  isEnthusiasmAckNoAction,
  isHumanRewrittenOutbound,
  isIndefiniteDeferralNoActionableAsk,
  isLeadIntakeRenotificationOnEngagedThread,
  isNonSalesConversation,
  isOptOutKeywordInbound,
  isQuotedReactionEchoInbound,
  isShadowReplayMessage,
  isShortAckNoAction,
  isStaffAuthoredOutbound,
  isTestLeadEmail
} from "../services/api/src/domain/scoringExclusions.ts";

type AnyObj = Record<string, any>;

type ParsedArgs = {
  conversationsPath: string;
  outDir: string;
  sinceHours: number;
  responseWindowMin: number;
};

type EvalRow = {
  convId: string;
  leadRef: string | null;
  leadName: string | null;
  leadPhone: string | null;
  inboundAt: string;
  inboundProvider: string;
  inboundText: string;
  outboundAt: string | null;
  outboundProvider: string | null;
  outboundText: string | null;
  responseLatencySec: number | null;
  score: number;
  pass: boolean;
  band: "excellent" | "good" | "needs_work" | "poor";
  intent: string;
  issueCodes: string[];
  issueDetails: Array<{ code: string; detail: string }>;
  status: "responded" | "responded_late" | "missing_response";
  // True when staff rewrote the agent's draft before sending and we graded the
  // agent's `originalDraftBody` (its actual output) rather than the human's text.
  gradedAgentDraft?: boolean;
  // True when the reply landed AFTER the response window — a real (graded) reply,
  // not a miss (Joe ruling 2026-07-13). Latency is what response_latency_audit tracks.
  respondedLate?: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) continue;
    args.set(key, value);
    i += 1;
  }

  const cwd = process.cwd();
  const dataDir = process.env.DATA_DIR || path.resolve(cwd, "data");
  const conversationsPath =
    args.get("--conversations") ||
    process.env.CONVERSATIONS_DB_PATH ||
    path.resolve(dataDir, "conversations.json");
  const outDir =
    args.get("--out-dir") ||
    process.env.TONE_QUALITY_OUT_DIR ||
    path.resolve(cwd, "reports", "tone_quality");
  const sinceHoursRaw = Number(args.get("--since-hours") || process.env.TONE_QUALITY_SINCE_HOURS || "24");
  const responseWindowMinRaw = Number(
    args.get("--response-window-min") || process.env.TONE_QUALITY_RESPONSE_WINDOW_MIN || "30"
  );

  return {
    conversationsPath,
    outDir,
    sinceHours: Number.isFinite(sinceHoursRaw) && sinceHoursRaw >= 0 ? sinceHoursRaw : 24,
    responseWindowMin: Number.isFinite(responseWindowMinRaw) && responseWindowMinRaw > 0 ? responseWindowMinRaw : 30
  };
}

function toMessages(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.conversations)) return raw.conversations;
  return [];
}

function toMs(iso: string): number {
  const ms = Date.parse(String(iso || ""));
  return Number.isFinite(ms) ? ms : NaN;
}

function computeMedian(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function hasActionableCue(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  if (/\?/.test(t)) return true;
  return /\b(available|in stock|price|pricing|payment|payments|apr|finance|financing|monthly|down payment|term|months|come in|stop by|schedule|appointment|call me|callback|text me|tomorrow|today|next week|when)\b/.test(
    t
  );
}

function isCloseoutUpdateNoReplyNeeded(text: string): boolean {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t) return false;
  if (/\?/.test(t)) return false;
  if (
    /\b(no need|already called|already spoke|spoke with them|handled it|all set|sorted|taken care of|sorry it took so long)\b/.test(
      t
    )
  ) {
    return !hasActionableCue(t);
  }
  return false;
}

function getSkipReason(
  conv: AnyObj,
  inbound: AnyObj,
  inboundText: string,
  ctx: { hasPriorOutbound: boolean }
): string | null {
  const provider = String(inbound?.provider ?? "").trim().toLowerCase();
  const followUpMode = String(conv?.followUp?.mode ?? "").trim().toLowerCase();
  const convMode = String(conv?.mode ?? "").trim().toLowerCase();
  const leadEmail = String(conv?.lead?.email ?? "").trim().toLowerCase();
  if (isShadowReplayMessage(inbound)) return "shadow_replay_turn";
  if (isAutomatedSenderInbound({ from: inbound?.from, body: inbound?.body, convId: conv?.id })) {
    return "automated_sender";
  }
  if (
    isLeadIntakeRenotificationOnEngagedThread({
      body: inbound?.body,
      hasPriorOutbound: ctx.hasPriorOutbound
    })
  ) {
    return "lead_intake_renotification";
  }
  if (isNonSalesConversation(conv)) return "non_sales_thread";
  if (provider === "voice_transcript") return "provider_voice_transcript";
  if (isTestLeadEmail(leadEmail) || isTestLeadEmail(conv?.id)) return "test_lead_email";
  if (isOptOutKeywordInbound(inboundText)) return "opt_out_no_reply";
  if (isQuotedReactionEchoInbound(inboundText)) return "reaction_to_outbound";
  if (isShortAckNoAction(inboundText)) return "short_ack_no_action";
  if (isClosingAckNoAction(inboundText)) return "closing_ack_no_action";
  if (isEnthusiasmAckNoAction(inboundText)) return "enthusiasm_ack_no_reply";
  if (isCloseoutUpdateNoReplyNeeded(inboundText)) return "closeout_update_no_reply";
  if (isIndefiniteDeferralNoActionableAsk(inboundText)) return "indefinite_followup_deferral";
  if ((followUpMode === "manual_handoff" || followUpMode === "paused_indefinite") && !hasActionableCue(inboundText)) {
    return "manual_handoff_non_actionable";
  }
  // In Human mode the console blocks the agent from drafting/regenerating
  // (AGENTS.md: "regenerate blocked in Suggest mode / Human mode"), so staff own
  // every reply and the agent produces NO customer-facing send. Grading agent
  // tone here is a phantom regardless of whether the inbound is "actionable":
  // the graded "outbound" is either a staff-typed message or a transient,
  // never-sent draft (2026-07-20 release-gate dirt — William Indelicato,
  // Jaden Capozzi, David Miller: three human-mode threads whose graded outbounds
  // did not even exist in the live store). Dropped human-mode customer questions
  // still surface as staff items via the stuck-turn / stale-handoff reports and
  // the fresh-stuck-actionable gate metric — not as an agent-tone miss.
  if (convMode === "human") {
    return "human_mode_agent_silent";
  }
  return null;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(parsed.conversationsPath)) {
    console.error(`Conversations file not found: ${parsed.conversationsPath}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(parsed.conversationsPath, "utf8"));
  const conversations = toMessages(raw);
  const windowStartMs =
    parsed.sinceHours > 0 ? Date.now() - parsed.sinceHours * 60 * 60 * 1000 : Number.NEGATIVE_INFINITY;
  const windowEndMs = Number.POSITIVE_INFINITY;

  const rows: EvalRow[] = [];
  const skippedReasonMap = new Map<string, number>();
  let skippedTurns = 0;
  for (const conv of conversations) {
    const convId = String(conv?.id ?? conv?.leadKey ?? "");
    if (!convId) continue;
    const leadRef = conv?.lead?.leadRef ? String(conv.lead.leadRef) : null;
    const leadName = [conv?.lead?.firstName, conv?.lead?.lastName].filter(Boolean).join(" ") || null;
    const leadPhone = conv?.lead?.phone ? String(conv.lead.phone) : null;
    const messages = Array.isArray(conv?.messages) ? [...conv.messages] : [];
    messages.sort((a, b) => toMs(String(a?.at ?? "")) - toMs(String(b?.at ?? "")));

    for (let i = 0; i < messages.length; i += 1) {
      const inbound = messages[i];
      if (inbound?.direction !== "in") continue;
      const inboundAtIso = String(inbound?.at ?? "");
      const inboundAtMs = toMs(inboundAtIso);
      if (!Number.isFinite(inboundAtMs)) continue;
      if (inboundAtMs < windowStartMs || inboundAtMs > windowEndMs) continue;

      const inboundText = normalizeText(inbound?.body);
      if (!inboundText) continue;
      const hasPriorOutbound = messages.slice(0, i).some(m => String(m?.direction) === "out");
      const skipReason = getSkipReason(conv, inbound, inboundText, { hasPriorOutbound });
      if (skipReason) {
        skippedTurns += 1;
        skippedReasonMap.set(skipReason, (skippedReasonMap.get(skipReason) ?? 0) + 1);
        continue;
      }

      // A reply that lands AFTER the 30-min window is still a real, graded reply —
      // NOT a `missing_response` miss (Joe ruling 2026-07-13). matchInboundReply
      // returns the prompt reply, the late reply, or null when the turn was truly
      // dropped (customer re-nudged first, or no reply at all).
      const match = matchInboundReply(messages, i, parsed.responseWindowMin);

      if (!match) {
        rows.push({
          convId,
          leadRef,
          leadName,
          leadPhone,
          inboundAt: inboundAtIso,
          inboundProvider: String(inbound?.provider ?? ""),
          inboundText,
          outboundAt: null,
          outboundProvider: null,
          outboundText: null,
          responseLatencySec: null,
          score: 0,
          pass: false,
          band: "poor",
          intent: "general",
          issueCodes: ["missing_response"],
          issueDetails: [{ code: "missing_response", detail: "no reply before the customer's next message" }],
          status: "missing_response"
        });
        continue;
      }

      const matchedOut = match.matchedOut;

      // A reply a staff member TYPED FROM SCRATCH (author marker, no
      // `originalDraftBody`) has no agent draft behind it at all — there is nothing of
      // the agent's to grade, so counting it as an agent tone failure is a phantom.
      // Production 2026-07-22: Joe's own one-character "😂" answer to Scott Gresko's
      // joke (+15857552622) scored 65 / `intent_mismatch` against the AGENT. This is
      // narrower than the human-mode skip above (that one covers whole threads) and
      // distinct from the rewrite case below (there an agent draft exists and IS
      // graded), so the sample only loses turns the agent never wrote.
      if (isStaffAuthoredOutbound(matchedOut ?? {})) {
        skippedTurns += 1;
        skippedReasonMap.set(
          "staff_typed_reply_no_agent_draft",
          (skippedReasonMap.get("staff_typed_reply_no_agent_draft") ?? 0) + 1
        );
        continue;
      }

      // When a staff member rewrote the agent's draft before sending, the SENT
      // body is the human's words, not the agent's — grading the agent on it is a
      // phantom miss. Grade the agent's own draft (`originalDraftBody`) instead:
      // this measures what the agent WOULD have sent (the autopilot-readiness
      // signal the release gate wants) and is fail-safe (a bad draft still scores
      // bad), while keeping the turn in the denominator. In this dealer staff
      // rewrite most sends, so skipping these instead would collapse the sample.
      const outboundWasHumanRewritten = isHumanRewrittenOutbound(matchedOut);
      const gradedBody = outboundWasHumanRewritten ? matchedOut?.originalDraftBody : matchedOut?.body;
      const outboundText = normalizeText(gradedBody);
      const tone = evaluateTurnToneQuality({ inboundText, outboundText });
      const outAtIso = String(matchedOut?.at ?? "");

      rows.push({
        convId,
        leadRef,
        leadName,
        leadPhone,
        inboundAt: inboundAtIso,
        inboundProvider: String(inbound?.provider ?? ""),
        inboundText,
        outboundAt: outAtIso,
        outboundProvider: String(matchedOut?.provider ?? ""),
        outboundText,
        responseLatencySec: match.latencySec,
        score: tone.score,
        pass: tone.pass,
        band: tone.band,
        intent: tone.intent,
        issueCodes: tone.issues.map(x => x.code),
        issueDetails: tone.issues.map(x => ({ code: x.code, detail: x.detail })),
        status: match.withinWindow ? "responded" : "responded_late",
        gradedAgentDraft: outboundWasHumanRewritten || undefined,
        respondedLate: match.withinWindow ? undefined : true
      });
    }
  }

  // Late replies are real, graded replies — pooled with prompt replies for
  // pass-rate math. Only a genuinely dropped turn (no reply before the customer's
  // next message) counts as missing (Joe ruling 2026-07-13).
  const responded = rows.filter(r => r.status === "responded" || r.status === "responded_late");
  const respondedWithinWindow = rows.filter(r => r.status === "responded");
  const respondedLate = rows.filter(r => r.status === "responded_late");
  const missing = rows.filter(r => r.status === "missing_response");
  const passCountResponded = responded.filter(r => r.pass).length;
  const failCountResponded = responded.length - passCountResponded;
  const passCountAll = rows.filter(r => r.pass).length;
  const failCountAll = rows.length - passCountAll;
  const scores = responded.map(r => r.score);
  const avgScore = scores.length ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)) : 0;
  const medianScore = Number(computeMedian(scores).toFixed(2));

  const issueMap = new Map<string, number>();
  for (const r of rows) {
    for (const code of r.issueCodes) issueMap.set(code, (issueMap.get(code) ?? 0) + 1);
  }
  const issueCounts = [...issueMap.entries()]
    .map(([issue, count]) => ({ issue, count }))
    .sort((a, b) => b.count - a.count);

  const intentMap = new Map<
    string,
    { count: number; pass: number; totalScore: number; missing: number }
  >();
  for (const r of rows) {
    const cur = intentMap.get(r.intent) ?? { count: 0, pass: 0, totalScore: 0, missing: 0 };
    cur.count += 1;
    cur.totalScore += r.score;
    if (r.status === "missing_response") cur.missing += 1;
    if (r.pass) cur.pass += 1;
    intentMap.set(r.intent, cur);
  }
  const intentStats = [...intentMap.entries()]
    .map(([intent, v]) => ({
      intent,
      count: v.count,
      pass: v.pass,
      missing: v.missing,
      avgScore: Number((v.totalScore / Math.max(1, v.count)).toFixed(2))
    }))
    .sort((a, b) => b.count - a.count);

  const providerMap = new Map<string, number>();
  for (const r of responded) {
    const key = r.outboundProvider || "unknown";
    providerMap.set(key, (providerMap.get(key) ?? 0) + 1);
  }
  const providerStats = [...providerMap.entries()]
    .map(([provider, count]) => ({ provider, count }))
    .sort((a, b) => b.count - a.count);

  const bandMap = new Map<string, number>();
  for (const r of responded) bandMap.set(r.band, (bandMap.get(r.band) ?? 0) + 1);
  const bandCounts = [...bandMap.entries()]
    .map(([band, count]) => ({ band, count }))
    .sort((a, b) => b.count - a.count);

  const failures = rows
    .filter(r => !r.pass)
    .sort((a, b) => a.score - b.score || String(a.inboundAt).localeCompare(String(b.inboundAt)));

  fs.mkdirSync(parsed.outDir, { recursive: true });
  const rowsPath = path.join(parsed.outDir, "tone_quality_rows.json");
  const failuresPath = path.join(parsed.outDir, "tone_quality_failures.json");
  const summaryPath = path.join(parsed.outDir, "tone_quality_summary.json");

  fs.writeFileSync(rowsPath, JSON.stringify({ count: rows.length, rows }, null, 2));
  fs.writeFileSync(failuresPath, JSON.stringify({ count: failures.length, rows: failures }, null, 2));

  const summary = {
    generatedAt: new Date().toISOString(),
    source: parsed.conversationsPath,
    sinceHours: parsed.sinceHours,
    windowStart: Number.isFinite(windowStartMs) ? new Date(windowStartMs).toISOString() : null,
    responseWindowMin: parsed.responseWindowMin,
    skippedTurnCount: skippedTurns,
    skippedReasonCounts: [...skippedReasonMap.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    totalInboundTurns: rows.length,
    respondedTurns: responded.length,
    respondedWithinWindowCount: respondedWithinWindow.length,
    respondedLateCount: respondedLate.length,
    missingResponseCount: missing.length,
    passCount: passCountAll,
    failCount: failCountAll,
    passRate: rows.length ? Number(((passCountAll / rows.length) * 100).toFixed(2)) : 0,
    respondedPassCount: passCountResponded,
    respondedFailCount: failCountResponded,
    respondedPassRate: responded.length ? Number(((passCountResponded / responded.length) * 100).toFixed(2)) : 0,
    avgScore,
    medianScore,
    issueCounts,
    bandCounts,
    intentStats,
    providerStats,
    outputs: {
      rowsPath,
      failuresPath,
      summaryPath
    }
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main();
