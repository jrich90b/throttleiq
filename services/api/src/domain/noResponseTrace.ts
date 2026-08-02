/**
 * Wrongful-silence trace shaping (2026-08-02) — the pure half of the no-response judge's shadow hook.
 *
 * The judge answers "did this turn deserve a reply we didn't give?". THIS module answers the much
 * smaller question that followed it around inside index.ts: given the verdict, do we record anything,
 * and under which trace stage? That was ~18 lines of branching wedged into an async handler where it
 * could only ever be exercised by a live LLM call. It is a pure mapping, so it belongs here and is
 * gradeable in `no_response_judge:eval` without spending a token.
 *
 * THREE stages, because they are three different findings and get read by different people:
 *   no_response.flag                  — a confident wrongful silence, judge LIVE (the enforce lane)
 *   no_response.shadow                — the same, while dark: what we WOULD have flagged
 *   no_response.social_reciprocation  — not a miss. A warm closer ("have a good weekend!") we stayed
 *                                       quiet on. Silence is defensible; a reply is an opportunity.
 *                                       Kept separate so it can never inflate the wrongful-silence
 *                                       count that gates the enforce decision.
 *
 * FAIL DIRECTION: return null (record nothing) whenever the verdict is missing or says silence was
 * fine. This is observability — over-recording buries the real misses, and a trace nobody trusts is
 * worse than no trace.
 */

export type NoResponseTraceVerdict = {
  shouldRespond?: boolean | null;
  confidence?: number | null;
  category?: string | null;
  reason?: string | null;
};

export type NoResponseTraceDecision = {
  action: "pass" | "flag_missing_response";
  live: boolean;
};

export type NoResponseTrace = {
  stage: "no_response.flag" | "no_response.shadow" | "no_response.social_reciprocation";
  detail: Record<string, unknown>;
};

/**
 * Shape the trace for one judged silence, or null to record nothing.
 * `decision` comes from `decideNoResponseJudge` — this module deliberately does NOT re-derive it, so
 * the gate stays the single owner of "is this a wrongful silence?".
 */
export function resolveNoResponseTrace(input: {
  verdict: NoResponseTraceVerdict | null | undefined;
  decision: NoResponseTraceDecision;
  inboundText: string;
}): NoResponseTrace | null {
  const verdict = input.verdict;
  if (!verdict) return null;
  const isWrongfulSilence = input.decision.action !== "pass";
  const isSocialReciprocation = String(verdict.category ?? "") === "social_reciprocation";
  // A social closer that the gate ALSO flagged is a wrongful silence first — the stronger finding wins,
  // otherwise a real dropped ask could be filed as a nice-to-have.
  if (!isWrongfulSilence && !isSocialReciprocation) return null;
  const stage: NoResponseTrace["stage"] = isWrongfulSilence
    ? input.decision.live
      ? "no_response.flag"
      : "no_response.shadow"
    : "no_response.social_reciprocation";
  return {
    stage,
    detail: {
      action: input.decision.action,
      live: input.decision.live,
      category: verdict.category ?? null,
      shouldRespond: verdict.shouldRespond ?? null,
      confidence: typeof verdict.confidence === "number" ? verdict.confidence : null,
      reason: String(verdict.reason ?? "").slice(0, 180),
      inboundPreview: String(input.inboundText ?? "").slice(0, 140)
    }
  };
}
