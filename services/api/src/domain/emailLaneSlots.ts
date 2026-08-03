/**
 * Email/SendGrid lane slot comprehension — the merged-parser cutover entry point.
 *
 * Lives in its OWN module, not in llmDraft.ts, deliberately: the un-stack loop is
 * actively ratcheting llmDraft.ts DOWN (source_size_ratchet:eval), and adding to
 * that file would silently spend reductions another routine just earned. Nothing
 * in llmDraft imports this module, so there is no cycle.
 */
import type { Conversation } from "./conversationStore.js";
import {
  parseSemanticSlotsWithLLM,
  parseUnifiedSemanticSlotsMergedWithLLM,
  applyMergedWatchRelevanceGuard,
  type SemanticSlotParse,
  type UnifiedSemanticSlotParse
} from "./llmDraft.js";

/**
 * Semantic slots for the EMAIL / SendGrid lane — merged-parser aware.
 * (Email-lane cutover, 2026-08-03; Joe approved 2026-08-01. CLAUDE.md: "Still on
 * legacy: the email/SendGrid lane (calls parseSemanticSlotsWithLLM directly) —
 * its cutover is the next milestone.")
 *
 * WHY THIS EXISTS. The SMS lane funnels its slot comprehension through
 * `parseUnifiedSemanticSlotsWithLLM`, so since 2026-07-14 it is served by the
 * MERGED one-call parser. The email lane calls `parseSemanticSlotsWithLLM`
 * DIRECTLY — so the same customer sentence can be understood by two different
 * parsers depending only on whether it arrived as a text or an email. That split
 * is the defect; this closes it.
 *
 * WHY NOT just call `parseUnifiedSemanticSlotsWithLLM` here. Email consumes the
 * SEMANTIC slots only — it never reads trade payoff or trade target. The unified
 * wrapper's flag-OFF branch fires all THREE sub-parsers, so routing email through
 * it would turn 1 round-trip into 3 in exactly the state we fall back to. Taking
 * the merged parser's `semantic` half instead keeps the email lane at ONE call in
 * BOTH states: this is a comprehension-parity change, not a cost change.
 *
 * FAIL DIRECTION / KILL SWITCH. The email lane gets its OWN flag
 * (`LLM_EMAIL_UNIFIED_SLOT_LIVE`) so it can be reverted WITHOUT reverting SMS.
 * Unset ⇒ `parseSemanticSlotsWithLLM` runs exactly as today, so the fail
 * direction points at today's shipped behavior. The legacy path is NOT burned
 * here — per CLAUDE.md it IS the revert, and stays until the email lane has its
 * own clean soak.
 *
 * The merged result passes `applyMergedWatchRelevanceGuard` BEFORE projection —
 * the merged parser's known failure mode is watch OVER-ATTACHMENT, and CLAUDE.md
 * is explicit: never act on a model the customer didn't reference this turn.
 */
export async function parseSemanticSlotsMergedAwareWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
  inventoryWatch?: Conversation["inventoryWatch"];
  inventoryWatchPending?: Conversation["inventoryWatchPending"];
  tradePayoff?: Conversation["tradePayoff"];
  dialogState?: string;
}): Promise<SemanticSlotParse | null> {
  const mergedLive =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_EMAIL_UNIFIED_SLOT_LIVE === "1" &&
    process.env.LLM_UNIFIED_SLOT_MERGED_LIVE === "1" &&
    process.env.LLM_UNIFIED_SLOT_PARSER_ENABLED === "1" &&
    !!process.env.OPENAI_API_KEY;
  if (!mergedLive) return parseSemanticSlotsWithLLM(args);
  const merged = applyMergedWatchRelevanceGuard(
    await parseUnifiedSemanticSlotsMergedWithLLM(args),
    args.text
  );
  return projectUnifiedToSemanticSlots(merged);
}

/**
 * Project a merged unified parse down to the legacy `SemanticSlotParse` shape the
 * email call sites already consume. Pure, so the eval can pin that it is LOSSLESS
 * across every semantic field — a field silently dropped here would be a
 * comprehension regression on the email lane that no SMS eval could ever see.
 *
 * `confidence` deliberately maps from `watchConfidence` (the SEMANTIC half's own
 * score), NOT the unified `confidence`. The unified value is the MIN across all
 * three jobs, so a low trade-payoff score on a turn that mentions no trade would
 * drag a perfectly confident semantic parse under the email lane's acceptance
 * floor (`LLM_SEMANTIC_SLOT_CONFIDENCE_MIN`, 0.76) and silently drop real watch
 * intent. Fail direction: mapping the wrong field fails toward NOT setting a
 * watch the customer asked for.
 */
export function projectUnifiedToSemanticSlots(
  parse: UnifiedSemanticSlotParse | null
): SemanticSlotParse | null {
  if (!parse) return null;
  return {
    watchAction: parse.watchAction,
    watch: parse.watch,
    departmentIntent: parse.departmentIntent,
    contactPreferenceIntent: parse.contactPreferenceIntent,
    mediaIntent: parse.mediaIntent,
    serviceRecordsIntent: parse.serviceRecordsIntent,
    confidence: parse.watchConfidence
  };
}

