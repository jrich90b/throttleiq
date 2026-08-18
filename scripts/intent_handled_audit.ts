/**
 * Intent-handled audit (2026-06-15) — the semantic safety net the keyword
 * scorers can't be.
 *
 * Origin: Nicholas Braun +17166286477 asked "What do I have to do to reserve
 * one" and got a fluent, charter-clean, grammatical draft that answered the
 * WRONG thing ("I'll keep this tied to the 2026 Other trade and let you know
 * when it's here"). Every nightly scorer is keyword/taxonomy-based, so a polite
 * non-answer on a novel intent slips through. This audit runs an LLM JUDGE over
 * each answered customer turn and asks one question: did the reply actually
 * address what the customer asked? It catches fluent-but-wrong-intent across ALL
 * intents, not a fixed list.
 *
 * Determinism: the judge is an LLM, so the gate (`intent_handled:eval`) runs
 * `--self-test`, which exercises the PURE scaffolding (candidate selection,
 * exclusions, prompt shape, summary) with a stub judge and never touches the
 * network. The real run (`intent_handled:audit`, nightly) calls the model.
 *
 * Usage:
 *   npx tsx scripts/intent_handled_audit.ts [--since-hours N] [--out-dir DIR] [--max N]
 *   npx tsx scripts/intent_handled_audit.ts --self-test
 *
 * OUTPUT PATH — it honours REPORT_ROOT like every sibling sweep (fixed 2026-08-18). It did not,
 * and that made this net DARK for five days without anyone noticing: the box cron and the loop's
 * daily block both run `REPORT_ROOT=<runtime>/reports npm run intent_handled:audit`, but the only
 * env var read here was INTENT_HANDLED_OUT_DIR, so the run fell through to `cwd/reports/...` — i.e.
 * INSIDE the repo checkout — while `anomaly_loop_detect` reads `$REPORT_ROOT/intent_handled/
 * anomalies.json`. Every run "succeeded" and wrote where nothing looks. Measured on the box
 * 2026-08-18: the loop's copy was frozen at 8/13 12:35 (121h) while a fresh run that same minute
 * landed in `/home/ubuntu/leadrider-api/americanharley/reports/intent_handled/`.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Where this audit writes. Precedence, most explicit first:
 *   1. `--out-dir` — an operator naming the exact directory always wins.
 *   2. `INTENT_HANDLED_OUT_DIR` — the pre-existing per-script override, unchanged.
 *   3. `REPORT_ROOT`/intent_handled — the shared report root every sibling sweep already uses, and
 *      the one `anomaly_loop_detect` reads its feed from. THIS is the rung that was missing.
 *   4. `cwd`/reports/intent_handled — the original local-dev default, unchanged.
 * Pure: takes its env, resolves no I/O, so the eval can execute it directly.
 */
export function resolveIntentHandledOutDir(input?: {
  outDirArg?: string | null;
  env?: Record<string, string | undefined>;
  cwd?: string;
}): string {
  const env = input?.env ?? process.env;
  const cwd = input?.cwd ?? process.cwd();
  const explicit = String(input?.outDirArg ?? "").trim();
  if (explicit) return explicit;
  const perScript = String(env.INTENT_HANDLED_OUT_DIR ?? "").trim();
  if (perScript) return perScript;
  const reportRoot = String(env.REPORT_ROOT ?? "").trim();
  if (reportRoot) return path.join(reportRoot, "intent_handled");
  return path.resolve(cwd, "reports", "intent_handled");
}

import {
  isHumanModeStaffReply,
  isLeadIntakeFormInbound,
  isNonSalesConversation,
  isShadowReplayMessage
} from "../services/api/src/domain/scoringExclusions.ts";
import { decideIntentHandledAnomaly } from "../services/api/src/domain/conversationOutcomeAudit.ts";
import { describeWalkInNoteProvenance } from "../services/api/src/domain/walkInFollowUpTopic.ts";

/**
 * Inbound providers this judge grades.
 *
 * `sendgrid_adf` was ABSENT until 2026-08-14, and that absence was the blind spot: web-lead forms
 * are 15% of customer turns but 33% of the wrong-intent corrections staff had to make by hand
 * (measured over 30 days on the live store). They were excluded for a good reason — a form is not
 * the customer speaking, so "did the reply answer their question?" grades nothing on them — and the
 * fix is not to ask that question anyway. Form turns carry a LEAD RECORD and are judged on FIT
 * instead (see buildIntentJudgePrompt). Same reframing as the pre-send judge's LEAD RECORD block.
 */
const CUSTOMER_IN = new Set(["twilio", "web_widget", "sendgrid", "sendgrid_adf"]);
const SENT_OUT = new Set(["twilio", "sendgrid", "human"]);

/**
 * What the net actually looked at, and what it dropped. Reported so the denominator is visible:
 * "0 misses found" means nothing without it.
 */
export type IntentCoverage = {
  customerTurnsSeen: number;
  judged: number;
  skippedNonSalesConversation: number;
  skippedShadowReplay: number;
  skippedNonActionable: number;
  skippedOutsideWindow: number;
  skippedNoReply: number;
  skippedStaffOwned: number;
  /** An inbound provider this audit does not grade — the shape that hid web-lead forms for months. */
  skippedProviderNotGraded: number;
  /** Judged turns whose "customer message" is a lead-intake form (graded on record FIT). */
  leadIntakeFormTurns: number;
};

