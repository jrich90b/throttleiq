/**
 * Per-conversation OUTCOME auditor — Phase 2 of the autonomous self-healing loop
 * (docs/autonomous_coding_loop.md). Pure, read-only, DETERMINISTIC detection of STATE/side-effect
 * contradictions across every aspect of a turn's outcome. This is the detection feed that replaces a
 * human watching the agent: a healthy system produces ZERO anomalies, so any hit is either a net-new
 * bug or a regression of a reconcile heal that should have repaired it.
 *
 * Scope (this module): the deterministic STATE half — appointment/cadence/watch/held-flag/todo
 * consistency. The COMPREHENSION half (was the reply correct / in-context / on-tone) is already graded
 * by the nightly LLM audits (context_fidelity, answer_correctness, fabricated_frame, voice_charter);
 * those emit into the SAME OutcomeAnomaly feed downstream (the "one feed" consolidation) — this module
 * defines the schema and owns the deterministic dimensions.
 *
 * `healed: true` marks a dimension that a 60s reconcile heal already repairs — so a non-zero count there
 * is a REGRESSION signal (the heal missed it / a write path outran it), not a brand-new gap.
 *
 * Deterministic invariant detection (AGENTS.md allows deterministic for invariant guards); never reads
 * customer intent. No mutations.
 */
import { REAL_OUTBOUND_CONTACT_PROVIDERS, collectInventoryWatches } from "./conversationStore.js";
import { modelMatches } from "./inventoryFeed.js";
import { stripWatchModelJunkTokens } from "./watchModelVinCodes.js";
import { isCampaignBroadcastSend } from "./scoringExclusions.js";

export type OutcomeSeverity = "P1" | "P2" | "P3";

// The "one feed": deterministic STATE contradictions + the COMPREHENSION/feedback verdicts the system
// already computed and persisted on the conversation (draftHeld, 👎). Category lets the loop route by
// kind (state → reconcile/invariant fix; comprehension → parser-first fix; feedback → redraft/diagnose).
export type OutcomeCategory = "state" | "comprehension" | "feedback" | "discovery";

export type OutcomeAnomaly = {
  convId: string;
  leadKey: string;
  dimension: string;
  category: OutcomeCategory;
  severity: OutcomeSeverity;
  healed: boolean; // a reconcile heal exists for this class → a hit means the heal lagged/missed (regression)
  detail: string;
  // ISO timestamp of the TRIGGERING event (the send/draft/booking that caused this finding), when the
  // detector can resolve it. Lets the stale-finding suppressor (anomalyClassifier.suppressStaleFindings)
  // drop a finding whose event predates the deployed fix for its dimension — never re-fix a ghost.
  // Optional: a detector that can't resolve an event time omits it, and the suppressor keeps the finding.
  occurredAt?: string;
  // ISO timestamp a HUMAN filed this finding (operator "Report issue" createdAt). NOT occurredAt: the
  // operator reports days after the reply they're complaining about, so this is only an UPPER BOUND on
  // the triggering event. Deliberately kept separate so it can never be mistaken for the event time by
  // the stale-finding suppressor. Its job is to bound the hand-search: the offending reply is at/before
  // it (see scripts/already_shipped_guard.ts --at, which cannot locate the reply on its own).
  reportedAt?: string;
};

const CATEGORY_BY_DIMENSION: Record<string, OutcomeCategory> = {
  appointment_confirmed_no_event: "state",
  watch_active_on_closed: "state",
  cadence_active_on_closed: "state",
  cadence_active_while_handoff: "state",
  stale_held_flag: "state",
  orphan_todo: "state",
  held_draft_unresolved: "comprehension",
  context_fidelity_shadow_unresolved: "comprehension",
  human_correction_material: "comprehension",
  cadence_quality_suppressed: "comprehension",
  open_critic_finding: "discovery",
  intent_unaddressed: "comprehension",
  reported_issue: "feedback",
  // A thumbs-down NOTE that instructs a person to act for a live customer ("book him in at 9:30") —
  // routed by decideThumbsDownNoteRouting, escalated like reported_issue (a human is waiting).
  thumbs_down_action_request: "feedback",
  task_autoclose_regression: "state",
  watch_fire_miss: "state",
  watch_fired_wrong_model: "state",
  negative_feedback: "feedback",
  // CRM (TLP) Playwright update failure. Nominal category "state" (a side-effect that didn't
  // apply); the classifier overrides this dimension to Tier 2 escalate (it's an integration
  // diagnosis — selector drift / login / timeout — not an auto-heal), mirroring reported_issue.
  crm_update_error: "state",
  // CRM log coverage gap: a real send not reflected in TLP with no failure recorded (auto-send
  // paths that never trigger logging). Also Tier-2 escalate (integration-wiring diagnosis).
  crm_log_stale: "state"
};
const categoryFor = (dimension: string): OutcomeCategory => CATEGORY_BY_DIMENSION[dimension] ?? "state";

type RawAnomaly = Omit<OutcomeAnomaly, "category">;

