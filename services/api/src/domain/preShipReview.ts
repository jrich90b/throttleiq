/**
 * Cross-model PRE-SHIP review — the independent check before a loop-driven change goes live.
 *
 * The safety premise of the whole self-healing loop, applied to its OWN output: a fluent-but-wrong change
 * is the failure mode we hunt, and a change written + approved + shipped by one party (me) with no second
 * set of eyes is exactly that risk. So before a behavioral fix merges, an INDEPENDENT model (Claude, a
 * different lineage than the OpenAI generation runtime) adversarially reviews the actual DIFF against the
 * finding it claims to fix and the parser-first law. This replaces "a human eyeballs every change" with "a
 * model that didn't write it checks every change" — and only genuine disagreement / judgment calls escalate
 * to a human.
 *
 * reviewLoopFixWithLLM = the Claude reviewer (tool-use via the shared anthropicRequest caller, no SDK).
 * decidePreShipGate = the PURE gate: ship only on a clean approve + green gates; otherwise ESCALATE. The
 * conservative default — no review available (no key) or any doubt — is ESCALATE, never silently ship.
 */
import { anthropicMessagesRequest, extractAnthropicToolInput } from "./anthropicRequest.js";

export type PreShipReviewParse = {
  verdict: "approve" | "hold";
  risk: "low" | "medium" | "high";
  customerFacing: boolean; // does this change what a customer receives?
  onTarget: boolean; // does the diff actually address the stated finding?
  lawOk: boolean; // parser-first / both-paths / eval present (per the diff)
  blocking: boolean; // a concrete defect that must block the merge
  /**
   * Tier-2a delegation (Joe, 2026-07-30): when a charter citation was supplied, does the cited
   * `docs/policy_charter.md` rule GENUINELY cover this change? Judged adversarially — stretching a
   * rule to cover a new judgment call must come back false. Meaningless (false) when no citation
   * was provided; only consulted when the gate is asked to require it.
   */
  charterCovered: boolean;
  reasons?: string;
  concerns?: string; // specific issues for the human when held
};

// `reasons`/`concerns` come FIRST on purpose (2026-07-29): the reviewer should articulate its
// reasoning BEFORE committing to a verdict, and trailing prose fields are the ones a max_tokens
// truncation eats. `minLength` makes an empty explanation schema-invalid rather than silently
// falsy — a hold whose reason was "" is exactly how PR #331 got blocked with nothing to act on.
// Best-effort only (tool schemas are not strictly enforced), which is why decidePreShipGate
// ALSO derives a deterministic failed-checks summary that cannot go silent.
const PRE_SHIP_REVIEW_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["reasons", "concerns", "verdict", "risk", "customer_facing", "on_target", "law_ok", "blocking", "charter_covered"],
  properties: {
    reasons: { type: "string", minLength: 20 },
    concerns: { type: "string", minLength: 1 },
    verdict: { type: "string", enum: ["approve", "hold"] },
    risk: { type: "string", enum: ["low", "medium", "high"] },
    customer_facing: { type: "boolean" },
    on_target: { type: "boolean" },
    law_ok: { type: "boolean" },
    blocking: { type: "boolean" },
    charter_covered: { type: "boolean" }
  }
};

