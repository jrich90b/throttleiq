import { normalizeText } from "./toneQuality.ts";

// Reply-matching for the tone-quality audit, extracted as a PURE, testable unit
// (gate: tone_quality:fixture_eval) so the "did this turn get answered" rule is
// not buried inline in one scorer.
//
// Joe ruling (2026-07-13): STOP counting a reply that went out after the 30-min
// response window as a `missing_response` tone FAILURE. In this dealer staff work
// leads in Suggest mode, so a genuine, good reply routinely lands hours later
// (Davey Cash: "can I look Saturday?" → "Saturday works, what time?" at +4h22m).
// The 30-min clock is a LATENCY signal (owned by response_latency_audit), not a
// tone pass/fail. So:
//   - reply within the window        → responded (prompt)     — graded on the reply
//   - reply after the window         → responded (LATE)       — graded on the reply, NOT a miss
//   - no reply before the customer's next inbound / ever → missing_response (a real drop)
// Fail-direction stays safe: a turn the customer had to re-nudge, or that was
// never answered at all, is still counted as a miss.

export type InboundReplyMatch = {
  matchedOut: any;
  // true = reply arrived within responseWindowMin; false = a genuine but LATE reply.
  withinWindow: boolean;
  latencySec: number;
};

function toMs(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/**
 * Find the outbound reply that answers the inbound turn at `inboundIndex`.
 * `messages` MUST be sorted ascending by time. Returns null when the turn was
 * genuinely unanswered (no outbound before the customer's next inbound, or none
 * at all) — that is the only case the audit scores as `missing_response`.
 */
export function matchInboundReply(
  messages: any[],
  inboundIndex: number,
  responseWindowMin: number
): InboundReplyMatch | null {
  const inbound = messages[inboundIndex];
  const inboundAtMs = toMs(String(inbound?.at ?? ""));
  if (!Number.isFinite(inboundAtMs)) return null;
  const maxOutMs = inboundAtMs + responseWindowMin * 60 * 1000;

  // Phase 1 — prompt reply strictly within the window. Preserves the original
  // audit semantics exactly (intervening inbounds inside the window are ignored,
  // so two quick customer texts can both attach to the same in-window reply).
  for (let j = inboundIndex + 1; j < messages.length; j += 1) {
    const out = messages[j];
    const outAtMs = toMs(String(out?.at ?? ""));
    if (!Number.isFinite(outAtMs)) continue;
    if (outAtMs > maxOutMs) break;
    if (out?.direction !== "out") continue;
    if (!normalizeText(out?.body)) continue;
    return { matchedOut: out, withinWindow: true, latencySec: Math.max(0, Math.round((outAtMs - inboundAtMs) / 1000)) };
  }

  // Phase 2 — a LATE reply: the first real outbound that lands BEFORE the customer
  // texts again. If the customer re-pinged first (or nobody ever replied), this
  // turn was genuinely dropped → null (missing_response).
  for (let j = inboundIndex + 1; j < messages.length; j += 1) {
    const m = messages[j];
    const mAtMs = toMs(String(m?.at ?? ""));
    if (!Number.isFinite(mAtMs)) continue;
    if (m?.direction === "in" && normalizeText(m?.body)) return null;
    if (m?.direction === "out" && normalizeText(m?.body)) {
      return { matchedOut: m, withinWindow: false, latencySec: Math.max(0, Math.round((mAtMs - inboundAtMs) / 1000)) };
    }
  }
  return null;
}
