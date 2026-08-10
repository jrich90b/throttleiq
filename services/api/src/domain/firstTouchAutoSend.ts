/**
 * First-touch ack auto-send — pure eligibility decision (Joe-approved scope A,
 * 2026-06-15; spec: docs/first_touch_autosend_spec.md).
 *
 * The biggest real-world quality lever is latency: the agent DRAFTS in ~30s but
 * the customer-facing SENT reply waits ~186 min median because suggest mode holds
 * every draft for staff approval (scripts/response_latency_audit.ts — the
 * agentDraft-vs-effective split). This module decides whether ONE reply — a
 * brand-new lead's first-touch acknowledgement, the part that is already
 * deterministic + Agent-Voice-Charter-clean — may auto-send in suggest mode.
 * Everything else (every non-first turn, every LLM-composed reply, every cadence
 * follow-up) stays staff-approved, exactly as today.
 *
 * PURE + fail-safe: any uncertainty resolves to send=false (hold the draft). The
 * env flag is read by the caller (isFirstTouchAckAutoSendEnabled) and passed in
 * as `enabled`, so this function stays deterministic + unit-testable. SHIPS DARK:
 * with FIRST_TOUCH_ACK_AUTOSEND unset/0, `enabled` is false ⇒ send=false always ⇒
 * exact current behavior. The live customer-send wiring is STEP 2 (approve-first).
 */

import fs from "node:fs";
import path from "node:path";
import { resolveReportDir } from "./reportPaths.js";

import { normalizePhone } from "./suppressionStore.js";

export type FirstTouchAutoSendInput = {
  /** Feature flag (FIRST_TOUCH_ACK_AUTOSEND). Off ⇒ never auto-send. */
  enabled: boolean;
  /** Brand-new lead, no prior outbound in the thread (isInitialAdf / first-outbound predicate). */
  isFirstTouch: boolean;
  /** Reply is the deterministic template/intro path (buildAgentIntro/applyInitialAdfPrefix), NOT LLM-composed. */
  isDeterministicReply: boolean;
  /** Destination phone is on the opt-out/STOP suppression list. */
  suppressed: boolean;
  /** Lead prefers calls only (contactPreference call_only / preferredContactMethod phone). */
  callOnly: boolean;
  /** Inbound was itself an opt-out (STOP/unsubscribe/cancel). */
  optedOut: boolean;
  /** Draft-state invariants allowed publication (applyDraftStateInvariants .allow). */
  invariantAllow: boolean;
  /** Resolved customer destination is a valid E.164 phone (SMS-deliverable; guards email-only leads). */
  hasDeliverablePhone: boolean;
  /**
   * The customer has ALREADY received a real message in this thread (any prior customer-facing
   * outbound — see CUSTOMER_FACING_OUTBOUND_PROVIDERS / hasCustomerReceivedOutbound). A first-touch
   * ack by definition happens ONCE, so this is the durable "have we ever greeted this lead" check.
   *
   * Why it is REQUIRED and not defaulted: `isFirstTouch` (isInitialAdf) is a property of the INBOUND
   * DOCUMENT, not of the thread — a vendor that re-pushes the same lead daily produces a fresh
   * "initial ADF" every morning. Observed in the 2026-07-28..30 shadow corpus: conv +15126299400
   * logged the IDENTICAL ride-challenge ack on three consecutive days, isFirstTouch true each time.
   * Without this the flip would have texted that customer the same greeting once a day.
   */
  alreadyContacted: boolean;
  /**
   * An equivalent ack is already sitting in this thread's recent outbound history — the same-batch
   * race `alreadyContacted` can miss when two ADFs for one lead land seconds apart (observed: conv
   * +17163084498 produced two near-identical acks 13s apart, and NO dedup guard existed on this
   * path at all despite the STEP-2 design calling for one).
   */
  duplicateRecentAck: boolean;
};

export type FirstTouchAutoSendDecision = { send: boolean; reason: string };

/**
 * Pure. Returns send=true ONLY for an enabled, first-touch, deterministic reply
 * to an SMS-deliverable, non-opted-out, non-call-only lead whose draft cleared
 * the invariant guard. Any other state holds the draft (the current behavior).
 * Order matters only for the `reason` label (compliance reasons surface first).
 */
export function decideFirstTouchAutoSend(input: FirstTouchAutoSendInput): FirstTouchAutoSendDecision {
  if (!input.enabled) return { send: false, reason: "flag_off" };
  if (!input.isFirstTouch) return { send: false, reason: "not_first_touch" };
  if (!input.isDeterministicReply) return { send: false, reason: "llm_substantive_reply" };
  if (input.suppressed) return { send: false, reason: "suppressed" };
  if (input.optedOut) return { send: false, reason: "opted_out" };
  if (input.callOnly) return { send: false, reason: "call_only" };
  // Duplicate prevention sits with the compliance checks on purpose: texting a brand-new lead the
  // same greeting twice is the failure mode most likely to embarrass the dealer, and it is the one
  // the pre-flip shadow review actually caught (both cases documented on the input fields above).
  if (input.alreadyContacted) return { send: false, reason: "already_contacted" };
  if (input.duplicateRecentAck) return { send: false, reason: "duplicate_recent_ack" };
  if (!input.invariantAllow) return { send: false, reason: "invariant_block" };
  if (!input.hasDeliverablePhone) return { send: false, reason: "no_deliverable_phone" };
  return { send: true, reason: "first_touch_deterministic_ack" };
}

