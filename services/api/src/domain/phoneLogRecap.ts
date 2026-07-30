import { buildAgentIntro } from "./agentVoice.js";

/**
 * Phone-log recap draft (Joe ruling, 2026-07-30).
 *
 * A Traffic Log Pro PHONE LOG is one of our own people writing up a call they already had. The
 * intake branch deliberately sends the customer NOTHING — it files a "Phone log follow-up" task and
 * hands off — on the reasoning that a human already spoke to them. Scott flagged that as "did not
 * generate a response" on Rich Retzlaff (+17168640008, 2026-07-24), and then hand-typed exactly the
 * message we would have drafted three hours later:
 *
 *   "Hi Rich- this is Scott from American H-D. Thank you for your time over the phone this morning
 *    about the 2026 Deadwood we have coming in. I will let you know..."
 *
 * So the message IS wanted; we were just making a person write it. Joe: "Draft it for approval."
 *
 * SCOPED TO A RECORDED PROMISE. Of the 6 phone logs in the store, only some carry a promise the
 * DEALERSHIP owes:
 *   - "told her I would send her photos"            (Lisa Snyder)  => promise, draft
 *   - "Stone will write up a quote."                (Fred Suchan)  => promise, draft
 *   - "Says he will stop in to check them out"      (John Elsbury) => the CUSTOMER committed, not us
 *   - "PreQual: N, PreQualified Amount; $0"         (Kody)         => no promise at all
 * Reading which of those is a dealership promise is COMPREHENSION, so the caller gates this on the
 * typed parser (parseManualOutboundPromiseWithLLM — the same staff-promise parser the manual
 * outbound arm uses, whose whole job is reading staff-typed text for a dealership commitment).
 * Nothing here matches keywords against the write-up.
 *
 * THE WRITE-UP NEVER REACHES THE CUSTOMER. The note is internal shorthand naming staff ("Stone told
 * him about the pre-owned freewheeler"). This module takes only the parser's KIND enum plus already
 * structured lead fields, and composes deterministic copy — the same pattern as
 * buildDemoRideEventSoftInvite. There is no LLM compose on this path, so there is nothing to
 * fabricate.
 *
 * FAIL DIRECTION: every uncertain path returns draft:false, which is exactly today's behavior
 * (task + handoff, no message). The draft is published as a staff DRAFT and never auto-sent, so a
 * false positive costs one discarded draft; a false negative costs nothing new.
 *
 * Pinned by `phone_log_recap:eval`.
 */

export type PhoneLogRecapPromiseKind =
  | "send_info"
  | "check_and_get_back"
  | "prepare_something"
  | "inventory_notify"
  | "other";

/** Same floor the manual-outbound promise arm uses — an unsure read must not message a customer. */
export const PHONE_LOG_RECAP_MIN_CONFIDENCE = 0.7;

export type PhoneLogRecapDecision = {
  draft: boolean;
  reason: string;
  kind: PhoneLogRecapPromiseKind | null;
};

const DRAFTABLE_KINDS: ReadonlySet<string> = new Set<PhoneLogRecapPromiseKind>([
  "send_info",
  "check_and_get_back",
  "prepare_something",
  "inventory_notify",
  "other"
]);

/**
 * Pure. Should this phone log produce a recap draft for staff to approve?
 *
 * `parse` is the typed staff-promise parser's output (null when the parser is off or errored).
 */
export function decidePhoneLogRecapDraft(input: {
  parse?: {
    promisePresent?: boolean | null;
    kind?: string | null;
    confidence?: number | null;
  } | null;
  hasDeliverablePhone: boolean;
  /** True when this thread already carries an outbound/draft — never stack a second recap. */
  alreadyContacted: boolean;
}): PhoneLogRecapDecision {
  // Parser off, errored, or nothing promised => today's behavior (task + handoff only).
  if (!input.parse) return { draft: false, reason: "no_parse", kind: null };
  if (input.parse.promisePresent !== true) {
    return { draft: false, reason: "no_promise", kind: null };
  }
  const kind = String(input.parse.kind ?? "").trim().toLowerCase();
  // The appointment arm owns booking talk, and `none` contradicts promisePresent — both bow out.
  if (kind === "appointment") return { draft: false, reason: "appointment_arm_owns_it", kind: null };
  if (!DRAFTABLE_KINDS.has(kind)) return { draft: false, reason: "unknown_kind", kind: null };

  const confidence = Number(input.parse.confidence);
  if (!Number.isFinite(confidence) || confidence < PHONE_LOG_RECAP_MIN_CONFIDENCE) {
    return { draft: false, reason: "below_confidence", kind: null };
  }
  // Phone logs strip the email address (shouldSuppressPhoneLogEmail), so SMS is the only channel.
  if (!input.hasDeliverablePhone) return { draft: false, reason: "no_deliverable_phone", kind: null };
  if (input.alreadyContacted) return { draft: false, reason: "already_contacted", kind: null };

  return { draft: true, reason: "promise_recorded", kind: kind as PhoneLogRecapPromiseKind };
}

/**
 * The promise sentence, chosen by the parser's KIND. Deliberately says only that we will follow
 * through — never a date, a price, or a claim about what was discussed, none of which we know.
 */
export function phoneLogRecapPromiseLine(kind: PhoneLogRecapPromiseKind): string {
  switch (kind) {
    case "send_info":
      return "I'll get that over to you shortly.";
    case "inventory_notify":
      return "I'll let you know as soon as it's here and ready to show.";
    case "prepare_something":
      return "I'm getting that put together for you and I'll follow up shortly.";
    case "check_and_get_back":
      return "I'm checking on that and I'll get right back to you.";
    default:
      return "I'll follow up with you shortly.";
  }
}

/**
 * Deterministic recap copy.
 *
 * NOTE ON VOICE: it says "Thanks for your time on the phone", never "great talking with you" or a
 * time of day. The agent was not on that call — a first-person account of a conversation it did not
 * have is the fabricated-frame failure mode (see the ADF form-vs-question framing bug class), and
 * the phone log carries no reliable call timestamp anyway.
 */
export function buildPhoneLogRecapDraft(args: {
  firstName?: string | null;
  agentName: string;
  dealerName: string;
  /** Year + model from the ADF's structured vehicle field. Omitted when incomplete. */
  unitLabel?: string | null;
  kind: PhoneLogRecapPromiseKind;
}): string {
  const unit = String(args.unitLabel ?? "").trim();
  const intro = buildAgentIntro(args.firstName, args.agentName, args.dealerName);
  const thanks = unit
    ? `Thanks for your time on the phone about the ${unit}.`
    : "Thanks for your time on the phone.";
  return `${intro}${thanks} ${phoneLogRecapPromiseLine(args.kind)}`;
}

/**
 * Year + model only, from the ADF's structured vehicle field — never the free-text write-up, and
 * never a trade-in vehicle (the caller passes the interest vehicle; a trade-tagged unit must never
 * become the unit of interest). Returns "" unless both parts are present, so a half-known bike is
 * simply left out of the sentence rather than half-named.
 */
export function phoneLogRecapUnitLabel(vehicle?: {
  year?: string | number | null;
  model?: string | null;
} | null): string {
  const year = String(vehicle?.year ?? "").trim();
  const model = String(vehicle?.model ?? "").trim();
  if (!year || !model) return "";
  if (!/^\d{4}$/.test(year)) return "";
  return `${year} ${model}`;
}
