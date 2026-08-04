/**
 * Corpus replay flywheel (Joe-approved 2026-07-02) — the offline readiness loop.
 *
 * Live traffic exposes ~10-25 actionable turns/day; the release gate crawls at that rate. This
 * flywheel replays a CORPUS of real inbound turns through the CURRENT code (the sandboxed
 * inbound_shadow_replay harness — no sends, snapshot store), judges every produced draft with
 * the intent-handled LLM judge (the fluent-but-wrong-intent net), diffs per-turn results
 * against the previous baseline (regressions pop instantly), and emits findings in the
 * OutcomeAnomaly shape so the existing tiered loop can fix them.
 *
 *   replay cohort → judge drafts → score turns → diff baseline → findings + scoreboard
 *
 * Read-only by construction: consumes a replay report produced against a snapshot; never
 * touches the live store, never sends. LLM cost is capped by --max-judge.
 *
 * Usage:
 *   npx tsx scripts/corpus_replay_flywheel.ts --replay-json <inbound-shadow-*.json> [--out-dir DIR] [--max-judge N]
 *   npx tsx scripts/corpus_replay_flywheel.ts --self-test        # pure scaffolding, no network
 *
 * Release contract (Joe, 2026-07-05 — correctness blocks, quality trends):
 *   GATE (blocks rollout): criticals === 0 AND regressions === 0, two consecutive sweeps.
 *   TREND (tracked, never blocking): overall passRate target >= 0.85 (aligned with the live
 *   tone-gate floor) — judge-minor quality nits inform voice work but cannot block a release
 *   (blocking on an LLM judge's taste invites Goodharting the voice charter).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildIntentJudgePrompt,
  isNonActionableInbound,
  realJudge,
  type IntentJudgeCandidate,
  type IntentVerdict
} from "./intent_handled_audit.ts";
import {
  isBareReactionOnlyInbound,
  isQuotedReactionEchoInbound,
  isTestLeadEmail
} from "../services/api/src/domain/scoringExclusions.ts";
import { isPlaceholderModel } from "../services/api/src/domain/modelDeflection.ts";
import { classifyReplayErrorCause } from "../services/api/src/domain/replayFidelity.ts";
import { describeWalkInNoteProvenance } from "../services/api/src/domain/walkInFollowUpTopic.ts";

export type ReplayRow = {
  id?: string;
  conversationId: string;
  leadKey?: string;
  customerName?: string;
  messageId?: string;
  messageIndex?: number;
  messageAt?: string;
  provider?: string;
  body: string;
  draft: string | null;
  verdict: "candidate_safe" | "review" | "expected_no_response" | "no_response" | "error";
  reviewReasons?: string[];
  router?: { followUpMode?: string | null; followUpReason?: string | null } | null;
  /** The SOURCE conversation's mode before the replay harness force-overwrites it (autopilot). */
  sourceConversationMode?: string | null;
  error?: string;
};

// Tracked quality trend target — aligned with the live tone-gate floor (85%). Never blocking.
export const TREND_PASS_RATE_TARGET = 0.85;

/**
 * Fraction of ATTEMPTED turns that must have produced a real verdict for the sweep to be able to
 * clear the gate at all.
 *
 * A harness error is no evidence either way, so a handful of them must NOT block the gate — doing
 * that is the bug this replaces, where a deploy running `npm ci` mid-sweep blocked every merge.
 * But "no evidence" must never round UP to "clean" either (same anti-flattery rule the readiness
 * scorecard uses, where NOT_MEASURED blocks the bar): a sweep that lost most of its corpus has not
 * validated anything, and its PASS would be a lie. So incidental loss is tolerated and reported,
 * while a sweep below this floor is INCOMPLETE and cannot pass. The 08-04 incident sits at
 * 671/700 = 95.9%, deliberately just inside — 671 real verdicts ARE evidence.
 */
export const COVERAGE_FLOOR = 0.95;

/** Share of attempted turns that yielded a real verdict. 1 when nothing was attempted. */
export function computeCoverage(measured: number, harnessErrors: number): number {
  const attempted = measured + harnessErrors;
  if (attempted <= 0) return 1;
  return Math.round((measured / attempted) * 1000) / 1000;
}

export type TurnScore = {
  turnKey: string;
  conversationId: string;
  pass: boolean;
  critical: boolean;
  verdict: ReplayRow["verdict"];
  reviewReasons: string[];
  judge?: IntentVerdict | null;
  body: string;
  draft: string | null;
  /** When the replayed CUSTOMER turn happened (turnTimeOf); absent when it can't be resolved. */
  turnAt?: string;
};

/**
 * WHEN THE REPLAYED TURN ACTUALLY HAPPENED — not when the sweep ran.
 *
 * Every replay finding used to be stamped `occurredAt: atIso` (the sweep's own clock), so a turn
 * from May carried an August timestamp. That made replay findings structurally unable to SETTLE:
 * the disposition ledger's fail-safe path resurfaces a disposed key whose event postdates the fix
 * boundary, and a nightly-stamped event always postdates every boundary. On 2026-08-04 two disposed
 * findings came back as `regression-of-disposed` on that basis alone — +17164738220 (real turn
 * 2026-05-19) and +17164182619 (real turn 2026-07-09), both stamped 2026-08-04T07:53:34.625Z, the
 * same millisecond, because that was the run. Both genuinely PREDATE their 2026-07-30 boundary.
 *
 * FAIL DIRECTION: unknown returns undefined and the caller keeps the sweep time — i.e. "recent",
 * which keeps the finding visible. A turn time can only ever make a finding look OLDER, and a real
 * post-fix regression still carries a post-fix turn time, so it still resurfaces.
 */
export function turnTimeOf(row: Pick<ReplayRow, "messageAt" | "messageId">): string | undefined {
  const at = Date.parse(String(row.messageAt ?? ""));
  if (Number.isFinite(at)) return new Date(at).toISOString();
  // The store's message ids carry the send epoch as their last segment (msg_<rand>_<epochMs>);
  // it agrees with messageAt to within milliseconds, so it is a faithful second source.
  const epoch = String(row.messageId ?? "").match(/_(\d{10,})$/);
  if (epoch) {
    const ms = Number(epoch[1]);
    if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  }
  return undefined;
}

