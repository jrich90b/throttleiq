/**
 * Visit-commitment parser — the tiebreaker for the soft-visit arm.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────────
 * The soft-visit arm fires on `detectSoftVisitIntent` (a legacy keyword rule) OR'd with
 * `isParserSoftVisitCommitment`. MEASURED 2026-08-14 over all 1,910 inbound turns in 90 days on
 * the live store: the keyword rule fires 45 times and the parser signal agrees on only 5. So the
 * keyword rule is CARRYING the arm, not backstopping it — and on the turns where they disagree
 * nothing comprehended the sentence at all.
 *
 * That is what AGENTS.md "Fallback-vs-Parser Precedence" (Joe, 2026-08-06) forbids: *a fallback
 * may not overrule a parser verdict that exists.* Michelle Hyjek `+17163164854`, 2026-08-08
 * 17:33Z, is the instance Joe reported ("This looks like a another lead got tied to this lead"):
 *
 *     "No I am out of town for my nieces wedding I come back Monday"
 *
 * The appointment-timing parser read her correctly 6/6 on current main — intent `none`,
 * normalizedText "out of town, returning Monday", confidence 0.86-0.92 — and the day-anchored
 * signal correctly declined. The keyword rule saw `come` + `monday` and armed a soft-visit
 * window anyway: a cadence quiet-window, a dialog state, and a staff task asserting *"they said
 * they'd come in Aug 10."* She had said she would be OUT OF TOWN until then.
 *
 * ── WHY A SEPARATE PARSER, AND WHY IT IS NOT A ROUND-TRIP TAX ─────────────────────────────────
 * It would be wrong to simply delete the keyword rule: on the same measurement it is the only
 * thing catching ~40 real commitments per 90 days that the day-anchored verb list misses
 * ("I'll come this weekend", "I will have to come Friday", "going to stop up there tomorrow").
 * It would also be disproportionate to bolt a new required field onto the booking-critical
 * appointment-timing parser and rewrite its twenty few-shots to fix a rare miss.
 *
 * So this parser answers ONE question and runs ONLY on the disputed turns — where the keyword
 * rule fires and the parser signal did not. That is the 40-in-90-days population: roughly one
 * call every other day, not one per turn. Everything else short-circuits before it.
 *
 * ── FAIL DIRECTION ────────────────────────────────────────────────────────────────────────────
 * Only an explicit, confident `no` suppresses the arm. Disabled LLM, no key, an error, a low
 * confidence or `unclear` all resolve to TODAY'S BEHAVIOUR (the keyword rule stands). So this can
 * only ever remove a soft-visit hold we were confident is wrong; it can never introduce a new
 * silence, and it degrades to the current system in every failure mode.
 */
import { z } from "zod";
import type { AppointmentTimingParse } from "./llmDraft.js";
import {
  needsVisitCommitmentTiebreak,
  resolveSoftVisitCommitment,
  type SoftVisitDecision
} from "./softVisitSignal.js";

export const VisitCommitmentSchema = z.object({
  visit_commitment: z
    .enum(["yes", "no", "unclear"])
    .describe(
      'Is the customer saying they will COME TO THE DEALERSHIP in person? "yes": they commit or ' +
        'intend to come here ("I\'ll come this weekend", "going to stop up tomorrow", "I will ' +
        'have to come Friday"). "no": the day/travel they mention is about something else — ' +
        "their own whereabouts or travel (out of town, on vacation, at a wedding, returning " +
        "home), someone else's movement, a part or bike arriving, or a call/text they will make. " +
        '"unclear": you cannot tell.'
    ),
  day: z
    .string()
    .describe(
      'The day the customer named for coming in, lowercased and bare: "friday", "saturday", ' +
        '"today", "tomorrow", "august 9". Empty string when they named no day, or when ' +
        'visit_commitment is not "yes". Never a time of day — "friday afternoon" is "friday".'
    ),
  confidence: z.number().min(0).max(1)
});

export type VisitCommitmentParse = z.infer<typeof VisitCommitmentSchema>;

/**
 * Strip the JSON-schema keywords OpenAI strict mode rejects (Zod emits `oneOf` for unions, which
 * the API refuses outright and requestStructuredJson turns into null — a parser that looks merely
 * unsure while never having run). Mirrors `salesHandoffReadiness.toStrictSchema`.
 */
function toStrictSchema(schema: unknown): { [key: string]: unknown } {
  const walk = (node: any): any => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: any = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$schema") continue;
      out[k === "oneOf" ? "anyOf" : k] = walk(v);
    }
    return out;
  };
  return walk(schema) as { [key: string]: unknown };
}