type AuditableConv = {
  id?: string;
  leadKey?: string;
  closedAt?: string | null;
  closedReason?: string | null;
  sale?: { soldAt?: string | null } | null;
  appointment?: { status?: string | null; bookedEventId?: string | null; whenText?: string | null; whenIso?: string | null } | null;
  followUpCadence?: { status?: string | null; kind?: string | null } | null;
  followUp?: { mode?: string | null } | null;
  inventoryWatch?: { status?: string | null } | null;
  inventoryWatches?: Array<{ status?: string | null }> | null;
  draftHeld?: { at?: string | null; reason?: string | null; heldKind?: string | null; frame?: string | null } | null;
  contextFidelityShadow?: { at?: string | null; frame?: string | null; severity?: string | null; reason?: string | null; draftPreview?: string | null } | null;
  humanCorrection?: { at?: string | null; category?: string | null; reason?: string | null; steering?: string | null } | null;
  cadenceQualityShadow?: { at?: string | null; overall?: string | null; reason?: string | null; cadenceKind?: string | null } | null;
  messages?: Array<{ direction?: string | null; provider?: string | null; at?: string | null; body?: string | null; sid?: string | null; draftStatus?: string | null; feedback?: { rating?: string | null; at?: string | null } | null }> | null;
  questions?: Array<{ text?: string | null; status?: string | null; createdAt?: string | null }> | null;
  lead?: { leadRef?: string | null } | null;
  crm?: { lastLoggedAt?: string | null; lastLoggedAtByLeadRef?: Record<string, string | null> | null } | null;
};

function isClosed(conv: AuditableConv): boolean {
  return !!(conv.closedAt || conv.closedReason || conv.sale?.soldAt);
}

function hasActiveWatch(conv: AuditableConv): boolean {
  // Union single + array (collectInventoryWatches) and use the SAME "active" definition as the heal
  // (!== paused) so "detector flags it" ⟺ "heal would pause it" — no perpetual false-positives.
  return collectInventoryWatches(conv).some(w => w && String(w?.status ?? "").toLowerCase() !== "paused");
}

