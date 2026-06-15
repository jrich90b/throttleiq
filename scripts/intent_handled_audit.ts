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
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isNonSalesConversation, isShadowReplayMessage } from "../services/api/src/domain/scoringExclusions.ts";

const CUSTOMER_IN = new Set(["twilio", "web_widget", "sendgrid"]);
const SENT_OUT = new Set(["twilio", "sendgrid", "human"]);

export type IntentJudgeCandidate = {
  convId: string;
  at: string;
  inboundText: string;
  replyText: string;
  replyKind: "sent" | "draft";
  context: string[]; // up to a few prior messages, oldest->newest "in/out: body"
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
): { candidates: IntentJudgeCandidate[]; eligibleTotal: number } {
  const out: IntentJudgeCandidate[] = [];
  let eligibleTotal = 0;
  const REPLY_WINDOW = 7 * 24 * 60 * 60 * 1000;

  for (const conv of convs ?? []) {
    if (isNonSalesConversation(conv ?? {})) continue;
    const msgs = (conv?.messages ?? [])
      .map((m: any) => ({ ...m, t: msgTime(m) }))
      .filter((m: any) => Number.isFinite(m.t))
      .sort((a: any, b: any) => a.t - b.t);

    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.direction !== "in" || !CUSTOMER_IN.has(m.provider)) continue;
      if (isShadowReplayMessage(m)) continue;
      const inboundText = String(m.body ?? "").trim();
      if (!inboundText || isNonActionableInbound(inboundText)) continue;
      if (m.t < opts.windowStartMs) continue;

      // Find the reply: first SENT outbound or pending draft before the next
      // customer inbound, within the window. Silence (no reply) is the route
      // watchdog's job, not this judge's.
      let reply: any = null;
      for (let j = i + 1; j < msgs.length; j++) {
        const n = msgs[j];
        if (n.t - m.t > REPLY_WINDOW) break;
        if (n.direction === "in" && CUSTOMER_IN.has(n.provider) && String(n.body ?? "").trim()) break;
        if (isShadowReplayMessage(n)) continue;
        if (n.direction === "out" && (SENT_OUT.has(n.provider) || n.provider === "draft_ai")) {
          if (String(n.body ?? "").trim()) {
            reply = n;
            break;
          }
        }
      }
      if (!reply) continue;

      eligibleTotal++;
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
        context
      });
    }
  }

  const max = opts.maxCandidates ?? Infinity;
  return { candidates: out.slice(0, max), eligibleTotal };
}

export function buildIntentJudgePrompt(c: IntentJudgeCandidate): string {
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
    `Customer's latest message: ${c.inboundText}`,
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

async function realJudge(c: IntentJudgeCandidate): Promise<IntentVerdict | null> {
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
): Promise<{ findings: IntentFinding[]; eligibleTotal: number; capped: boolean }> {
  const { candidates, eligibleTotal } = selectIntentJudgeCandidates(convs, {
    windowStartMs: opts.windowStartMs,
    maxCandidates: opts.maxCandidates
  });
  const findings: IntentFinding[] = [];
  for (const c of candidates) {
    const verdict = await opts.judge(c);
    if (verdict) findings.push({ ...c, verdict });
  }
  return { findings, eligibleTotal, capped: eligibleTotal > candidates.length };
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
    }
  ];

  const { candidates, eligibleTotal } = selectIntentJudgeCandidates(convs, { windowStartMs: Date.parse(base) - 1000 });
  const ids = candidates.map(c => c.convId).sort();
  assert(JSON.stringify(ids) === JSON.stringify(["good", "nicholas"]), `candidates should be [good, nicholas], got ${JSON.stringify(ids)}`);
  assert(eligibleTotal === 2, `eligibleTotal should be 2, got ${eligibleTotal}`);
  const nick = candidates.find(c => c.convId === "nicholas")!;
  assert(nick.replyKind === "draft", "nicholas reply is a draft");
  assert(buildIntentJudgePrompt(nick).includes("reserve one") && buildIntentJudgePrompt(nick).includes("2026 Other trade"), "prompt carries inbound + reply");

  // Stub judge: flags the watch-collapse non-answer, passes the in-stock answer.
  const stubJudge: JudgeFn = async c => {
    const addressed = !/keep this tied to|let you know when/i.test(c.replyText);
    return {
      addressed,
      customerAsk: c.inboundText,
      why: addressed ? "reply answered the ask" : "reply ignored the reservation ask",
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
    if (summary.judged !== 2 || summary.unaddressed !== 1 || summary.major !== 1 || summary.draftMisses !== 1) {
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
  const outDir =
    args.get("--out-dir") || process.env.INTENT_HANDLED_OUT_DIR || path.resolve(process.cwd(), "reports", "intent_handled");

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

  const { findings, eligibleTotal, capped } = await runIntentAudit(convs, {
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
    source: { conversationsPath, sinceHours, eligibleTotal, capped },
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
    "",
    "## Unaddressed turns",
    ...report.findings.map(
      f => `- [${f.severity}${f.replyKind === "draft" ? "/draft" : ""}] ${f.convId} ${f.at}: ask="${f.customerAsk}" — ${f.why}\n    in: "${f.inbound}"\n    reply: "${f.reply}"`
    )
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "intent_handled_report.md"), md + "\n");

  console.log(
    `intent-handled audit: ${summary.unaddressed}/${summary.judged} unaddressed (${summary.major} major); report at ${outDir}`
  );
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) main();