export type IntentJudgeCandidate = {
  convId: string;
  at: string;
  inboundText: string;
  replyText: string;
  replyKind: "sent" | "draft";
  context: string[]; // up to a few prior messages, oldest->newest "in/out: body"
  /**
   * Who actually wrote `inboundText`, when it is NOT the customer's own words (a Traffic Log Pro
   * walk-in lead record carrying a salesperson's note). Absent on a real customer message, which
   * leaves the prompt byte-identical. See describeWalkInNoteProvenance.
   */
  inboundProvenance?: string | null;
  /**
   * Present ONLY when `inboundText` is a structured lead-intake form. Its presence is what swaps
   * the judge's question from "did it answer the ask?" (there is none) to "does it fit the record?".
   */
  leadRecord?: {
    source: string | null;
    vehicle: string | null;
    inquiry: string | null;
    priorReplyCount: number;
    threadStage: string | null;
  } | null;
};

export type IntentVerdict = {
  addressed: boolean;
  customerAsk: string;
  why: string;
  severity: "none" | "minor" | "major";
};

export type IntentFinding = IntentJudgeCandidate & { verdict: IntentVerdict };

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

// Non-actionable inbound classes (mirror of tone_quality skip philosophy): pure
// reactions/emoji, bare acks, and clear closeouts with no ask. These never need
// a substantive reply, so a short ack to them is not a miss.
const EMOJI_ONLY_RE = /^[\p{Emoji}\p{Extended_Pictographic}\s❤️👍👎]+$/u;
const BARE_ACK_RE =
  /^(?:ok|okay|k|kk|yes|yep|yeah|no|nope|thanks|thank you|ty|thx|sounds good|got it|great|perfect|cool|will do|👍|👌)[.!]?$/i;
const CLOSEOUT_RE = /\b(no need|already (?:called|bought|handled|taken care)|all set|nevermind|never mind)\b/i;
// Short gratitude/closeout ("thank you bro", "thanks man", "appreciate it") is a
// courtesy, not a new ask — a polite reply to it is correct. Judging it as a turn
// made the judge reach back to OLDER requests and cry wolf (false major:
// "Thank you bro" -> "You're welcome!"). Bounded to short, question-free gratitude
// so a real ask riding on a thanks ("thanks, can you send more pics?") still counts.
const GRATITUDE_RE =
  /^(?:thanks?|thank you|thank u|ty|thx|tysm|appreciate (?:it|that|you|ya)|preciate it|much appreciated)\b/i;

export function isNonActionableInbound(text: string): boolean {
  const raw = String(text ?? "").trim();
  if (!raw) return true;
  if (EMOJI_ONLY_RE.test(raw)) return true;
  if (BARE_ACK_RE.test(raw)) return true;
  if (raw.split(/\s+/).length <= 2 && !raw.includes("?")) return true;
  if (GRATITUDE_RE.test(raw) && !raw.includes("?") && raw.split(/\s+/).length <= 4) return true;
  if (CLOSEOUT_RE.test(norm(raw))) return true;
  return false;
}

function msgTime(m: any): number {
  return Date.parse(String(m?.at ?? ""));
}