// Pure, read-only. Returns the state-contradiction anomalies for ONE conversation (empty when healthy).
export function auditConversationOutcome(conv: AuditableConv, opts: { now?: Date } = {}): OutcomeAnomaly[] {
  const out: RawAnomaly[] = [];
  if (!conv) return [];
  const now = opts.now ?? new Date();
  const base = { convId: String(conv.id ?? ""), leadKey: String(conv.leadKey ?? "") };
  const closed = isClosed(conv);
  const cad = conv.followUpCadence;
  const cadActive = String(cad?.status ?? "").toLowerCase() === "active";
  const appt = conv.appointment;

  // 1. A "confirmed" appointment with NO calendar event — silently skipped by the reminder + outcome
  //    sweeps (they gate on bookedEventId). Net-new (no heal yet). Audit P1.5.
  if (String(appt?.status ?? "").toLowerCase() === "confirmed" && !String(appt?.bookedEventId ?? "").trim()) {
    out.push({
      ...base,
      dimension: "appointment_confirmed_no_event",
      severity: "P1",
      healed: false,
      detail: `appointment.status=confirmed but bookedEventId is empty (whenText=${appt?.whenText ?? "?"})`
    });
  }

  // 2. Inventory watch still ACTIVE on a closed/sold conversation — a reopen can refire "it's available
  //    again!" to a customer who already bought/closed. Net-new (only the opt-out path pauses today).
  if (closed && hasActiveWatch(conv)) {
    out.push({ ...base, dimension: "watch_active_on_closed", severity: "P2", healed: true, detail: "inventoryWatch active on a closed/sold conversation" });
  }

  // 2b. A watch that NOTIFIED a unit LESS specific than the watched model — a trim-specific watch fired on
  //     a base unit (Jason, 6/26: a "Street Glide Special" watch drafted a base "Street Glide"). At fire
  //     time the engine stamps the NOTIFIED unit's model (lastNotifiedModel); if the WATCH model strictly
  //     includes (is more specific than) that unit's model, the engine matched too loosely — the exact
  //     inverse of the directional matcher (a more-specific watch must NEVER fire on a less-specific unit;
  //     that direction is never legitimate). Independent of the engine's own match path, so it catches a
  //     REGRESSION of the directional fix (index.ts inventoryItemMatchesWatch). Recent fires only (fresh
  //     signal; the loop's dedup suppresses repeats). SCOPED to this high-confidence signature — the broader
  //     "different family/catalog over-match" class stays with the LLM open-critic (wrong_watch_model) to
  //     avoid false-positives on legitimate family watches (e.g. a "Sportster" watch on an "Iron 883").
  //     Net-new (no auto-heal): the real fix is the matcher; a hit means it regressed or a new fire path bypassed it.
  const WRONG_MODEL_FIRE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
  for (const w of collectInventoryWatches(conv as any)) {
    const watchModel = String(w?.model ?? "").trim();
    const notifiedModel = String(w?.lastNotifiedModel ?? "").trim();
    if (!watchModel || !notifiedModel) continue;
    const firedAtMs = Date.parse(String(w?.lastNotifiedAt ?? ""));
    if (!Number.isFinite(firedAtMs) || now.getTime() - firedAtMs > WRONG_MODEL_FIRE_WINDOW_MS) continue;
    // Compare on JUNK-STRIPPED labels: stored watch models sometimes carry a glued make prefix
    // ("HARLEY-DAVIDSON Street Glide", +17165600980) or OEM model/paint codes ("Flhtcutg 1mad Tri
    // Glide Ultra", +17166021492) from feed-sourced creation paths. Those tokens are FAKE
    // specificity — the fire was correct — so they must not trip the strictly-more-specific test.
    // Real trim words (Special/Limited/ST/CVO/Ultra/Classic) are plain words the stripper never
    // touches, so a genuine directional-matcher regression still flags.
    const watchModelCore = stripWatchModelJunkTokens(watchModel);
    const notifiedModelCore = stripWatchModelJunkTokens(notifiedModel);
    // watch strictly MORE specific than the unit it notified (watch includes unit, unit does NOT include watch).
    if (modelMatches(watchModelCore, notifiedModelCore) && !modelMatches(notifiedModelCore, watchModelCore)) {
      out.push({
        ...base,
        dimension: "watch_fired_wrong_model",
        severity: "P2",
        healed: false,
        detail: `inventory watch for "${watchModel}" notified a less-specific unit "${notifiedModel}" (trim-specific watch fired on a base unit — directional-matcher regression)`
      });
    }
  }

  // 3. Follow-up cadence ACTIVE on a closed/sold conv (post_sale is legitimate). Should be 0
  //    (stopFollowUpCadence on close). A hit = a close path that didn't stop the cadence.
  if (closed && cadActive && cad?.kind !== "post_sale") {
    out.push({ ...base, dimension: "cadence_active_on_closed", severity: "P1", healed: false, detail: `followUpCadence active (kind=${cad?.kind ?? "?"}) on a closed/sold conversation` });
  }

  // 4. Cadence ACTIVE while handed off to a human — could auto-text mid-handoff. A reconcile heal pauses
  //    this, so a hit is a regression (a handoff path that bypassed setFollowUpMode's guard). CARVE-OUT:
  //    long_term / post_sale cadences are INTENTIONALLY kept through a handoff (matches the heal's own
  //    carve-out + stopFollowUpCadence) — flagging them is a false positive (model the hold conditions).
  if (
    !closed &&
    cadActive &&
    conv.followUp?.mode === "manual_handoff" &&
    cad?.kind !== "long_term" &&
    cad?.kind !== "post_sale"
  ) {
    out.push({ ...base, dimension: "cadence_active_while_handoff", severity: "P1", healed: true, detail: `followUpCadence active (kind=${cad?.kind ?? "?"}) while followUp.mode=manual_handoff` });
  }

  // 5. A held "needs reply" flag that a REAL reply already cleared — the inbox shows "needs reply"
  //    forever. A reconcile heal clears it, so a hit is a regression. (Same rule as healStaleHeldFlag,
  //    read-only: a real outbound exists AFTER the hold timestamp.)
  const heldAtMs = Date.parse(String(conv.draftHeld?.at ?? ""));
  if (!closed && conv.draftHeld && Number.isFinite(heldAtMs)) {
    const repliedAfter = (conv.messages ?? []).some(m => {
      if (m?.direction !== "out" || !REAL_OUTBOUND_CONTACT_PROVIDERS.has(String(m?.provider ?? ""))) return false;
      const t = Date.parse(String(m?.at ?? ""));
      return Number.isFinite(t) && t > heldAtMs;
    });
    if (repliedAfter) {
      // STATE cleanup: a real reply went out after the hold → the flag should have cleared (heal regression).
      out.push({ ...base, dimension: "stale_held_flag", severity: "P2", healed: true, detail: "draftHeld set but a real reply went out after the hold" });
    } else {
      // COMPREHENSION miss: the draft judge HELD this reply (out-of-context / fabrication / unsafe) and
      // no real reply has gone out — the agent couldn't answer this turn correctly. The system already
      // diagnosed it (frame + steering), which is exactly the loop's parser-first fix input.
      out.push({
        ...base,
        dimension: "held_draft_unresolved",
        severity: "P1",
        healed: false,
        detail: `held (${conv.draftHeld?.heldKind ?? conv.draftHeld?.reason ?? "?"}${conv.draftHeld?.frame ? `/${conv.draftHeld.frame}` : ""}) and unresolved — no reply sent`
      });
    }
  }

  // 5b. Context-fidelity SHADOW flag unresolved (Net 1): the scorer flagged this draft as answering out
  //     of context (MAJOR), the gate is in SHADOW so it published anyway, and NO corrective reply went
  //     out after — i.e. an out-of-context reply that NO human caught. This is the proactive net for
  //     the "answering out of context" class: the model's OWN self-critique, surfaced to the loop
  //     without waiting for a 👎 or a manual correction. A DIFFERENT outbound after the flag = corrected
  //     (resolved); the same draft sent as-is (or still pending) = unresolved. Comprehension P2 — the
  //     loop's parser-first fix input is frame + the persisted reason.
  const cfs = conv.contextFidelityShadow;
  const cfsAtMs = Date.parse(String(cfs?.at ?? ""));
  if (cfs && Number.isFinite(cfsAtMs) && String(cfs.severity ?? "").toLowerCase() === "major") {
    const norm = (s: any) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
    const flagged = norm(cfs.draftPreview);
    const correctiveReplyAfter = (conv.messages ?? []).some(m => {
      if (m?.direction !== "out" || !REAL_OUTBOUND_CONTACT_PROVIDERS.has(String(m?.provider ?? ""))) return false;
      const t = Date.parse(String(m?.at ?? ""));
      if (!Number.isFinite(t) || t <= cfsAtMs) return false;
      const body = norm(m?.body);
      return !!body && body !== flagged; // a DIFFERENT reply went out after the flag = corrected
    });
    if (!correctiveReplyAfter) {
      out.push({
        ...base,
        dimension: "context_fidelity_shadow_unresolved",
        severity: "P2",
        healed: false,
        detail: `context-fidelity shadow flagged out-of-context (${cfs.frame ?? "?"}) and no corrective reply followed${cfs.reason ? ` — ${String(cfs.reason).slice(0, 120)}` : ""}`
      });
    }
  }

  // 5c. Material HUMAN CORRECTION (Net 2): staff EDITED the AI draft before sending and the diff-judge
  //     found the change MATERIAL (the human fixed WHAT the reply said — intent / facts / lead-type /
  //     context, not just voice/length). This is the strongest "the agent was wrong here" signal — a
  //     human already corrected it — and the very class Joe kept catching by hand. Surface it so the
  //     loop turns the correction into a parser-first fix (frame + steering are the inputs). Recent only
  //     (a fresh signal; old ones age out — the loop's dedup prevents re-work). Comprehension P2.
  const hc = conv.humanCorrection;
  const hcAtMs = Date.parse(String(hc?.at ?? ""));
  if (hc && Number.isFinite(hcAtMs)) {
    const ageDays = (now.getTime() - hcAtMs) / (1000 * 60 * 60 * 24);
    if (ageDays >= 0 && ageDays <= 21) {
      out.push({
        ...base,
        dimension: "human_correction_material",
        severity: "P2",
        healed: false,
        detail: `staff materially corrected the AI draft (${hc.category ?? "?"})${hc.reason ? ` — ${String(hc.reason).slice(0, 120)}` : ""}`,
        // The correction time is stamped as occurredAt (mirrors negative_feedback below): the corrected
        // draft is at/before it, so a fix commit that postdates it provably postdates the draft. Without
        // this these rows carried NO event time, so the already-shipped echo suppressor could never prove
        // them stale and a per-case fix (e.g. #148, +12282200201 poker-chip) re-fired forever once its
        // 14-day PR-ledger window lapsed. (suppressAlreadyShippedEchoes in anomalyClassifier.)
        occurredAt: new Date(hcAtMs).toISOString()
      });
    }
  }


  // 5e. Cadence-quality suppressed/held (folded from the cadence-quality judge): a PROACTIVE follow-up
  //     message the judge flagged as suppress/hold (a bad unprompted send) — surfaced as a comprehension
  //     gap (the proactive template/parser needs a fix). Recent only (≤21d; a past send, ages out).
  const cqs = conv.cadenceQualityShadow;
  const cqsAtMs = Date.parse(String(cqs?.at ?? ""));
  if (cqs && Number.isFinite(cqsAtMs) && ["suppress", "hold"].includes(String(cqs.overall ?? "").toLowerCase())) {
    const ageDays = (now.getTime() - cqsAtMs) / (1000 * 60 * 60 * 24);
    if (ageDays >= 0 && ageDays <= 21) {
      out.push({
        ...base,
        dimension: "cadence_quality_suppressed",
        severity: "P2",
        healed: false,
        detail: `proactive cadence message judged ${cqs.overall} (${cqs.cadenceKind ?? "?"})${cqs.reason ? ` — ${String(cqs.reason).slice(0, 120)}` : ""}`
      });
    }
  }

  // 6. Unaddressed 👎: the LAST outbound was thumbed-down by a rep. If it's still a PENDING draft, the
  //    closed-loop redraft (Phase 1) should replace it — a hit here is a genuine pipeline miss. Once a
  //    message is actually SENT (provider !== draft_ai), rewriting delivered history is structurally
  //    impossible (mirrors decideFeedbackRedraftTurn's own "can't redraft an already-sent message" gate,
  //    index.ts ratedIsPendingDraft) — so "not yet improved" is never true for it; it's a review/coaching
  //    signal on an already-sent message, not an unresolved auto-fix.
  const lastOut = [...(conv.messages ?? [])].reverse().find(m => m?.direction === "out");
  if (String(lastOut?.feedback?.rating ?? "").toLowerCase() === "down") {
    const ratedIsPendingDraft = lastOut?.provider === "draft_ai" && lastOut?.draftStatus !== "stale";
    // Age-cap (mirrors the cadence_quality_suppressed gate above): a weeks-old thumb-down on an
    // already-SENT message is a review/coaching signal that the nightly feedback loop has long since
    // classified — resurfacing it in every work order forever is pure noise (2026-07-02: all 4
    // negative_feedback items were May sends, 3 of them predating fixes that already shipped). The
    // feedback timestamp is stamped as occurredAt so downstream stale-suppression can reason about
    // age at all (these rows previously carried none).
    const nfAtRaw = String(lastOut?.feedback?.at ?? lastOut?.at ?? "");
    const nfAtMs = Date.parse(nfAtRaw);
    const nfAgeDays = Number.isFinite(nfAtMs) ? (now.getTime() - nfAtMs) / (1000 * 60 * 60 * 24) : null;
    const nfFresh = nfAgeDays == null || (nfAgeDays >= 0 && nfAgeDays <= 21);
    if (nfFresh) {
      out.push({
        ...base,
        dimension: "negative_feedback",
        severity: "P2",
        healed: false,
        ...(Number.isFinite(nfAtMs) ? { occurredAt: new Date(nfAtMs).toISOString() } : {}),
        detail: ratedIsPendingDraft
          ? "a pending draft was thumbed-down and the auto-redraft has not replaced it"
          : "the latest outbound (already sent) was thumbed-down — feedback for review, not an auto-fixable draft"
      });
    }
  }

  // 7. CRM (TLP) update error: the Playwright-driven TLP push (log contact / mark delivered) FAILED
  //    and persisted an open internal question ("TLP log failed for leadRef ..." / "TLP delivered
  //    step failed for leadRef ..."; see buildTlpLogFailureQuestion + the delivered-step sites). The
  //    dealer's CRM is now stale. Surfaced so the loop DIAGNOSES the integration (selector drift /
  //    login / launch timeout) and opens an approve-first fix — never an auto-heal. Recent only
  //    (≤21d). De-noised: skip when the CRM has since logged successfully (crm.lastLoggedAt newer
  //    than the failure) — a transient that already recovered.
  const crmLastLoggedMs = Date.parse(String(conv.crm?.lastLoggedAt ?? ""));
  const crmFailure = (conv.questions ?? [])
    .filter(q => String(q?.status ?? "").toLowerCase() !== "done")
    .filter(q => /\btlp\b[\s\S]*\bfail/i.test(String(q?.text ?? "")))
    .map(q => ({ q, atMs: Date.parse(String(q?.createdAt ?? "")) }))
    .filter(({ atMs }) => Number.isFinite(atMs) && (now.getTime() - atMs) / (1000 * 60 * 60 * 24) <= 21)
    .filter(({ atMs }) => !(Number.isFinite(crmLastLoggedMs) && crmLastLoggedMs >= atMs))
    .sort((a, b) => b.atMs - a.atMs)[0];
  if (crmFailure) {
    out.push({
      ...base,
      dimension: "crm_update_error",
      severity: "P2",
      healed: false,
      detail: String(crmFailure.q.text ?? "CRM update failed").slice(0, 180)
    });
  }

  // 8. CRM log STALE (the coverage-gap blind spot, distinct from crm_update_error): a REAL outbound
  //    was SENT (provider twilio/human/sendgrid or a Twilio sid) NEWER than the last successful TLP
  //    log, with a resolvable leadRef and NO open TLP-failure question. That means the send never
  //    even ATTEMPTED a CRM log (the auto-send paths — cadence, appointment-confirm, webhook autopilot
  //    — don't trigger logging today), so it's INVISIBLE to crm_update_error (which only fires on a
  //    persisted failure). Surfaced so the wiring gap is caught + fixed. Exclusive with
  //    crm_update_error. De-noised: requires a leadRef; recent sends (< CRM_LOG_STALE_DAYS, the
  //    fire-and-forget async window) don't trip; ≤21d recency cap; draft_ai (suggest-mode, never sent)
  //    does not count as a send.
  const leadRef = String(conv.lead?.leadRef ?? "").trim();
  const hasCrmFailure = out.some(a => a.dimension === "crm_update_error");
  if (leadRef && !hasCrmFailure) {
    const staleDays = Number(process.env.CRM_LOG_STALE_DAYS ?? 2);
    const sentOutMs = (conv.messages ?? [])
      .filter(
        m =>
          m?.direction === "out" &&
          !!m?.body &&
          (["twilio", "human", "sendgrid"].includes(String(m?.provider ?? "").toLowerCase()) ||
            !!String((m as any)?.sid ?? "").trim())
      )
      .map(m => Date.parse(String(m?.at ?? "")))
      .filter(t => Number.isFinite(t));
    const lastSentMs = sentOutMs.length ? Math.max(...sentOutMs) : NaN;
    if (Number.isFinite(lastSentMs)) {
      const crmByRef = conv.crm?.lastLoggedAtByLeadRef?.[leadRef];
      const crmLoggedMs = Date.parse(String(crmByRef ?? conv.crm?.lastLoggedAt ?? ""));
      const loggedAfterSend = Number.isFinite(crmLoggedMs) && crmLoggedMs >= lastSentMs;
      const ageDays = (now.getTime() - lastSentMs) / (1000 * 60 * 60 * 24);
      if (!loggedAfterSend && ageDays >= staleDays && ageDays <= 21) {
        out.push({
          ...base,
          dimension: "crm_log_stale",
          severity: "P2",
          healed: false,
          // The triggering event is the un-logged SEND; surfaced so the stale-finding suppressor can drop
          // sends that predate the TLP-autosend-coverage fix (a pre-fix send can never be re-logged).
          occurredAt: new Date(lastSentMs).toISOString(),
          detail: `a sent outbound (${Math.round(ageDays)}d ago) is newer than the last TLP log${
            Number.isFinite(crmLoggedMs) ? ` (${Math.round((now.getTime() - crmLoggedMs) / (1000 * 60 * 60 * 24))}d ago)` : " (never logged)"
          } — no failure recorded (the send never attempted a CRM log)`
        });
      }
    }
  }

  return out.map(a => ({ ...a, category: categoryFor(a.dimension) }));
}

