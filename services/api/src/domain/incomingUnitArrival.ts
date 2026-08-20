/**
 * IS A BIKE ACTUALLY COMING IN? — the comprehension gate in front of the initial-ADF
 * pending-incoming-inventory branch.
 *
 * TRIGGER (Robert Myers +17163229218, agent-loop 2026-08-06). A Traffic Log Pro walk-in note in
 * the dealer's own words:
 *
 *   "Robert came in and really liked the pre-owned 2015 Dyna low rider WE HAVE IN STOCK. I looked
 *    at his trade and gave him out the door numbers. said he was going to look at the credit union
 *    first."
 *
 * produced the draft *"I have you down for the 2015 FXDL Dyna Low Rider WE'VE GOT COMING IN"*, plus
 * `dialogState: pending_incoming_inventory`, a manual handoff, a stopped cadence and an
 * arrival-notify task. He sat on that bike in the showroom; nothing was coming in.
 *
 * The mechanism: `hasPendingIncomingInventorySignal` is a keyword regex, and on the initial-ADF path
 * (`sendgridInbound.ts`) it is not a prefilter — it IS the decision. Its first alternative matched
 * three unrelated words inside a sliding window: "**came**" … "**in**" stock … his "**trade**".
 *
 * MIGRATE, not KEEP (AGENTS.md fail-direction test). Removing the regex's authority makes us fail
 * toward NOT arming the state and NOT telling a customer a bike is on its way — i.e. toward not
 * asserting and not doing the side effect. That is the safe side, so "is a unit arriving?" is
 * comprehension and belongs in a typed parser.
 *
 * SHAPE — the `hasPartsInquirySignal` pattern used elsewhere in this domain. The existing regex is
 * DEMOTED to a cheap prefilter (unchanged, so no note that is silent today ever starts reaching the
 * parser) and the parser makes the call. Net effect is strictly FEWER arms than today, never more:
 * every note that arms after this change also armed before it.
 *
 * Distinct from `parseIncomingInventoryPurposeWithLLM`, which asks WHY a unit is coming in and
 * presupposes that one is. This asks the prior question: is one coming in at all?
 */
import { requestStructuredJson } from "./llmDraft.js";

/**
 *  "arriving"     — a unit is NOT at the dealership yet and is expected (in transit, on order,
 *                   being brought in from another store/auction, a trade being taken in later).
 *  "already_here" — the unit the note is about is AT the dealership now (in stock, on the floor,
 *                   the customer looked at it). Robert Myers' note.
 *  "none"         — the text establishes no incoming unit at all.
 */
export type IncomingUnitArrivalParse = {
  status: "arriving" | "already_here" | "none";
  confidence?: number;
};

const INCOMING_UNIT_ARRIVAL_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["status", "confidence"],
  properties: {
    status: { type: "string", enum: ["arriving", "already_here", "none"] },
    confidence: { type: "number" }
  }
};

/** Confidence floor for accepting the arrival read (INCOMING_UNIT_ARRIVAL_CONFIDENCE_MIN, default 0.7). */
export function incomingUnitArrivalConfidenceFloor(): number {
  const v = Number(process.env.INCOMING_UNIT_ARRIVAL_CONFIDENCE_MIN);
  return Number.isFinite(v) && v > 0 ? v : 0.7;
}

