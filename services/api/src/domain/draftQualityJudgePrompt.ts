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

/** The parsed verdict for the schema below — the two belong together. */
export type DraftQualityJudgeParse = {
  // Per-axis pass flags for a customer-facing draft, judged against the customer's turn.
  intentOk: boolean; // does the draft actually ADDRESS what the customer asked?
  toneOk: boolean; // is it ON-VOICE (warm, human, not corporate; per the voice charter)?
  dispositionOk: boolean; // is it RIGHT FOR THE CUSTOMER'S STATE (empathy if stressed; not
  //                          pushy if not ready; not undercutting if committed)?
  safetyOk: boolean; // SAFE — no fabricated facts, no premature booking, no compliance issue?
  overall: "good" | "needs_regenerate" | "hold";
  confidence?: number;
  reason?: string;
  steering?: string; // hint to steer a re-draft when overall !== "good"
};

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

/**
 * What the LEAD RECORD says this person needs, for the turns where the "customer message" is a
 * structured web-lead form rather than someone typing.
 *
 * WHY (David Ventry `+17164233848`, 2026-08-13): his HDFS COA form landed on a thread we were
 * already mid-deal on. The agent drafted a generic "thanks for the credit application, are you
 * looking at…"; Scott deleted it and typed "I received your credit APPROVAL for the Fat Boy — did
 * you sell the Super Glide?". The pre-send judge passed the generic draft, and by its own rules it
 * was right to: the prompt tells it a form's fields "are NOT requests" (added to stop it inventing
 * an ask out of `Payment Status: Failed`), so `intent_ok` had nothing to grade and passed by
 * construction. Correct rule, missing second half.
 *
 * Measured 2026-08-14 over 30 days: web-lead forms are 15% of customer turns but 33% of the
 * wrong-intent corrections staff had to make by hand — the one inbound type where every net is
 * weakest at once.
 *
 * So this block does NOT reinstate "what did they ask". It supplies what a form DOES carry — the
 * record, and how far along the thread already is — and asks whether the reply fits it.
 */
export type DraftQualityLeadIntake = {
  /** Lead source as delivered, e.g. "HDFS COA Online" / "Traffic Log Pro" / "Riding Academy - Enrolled". */
  source?: string | null;
  /** Year + model off the lead record, e.g. "2005 Harley-Davidson Fat Boy". */
  vehicle?: string | null;
  /** The form's Inquiry body — machine-generated on most sources, occasionally real customer prose. */
  inquiry?: string | null;
  /** Customer-facing replies already sent on this thread. 0 => genuine first touch. */
  priorReplyCount?: number | null;
  /** Where the thread already stands, off the route state — e.g. "credit_app", "in_process_deal". */
  threadStage?: string | null;
};

/**
 * Is there enough record here for the judge to test the reply against? A form we know nothing about
 * beyond its existence gets the pre-2026-08-14 prompt, byte for byte — an empty record block would
 * only invite the judge to reason about facts it cannot see (the trap `hasCheckableUnitFacts`
 * already exists to avoid).
 */
export function hasUsableLeadIntakeRecord(rec: DraftQualityLeadIntake | null | undefined): boolean {
  if (!rec) return false;
  const has = (v: unknown) => String(v ?? "").trim().length > 0;
  const engaged = typeof rec.priorReplyCount === "number" && rec.priorReplyCount > 0;
  return has(rec.source) || has(rec.vehicle) || has(rec.inquiry) || has(rec.threadStage) || engaged;
}

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
  leadIntake?: DraftQualityLeadIntake | null;
}): string {
  const history = args.historyLines ?? [];
  const facts = hasCheckableUnitFacts(args.unitFacts) ? args.unitFacts! : null;
  const intake = hasUsableLeadIntakeRecord(args.leadIntake) ? args.leadIntake! : null;
  const engaged = typeof intake?.priorReplyCount === "number" && intake.priorReplyCount > 0;
  const intakeLines = intake
    ? [
        "",
        "LEAD RECORD — this turn's \"customer message\" is a WEB-LEAD FORM, not this person typing.",
        "The form's fields are still NOT requests (see the rule below). But the record and the thread",
        "DO say what this person needs, and that is what you judge the draft against here:",
        `  ${JSON.stringify({
          source: intake.source ?? null,
          vehicle: intake.vehicle ?? null,
          inquiry: String(intake.inquiry ?? "").slice(0, 400) || null,
          repliesAlreadySentOnThisThread: intake.priorReplyCount ?? 0,
          threadStage: intake.threadStage ?? null
        })}`,
        "- On these turns intent_ok asks: does the reply FIT THIS RECORD AND THIS THREAD? Not \"did it",
        "  answer a question\" — there is no question to answer.",
        ...(engaged
          ? [
              "- This thread is ALREADY ENGAGED (we have replied before). Treating a known customer like",
              "  a stranger is the single most common failure here. Fail intent_ok when the draft:",
              "    (a) ASKS FOR SOMETHING THE RECORD ALREADY ANSWERS — above all, asking which bike they",
              "        want, or offering to send options, when `vehicle` names the unit. This is the most",
              "        common shape and it is always a miss, however warm and fluent the wording.",
              "    (b) IGNORES `threadStage` — replying to a live credit application, in-process deal, or",
              "        booked appointment as though it were a brand-new inquiry.",
              "  A form arriving mid-deal is an UPDATE to a live conversation, not a fresh lead. Read",
              "  `threadStage` and the recent thread as the CURRENT state of that deal.",
              "  WORKED EXAMPLE — record {vehicle: \"2005 Fat Boy\", threadStage: \"credit_app\"}.",
              "    draft: \"Thanks for getting your credit application in! Are you looking at a specific",
              "    bike, or would you like me to send over some options?\" -> intent_ok FALSE: the record",
              "    already names the bike, and this answers a stranger, not a customer mid-application.",
              "    A reply that names the Fat Boy and moves the application forward -> intent_ok TRUE.",
              "- Two things are NOT failures here, and you must not fail intent_ok for them:",
              "    * naming a fact you cannot verify from this thread (a trade, a phone call, a promise —",
              "      reps know things the thread never recorded). Fail only if it CONTRADICTS the record.",
              "    * saying who you are. Re-introducing after a mass blast or a bare link is normal and",
              "      human; persona continuity is judged elsewhere, not here."
            ]
          : [
              "- This is a genuine FIRST TOUCH (no reply sent yet). An introduction is correct here.",
              "  Judge whether the reply uses what the record gives — the source and the vehicle — rather",
              "  than asking for something the form already told us."
            ]),
        "- Do NOT invent an ask out of a field. A form saying `Payment Status: Failed` is not the",
        "  customer asking about pricing, and a draft that does not \"answer\" it is not a miss.",
        "- Absence of a fact is never evidence the draft is wrong. Judge fit, not completeness."
      ]
    : [];
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
    ...intakeLines,
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