export type OutcomeAuditSummary = {
  conversationsScanned: number;
  totalAnomalies: number;
  byDimension: Record<string, number>;
  byCategory: Record<OutcomeCategory, number>;
  bySeverity: Record<OutcomeSeverity, number>;
  regressionAnomalies: number; // hits on a `healed` dimension — a reconcile heal lagged/missed
};

// Store-level audit: per-conv detectors over all conversations + the orphan-todo check (an open todo
// whose conversation no longer exists in the store). Pure, read-only.
export function auditConversationStore(input: {
  conversations: AuditableConv[];
  todos?: Array<{ convId?: string | null; status?: string | null; summary?: string | null; autoCloseCheck?: { decision?: string | null } | null }>;
  now?: Date;
}): { anomalies: OutcomeAnomaly[]; summary: OutcomeAuditSummary } {
  const convs = Array.isArray(input.conversations) ? input.conversations : [];
  const now = input.now ?? new Date();
  const anomalies: OutcomeAnomaly[] = [];
  for (const conv of convs) anomalies.push(...auditConversationOutcome(conv, { now }));

  // Orphan todos: an open todo pointing at a conversation that isn't in the store.
  // PLUS task-fulfillment regression (folded from the task-autoclose detector): an OPEN task whose
  // autoCloseCheck recorded decision="closed" — the auto-close DECIDED to close it but it's still open,
  // so the close didn't apply (healed by the autoclose path → a lingering one is a regression). Reads the
  // already-persisted task verdict; no LLM, no inventory.
  const convIds = new Set(convs.map(c => String(c.id ?? "")));
  for (const t of input.todos ?? []) {
    if (String(t?.status ?? "") !== "open") continue;
    const cid = String(t?.convId ?? "");
    if (cid && !convIds.has(cid)) {
      anomalies.push({ convId: cid, leadKey: "", dimension: "orphan_todo", category: categoryFor("orphan_todo"), severity: "P2", healed: false, detail: `open todo on a conversation not in the store: ${String(t?.summary ?? "").slice(0, 60)}` });
    }
    if (String(t?.autoCloseCheck?.decision ?? "").toLowerCase() === "closed") {
      anomalies.push({ convId: cid, leadKey: "", dimension: "task_autoclose_regression", category: categoryFor("task_autoclose_regression"), severity: "P2", healed: true, detail: `task auto-close decided "closed" but the task is still open: ${String(t?.summary ?? "").slice(0, 60)}` });
    }
  }

  const byDimension: Record<string, number> = {};
  const byCategory: OutcomeAuditSummary["byCategory"] = { state: 0, comprehension: 0, feedback: 0, discovery: 0 };
  const bySeverity: OutcomeAuditSummary["bySeverity"] = { P1: 0, P2: 0, P3: 0 };
  let regressionAnomalies = 0;
  for (const a of anomalies) {
    byDimension[a.dimension] = (byDimension[a.dimension] ?? 0) + 1;
    byCategory[a.category] += 1;
    bySeverity[a.severity] += 1;
    if (a.healed) regressionAnomalies += 1;
  }
  return {
    anomalies,
    summary: { conversationsScanned: convs.length, totalAnomalies: anomalies.length, byDimension, byCategory, bySeverity, regressionAnomalies }
  };
}