export async function reviewLoopFixWithLLM(args: {
  title: string;
  finding: string; // the loop finding the fix claims to address
  diff: string; // git diff main...HEAD
  evalsGreen: boolean;
  /** Tier-2a: the claimed charter rule (id + verbatim excerpt from docs/policy_charter.md). */
  charterCitation?: { id: string; excerpt: string } | null;
}): Promise<PreShipReviewParse | null> {
  const apiKey = String(process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!apiKey) return null; // no independent reviewer → caller escalates (see decidePreShipGate)
  if (String(process.env.PRE_SHIP_REVIEW_ENABLED ?? "1").trim() === "0") return null;

  const model = process.env.ANTHROPIC_PRESHIP_MODEL || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  const diff = prepareDiffForReview(args.diff); // code-first, megalines collapsed, capped — never starve the source change out of the window (see prepareDiffForReview)
  const prompt = [
    "You are a senior engineer doing an INDEPENDENT pre-ship review of a code change for a Harley",
    "dealership's AI sales agent. You did NOT write this change. Be adversarial but fair: your job is to",
    "catch a fix that is fluent but wrong, off-target, unsafe, or breaks the codebase's law BEFORE it",
    "ships to real customers. Return only JSON matching the schema.",
    "",
    "The codebase LAW (judge law_ok against it):",
    "- COMPREHEND, never regex: customer intent is read by typed LLM parsers, not keyword/regex. A new",
    "  regex/keyword gate on free-text customer intent is a violation. (Deterministic IS allowed for",
    "  compliance/safety gates, STRUCTURED-field extraction, side-effects, and invariant guards.)",
    "- Route/reply decisions are centralized and applied in BOTH the live (/webhooks/twilio) and",
    "  regenerate paths — a change to one path but not the other is a parity violation.",
    "- A behavior change should carry a deterministic eval.",
    "",
    "Judge:",
    "- on_target: does the diff actually address the stated finding (not something else)?",
    "- law_ok: does it follow the law above (no new free-text regex intent gate; both paths; an eval present)?",
    "- customer_facing: does it change what a customer receives?",
    "- risk: high if a plausible scenario makes it reply wrongly / fail unsafe / regress an accepted case;",
    "  low if additive + fail-safe.",
    "- blocking: true if there is a concrete defect (wrong logic, missed path, law violation, unsafe).",
    "- verdict: approve ONLY if on_target AND law_ok AND not blocking AND risk is not high. Else hold.",
    "When unsure, HOLD — a human will look.",
    "",
    "EXPLAIN YOURSELF — a hold with no reason is useless, because the human it escalates to has nothing",
    "to act on. Mandatory:",
    "- reasons: 1-3 sentences on WHY you reached this verdict. Never empty.",
    "- concerns: when you HOLD, name the SPECIFIC thing to check — the file/function at issue and what",
    "  is wrong or unverified. \"Off-target\" or \"risky\" alone is not acceptable; say off-target HOW.",
    "  When you approve, put the residual risk to watch (or \"none\").",
    "- If you mark on_target=false, law_ok=false, or blocking=true, concerns MUST say which one and why.",
    "",
    ...(args.charterCitation
      ? args.charterCitation.id === "NS"
        ? [
            "NORTH-STAR ALIGNMENT (charter_covered) — this change claims Tier-2a WITHOUT a specific rule",
            "id: it cites only the owner's (Joe's) stated goal, quoted below from docs/policy_charter.md.",
            "This is the WEAKEST citation available, so judge it the HARDEST. charter_covered=true ONLY if",
            "the change plainly and directly advances that goal as written, and decides nothing Joe has not",
            "already decided. Merely being consistent with, adjacent to, or not-in-conflict-with the goal is",
            "NOT coverage — that is charter_covered=false. Any change that picks a new product policy, sets a",
            "threshold/figure, or resolves a judgment call the goal does not resolve is charter_covered=false.",
            "When false, concerns must say what the change decides that the goal does not.",
            "Cited goal (North star):",
            args.charterCitation.excerpt,
            ""
          ]
        : [
            "CHARTER COVERAGE (charter_covered) — this change claims Tier-2a delegation: it says it merely",
            "implements a policy the owner (Joe) has ALREADY ruled, quoted below from docs/policy_charter.md.",
            "Judge the citation ADVERSARIALLY: charter_covered=true ONLY if the change is a faithful",
            "implementation/correction toward that specific rule with no new judgment call smuggled in.",
            "A stretched citation — the rule is adjacent, the change goes beyond it, or 'correct' here",
            "requires a decision the rule does not make — is charter_covered=false. When false, concerns",
            "must say what the change decides that the cited rule does not.",
            `Cited rule ${args.charterCitation.id}:`,
            args.charterCitation.excerpt,
            ""
          ]
      : ["No charter citation was supplied — set charter_covered=false (it is not being claimed).", ""]),
    `Gates already green (tsc + ci:eval): ${args.evalsGreen ? "yes" : "NO"}.`,
    `Title: ${args.title}`,
    `Finding being fixed: ${args.finding}`,
    "",
    "DIFF (git diff main...HEAD):",
    diff || "(empty diff)"
  ].join("\n");

  try {
    // Shared caller (anthropicRequest.ts): claude-opus-5 rejects `temperature`, and this fetch
    // used to hardcode it — a 400 here returns null, which escalates EVERY ship as "no review
    // available". Pointing ANTHROPIC_PRESHIP_MODEL at Opus without this would have switched
    // auto-merge off across every routine with nothing saying why.
    const result = await anthropicMessagesRequest({
      apiKey,
      model,
      // Room for real prose in reasons+concerns; at 700 the trailing explanation fields were the
      // first thing a truncation dropped.
      maxTokens: 1200,
      temperature: 0,
      toolName: "pre_ship_review",
      toolDescription: "Return the independent pre-ship review.",
      inputSchema: PRE_SHIP_REVIEW_SCHEMA,
      messages: [{ role: "user", content: prompt }]
    });
    if (!result.ok) return null;
    const p = extractAnthropicToolInput(result.data, "pre_ship_review");
    if (!p || typeof p !== "object") return null;
    const oneOf = <T extends string>(v: any, allowed: T[], dflt: T): T => (allowed.includes(String(v) as T) ? (String(v) as T) : dflt);
    return {
      verdict: oneOf(p.verdict, ["approve", "hold"], "hold"),
      risk: oneOf(p.risk, ["low", "medium", "high"], "high"),
      customerFacing: p.customer_facing !== false,
      onTarget: p.on_target === true,
      lawOk: p.law_ok === true,
      blocking: p.blocking === true,
      // Fail-safe direction: anything but an explicit true means NOT covered.
      charterCovered: p.charter_covered === true,
      // Normalize blank prose to undefined: an empty string satisfies `required` but is falsy, so it
      // used to slip through as "the reviewer explained itself" and land as a contentless hold.
      reasons: cleanReviewText(p.reasons),
      concerns: cleanReviewText(p.concerns)
    };
  } catch {
    return null;
  }
}