export function visitCommitmentJsonSchema(): { [key: string]: unknown } {
  return toStrictSchema(z.toJSONSchema(VisitCommitmentSchema, { target: "draft-7" }));
}

/**
 * The floor a `no` must clear before it is allowed to overrule the keyword rule. Deliberately
 * high: suppressing the arm removes a cadence HOLD, so an unsure `no` must fail toward today's
 * behaviour rather than toward messaging someone who told us they are away.
 */
export function visitCommitmentConfidenceMin(): number {
  const raw = Number(process.env.LLM_VISIT_COMMITMENT_CONFIDENCE_MIN);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.75;
}

/**
 * Reads whether this turn commits the customer to coming to the dealership.
 * HISTORY MATTERS: "I come back Monday" only resolves against the fact that we had just asked
 * whether she was with Dave, and that she had said she was away.
 */
export async function parseVisitCommitmentWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
}): Promise<VisitCommitmentParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_VISIT_COMMITMENT_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const { requestStructuredJson } = await import("./llmDraft.js");
  const primaryModel =
    process.env.OPENAI_VISIT_COMMITMENT_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_VISIT_COMMITMENT_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const history = (args.history ?? []).slice(-6).map(h => `${h.direction}: ${h.body}`);
  const prompt = [
    "You read SMS in a Harley dealership thread and answer ONE question: is the customer saying",
    "they will COME TO THE DEALERSHIP in person? Return only JSON matching the schema.",
    "",
    "A day or a travel word is NOT by itself a visit. People mention days for all sorts of",
    "reasons: their own trips, when a part is expected, when someone else is free, when they will",
    'call. "Coming back" from somewhere means returning HOME, not coming to us, unless the thread',
    "makes the dealership the destination.",
    "",
    'Answer "no" when the day belongs to something other than a visit here. Answer "unclear" when',
    "you genuinely cannot tell — do not guess either way.",
    "",
    "A BARE DAY IS AN ANSWER TO WHATEVER WE JUST ASKED. When our last message invited them to come",
    'in, a reply that is only a day or a daypart ("Friday. Afternoon", "Saturday", "Thursday is',
    'fine") IS a visit commitment — the verb is in our question, not in their reply. When our last',
    "message asked about something else — when to CALL them, when a payment lands, when a part is",
    "due — the same bare day is not a visit.",
    "",
    "Examples:",
    'input: "No I am out of town for my nieces wedding I come back Monday" output: {"visit_commitment":"no","day":"","confidence":0.95}',
    'input: "I\'ll come this weekend" output: {"visit_commitment":"yes","day":"this weekend","confidence":0.93}',
    'input: "I will have to come Friday" output: {"visit_commitment":"yes","day":"friday","confidence":0.9}',
    'input: "I\'m going to stop up there tomorrow, thank you" output: {"visit_commitment":"yes","day":"tomorrow","confidence":0.94}',
    'input: "Ok..Hopefully get lucky and they come tomorrow" history: "out: your parts are on order" output: {"visit_commitment":"no","day":"","confidence":0.9}',
    'input: "Ok I will be there for the taste of country pre party on Saturday" output: {"visit_commitment":"yes","day":"saturday","confidence":0.94}',
    'input: "I\'ll be in touch Monday" output: {"visit_commitment":"no","day":"","confidence":0.88}',
    // A phone-menu recording or a web-form payload is a MACHINE RECORD, not something a customer
    // said (AGENTS.md: "a keyword rule written for customer prose must not run against a machine
    // record"). Measured 2026-08-14: without this example these read "unclear" 4 runs in 5.
    // Dealer-AGNOSTIC on purpose: the portability ratchet counts dealer literals in
    // services/api/src, and the first draft of this example pasted the real store name straight
    // out of the transcript, taking the count 133 -> 134 and breaking the readiness bar's
    // portability section. A machine record is recognisable by its SHAPE, not by whose name is on it.
    'input: "Agent: Thank you for calling the dealership. If you know your party\'s extension, you may enter it at any time." output: {"visit_commitment":"no","day":"","confidence":0.92}',
    'input: "WEB TEXT WIDGET Department: Motor Clothes Name: Dennis Dashnaw Page: Events" output: {"visit_commitment":"no","day":"","confidence":0.9}',
    'input: "Thanks Scott. Enjoyed the ride home..hoping to put some miles on the Deadwood nxt week" output: {"visit_commitment":"no","day":"","confidence":0.9}',
    // BARE-DAY ACCEPTANCES of our own visit invitation. Both the message AND its history below are
    // verbatim store rows. The third is the deliberate contrast, and it is why this needs a parser
    // and not a rule: "I will by Saturday" LOOKS like the strongest commitment of the three and is
    // a promise to make a DOWN PAYMENT, because the question it answered was about money.
    //
    // WHAT THESE ACTUALLY BUY — ablated and measured 2026-08-15, because the first draft of this
    // comment claimed credit they had not earned. Mohamed Ahmed's "Ok. Friday. Afternoon"
    // (+17164258647, answering "the Deadwood just arrived ... if you want to stop by") read
    // `unclear` at 0.45, 4 runs in 4 — but that was against the parser BEFORE the `day` field
    // existed, and adding `day` to the schema is what actually flipped it. With the schema change
    // and WITHOUT this rule and these examples the turn arms 2/5: right but unstable. With them it
    // is 5/5 across three separate 5-run blocks. All seven other cases (two more positives, four
    // negatives) read identically either way. So these are a STABILITY measure on one shape, not
    // the fix — and at 2/5 the eval's decision vote cannot reliably detect their removal, so the
    // source pins in `human_mode_visit_commitment:eval` are the structural guard and this comment
    // is the record.
    'input: "Ok. Friday. Afternoon" history: "out: just wanted to let you know the Deadwood just arrived here at the dealership if you want to stop by and take a look at it" output: {"visit_commitment":"yes","day":"friday","confidence":0.9}',
    'input: "Thursday is fine" history: "out: I am off tomorrow so we would have to do it either Thursday or Friday if that works for your schedule" output: {"visit_commitment":"yes","day":"thursday","confidence":0.9}',
    'input: "I will by Saturday" history: "out: Are you able to make the remaining down payment over the phone?" output: {"visit_commitment":"no","day":"","confidence":0.88}',
    "",
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "visit_commitment_parser",
      schema: visitCommitmentJsonSchema(),
      maxOutputTokens: 80,
      debugTag: "llm-visit-commitment-parser",
      debug: process.env.LLM_VISIT_COMMITMENT_PARSER_DEBUG === "1"
    });

  const raw =
    (await runParse(primaryModel)) ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!raw) return null;
  const result = VisitCommitmentSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * The ONE call both `/webhooks/twilio` and `/conversations/:id/regenerate` make to decide whether
 * a turn arms the soft-visit window. Lives here rather than in `softVisitSignal.ts` so that module
 * stays pure and LLM-free (its referee is unit-testable without a client), and rather than inline
 * in `index.ts` so the two paths cannot drift apart again.
 *
 * The tiebreak parse is issued ONLY when the keyword rule would otherwise decide alone — measured
 * at ~40 turns per 90 days, about one call every other day. Any parser failure is swallowed and
 * resolves to today's behaviour; this can never block a turn.
 */
