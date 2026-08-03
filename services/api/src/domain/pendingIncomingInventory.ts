import type { Conversation, PendingIncomingInventory } from "./conversationStore.js";
import { isPlaceholderModel } from "./modelDeflection.js";

function compact(text: string | null | undefined): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function lower(text: string | null | undefined): string {
  return compact(text).toLowerCase();
}

function toNumberYear(value: unknown): number | undefined {
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) && n >= 1900 && n <= 2100 ? n : undefined;
}

function cleanModel(raw: string | null | undefined): string {
  let text = compact(raw);
  text = text.replace(/\bharley[-\s]?davidson\b/gi, "").replace(/\bhd\b/gi, "");
  text = text.replace(/\bused\b|\bnew\b/gi, "");
  text = text.replace(/\s+/g, " ").trim();
  if (/^trike\s+freewheeler$/i.test(text)) return "Freewheeler";
  return text;
}

function extractVehicleFromSourceText(raw: string | null | undefined): { year?: number; model?: string } {
  const text = compact(raw);
  const match = text.match(
    /\b((?:19|20)\d{2})\s+([A-Za-z0-9][A-Za-z0-9\s/.-]{2,80}?)(?:\s+(?:we|that|this|is|are|was|were|taking|getting|coming|arriving|on|in)\b|[,.;]|$)/i
  );
  if (!match) return {};
  return {
    year: toNumberYear(match[1]),
    model: cleanModel(match[2])
  };
}

export function hasPendingIncomingInventorySignal(textRaw: string | null | undefined): boolean {
  const text = lower(textRaw);
  if (!text) return false;
  return (
    /\b(?:taking|take|took|getting|get|got|coming|come|came|bringing|bring|brought)\b[\s\S]{0,80}\b(?:in|into|on)\b[\s\S]{0,30}\btrade\b/.test(text) ||
    /\b(?:coming|come|came|incoming|inbound|arriv(?:e|es|ing)|land(?:s|ed|ing)?)\b[\s\S]{0,80}\b(?:trade|pre[-\s]?owned|used)\b/.test(text) ||
    /\b(?:not|isn'?t|ain'?t)\s+(?:here|in|available|ready)\s+yet\b/.test(text) ||
    /\b(?:when|once|as soon as)\b[\s\S]{0,80}\b(?:it|the bike|that bike|trade)\b[\s\S]{0,80}\b(?:gets here|comes in|arrives|is available|is ready)\b/.test(text)
  );
}

export function hasPendingIncomingInventoryContext(
  conv: Pick<Conversation, "pendingIncomingInventory"> | null | undefined
): boolean {
  return String(conv?.pendingIncomingInventory?.status ?? "").toLowerCase() === "pending";
}

/**
 * PREFILTER (LLM gate, not an answer gate — the hasPartsInquirySignal pattern): a staff intake
 * note that BOTH mentions a unit ARRIVING and says it's ALLOCATED to someone. Only when both cue
 * families hit do we spend the incoming-inventory purpose parse to comprehend the allocation
 * (Joe ruling 2026-07-19, Peter Arnoldo +17166887637: "once the next one we have coming in
 * arrives which is spoken for"). Both-cues-required keeps false positives rare: "keep an eye out
 * for a used Low Rider S" (no arrival) and "taking his bike in on trade" (no allocation) never
 * reach the parser. A miss here just means today's behavior (watch + generic ack). Pure.
 */
export function hasSpokenForIncomingCue(textRaw: string | null | undefined): boolean {
  const text = lower(textRaw);
  if (!text) return false;
  const arrival =
    /\b(?:coming in|incoming|in transit|on its way|on the way|arriv(?:e|es|ing|al)|ship date|ships?\b|land(?:s|ing|ed)?\b|gets? here|comes? in)\b/.test(
      text
    );
  const allocated =
    /\b(?:spoken for|reserved|claimed|allocated|promised|has a deposit|deposit (?:down|on it)|already sold|is sold|sold to)\b/.test(
      text
    );
  return arrival && allocated;
}

/** Confidence floor for accepting the incoming-inventory purpose/allocation parse
 *  (INCOMING_INVENTORY_PURPOSE_CONFIDENCE_MIN, default 0.7). */