/**
 * Blank/whitespace prose → undefined, so a falsy-but-present string can never pass as an explanation.
 * Cap is generous (the point of this field is to be READ) and marks truncation, because a reason cut
 * off mid-sentence reads as a bug and loses the actionable half.
 */
export function cleanReviewText(value: unknown, cap = 900): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= cap ? trimmed : `${trimmed.slice(0, cap).trimEnd()}…[truncated]`;
}

/**
 * Which checks actually drove a non-ship, derived from the flags the gate already holds.
 *
 * This is the part that CANNOT go silent. The reviewer's prose is best-effort — it can come back
 * blank or get truncated — but an escalation with no stated cause just moves the guesswork onto the
 * human (observed on PR #331: `verdict=hold` with empty reasons AND concerns, so the operator was
 * told only "review withheld approval"). Pure, so `pre_ship_review:eval` pins it.
 */
export function summarizePreShipHold(review: PreShipReviewParse): string {
  const failed: string[] = [];
  if (!review.onTarget) failed.push("on_target=false (reviewer does not think the diff addresses the finding)");
  if (!review.lawOk) failed.push("law_ok=false (reviewer flagged a parser-first/both-paths/eval violation)");
  if (review.blocking) failed.push("blocking=true (reviewer found a concrete defect)");
  if (review.risk === "high") failed.push("risk=high");
  if (!failed.length && review.verdict === "hold") failed.push("verdict=hold with no failing check (reviewer was unsure)");
  return failed.join("; ");
}

// PURE gate. Ship only on a clean approve with green gates; anything else ESCALATES to a human. The
// conservative default (no review, or any doubt) is ESCALATE — never silently ship an unreviewed change.
// Tier-2a (requireCharterCovered): a clean approve additionally needs the reviewer's confirmation that
// the cited docs/policy_charter.md rule genuinely covers the change — an approve WITHOUT coverage still
// escalates, because "good change" is not the question; "already ruled by Joe" is.
export function decidePreShipGate(
  review: PreShipReviewParse | null,
  opts: { evalsGreen: boolean; requireCharterCovered?: boolean }
): { ship: boolean; escalate: boolean; reason: string } {
  if (!opts.evalsGreen) return { ship: false, escalate: false, reason: "gates not green (tsc + ci:eval) — fix before shipping" };
  if (!review) return { ship: false, escalate: true, reason: "no independent cross-model review available — escalate to a human" };
  if (review.verdict === "approve" && !review.blocking && review.onTarget && review.lawOk && review.risk !== "high") {
    if (opts.requireCharterCovered && !review.charterCovered) {
      const why = cleanReviewText(review.concerns) ?? cleanReviewText(review.reasons) ?? "no detail given";
      return {
        ship: false,
        escalate: true,
        reason: `cross-model review approved the change but REJECTED the charter citation (charter_covered=false) — this is a NEW judgment call, ask Joe: ${why}`
      };
    }
    return {
      ship: true,
      escalate: false,
      reason: `cross-model review approved (risk=${review.risk}, on_target, law_ok${opts.requireCharterCovered ? ", charter_covered" : ""})`
    };
  }
  // A hold must always arrive actionable: the reviewer's own words when it gave any, plus the
  // deterministic list of checks that failed either way.
  const prose = cleanReviewText(review.concerns) ?? cleanReviewText(review.reasons);
  const failed = summarizePreShipHold(review);
  const why = prose ?? "NO REASON GIVEN by the reviewer (prose came back empty — treat the failed checks below as the whole basis)";
  // `failed` already names risk=high; only append risk when it isn't already in there.
  const riskSuffix = review.risk === "high" ? "" : ` (risk=${review.risk})`;
  return {
    ship: false,
    escalate: true,
    reason: `cross-model review HELD: ${why}${failed ? ` — failed checks: ${failed}` : ""}${riskSuffix}`
  };
}

