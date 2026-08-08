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
 * The unit the composer was actually working from, straight off the live inventory feed — the only
 * numbers in this prompt the judge is allowed to treat as GROUND TRUTH.
 *
 * WHY (Joe, 2026-08-04, on Michael Lococo `+15853075478`): the judge reads words, not inventory, so
 * a WRONG number that reads perfectly sails through. His draft quoted "$25,999–$44,999 ... around
 * $560–$1,020/mo" for a 2026 Road Glide — a range swept from sibling models (the CVO ST), turned
 * into a payment quote. Fluent, on-topic, correctly formatted, and worth $15k of nonsense. The
 * judge rated it fine because nothing in its prompt said what the bike costs. `safety_ok` already
 * said "no FABRICATED facts (a specific price the agent can't know)" — but the judge had no way to
 * tell an invented number from a real one. These facts are that way.
 */
export type DraftQualityUnitFacts = {
  /** Human label for the resolved unit, e.g. "2026 Harley-Davidson Road Glide (Dark Billiard Gray Black Trim)". */
  label?: string | null;
  /** Feed list/asking price in dollars. */
  listPrice?: number | null;
  mileage?: number | null;
  stockId?: string | null;
  /** Feed availability, e.g. "available" / "sale_pending" / "sold". */
  status?: string | null;
};

/** True when we resolved enough about a specific unit for the judge to check a number against it. */
export function hasCheckableUnitFacts(facts: DraftQualityUnitFacts | null | undefined): boolean {
  if (!facts) return false;
  const price = typeof facts.listPrice === "number" && facts.listPrice > 0;
  const mileage = typeof facts.mileage === "number" && facts.mileage > 0;
  return price || mileage;
}

/**
 * Builds the full judge prompt. `historyLines` are already formatted "direction: body" lines,
 * already sliced to the judge's window — the WINDOW is the caller's policy (today: last 8; the
 * grader-phantom history says widening it is its own experiment), the QUESTION is this module's.
 *
 * `unitFacts` is OPTIONAL and the prompt is byte-identical to the pre-2026-08-04 prompt when it is
 * absent or carries no checkable number. That is deliberate: most turns have no single resolved
 * unit (a general model inquiry has no one price), and a fact-check section with nothing in it
 * would invite the judge to reason about numbers it cannot see.
 */
export function buildDraftQualityJudgePrompt(args: {
  draft: string;
  inbound: string;
  historyLines: string[];
  leadModel?: string | null;
  leadSource?: string | null;
  channel?: "sms" | "email";
  unitFacts?: DraftQualityUnitFacts | null;
}): string {
  const history = args.historyLines ?? [];
  const facts = hasCheckableUnitFacts(args.unitFacts) ? args.unitFacts! : null;
  const factLines = facts
    ? [
        "",
        "VERIFIED UNIT FACTS — read from the live inventory feed for the unit this thread is about.",
        "These are TRUE. They are also the ONLY numbers you can verify:",
        `  ${JSON.stringify({
          unit: facts.label ?? null,
          listPrice: typeof facts.listPrice === "number" && facts.listPrice > 0 ? facts.listPrice : null,
          mileage: typeof facts.mileage === "number" && facts.mileage > 0 ? facts.mileage : null,
          stockId: facts.stockId ?? null,
          status: facts.status ?? null
        })}`,
        "- A price, payment, or mileage in the draft that CONTRADICTS these facts fails safety_ok ->",
        "  \"hold\". A wrong number that reads perfectly is the failure this section exists to catch.",
        "- A PAYMENT estimate built on a wrong price is the same failure. A monthly range far wider",
        "  than one bike can justify (e.g. \"$560-$1,020/mo\") is the tell that the price behind it",
        "  swept in other models — hold it and say which number is wrong.",
        "- A price RANGE is wrong whenever we resolved ONE unit: quote its price, not a spread.",
        "- Do NOT reason about numbers that are not listed here. Out-the-door totals, taxes, fees,",
        "  rates, and trade values are not in these facts — a draft that defers on those is CORRECT,",
        "  not a fabrication. Absence of a fact is never evidence the draft is wrong."
      ]
    : [];
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
    "- A \"WEB LEAD (ADF)\" block is a FORM the dealership received — it is not the customer speaking.",
    "  Its Name/Email/Phone/Source/Vehicle fields record how the lead ARRIVED. They are not requests,",
    "  and an email address in that block is NOT a stated contact preference. Treat channel as a",
    "  problem ONLY when the customer asked, in their own words, to be reached a different way.",
    "- When the customer asked to schedule, book, or test ride, OFFERING two concrete times is the",
    "  best possible reply — never fail it as pushy, and never steer a re-draft to replace concrete",
    "  times with a question about how or where to send times. Dropping a real time slot is a",
    "  regression, not a fix. (disposition_ok's \"don't pivot to scheduling\" is about a customer who",
    "  only wanted information — it does not apply to someone who asked for a booking.)",
    "- The same rule read the other way round: a reply to a booking / test-ride request that offers NO",
    "  time and instead asks WHICH CONTACT CHANNEL to use, or HOW or WHERE to send times, has answered",
    "  a question the customer never asked. Fail intent_ok -> \"needs_regenerate\", and steer it to offer",
    "  two concrete times. Deferring for a REAL reason is not this and is fine: checking whether the",
    "  unit is on the floor, out-of-hours, or handing to a person. Asking for their email or phone",
    "  instead of giving them a time is not a real reason.",
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
    '- customer: "WEB LEAD (ADF) Source: HD.com Online Test Ride Request Name: Ch Wan Email:',
    '  rider@example.com Phone: rider@example.com Year: 2026 Vehicle: Harley-Davidson Nightster"',
    '  | draft: "Hey — glad you got in touch. I can set up that Nightster test ride: are you',
    '  available today at 9:30 AM or 11:30 AM?" ->',
    '  {"intent_ok":true,"tone_ok":true,"disposition_ok":true,"safety_ok":true,"overall":"good","confidence":0.9,"reason":"they asked to book a test ride and the draft offers two concrete times; the email in the form block is how the lead arrived, not a stated contact preference","steering":""}',
    ...(facts
      ? [
          '- VERIFIED UNIT FACTS {"unit":"2026 Road Glide (Dark Billiard Gray Black Trim)","listPrice":29399}',
          '  | customer: "Looking for current rates and estimated payments" | draft: "Ballpark, on about',
          '  $25,999-$44,999, you\'re around $560-$1,020/mo at 60 months before taxes and fees." ->',
          '  {"intent_ok":true,"tone_ok":true,"disposition_ok":true,"safety_ok":false,"overall":"hold","confidence":0.95,"reason":"the unit is $29,399 but the draft quotes a $25,999-$44,999 spread and builds a payment range on it — those are other models\' prices","steering":"quote this unit at $29,399; do not give a payment range built on a swept price"}',
          '- VERIFIED UNIT FACTS {"unit":"2026 Road Glide (Dark Billiard Gray Black Trim)","listPrice":29399}',
          '  | customer: "what would my out the door be" | draft: "It\'s $29,399 before tax and fees — I\'d',
          '  need to run your exact out-the-door with the desk. Want me to?" ->',
          '  {"intent_ok":true,"tone_ok":true,"disposition_ok":true,"safety_ok":true,"overall":"good","confidence":0.9,"reason":"the price matches the feed and the out-the-door total is correctly deferred, not invented","steering":""}'
        ]
      : []),
    ...factLines,
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