export function incomingInventoryPurposeConfidenceFloor(): number {
  const v = Number(process.env.INCOMING_INVENTORY_PURPOSE_CONFIDENCE_MIN);
  return Number.isFinite(v) && v > 0 ? v : 0.7;
}

// A SPECIFIC parts/accessory-inquiry prefilter: a part number, OR an accessory noun paired with an
// intent verb. Deliberately specific so a bare incoming-inventory ack ("ok, let me know when it's
// here") never matches — only a real parts ask does. Used to DEFER the pending-incoming handler to the
// parts/accessory parser (a prefilter that gates to the LLM, not an answer gate). Pure.
const PARTS_ACCESSORY_NOUN =
  /\b(handle ?bars?|grips?|\bseat\b|exhaust|\bpipes?\b|slip-?on|windshield|windscreen|backrest|sissy ?bar|tour ?pak|luggage|fairing|saddle ?bags?|engine guard|\bguard\b|\brack\b|fender|floorboard|highway peg|crash bar|derby|air cleaner|stage \d|\bmirror|hard ?bags?)\b/i;
const PARTS_INTENT_VERB =
  /\b(looking for|want|need|do you (have|carry|stock)|in stock|order|can you (get|order)|could (you )?get|add|install|put on|price|pricing|how much|fit|fitment)\b/i;
