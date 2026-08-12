import type { DeptWidgetBikeInterestParse } from "./llmDraft.js";

/**
 * Dept-widget "did you mean the bike or the department?" clarify (Joe ruling 2026-07-26 #4).
 *
 * A web-text-widget lead can arrive tagged to a NON-SALES department (Motor Clothes / Parts /
 * Service) yet actually be asking about a MOTORCYCLE — James Brown (+15415147201) came through the
 * "Motor Clothes" widget with "Checking out Pan America HD". The old first-touch gave the pure
 * apparel handoff ack (staying apparel-only, ignoring the bike) and a later draft pivoted straight
 * to sales ("are you looking at the 1250 or the Special?"). Joe ruled: don't assume — CLARIFY which
 * side they want, and let staff route.
 *
 * This module is the PURE, deterministic decision + the approved clarify template. The comprehension
 * (is this message actually about a motorcycle?) is owned by the typed parser
 * classifyDeptWidgetBikeInterestWithLLM (llmDraft.ts) — never regex. hasDeptWidgetBikeHint is only a
 * cheap COST gate (skip the parser call when there is obviously no bike token); the parser owns the
 * verdict, so over-matching just costs one parser call and under-matching is the only thing to keep
 * rare.
 *
 * Fail direction: this only ever swaps the DRAFT wording of a suggest-mode ack. It never sends,
 * never closes, never skips the department task/handoff — a false positive is a slightly-off clarify
 * draft staff can edit; a false negative falls back to the existing plain dept ack (status quo).
 * Pinned by scripts/dept_widget_bike_clarify_eval.ts (ci:eval).
 */

/** Minimum parser confidence before we swap the plain dept ack for a clarify. */
export const DEPT_WIDGET_BIKE_CLARIFY_CONFIDENCE_MIN = 0.6;

/**
 * The parser's strict-structured-output schema. It lives HERE, next to the decision it gates (the
 * walkInInventoryWant.ts precedent), so the prompt surface can be edited without spending
 * llmDraft.ts's size budget. classifyDeptWidgetBikeInterestWithLLM imports both.
 */
export const DEPT_WIDGET_BIKE_INTEREST_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["asksAboutMotorcycle", "motorcycleReference", "confidence"],
  properties: {
    asksAboutMotorcycle: { type: "boolean" },
    motorcycleReference: { type: ["string", "null"] },
    confidence: { type: "number" }
  }
};

/**
 * The parser prompt.
 *
 * OWNED-UNIT RULE (Joe report 2026-08-12, Michael McGary +17165502654). He came through the
 * SERVICE widget with "Can I ask what is going on with my 2026 street glide?" and got the
 * sales-vs-service clarify — Joe: "This is a service widget. It implies his bike is in service and
 * wants an update." The prompt had no rule for a customer asking about a bike he ALREADY OWNS, so
 * the model had to guess and guessed differently run to run: MEASURED 2 of 10 runs on his exact
 * text returned asksAboutMotorcycle=true (-> clarify), 8 returned false (-> plain dept ack). This
 * was never a wrong rule, it was a MISSING one, and the symptom was instability.
 *
 * The possessive is the tell the rules already used on the apparel side ("gloves for my Street
 * Glide" is apparel, not shopping); it just was not stated for a STATUS question about the unit
 * itself. A customer asking after a bike they own, bought or ordered is not shopping — they need
 * the department, which is exactly what the human did on this thread ("I'll have the American H-D
 * service team text you with an update on your 2026 Street Glide").
 *
 * Fail direction is unchanged and safe: false -> the plain dept ack + the department task/handoff
 * (the status quo path), never a send, a close, or a skipped handoff.
 */
export function buildDeptWidgetBikeInterestPrompt(args: { message: string; deptLabel: string }): string {
  const message = String(args.message ?? "").trim();
  const deptLabel = String(args.deptLabel ?? "team").trim() || "team";
  return [
    "You classify one inbound message from a customer who reached a Harley-Davidson dealership",
    `through the "${deptLabel}" web widget (a NON-SALES department: apparel/MotorClothes, parts, or service).`,
    "Decide whether the customer's message is actually about a MOTORCYCLE (a bike model, buying/",
    "looking at a bike, availability, a test ride, pricing on a unit) rather than the department the",
    "widget is for.",
    "",
    "RULES:",
    '- asksAboutMotorcycle=true ONLY when the message references an actual motorcycle interest',
    '  (a bike model like "Pan America"/"Street Glide", "looking at bikes", "test ride", "buy a bike").',
    "- A request that fits the department itself (gear/clothing/helmet for apparel; a part/accessory",
    "  for parts; a repair/oil change/inspection for service) is NOT a motorcycle-buying interest →",
    "  asksAboutMotorcycle=false, even if a bike model is named only as the bike the gear/part is FOR",
    '  (e.g. "gloves for my Street Glide" is apparel, not motorcycle interest).',
    "- A customer asking about a unit they ALREADY OWN, already bought, or already have on order —",
    "  a STATUS or update question about that bike — is NOT motorcycle-buying interest →",
    "  asksAboutMotorcycle=false. The tell is a possessive plus a status question rather than a",
    '  shopping question: "what is going on with my 2026 Street Glide?", "any update on my bike?",',
    '  "when will my order be in?", "is my Road King done yet?". They are not shopping; they need',
    "  this department. Only flip to true if they ALSO ask about a DIFFERENT bike they might buy",
    '  (e.g. "while my Road King is in, do you have a Low Rider ST I could look at?").',
    "- motorcycleReference = the bike the customer named (verbatim-ish), or null if none.",
    "- confidence in [0,1].",
    "",
    "EXAMPLES:",
    '- "Checking out Pan America HD" (Motor Clothes) → asksAboutMotorcycle=true, reference "Pan America".',
    '- "Do you have XL riding gloves for my Street Glide" (Motor Clothes) → false, reference "Street Glide".',
    '- "Can I ask what is going on with my 2026 street glide?" (Service) → false, reference',
    '  "2026 street glide" (he owns it; this is a service-status question).',
    '- "Any update on my bike? Dropped it off last week" (Service) → false, reference null.',
    '- "While my Road King is in for service, do you have a Low Rider ST on the floor?" (Service) →',
    '  true, reference "Low Rider ST" (he asks about a DIFFERENT bike he might buy).',
    "",
    `Message: ${message}`,
    "",
    'Return only JSON: { "asksAboutMotorcycle": <bool>, "motorcycleReference": <string|null>, "confidence": <0..1> }'
  ].join("\n");
}