// Net 3 — turn an OPEN-ENDED critic verdict (critiqueConversationHandlingWithLLM) into a feed anomaly.
// Pure + deterministic so it's eval-pinned (the LLM call lives in the sweep; this decides what's worth
// surfacing). Conservative: only a CLEAR, MAJOR, high-confidence mishandling escalates — the critic is
// the noisiest net, and a discovery is an UNCONFIRMED new class (Tier 2 escalate, never auto-patched).
// The model-proposed issueClass rides along in the detail = the candidate new gap class for Joe to review.
export type OpenCriticFinding = {
  hasIssue?: boolean;
  severity?: string | null;
  issueClass?: string | null;
  reason?: string | null;
  confidence?: number | null;
};

// Turn-action summary for the cross-model TURN critic (Net 3, broadened from reply-only). The conversation
// object already records what the agent DID this turn — the parsed lead fields, the route it chose, the
// cadence kind, active watches, open tasks, the handoff mode, the appointment. Surfacing that to the critic
// lets it judge the agent's ACTIONS (reply + side-effects), not just the reply text — so a wrong parse /
// wrong watch model / mis-route / wrong cadence / deflected booking / missing task is caught even when the
// reply reads fine. Pure + read-only. (Inventory/policy enrichment is a separate, optional follow-on.)
export function summarizeTurnActions(
  conv: any,
  openTodos?: Array<{ reason?: string | null; summary?: string | null }>
): {
  leadSource: string | null;
  parsedVehicle: string | null;
  tradeVehicle: string | null;
  purchaseTimeframe: string | null;
  route: { bucket: string | null; cta: string | null };
  dialogState: string | null;
  handoffMode: string | null;
  cadence: { kind: string | null; status: string | null };
  activeWatches: Array<{ model: string | null; year: number | null; condition: string | null }>;
  openTasks: Array<{ reason: string | null; summary: string | null }>;
  appointment: { status: string | null; booked: boolean; whenText: string | null };
} {
  const fmtVeh = (x: any) => {
    const s = [x?.year, x?.model ?? x?.description].filter(Boolean).join(" ").trim();
    return s || null;
  };
  const watches = collectInventoryWatches(conv)
    .filter((w: any) => w && String(w?.status ?? "active").toLowerCase() !== "paused")
    .map((w: any) => ({ model: w?.model ?? null, year: typeof w?.year === "number" ? w.year : null, condition: w?.condition ?? null }));
  return {
    leadSource: conv?.lead?.source ?? null,
    parsedVehicle: fmtVeh(conv?.lead?.vehicle ?? {}),
    tradeVehicle: fmtVeh(conv?.lead?.tradeVehicle ?? {}),
    purchaseTimeframe: conv?.lead?.purchaseTimeframe ?? null,
    route: { bucket: conv?.classification?.bucket ?? null, cta: conv?.classification?.cta ?? null },
    dialogState: conv?.dialogState?.name ?? null,
    handoffMode: conv?.followUp?.mode ?? null,
    cadence: { kind: conv?.followUpCadence?.kind ?? null, status: conv?.followUpCadence?.status ?? null },
    activeWatches: watches,
    openTasks: (openTodos ?? []).map(t => ({ reason: t?.reason ?? null, summary: String(t?.summary ?? "").slice(0, 120) || null })),
    appointment: { status: conv?.appointment?.status ?? null, booked: !!conv?.appointment?.bookedEventId, whenText: conv?.appointment?.whenText ?? null }
  };
}

