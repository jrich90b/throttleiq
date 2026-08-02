/**
 * The draft-quality judge's prompt surface — schema + prompt builder, extracted from llmDraft.ts
 * (2026-08-02, the judge-backtest model comparison).
 *
 * WHY IT MOVED. The backtest (`scripts/draft_judge_backtest.ts`) needs to run the EXACT judgment
 * the production judge runs, against challenger models on a different provider. Rebuilding the
 * prompt inside the script would be a hand-copy — and a hand-copied prompt drifts exactly the way
 * the hand-copied cadence similarity math drifted (0.8095 in the copy vs 0.7727 shipped, PR #432).
 * Exporting the real builder is the only version of this experiment whose results mean anything.
 * Same move as `inboundReplyActionPrompt.ts` / `walkInInventoryWant.ts`; llmDraft.ts is at its
 * size ceiling and this pays the ratchet down further.
 *
 * The judge's calling contract (enable gates, model resolution, fallback, the shadow arm) stays
 * in `judgeDraftQualityWithLLM` — this module is only the question we ask, not when we ask it.
 */

export const DRAFT_QUALITY_JUDGE_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["intent_ok", "tone_ok", "disposition_ok", "safety_ok", "overall", "confidence", "reason", "steering"],
  properties: {
    intent_ok: { type: "boolean" },
    tone_ok: { type: "boolean" },
    disposition_ok: { type: "boolean" },
    safety_ok: { type: "boolean" },
    overall: { type: "string", enum: ["good", "needs_regenerate", "hold"] },
    confidence: { type: "number" },
    reason: { type: "string" },
    steering: { type: "string" }
  }
};

/**
 * Builds the full judge prompt. `historyLines` are already formatted "direction: body" lines,
 * already sliced to the judge's window — the WINDOW is the caller's policy (today: last 8; the
 * grader-phantom history says widening it is its own experiment), the QUESTION is this module's.
 */
export function buildDraftQualityJudgePrompt(args: {
  draft: string;
  inbound: string;
  historyLines: string[];
  leadModel?: string | null;
  leadSource?: string | null;
  channel?: "sms" | "email";
}): string {
  const history = args.historyLines ?? [];
  return [
    "You are a strict QA reviewer for a Harley dealership's AI sales agent. You read the DRAFT reply",
    "the agent wants to send and the CUSTOMER message it is replying to, and you judge the draft on",
    "four axes. Return only JSON matching the provided schema.",
    "",
    "Axes (each a boolean — true = passes):",
    "- intent_ok: does the draft actually ADDRESS what the customer asked / needs this turn? A fluent",
    "  reply that answers a DIFFERENT thing, dodges the question, or talks past the ask fails this.",
    "- tone_ok: is it on-voice — warm, natural, like a helpful person texting a friend? Stiff/corporate",
    "  (\"This is X. Per your inquiry...\"), robotic, or over-eager hard-sell fails. A 'Reply STOP' footer",
    "  on SMS is fine. Sparing emoji is fine.",
    "- disposition_ok: is it right for the customer's emotional state? If they're stressed, frustrated,",
    "  grieving, or money-tight → acknowledge before pitching. If they're not ready / just looking →",
    "  don't push a visit hard. If they're committed to a bike → don't undercut their choice. If they",
    "  just want info → answer it, don't pivot to scheduling.",
    "- safety_ok: no FABRICATED facts (a specific price, stock #, or availability the agent can't know),",
    "  no confirming a booking that isn't booked, no compliance problem.",
    "",
    "overall:",
    "- \"good\": all four axes pass; send as-is.",
    "- \"needs_regenerate\": a recoverable problem — tone is off, it's awkward, it half-missed but the",
    "  right info/approach is available; a re-draft would likely fix it.",
    "- \"hold\": it answers the WRONG thing, fabricates a fact, or is unsafe — a re-draft of the same",
    "  logic may not fix it; a human (or a code fix) should look. When unsure between regenerate and",
    "  hold, prefer needs_regenerate.",
    "",
    "Rules:",
    "- Judge the DRAFT, not the customer. Be fair: do not fail a draft that is genuinely fine.",
    "- steering: one short instruction for a re-draft (e.g. \"answer the price question directly\",",
    "  \"warm it up — drop the corporate intro\", \"acknowledge the stress before suggesting a visit\").",
    "  Empty string when overall is good.",
    "- confidence is 0..1; use >= 0.8 only when the verdict is clear.",
    "",
    "Examples:",
    '- customer: "What is the asking price?" | draft: "Doing well—hope your day is going great too!" ->',
    '  {"intent_ok":false,"tone_ok":true,"disposition_ok":false,"safety_ok":true,"overall":"hold",',
    '   "confidence":0.95,"reason":"answers small talk, ignores the price question","steering":"answer the price question or say you will get the exact price"}',
    '- customer: "what is the out the door price" | draft: "Great question — let me grab the exact',
    '  out-the-door number from my manager and text it right over. Anything else you want me to include?" ->',
    '  {"intent_ok":true,"tone_ok":true,"disposition_ok":true,"safety_ok":true,"overall":"good","confidence":0.9,"reason":"addresses the price ask without fabricating a number","steering":""}',
    '- customer: "my wife just passed, putting this on hold" | draft: "No problem! Want to come in',
    '  Saturday at 10 to check it out?" ->',
    '  {"intent_ok":false,"tone_ok":false,"disposition_ok":false,"safety_ok":true,"overall":"hold","confidence":0.95,"reason":"pushes a visit on a grieving customer who asked to pause","steering":"acknowledge their loss with empathy, no scheduling, leave the door open"}',
    '- customer: "is it still available" | draft: "Yes it is! When can you come in?" ->',
    '  {"intent_ok":true,"tone_ok":true,"disposition_ok":true,"safety_ok":true,"overall":"good","confidence":0.82,"reason":"confirms availability and invites a visit appropriately","steering":""}',
    "",
    `Channel: ${args.channel ?? "sms"}`,
    `Known lead: ${JSON.stringify({
      model: args.leadModel ?? null,
      source: args.leadSource ?? null
    })}`,
    history.length ? `Recent thread:\n${history.join("\n")}` : "Recent thread: (none)",
    `Customer's latest message: ${args.inbound}`,
    `DRAFT reply to judge: ${args.draft}`
  ].join("\n");
}

/** The verdict coercion the production judge applies — exported so offline arms match it exactly. */
export function coerceDraftQualityOverall(raw: unknown): "good" | "needs_regenerate" | "hold" {
  const v = String(raw ?? "").toLowerCase();
  return v === "hold" || v === "needs_regenerate" ? v : "good";
}