// PURE: pick answered customer turns worth judging. A candidate is a substantive
// customer inbound followed (before the next customer inbound, within 7d) by a
// reply — a SENT outbound, or a pending draft_ai (the Nicholas case was a draft).
export function selectIntentJudgeCandidates(
  convs: any[],
  opts: { windowStartMs: number; maxCandidates?: number }
): {
  candidates: IntentJudgeCandidate[];
  eligibleTotal: number;
  staffOwnedSkipped: number;
  coverage: IntentCoverage;
} {
  const out: IntentJudgeCandidate[] = [];
  let eligibleTotal = 0;
  let staffOwnedSkipped = 0;
  // COVERAGE. This audit is the semantic net for wrong intent, and for months it graded ~1 turn a
  // night while nobody could see what it had dropped or why (2026-08-13 run: eligibleTotal 1). A
  // net whose denominator is invisible cannot be trusted, and a future provider added upstream
  // would silently fall out of it exactly the way `sendgrid_adf` did. Count every turn we see and
  // every reason we drop one.
  const coverage: IntentCoverage = {
    customerTurnsSeen: 0,
    judged: 0,
    skippedNonSalesConversation: 0,
    skippedShadowReplay: 0,
    skippedNonActionable: 0,
    skippedOutsideWindow: 0,
    skippedNoReply: 0,
    skippedStaffOwned: 0,
    skippedProviderNotGraded: 0,
    leadIntakeFormTurns: 0
  };
  const REPLY_WINDOW = 7 * 24 * 60 * 60 * 1000;

  for (const conv of convs ?? []) {
    if (isNonSalesConversation(conv ?? {})) continue;
    const msgs = (conv?.messages ?? [])
      .map((m: any) => ({ ...m, t: msgTime(m) }))
      .filter((m: any) => Number.isFinite(m.t))
      .sort((a: any, b: any) => a.t - b.t);

    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.direction !== "in") continue;
      coverage.customerTurnsSeen++;
      if (!CUSTOMER_IN.has(m.provider)) {
        coverage.skippedProviderNotGraded++;
        continue;
      }
      if (isShadowReplayMessage(m)) {
        coverage.skippedShadowReplay++;
        continue;
      }
      const inboundText = String(m.body ?? "").trim();
      if (!inboundText || isNonActionableInbound(inboundText)) {
        coverage.skippedNonActionable++;
        continue;
      }
      if (m.t < opts.windowStartMs) {
        coverage.skippedOutsideWindow++;
        continue;
      }

      // Find the reply: first SENT outbound or LIVE pending draft before the next
      // customer inbound, within the window. A draftStatus "stale" draft was
      // dismissed/superseded — the console hides it (getLatestPendingDraft), so
      // it is not "the reply"; counting it would judge a phantom the customer
      // never got and mask a real no-response (Zachary Bushey class, 2026-07-05).
      // Silence (no reply) is the route watchdog's job, not this judge's.
      let reply: any = null;
      for (let j = i + 1; j < msgs.length; j++) {
        const n = msgs[j];
        if (n.t - m.t > REPLY_WINDOW) break;
        if (n.direction === "in" && CUSTOMER_IN.has(n.provider) && String(n.body ?? "").trim()) break;
        if (isShadowReplayMessage(n)) continue;
        if (n.direction === "out" && (SENT_OUT.has(n.provider) || (n.provider === "draft_ai" && n.draftStatus !== "stale"))) {
          if (String(n.body ?? "").trim()) {
            reply = n;
            break;
          }
        }
      }
      if (!reply) {
        coverage.skippedNoReply++;
        continue;
      }

      // The reply is a person's own words on a thread a person owns — the agent is code-gated
      // out of answering in human mode, so this can never be an agent comprehension miss.
      // Counted, not silently dropped, so the report says how much of the window it removed.
      if (isHumanModeStaffReply({ conversationMode: conv?.mode, reply })) {
        staffOwnedSkipped++;
        coverage.skippedStaffOwned++;
        continue;
      }

      eligibleTotal++;
      coverage.judged++;
      const context = msgs
        .slice(Math.max(0, i - 6), i)
        .filter((c: any) => String(c.body ?? "").trim())
        .map((c: any) => `${c.direction === "in" ? "customer" : "agent"}: ${String(c.body).replace(/\s+/g, " ").trim()}`);
      out.push({
        convId: String(conv?.id ?? ""),
        at: String(m.at ?? ""),
        inboundText,
        replyText: String(reply.body ?? "").trim(),
        replyKind: SENT_OUT.has(reply.provider) ? "sent" : "draft",
        context,
        inboundProvenance: describeWalkInNoteProvenance({
          body: inboundText,
          walkIn: conv?.lead?.walkIn,
          walkInComment: conv?.lead?.walkInComment
        }),
        leadRecord: buildLeadRecordForTurn(conv, inboundText, msgs.slice(0, i))
      });
      if (out[out.length - 1]?.leadRecord) coverage.leadIntakeFormTurns++;
    }
  }

  const max = opts.maxCandidates ?? Infinity;
  return { candidates: out.slice(0, max), eligibleTotal, staffOwnedSkipped, coverage };
}

/**
 * The LEAD RECORD for a form turn — `null` on every ordinary typed message, which keeps those
 * prompts byte-identical. Mirrors buildDraftJudgeLeadIntake (index.ts) so the nightly net and the
 * pre-send gate ask the same question of the same turn.
 */
export function buildLeadRecordForTurn(
  conv: any,
  inboundText: string,
  priorMsgs: any[]
): IntentJudgeCandidate["leadRecord"] {
  if (!isLeadIntakeFormInbound(inboundText)) return null;
  const lead = conv?.lead ?? {};
  const vehicle = lead?.vehicle ?? {};
  const year = String(vehicle?.year ?? "").trim();
  const model = String(vehicle?.model ?? vehicle?.description ?? "").trim();
  // Only what the customer RECEIVED counts as a prior reply — an unsent draft is not one.
  const priorReplyCount = (priorMsgs ?? []).filter(
    (x: any) => x?.direction === "out" && SENT_OUT.has(String(x?.provider ?? "")) && String(x?.body ?? "").trim()
  ).length;
  return {
    source: String(lead?.source ?? "").trim() || null,
    vehicle: [year, model].filter(Boolean).join(" ") || null,
    inquiry: String(lead?.inquiry ?? lead?.comment ?? "").trim().slice(0, 400) || null,
    priorReplyCount,
    threadStage: String(conv?.followUp?.reason ?? conv?.dialogState?.name ?? "").trim() || null
  };
}