/**
 * Pure near-duplicate check over a conversation's own outbound history: has an equivalent ack
 * already gone to this customer inside the window?
 *
 * Deliberately deterministic (AGENTS.md: side-effect/safety gates are the deterministic lane) and
 * fail-SAFE — anything it cannot read confidently returns TRUE (hold the draft). That direction is
 * the whole point: a held draft costs a staff click, a duplicate text costs the dealer's credibility.
 *
 * The window is generous (24h default) because a genuine first-touch ack happens exactly once per
 * lead, so there is no legitimate repeat for it to suppress.
 */
export function isDuplicateRecentFirstTouchAck(
  messages: unknown,
  candidateText: unknown,
  opts?: { nowMs?: number; windowMs?: number }
): boolean {
  const candidate = normalizeAckForDedup(candidateText);
  // No readable candidate text ⇒ we cannot prove it is NOT a duplicate ⇒ hold.
  if (!candidate) return true;
  if (!Array.isArray(messages)) return false;
  const windowMs = Number(opts?.windowMs ?? 24 * 60 * 60 * 1000);
  const nowMs = Number(opts?.nowMs ?? Date.now());
  for (const msg of messages) {
    const provider = String((msg as any)?.provider ?? "").trim();
    if (!CUSTOMER_FACING_OUTBOUND_PROVIDERS_FOR_DEDUP.has(provider)) continue;
    if (String((msg as any)?.direction ?? "") !== "out") continue;
    if (!acksAreEquivalent(normalizeAckForDedup((msg as any)?.body), candidate)) continue;
    const at = Date.parse(String((msg as any)?.at ?? (msg as any)?.createdAt ?? ""));
    // An equivalent customer-facing message with an UNREADABLE timestamp still counts as a
    // duplicate — fail-safe beats assuming it was long ago.
    if (!Number.isFinite(at)) return true;
    if (Number.isFinite(nowMs) && nowMs - at <= windowMs) return true;
  }
  return false;
}

/** Mirrors agentVoice's CUSTOMER_FACING_OUTBOUND_PROVIDERS — providers that mean the customer really got it. */
const CUSTOMER_FACING_OUTBOUND_PROVIDERS_FOR_DEDUP = new Set(["twilio", "sendgrid", "human", "web_widget"]);

/** Collapse whitespace/punctuation/case so "Hey Joe, it's Alex." and "Hey Joe it's Alex" compare equal. */
function normalizeAckForDedup(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Footer-insensitive equivalence. An ack that was actually SENT carries the STOP footer
 * (`ensureInitialSmsOptOutFooter` runs before the send for send/record parity), while the candidate
 * we are about to send does not have it yet — so strict equality would miss the very duplicate this
 * guard exists to catch. Prefix containment in either direction handles that, with a length floor so
 * two short fragments can't collide by accident.
 */
function acksAreEquivalent(a: string, b: string): boolean {
  if (!a || !b) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 24) return shorter === longer;
  return longer.startsWith(shorter);
}

/**
 * Is this lead key something we can actually deliver an SMS to?
 *
 * Was `leadKey.startsWith("+")` inline at the two call sites — but leadKey is stored as BARE
 * DIGITS ("7164789799", not "+17164789799"), so the check rejected every SMS lead it saw. Across
 * the 2026-07-27..30 shadow corpus that was 218 of 218 otherwise-eligible first-touch leads, i.e.
 * the feature could never fire at all and its "0 sends" told us nothing about safety. The
 * suppression check on the ADJACENT line normalizes first and works correctly; this one didn't.
 *
 * Now shares suppression's `normalizePhone`, so "is this a phone we can text" and "is this phone
 * opted out" can never disagree about what a phone number is. Still fail-safe: anything that does
 * not normalize to E.164 (email-only leads, blanks, junk) returns false and holds the draft.
 */
export function hasDeliverablePhoneKey(leadKey: unknown): boolean {
  if (typeof leadKey !== "string") return false;
  return normalizePhone(leadKey).startsWith("+");
}