/** A minimal outbound-message shape for authorship classification (open-critic reply selection). */
export type OutboundAuthorshipMsg = {
  direction?: string | null;
  body?: string | null;
  provider?: string | null;
  actorUserName?: string | null;
  actorUserId?: string | null;
  from?: string | null;
  at?: string | null;
};

/**
 * Is this outbound HUMAN-authored (a staff member typed it from scratch or materially EDITED the AI
 * draft)? The send path (`/conversations/:id/send`, index.ts `shouldStampHumanOutboundActor`) stamps
 * `actorUserId`/`actorUserName` ONLY when the sent text did not come from an AI draft, or when staff
 * edited the draft. An AI draft APPROVED UNCHANGED carries NO actor — so the discriminator is the
 * PRESENCE of an actor, NOT the provider (an approved AI draft sends via "twilio" too, so keying on
 * provider would wrongly exclude the high-value staff-approved-AI-draft case).
 */
export function isHumanAuthoredOutbound(m: OutboundAuthorshipMsg | null | undefined): boolean {
  if (!m || m.direction !== "out") return false;
  return Boolean(String(m.actorUserName ?? "").trim() || String(m.actorUserId ?? "").trim());
}

/**
 * Select the reply the OPEN-CRITIC should grade as the AGENT's, from a chronological (ascending)
 * message list. The critic judges the agent's handling — it must never grade a human-typed/edited send
 * as an agent error. Kurtis Stone's manual self-intro ("hello stone from American Harley…" — a missing
 * comma after his own name) was misread by the critic as the agent addressing the CUSTOMER as "Stone"
 * (2026-06-30, the false-positive "name-bleed" cluster). Returns the latest real (sent) outbound IFF it
 * is agent-authored; if the latest real outbound is human-authored, a human is driving the thread, so we
 * return null and the sweep skips the conversation. fail-direction: under-report (never flag a human's
 * message as an agent bug); the deterministic detectors still cover side-effects on human-driven threads.
 *
 * A Campaign Studio BROADCAST send is excluded the same way (2026-07-17: the 7/16 "250 Years of
 * Freedom" EVENT blast drew 7 "promotional_blast_sent_to_active_finance_lead"-style findings — and
 * would re-fire after EVERY event blast). Joe's ruling (7/16): EVENT blasts reach active/engaged/sold
 * leads BY DESIGN, and a staff-composed mass send carries no actor stamp yet is not the agent's 1:1
 * decision — so it must never be critiqued as one. Same correlation the voice charter uses
 * (scoringExclusions.isCampaignBroadcastSend: campaignId + ±10s send-window), so a genuine 1:1 agent
 * reply on a campaign-tagged thread (minutes/hours from any send) is still graded.
 */