const PART_NUMBER = /\bpart\s*(?:#|no\.?|number)\s*#?\s*\d{3,}|#\s*\d{4,}/i;

export function hasPartsInquirySignal(textRaw: string | null | undefined): boolean {
  const text = lower(textRaw);
  if (!text) return false;
  if (PART_NUMBER.test(text)) return true;
  return PARTS_ACCESSORY_NOUN.test(text) && PARTS_INTENT_VERB.test(text);
}

/** Reads PARTS_TURN_PRECEDENCE_ENABLED. Default OFF (dark) — when off, a parts turn does NOT defer the
 *  pending-incoming handler and the accessory decision is not force-run (byte-identical to today). */
export function partsTurnPrecedenceEnabled(): boolean {
  const raw = String(process.env.PARTS_TURN_PRECEDENCE_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function isPendingIncomingInventoryAcknowledgementText(textRaw: string | null | undefined): boolean {
  const text = lower(textRaw);
  if (!text) return false;
  if (/\b(stop|unsubscribe|wrong number|not interested|do not text|don't text)\b/.test(text)) return false;
  return (
    /\b(?:yes|yep|yeah|yup|ok|okay|sure|sounds good|will do|please|thanks|thank you)\b[\s\S]{0,80}\b(?:let me know|keep me posted|text me|notify me|hit me up)\b/.test(text) ||
    /\b(?:let me know|keep me posted|text me|notify me|hit me up)\b[\s\S]{0,100}\b(?:available|ready|comes in|gets here|arrives|lands|trade)\b/.test(text) ||
    /\b(?:when|once|as soon as)\b[\s\S]{0,80}\b(?:available|ready|comes in|gets here|arrives|lands)\b/.test(text)
  );
}

export function shouldHandlePendingIncomingInventoryTurn(args: {
  conv: Pick<Conversation, "pendingIncomingInventory"> | null | undefined;
  inboundText: string | null | undefined;
  lastOutboundText?: string | null;
  partsInquiry?: boolean;
}): boolean {
  if (!hasPendingIncomingInventoryContext(args.conv)) return false;
  // A parts/accessory inquiry is not an incoming-inventory acknowledgement — defer so the parts handler
  // owns the turn (the customer asked about parts, not "let me know when the bike arrives").
  if (args.partsInquiry) return false;
  if (isPendingIncomingInventoryAcknowledgementText(args.inboundText)) return true;
  const combined = `${compact(args.lastOutboundText)} ${compact(args.inboundText)}`;
  return hasPendingIncomingInventorySignal(combined) && isPendingIncomingInventoryAcknowledgementText(combined);
}

export function buildPendingIncomingInventoryFromConversation(args: {
  conv: Pick<Conversation, "lead" | "pendingIncomingInventory">;
  sourceText?: string | null;
  source?: PendingIncomingInventory["source"];
  sourceMessageId?: string | null;
  allocation?: PendingIncomingInventory["allocation"];
  nowIso?: string;
}): PendingIncomingInventory | null {
  const existing = args.conv.pendingIncomingInventory;
  const leadVehicle = args.conv.lead?.vehicle ?? {};
  const leadInventory = (args.conv.lead as any)?.inventory ?? {};
  const sourceVehicle = extractVehicleFromSourceText(args.sourceText);
  const model = cleanModel(
    existing?.model ||
      leadVehicle.model ||
      leadVehicle.description ||
      leadInventory.model ||
      sourceVehicle.model ||
      ""
  );
  const year = existing?.year ?? toNumberYear(leadVehicle.year ?? leadInventory.year ?? sourceVehicle.year);
  const label = formatPendingIncomingInventoryLabel({
    model,
    year,
    make: existing?.make || compact(leadVehicle.make) || "Harley-Davidson",
    label: existing?.label
  });
  if (!model && !label) return null;
  const nowIso = args.nowIso || new Date().toISOString();
  return {
    model: model || existing?.model,
    year,
    make: existing?.make || compact(leadVehicle.make) || "Harley-Davidson",
    condition: existing?.condition || compact(leadVehicle.condition) || "used",
    label: existing?.label || label,
    note: compact(args.sourceText) || existing?.note,
    source: args.source || existing?.source || "system",
    sourceMessageId: compact(args.sourceMessageId) || existing?.sourceMessageId,
    allocation: args.allocation || existing?.allocation,
    status: "pending",
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso,
    acknowledgedAt: existing?.acknowledgedAt
  };
}

export function formatPendingIncomingInventoryLabel(
  pending: Pick<PendingIncomingInventory, "label" | "year" | "make" | "model"> | null | undefined
): string {
  const explicit = compact(pending?.label);
  if (explicit) return explicit;
  const year = pending?.year ? String(pending.year) : "";
  const model = cleanModel(pending?.model);
  const make = compact(pending?.make);
  const parts = [year, model || make].filter(Boolean);
  return compact(parts.join(" "));
}

/**
 * The KIND of incoming unit — drives the customer/task copy. Three framings:
 *  - "order":  a NEW bike on order from the factory ("on order").
 *  - "trade":  the CUSTOMER'S OWN bike being taken in on trade ("on trade").
 *  - "incoming": a used/other unit the dealer is SOURCING for the customer to BUY, or an unclear
 *               case — neutral "coming in" copy that is TRUE either way and never wrongly says "trade".
 * Prefers the COMPREHENDED `purpose` (parseIncomingInventoryPurposeWithLLM, set at creation). Falls back
 * to the structured `condition` for legacy records with no purpose: new => order, else => the neutral
 * "incoming" framing (NOT "trade" — a used incoming unit is only a trade when we actually read it as
 * the customer's own trade-in). Joe, 2026-07-16 (Bill Indelicato +17163591526): a used bike being
 * sourced for the buyer was being called "the 2015 Road King trade". FAIL DIRECTION: unknown => the
 * neutral "coming in" copy, never a wrong "trade" claim.
 */
type IncomingUnitKind = "order" | "trade" | "incoming";
function incomingUnitKind(
  pending: Pick<PendingIncomingInventory, "condition" | "purpose"> | null | undefined
): IncomingUnitKind {
  const purpose = lower(pending?.purpose);
  if (purpose === "factory_order") return "order";
  if (purpose === "trade_in") return "trade";
  if (purpose === "sourced_for_purchase") return "incoming";
  // No comprehended purpose (legacy / parser off): only an explicit `new` condition is an order;
  // everything else is the neutral "coming in" framing — we do NOT guess "trade" from `used` alone.
  return lower(pending?.condition) === "new" ? "order" : "incoming";
}

/**
 * A clean "{year} {model}" descriptor for customer copy — or "" when the model is a placeholder
 * ("Other" / "Full Line" / make-only), so a placeholder never leaks into a reply as "the 2026 Other …"
 * (Nicholas Braun's stored label was literally "2026 Other"). The builders fall back to a neutral
 * "the bike" when this is empty. Structured display of a known field, not comprehension.
 */
function cleanIncomingUnitLabel(
  pending: Pick<PendingIncomingInventory, "label" | "year" | "model"> | null | undefined
): string {
  const explicit = compact(pending?.label);
  if (explicit && !isPlaceholderModel(explicit)) return explicit;
  if (isPlaceholderModel(pending?.model)) return "";
  const model = cleanModel(pending?.model);
  if (!model) return "";
  const year = pending?.year ? String(pending.year) : "";
  return compact([year, model].filter(Boolean).join(" "));
}

export function buildPendingIncomingInventoryCustomerAck(
  pending: PendingIncomingInventory | null | undefined
): string {
  const unit = cleanIncomingUnitLabel(pending);
  const kind = incomingUnitKind(pending);
  if (kind === "order") {
    const subject = unit ? `the ${unit} you've got on order` : "the bike you've got on order";
    return `Ok, will do. I'll keep an eye on ${subject} and let you know as soon as it's here and ready to look at.`;
  }
  if (kind === "trade") {
    const subject = unit ? `the ${unit} trade` : "the incoming trade";
    return `Ok, will do. I'll keep this tied to ${subject} and let you know as soon as it's here and ready to look at.`;
  }
  const subject = unit ? `the ${unit}` : "the bike";
  return `Ok, will do. I'll keep an eye on ${subject} we've got coming in and let you know as soon as it's here and ready to look at.`;
}

export function buildPendingIncomingInventoryInitialAdfReply(
  pending: PendingIncomingInventory | null | undefined
): string {
  const unit = cleanIncomingUnitLabel(pending);
  const subject = unit ? `the ${unit}` : "the bike";
  const kind = incomingUnitKind(pending);
  if (kind === "order") {
    return `Thanks — I have you down for ${subject} you've got on order. We'll let you know as soon as it's here and ready to look at.`;
  }
  if (kind === "trade") {
    return `Thanks — I have you down for ${subject} we're taking in on trade. We'll let you know as soon as it's here and ready to look at.`;
  }
  return `Thanks — I have you down for ${subject} we've got coming in. We'll let you know as soon as it's here and ready to look at.`;
}

/**
 * Warm customer ack when the incoming unit is SPOKEN FOR by someone else (Joe ruling
 * 2026-07-19, Peter Arnoldo +17166887637): the customer is on the list for a FUTURE unit, and
 * STAFF own the pipeline conversation — so the copy promises the team will keep them posted,
 * never that the agent will "keep an eye out" (that's watch language), and never quotes
 * pipeline facts (ship dates, allocation details) the agent can't verify.
 */
export function buildSpokenForIncomingHandoffAck(
  pending: Pick<PendingIncomingInventory, "label" | "year" | "model"> | null | undefined
): string {
  const unit = cleanIncomingUnitLabel(pending);
  const subject = unit ? `the next ${unit}` : "the next one coming in";
  return `You're on the list for ${subject} — we'll keep you posted as soon as we know more.`;
}

export function buildPendingIncomingInventoryTaskSummary(args: {
  pending: PendingIncomingInventory | null | undefined;
  customerName?: string | null;
}): string {
  const unit = cleanIncomingUnitLabel(args.pending);
  const customer = compact(args.customerName) || "customer";
  // Spoken-for allocation outranks the purpose framing: staff must know the in-transit unit is
  // claimed and confirm this customer's allocation by hand. Keeps the stable "arrives or is
  // ready to show" tail so isPendingIncomingInventoryNotifyTodoSummary / the dedup planner
  // still collapse duplicates.
  if (lower(args.pending?.allocation) === "spoken_for_other") {
    const subject = unit ? `the next ${unit}` : "the next incoming bike";
    return `Notify ${customer} when ${subject} arrives or is ready to show — the current incoming unit is spoken for; confirm their allocation.`;
  }
  const kind = incomingUnitKind(args.pending);
  if (kind === "order") {
    const subject = unit ? `the ${unit} (on order)` : "the ordered bike";
    return `Notify ${customer} when ${subject} arrives or is ready to show.`;
  }
  if (kind === "trade") {
    const subject = unit ? `the ${unit} trade` : "the incoming trade";
    return `Notify ${customer} when ${subject} arrives or is ready to show.`;
  }
  const subject = unit ? `the ${unit}` : "the incoming bike";
  return `Notify ${customer} when ${subject} arrives or is ready to show.`;
}

/**
 * Identify our OWN "Notify … when the … arrives or is ready to show" task by its fixed template
 * tail. This is a SINGLETON objective per conversation, but it historically piled up (Nicholas
 * Braun: 4 open copies, 2026-06-23): the producer (applyPendingIncomingInventoryState) tags the
 * task `taskClass: "followup"` while inferTodoTaskClass classifies the same summary as "todo" — so
 * addTodo's class-keyed merge split identical objectives across buckets and never collapsed them.
 * Matching on the template lets us dedup CLASS-AGNOSTICALLY. We key on the stable tail "arrives or is
 * ready to show" (NOT "trade arrives …") so it recognizes BOTH the legacy trade copy and the new
 * kind-aware copy (on-order vs trade) after the trade/placeholder-label fix. This recognizes a
 * system-generated task summary for side-effect/state housekeeping — NOT customer comprehension —
 * which AGENTS.md allows.
 */
export function isPendingIncomingInventoryNotifyTodoSummary(summary: string | null | undefined): boolean {
  const text = lower(summary);
  if (!text) return false;
  if (text.includes("arrives or is ready to show")) return true;
  // Generic arrival-notify family (Joe ruling 2026-07-09, Dante Turello +17169085899: the
  // template task AND a staff-written "contact customer when the low rider s gets here from
  // the auction" reminder sat open side by side — same objective, different words, never
  // merged). Conservative shape: an action verb + a temporal conjunction + an arrival verb.
  // Two tasks matching this ON THE SAME CONVERSATION are the same "tell them when it lands"
  // objective. Deterministic matching of SYSTEM/STAFF task summaries (side-effect
  // housekeeping, not customer comprehension — AGENTS.md-allowed).
  const action = /\b(notify|contact|call|text|reach out|let\b.{0,30}\bknow|follow up with)\b/i.test(text);
  const temporal = /\b(when|once|as soon as|after)\b/i.test(text);
  const arrival =
    /\b(arriv\w+|gets? here|get here|comes? in|came in|is here|here from|shows? up|ready to (?:show|view|see)|hits the floor|off the truck|from the auction)\b/i.test(
      text
    );
  return action && temporal && arrival;
}

/**
 * Does a REACHED voice attempt leave this task open? Pure gate for
 * markOpenCallTodosDoneForCompletedVoiceAttempt, which closes EVERY open `reason: "call"` task on
 * the conversation the moment a call connects — a blunt closer the task-fulfillment module's own
 * header already calls out (taskFulfillmentAutoClose.ts).
 *
 * LIVE CASE (Joe Catalano, +17164324480, operator-reported "Should this have created a watch?"):
 * his 2026 CVO Street Glide ships 8/25, and the arrival-notify task was correctly created and
 * DATED off that arrival (dueAt 2026-08-25T13:00Z). On 8/1 at 14:53Z a call connected on that
 * thread and one minute later the blunt closer marked the 8/25 reminder done — 24 days before the
 * bike is due. The parser-first fulfillment judge had ALREADY read the same task at 12:27Z that
 * morning and ruled `not_fulfilled` ("never communicated that the unit has arrived"); the blunt
 * closer overrode it. From the operator's side nothing is left that fires when the bike lands, so
 * the promise the dealer made ("I'll let you know as soon as it's here") dies silently.
 *
 * SCOPE — arrival-notify tasks that are STILL DATED IN THE FUTURE, nothing else. An ordinary
 * call-back task ("Call requested: get off at three thirty", due tomorrow 9am, staff call today) is
 * genuinely fulfilled by the call and must keep closing: 45 of the 102 early-closed call tasks in
 * the live store are that pattern, and all but this one are ~1 day early. Once the arrival date has
 * PASSED, a reached call closes the task exactly as it does today — the guard only protects the
 * window while the unit is still in transit.
 *
 * FAIL DIRECTION: keeping it open leaves a task staff can close by hand (noise); closing it early
 * loses the follow-through entirely and the customer is never told their bike arrived. Fail-safe is
 * to KEEP — the same policy taskFulfillmentAutoClose states for its own uncertain verdicts. This is
 * a side-effect/state gate on OUR OWN generated task summary, not customer comprehension, so
 * deterministic is correct here per AGENTS.md.
 */
export function shouldVoiceAttemptKeepArrivalNotifyTaskOpen(input: {
  summary?: string | null;
  dueAt?: string | null;
  nowMs: number;
}): boolean {
  if (!isPendingIncomingInventoryNotifyTodoSummary(input?.summary)) return false;
  const dueAtMs = Date.parse(String(input?.dueAt ?? "").trim());
  if (!Number.isFinite(dueAtMs)) return false; // undated ⇒ today's behavior, unchanged
  return dueAtMs > input.nowMs;
}

/**
 * Pure dedup planner for the pending-incoming notify task. Given a conversation's OPEN todos,
 * pick the single survivor (the richest copy — longest summary, so any appended ask like a
 * parts/color question isn't lost; ties keep the first) and list the redundant copies to retire.
 * If the survivor has no due date but a retiree does, adopt the EARLIEST retiree due date so
 * collapsing duplicates never loses the scheduled follow-up time. No matches → nothing to do.
 */
export function planPendingIncomingNotifyDedup(
  openTodos: { id: string; summary?: string | null; dueAt?: string | null }[]
): { keepId: string | null; retireIds: string[]; adoptDueAt: string | null } {
  const matches = (openTodos ?? []).filter(t => isPendingIncomingInventoryNotifyTodoSummary(t?.summary));
  if (matches.length === 0) return { keepId: null, retireIds: [], adoptDueAt: null };
  const keep = matches.reduce((best, t) =>
    String(t?.summary ?? "").length > String(best?.summary ?? "").length ? t : best
  );
  const retirees = matches.filter(t => t.id !== keep.id);
  let adoptDueAt: string | null = null;
  if (!String(keep?.dueAt ?? "").trim()) {
    const dues = retirees
      .map(t => String(t?.dueAt ?? "").trim())
      .filter(d => d && Number.isFinite(Date.parse(d)))
      .sort((a, b) => Date.parse(a) - Date.parse(b));
    adoptDueAt = dues[0] ?? null;
  }
  return { keepId: keep.id, retireIds: retirees.map(t => t.id), adoptDueAt };
}

/**
 * WHEN should the "Notify {customer} when the {unit} arrives" staff task come due?
 *
 * Trigger (Mohamed Ahmed +17164258647, operator-reported 2026-07-29 — "this should not create a
 * task that starts right away. its a watch and should only create the task when the motorcycle
 * arrives and the watch fires"; Joe ruled "task off the arrival date"): the task was created with
 * NO dueAt, so a bike Joe had just told the customer was "scheduled to come in around 8/21" left a
 * task screaming DUE NOW in the inbox for three weeks. The same complaint arrived earlier from
 * Nicholas Braun +17166286477 ("probably next week but the call task is for tomorrow") — one root
 * cause: the task's date ignored the ARRIVAL.
 *
 * We deliberately do NOT delete the task. It is the safety net the watch depends on: `watch_fire_miss`
 * findings prove watches do miss, and the task is how staff catch that. So the task always exists —
 * it just comes due when the promise does.
 *
 * BUCKET: a pure side-effect/state decision over an ALREADY-COMPREHENDED slot. The arrival wording
 * ("around 8/21") is read by parseIncomingInventoryPurposeWithLLM's `expected_arrival_text` and
 * resolved to a calendar day by the caller's existing `parseRequestedDateOnly` — this function only
 * decides the resulting dueAt. No prose is inspected here.
 *
 * FAIL DIRECTION: today's behavior. No stated timing, an unresolvable date, or a date already behind
 * us => `dueAt: null`, i.e. the undated task staff get now. We never push a task PAST a known
 * arrival, and never invent a date. Over-dating would hide a real follow-through; leaving it undated
 * is merely noisy, which is the state we are improving from.
 */
export function resolvePendingIncomingNotifyDueAt(args: {
  /** `expected_arrival_text` resolved by the caller via parseRequestedDateOnly; null when absent/unparsable. */
  expectedArrivalDay?: { year: number; month: number; day: number } | null;
  /** Now, as epoch ms — compared against the resolved day so a stale arrival never dates a task backwards. */
  nowMs: number;
}): { dueAt: string | null; reason: string } {
  const day = args.expectedArrivalDay;
  if (!day) return { dueAt: null, reason: "no_expected_arrival" };
  const { year, month, day: dayOfMonth } = day;
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(dayOfMonth) ||
    month < 1 ||
    month > 12 ||
    dayOfMonth < 1 ||
    dayOfMonth > 31
  ) {
    return { dueAt: null, reason: "invalid_expected_arrival" };
  }
  // Morning of the arrival day, dealership-local — staff should see it the day the bike lands, not
  // at midnight. 13:00Z ~= 9am ET, matching the other dated staff tasks.
  const dueMs = Date.UTC(year, month - 1, dayOfMonth, 13, 0, 0, 0);
  if (!Number.isFinite(dueMs)) return { dueAt: null, reason: "invalid_expected_arrival" };
  if (!Number.isFinite(args.nowMs)) return { dueAt: null, reason: "invalid_now" };
  // An arrival already behind us means the bike is late or the note was stale — surface it NOW
  // (undated) rather than dating a task into the past, where the inbox would bury it.
  if (dueMs <= args.nowMs) return { dueAt: null, reason: "arrival_not_in_future" };
  return { dueAt: new Date(dueMs).toISOString(), reason: "expected_arrival" };
}

/**
 * Should the "Notify {customer} when the {unit} arrives" task be RE-DATED to the arrival we know?
 *
 * Trigger (Mohamed Ahmed +17164258647 again, operator-reported 2026-07-31 — "Why is this overdue
 * when the bike is not supposed to come in til 8/21", and STILL true on 2026-08-03: the task read
 * due 8/3 and pinged staff that morning for a bike landing 8/21). #337 dated the task at CREATE
 * time, but `upsertPendingIncomingInventoryNotifyTodo` would then only ever FILL a missing date or
 * pull one EARLIER. That rule is what locked the wrong date in: once ANY other writer stamped a
 * nearer date — a staff snooze, an addTodo carrying a schedule — the arrival could never take
 * effect, and the task shouted "overdue" for the three weeks nobody could act on it.
 *
 * RULE, and it is the whole idea: for THIS one task type a KNOWN FUTURE ARRIVAL IS THE AUTHORITY.
 * The objective is literally "tell them it arrived", so no date before the arrival can be actioned
 * and no date after it is soon enough. We therefore move the task in BOTH directions to sit on the
 * arrival — which is the one thing #337 would not do.
 *
 * BUCKET: a pure side-effect/state decision over an ALREADY-COMPREHENDED slot. The arrival wording
 * was read by `parseIncomingInventoryPurposeWithLLM`'s `expected_arrival_text` and resolved by
 * `resolvePendingIncomingNotifyDueAt`. No prose is inspected here.
 *
 * FAIL DIRECTION — deliberately different from #337, and narrowly so. #337 refused to push any task
 * later because a task pushed out is a task staff may not chase; that stays right in general. It is
 * wrong for THIS task, where "due now" is not merely noisy but unactionable, and where an inbox that
 * cries overdue for three straight weeks is what teaches staff to stop reading it. The blast radius
 * is held to that one case by three guards: we act ONLY on a known arrival, ONLY when it is still in
 * the FUTURE, and we never move the task PAST it. Everything else — no arrival, an unparsable one,
 * an arrival already behind us — returns the current date untouched, i.e. today's behavior.
 *
 * The bike showing up EARLY is covered by the inventory watch, which fires on arrival independently
 * of this task; the task is the safety net for a watch that misses, not the arrival signal itself.
 */
export function planPendingIncomingNotifyDueAtUpdate(args: {
  /** The task's current `dueAt`, if any. */
  currentDueAt?: string | null;
  /** The arrival-dated due time from `resolvePendingIncomingNotifyDueAt` (pending.expectedArrivalAt). */
  arrivalDueAt?: string | null;
  /** Now, as epoch ms — an arrival already behind us never re-dates a task. */
  nowMs: number;
}): { dueAt: string | null; changed: boolean; reason: string } {
  const current = String(args.currentDueAt ?? "").trim() || null;
  const arrivalIso = String(args.arrivalDueAt ?? "").trim();
  const arrivalMs = arrivalIso ? Date.parse(arrivalIso) : Number.NaN;
  if (!arrivalIso || !Number.isFinite(arrivalMs)) {
    return { dueAt: current, changed: false, reason: "no_known_arrival" };
  }
  if (!Number.isFinite(args.nowMs)) {
    return { dueAt: current, changed: false, reason: "invalid_now" };
  }
  // A stale/late arrival must not drag a task backwards into the past, where the inbox buries it.
  if (arrivalMs <= args.nowMs) {
    return { dueAt: current, changed: false, reason: "arrival_not_in_future" };
  }
  const arrivalNormalized = new Date(arrivalMs).toISOString();
  const currentMs = current ? Date.parse(current) : Number.NaN;
  if (Number.isFinite(currentMs) && currentMs === arrivalMs) {
    return { dueAt: arrivalNormalized, changed: false, reason: "already_dated_to_arrival" };
  }
  return { dueAt: arrivalNormalized, changed: true, reason: "arrival_is_authority" };
}

/**
 * Does this pending record still have NO expected arrival, with seed text we could read one from?
 *
 * #337 read `expected_arrival_text` only inside the "we still need the purpose" branch, so a record
 * whose purpose was already settled — i.e. EVERY record established before #337 shipped — skipped
 * the parser entirely and could never acquire an arrival, no matter how many turns the thread took.
 * Mohamed Ahmed +17164258647 is exactly that: purpose "factory_order" since 7/29, so his stated 8/21
 * was permanently unreachable and his task kept reading due today. Capturing the arrival on its OWN
 * condition is what lets those records heal.
 *
 * Bounded cost: true only while the record has NO arrival at all, so it is one extra parse per
 * record, once, and never again.
 */
export function pendingIncomingArrivalIsUnknown(
  pending: { expectedArrivalText?: string | null; expectedArrivalAt?: string | null },
  seedText: string | null | undefined
): boolean {
  return (
    !String(pending?.expectedArrivalText ?? "").trim() &&
    !String(pending?.expectedArrivalAt ?? "").trim() &&
    !!String(seedText ?? "").trim()
  );
}

/**
 * Record the COMPREHENDED arrival on the pending record, resolved to a due date.
 *
 * The wording ("around 8/21", "late August") is read by parseIncomingInventoryPurposeWithLLM's
 * `expected_arrival_text` and turned into a calendar day by the caller's `parseRequestedDateOnly` —
 * the same resolver the staff-promise tasks use. Never regexed out of prose. This only stores it.
 */
export function applyComprehendedArrivalToPending(args: {
  pending: { expectedArrivalText?: string | null; expectedArrivalAt?: string | null };
  arrivalText: string;
  arrivalDay: { year: number; month: number; day: number } | null;
  nowMs: number;
}): void {
  const text = String(args.arrivalText ?? "").trim();
  if (!text) return;
  args.pending.expectedArrivalText = text;
  const resolved = resolvePendingIncomingNotifyDueAt({
    expectedArrivalDay: args.arrivalDay,
    nowMs: args.nowMs
  });
  if (resolved.dueAt) args.pending.expectedArrivalAt = resolved.dueAt;
}

/**
 * Apply a purpose decision to the pending record. Behavior-preserving extraction from
 * applyPendingIncomingInventoryState — the allocation is only ever FILLED, never overwritten, which
 * is what keeps a previously-established allocation from being downgraded by a later thin turn.
 */
export function applyIncomingInventoryPurposeDecision(
  pending: { purpose?: string | null; allocation?: string | null },
  decision: { purpose: string; allocation: string }
): void {
  pending.purpose = decision.purpose as any;
  if (!pending.allocation && decision.allocation !== "unclear") {
    pending.allocation = decision.allocation as any;
  }
}