/**
 * Prepare a raw `git diff main...HEAD` so the ACTUAL logic change is always inside the reviewed window.
 * Two failure modes this fixes (Jason watch-matcher ship, 6/26 — PR #100 was wrongly ESCALATED):
 *  (1) git lists files ALPHABETICALLY, so a config file (package.json) precedes source (services/...). With
 *      a flat char cap, the source hunk can be truncated out entirely → the reviewer reports "no change to
 *      <file>" and HOLDS a correct fix.
 *  (2) a single line can be enormous — the one-line `ci:eval` chain in package.json is ~15KB — and on its
 *      own blows the whole budget. Almost every loop fix wires in an eval (touching that exact line), so a
 *      naive cap would mis-fire on nearly every change the loop ships.
 * Fix: split per file, COLLAPSE any single +/- content line over `maxLineLen` to a short marker, ORDER
 * source/code files before config/lock/generated files, then cap. Pure + deterministic so
 * `pre_ship_review:eval` can pin the behavior without an LLM call.
 */
export function prepareDiffForReview(rawDiff: string, opts?: { cap?: number; maxLineLen?: number }): string {
  const cap = opts?.cap ?? 24000;
  const maxLineLen = opts?.maxLineLen ?? 500;
  const raw = String(rawDiff ?? "");
  if (!raw.trim()) return "";

  const headerRe = /^diff --git a\/(\S+) b\/(\S+)$/gm;
  const headers: { path: string; start: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(raw))) headers.push({ path: m[2] || m[1], start: m.index });
  if (!headers.length) return capWithMarker(collapseLongDiffLines(raw, maxLineLen), cap); // not a recognizable git diff

  const sections = headers.map((h, i) => ({
    path: h.path,
    text: collapseLongDiffLines(raw.slice(h.start, i + 1 < headers.length ? headers[i + 1].start : raw.length), maxLineLen)
  }));
  // Stable sort: non-config (source) keep their original alpha order and lead; config/lock/generated sink to
  // the end. Node's Array.sort is stable, so equal-rank items preserve input order.
  const ordered = sections
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (isLowSignalPath(a.s.path) ? 1 : 0) - (isLowSignalPath(b.s.path) ? 1 : 0) || a.i - b.i)
    .map(x => x.s);
  return capWithMarker(ordered.map(s => s.text).join(""), cap);
}

/** Config / lock / generated files — real but low review-signal; sort them after source so source is never starved. */
function isLowSignalPath(p: string): boolean {
  return (
    /(^|\/)package(-lock)?\.json$/.test(p) ||
    /(^|\/)(yarn\.lock|pnpm-lock\.yaml|composer\.lock)$/.test(p) ||
    /\.lock$/.test(p) ||
    /\.(snap|map|min\.js|min\.css)$/.test(p)
  );
}

/** Collapse any single +/- CONTENT line longer than maxLineLen to a marker; never touch diff/file/hunk headers. */
function collapseLongDiffLines(text: string, maxLineLen: number): string {
  return text
    .split("\n")
    .map(line => {
      if (line.startsWith("+++ ") || line.startsWith("--- ")) return line; // file headers
      if ((line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) && line.length > maxLineLen) {
        return `${line[0]} [line collapsed: ${line.length} chars]`;
      }
      return line;
    })
    .join("\n");
}

function capWithMarker(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}\n…[diff truncated at ${cap} chars]`;
}