export function selectOpenCriticAgentReply<T extends OutboundAuthorshipMsg>(
  messages: T[],
  realOutProviders: ReadonlySet<string>,
  campaignThread?:
    | { campaignId?: string | null; firstSentAt?: string | null; lastSentAt?: string | null }
    | null
): T | null {
  const list = Array.isArray(messages) ? messages : [];
  let lastRealOut: T | null = null;
  for (const m of list) {
    if (
      m?.direction === "out" &&
      realOutProviders.has(String(m?.provider ?? "")) &&
      String(m?.body ?? "").trim()
    ) {
      lastRealOut = m;
    }
  }
  if (!lastRealOut) return null;
  if (isHumanAuthoredOutbound(lastRealOut)) return null;
  if (isCampaignBroadcastSend(lastRealOut, campaignThread ?? null)) return null;
  return lastRealOut;
}

export function decideOpenCriticAnomaly(
  finding: OpenCriticFinding,
  base: { convId: string; leadKey?: string | null }
): OutcomeAnomaly | null {
  if (!finding?.hasIssue) return null;
  if (String(finding.severity ?? "").toLowerCase() !== "major") return null;
  const conf = typeof finding.confidence === "number" ? finding.confidence : 1;
  if (!(conf >= 0.8)) return null;
  const issueClass = String(finding.issueClass ?? "").trim() || "unspecified";
  return {
    convId: String(base.convId ?? ""),
    leadKey: String(base.leadKey ?? ""),
    dimension: "open_critic_finding",
    category: categoryFor("open_critic_finding"),
    severity: "P2",
    healed: false,
    detail: `open-critic: ${issueClass}${finding.reason ? ` — ${String(finding.reason).slice(0, 140)}` : ""}`
  };
}

// Intent-handled audit finding (the report-finding shape `intent_handled_audit.ts` writes for an
// UNADDRESSED turn). The semantic LLM judge that catches fluent-but-wrong-intent replies the keyword
// scorers can't — a polite non-answer on a real ask ("what do I do to reserve one" → a notify-when-it-
// arrives non-answer). Mapped into the unified feed below.
export type IntentHandledFinding = {
  convId?: string | null;
  severity?: string | null; // "none" | "minor" | "major"
  replyKind?: string | null; // "sent" | "draft"
  customerAsk?: string | null;
  why?: string | null;
};

