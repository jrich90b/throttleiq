/**
 * Per-parser feature-flag wiring (8/3 wiring triage, theme D2).
 *
 * The three legacy per-parser flags (LLM_TRADE_PAYOFF_PARSER_ENABLED,
 * LLM_TRADE_TARGET_VALUE_PARSER_ENABLED, LLM_SEMANTIC_SLOT_PARSER_ENABLED) were OR'd with
 * LLM_UNIFIED_SLOT_PARSER_ENABLED — which is ON in prod — so they could only ever turn a parser
 * ON, never OFF. In an incident, the documented per-parser kill switch appeared to do nothing.
 *
 * Contract:
 *   - explicit "0"  -> OFF, no matter what the unified flag says (a kill switch that kills);
 *   - "1"           -> ON;
 *   - anything else -> ON iff LLM_UNIFIED_SLOT_PARSER_ENABLED === "1" (the pre-fix behavior, so
 *                      unset flags behave byte-identically to before).
 *
 * Callers still AND this with LLM_ENABLED and the API key check — this helper owns only the
 * per-parser bit.
 */
export function isParserFlagEnabled(flagName: string): boolean {
  const raw = String(process.env[flagName] ?? "").trim();
  if (raw === "0") return false;
  return raw === "1" || process.env.LLM_UNIFIED_SLOT_PARSER_ENABLED === "1";
}