export async function resolveSoftVisitTurn(args: {
  legacySignal: boolean;
  parse: AppointmentTimingParse | null | undefined;
  conditionalAllowed?: boolean;
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
}): Promise<SoftVisitDecision> {
  const gate = {
    legacySignal: args.legacySignal,
    parse: args.parse,
    conditionalAllowed: args.conditionalAllowed
  };
  let visitCommitment: VisitCommitmentParse | null = null;
  if (needsVisitCommitmentTiebreak(gate)) {
    try {
      visitCommitment = await parseVisitCommitmentWithLLM({ text: args.text, history: args.history });
    } catch {
      visitCommitment = null; // a failed tiebreak leaves the legacy signal standing (today's behaviour)
    }
  }
  return resolveSoftVisitCommitment({ ...gate, visitCommitment });
}

/**
 * ── HUMAN-MODE VISIT COMMITMENT ───────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS. On a thread a rep has taken over (`conv.mode === "human"`) the webhook handles
 * the turn in its own block and returns long before the scheduling arms — so when the CUSTOMER
 * names a day to come in, nothing records it. Operator report on Mohamed Ahmed `+17164258647`
 * (2026-08-12 21:33Z, "Ok. Friday. Afternoon" answering "the Deadwood just arrived ... if you want
 * to stop by"): *"should there have been a soft appointment made for this with an outcome?"* Yes —
 * `conv.appointment` was null, no soft-visit window, no task, and no outcome to grade. MEASURED
 * 2026-08-15 on the live store: 178 of 860 conversations are human-mode and carry 66 inbound turns
 * in 90 days that name a day without a clock time; NOT ONE produced a soft-appointment task.
 * That is a structural hole in the booked-rate the readiness bar grades, not a one-off.
 *
 * WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT. It mints the SAME dated staff task the agent
 * lane already mints (`addSoftVisitStaffTask`) and nothing else: no reply, no draft, no cadence
 * window, no dialog state, no appointment. A rep owns this thread, so the conversation stays
 * theirs — this only makes the visit visible. Same shape as the sell-to-dealer appraisal task that
 * already fires in this block ("the owner gets the task here too; the reply stays hands-off").
 *
 * FAIL DIRECTION. A miss is exactly today's behaviour (nothing recorded). An over-fire is one
 * extra staff task on a thread a human is already reading — the cheapest wrong answer available,
 * and the reason this is safe to run without a reply gate.
 *
 * WHY A PARSER AND NOT A RULE. The commitment is in OUR question, not their words: "Ok. Friday.
 * Afternoon" carries no verb at all. And the inverse is just as common — measured on the same
 * store, "I will by Saturday" reads like the strongest commitment of the set and is a promise to
 * make a DOWN PAYMENT, because the question it answered was about money. No keyword rule can tell
 * those apart; the parser reads both correctly (4/4 each, 2026-08-15).
 */
