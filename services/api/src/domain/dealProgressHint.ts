// Deal-progress parser HINT gates (cost control, never a routing decision).
//
// Both helpers are cheap pre-filters that decide only whether the typed deal-progress LLM
// parser (parseDealProgressSignalWithLLM) is worth invoking on an inbound turn; the actual
// entry decision stays centralized in decideInProcessDealTurn (routeStateReducer.ts) behind
// parser acceptance + the confidence floor. Fail-direction: a hint FALSE NEGATIVE means the
// parser is never asked and the turn drafts normally (today's behavior — the failure this
// module exists to shrink); a hint FALSE POSITIVE only costs one extra parser call, whose
// output the reducer still gates. AGENTS.md bucket: deterministic pre-filter gating an LLM
// call (same class as the disposition hint), NOT comprehension — the parser comprehends.
//
// Moved out of index.ts (2026-07-23, +17166035402 / +17166046117 corrections) so the hint
// tables are importable by scripts/in_process_deal_eval.ts, and widened per those replays:
//  - accessory-config / total-cost turns on an agreed deal ("Yes please for it. And I'll
//    need a total cost.", "Please put those on.") carried none of the original logistics
//    vocabulary, so the parser was never consulted and the agent quoted an unrelated bike
//    price on a live deal;
//  - threads where ALL the deal language lives in the rep's own texts ("...finalize and
//    take delivery of your 2025 Low Rider ST") got customer turns like "Is Wednesday
//    around noon fine?" with no inbound hint at all — the staff-outbound helper below
//    lets the rep's recent human sends open the same parser gate.

const DEAL_PROGRESS_HINT_RE =
  /\b(insurance|insured|allstate|geico|progressive|state farm|payoff|paid off|pay[- ]?off|delivery|deliver(?:ed|ing)?|pick(?:ing)?\s*up|pickup|trailer|paperwork|title|plates?|registration|notar|sign(?:ing)?\s+(?:the\s+)?(?:docs|papers|paperwork)|deposit|down payment|install(?:ed|ing)?|finalize|total cost|out[- ]the[- ]door|add\s+(?:it|that|this|one|those|them)\s+to\s+(?:the|my|your)\s+(?:list|order|build)|put\s+(?:it|that|this|those|them|these)\s+on)\b/;

export function hasDealProgressParserHintText(text: string | null | undefined): boolean {
  const lower = String(text ?? "").toLowerCase();
  if (!lower.trim()) return false;
  return DEAL_PROGRESS_HINT_RE.test(lower);
}

// How far back a rep's own deal language keeps the parser gate open. Deals in flight move in
// days; a stale "delivery" text from weeks ago shouldn't hint forever.
export const STAFF_OUTBOUND_DEAL_HINT_WINDOW_DAYS = 14;
const STAFF_OUTBOUND_DEAL_HINT_SCAN_LIMIT = 6;

type MinimalMessage = {
  direction?: string;
  body?: string | null;
  at?: string | null;
  actorUserId?: string | null;
  actorUserName?: string | null;
};

// True when one of the last few HUMAN staff sends (a rep typing, not the agent — actor
// attribution present) within the recency window carries deal-progress language. Used as an
// alternate hint source for the same parser call: the parser then reads the real history and
// decideInProcessDealTurn still owns the decision.
export function hasStaffOutboundDealProgressHintText(
  messages: MinimalMessage[] | null | undefined,
  now: Date = new Date()
): boolean {
  const list = Array.isArray(messages) ? messages : [];
  const cutoff = now.getTime() - STAFF_OUTBOUND_DEAL_HINT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const humanSends = list.filter(m => {
    if (!m || m.direction !== "out") return false;
    if (!(m.actorUserId || m.actorUserName)) return false;
    if (!String(m.body ?? "").trim()) return false;
    const at = Date.parse(String(m.at ?? ""));
    return Number.isFinite(at) && at >= cutoff;
  });
  return humanSends
    .slice(-STAFF_OUTBOUND_DEAL_HINT_SCAN_LIMIT)
    .some(m => hasDealProgressParserHintText(m.body));
}