/** Reads FIRST_TOUCH_ACK_AUTOSEND. Default OFF (dark). */
export function isFirstTouchAckAutoSendEnabled(): boolean {
  const raw = String(process.env.FIRST_TOUCH_ACK_AUTOSEND ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Reads FIRST_TOUCH_ACK_AUTOSEND_DEBUG. When on, the call site logs the shadow decision (no send). */
export function firstTouchAutoSendDebugEnabled(): boolean {
  const raw = String(process.env.FIRST_TOUCH_ACK_AUTOSEND_DEBUG ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

// ---------------------------------------------------------------------------
// Shadow log (STEP 1 evidence): capture the ACTUAL first-touch ack the agent
// would auto-send, plus the risk context (model / sold-or-held disclosure lives
// in the ack text itself, lead source, the customer's inbound) so Joe can READ
// what would have gone out — with nothing ever sent. Reviewed via
// `npm run first_touch_autosend_shadow:report`. Enabled by
// FIRST_TOUCH_ACK_AUTOSEND_DEBUG (default OFF); logging must NEVER disrupt the
// live inbound path.

export type FirstTouchShadowRecordInput = {
  at: string;
  convId: string | null;
  leadKey: string | null;
  leadName?: string | null;
  model?: string | null;
  leadSource?: string | null;
  inboundText?: string | null;
  ackText: string;
  decision: FirstTouchAutoSendDecision;
  /** Injected only by the eval; production reads the process env. */
  origin?: FirstTouchShadowOrigin;
};

/**
 * Where a shadow row came from. `"replay"` means a rehearsal of a historical turn, not a real
 * customer — see firstTouchShadowOrigin below for why that distinction is load-bearing.
 */
export type FirstTouchShadowOrigin = "live" | "replay";

export type FirstTouchShadowRecord = {
  at: string;
  convId: string | null;
  leadKey: string | null;
  leadName: string | null;
  model: string | null;
  leadSource: string | null;
  inbound: string | null;
  wouldSend: boolean;
  reason: string;
  ack: string;
  origin: FirstTouchShadowOrigin;
};

/**
 * Is this process a REPLAY of a historical turn, or a live customer inbound? (2026-08-10)
 *
 * WHY THIS EXISTS. The flip bar for FIRST_TOUCH_ACK_AUTOSEND is graded off this JSONL, and one of
 * its criteria is "zero duplicates" — the same lead must never be acked twice. Measured 2026-08-10,
 * the log carried **722 would-send rows over 11 days against 46 real new leads** (~15x), because
 * `corpus_replay_nightly` shells out to `inbound_shadow_replay`, which spawns a per-case API with a
 * SANDBOX data dir but INHERITS the live `REPORT_ROOT` — so every rehearsal appends here.
 *
 * A replay is a thread rewound to before we answered, so it will always say "would send", and it
 * says it again every night. Layla (+15126299400) was really texted once, on 2026-07-19, and shows
 * up as a would-send on ELEVEN consecutive days. Graded naively that reads as a duplicate-send bug;
 * it is a rehearsal counted as a performance. Nothing about the guard was proven broken by it.
 *
 * The signal is `NODE_ENV`, which `buildShadowApiEnv` (scripts/inbound_shadow_replay.ts) pins to
 * "shadow" for every replayed case. It is the same value the harness has always set; this just
 * stops throwing it away.
 *
 * FAIL DIRECTION: anything that is not provably live is "replay". A row wrongly marked replay is
 * merely excluded from the bar (the bar stays conservative and the flip waits); a row wrongly
 * marked live re-contaminates the one measurement this exists to clean, which is how we got here.
 */
export function firstTouchShadowOrigin(env?: NodeJS.ProcessEnv): FirstTouchShadowOrigin {
  const source = env ?? process.env;
  const nodeEnv = String(source.NODE_ENV ?? "").trim().toLowerCase();
  if (nodeEnv === "shadow" || nodeEnv === "test") return "replay";
  // An explicit override for any future harness that cannot set NODE_ENV.
  const explicit = String(source.FIRST_TOUCH_SHADOW_ORIGIN ?? "").trim().toLowerCase();
  if (explicit === "replay") return "replay";
  return "live";
}

function clip(value: unknown, max: number): string | null {
  const text = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Pure: assemble the reviewable shadow record (ack text + risk context + decision). */
export function buildFirstTouchShadowRecord(input: FirstTouchShadowRecordInput): FirstTouchShadowRecord {
  return {
    at: input.at,
    convId: input.convId ?? null,
    leadKey: input.leadKey ?? null,
    leadName: clip(input.leadName, 80),
    model: clip(input.model, 80),
    leadSource: clip(input.leadSource, 80),
    inbound: clip(input.inboundText, 240),
    wouldSend: Boolean(input.decision?.send),
    reason: String(input.decision?.reason ?? ""),
    ack: clip(input.ackText, 600) ?? "",
    // Stamped at build time, so a row can never be re-classified later by guesswork (timestamps
    // cannot do it: the replay jobs run at several hours and drown the ~4 real leads/day).
    origin: input.origin ?? firstTouchShadowOrigin()
  };
}

export function firstTouchAutoSendShadowDir(): string {
  return resolveReportDir("first_touch_autosend", "FIRST_TOUCH_AUTOSEND_SHADOW_DIR");
}

/** Append one shadow record as JSONL. Wrapped so it can NEVER throw into the live path. */
export function appendFirstTouchShadowLog(record: FirstTouchShadowRecord): void {
  try {
    const dir = firstTouchAutoSendShadowDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "first_touch_autosend_shadow.jsonl"), `${JSON.stringify(record)}\n`);
  } catch {
    // shadow logging is best-effort; never disrupt the customer inbound path.
  }
}