export async function parseIncomingUnitArrivalWithLLM(args: {
  seedText: string;
}): Promise<IncomingUnitArrivalParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_INCOMING_UNIT_ARRIVAL_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const seedText = String(args.seedText ?? "").trim();
  if (!seedText) return null;

  const debug = process.env.LLM_INCOMING_UNIT_ARRIVAL_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_INCOMING_UNIT_ARRIVAL_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_INCOMING_UNIT_ARRIVAL_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");

  const prompt = [
    "You are reading a Harley-Davidson dealership's own intake note or web-lead text about ONE",
    "customer. Decide ONE thing: is the motorcycle this note is about NOT AT THE DEALERSHIP YET and",
    "expected to arrive? Return only JSON matching the provided schema.",
    "",
    "status:",
    '- "arriving": the bike is not here yet and is expected — in transit, on order from the factory,',
    "  being brought in from an auction or another store, or a trade the dealer will take in later.",
    '- "already_here": the bike the note is about is AT the dealership now — in stock, on the floor,',
    "  on the lot, the customer came in and looked at it or sat on it, we have it.",
    '- "none": the note establishes no incoming unit at all — a question, a price/finance discussion,',
    "  a service visit, a general shopper with no specific unit on its way.",
    "",
    "Hard rules:",
    "- A customer COMING IN to the store is not a BIKE coming in. Staff notes are written about",
    "  people visiting; read what the BIKE is doing, not what the person did.",
    "- Words like 'trade', 'used', 'pre-owned' say nothing about arrival on their own. A trade the",
    "  dealer already appraised in person is not an arriving unit.",
    '- "we have in stock" / "on our floor" / "he sat on it" / "took it for a demo ride" =>',
    '  "already_here", even if the same sentence also mentions a trade.',
    "- When you cannot tell whether a unit is on its way, answer \"none\" — a wrong \"arriving\" makes us",
    "  tell a customer their bike is en route when it is already on the floor, or does not exist.",
    "- confidence 0..1; use >= 0.7 only when the read is clear.",
    "",
    "Examples:",
    '- "Robert came in and really liked the pre-owned 2015 Dyna low rider we have in stock. I looked at his trade and gave him out the door numbers." -> {"status":"already_here","confidence":0.95}',
    '- "Interested in 2016 Freewheeler we are taking in on trade." -> {"status":"arriving","confidence":0.9}',
    '- "We have a 2015 Road King coming in from the auction for him to look at." -> {"status":"arriving","confidence":0.93}',
    '- "New 2026 Street Glide on order from the factory for this customer, projected ship date 8/21." -> {"status":"arriving","confidence":0.94}',
    '- "Told him the next one we have coming in is spoken for; he is on the list for the following one." -> {"status":"arriving","confidence":0.9}',
    '- "Customer test rode the Low Rider S on the lot today, wants payment options." -> {"status":"already_here","confidence":0.93}',
    '- "Came in for service on his 2019 Street Glide, asked about trade values while he waited." -> {"status":"none","confidence":0.85}',
    '- "Wants pricing on a 2024 Road Glide." -> {"status":"none","confidence":0.9}',
    "",
    `Note:\n${seedText.slice(0, 1200)}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "incoming_unit_arrival_parser",
      schema: INCOMING_UNIT_ARRIVAL_PARSER_JSON_SCHEMA,
      maxOutputTokens: 60,
      debugTag: "llm-incoming-unit-arrival-parser",
      debug
    });

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const raw = String(parsed.status ?? "").toLowerCase();
  const status: IncomingUnitArrivalParse["status"] =
    raw === "arriving" || raw === "already_here" ? raw : "none";
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;
  return { status, confidence };
}

/**
 * Should the initial-ADF branch arm `pendingIncomingInventory` (and with it the manual handoff, the
 * stopped cadence, the arrival-notify task and the "we've got coming in" customer draft)?
 *
 * PURE. The regex prefilter is necessary but no longer sufficient — a confident comprehended
 * "arriving" is required on top of it.
 *
 * FAIL DIRECTION, deliberately: anything other than a confident "arriving" declines. That includes
 * the parser being unavailable (LLM off, no key, both models failed) and a hedged read below the
 * floor. Declining means the lead falls through to the ordinary ADF handling — a generic ack and no
 * handoff, which is a miss staff can recover. Arming wrongly asserts to the customer that a bike is
 * on its way, stops the cadence and hands the thread off, which nothing downstream corrects.
 */
export function decideInitialAdfPendingIncomingArm(args: {
  /** `hasPendingIncomingInventorySignal` over the ADF source text — the cheap prefilter. */
  prefilterSignal: boolean;
  /** `parseIncomingUnitArrivalWithLLM` result; null when the parser did not run or failed. */
  parse: IncomingUnitArrivalParse | null | undefined;
  /** `incomingUnitArrivalConfidenceFloor()`. */
  confidenceFloor: number;
}): { arm: boolean; reason: string } {
  if (!args.prefilterSignal) return { arm: false, reason: "no_prefilter_signal" };
  if (!args.parse) return { arm: false, reason: "arrival_parse_unavailable" };
  if (args.parse.status !== "arriving") return { arm: false, reason: `arrival_${args.parse.status}` };
  const confidence = typeof args.parse.confidence === "number" ? args.parse.confidence : 0;
  if (confidence < args.confidenceFloor) return { arm: false, reason: "arrival_below_confidence_floor" };
  return { arm: true, reason: "arrival_comprehended" };
}

/**
 * ── THE SECOND DOOR (Joe, 2026-08-19, Zackary Busch +17162489119) ───────────────────────────────
 *
 * The Robert Myers gate above gets asked on the initial-ADF branch only. Zack came in through the
 * OTHER one, and it had no gate at all.
 *
 * His Traffic Log Pro note, in the dealer's own words: *"I showed him the 2008 FLHTCU that i just
 * took in on trade. I told him we are going to get it through the service department to get
 * serviced before it is ready to sell and we are waiting for the title."* The bike is on the
 * property. Nothing is coming in.
 *
 * Two minutes later staff texted "I'll get a hold of you when that 08 Ultra is ready to look at",
 * Zack answered "Perfect, thank you. I'll be waiting", and the inbound-reply parser read THAT
 * exchange as a pending-incoming-inventory acknowledgement at 0.96. It was not wrong about the
 * exchange — a promise plus a thank-you reads the same whether the bike is on a truck or on a lift.
 * It simply never saw the note. The result: `dialogState: pending_incoming_inventory`, the cadence
 * stopped, a manual handoff, a task reading "notify when the 2008 Flhtcu ARRIVES", and a draft
 * telling the customer about "the 2008 Flhtcu we've got coming in … as soon as it's here".
 *
 * ⚠️ MEASURED, AND IT KILLED THE OBVIOUS FIX. The plan was "run the existing arrival parser on the
 * same seed the ADF path uses". Executed against Zack's real record, that seed — which is
 * `[effectiveInquiry, lead.inquiry, comment, inquiryRaw, event.body].join("\n")`, i.e. the prose
 * wrapped in the raw `PHONE LOG (ADF) … Year: 2008 / Vehicle: Flhtcu` header — is UNSTABLE:
 *
 *     full ADF block   arriving, already_here, already_here, already_here, already_here, arriving
 *                      -> 2 of 6 wrong
 *     inquiry prose    already_here x10, confidence 0.85-0.90
 *                      -> 0 of 10 wrong
 *
 * The comprehension was never the problem; the SEED was. `Year: 2008 / Vehicle: Flhtcu` reads like
 * an inbound-unit spec and drags the answer toward "arriving". So this gate is seeded with the
 * establishing PROSE and nothing else. (The ADF path still uses the noisy seed — that is a separate,
 * measured finding, deliberately not changed here.)
 *
 * FAIL DIRECTION, and why this can only ever arm LESS: today this arm has no gate, so every
 * acknowledgement arms. This blocks ONLY on a confident `already_here`. Parser off, no key, a throw,
 * `arriving`, `none`, a hedged read below the floor, or no establishing note at all — every one of
 * those keeps today's exact behaviour. Blocking wrongly costs a lead the incoming-unit framing that
 * staff can re-add; arming wrongly tells a customer a bike he has already stood next to is on its
 * way, stops his cadence and hands the thread off, which nothing downstream corrects.
 */
export function decideEstablishedStockBlocksArm(args: {
  parse: IncomingUnitArrivalParse | null | undefined;
  confidenceFloor: number;
}): { block: boolean; reason: string } {
  if (!args.parse) return { block: false, reason: "arrival_parse_unavailable" };
  if (args.parse.status !== "already_here") return { block: false, reason: `arrival_${args.parse.status}` };
  const confidence = typeof args.parse.confidence === "number" ? args.parse.confidence : 0;
  if (confidence < args.confidenceFloor) return { block: false, reason: "already_here_below_floor" };
  return { block: true, reason: "established_stock_comprehended" };
}

/**
 * The establishing PROSE for a lead — the staff note or customer inquiry that says what this thread
 * is actually about — with the ADF field header deliberately left out (see the measurement above).
 * Structured extraction of our OWN record, not comprehension: it only picks a field.
 */
export function establishingNoteForArrivalCheck(conv: any): string {
  for (const candidate of [conv?.lead?.inquiry, conv?.lead?.comment, conv?.lead?.notes]) {
    const text = String(candidate ?? "").trim();
    if (text) return text;
  }
  return "";
}

/**
 * Is this acknowledgement about a unit the lead's own note says is already on the property?
 * Resolves to false on every uncertainty, including a parser throw — see the fail direction above.
 */
export async function pendingIncomingArmBlockedByEstablishedStock(
  conv: any
): Promise<{ block: boolean; reason: string }> {
  const seedText = establishingNoteForArrivalCheck(conv);
  if (!seedText) return { block: false, reason: "no_establishing_note" };
  let parse: IncomingUnitArrivalParse | null = null;
  try {
    parse = await parseIncomingUnitArrivalWithLLM({ seedText });
  } catch {
    parse = null;
  }
  return decideEstablishedStockBlocksArm({ parse, confidenceFloor: incomingUnitArrivalConfidenceFloor() });
}
