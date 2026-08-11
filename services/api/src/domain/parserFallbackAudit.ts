import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "./dataDir.js";

/**
 * Durable record of every moment a KEYWORD fallback was allowed to speak for a customer turn while
 * the LLM parser had already read that turn.
 *
 * WHY THIS EXISTS (Joe asked, 2026-08-11: "are there still any regex that triggers before the llm
 * parser that shouldn't be?"). AGENTS.md "Fallback-vs-Parser Precedence" is unambiguous:
 *
 *   > A fallback may not overrule a parser verdict that exists — INCLUDING A HEDGED ONE BELOW THE
 *   > ACCEPT FLOOR. A hedged reading of the sentence beats a keyword that never read it.
 *
 * `canUseInboundReplyActionFallback` does not match that rule: it opens the door to the keyword
 * whenever confidence sits under the floor (0.74), even though a reading exists. That gate guards
 * ELEVEN call sites in the live path plus the regenerate twin.
 *
 * We could not size the problem. The parser usage log records that a parser RAN, not what it
 * returned, and route-outcome counters live in memory only — wiped by every restart, and the API
 * restarts 8-17 times a day. So "how often does a keyword overrule a hedged reading?" had no answer,
 * which is exactly the wrong footing for changing a routing precedence.
 *
 * This module is that missing answer, and NOTHING ELSE. It changes no decision: the audited wrapper
 * returns the identical boolean the pure gate returns, proven by decision_equivalence. Read the rows
 * for a few days, THEN decide whether to close the gap between the code and the rule.
 *
 * Rows are append-only JSONL, one file per month, same convention as `openaiUsageLogger`. Writing
 * must never break a customer turn, so every failure here is swallowed.
 */

export type ParserFallbackAuditRow = {
  /** Discriminates row shapes if this instrument later covers other parsers. */
  kind: string;
  [field: string]: unknown;
};

export function parserFallbackAuditEnabled(): boolean {
  return String(process.env.PARSER_FALLBACK_AUDIT_ENABLED ?? "1") !== "0";
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function parserFallbackAuditPath(date = new Date()): string {
  const configured = String(process.env.PARSER_FALLBACK_AUDIT_PATH ?? "").trim();
  if (configured) return configured;
  return path.join(getDataDir(), "parser_fallback_audit", `${monthKey(date)}.jsonl`);
}

/**
 * Append one audit row. Returns whether it was written, so an eval can assert the wire without
 * reaching into the filesystem twice — production callers ignore it.
 */
export function recordParserFallbackAudit(row: ParserFallbackAuditRow): boolean {
  if (!parserFallbackAuditEnabled()) return false;
  try {
    const filePath = parserFallbackAuditPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`, "utf8");
    return true;
  } catch {
    // Measurement is support only; it must never block a customer workflow.
    return false;
  }
}