export type HumanModeVisitCommitmentDecision = {
  task: boolean;
  dayLabel: string | null;
  reason:
    | "not_human_mode"
    | "thread_closed"
    | "no_day_hint"
    | "commitment_not_confirmed"
    | "no_day_named"
    | "already_tasked"
    | "task";
};

/**
 * Deterministic ELIGIBILITY only (AGENTS.md: hint gates are the allowed deterministic bucket) —
 * does the raw inbound even mention a day? Comprehension stays with the parser below. Fail
 * direction: a hint miss = today's behaviour (parser not consulted); an over-trigger costs one
 * parser call on a turn that resolves to nothing. Measured: 66 turns / 90 days = 0.73 calls a day.
 */
export function hasVisitDayHintText(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return /\b(?:mon|tues?|wednes|thurs?|fri|satur|sun)day\b|\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b|\btoday\b|\btomorrow\b|\bthis weekend\b|\bweekend\b/.test(
    t
  );
}

/**
 * The pure decision. Kept free of any LLM call so the eval can drive it directly.
 * `alreadyTasked` is the caller's read of whether this thread already carries a soft-appointment
 * task for the same day — re-minting one on every follow-up turn would bury the rep in duplicates.
 */
export function decideHumanModeVisitCommitmentTask(input: {
  humanMode: boolean;
  threadClosed: boolean;
  dayHint: boolean;
  visitCommitment: VisitCommitmentParse | null | undefined;
  alreadyTasked: boolean;
  confidenceMin?: number;
}): HumanModeVisitCommitmentDecision {
  if (!input.humanMode) return { task: false, dayLabel: null, reason: "not_human_mode" };
  if (input.threadClosed) return { task: false, dayLabel: null, reason: "thread_closed" };
  if (!input.dayHint) return { task: false, dayLabel: null, reason: "no_day_hint" };
  const min = input.confidenceMin ?? visitCommitmentConfidenceMin();
  const parse = input.visitCommitment;
  // Only a CONFIDENT yes mints anything: null (LLM off, no key, an error), "unclear" and "no" all
  // resolve to today's behaviour. This can never introduce a message; it can only add a task.
  if (!parse || parse.visit_commitment !== "yes" || (parse.confidence ?? 0) < min) {
    return { task: false, dayLabel: null, reason: "commitment_not_confirmed" };
  }
  const dayLabel = String(parse.day ?? "").trim().toLowerCase();
  if (!dayLabel) return { task: false, dayLabel: null, reason: "no_day_named" };
  if (input.alreadyTasked) return { task: false, dayLabel, reason: "already_tasked" };
  return { task: true, dayLabel, reason: "task" };
}

/**
 * The ONE call the human-mode branch of `/webhooks/twilio` makes. The parser runs only after the
 * cheap gates pass, so a thread that is not human-mode, is closed, or names no day never pays for
 * it. Any parser failure is swallowed and resolves to today's behaviour.
 */
export async function resolveHumanModeVisitCommitmentTask(args: {
  humanMode: boolean;
  threadClosed: boolean;
  alreadyTasked: boolean;
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
}): Promise<HumanModeVisitCommitmentDecision> {
  const gate = {
    humanMode: args.humanMode,
    threadClosed: args.threadClosed,
    dayHint: hasVisitDayHintText(args.text),
    alreadyTasked: args.alreadyTasked
  };
  const preflight = decideHumanModeVisitCommitmentTask({ ...gate, visitCommitment: null });
  // Anything that already fails WITHOUT a parse and not merely for want of one stays unparsed.
  if (!preflight.task && preflight.reason !== "commitment_not_confirmed") return preflight;
  let visitCommitment: VisitCommitmentParse | null = null;
  try {
    visitCommitment = await parseVisitCommitmentWithLLM({ text: args.text, history: args.history });
  } catch {
    visitCommitment = null; // a failed parse leaves today's behaviour (no task) standing
  }
  return decideHumanModeVisitCommitmentTask({ ...gate, visitCommitment });
}