export function buildIntentJudgePrompt(c: IntentJudgeCandidate): string {
  // FORM TURNS ask a different question. A web-lead form is not the customer speaking, so "did the
  // reply answer their ask?" grades nothing — which is exactly why these turns were excluded from
  // this audit entirely until 2026-08-14, and why the pre-send judge passed them by construction.
  // Judge FIT against the record and the thread instead. See David Ventry +17164233848: an HDFS COA
  // form on a mid-deal thread, answered as a brand-new inquiry, caught only when Scott retyped it.
  if (c.leadRecord) {
    const engaged = c.leadRecord.priorReplyCount > 0;
    return [
      "You are a sales-ops QA reviewer for a Harley-Davidson dealership's text agent.",
      "This turn's \"customer message\" is a WEB-LEAD FORM the dealership received, NOT this person",
      "typing. There is no question to answer, so do not look for one, and do not invent one out of a",
      "form field (a form saying `Payment Status: Failed` is not someone asking about pricing).",
      "",
      "Decide ONE thing: does the agent's reply FIT what the LEAD RECORD and the thread say this",
      "person needs? `addressed` = true when it fits, false when it does not.",
      "",
      `LEAD RECORD: ${JSON.stringify(c.leadRecord)}`,
      "",
      ...(engaged
        ? [
            "This thread is ALREADY ENGAGED — we have replied before. Mark addressed=false when the reply:",
            "  (a) asks for something the record already answers — above all, asking which bike they want,",
            "      or offering to send options, when `vehicle` names the unit; or",
            "  (b) ignores `threadStage`, replying to a live credit application, in-process deal or booked",
            "      appointment as though it were a brand-new inquiry.",
            "A form arriving mid-deal is an UPDATE to a live conversation, not a fresh lead.",
            "NOT failures: naming a fact you cannot verify from this thread (reps know things the thread",
            "never recorded — fail only if it CONTRADICTS the record), or saying who you are."
          ]
        : [
            "This is a genuine FIRST TOUCH — no reply has been sent. An introduction is correct here.",
            "Mark addressed=false only when the reply ignores what the record gives (its source and",
            "vehicle) or asks for something the form already told us."
          ]),
      "",
      c.context.length ? `Conversation so far:\n${c.context.join("\n")}` : "Conversation so far: (none)",
      "",
      `Lead form received: ${c.inboundText}`,
      `Agent's reply${c.replyKind === "draft" ? " (drafted, not yet sent)" : ""}: ${c.replyText}`,
      "",
      "Return JSON: addressed (bool), customer_ask (short paraphrase of what this lead needs),",
      "why (one sentence), severity (none if addressed; major when a live deal or a named unit was",
      "ignored; minor otherwise)."
    ].join("\n");
  }
  return [
    "You are a sales-ops QA reviewer for a Harley-Davidson dealership's text agent.",
    "Decide ONE thing: did the agent's reply ADDRESS what the customer asked or clearly",
    "wanted ON THEIR LATEST MESSAGE? Answering their question, or taking the obviously",
    "intended next step (including an honest 'a teammate will get you X' handoff), counts as",
    "addressed. A fluent but off-topic reply, a reply that answers a DIFFERENT question, or a",
    "generic non-answer is NOT addressed. Judge substance, not tone or grammar.",
    "Judge ONLY the latest customer message. If it is a thank-you, acknowledgement, or",
    "closeout with no new ask, a courteous reply counts as addressed — do NOT penalize for",
    "older requests earlier in the thread (those are tracked elsewhere).",
    "",
    c.context.length ? `Conversation so far:\n${c.context.join("\n")}` : "Conversation so far: (none)",
    "",
    ...(c.inboundProvenance ? [c.inboundProvenance, ""] : []),
    `${c.inboundProvenance ? "Latest inbound record" : "Customer's latest message"}: ${c.inboundText}`,
    `Agent's reply${c.replyKind === "draft" ? " (drafted, not yet sent)" : ""}: ${c.replyText}`,
    "",
    "Return JSON: addressed (bool), customer_ask (short paraphrase of what they wanted),",
    "why (one sentence), severity (none if addressed; major if a clear question/high-intent",
    "ask got a non-answer; minor otherwise)."
  ].join("\n");
}

const JUDGE_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["addressed", "customer_ask", "why", "severity"],
  properties: {
    addressed: { type: "boolean" },
    customer_ask: { type: "string" },
    why: { type: "string" },
    severity: { type: "string", enum: ["none", "minor", "major"] }
  }
};

export type JudgeFn = (c: IntentJudgeCandidate) => Promise<IntentVerdict | null>;

export function summarizeFindings(findings: IntentFinding[]) {
  const unaddressed = findings.filter(f => !f.verdict.addressed);
  const bySeverity: Record<string, number> = { none: 0, minor: 0, major: 0 };
  let draftMisses = 0;
  let sentMisses = 0;
  for (const f of findings) {
    bySeverity[f.verdict.severity] = (bySeverity[f.verdict.severity] ?? 0) + 1;
    if (!f.verdict.addressed) (f.replyKind === "draft" ? draftMisses++ : sentMisses++);
  }
  return {
    judged: findings.length,
    unaddressed: unaddressed.length,
    unaddressedRatePct: findings.length ? Math.round((unaddressed.length / findings.length) * 1000) / 10 : 0,
    major: bySeverity.major,
    draftMisses,
    sentMisses
  };
}