/**
 * Cheap cost hint (NOT comprehension — the parser owns the verdict): a bike-ish token that makes it
 * worth spending one parser call. Deliberately broad; a false hit costs one parser call that then
 * returns asksAboutMotorcycle=false and nothing changes.
 */
export function hasDeptWidgetBikeHint(message: string): boolean {
  const t = String(message ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\b(bike|motorcycle|motorbike|test\s*ride|trade\s*in|financ|road\s*glide|street\s*glide|pan\s*america|sportster|softail|fat\s*boy|fatboy|breakout|low\s*rider|lowrider|nightster|heritage|ultra|electra|freewheeler|tri\s*glide|road\s*king|cvo|lineup|in\s*stock|test\s*drive)\b/.test(
      t
    ) ||
    /\b(19|20)\d{2}\b/.test(t) // a model year
  );
}

/** Approved clarify template — offers BOTH the bike (sales) side and the department side, never
 * assumes, never fabricates price/availability, never promises a reply time. */
export function buildDeptBikeClarifyReply(args: {
  firstName?: string | null;
  deptLabel?: string | null;
  motorcycleReference?: string | null;
}): string {
  const firstName = String(args.firstName ?? "").trim();
  const deptLabel = String(args.deptLabel ?? "").trim() || "that team";
  const ref = String(args.motorcycleReference ?? "").trim();
  const bikePhrase = ref ? `the ${ref}` : "a motorcycle";
  const greeting = firstName ? `Hi ${firstName}` : "Hi there";
  return (
    `${greeting} — thanks for reaching out! Just to point you to the right person: are you looking for ` +
    `info on ${bikePhrase} itself (our sales team can help with that), or ${deptLabel} gear/support for it? ` +
    `Happy to get you to the right team either way.`
  );
}

/**
 * Approved ACQUISITION reply (the Lynn Kraus class, +17164785613, corpus sweep 2026-07-28): a
 * dept-widget lead whose message is a clear sell-to-dealer ask ("Do you guys buy motorcycles? I have
 * a '17 Road King Special … looking to sell") must be ANSWERED, not clarified — see
 * decideDeptWidgetIntakeTurn in routeStateReducer.
 *
 * Hard constraints baked into the wording (eval-pinned):
 * - Confirms we DO buy bikes (that was the literal question) but never promises we WILL buy THIS one
 *   — inventory levels are a human call (Joe's own reply hedged: "a little heavy on pre-owned").
 * - Never quotes or estimates a number: no offer, no range, no "worth". We have no appraisal yet.
 * - Never promises a reply time (widget forms arrive after hours / on holidays).
 * - Moves to the one real next step, the in-person appraisal, and asks for the details the appraisal
 *   needs — mirroring the established trade_cash copy so the voice matches the rest of the lane.
 */
export function buildDeptWidgetAcquisitionReply(args: {
  firstName?: string | null;
  motorcycleReference?: string | null;
}): string {
  const firstName = String(args.firstName ?? "").trim();
  const ref = String(args.motorcycleReference ?? "").trim();
  const greeting = firstName ? `Hi ${firstName}` : "Hi there";
  const bikePhrase = ref ? `the ${ref}` : "your bike";
  return (
    `${greeting} — yes, we do buy bikes. To put a real number on ${bikePhrase} we do an in‑person ` +
    `appraisal, so the team can take a look at it. Do you have any lien or payoff on it, and what's ` +
    `the mileage? I can get you set up to bring it by.`
  );
}

/**
 * Pure decision: given the parser verdict, return the clarify reply to use INSTEAD of the plain
 * department ack, or null to keep the plain ack. Deterministic — the LLM is upstream (the parse).
 */
export function decideDeptWidgetBikeClarify(args: {
  parse: DeptWidgetBikeInterestParse | null;
  firstName?: string | null;
  deptLabel?: string | null;
  confidenceMin?: number;
}): string | null {
  const parse = args.parse;
  if (!parse || !parse.asksAboutMotorcycle) return null;
  const min = typeof args.confidenceMin === "number" ? args.confidenceMin : DEPT_WIDGET_BIKE_CLARIFY_CONFIDENCE_MIN;
  if (!(Number(parse.confidence) >= min)) return null;
  return buildDeptBikeClarifyReply({
    firstName: args.firstName,
    deptLabel: args.deptLabel,
    motorcycleReference: parse.motorcycleReference
  });
}
