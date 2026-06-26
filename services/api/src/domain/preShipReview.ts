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
 * reviewLoopFixWithLLM = the Claude reviewer (raw fetch + tool-use, no SDK; mirrors claudeAgent.ts).
 * decidePreShipGate = the PURE gate: ship only on a clean approve + green gates; otherwise ESCALATE. The
 * conservative default — no review available (no key) or any doubt — is ESCALATE, never silently ship.
 */

export type PreShipReviewParse = {
  verdict: "approve" | "hold";
  risk: "low" | "medium" | "high";
  customerFacing: boolean; // does this change what a customer receives?
  onTarget: boolean; // does the diff actually address the stated finding?
  lawOk: boolean; // parser-first / both-paths / eval present (per the diff)
  blocking: boolean; // a concrete defect that must block the merge
  reasons?: string;
  concerns?: string; // specific issues for the human when held
};

const PRE_SHIP_REVIEW_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "risk", "customer_facing", "on_target", "law_ok", "blocking", "reasons", "concerns"],
  properties: {
    verdict: { type: "string", enum: ["approve", "hold"] },
    risk: { type: "string", enum: ["low", "medium", "high"] },
    customer_facing: { type: "boolean" },
    on_target: { type: "boolean" },
    law_ok: { type: "boolean" },
    blocking: { type: "boolean" },
    reasons: { type: "string" },
    concerns: { type: "string" }
  }
};

export async function reviewLoopFixWithLLM(args: {
  title: string;
  finding: string; // the loop finding the fix claims to address
  diff: string; // git diff main...HEAD
  evalsGreen: boolean;
}): Promise<PreShipReviewParse | null> {
  const apiKey = String(process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!apiKey) return null; // no independent reviewer → caller escalates (see decidePreShipGate)
  if (String(process.env.PRE_SHIP_REVIEW_ENABLED ?? "1").trim() === "0") return null;

  const model = process.env.ANTHROPIC_PRESHIP_MODEL || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  const diff = String(args.diff ?? "").slice(0, 16000); // cap tokens; the shape is what matters
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
    "When unsure, HOLD — a human will look. concerns = the specific thing a human should check.",
    "",
    `Gates already green (tsc + ci:eval): ${args.evalsGreen ? "yes" : "NO"}.`,
    `Title: ${args.title}`,
    `Finding being fixed: ${args.finding}`,
    "",
    "DIFF (git diff main...HEAD):",
    diff || "(empty diff)"
  ].join("\n");

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: 700,
        temperature: 0,
        tool_choice: { type: "tool", name: "pre_ship_review" },
        tools: [{ name: "pre_ship_review", description: "Return the independent pre-ship review.", input_schema: PRE_SHIP_REVIEW_SCHEMA }],
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data: any = await resp.json().catch(() => null);
    if (!resp.ok) return null;
    const block = Array.isArray(data?.content) ? data.content.find((b: any) => b?.type === "tool_use" && b?.name === "pre_ship_review") : null;
    const p = block?.input;
    if (!p || typeof p !== "object") return null;
    const oneOf = <T extends string>(v: any, allowed: T[], dflt: T): T => (allowed.includes(String(v) as T) ? (String(v) as T) : dflt);
    return {
      verdict: oneOf(p.verdict, ["approve", "hold"], "hold"),
      risk: oneOf(p.risk, ["low", "medium", "high"], "high"),
      customerFacing: p.customer_facing !== false,
      onTarget: p.on_target === true,
      lawOk: p.law_ok === true,
      blocking: p.blocking === true,
      reasons: typeof p.reasons === "string" ? p.reasons.slice(0, 400) : undefined,
      concerns: typeof p.concerns === "string" ? p.concerns.slice(0, 400) : undefined
    };
  } catch {
    return null;
  }
}

// PURE gate. Ship only on a clean approve with green gates; anything else ESCALATES to a human. The
// conservative default (no review, or any doubt) is ESCALATE — never silently ship an unreviewed change.
export function decidePreShipGate(
  review: PreShipReviewParse | null,
  opts: { evalsGreen: boolean }
): { ship: boolean; escalate: boolean; reason: string } {
  if (!opts.evalsGreen) return { ship: false, escalate: false, reason: "gates not green (tsc + ci:eval) — fix before shipping" };
  if (!review) return { ship: false, escalate: true, reason: "no independent cross-model review available — escalate to a human" };
  if (review.verdict === "approve" && !review.blocking && review.onTarget && review.lawOk && review.risk !== "high") {
    return { ship: true, escalate: false, reason: `cross-model review approved (risk=${review.risk}, on_target, law_ok)` };
  }
  const why = review.concerns || review.reasons || "review withheld approval";
  return { ship: false, escalate: true, reason: `cross-model review HELD: ${why}` };
}