export async function realJudge(c: IntentJudgeCandidate): Promise<IntentVerdict | null> {
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  // gpt-5 models spend output budget on reasoning tokens; minimal effort + a
  // larger ceiling keeps the strict-JSON output from truncating mid-string.
  const reasoning = /^gpt-5/i.test(model) ? ({ reasoning: { effort: "minimal" as const } }) : {};
  try {
    const resp: any = await client.responses.parse({
      model,
      input: buildIntentJudgePrompt(c),
      ...reasoning,
      max_output_tokens: 800,
      text: { format: { type: "json_schema", name: "intent_handled_judge", schema: JUDGE_SCHEMA, strict: true } }
    });
    const p = resp?.output_parsed;
    if (!p || typeof p !== "object") return null;
    return {
      addressed: !!p.addressed,
      customerAsk: String(p.customer_ask ?? ""),
      why: String(p.why ?? ""),
      severity: ["none", "minor", "major"].includes(p.severity) ? p.severity : "minor"
    };
  } catch (err: any) {
    console.warn("[intent-handled] judge failed:", err?.message ?? err);
    return null;
  }
}

export async function runIntentAudit(
  convs: any[],
  opts: { windowStartMs: number; maxCandidates: number; judge: JudgeFn }
): Promise<{ findings: IntentFinding[]; eligibleTotal: number; capped: boolean; staffOwnedSkipped: number }> {
  const { candidates, eligibleTotal, staffOwnedSkipped, coverage } = selectIntentJudgeCandidates(convs, {
    windowStartMs: opts.windowStartMs,
    maxCandidates: opts.maxCandidates
  });
  const findings: IntentFinding[] = [];
  for (const c of candidates) {
    const verdict = await opts.judge(c);
    if (verdict) findings.push({ ...c, verdict });
  }
  return { findings, eligibleTotal, capped: eligibleTotal > candidates.length, staffOwnedSkipped, coverage };
}