export function turnKeyOf(row: Pick<ReplayRow, "conversationId" | "messageId" | "messageIndex" | "body">): string {
  const anchor =
    String(row.messageId ?? "").trim() ||
    (Number.isFinite(row.messageIndex) ? `idx${row.messageIndex}` : "") ||
    String(row.body ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  return `${String(row.conversationId ?? "").trim()}::${anchor}`;
}

// Fidelity v2 (cohort-1 calibration, 2026-07-02): the raw judge lacks the DESIGN POLICIES, so it
// flagged policy-correct behavior as critical. These deterministic post-classifiers encode the
// accepted designs — findings they match are counted separately (designAccepted / deflections in
// the summary), never silently dropped, so the numbers stay honest while the T1/T2 gates measure
// what actually blocks release.
export function isTestLeadRow(row: ReplayRow): boolean {
  const hay = `${row.conversationId} ${row.body}`.toLowerCase();
  if (isTestLeadEmail(row.conversationId)) return true;
  const emailMatch = hay.match(/email:\s*(\S+)/);
  if (emailMatch && isTestLeadEmail(emailMatch[1])) return true;
  // Internal staff emails on inbound leads = smoke/test submissions (gio@americanharley-... on a
  // "Fuel economy 0.02 mpg" Kenect lead, sweep-2 false regression).
  if (emailMatch && /@americanharley/.test(emailMatch[1])) return true;
  return /\btest\s*(?:lead|111|dla)\b/i.test(hay);
}

// Department handoff-ack BY DESIGN: parts/service/apparel widget+ADF leads get a warm handoff,
// never a fabricated availability/price answer (web-widget non-sales design, PR #47/#148).
export function isDesignAcceptedHandoff(row: ReplayRow): boolean {
  const draft = String(row.draft ?? "").toLowerCase();
  const body = String(row.body ?? "").toLowerCase();
  const isDeptLead =
    /department:\s*(parts|service|apparel|motor\s*clothes)/.test(body) ||
    /source:[^\n]*(service|parts|apparel)/.test(body) ||
    /\b(apparel|parts|service) request\b/.test(draft);
  const isHandoffAck =
    /(passed your message along|(?:our|the) (?:parts|service|apparel|motor\s*clothes) (?:team|department)|(?:team|department) (?:will|to|they['\u2019]ll) (?:reach out|follow up|text you))/.test(
      draft
    );
  return isDeptLead && isHandoffAck;
}

// A Dealer Lead App post-ride survey log (internal, staff-filed after a demo/test ride): the
// "Marketing Questions: Dealer Lead App ..." block plus a "Demo Bikes Ridden:" line. Never a
// customer question — the outcome + follow-up stay with the salesperson.
export function isDealerRideLogBody(body: string): boolean {
  const b = body.toLowerCase();
  return /dealer lead app/.test(b) && /demo bikes? ridden|demo ride|test ride/.test(b);
}

// Dealer-ride post-ride thank-you BY DESIGN (Joe-approved 2026-07-02): a confirmed demo-ride
// lead gets ONE warm thank-you draft while the outcome + follow-up stay with the salesperson —
// the judge reads it as "didn't answer the asks", but that IS the accepted policy.
export function isDealerRideThankYou(row: ReplayRow): boolean {
  const draft = String(row.draft ?? "").toLowerCase();
  const isThankYou = /thanks (?:again )?for coming in for the (?:test )?ride|thanks for your interest in the/.test(draft);
  return isDealerRideLogBody(String(row.body ?? "")) && isThankYou;
}

// Event-promo / sweepstakes ack BY DESIGN (PR #34/#91): a sweeps/RSVP marketing lead gets the
// one warm ack, never a sales answer — the judge reads customer vehicle interest into the form.
export function isEventPromoAckByDesign(row: ReplayRow): boolean {
  const body = String(row.body ?? "").toLowerCase();
  const draft = String(row.draft ?? "").toLowerCase();
  const isEventLead = /source:[^\n]*(sweeps|rsvp|national event|ride challenge)/.test(body);
  const isAck = /thanks for entering|good luck/.test(draft);
  return isEventLead && isAck;
}

// Manager-quoted pricing BY DESIGN (manual quote follow-up): exact prices/OTD numbers come from
// staff, never fabricated — "I'll have a/our manager pull exact pricing" is the designed answer.
export function isManagerQuotePricingPath(row: ReplayRow, judge: IntentVerdict | null | undefined): boolean {
  if (!judge || judge.addressed) return false;
  const draft = String(row.draft ?? "").toLowerCase();
  const priceAsk = /price|pricing|cost|how much|out[- ]the[- ]door|otd|mileage/i.test(String(judge.customerAsk ?? ""));
  return priceAsk && /(have (?:a|our|the) manager|manager (?:will )?pull|have (?:our|the) team confirm)[^.]{0,60}(pric|quote|number)/.test(draft);
}

// Cross-department handoff BY DESIGN: a parts/service/apparel QUESTION on any lead routes to that
// department with a handoff ack (never fabricated availability) — dept declared on the lead or not.
export function isCrossDeptHandoff(row: ReplayRow, judge: IntentVerdict | null | undefined): boolean {
  if (!judge || judge.addressed) return false;
  const draft = String(row.draft ?? "").toLowerCase();
  return /(?:our|the) (?:parts|service|apparel|motor\s*clothes) (?:department|team) (?:will )?(?:follow up|reach out|text)/.test(draft);
}

// Media-claim rows: the replay transport cannot carry attachments, so a draft that says "here is
// a photo" scores as a false claim — a harness limitation, not an agent bug. Excluded, counted.
export function isMediaClaimRow(row: ReplayRow, judge: IntentVerdict | null | undefined): boolean {
  if (!judge || judge.addressed) return false;
  const draft = String(row.draft ?? "").toLowerCase();
  const mediaAsk = /photo|picture|pic|video/i.test(String(judge.customerAsk ?? ""));
  return mediaAsk && /here (?:is|are) (?:a |the )?(photo|picture|pic|video|walkaround)/.test(draft);
}

// Deflection-with-commitment ("I'll confirm X and follow up"): the answer-don't-deflect program
// tracks these as improvement targets, but in suggest mode staff fulfill the commitment — a
// deflection is a quality gap, never a release-blocking critical.
export function isDeflectionWithCommitment(row: ReplayRow): boolean {
  const draft = String(row.draft ?? "").toLowerCase();
  return /(i['\u2019]ll|i will|going to|let me) (?:have (?:the|our) team |have (?:\w+ )?)?(confirm|check(?: on)?|find out|get|verify|look into|review)[^.]{0,80}(follow up|get back|send|let you know|reach out|text you)/.test(
    draft
  );
}

// Clarify-on-ambiguous BY DESIGN: when the customer's ask names no specific unit ("a specific
// used bike", "one of your bikes") a single clarifying question is the correct move, not a miss.
export function isAcceptedClarify(row: ReplayRow, judge: IntentVerdict | null | undefined): boolean {
  if (!judge || judge.addressed) return false;
  const draft = String(row.draft ?? "");
  const asksOneQuestion = (draft.match(/\?/g) ?? []).length >= 1 && draft.length < 260;
  // Keyed on the DRAFT's clarify shape, not the judge's phrasing (a re-rolled verdict that says
  // "asked which bike" instead of "clarifying question" was flipping this turn sweep-to-sweep).
  const clarifyShape =
    /\b(which (?:bike|model|one|unit)|do you mean|are you (?:looking|referring|asking)|what (?:bike|model|year)|a specific)\b/i.test(
      draft
    ) || /clarif/i.test(String(judge.why ?? ""));
  return asksOneQuestion && clarifyShape;
}

// The ADF intake body carries the lead's vehicle as a "Vehicle: <description>" line
// (sendgridInbound's WEB LEAD/PHONE LOG formatter). Structured extraction of our own
// intake format — not customer-intent comprehension.
export function extractAdfVehicleLabel(body: string): string | null {
  const m = String(body ?? "").match(/^\s*Vehicle:\s*(.+?)\s*$/im);
  return m ? m[1] : null;
}

// A lead-vehicle label that names NO real bike: the LIVE deflection's placeholder notion
// (modelDeflection.isPlaceholderModel — "Other"/"Full Line"/bare make) PLUS the campaign-tag
// "vehicles" Meta/prequal ADFs carry ("H-D Meta Promo", "Meta Promo Offer"). The campaign tags
// stay scorer-local so the live deflection decision is untouched (detector-only change).
export function isPlaceholderVehicleLabel(label: string | null | undefined): boolean {
  if (isPlaceholderModel(label ?? null)) return true;
  return /\b(meta\s+promo|promo\s+offer|pre-?qual)\b/i.test(String(label ?? ""));
}

// Placeholder-vehicle clarify BY DESIGN: when the ADF's Vehicle line is a placeholder
// ("Harley-Davidson Other", "H-D Meta Promo", bare make), the customer specified NO model —
// a draft asking which model they're eyeing ADDRESSES the ask (the modelDeflection rule:
// genuinely unknown → ask). The judge reads the placeholder as a SPECIFIED model and fails
// the clarify as a miss (8 of 73 fails on the 7/17 sweep). A SPECIFIC Vehicle line never
// matches, so re-asking for a model already on record still fails (the real miss class).
export function isPlaceholderVehicleClarify(row: ReplayRow, judge: IntentVerdict | null | undefined): boolean {
  if (!judge || judge.addressed) return false;
  const vehicle = extractAdfVehicleLabel(String(row.body ?? ""));
  if (vehicle == null) return false; // no Vehicle line at all -> not this class
  if (!isPlaceholderVehicleLabel(vehicle)) return false;
  const draft = String(row.draft ?? "");
  if (!/\?/.test(draft)) return false; // a which-model ask is a question
  return (
    /\b(?:which|what)\s+(?:[a-z'’-]+\s+){0,2}(?:bike|model|ride|harley)\b/i.test(draft) ||
    /\b(?:specific|particular)\s+(?:[a-z'’-]+\s+){0,1}(?:bike|model|ride|unit)\b/i.test(draft) ||
    /\b(?:bike|model)\b[^.!?]{0,50}\bin mind\b/i.test(draft)
  );
}

// Finance-policy BY DESIGN: no fabricated rates/payments — the credit-app path or a
// budget-anchoring counter-question IS the designed answer to "what are the numbers?"
export function isFinancePolicyAnswer(row: ReplayRow, judge: IntentVerdict | null | undefined): boolean {
  if (!judge || judge.addressed) return false;
  const draft = String(row.draft ?? "").toLowerCase();
  const financeAsk = /financ|payment|down payment|monthly|apr|rate|numbers|terms?|plans?/i.test(String(judge.customerAsk ?? ""));
  const policyMove =
    /credit app|pre-?qual|what monthly payment|payment (?:are you|you['\u2019]re) (?:trying|looking)|stay around|budget|(?:our )?finance (?:team|manager) (?:will )?(?:confirm|check|reach out|follow up)|have (?:our )?finance/.test(
      draft
    );
  return financeAsk && policyMove;
}

// Blocked test-ride WITH the watch offer = the Joe-approved #151 behavior (2026-07-03): we never
// book a bike we don't have; the draft explains it, offers alternates/inventory, AND offers the
// watch. The judge wants a booking anyway — that's the judge being stricter than the design.
// Charter C4.3 (stock-check-first), pinned live by test_ride_stock_check_first:eval.
//
// COPY-DRIFT REPAIR (2026-07-31): this classifier matched only the ORCHESTRATOR/regen draft
// (buildBlockedTestRideInventoryDraft). PR #367 gave the initial-ADF first touch its OWN, shorter
// unavailability copy (buildInitialUnavailableInventorySmsReply -- "I'm not seeing a 2026 Sportster
// S in stock right now. I can check similar options, or I can keep an eye out and text you IF ONE
// COMES IN") -- the same ruled behavior in different words, so it fell out of the design-accept and
// the SAME policy-correct reply began failing the release gate as a P1 (08610167776 Sanjeev,
// +16785960725 Justin, +18188420202 -- "book a test ride" / "availability" asks answered honestly).
// A scorer that fails the behavior the charter REQUIRES teaches the loop to break the charter, so
// the repair belongs here, not in the reply.
//
// Deliberately narrow so a real miss cannot hide behind it: the draft must lead with the honest
// unavailability AND offer the watch, and the judge's CUSTOMER ASK must be about
// availability/booking that bike. Keyed on the ask alone, never judge.why -- the why routinely
// tacks "...or offer to schedule" onto asks that are really about something else (+12099195457
// asked for mileage/price/year, which we still owe and which must keep failing).
export function isBlockedTestRideWithWatchOffer(row: ReplayRow, judge: IntentVerdict | null | undefined): boolean {
  if (!judge || judge.addressed) return false;
  const draft = String(row.draft ?? "").toLowerCase();
  // Orchestrator / regenerate blocked draft (buildBlockedTestRideInventoryDraft).
  if (
    /don['\u2019]t want to book you on a bike/.test(draft) &&
    /keep an eye out and text you the moment/.test(draft)
  ) {
    return true;
  }
  // Initial-ADF first-touch unavailability draft (buildInitialUnavailableInventorySmsReply, #367).
  const unavailableLead =
    /not seeing [^.]{0,60}in stock right now/.test(draft) || /is no longer available/.test(draft);
  const watchOffer = /keep an eye out and text you/.test(draft);
  const availabilityAsk = /(test ride|demo ride|book|schedul|availab|in stock)/i.test(
    String(judge.customerAsk ?? "")
  );
  return unavailableLead && watchOffer && availabilityAsk;
}

// A greeting that ADDRESSES a person by first name in the opening clause ("Good morning Scott,",
// "Hey Scott this is Mark"). Harness-local approximation of the live owner-thread step-back's
// greeting matcher (routeStateReducer.decideOwnerThreadStepBack): the live rule matches the
// KNOWN assigned-owner name; the replay row doesn't carry the owner roster, so this matches the
// greeting SHAPE and the post_sale router reason narrows it (see isExpectedSilence). Generic
// tokens ("hi there", "hey all") are excluded so a name is actually required, and the live
// rule's 3-char name floor is kept.
export function opensWithPersonNameGreeting(text: string | null | undefined): boolean {
  const m = String(text ?? "")
    .trim()
    .match(/^(?:hey|hi|hello|good\s+(?:morning|afternoon|evening)|yo|hiya)[,!. ]+([a-z][a-z'’-]{2,})\b/i);
  if (!m) return false;
  // Stoplist: generic address terms + common sentence-starters ("Hello, when does the shop
  // open?") so an ordinary message after a bare greeting never reads as a name-greeting.
  return !/^(?:there|all|guys|y'?all|everyone|team|folks|again|good|sir|ma'?am|you|are|was|were|does|did|can|could|will|would|should|just|the|this|that|thanks|thank|sorry|what|when|where|who|how|why|please|any|got|still|hope|hoping|looking|wanted|want|need|checking|question|quick)$/i.test(
    m[1]
  );
}

// Deliberate-silence BY DESIGN: states whose correct behavior is NO auto-draft (handoff family
// incl. tonight's in_process_deal, paused/closed dispositions, walk-in phone-log records). The
// replay's own classifier can't prove these; the router state on the replayed conv can.
export function isExpectedSilence(row: ReplayRow): boolean {
  if (row.verdict !== "no_response") return false;
  // Human-owned thread (staff takeover): the live system suppresses customer-facing auto replies
  // there by design — mirrors the release-gate human-mode skips (c5ae6e32/acbede8d). Keyed on the
  // row's SOURCE mode (pre-override) because the replay harness forces autopilot onto the temp
  // copy; this also retires phantoms in already-banked replay reports whose rows carry the field
  // but were classified before the harness-side carve-out learned to read it.
  if (String(row.sourceConversationMode ?? "").toLowerCase() === "human") return true;
  const mode = String(row.router?.followUpMode ?? "").toLowerCase();
  const reason = String(row.router?.followUpReason ?? "").toLowerCase();
  if (mode === "manual_handoff" || mode === "paused_indefinite") return true;
  if (/in_process_deal|walk_?in|phone_log|marketplace_relay|credit_app|dealer_ride|handoff/.test(reason)) return true;
  // Pure reaction turns — an iOS/Twilio tapback echo (`Liked "…"`) or an emoji-only body — are
  // a designed no-reply signal (AGENTS.md "Twilio Reaction No-Reply Guardrail"); the customer
  // pressed a button, they didn't write a word. Reuses the eval-pinned scorer exclusions
  // (scoringExclusions.ts) so the flywheel can't drift from the live guard's notion
  // (+19198105169, `Liked “Gotcha — yes…”` on an inventory-watch thread, 7/23 sweep).
  const body = String(row.body ?? "");
  if (isQuotedReactionEchoInbound(body) || isBareReactionOnlyInbound(body)) return true;
  // Owner-thread step-back on a post_sale thread (Joe, 2026-07-09): a customer who opens by
  // greeting their salesperson BY NAME on a human-owned post-sale thread is talking to that
  // person — the designed behavior is NO auto-draft (the owner gets a reply task instead), so
  // the replayed silence is correct (+17166035402, "Good morning Scott, the delivery went
  // well…"). Fail-direction: this HIDES silences from scoring, so BOTH conditions are required
  // — a post_sale customer message that doesn't greet a person still fails as unexpected
  // silence, and a name-greeting on a normal sales thread still fails.
  if (reason === "post_sale" && opensWithPersonNameGreeting(body)) return true;
  // A Dealer Lead App post-ride survey log is staff-filed and never a customer question. The
  // FIRST one earns its one by-design thank-you (isDealerRideThankYou); a REPEAT log correctly
  // stays silent (the thank-you already went out). Body-keyed so it holds even when the replayed
  // router state doesn't carry a dealer_ride reason (the case the reason-list above misses).
  return isDealerRideLogBody(String(row.body ?? ""));
}

// Structured extraction of our own ADF intake format: the free-text Inquiry section (everything
// after the "Inquiry:" header). Not customer-intent comprehension — the intake formatter wrote it.
export function extractAdfInquirySection(body: string): string | null {
  const m = String(body ?? "").match(/\bInquiry:\s*\n?([\s\S]*)$/i);
  return m ? m[1].trim() : null;
}

// An ADF web lead whose Inquiry section carries NO customer question — empty, or nothing but
// vendor placeholders ("Lead arrived" — the AutoDealers.Digital shape — "None", a bare
// preferred-contact line). The customer clicked a listing; they wrote nothing.
export function isEmptyInquiryAdfBody(body: string): boolean {
  const b = String(body ?? "");
  if (!/^\s*WEB LEAD \(ADF\)/i.test(b)) return false;
  const inquiry = extractAdfInquirySection(b);
  if (inquiry == null) return false; // no Inquiry section at all -> can't prove, not this class
  const lines = inquiry.split(/\n/).map(l => l.trim()).filter(Boolean);
  return lines.every(
    l => /^lead arrived\.?$/i.test(l) || /^none\.?$/i.test(l) || /^preferred method of contact\b/i.test(l)
  );
}

// First-touch intro on an empty-Inquiry ADF BY DESIGN: when the customer asked NOTHING, the
// Joe-approved first touch is the intro + "Thanks for your inquiry about the <bike>" + the
// availability-true invite (sendgridInbound's isPurchaseIntentLead builder, pinned by
// tone_quality:fixture_eval). The judge invents asks the customer never made ("didn't confirm
// availability/price/financing") and fails it as minor (4 of the 7/23 sweep's fails —
// adf_ref_11626/11617/11613/11592). Fail-direction: ONLY a judge-minor is excused — a
// judge-major on the same shape (wrong bike, fabricated claim) still fails — and a body whose
// Inquiry carries a real question never matches, so ignoring an actual ask stays a miss.
export function isEmptyInquiryAdfIntroByDesign(row: ReplayRow, judge: IntentVerdict | null | undefined): boolean {
  if (!judge || judge.addressed || judge.severity !== "minor") return false;
  if (!isEmptyInquiryAdfBody(String(row.body ?? ""))) return false;
  const draft = String(row.draft ?? "").toLowerCase();
  if (!/thanks for your inquiry about the /.test(draft)) return false;
  return (
    // Copy swept to rep voice 2026-08-01 ("just say the word" -> "just let me know"); match BOTH
    // so this detector keeps seeing the boilerplate in historical rows AND in new drafts.
    /just say the word/.test(draft) ||
    /just let me know/.test(draft) ||
    /currently on hold, but i can text you first/.test(draft) ||
    /no longer available, but i can help/.test(draft)
  );
}

// Non-buyer survey ack BY DESIGN (Elizabeth Klapa class, 2026-06-25): a Dealer Lead App
// passenger/marketing survey whose respondent is explicitly NOT a buyer gets the one warm,
// no-pressure acknowledgement — deliberately NO models, prices, lessons, or next steps (those
// are exactly the out-of-context failure modes for a self-declared non-buyer). The judge wants
// "helpful info or next steps" and fails the designed restraint as minor (+17168618586, Susan,
// 7/23 sweep). Matched on the pinned buildNonBuyerSurveyAck copy (non_buyer_survey_ack:eval)
// on a Dealer Lead App body, judge-minor only — a major on the same thread still fails.
export function isNonBuyerSurveyAckByDesign(row: ReplayRow, judge: IntentVerdict | null | undefined): boolean {
  if (!judge || judge.addressed || judge.severity !== "minor") return false;
  if (!/dealer lead app/i.test(String(row.body ?? ""))) return false;
  const draft = String(row.draft ?? "").toLowerCase();
  return /no pressure at all/.test(draft) && /bike of your own down the road/.test(draft);
}

// Room58 "Standard" handoff ack BY DESIGN (+18283619458 Larry Silvers, 7/31 sweep, P1). Room58 -
// Standard is the generic "Contact Us" web form: the customer picks no bike ("Full Line") and
// writes NOTHING. Since 2026-03-12 (`c682179b`) that lead is deliberately NOT answered by the
// agent — sendgridInbound's isRoom58Standard branch files a todo, stops the cadence, sets
// followUpMode manual_handoff and sends only the pinned ack, because a human has to find out what
// the customer actually wants. The judge grades it against a 1:1 sales reply, invents an ask the
// customer never made ("likely requesting availability/pricing/next steps") and fails it MAJOR —
// so a deliberate design re-fires as a P1 every night and can never be "fixed" in code.
//
// Fail-direction (why accepting a MAJOR is safe here, unlike the minor-only accepts above): the
// gate is the BODY, not the severity. `isEmptyInquiryAdfBody` requires the Inquiry section to be
// present and empty, so the instant a Room58 customer writes a real question the accept stops
// matching and an unanswered ask fails exactly as it does today. The draft must also still be the
// pinned ack copy, so if that copy is ever reworded — or the branch is changed to actually engage
// the lead — this detector falls out and the rows surface again ([[scorer-copy-drift-design-accept]]).
export function isRoom58StandardHandoffAckByDesign(
  row: ReplayRow,
  judge: IntentVerdict | null | undefined
): boolean {
  if (!judge || judge.addressed) return false;
  const body = String(row.body ?? "");
  if (!/source:\s*room58 - standard/i.test(body)) return false;
  if (!isEmptyInquiryAdfBody(body)) return false;
  const draft = String(row.draft ?? "").toLowerCase();
  return /i got your inquiry/.test(draft) && /make sure the team follows up soon/.test(draft);
}

/** A row worth spending a judge call on: it produced a draft on an actionable inbound. */
export function isJudgeWorthy(row: ReplayRow): boolean {
  if (!row.draft || !String(row.draft).trim()) return false;
  if (row.verdict !== "candidate_safe" && row.verdict !== "review") return false;
  return !isNonActionableInbound(String(row.body ?? ""));
}

/**
 * Fold a replay verdict + optional judge verdict into pass/critical. Fail-direction: anything
 * ambiguous scores as FAIL (the loop investigates), but only judge-major and hard errors are
 * CRITICAL (the T1 gate) — deterministic review reasons alone are reviewable, not release-blocking.
 */
export function scoreTurn(row: ReplayRow, judge: IntentVerdict | null | undefined): TurnScore {
  const reviewReasons = (row.reviewReasons ?? []).filter(Boolean);
  const judgedMajor = judge ? !judge.addressed && judge.severity === "major" : false;
  const judgedMinor = judge ? !judge.addressed && judge.severity === "minor" : false;
  const hardError = row.verdict === "error";
  const unexpectedSilence = row.verdict === "no_response";
  const judgedAddressed = judge ? judge.addressed : false;
  const pass =
    !hardError &&
    !unexpectedSilence &&
    !judgedMajor &&
    !judgedMinor &&
    (row.verdict === "candidate_safe" ||
      row.verdict === "expected_no_response" ||
      // "review" is the deterministic classifier's sensitive-topic CAUTION label (finance/
      // scheduling); when the judge confirms the draft addressed the ask, caution != failure.
      (row.verdict === "review" && judgedAddressed));
  return {
    turnKey: turnKeyOf(row),
    conversationId: row.conversationId,
    pass,
    critical: judgedMajor || hardError,
    verdict: row.verdict,
    reviewReasons,
    judge: judge ?? null,
    body: String(row.body ?? "").replace(/\s+/g, " ").slice(0, 200),
    draft: row.draft ? String(row.draft).replace(/\s+/g, " ").slice(0, 200) : null,
    ...(turnTimeOf(row) ? { turnAt: turnTimeOf(row) } : {})
  };
}

export type ScoreAdjustment =
  | "none"
  | "excluded_test_lead"
  | "excluded_anachronistic"
  | "design_accepted_handoff"
  | "deflection_downgraded"
  | "nondeterministic_recovered"
  | "excluded_harness_error";

/**
 * Apply the design-policy post-classification to a raw score (fidelity v2). Pure + auditable:
 * every adjustment is named on the score so the summary can count them — nothing is silently
 * dropped. Order: test leads are excluded outright; a turn the HARNESS never managed to run is
 * excluded as unmeasured; a policy-correct department handoff that the judge flagged becomes a
 * PASS (accepted design); a deflection-with-commitment loses CRITICAL status (quality gap for
 * the answer-don't-deflect program, not a release blocker).
 */
export function adjustScore(score: TurnScore, row: ReplayRow): TurnScore & { adjustment: ScoreAdjustment; excluded?: boolean } {
  if (isTestLeadRow(row)) {
    return { ...score, adjustment: "excluded_test_lead", excluded: true };
  }
  // The temporary API never booted / never loaded the prepared thread, so this turn produced NO
  // evidence about the agent in either direction. Scoring it would make an ops incident (a deploy
  // rewriting node_modules mid-sweep) read as a release-blocking CRITICAL and mint a per-conversation
  // "draft: (none)" finding against a reply the agent was never asked to write — see
  // classifyReplayErrorCause. Excluded, never silently: counted as summary.harnessErrors, and if
  // enough turns are lost the whole sweep stops being able to clear the gate (COVERAGE_FLOOR).
  if (score.verdict === "error" && classifyReplayErrorCause(row.error) === "harness") {
    return { ...score, critical: false, adjustment: "excluded_harness_error", excluded: true };
  }
  if (!score.pass && isExpectedSilence(row)) {
    return { ...score, pass: true, critical: false, adjustment: "design_accepted_handoff" };
  }
  if (!score.pass && score.judge && !score.judge.addressed && isDesignAcceptedHandoff(row)) {
    return { ...score, pass: true, critical: false, adjustment: "design_accepted_handoff" };
  }
  if (!score.pass && isAcceptedClarify(row, score.judge)) {
    return { ...score, pass: true, critical: false, adjustment: "design_accepted_handoff" };
  }
  if (!score.pass && isPlaceholderVehicleClarify(row, score.judge)) {
    return { ...score, pass: true, critical: false, adjustment: "design_accepted_handoff" };
  }
  if (!score.pass && isFinancePolicyAnswer(row, score.judge)) {
    return { ...score, pass: true, critical: false, adjustment: "design_accepted_handoff" };
  }
  if (!score.pass && isBlockedTestRideWithWatchOffer(row, score.judge)) {
    return { ...score, pass: true, critical: false, adjustment: "design_accepted_handoff" };
  }
  if (!score.pass && isDealerRideThankYou(row)) {
    return { ...score, pass: true, critical: false, adjustment: "design_accepted_handoff" };
  }
  if (!score.pass && isEventPromoAckByDesign(row)) {
    return { ...score, pass: true, critical: false, adjustment: "design_accepted_handoff" };
  }
  if (!score.pass && isEmptyInquiryAdfIntroByDesign(row, score.judge)) {
    return { ...score, pass: true, critical: false, adjustment: "design_accepted_handoff" };
  }
  if (!score.pass && isNonBuyerSurveyAckByDesign(row, score.judge)) {
    return { ...score, pass: true, critical: false, adjustment: "design_accepted_handoff" };
  }
  if (!score.pass && isRoom58StandardHandoffAckByDesign(row, score.judge)) {
    return { ...score, pass: true, critical: false, adjustment: "design_accepted_handoff" };
  }
  if (!score.pass && isManagerQuotePricingPath(row, score.judge)) {
    return { ...score, pass: true, critical: false, adjustment: "design_accepted_handoff" };
  }
  if (!score.pass && isCrossDeptHandoff(row, score.judge)) {
    return { ...score, pass: true, critical: false, adjustment: "design_accepted_handoff" };
  }
  if (!score.pass && isMediaClaimRow(row, score.judge)) {
    return { ...score, adjustment: "excluded_test_lead", excluded: true };
  }
  if (score.critical && isDeflectionWithCommitment(row)) {
    return { ...score, critical: false, adjustment: "deflection_downgraded" };
  }
  return { ...score, adjustment: "none" };
}

export type BaselineEntry = { pass: boolean; critical: boolean; at: string; draftSig?: string };

// Agent self-intro clauses ("it's Alexandra over at American Harley-Davidson", "this is Scott
// at ...", "Giovanni here from ...") normalize to one token: a persona/rep RENAME rewrites every
// opener's text with zero routing/content change — without this, a rename flips every opener
// into a "changed draft" and floods the regression gate (7/6 sweep: ~13 of 16 "regressions"
// were the Brooke→Alexandra rename). Runs on OUR OWN drafts inside an offline scorer — not
// customer-intent comprehension, so a deterministic pattern is the right tool (AGENTS.md:
// structured extraction). Idempotent, so legacy baseline sigs renormalize at compare time.
export function stripAgentIntro(text: string): string {
  return (
    text
      // "this is Giovanni at American Harley-Davidson" (bare at/from is the this-is idiom)
      .replace(
        /\bthis is\s+[a-z][a-z.’'-]*(?:\s+[a-z][a-z.’'-]*)?\s+(?:over at|here at|here from|at|from)\s+[^.!?]{0,60}/g,
        "<agent-intro>"
      )
      // "it's Alexandra over at American Harley-Davidson" — bare at/from EXCLUDED here so
      // content-bearing phrases ("it's available at the dealership") keep their content
      .replace(
        /\bit[’']?s\s+[a-z][a-z.’'-]*(?:\s+[a-z][a-z.’'-]*)?\s+(?:over at|here at|here from)\s+[^.!?]{0,60}/g,
        "<agent-intro>"
      )
      // "Scott here from American H-D"
      .replace(/\b[a-z][a-z.’'-]*\s+here\s+(?:at|from)\s+[^.!?]{0,60}/g, "<agent-intro>")
      .replace(/\s+/g, " ")
      .trim()
  );
}

// Normalized draft signature: strips dates/times/numbers/URLs so time-sensitive content (slot
// offers, "Wed, Mar 11", prices) doesn't read as a code change between sweeps, and strips the
// agent self-intro so persona renames don't.
export function draftSignature(draft: string | null | undefined): string {
  return stripAgentIntro(String(draft ?? "").toLowerCase())
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+[a-z]{3,9}\s+\d{1,2}\b/g, "<date>")
    .replace(/\b\d{1,2}:\d{2}\s*(am|pm)?\b/g, "<time>")
    .replace(/\b\d[\d,.]*\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}
export type Baseline = Record<string, BaselineEntry>;

/**
 * Turns that PASSED in the previous baseline and FAIL now WITH a materially changed draft —
 * the code-caused regression set (T3). A pass->fail flip on an UNCHANGED draft signature is
 * judge nondeterminism, returned separately as flaky so it can be counted, not gate-failed.
 */
export function diffAgainstBaseline(
  scores: TurnScore[],
  baseline: Baseline | null | undefined
): { regressions: TurnScore[]; flaky: TurnScore[] } {
  if (!baseline) return { regressions: [], flaky: [] };
  const regressions: TurnScore[] = [];
  const flaky: TurnScore[] = [];
  for (const s of scores) {
    const prev = baseline[s.turnKey];
    if (!prev || prev.pass !== true || s.pass) continue;
    // Renormalize the STORED sig too (stripAgentIntro is idempotent): baselines written before
    // the intro normalization — or before a persona rename — must not read as changed drafts.
    const prevSig = prev.draftSig == null ? null : stripAgentIntro(prev.draftSig);
    const sigChanged = prevSig != null && prevSig !== draftSignature(s.draft);
    if (sigChanged || prevSig == null) regressions.push(s);
    else flaky.push(s);
  }
  return { regressions, flaky };
}

/**
 * Confirm-on-refail decision (pure). One replay sample of a nondeterministic pipeline is weak
 * evidence: LLM routing parsers flip on borderline turns, and a single unlucky sample would
 * BLOCK the release gate with a phantom regression (7/6 sweep: the appointment-status and
 * compliment-hijack "regressions" reproduced 0/6 on re-runs). A candidate regression stays a
 * regression only when a SECOND, independent replay of the same turn also fails.
 * FAIL DIRECTION: a missing or unscoreable rerun CONFIRMS the regression — we never silently
 * drop a potential code regression because the confirmation pass couldn't reproduce the turn.
 */
export type RefailOutcome = "confirmed" | "recovered";
export function resolveRefailOutcome(args: { rerunFound: boolean; rerunPass: boolean }): RefailOutcome {
  if (!args.rerunFound) return "confirmed";
  return args.rerunPass ? "recovered" : "confirmed";
}

export function mergeBaseline(prev: Baseline | null | undefined, scores: TurnScore[], atIso: string): Baseline {
  const next: Baseline = { ...(prev ?? {}) };
  for (const s of scores) {
    next[s.turnKey] = { pass: s.pass, critical: s.critical, at: atIso, draftSig: draftSignature(s.draft) };
  }
  return next;
}

export type FlywheelFinding = {
  convId: string;
  leadKey: string;
  dimension: "corpus_replay_regression" | "corpus_replay_judge_fail" | "corpus_replay_error";
  severity: "P1" | "P2";
  healed: false;
  occurredAt: string;
  category: "reply";
  detail: string;
  /**
   * The deployed commit these verdicts were rendered against. `occurredAt` only says when the
   * sweep ran; a sweep is recent while its verdict is already superseded once main moves and
   * redeploys (anomalyClassifier.isSupersededGrade). Omitted when the commit can't be resolved —
   * unknown must never read as "graded against current code".
   */
  gradedAtCommit?: string;
};

export function buildFindings(
  scores: Array<TurnScore & { adjustment?: ScoreAdjustment; excluded?: boolean }>,
  regressions: TurnScore[],
  atIso: string,
  gradedAtCommit?: string | null
): FlywheelFinding[] {
  const regressionKeys = new Set(regressions.map(r => r.turnKey));
  const out: FlywheelFinding[] = [];
  for (const s of scores) {
    if (s.pass) continue;
    // Belt and braces with main()'s `!s.excluded` filter: a turn the harness never ran has no
    // conversation-level story to tell, so it must not mint a "draft: (none)" finding blaming the
    // agent — regardless of which caller assembled this list.
    if (s.excluded === true || s.adjustment === "excluded_harness_error") continue;
    const isRegression = regressionKeys.has(s.turnKey);
    const dimension: FlywheelFinding["dimension"] =
      s.verdict === "error" ? "corpus_replay_error" : isRegression ? "corpus_replay_regression" : "corpus_replay_judge_fail";
    const why = s.judge && !s.judge.addressed ? `${s.judge.customerAsk} — ${s.judge.why}` : s.reviewReasons.join("; ") || s.verdict;
    out.push({
      convId: s.conversationId,
      leadKey: s.conversationId,
      dimension,
      severity: s.critical || isRegression ? "P1" : "P2",
      healed: false,
      // The TURN's own time when we can resolve it, the sweep's clock only as a fallback. See
      // turnTimeOf: stamping the run made every replay finding permanently "new", so a disposed
      // key resurfaced as `regression-of-disposed` after every nightly and could never settle.
      // Unknown keeps atIso — recent, therefore still visible (the noisier, safer direction).
      occurredAt: s.turnAt ?? atIso,
      category: "reply",
      detail: `[replay ${s.turnKey}] customer: "${s.body}" → draft: "${s.draft ?? "(none)"}" — ${why}`.slice(0, 480),
      ...(String(gradedAtCommit ?? "").trim() ? { gradedAtCommit: String(gradedAtCommit).trim() } : {})
    });
  }
  return out;
}

export type FlywheelSummary = {
  generatedAt: string;
  replaySource: string;
  totalTurns: number;
  excludedTestLeads: number;
  excludedAnachronistic: number;
  /** Turns the harness never managed to run (boot/infra), so they carry no verdict. */
  harnessErrors: number;
  /** measured / attempted. Below COVERAGE_FLOOR the sweep cannot clear the gate. */
  coverage: number;
  designAccepted: number;
  deflectionsDowngraded: number;
  judged: number;
  judgeSkippedByCap: number;
  passed: number;
  failed: number;
  criticals: number;
  regressions: number;
  flakyJudgeFlips: number;
  /** Candidate regressions whose confirmation re-replay PASSED — parser nondeterminism, not code. */
  nondeterministicRecovered: number;
  passRate: number;
  thresholds: {
    gate_criticals_zero: boolean; // BLOCKING
    gate_regressions_zero: boolean; // BLOCKING
    gate_coverage_complete: boolean; // BLOCKING — too much of the corpus went unmeasured to judge
    gate_pass: boolean; // all three blocking bars green this sweep
    trend_pass_rate: number; // tracked vs TREND_PASS_RATE_TARGET, never blocking
    trend_on_target: boolean;
  };
};

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const replayJson = flag("replay-json");
  const outDir = path.resolve(flag("out-dir") ?? "reports/corpus_replay");
  const maxJudge = Math.max(0, Number(flag("max-judge") ?? 400) || 400);
  if (!replayJson) {
    console.error("corpus_replay_flywheel requires --replay-json <inbound-shadow-*.json> (or --self-test)");
    process.exit(2);
  }
  if (process.env.LLM_ENABLED !== "1" || !process.env.OPENAI_API_KEY) {
    console.error("flywheel needs LLM_ENABLED=1 and OPENAI_API_KEY for judging.");
    process.exit(2);
  }

  const report = JSON.parse(fs.readFileSync(replayJson, "utf8"));
  const rows: ReplayRow[] = Array.isArray(report?.cases) ? report.cases : [];
  const atIso = new Date().toISOString();

  // Judge context from the snapshot: the prior messages before the replayed turn — without it
  // the judge misreads context-dependent replies (cohort-1 calibration).
  const dataDir = flag("data-dir") ?? String(report?.sourceDataDir ?? "");
  const contextByConv = new Map<string, Array<{ direction?: string; body?: string; at?: string }>>();
  // A walk-in lead's ADF "Inquiry" is a salesperson's log about an in-store visit, not the
  // customer's words. The judge must be told, or it invents a customer ask and fails the reply for
  // not fulfilling it (+17169705448 — see describeWalkInNoteProvenance).
  const leadByConv = new Map<string, { walkIn?: boolean; walkInComment?: string }>();
  const snapPath = dataDir ? path.join(dataDir, "conversations.json") : "";
  if (snapPath && fs.existsSync(snapPath)) {
    const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));
    for (const c of snap?.conversations ?? []) {
      contextByConv.set(String(c?.id ?? ""), Array.isArray(c?.messages) ? c.messages : []);
      if (c?.lead) leadByConv.set(String(c?.id ?? ""), c.lead);
    }
  }
  const provenanceFor = (row: ReplayRow): string | null =>
    describeWalkInNoteProvenance({
      body: row.body,
      walkIn: leadByConv.get(String(row.conversationId ?? ""))?.walkIn,
      walkInComment: leadByConv.get(String(row.conversationId ?? ""))?.walkInComment
    });
  const contextFor = (row: ReplayRow): string[] => {
    const msgs = contextByConv.get(String(row.conversationId ?? "")) ?? [];
    const cutMs = Date.parse(String(row.messageAt ?? ""));
    const prior = msgs.filter(m => {
      const t = Date.parse(String(m?.at ?? ""));
      return Number.isFinite(t) && Number.isFinite(cutMs) ? t < cutMs : false;
    });
    return prior.slice(-6).map(m => `${m?.direction === "in" ? "in" : "out"}: ${String(m?.body ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
  };

  // Judge (cost-capped). One intent-handled call per judge-worthy row. Test leads are never
  // worth a judge call.
  const judgeWorthy = rows.filter(r => isJudgeWorthy(r) && !isTestLeadRow(r));
  const toJudge = judgeWorthy.slice(0, maxJudge);
  const verdicts = new Map<string, IntentVerdict | null>();
  // Judge cache keyed by turnKey + draft hash: classifier-only iterations re-score for free;
  // a turn re-judges ONLY when its draft changed (i.e., after a code fix).
  const cachePath = path.join(outDir, "judge_cache.json");
  // The provenance marker is part of the key: a cached verdict judged WITHOUT it graded a
  // different question, so those rows must re-judge even though the draft is unchanged.
  const draftHash = (row: ReplayRow) =>
    `${turnKeyOf(row)}##${String(row.draft ?? "").replace(/\s+/g, " ").trim().slice(0, 300)}${provenanceFor(row) ? "##walkin-prov" : ""}`;
  const cache: Record<string, IntentVerdict | null> = fs.existsSync(cachePath)
    ? JSON.parse(fs.readFileSync(cachePath, "utf8"))
    : {};
  let judged = 0;
  let cacheHits = 0;
  const judgeWithCache = async (row: ReplayRow): Promise<IntentVerdict | null> => {
    const ck = draftHash(row);
    if (ck in cache) {
      cacheHits += 1;
      return cache[ck];
    }
    const candidate: IntentJudgeCandidate = {
      convId: row.conversationId,
      at: row.messageAt ?? atIso,
      inboundText: row.body,
      replyText: String(row.draft ?? ""),
      replyKind: "draft",
      context: contextFor(row),
      inboundProvenance: provenanceFor(row)
    };
    try {
      const v = await realJudge(candidate);
      cache[ck] = v;
      judged += 1;
      return v;
    } catch (err: any) {
      console.warn(`[flywheel] judge failed for ${turnKeyOf(row)}: ${err?.message ?? err}`);
      return null;
    }
  };
  for (const row of toJudge) {
    verdicts.set(turnKeyOf(row), await judgeWithCache(row));
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify(cache)}\n`);
  if (cacheHits) console.log(`[flywheel] judge cache hits: ${cacheHits}`);

  // State-anachronism guard: the sandbox replays each turn against the conversation's FINAL
  // snapshot state, so any turn that is NOT the conversation's last inbound sees future context
  // (later appointments, later decisions) and cannot be judged fairly (cohort-1 example: a June
  // scheduling turn "confirmed" the July appointment that was booked days later). Only the last
  // inbound per conversation is scored; earlier turns are counted, not judged.
  const lastInboundAt = new Map<string, number>();
  for (const [convId, msgs] of contextByConv) {
    let last = NaN;
    for (const m of msgs) {
      if ((m as any)?.direction !== "in") continue;
      const t = Date.parse(String(m?.at ?? ""));
      if (Number.isFinite(t) && (!Number.isFinite(last) || t > last)) last = t;
    }
    if (Number.isFinite(last)) lastInboundAt.set(convId, last);
  }
  const outboundAtByConv = new Map<string, number[]>();
  for (const [convId, msgs] of contextByConv) {
    const outs: number[] = [];
    for (const m of msgs) {
      if ((m as any)?.direction !== "out") continue;
      const t = Date.parse(String(m?.at ?? ""));
      if (Number.isFinite(t)) outs.push(t);
    }
    outboundAtByConv.set(convId, outs);
  }
  const isAnachronistic = (row: ReplayRow): boolean => {
    const rowAt = Date.parse(String(row.messageAt ?? ""));
    if (!Number.isFinite(rowAt)) return false; // can't prove → score it
    const lastIn = lastInboundAt.get(String(row.conversationId ?? ""));
    if (Number.isFinite(lastIn) && rowAt < (lastIn as number) - 1000) return true;
    // The conversation materially moved PAST this turn only when a real staff BACK-AND-FORTH
    // followed it (Peter Massaro "forty eight": price sent + follow-ups within days — replaying
    // against July state is unfair). TWO OR MORE outbounds within 7 days of the turn = the deal
    // advanced; a LONE outbound after it is a cadence drip and the turn is still fair to score
    // (the 24h single-outbound rule over-excluded 302 of 617 fair turns — every cadence tail).
    const outs = outboundAtByConv.get(String(row.conversationId ?? "")) ?? [];
    const withinWeek = outs.filter(t => t > rowAt + 1000 && t - rowAt <= 7 * 24 * 60 * 60 * 1000);
    if (withinWeek.length >= 2) return true;
    return false;
  };
  const adjustedAll = rows.map(row => {
    if (isAnachronistic(row)) {
      return { ...scoreTurn(row, verdicts.get(turnKeyOf(row))), adjustment: "excluded_anachronistic" as const, excluded: true };
    }
    return adjustScore(scoreTurn(row, verdicts.get(turnKeyOf(row))), row);
  });
  const excludedTestLeads = adjustedAll.filter(s => s.adjustment === "excluded_test_lead").length;
  const excludedAnachronistic = adjustedAll.filter(s => s.adjustment === "excluded_anachronistic").length;
  const harnessErrors = adjustedAll.filter(s => s.adjustment === "excluded_harness_error").length;
  const scores = adjustedAll.filter(s => !s.excluded);
  const designAccepted = scores.filter(s => s.adjustment === "design_accepted_handoff").length;
  const deflectionsDowngraded = scores.filter(s => s.adjustment === "deflection_downgraded").length;
  const baselinePath = path.join(outDir, "baseline.json");
  const prevBaseline: Baseline | null = fs.existsSync(baselinePath)
    ? JSON.parse(fs.readFileSync(baselinePath, "utf8"))
    : null;
  const { regressions, flaky } = diffAgainstBaseline(scores, prevBaseline);

  // Confirm-on-refail: re-replay ONLY the regressed conversations against the SAME snapshot
  // (still on disk — the nightly removes it after this process exits). A candidate regression
  // survives only if the second, independent sample also fails (resolveRefailOutcome). Passing
  // reruns replace the unlucky sample in `scores` so passRate/criticals/baseline reflect the
  // CONFIRMED state, and are counted honestly as nondeterministicRecovered — never dropped
  // silently. FLYWHEEL_REFAIL=0 is the kill switch.
  let nondeterministicRecovered = 0;
  let confirmedRegressions = regressions;
  const refailEnabled =
    regressions.length > 0 && !!snapPath && fs.existsSync(snapPath) && process.env.FLYWHEEL_REFAIL !== "0";
  if (refailEnabled) {
    const convIds = [...new Set(regressions.map(r => r.conversationId))];
    console.log(`[flywheel] confirm-on-refail: re-replaying ${convIds.length} regressed conversation(s)`);
    const rerunDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-refail-"));
    try {
      execFileSync(
        "npx",
        [
          "tsx",
          "scripts/inbound_shadow_replay.ts",
          "--data-dir",
          dataDir,
          "--since-days",
          "3650",
          "--limit",
          String(Math.max(convIds.length, 1)),
          "--last-turn-only",
          "--conv",
          convIds.join(","),
          "--out-dir",
          rerunDir
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 }
      );
      const rerunFile = fs
        .readdirSync(rerunDir)
        .filter(f => f.startsWith("inbound-shadow-") && f.endsWith(".json"))
        .sort()
        .pop();
      const rerunRows: ReplayRow[] = rerunFile
        ? (JSON.parse(fs.readFileSync(path.join(rerunDir, rerunFile), "utf8"))?.cases ?? [])
        : [];
      const rerunByKey = new Map(rerunRows.map(r => [turnKeyOf(r), r] as const));
      const stillRegressed: typeof regressions = [];
      for (const reg of regressions) {
        const rr = rerunByKey.get(reg.turnKey);
        let rerunScore: (TurnScore & { adjustment: ScoreAdjustment; excluded?: boolean }) | null = null;
        if (rr) {
          const verdict = isJudgeWorthy(rr) && !isTestLeadRow(rr) ? await judgeWithCache(rr) : null;
          rerunScore = adjustScore(scoreTurn(rr, verdict), rr);
        }
        // An excluded rerun (test-lead/design classifier) counts as recovered — exclusion means
        // the turn shouldn't gate at all, which is not evidence of a code regression.
        const rerunPass = !!rerunScore && (rerunScore.excluded === true || rerunScore.pass);
        if (resolveRefailOutcome({ rerunFound: !!rerunScore, rerunPass }) === "recovered") {
          nondeterministicRecovered += 1;
          const idx = scores.findIndex(s => s.turnKey === reg.turnKey);
          if (idx >= 0 && rerunScore) {
            scores[idx] = { ...rerunScore, adjustment: "nondeterministic_recovered", excluded: undefined };
          }
        } else {
          stillRegressed.push(reg);
        }
      }
      confirmedRegressions = stillRegressed;
      fs.writeFileSync(cachePath, `${JSON.stringify(cache)}\n`);
      console.log(
        `[flywheel] confirm-on-refail: ${nondeterministicRecovered}/${regressions.length} candidate regression(s) did not reproduce (nondeterministic) — ${confirmedRegressions.length} confirmed`
      );
    } finally {
      // Sync teardown — an async rm races the store's flush and flakes (temp-store lesson, 7/4).
      fs.rmSync(rerunDir, { recursive: true, force: true });
    }
  }

  // The commit these verdicts grade. The nightly resolves the deployed HEAD and passes it; a
  // direct/manual run without the flag simply omits it (unknown, never guessed).
  const findings = buildFindings(scores, confirmedRegressions, atIso, flag("graded-at-commit"));

  const failed = scores.filter(s => !s.pass);
  const summary: FlywheelSummary = {
    generatedAt: atIso,
    replaySource: replayJson,
    totalTurns: scores.length,
    excludedTestLeads,
    excludedAnachronistic,
    harnessErrors,
    coverage: computeCoverage(scores.length, harnessErrors),
    designAccepted,
    deflectionsDowngraded,
    judged,
    judgeSkippedByCap: Math.max(0, judgeWorthy.length - toJudge.length),
    passed: scores.length - failed.length,
    failed: failed.length,
    criticals: scores.filter(s => s.critical).length,
    regressions: confirmedRegressions.length,
    flakyJudgeFlips: flaky.length,
    nondeterministicRecovered,
    passRate: scores.length ? Math.round(((scores.length - failed.length) / scores.length) * 1000) / 1000 : 1,
    thresholds: (() => {
      const criticalsZero = scores.every(s => !s.critical);
      const regressionsZero = confirmedRegressions.length === 0;
      const coverageComplete = computeCoverage(scores.length, harnessErrors) >= COVERAGE_FLOOR;
      const rate = scores.length ? (scores.length - failed.length) / scores.length : 1;
      return {
        gate_criticals_zero: criticalsZero,
        gate_regressions_zero: regressionsZero,
        gate_coverage_complete: coverageComplete,
        gate_pass: criticalsZero && regressionsZero && coverageComplete,
        trend_pass_rate: Math.round(rate * 1000) / 1000,
        trend_on_target: rate >= TREND_PASS_RATE_TARGET
      };
    })()
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(baselinePath, `${JSON.stringify(mergeBaseline(prevBaseline, scores, atIso), null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "latest.json"), `${JSON.stringify({ generatedAt: atIso, anomalies: findings }, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "scores.json"), `${JSON.stringify(scores, null, 2)}\n`);
  console.log(
    `flywheel: ${summary.totalTurns} turns, ${summary.judged} judged (${summary.judgeSkippedByCap} over cap), ` +
      `pass ${summary.passed}/${summary.totalTurns} (${(summary.passRate * 100).toFixed(1)}%), ` +
      `criticals ${summary.criticals}, regressions ${summary.regressions}` +
      (summary.harnessErrors
        ? `, UNMEASURED ${summary.harnessErrors} turn(s) lost to harness/boot failures (coverage ${(summary.coverage * 100).toFixed(1)}%)`
        : "") +
      ` — GATE:${summary.thresholds.gate_pass ? "PASS" : "fail"} (criticals ${summary.thresholds.gate_criticals_zero ? "ok" : "BLOCK"}, regressions ${summary.thresholds.gate_regressions_zero ? "ok" : "BLOCK"}, coverage ${summary.thresholds.gate_coverage_complete ? "ok" : "BLOCK"}) ` +
      `TREND:${(summary.thresholds.trend_pass_rate * 100).toFixed(1)}% ${summary.thresholds.trend_on_target ? "on-target" : `below ${TREND_PASS_RATE_TARGET * 100}%`}`
  );
}

function selfTest() {
  const assert = (cond: boolean, label: string) => {
    if (!cond) {
      console.error(`SELF-TEST FAIL: ${label}`);
      process.exit(1);
    }
  };
  const mk = (over: Partial<ReplayRow>): ReplayRow => ({
    conversationId: "+15550001111",
    messageId: "SM1",
    body: "is the low rider st still available?",
    draft: "Yes — the 2026 Low Rider ST is in stock. Want photos?",
    verdict: "candidate_safe",
    reviewReasons: [],
    ...over
  });

  // turn keys are stable and anchored
  assert(turnKeyOf(mk({})) === "+15550001111::SM1", "turn key anchors on messageId");
  assert(turnKeyOf(mk({ messageId: undefined, messageIndex: 4 })) === "+15550001111::idx4", "falls back to index");

  // ── A replay finding is stamped with the TURN's time, never the sweep's (2026-08-04) ──────
  // Production turns that proved it: both were disposed, both came back as `regression-of-disposed`
  // purely because the nightly re-stamped them with its own clock (2026-08-04T07:53:34.625Z, the
  // SAME millisecond for two different leads), and both really predate their 2026-07-30 boundary.
  assert(
    turnTimeOf({ messageAt: "2026-05-19T14:29:26.246Z", messageId: "msg_9dab7231c66c7_1779200966246" }) ===
      "2026-05-19T14:29:26.246Z",
    "messageAt is the turn time when present (+17164738220's real turn)"
  );
  assert(
    turnTimeOf({ messageId: "msg_49ab66cab6d22_1783616788874" }) === "2026-07-09T17:06:28.874Z",
    "the message id's trailing epoch is the fallback turn time (+17164182619's real turn)"
  );
  assert(turnTimeOf({ messageId: "SM1" }) === undefined, "an id carrying no epoch resolves to unknown");
  assert(turnTimeOf({}) === undefined, "no messageAt and no id resolves to unknown");
  {
    const RUN = "2026-08-04T07:53:34.625Z";
    const old = scoreTurn(
      mk({ messageId: "msg_9dab7231c66c7_1779200966246", messageAt: "2026-05-19T14:29:26.246Z", draft: null, verdict: "no_response" }),
      null
    );
    assert(
      buildFindings([old], [], RUN)[0]?.occurredAt === "2026-05-19T14:29:26.246Z",
      "a May turn replayed in August is stamped MAY — otherwise it can never age out or stay disposed"
    );
    // Fail direction: unresolvable turn time keeps the sweep clock, so the finding still reads recent.
    const unknown = scoreTurn(mk({ messageId: "SM1", draft: null, verdict: "no_response" }), null);
    assert(
      buildFindings([unknown], [], RUN)[0]?.occurredAt === RUN,
      "an unresolvable turn time falls back to the sweep clock — recent, so the finding stays visible"
    );
  }

  // judge-worthiness
  assert(isJudgeWorthy(mk({})), "actionable draft row is judge-worthy");
  assert(!isJudgeWorthy(mk({ body: "ok" })), "bare ack is not judge-worthy");
  assert(!isJudgeWorthy(mk({ draft: null, verdict: "expected_no_response" })), "no-draft rows are not judged");

  // scoring
  const passScore = scoreTurn(mk({}), { addressed: true, customerAsk: "availability", why: "answered", severity: "none" });
  assert(passScore.pass && !passScore.critical, "addressed candidate_safe passes");
  const major = scoreTurn(mk({}), { addressed: false, customerAsk: "availability", why: "answered wrong thing", severity: "major" });
  assert(!major.pass && major.critical, "judge-major fails AND is critical (T1)");
  const minor = scoreTurn(mk({}), { addressed: false, customerAsk: "availability", why: "partially", severity: "minor" });
  assert(!minor.pass && !minor.critical, "judge-minor fails but is not critical");
  const err = scoreTurn(mk({ verdict: "error", draft: null }), null);
  assert(!err.pass && err.critical, "replay error is critical");
  const silent = scoreTurn(mk({ verdict: "no_response", draft: null }), null);
  assert(!silent.pass && !silent.critical, "unexpected silence fails, not critical");
  const review = scoreTurn(mk({ verdict: "review", reviewReasons: ["price claim"] }), null);
  assert(!review.pass && !review.critical, "unjudged review rows fail toward investigation");

  // baseline diff — pass→fail with a CHANGED draft signature = regression; unchanged = flaky judge
  const key = turnKeyOf(mk({}));
  const changedSigBase: Baseline = { [key]: { pass: true, critical: false, at: "t0", draftSig: "a completely different draft <n>" } };
  const sameSigBase: Baseline = { [key]: { pass: true, critical: false, at: "t0", draftSig: draftSignature(major.draft) } };
  assert(diffAgainstBaseline([major], changedSigBase).regressions.length === 1, "pass→fail with changed draft is a regression");
  assert(
    diffAgainstBaseline([major], sameSigBase).regressions.length === 0 &&
      diffAgainstBaseline([major], sameSigBase).flaky.length === 1,
    "pass→fail on an UNCHANGED draft is a flaky judge flip, not a regression"
  );
  const legacyBase: Baseline = { [key]: { pass: true, critical: false, at: "t0" } };
  assert(diffAgainstBaseline([major], legacyBase).regressions.length === 1, "legacy baseline entries (no sig) fail toward counting the regression");
  assert(diffAgainstBaseline([passScore], changedSigBase).regressions.length === 0, "pass→pass is not");
  assert(diffAgainstBaseline([major], { [key]: { pass: false, critical: false, at: "t0" } }).regressions.length === 0, "fail→fail is not a regression");
  assert(diffAgainstBaseline([major], null).regressions.length === 0, "no baseline → no regressions (first run)");
  assert(draftSignature("See you Wed, Mar 11 at 9:30 AM — $12,499") === draftSignature("See you Thu, Jul 3 at 1:00 PM — $13,999"), "time/price content normalizes to the same signature");

  // greeting normalization — a persona/rep RENAME is not a changed draft (7/6: Brooke→Alexandra
  // flipped ~13 openers into phantom regressions)
  const brookeOpener = "Hey Rex, it's Brooke over at American Harley-Davidson. I got your request — which model?";
  const alexandraOpener = "Hey Rex, it's Alexandra over at American Harley-Davidson. I got your request — which model?";
  assert(draftSignature(brookeOpener) === draftSignature(alexandraOpener), "rep rename normalizes to the same signature");
  assert(
    draftSignature("Hey Kevin - Scott here from American H-D. Your bike arrives this week.") ===
      draftSignature("Hey Kevin - Giovanni here from American H-D. Your bike arrives this week."),
    "the NAME-here-from intro shape normalizes too"
  );
  assert(
    draftSignature("Hi Plinio — this is Giovanni at American Harley-Davidson. Quick reminder about Custom Coverage.") ===
      draftSignature("Hi Plinio — this is Scott at American Harley-Davidson. Quick reminder about Custom Coverage."),
    "the this-is-NAME-at intro shape normalizes too"
  );
  assert(draftSignature(brookeOpener) !== draftSignature("a completely different draft"), "intro-strip does not collapse distinct drafts");
  assert(
    draftSignature("Yes — it's available at the dealership today.") !== draftSignature("Yes — it's sold at the dealership today."),
    "content-bearing it's-X-at phrases keep their content (only the intro idiom strips)"
  );
  // legacy baseline sigs (written before intro normalization) renormalize at compare time
  const renamedRow = mk({ draft: alexandraOpener });
  const renamedScore = scoreTurn(renamedRow, { addressed: false, customerAsk: "model", why: "judge strictness", severity: "minor" });
  const legacySigBase: Baseline = {
    [turnKeyOf(renamedRow)]: {
      pass: true,
      critical: false,
      at: "t0",
      draftSig: "hey rex, it's brooke over at american harley-davidson. i got your request — which model?"
    }
  };
  const legacyDiff = diffAgainstBaseline([renamedScore], legacySigBase);
  assert(
    legacyDiff.regressions.length === 0 && legacyDiff.flaky.length === 1,
    "a rename-only change vs a LEGACY unnormalized sig is a flaky judge flip, not a regression"
  );

  // confirm-on-refail decision table — fail direction: only a passing rerun recovers
  assert(resolveRefailOutcome({ rerunFound: false, rerunPass: false }) === "confirmed", "missing rerun fails toward confirming the regression");
  assert(resolveRefailOutcome({ rerunFound: true, rerunPass: false }) === "confirmed", "a re-failing rerun confirms the regression");
  assert(resolveRefailOutcome({ rerunFound: true, rerunPass: true }) === "recovered", "a passing rerun is parser nondeterminism, not code");

  // findings shape for the next.json fold
  const findings = buildFindings([major, passScore], [major], "2026-07-02T23:00:00.000Z");
  assert(findings.length === 1, "only failures emit findings");
  assert(findings[0].dimension === "corpus_replay_regression" && findings[0].severity === "P1", "regressions are P1");
  assert(!!findings[0].occurredAt && findings[0].category === "reply", "findings carry occurredAt + category");

  // fidelity-v2 adjustments: named, auditable, never silent
  const testRow = mk({ conversationId: "test@hotmail.com" });
  assert(adjustScore(scoreTurn(testRow, null), testRow).excluded === true, "test leads are excluded, not scored");
  const deptRow = mk({
    body: "WEB TEXT WIDGET\nDepartment: Parts\nMessage: do you have a saddlemen road sofa seat?",
    draft: "Hi Paul — thanks for reaching out to our Parts team. I've passed your message along and they'll text you right back."
  });
  const deptScore = adjustScore(
    scoreTurn(deptRow, { addressed: false, customerAsk: "seat availability", why: "did not answer availability", severity: "major" }),
    deptRow
  );
  assert(deptScore.pass && deptScore.adjustment === "design_accepted_handoff", "a policy-correct department handoff passes as accepted design");
  const deflRow = mk({ draft: "I'll confirm the mileage on the 2020 Iron 1200 and follow up shortly." });
  const deflScore = adjustScore(
    scoreTurn(deflRow, { addressed: false, customerAsk: "mileage", why: "did not answer", severity: "major" }),
    deflRow
  );
  assert(!deflScore.pass && !deflScore.critical && deflScore.adjustment === "deflection_downgraded", "a deflection-with-commitment fails but is not critical");
  const realMiss = mk({ draft: "Thanks for entering — good luck!" });
  const realScore = adjustScore(
    scoreTurn(realMiss, { addressed: false, customerAsk: "demo ride", why: "wrong frame", severity: "major" }),
    realMiss
  );
  assert(!realScore.pass && realScore.critical && realScore.adjustment === "none", "a genuine wrong-intent reply stays critical");

  // Placeholder-vehicle clarify (7/17 sweep: 8 of 73 fails). An ADF Vehicle of
  // "Harley-Davidson Other" / "H-D Meta Promo" specifies NO model — the judge misreads it as a
  // specified model and fails the agent for asking which model, but asking IS the correct move.
  // Fixture drafts are the REAL failing shape: full ADF openers (>260 chars, so the short-clarify
  // isAcceptedClarify path does NOT cover them — only the new placeholder classifier can).
  const placeholderMajor: IntentVerdict = {
    addressed: false,
    customerAsk: "info on the Harley-Davidson Other they inquired about",
    why: "asked which model instead of answering about the specified vehicle",
    severity: "major"
  };
  const placeholderAdfBody =
    "WEB LEAD (ADF)\nSource: H-D Meta Promo Offer\nName: Randy Cole\nVehicle: Harley-Davidson Other\n\nInquiry:\nPreferred method of contact - text";
  const placeholderClarify = mk({
    body: placeholderAdfBody,
    draft:
      "Hi Randy — it's Alexandra at American Harley-Davidson. Thanks for claiming the H-D promo offer, that discount is a great excuse to finally pick out the right ride. Quick question so I can get real numbers and photos in front of you instead of guesses: which model are you eyeing, or are you still browsing the full lineup for now?"
  });
  assert(isPlaceholderVehicleClarify(placeholderClarify, placeholderMajor), "a which-model ask on a placeholder Vehicle line matches the classifier");
  const placeholderClarifyScore = adjustScore(scoreTurn(placeholderClarify, placeholderMajor), placeholderClarify);
  assert(
    placeholderClarifyScore.pass && placeholderClarifyScore.adjustment === "design_accepted_handoff",
    "a which-model clarify on a placeholder ADF vehicle passes as accepted design"
  );
  // The "H-D Meta Promo" campaign-tag vehicle is a placeholder too (scorer-local extension).
  const metaPromoClarify = mk({
    body: "WEB LEAD (ADF)\nSource: Facebook\nName: Dee\nVehicle: H-D Meta Promo\n\nInquiry:\nClaim offer",
    draft:
      "Hi Dee — thanks for reaching out about the Meta promo! I want to make sure I send you photos, pricing, and current inventory for the right ride instead of burying you in the whole lineup at once. Is there a specific bike you have in mind already, or would you like me to put together a few options based on how you plan to ride?"
  });
  const metaPromoScore = adjustScore(
    scoreTurn(metaPromoClarify, { addressed: false, customerAsk: "the promo vehicle", why: "did not address the vehicle", severity: "major" }),
    metaPromoClarify
  );
  assert(metaPromoScore.pass && metaPromoScore.adjustment === "design_accepted_handoff", "an H-D Meta Promo campaign-tag vehicle counts as a placeholder");
  // Guard against over-broadening: a SPECIFIC Vehicle line means asking which model is still a miss.
  const specificVehicleReAsk = mk({
    body: "WEB LEAD (ADF)\nSource: Website\nName: Ted\nVehicle: 2021 Street Glide Special\n\nInquiry:\nIs it still available?",
    draft:
      "Hi Ted — it's Alexandra at American Harley-Davidson. Thanks for reaching out about our inventory, we've got a great selection on the floor right now and I'd love to help you narrow it down to the right ride for where and how you plan to cruise. Which model are you interested in, and are you leaning new or pre-owned this time around?"
  });
  assert(!isPlaceholderVehicleClarify(specificVehicleReAsk, placeholderMajor), "a SPECIFIC Vehicle line never matches the placeholder classifier");
  const specificVehicleScore = adjustScore(
    scoreTurn(specificVehicleReAsk, { addressed: false, customerAsk: "availability of the 2021 Street Glide Special", why: "asked for the model already on record", severity: "major" }),
    specificVehicleReAsk
  );
  assert(!specificVehicleScore.pass && specificVehicleScore.critical, "re-asking for a SPECIFIED model stays a critical miss");
  // A placeholder vehicle with a draft that never asks which model earns no free pass either.
  const placeholderNoAsk = mk({
    body: placeholderAdfBody,
    draft: "Hi Randy — thanks for reaching out! Stop by any time this week and the team will take good care of you, we're open until six most nights and Saturdays too. We appreciate you thinking of American Harley-Davidson and look forward to meeting you at the dealership whenever works."
  });
  const placeholderNoAskScore = adjustScore(
    scoreTurn(placeholderNoAsk, { addressed: false, customerAsk: "help choosing a bike", why: "generic brush-off", severity: "major" }),
    placeholderNoAsk
  );
  assert(!placeholderNoAskScore.pass, "a placeholder vehicle with no which-model ask is not excused");
  assert(extractAdfVehicleLabel(placeholderAdfBody) === "Harley-Davidson Other", "Vehicle line extraction is exact");
  assert(extractAdfVehicleLabel("WEB LEAD (ADF)\nName: Sam\n\nInquiry:\nhello") === null, "no Vehicle line -> null (not this class)");
  assert(isPlaceholderVehicleLabel("Full Line") && isPlaceholderVehicleLabel("Harley-Davidson") && !isPlaceholderVehicleLabel("2021 Street Glide Special"), "the live placeholder notion (Other/Full Line/bare make) is reused");

  // Dealer Lead App post-ride survey log (internal, staff-filed). Body shape pinned from prod
  // regressions +17169123294 (Angelo) / +17164442837 (Megan): a "Marketing Questions: Dealer
  // Lead App ..." block with a "Demo Bikes Ridden:" line. The FIRST log earns its one thank-you;
  // a REPEAT log correctly stays silent — both are by-design, not a miss.
  const rideLogBody =
    "WEB LEAD (ADF)\nSource: Dealer Lead App\nRef: 11315\nName: Megan Sweeney\n\nInquiry:\nCustomer Comments: Stone Giuga Marketing Questions: Dealer Lead App - Type: Y SalesPerson: Stone Giuga - Which model of motorcycle are you interested in? 2022,SPORTSTER,FORTY-EIGHT Demo Bikes Ridden: 2015,SPORTSTER,1200 CUSTOM";
  const rideThankYou = mk({ body: rideLogBody, draft: "Hi Megan — Thanks again for coming in for the test ride on the 2015 Sportster 1200 Custom. If you need anything, just let me know." });
  const rideThankYouScore = adjustScore(
    scoreTurn(rideThankYou, { addressed: false, customerAsk: "next steps", why: "did not answer", severity: "major" }),
    rideThankYou
  );
  assert(rideThankYouScore.pass && rideThankYouScore.adjustment === "design_accepted_handoff", "first dealer-ride log's one thank-you passes as accepted design");
  const rideSilence = mk({ body: rideLogBody, draft: null, verdict: "no_response" });
  const rideSilenceScore = adjustScore(scoreTurn(rideSilence, null), rideSilence);
  assert(rideSilenceScore.pass && rideSilenceScore.adjustment === "design_accepted_handoff", "a repeat dealer-ride log producing silence is expected, not a miss");
  assert(isExpectedSilence(rideSilence), "dealer-ride log silence is body-keyed (holds without a dealer_ride router reason)");
  // Guard against over-broadening: a plain customer message that gets NO reply is still a miss.
  const plainSilence = mk({ body: "is the low rider st still available?", draft: null, verdict: "no_response" });
  const plainSilenceScore = adjustScore(scoreTurn(plainSilence, null), plainSilence);
  assert(!plainSilenceScore.pass && plainSilenceScore.adjustment === "none", "a plain customer message with no reply still fails as unexpected silence");

  // Reaction-only turns: an iOS tapback echo / emoji-only body is a designed no-reply signal
  // (pinned from prod +19198105169, `Liked “Gotcha — yes…”` on an inventory-watch thread).
  const tapbackSilence = mk({
    body: "Liked “Gotcha — yes, they are supposed to be coming back out with the Sportster. I’ll hold onto your info and text you when we see one come in.”",
    draft: null,
    verdict: "no_response",
    router: { followUpMode: "holding_inventory", followUpReason: "inventory_watch" }
  });
  const tapbackScore = adjustScore(scoreTurn(tapbackSilence, null), tapbackSilence);
  assert(tapbackScore.pass && tapbackScore.adjustment === "design_accepted_handoff", "a tapback echo producing silence is expected, not a miss");
  const emojiSilence = mk({ body: "👍👍", draft: null, verdict: "no_response" });
  assert(adjustScore(scoreTurn(emojiSilence, null), emojiSilence).pass, "an emoji-only reaction producing silence is expected");

  // Owner-thread step-back on a post_sale thread: greeting the salesperson BY NAME on the
  // human-owned thread → designed silence (prod +17166035402, "Good morning Scott…"). BOTH the
  // post_sale reason AND the name-greeting opener are required (fail-direction guards below).
  const postSaleGreetingSilence = mk({
    body: "Good morning Scott, the delivery went well. I hope to stop by weather permitting. Thank you Scott & Stone for making Sue & I very happy.",
    draft: null,
    verdict: "no_response",
    router: { followUpMode: "active", followUpReason: "post_sale" }
  });
  const postSaleGreetingScore = adjustScore(scoreTurn(postSaleGreetingSilence, null), postSaleGreetingSilence);
  assert(postSaleGreetingScore.pass && postSaleGreetingScore.adjustment === "design_accepted_handoff", "greeting the rep by name on a post_sale thread producing silence is the designed step-back");
  assert(opensWithPersonNameGreeting("Hey Scott this is Mark") && !opensWithPersonNameGreeting("Hi there, is it available?"), "the greeting matcher requires a personal name, not a generic token");
  const postSaleQuestionSilence = mk({
    body: "When is my part coming in?",
    draft: null,
    verdict: "no_response",
    router: { followUpMode: "active", followUpReason: "post_sale" }
  });
  assert(!adjustScore(scoreTurn(postSaleQuestionSilence, null), postSaleQuestionSilence).pass, "a post_sale question WITHOUT a name greeting still fails as unexpected silence");
  const activeGreetingSilence = mk({
    body: "Hey Scott, is the low rider st still available?",
    draft: null,
    verdict: "no_response",
    router: { followUpMode: "active", followUpReason: "" }
  });
  assert(!adjustScore(scoreTurn(activeGreetingSilence, null), activeGreetingSilence).pass, "a name greeting on a normal sales thread still fails as unexpected silence");

  // Empty-Inquiry ADF first touch: the customer clicked a listing and wrote NOTHING, so the
  // Joe-approved intro + invite IS the designed first touch; the judge invents asks and fails
  // it as minor (adf_ref_11626/11617/11613/11592, 7/23 sweep).
  const emptyInquiryAdfBody =
    "WEB LEAD (ADF)\nSource: AutoDealers.Digital - autodealersdigital.com\nRef: 11626\nName: Russ Bottoni\nStock: U119-13\nVIN: 1HD1CT314DC443563\nYear: 2013\nVehicle: Harley-Davidson 1200 Custom 2013 XL1200C U119-13 Vivid Black\n\nInquiry:\nLead arrived";
  const adfIntroDraft =
    "Hey Russ, it's Alexandra over at American Harley-Davidson. Thanks for your inquiry about the 2013 1200 Custom 2013 XL1200C U119-13 Vivid Black. If you’d like to stop in and check it out, just say the word.";
  const adfIntroMinor: IntentVerdict = {
    addressed: false,
    customerAsk: "likely wants availability, price, financing, next steps",
    why: "no concrete info offered",
    severity: "minor"
  };
  const adfIntroRow = mk({ body: emptyInquiryAdfBody, draft: adfIntroDraft });
  assert(isEmptyInquiryAdfBody(emptyInquiryAdfBody), "an Inquiry of 'Lead arrived' is an empty-Inquiry ADF");
  const adfIntroScore = adjustScore(scoreTurn(adfIntroRow, adfIntroMinor), adfIntroRow);
  assert(adfIntroScore.pass && adfIntroScore.adjustment === "design_accepted_handoff", "the approved intro on an empty-Inquiry ADF passes as accepted design");
  // Fail-direction guards: a judge-MAJOR is never excused, and a real Inquiry question never matches.
  const adfIntroMajorScore = adjustScore(
    scoreTurn(adfIntroRow, { ...adfIntroMinor, severity: "major" }),
    adfIntroRow
  );
  assert(!adfIntroMajorScore.pass && adfIntroMajorScore.critical, "a judge-major on the same intro shape still fails critical");
  const realAskAdf = mk({
    body: emptyInquiryAdfBody.replace("Lead arrived", "Is it still available? What's your best out-the-door price?"),
    draft: adfIntroDraft
  });
  assert(!isEmptyInquiryAdfBody(String(realAskAdf.body)), "an Inquiry carrying a real question is NOT the empty-Inquiry class");
  assert(!adjustScore(scoreTurn(realAskAdf, adfIntroMinor), realAskAdf).pass, "an intro that ignores an actual Inquiry question stays a miss");

  // Non-buyer survey ack: a Dealer Lead App passenger survey (explicit non-buyer) gets the one
  // warm no-pressure ack — the pinned buildNonBuyerSurveyAck copy (prod +17168618586, Susan).
  const nonBuyerBody =
    "WEB LEAD (ADF)\nSource: Dealer Lead App - Passenger\nRef: 11181\nName: Susan Fiegel\nVehicle: Harley-Davidson Full Line\n\nInquiry:\nMarketing Questions: Dealer Lead App - Type: N - Do you currently own a motorcycle? No, never owned - Do you expect to make a motorcycle purchase in the near future? No";
  const nonBuyerAckRow = mk({
    body: nonBuyerBody,
    draft:
      "Hey Susan, it's Alexandra over at American Harley-Davidson. Thanks for reaching out — no pressure at all. If you ever decide you'd like a bike of your own down the road, I'm here whenever you're ready."
  });
  const nonBuyerMinor: IntentVerdict = {
    addressed: false,
    customerAsk: "likely wanted info or next steps (lessons, models, demos)",
    why: "only a vague no-pressure statement",
    severity: "minor"
  };
  const nonBuyerScore = adjustScore(scoreTurn(nonBuyerAckRow, nonBuyerMinor), nonBuyerAckRow);
  assert(nonBuyerScore.pass && nonBuyerScore.adjustment === "design_accepted_handoff", "the pinned non-buyer survey ack passes as accepted design");
  const nonDlaAckRow = mk({ body: "is the low rider st still available?", draft: String(nonBuyerAckRow.draft) });
  assert(!adjustScore(scoreTurn(nonDlaAckRow, nonBuyerMinor), nonDlaAckRow).pass, "the no-pressure ack on a real sales question is NOT excused");
  const nonBuyerMajorScore = adjustScore(scoreTurn(nonBuyerAckRow, { ...nonBuyerMinor, severity: "major" }), nonBuyerAckRow);
  assert(!nonBuyerMajorScore.pass && nonBuyerMajorScore.critical, "a judge-major on the survey thread still fails critical");

  // Room58 - Standard handoff ack: the generic "Contact Us" form with an EMPTY Inquiry. Pinned
  // from the production turn +18283619458 (Larry Silvers, adf_ref 11353, 7/31 sweep) that the
  // judge failed MAJOR/critical. The lead is deliberately handed to a human (c682179b), so the
  // ack is the designed reply, not a deflection.
  const room58Body =
    "WEB LEAD (ADF)\nSource: Room58 - Standard\nRef: 11353\nName: Larry Silvers\nEmail: larry.ssrg@yahoo.com\nPhone: 8283619458\nYear: 2026\nVehicle: Harley-Davidson Full Line\n\nInquiry:";
  const room58AckDraft =
    "Hey Larry, it's Alexandra over at American Harley-Davidson. Thanks — I got your inquiry. I’ll make sure the team follows up soon.";
  const room58Row = mk({ body: room58Body, draft: room58AckDraft });
  const room58Major: IntentVerdict = {
    addressed: false,
    customerAsk:
      "Interest in 2026 Harley-Davidson Full Line — likely requesting information or follow-up about availability/pricing/next steps",
    why: "The agent's reply only acknowledges receipt and promises follow-up, but does not answer any specific information or take next-step action requested by a sales lead.",
    severity: "major"
  };
  const room58Score = adjustScore(scoreTurn(room58Row, room58Major), room58Row);
  assert(
    room58Score.pass && room58Score.adjustment === "design_accepted_handoff",
    "the pinned Room58 - Standard handoff ack on an empty Inquiry passes as accepted design"
  );
  // The BODY is the gate, not the severity: a Room58 customer who actually writes a question must
  // still fail, or this accept would blind the sweep to a real unanswered ask.
  const room58RealAsk = mk({
    body: `${room58Body}\nIs the Low Rider ST still in stock, and what's your best out-the-door price?`,
    draft: room58AckDraft
  });
  assert(
    !isEmptyInquiryAdfBody(String(room58RealAsk.body)),
    "a Room58 body carrying a real question is NOT the empty-Inquiry class"
  );
  assert(
    !adjustScore(scoreTurn(room58RealAsk, room58Major), room58RealAsk).pass,
    "the Room58 ack sent over a real customer question stays a miss"
  );
  // Scope: the same ack copy on a non-Room58 lead is NOT excused (only this source is handed off).
  const nonRoom58AckRow = mk({
    body: room58Body.replace("Room58 - Standard", "Room58 - Book test ride"),
    draft: room58AckDraft
  });
  assert(
    !adjustScore(scoreTurn(nonRoom58AckRow, room58Major), nonRoom58AckRow).pass,
    "the handoff ack on a non-Standard Room58 lead is NOT excused"
  );
  // Copy drift must fail OPEN (the [[scorer-copy-drift-design-accept]] trap): reword the ack and
  // the row surfaces again rather than being silently accepted.
  const room58DriftedRow = mk({
    body: room58Body,
    draft: "Hey Larry, it's Alexandra over at American Harley-Davidson. Got it — someone will be in touch."
  });
  assert(
    !adjustScore(scoreTurn(room58DriftedRow, room58Major), room58DriftedRow).pass,
    "a reworded handoff ack falls out of the accept and surfaces again"
  );
  // Human-owned SOURCE thread (staff takeover): the replay harness forces autopilot onto the
  // temp copy, so expected silence must be keyed on the row's sourceConversationMode — mirrors
  // the release-gate human-mode skips (c5ae6e32). Shapes pinned from the 2026-07-23 phantom
  // cluster: sold post-sale (+17169982451), wrong-number (+17163083346), owner-greeting/other
  // (+17168619251) — all mode:"human" threads whose replayed silence was scored as a miss.
  for (const [label, body] of [
    ["sold post-sale ack", "Thanks again, loving the new bike!"],
    ["wrong-number", "Wrong #"],
    ["owner-greeting", "Hey Stone, it's Mike"]
  ] as const) {
    const humanSilence = mk({ body, draft: null, verdict: "no_response", sourceConversationMode: "human" });
    assert(isExpectedSilence(humanSilence), `human-owned silence (${label}) is by design, not a miss`);
    const humanSilenceScore = adjustScore(scoreTurn(humanSilence, null), humanSilence);
    assert(
      humanSilenceScore.pass && humanSilenceScore.adjustment === "design_accepted_handoff",
      `human-owned silence (${label}) passes as accepted design`
    );
  }
  // Guard against over-broadening: same silence on an agent-owned thread stays an unexpected miss…
  assert(
    !isExpectedSilence(mk({ body: "is the low rider st still available?", draft: null, verdict: "no_response", sourceConversationMode: "autopilot" })),
    "agent-owned (autopilot) silence is still an unexpected miss"
  );
  // …and a human-owned thread that DID produce a bad draft gets no free pass (carve-out is silence-only).
  const humanBadDraft = mk({ sourceConversationMode: "human" });
  const humanBadDraftScore = adjustScore(
    scoreTurn(humanBadDraft, { addressed: false, customerAsk: "availability", why: "answered wrong thing", severity: "major" }),
    humanBadDraft
  );
  assert(!humanBadDraftScore.pass, "a judge-failed DRAFT on a human-owned thread still fails (carve-out is silence-only)");

  // Stock-check-first (charter C4.3) design-accept must cover BOTH unavailability drafts. The
  // orchestrator/regen copy was already covered; PR #367 gave the initial-ADF first touch its own
  // shorter copy and the same ruled behavior started failing the gate (08610167776 Sanjeev asked to
  // book a 2026 Sportster S test ride for 29/6 at 12 pm; we don't have the bike, so we answer
  // honestly and offer the watch instead of booking).
  // Live copy as of 2026-07-31 (buildInitialUnavailableInventorySmsReply, Joe's two ways forward:
  // come in and pick from what we have, or we text them when we get one).
  const initialAdfUnavailableDraft =
    "Hey Sanjeev, it's Alexandra over at American Harley-Davidson. Thanks — I’m not seeing a 2026 " +
    "Sportster S in stock right now. Want to pick something out from what we have and still come " +
    "in? Or I can keep an eye out and text you when we get one.";
  const bookTestRideAsk: IntentVerdict = {
    addressed: false,
    customerAsk: "Book a test ride of a 2026 Harley-Davidson Sportster S on 29/6/2026 at 12 pm",
    why: "the agent only said the bike isn't in stock without offering to schedule",
    severity: "major"
  };
  const stockFirstRow = mk({ draft: initialAdfUnavailableDraft });
  assert(
    isBlockedTestRideWithWatchOffer(stockFirstRow, bookTestRideAsk),
    "the initial-ADF unavailability copy (#367) is the same ruled stock-check-first behavior"
  );
  const stockFirstScore = adjustScore(scoreTurn(stockFirstRow, bookTestRideAsk), stockFirstRow);
  assert(
    stockFirstScore.pass && stockFirstScore.adjustment === "design_accepted_handoff",
    "an honest out-of-stock answer to a test-ride ask passes as accepted design (C4.3), not a P1"
  );
  // The original orchestrator/regen draft still matches (no regression on the arm that worked).
  const orchestratorBlockedDraft =
    "I’m not seeing a 2021 Sportster S in stock right now, and I don’t want to book you on a bike we " +
    "don’t have. Here’s our current inventory so you can pick an in-stock bike: https://example.com/i " +
    "I can also keep an eye out and text you the moment one lands — want me to? Once you pick one, I " +
    "can line up the test ride right away.";
  assert(
    isBlockedTestRideWithWatchOffer(mk({ draft: orchestratorBlockedDraft }), bookTestRideAsk),
    "the orchestrator/regen blocked draft stays covered"
  );
  // FAIL-DIRECTION GUARDS — the narrow shape must not swallow real misses.
  // (a) A non-availability ask on the SAME draft still fails: we genuinely owe mileage/price/year
  //     (+12099195457), and judge.why mentioning "schedule" must not rescue it.
  const specsAsk: IntentVerdict = {
    addressed: false,
    customerAsk: "Information about miles driven, price, and model year for the 2022 Iron 883",
    why: "did not provide the requested details (mileage, price, year) or offer to schedule",
    severity: "major"
  };
  const specsRow = mk({ draft: initialAdfUnavailableDraft });
  assert(
    !isBlockedTestRideWithWatchOffer(specsRow, specsAsk),
    "an unanswered specs/pricing ask is NOT excused by the unavailability copy"
  );
  assert(!adjustScore(scoreTurn(specsRow, specsAsk), specsRow).pass, "the specs miss still fails the gate");
  // (b) An IN-STOCK draft that simply never books stays a miss (no unavailability lead to excuse it).
  const inStockDuckRow = mk({
    draft: "Hey Sanjeev, it's Alexandra over at American Harley-Davidson. I can keep an eye out and text you if one comes in."
  });
  assert(
    !isBlockedTestRideWithWatchOffer(inStockDuckRow, bookTestRideAsk),
    "a watch offer WITHOUT the honest unavailability lead is not the ruled behavior"
  );
  // (c) A judge that says the ask WAS addressed never reaches the design-accept at all.
  assert(
    !isBlockedTestRideWithWatchOffer(stockFirstRow, { ...bookTestRideAsk, addressed: true }),
    "an addressed verdict is never re-classified"
  );

  // ── HARNESS errors are unmeasured, not agent criticals (2026-08-04) ───────────────────
  // A deploy running `npm ci` mid-sweep killed 29 consecutive boots; they scored as 9 of the
  // 12 criticals and blocked the gate, and each minted a "draft: (none)" P1 against a reply
  // the agent was never asked to write.
  const bootFailRow = mk({
    draft: null,
    verdict: "error",
    reviewReasons: ["shadow replay failed"],
    error: "temporary API exited early (1): Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'dotenv'"
  });
  const bootFailScore = adjustScore(scoreTurn(bootFailRow, null), bootFailRow);
  assert(bootFailScore.excluded === true, "a harness boot failure is excluded from the scored corpus");
  assert(bootFailScore.adjustment === "excluded_harness_error", "and it is named, never silently dropped");
  assert(!bootFailScore.critical, "a harness boot failure must not count as a release-blocking critical");
  assert(
    buildFindings([bootFailScore], [], "2026-08-04T07:53:34.625Z").length === 0,
    "a turn the harness never ran mints NO conversation-level finding — there is nothing to say about that reply"
  );

  // An error the classifier does NOT recognise stays the agent's: still critical, still a finding.
  const agentFailRow = mk({
    draft: null,
    verdict: "error",
    reviewReasons: ["shadow replay failed"],
    error: "timed out waiting for Twilio shadow job"
  });
  const agentFailScore = adjustScore(scoreTurn(agentFailRow, null), agentFailRow);
  assert(agentFailScore.excluded !== true, "an agent-side error stays in the scored corpus");
  assert(agentFailScore.critical, "an agent-side error keeps its CRITICAL");
  assert(
    buildFindings([agentFailScore], [], "2026-08-04T07:53:34.625Z")[0]?.dimension === "corpus_replay_error",
    "and it still mints its corpus_replay_error work order"
  );

  // Coverage: incidental loss is tolerated and reported; a gutted sweep cannot pass.
  assert(computeCoverage(671, 29) === 0.959, "coverage is measured/attempted (the real 08-04 sweep)");
  assert(computeCoverage(671, 29) >= COVERAGE_FLOOR, "losing 29 of 700 leaves 671 real verdicts — evidence, not a void");
  assert(computeCoverage(100, 600) < COVERAGE_FLOOR, "a sweep that lost most of its corpus has validated nothing");
  assert(computeCoverage(0, 0) === 1, "an empty sweep does not divide by zero");

  // prompt builder reachable (shared with the nightly audit — same judging semantics)
  assert(buildIntentJudgePrompt({ convId: "x", at: "t", inboundText: "hi", replyText: "hey", replyKind: "draft", context: [] }).length > 50, "judge prompt builder shared");

  console.log("corpus replay flywheel self-test OK (scoring, baseline diff, findings shape, judge gating, harness-error exclusion + coverage floor)");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (process.argv.includes("--self-test")) {
    selfTest();
  } else {
    main().catch(err => {
      console.error(err?.stack ?? err?.message ?? err);
      process.exit(1);
    });
  }
}