// Maps a MAJOR intent-handled miss into the self-healing loop's OutcomeAnomaly feed so DETECT→CLASSIFY
// turns it into a parser-first fix (comprehension → Tier 1 parser_fix_candidate, customer-facing → notify,
// PR-first until the dimension graduates). Mirrors decideOpenCriticAnomaly. Noise floor: only `major` (a
// clear high-intent ask that got a non-answer) crosses — minor/none never become work orders. fail-direction
// none (a report-only feed; the loop is approve-first and the ci:eval gate is non-negotiable downstream).
export function decideIntentHandledAnomaly(
  finding: IntentHandledFinding,
  base?: { leadKey?: string | null }
): OutcomeAnomaly | null {
  if (String(finding?.severity ?? "").toLowerCase() !== "major") return null;
  const convId = String(finding?.convId ?? "").trim();
  if (!convId) return null;
  const ask = String(finding?.customerAsk ?? "").trim();
  const why = String(finding?.why ?? "").trim();
  const kind = finding?.replyKind === "draft" ? "draft" : "sent";
  return {
    convId,
    leadKey: String(base?.leadKey ?? ""),
    dimension: "intent_unaddressed",
    category: categoryFor("intent_unaddressed"),
    severity: "P2",
    healed: false,
    detail: `intent-unaddressed (${kind}): ${ask || "—"}${why ? ` — ${why.slice(0, 140)}` : ""}`
  };
}

// Operator-reported ops anomaly (the existing dashboard "Report issue" feed, opsAnomalyStore). This maps
// an OPS anomaly into the self-healing loop's OutcomeAnomaly feed so the button operators ALREADY use
// drives parser-first fix PRs (on top of its existing support-ticket flow). Only the AGENT-BEHAVIOR types
// cross — the loop's only tool is an agent-behavior code fix, so routing/cadence/appointment/task/handoff/
// other feed it; tone (covered by 👎 + the voice layer) and the infra types (inventory/integration/ui)
// stay support-only. Gated to a conversation-scoped, open, recent, non-info report with a note. The
// classifier escalates `reported_issue` Tier 2 (approve-first), with the note as the fix steering.
const OPS_ANOMALY_LOOP_TYPES = new Set(["routing", "cadence", "appointment", "task_inbox", "handoff", "other"]);
export type OpsAnomalyReport = {
  id?: string | null;
  type?: string | null;
  severity?: string | null;
  title?: string | null;
  note?: string | null;
  status?: string | null;
  createdAt?: string | null;
  context?: { convId?: string | null; leadKey?: string | null } | null;
};
export function decideOpsAnomalyReportedIssue(a: OpsAnomalyReport, opts?: { now?: Date }): OutcomeAnomaly | null {
  if (String(a?.status ?? "open").toLowerCase() === "closed") return null;
  const type = String(a?.type ?? "").toLowerCase();
  if (!OPS_ANOMALY_LOOP_TYPES.has(type)) return null; // support-only types skip the code loop
  if (String(a?.severity ?? "warning").toLowerCase() === "info") return null; // low-signal FYI
  const convId = String(a?.context?.convId ?? "").trim();
  if (!convId) return null; // agent-behavior reports are conversation-scoped; the loop needs it for context
  const note = String(a?.note || a?.title || "").trim();
  if (!note) return null;
  const atMs = Date.parse(String(a?.createdAt ?? ""));
  if (Number.isFinite(atMs)) {
    const ageDays = ((opts?.now ?? new Date()).getTime() - atMs) / (1000 * 60 * 60 * 24);
    if (ageDays < 0 || ageDays > 21) return null;
  }
  return {
    convId,
    leadKey: String(a?.context?.leadKey ?? ""),
    dimension: "reported_issue",
    category: categoryFor("reported_issue"),
    severity: "P2",
    healed: false,
    detail: `operator-reported (${type}): ${note.slice(0, 180)}`,
    // Upper bound on the offending reply — never occurredAt (see the OutcomeAnomaly field note).
    ...(Number.isFinite(atMs) ? { reportedAt: new Date(atMs).toISOString() } : {})
  };
}

// Thumbs-down NOTE → staff-action anomaly (2026-07-10). A rep types a note into the 👎 box that is
// really an INSTRUCTION for a live customer ("book him in at 9:30"), not a code-defect report. The
// sweep runs parseThumbsDownNoteWithLLM + decideThumbsDownNoteRouting and, when the route is
// staff_action, calls this to emit the digest work order. Pure: the parse + route are computed at the
// call site and passed in, so the mapper stays deterministic and eval'able (mirrors the ops-anomaly
// mapper). Returns null for any non-staff route or a note we couldn't anchor to a message.
export type ThumbsDownActionInput = {
  convId: string;
  leadKey?: string | null;
  note: string;
  route: "staff_action" | "reply_defect" | "record_only";
  actionSummary?: string | null;
  // ISO timestamp the 👎 was recorded (feedback.at) — the EXACT reply the note is about, so unlike an
  // operator report this is a true occurredAt, not just an upper bound.
  ratedAt?: string | null;
};
export function decideThumbsDownActionAnomaly(input: ThumbsDownActionInput): OutcomeAnomaly | null {
  if (input.route !== "staff_action") return null; // reply_defect/record_only go to the code-fix diagnosis lane
  const convId = String(input.convId ?? "").trim();
  if (!convId) return null;
  const note = String(input.note ?? "").trim();
  if (!note) return null;
  const summary = String(input.actionSummary ?? "").trim();
  const atMs = Date.parse(String(input.ratedAt ?? ""));
  return {
    convId,
    leadKey: String(input.leadKey ?? ""),
    dimension: "thumbs_down_action_request",
    category: categoryFor("thumbs_down_action_request"),
    severity: "P2",
    healed: false,
    detail: `thumbs-down note = staff action${summary ? `: ${summary.slice(0, 140)}` : ""} — “${note.slice(0, 140)}”`,
    // The 👎 is anchored to the exact rated reply, so this IS the triggering event — a real occurredAt.
    ...(Number.isFinite(atMs) ? { occurredAt: new Date(atMs).toISOString() } : {})
  };
}