function selfTest() {
  const assert = (cond: boolean, label: string) => {
    if (!cond) {
      console.error(`SELF-TEST FAIL: ${label}`);
      process.exit(1);
    }
  };

  // isNonActionableInbound
  for (const skip of [
    "👍",
    "ok",
    "thanks!",
    "yes",
    "No need, I already called",
    "Thank you bro", // short gratitude — was a false major ("You're welcome!")
    "thanks man appreciate it",
    "Appreciate it!"
  ]) {
    assert(isNonActionableInbound(skip), `non-actionable: "${skip}"`);
  }
  for (const keep of [
    "What do I have to do to reserve one",
    "Is the bike in store?",
    "the new 2026 superglide please",
    "thanks, can you send more pics?", // gratitude + a real ask -> still actionable
    "thanks for the info and any appointments later this month same time"
  ]) {
    assert(!isNonActionableInbound(keep), `actionable: "${keep}"`);
  }

  const base = "2026-06-15T12:00:00.000Z";
  const t = (mins: number) => new Date(Date.parse(base) + mins * 60000).toISOString();
  const convs = [
    {
      id: "nicholas",
      messages: [
        { direction: "out", provider: "twilio", at: t(0), body: "We don't have the 2026 Super Glide in stock right now." },
        { direction: "in", provider: "twilio", at: t(1), body: "What do I have to do to reserve one" },
        // fluent but wrong-intent DRAFT (the production miss)
        { direction: "out", provider: "draft_ai", at: t(2), body: "Ok, will do. I'll keep this tied to the 2026 Other trade and let you know when it's ready to look at." }
      ]
    },
    {
      id: "good",
      messages: [
        { direction: "in", provider: "twilio", at: t(0), body: "Is the bike in store?" },
        { direction: "out", provider: "twilio", at: t(1), body: "Yes, the Street Glide is on the floor right now. Want to swing by today?" }
      ]
    },
    {
      id: "silence", // inbound with no reply -> watchdog's job, not judged here
      messages: [{ direction: "in", provider: "twilio", at: t(0), body: "What's the price on the Road Glide?" }]
    },
    {
      id: "shadow", // shadow replay excluded
      messages: [
        { direction: "in", provider: "twilio", at: t(0), body: "Can I reserve one?", providerMessageId: "SMshadow_1" },
        { direction: "out", provider: "draft_ai", at: t(1), body: "shadow", providerMessageId: "SMshadow_2" }
      ]
    },
    {
      // Dismissed (stale) draft with nothing sent after -> the console hides it,
      // so this is a NO-reply turn (route watchdog's job), NOT a judged reply
      // (Zachary Bushey class, 2026-07-05).
      id: "dismissed",
      messages: [
        { direction: "in", provider: "twilio", at: t(0), body: "What do I have to do to reserve one" },
        { direction: "out", provider: "draft_ai", at: t(1), body: "Ok, will do.", draftStatus: "stale" }
      ]
    },
    {
      // Staff takeover: the AI draft was dismissed (stale) and staff sent their
      // own reply. Judge the SENT reply the customer got, not the phantom draft.
      id: "takeover",
      messages: [
        { direction: "in", provider: "twilio", at: t(0), body: "Is the bike in store?" },
        { direction: "out", provider: "draft_ai", at: t(1), body: "phantom dismissed draft", draftStatus: "stale" },
        { direction: "out", provider: "twilio", at: t(2), body: "Yes, it's on the floor right now — want to swing by today?" }
      ]
    },
    {
      // Human takeover (mode: "human"): the agent is code-gated out of replying, so this send is
      // a person's own words. Rich Retzlaff +17168640008, 2026-08-12 — Joe dictated the sentence,
      // a rep typed it 42s later, and the judge filed a Tier-1 miss against it.
      id: "human_mode",
      mode: "human",
      messages: [
        { direction: "in", provider: "twilio", at: t(0), body: "I listed it for $12000 and dropped it to $10800 and have a few reach out now" },
        { direction: "out", provider: "twilio", at: t(1), body: "Ok, Let me know how you make out! Scott will be in tomorrow if you want to touch base with him." }
      ]
    },
    {
      // ...but the AGENT'S OWN WORDS stay graded even on a human-owned thread: a live draft is
      // agent output whoever owns the thread. Keyed on the reply, never on the conversation.
      id: "human_mode_agent_draft",
      mode: "human",
      messages: [
        { direction: "in", provider: "twilio", at: t(0), body: "What do I have to do to reserve one" },
        { direction: "out", provider: "draft_ai", at: t(1), body: "Ok, will do. I'll keep this tied to the 2026 Other trade and let you know when it's ready to look at." }
      ]
    },
    {
      // Same, for an APPROVED draft: `finalizeDraftAsSent` stamps authoredBy "agent" (2026-08-13),
      // so a sent message the agent wrote is still judged on a human-owned thread.
      id: "human_mode_approved_draft",
      mode: "human",
      messages: [
        { direction: "in", provider: "twilio", at: t(0), body: "Is the bike in store?" },
        { direction: "out", provider: "twilio", authoredBy: "agent", at: t(1), body: "Yes, the Street Glide is on the floor right now. Want to swing by today?" }
      ]
    }
  ];

  // WEB-LEAD FORM turns (2026-08-14). Two arms, opposite fail directions: a form landing mid-deal
  // must be judged on record FIT, and a first-touch form must still be allowed its introduction.
  convs.push({
    id: "ventry_engaged",
    mode: "suggest",
    followUp: { reason: "credit_app" },
    lead: { source: "HDFS COA Online", vehicle: { year: "2005", model: "Fat Boy" }, inquiry: "App ID: 1014107855" },
    messages: [
      { direction: "out", provider: "twilio", at: t(-2), body: "https://creditapplication.harley-davidson.com/us/en/?dealerid=3436" },
      { direction: "in", provider: "sendgrid_adf", at: t(0), body: "WEB LEAD (ADF)\nSource: HDFS COA Online\nRef: 11785\nName: David Ventry\nYear: 2005\nVehicle: Harley-Davidson Fat Boy\n\nInquiry:\nApp ID: 1014107855, Model Year: 2005, Model: Fat Boy" },
      { direction: "out", provider: "draft_ai", at: t(1), body: "Thanks for getting your credit application in! Are you looking at a specific bike?" }
    ]
  });
  convs.push({
    id: "ventry_first_touch",
    mode: "suggest",
    lead: { source: "HDFS COA Online", vehicle: { year: "2005", model: "Fat Boy" } },
    messages: [
      { direction: "in", provider: "sendgrid_adf", at: t(0), body: "WEB LEAD (ADF)\nSource: HDFS COA Online\nRef: 11785\nName: David Ventry\nYear: 2005\nVehicle: Harley-Davidson Fat Boy\n\nInquiry:\nApp ID: 1014107855, Model Year: 2005, Model: Fat Boy" },
      { direction: "out", provider: "draft_ai", at: t(1), body: "Hi David — it's Scott at American H-D, thanks for applying on the Fat Boy." }
    ]
  });

  const { candidates, eligibleTotal, staffOwnedSkipped, coverage } = selectIntentJudgeCandidates(convs, { windowStartMs: Date.parse(base) - 1000 });
  const ids = candidates.map(c => c.convId).sort();
  const expectedIds = [
    "good",
    "human_mode_agent_draft",
    "human_mode_approved_draft",
    "nicholas",
    "takeover",
    "ventry_engaged",
    "ventry_first_touch"
  ];
  assert(JSON.stringify(ids) === JSON.stringify(expectedIds), `candidates should be ${JSON.stringify(expectedIds)}, got ${JSON.stringify(ids)}`);
  assert(eligibleTotal === 7, `eligibleTotal should be 7, got ${eligibleTotal}`);

  // A web-lead form is now GRADED, not silently dropped — the whole point of the change.
  const engagedForm = candidates.find(c => c.convId === "ventry_engaged")!;
  assert(!!engagedForm.leadRecord, "a form turn must carry a LEAD RECORD");
  assert(engagedForm.leadRecord!.vehicle === "2005 Fat Boy", `record vehicle wrong: ${engagedForm.leadRecord!.vehicle}`);
  assert(engagedForm.leadRecord!.threadStage === "credit_app", "record must carry the thread stage");
  assert(engagedForm.leadRecord!.priorReplyCount === 1, `engaged thread must count its prior SENT reply, got ${engagedForm.leadRecord!.priorReplyCount}`);
  const engagedPrompt = buildIntentJudgePrompt(engagedForm);
  assert(/ALREADY ENGAGED/.test(engagedPrompt), "engaged form turn must get the engaged arm");
  assert(/WEB-LEAD FORM/.test(engagedPrompt), "the form framing must replace the ask framing");
  assert(!/did the agent's reply ADDRESS what the customer asked/i.test(engagedPrompt), "a form turn must NOT be asked the ask-question");
  assert(/Payment Status: Failed/.test(engagedPrompt), "the anti-phantom instruction must ride along");

  // FAIL DIRECTION: a first touch has no prior reply and must keep its introduction.
  const firstForm = candidates.find(c => c.convId === "ventry_first_touch")!;
  assert(firstForm.leadRecord!.priorReplyCount === 0, "a first touch has no prior reply");
  const firstPrompt = buildIntentJudgePrompt(firstForm);
  assert(/FIRST TOUCH/.test(firstPrompt) && /introduction is correct/.test(firstPrompt), "a first touch must be allowed its intro");
  assert(!/ALREADY ENGAGED/.test(firstPrompt), "the engaged arm must not fire on a first touch");

  // A TYPED message must be untouched by any of this.
  const nickCandidate = candidates.find(c => c.convId === "nicholas")!;
  assert(!nickCandidate.leadRecord, "a typed customer message must carry no lead record");
  assert(/did the agent's reply ADDRESS/i.test(buildIntentJudgePrompt(nickCandidate)), "typed turns keep the original question");

  // COVERAGE: the denominator must be reported, and it must add up.
  assert(coverage.judged === 7, `coverage.judged should be 7, got ${coverage.judged}`);
  assert(coverage.leadIntakeFormTurns === 2, `coverage.leadIntakeFormTurns should be 2, got ${coverage.leadIntakeFormTurns}`);
  assert(coverage.skippedStaffOwned === 1, `coverage.skippedStaffOwned should be 1, got ${coverage.skippedStaffOwned}`);
  const accounted =
    coverage.judged +
    coverage.skippedProviderNotGraded +
    coverage.skippedShadowReplay +
    coverage.skippedNonActionable +
    coverage.skippedOutsideWindow +
    coverage.skippedNoReply +
    coverage.skippedStaffOwned;
  assert(
    accounted === coverage.customerTurnsSeen,
    `every customer turn seen must be judged or accounted for by a named reason: ${accounted} != ${coverage.customerTurnsSeen}`
  );
  assert(!candidates.some(c => c.convId === "human_mode"), "a person's reply on a human-mode thread is not an agent comprehension miss");
  assert(staffOwnedSkipped === 1, `staffOwnedSkipped should be 1, got ${staffOwnedSkipped}`);
  assert(!candidates.some(c => c.convId === "dismissed"), "a dismissed (stale) draft with no send is not a judged reply");
  const take = candidates.find(c => c.convId === "takeover")!;
  assert(take.replyKind === "sent" && /on the floor/.test(take.replyText), "takeover judges the SENT reply, not the dismissed draft");
  const nick = candidates.find(c => c.convId === "nicholas")!;
  assert(nick.replyKind === "draft", "nicholas reply is a draft");
  assert(buildIntentJudgePrompt(nick).includes("reserve one") && buildIntentJudgePrompt(nick).includes("2026 Other trade"), "prompt carries inbound + reply");

  // Stub judge: flags the watch-collapse non-answer, passes the in-stock answer, and — on a FORM
  // turn — flags a reply that asks which bike when the record already names one. The form arm is
  // stubbed here (not just candidate-selected) so a finding is proven to travel the whole way:
  // selection -> record -> prompt -> verdict -> summary.
  const stubJudge: JudgeFn = async c => {
    const ignoresRecord =
      !!c.leadRecord &&
      !!c.leadRecord.vehicle &&
      /specific bike|send over some options|which bike/i.test(c.replyText);
    const addressed = !ignoresRecord && !/keep this tied to|let you know when/i.test(c.replyText);
    return {
      addressed,
      customerAsk: c.leadRecord ? "a lead record we already hold" : c.inboundText,
      why: addressed
        ? "reply fit the turn"
        : ignoresRecord
          ? "asked which bike when the record names it"
          : "reply ignored the reservation ask",
      severity: addressed ? "none" : "major"
    };
  };
  return { candidates, stubJudge };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    const { candidates, stubJudge } = selfTest();
    const findings: IntentFinding[] = [];
    for (const c of candidates) {
      const v = await stubJudge(c);
      if (v) findings.push({ ...c, verdict: v });
    }
    const summary = summarizeFindings(findings);
    // 7 judged (good, nicholas, takeover, the two human-mode threads whose reply the AGENT wrote,
    // and the two WEB-LEAD FORM turns added 2026-08-14). Unaddressed: nicholas and
    // human_mode_agent_draft (the watch-collapse non-answer), plus ventry_engaged — a form on a
    // mid-deal thread answered by asking which bike when the record names the Fat Boy. All three
    // are drafts. ventry_first_touch is addressed: an introduction on a genuine first touch is
    // correct, and a change that started failing it would be over-firing, not fixing. The
    // takeover's SENT reply is judged (addressed); the dismissed stale draft it superseded is never
    // judged; "dismissed" yields no candidate; "human_mode" (a person's own send) is excluded.
    if (summary.judged !== 7 || summary.unaddressed !== 3 || summary.major !== 3 || summary.draftMisses !== 3) {
      console.error(`SELF-TEST FAIL: summary ${JSON.stringify(summary)}`);
      process.exit(1);
    }
    console.log("PASS intent-handled audit self-test");
    return;
  }

  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args.set(argv[i], argv[i + 1] ?? "");

  const conversationsPath =
    args.get("--conversations") ||
    process.env.CONVERSATIONS_DB_PATH ||
    (process.env.DATA_DIR
      ? path.join(process.env.DATA_DIR, "conversations.json")
      : path.resolve(process.cwd(), "services", "api", "data", "conversations.json"));
  const sinceHours = Number(args.get("--since-hours") || process.env.INTENT_HANDLED_SINCE_HOURS || "24");
  const maxCandidates = Number(args.get("--max") || process.env.INTENT_HANDLED_MAX || "150");
  const outDir = resolveIntentHandledOutDir({ outDirArg: args.get("--out-dir"), env: process.env });

  if (process.env.LLM_ENABLED !== "1" || !process.env.OPENAI_API_KEY) {
    console.error("intent-handled audit needs LLM_ENABLED=1 and OPENAI_API_KEY (skipping).");
    process.exit(1);
  }
  if (!fs.existsSync(conversationsPath)) {
    console.error(`Conversations file not found: ${conversationsPath}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(conversationsPath, "utf8"));
  const convs: any[] = Array.isArray(raw?.conversations) ? raw.conversations : [];
  const windowStartMs = Date.now() - sinceHours * 60 * 60 * 1000;

  const { findings, eligibleTotal, capped, staffOwnedSkipped, coverage } = await runIntentAudit(convs, {
    windowStartMs,
    maxCandidates,
    judge: realJudge
  });
  const summary = summarizeFindings(findings);
  if (capped) {
    console.log(`[intent-handled] capped: judged ${findings.length} of ${eligibleTotal} eligible (raise --max to cover more).`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    source: { conversationsPath, sinceHours, eligibleTotal, capped, staffOwnedSkipped },
    // The denominator. "0 misses" is not a result without it.
    coverage,
    summary,
    findings: findings
      .filter(f => !f.verdict.addressed)
      .map(f => ({
        convId: f.convId,
        at: f.at,
        replyKind: f.replyKind,
        severity: f.verdict.severity,
        customerAsk: f.verdict.customerAsk,
        why: f.verdict.why,
        inbound: f.inboundText.slice(0, 200),
        reply: f.replyText.slice(0, 200)
      }))
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "intent_handled_summary.json"), JSON.stringify({ ...report, findings: undefined }, null, 2));
  fs.writeFileSync(path.join(outDir, "intent_handled_findings.json"), JSON.stringify(report, null, 2));
  const md = [
    "# Intent-Handled Audit",
    "",
    `Generated: ${report.generatedAt}`,
    `Window: last ${sinceHours}h | judged: ${summary.judged} | unaddressed: ${summary.unaddressed} (${summary.unaddressedRatePct}%) | major: ${summary.major}`,
    capped ? `Capped at ${findings.length} of ${eligibleTotal} eligible.` : "",
    staffOwnedSkipped
      ? `Skipped ${staffOwnedSkipped} staff-owned turn(s): a person's reply on a human-mode thread is not agent output.`
      : "",
    "",
    "## Unaddressed turns",
    ...report.findings.map(
      f => `- [${f.severity}${f.replyKind === "draft" ? "/draft" : ""}] ${f.convId} ${f.at}: ask="${f.customerAsk}" — ${f.why}\n    in: "${f.inbound}"\n    reply: "${f.reply}"`
    )
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "intent_handled_report.md"), md + "\n");

  // Feed the self-healing loop: emit each MAJOR miss as an OutcomeAnomaly into a sibling file
  // (anomalies.json) that anomaly_loop_detect merges → CLASSIFY → parser-first fix PR. Mirrors
  // open_critic_sweep so the semantic net stops being a report-only digest. report.findings is
  // already the unaddressed slice; decideIntentHandledAnomaly keeps only severity=major. Kill:
  // INTENT_HANDLED_ANOMALY_FEED=0 (still writes the digest, just not the loop feed).
  if (process.env.INTENT_HANDLED_ANOMALY_FEED !== "0") {
    const anomalies = report.findings
      .map(f => decideIntentHandledAnomaly(f))
      .filter((a): a is NonNullable<typeof a> => !!a);
    fs.writeFileSync(
      path.join(outDir, "anomalies.json"),
      JSON.stringify(
        {
          generatedAt: report.generatedAt,
          source: conversationsPath,
          summary: { major: summary.major, emitted: anomalies.length },
          anomalies
        },
        null,
        2
      )
    );
    console.log(`intent-handled anomaly feed: ${anomalies.length} major miss(es) → ${path.join(outDir, "anomalies.json")}`);
  }

  console.log(
    `intent-handled audit: ${summary.unaddressed}/${summary.judged} unaddressed (${summary.major} major); report at ${outDir}`
  );
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) main();
