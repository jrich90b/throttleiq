/**
 * Feed Joe's written rulings to the in-product draft reviewer (Joe, 2026-08-15: "does this Claude
 * API know the guardrails we have?" — then, on being shown the measurement below, "build the fix").
 *
 * THE DEFECT THIS EXISTS FOR, measured 2026-08-15. The minute-lane reviewer stamped `ok` on a draft
 * that broke TWO of Joe's own rulings at once (conv `+17169071289`, receipt
 * `msg_9092e0d536c57_1786813233214`, 17:01:02Z): it re-introduced the agent to a customer texted the
 * day before (7/23 ruling) and offered to show a bike he had already ridden (8/15 DAT ruling). It
 * approved them because **nobody had ever told it those rules existed.** That is true of every rule
 * in the charter and of every rule Joe makes from here — the reviewer's blind spot grows with each
 * ruling, which is why this is worth more than any single copy fix.
 *
 * WHY A FILE READ AND NOT HARD-CODED CLAUSES: the whole point is that a NEW ruling reaches the
 * reviewer without a code change. Joe writes it in `docs/policy_charter.md`, the next review picks
 * it up. Hard-coding would recreate the problem one ruling later.
 *
 * SCOPE — composition-relevant sections ONLY. The reviewer judges one drafted reply, so it gets C1
 * (voice & composition) and C2 (when to stay silent), plus the rate-quoting line from C7 because
 * quoting a figure is the costliest thing a rewrite can invent. Cadence timing, task routing and ops
 * conduct are not its job and would only dilute the prompt.
 *
 * FAIL DIRECTION: every failure returns null and the caller keeps the baked-in rules, which are the
 * floor and are never replaced by this. A missing, truncated or malformed charter must degrade the
 * reviewer to exactly today's behaviour — never a crash, never an empty ruleset.
 */
import fs from "node:fs";
import path from "node:path";

/** Sections the reviewer is allowed to see. Anything else is not its job. */
export const REVIEW_RELEVANT_CHARTER_SECTIONS = ["C1", "C2"] as const;

/** Individual rules pulled in from sections the reviewer does NOT otherwise get. */
export const REVIEW_RELEVANT_EXTRA_RULE_IDS = ["C7.1"] as const;

/** Cap what we inject so one runaway charter edit cannot crowd out the baked rules. */
export const CHARTER_FEED_MAX_CHARS = 6000;

/**
 * Pull the composition-relevant rules out of charter markdown. Pure over the text so the eval can
 * execute it against a fixture instead of the real file.
 *
 * The charter's shape is `## C1 — Voice & composition` headings over `- **C1.7** …` bullets that may
 * wrap across lines. We keep the bullets and drop the `*(provenance)*` trailers — the reviewer needs
 * the rule, not the citation, and the citations are a third of the bytes.
 */
export function extractReviewRelevantCharterRules(markdown: string): string | null {
  const text = String(markdown ?? "");
  if (!text.trim()) return null;
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let inSection = false;
  /** Is the most recent line we kept a bullet that a continuation line may extend? */
  let lastKeptIsOpen = false;
  for (const line of lines) {
    const heading = /^##\s+(C\d+)\b/.exec(line);
    if (heading) {
      inSection = (REVIEW_RELEVANT_CHARTER_SECTIONS as readonly string[]).includes(heading[1]);
      lastKeptIsOpen = false;
      continue;
    }
    // Rule ids carry an optional letter suffix (`C1.2a` — a clarification bolted onto an existing
    // rule rather than renumbering the charter). Missing that suffix silently drops exactly the
    // kind of rule this feed exists to deliver, so it is part of the pattern, not an afterthought.
    const ruleId = /^\s*-\s+\*\*(C\d+\.\d+[a-z]?)\*\*/.exec(line);
    if (ruleId) {
      const wanted = inSection || (REVIEW_RELEVANT_EXTRA_RULE_IDS as readonly string[]).includes(ruleId[1]);
      // A rule we do not want must not be appended to the last one we DID want, so mark that there
      // is no open bullet to continue into.
      lastKeptIsOpen = wanted;
      if (!wanted) continue;
      kept.push(line.trim());
      continue;
    }
    // A continuation line belongs to the bullet above it — keep it ONLY if we kept that bullet.
    // A rule cut off mid-sentence is worse than one left out: the reviewer would enforce half a rule.
    if (lastKeptIsOpen && kept.length && /^\s+\S/.test(line) && !/^\s*-\s/.test(line)) {
      kept[kept.length - 1] = `${kept[kept.length - 1]} ${line.trim()}`;
      continue;
    }
    if (!line.trim()) lastKeptIsOpen = false;
  }
  const cleaned = kept
    .map(l => l.replace(/\*\(.*?\)\*\s*$/, "").replace(/\*\*/g, "").trim())
    .filter(Boolean);
  if (!cleaned.length) return null;
  const joined = cleaned.join("\n");
  return joined.length > CHARTER_FEED_MAX_CHARS ? `${joined.slice(0, CHARTER_FEED_MAX_CHARS)}\n…(charter truncated)` : joined;
}

/** Resolved once; the charter lives in the repo next to the running code. */
function charterPath(): string {
  return process.env.POLICY_CHARTER_PATH?.trim() || path.resolve(process.cwd(), "docs/policy_charter.md");
}

let cached: { at: number; value: string | null } | null = null;
/** Re-read at most this often — the minute lane must not stat the file per draft. */
export const CHARTER_FEED_CACHE_MS = 5 * 60 * 1000;

/**
 * The charter rules for the reviewer, or null when the file cannot be read or yields nothing.
 * Never throws: a broken charter degrades the reviewer to its baked rules, which is exactly
 * today's behaviour.
 */
export function loadReviewRelevantCharterRules(nowMs: number = Date.now()): string | null {
  if (cached && nowMs - cached.at < CHARTER_FEED_CACHE_MS) return cached.value;
  let value: string | null = null;
  try {
    value = extractReviewRelevantCharterRules(fs.readFileSync(charterPath(), "utf8"));
  } catch {
    value = null;
  }
  cached = { at: nowMs, value };
  return value;
}

/** Test seam — the eval clears the cache between fixtures. */
export function resetCharterFeedCacheForTests(): void {
  cached = null;
}
