import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type AnyObj = Record<string, any>;
type OutcomeFamily = "dealer_ride" | "appointment" | "finance";
type FindingSeverity = "P1" | "P2" | "P3";
type RecommendationType = "few_shot_example" | "schema_review" | "guard_eval" | "no_change";

type ParsedArgs = {
  conversationsPath: string;
  outDir: string;
  sinceHours: number;
};

type LoadedStore = {
  conversations: AnyObj[];
  todos: AnyObj[];
};

type OutcomeCase = {
  id: string;
  family: OutcomeFamily;
  convId: string;
  leadKey: string | null;
  leadRef: string | null;
  customerName: string | null;
  ownerName: string | null;
  mode: string | null;
  source: string;
  status: string | null;
  primaryStatus: string | null;
  secondaryStatus: string | null;
  note: string;
  updatedAt: string;
  /**
   * When a LATER outcome exists on this same conversation, its timestamp — otherwise null.
   *
   * `conv.followUp` is a single mutable slot: every outcome that lands rewrites the same
   * reason/mode. So for any outcome that is not the newest one on its conversation, the
   * follow-up state we can read today belongs to a LATER event, and asking "did THIS outcome
   * route correctly?" has no answer left in the record. Checks that grade routing consult this
   * before firing.
   */
  supersededByOutcomeAt: string | null;
  followUpMode: string | null;
  followUpReason: string | null;
  cadenceStatus: string | null;
  cadenceKind: string | null;
  nextDueAt: string | null;
  preferredContactMethod: string | null;
  customerFacingAfterOutcome: Array<{
    id: string | null;
    provider: string | null;
    at: string | null;
    body: string;
  }>;
  openTasks: Array<{
    id: string | null;
    reason: string | null;
    taskClass: string | null;
    summary: string;
    dueAt: string | null;
  }>;
  cueTags: string[];
};

type OutcomeFinding = {
  id: string;
  severity: FindingSeverity;
  family: OutcomeFamily;
  issue: string;
  title: string;
  detail: string;
  caseId: string;
  leadRef: string | null;
  customerName: string | null;
  evidence: AnyObj;
  suggestedFix: {
    type: RecommendationType;
    parserTarget: string;
    confidenceTarget: number | null;
    action: string;
  };
};

type ParserSeedCandidate = {
  id: string;
  family: OutcomeFamily;
  recommendation: RecommendationType;
  parserTarget: string;
  confidenceTarget: number;
  customerName: string | null;
  leadRef: string | null;
  note: string;
  observed: {
    status: string | null;
    primaryStatus: string | null;
    secondaryStatus: string | null;
    followUpMode: string | null;
    cadenceStatus: string | null;
    customerFacingText: string | null;
  };
  proposedExpected: AnyObj;
  reason: string;
  cueTags: string[];
};

type OutcomeQaReport = {
  ok: true;
  generatedAt: string;
  source: {
    conversationsPath: string;
    sinceHours: number | null;
    windowStart: string | null;
  };
  summary: {
    outcomeCount: number;
    findingCount: number;
    parserSeedCandidateCount: number;
    byFamily: Array<{ family: OutcomeFamily; count: number }>;
    findingsByIssue: Array<{ issue: string; count: number }>;
    parserRecommendationsByType: Array<{ type: RecommendationType; count: number }>;
  };
  cases: OutcomeCase[];
  findings: OutcomeFinding[];
  parserSeedCandidates: ParserSeedCandidate[];
};

export function parseArgs(argv: string[]): ParsedArgs {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) continue;
    args.set(key, value);
    i += 1;
  }

  const cwd = process.cwd();
  const dataDir = process.env.DATA_DIR || path.resolve(cwd, "data");
  const conversationsPath =
    args.get("--conversations") ||
    process.env.CONVERSATIONS_DB_PATH ||
    process.env.CONVERSATIONS_PATH ||
    path.join(dataDir, "conversations.json");
  const outDir =
    args.get("--out-dir") ||
    process.env.OUTCOME_QA_OUT_DIR ||
    path.resolve(cwd, "reports", "outcome_qa");
  const sinceRaw = Number(
    args.get("--since-hours") ||
      process.env.OUTCOME_QA_SINCE_HOURS ||
      process.env.AUDIT_SINCE_HOURS ||
      "24"
  );

  return {
    conversationsPath,
    outDir,
    sinceHours: Number.isFinite(sinceRaw) && sinceRaw >= 0 ? sinceRaw : 24
  };
}

function normText(input: unknown): string {
  return String(input ?? "")
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function toIso(input: unknown): string | null {
  const text = String(input ?? "").trim();
  if (!text) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function toMs(input: unknown): number {
  const iso = toIso(input);
  return iso ? Date.parse(iso) : NaN;
}

function loadStore(filePath: string): LoadedStore {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (Array.isArray(raw)) return { conversations: raw, todos: [] };
  return {
    conversations: Array.isArray(raw?.conversations) ? raw.conversations : [],
    todos: Array.isArray(raw?.todos) ? raw.todos : []
  };
}

function leadName(conv: AnyObj): string | null {
  const lead = conv?.lead ?? {};
  const direct = normText(lead?.name);
  if (direct) return direct;
  const joined = normText(`${lead?.firstName ?? ""} ${lead?.lastName ?? ""}`);
  return joined || null;
}

function leadRef(conv: AnyObj): string | null {
  return normText(conv?.lead?.leadRef ?? conv?.leadRef) || null;
}

function leadKey(conv: AnyObj): string | null {
  return normText(conv?.leadKey ?? conv?.id) || null;
}

function firstName(input: unknown): string {
  return normText(input).split(/\s+/).filter(Boolean)[0] ?? "";
}

function isCustomerFacingProvider(provider: unknown): boolean {
  const key = normText(provider).toLowerCase();
  return key === "draft_ai" || key === "human" || key === "twilio" || key === "sendgrid";
}

function isInternalActionLog(text: string): boolean {
  return /^context note applied actions by\b/i.test(text) || /\bcontext_note_[a-z_]+:/i.test(text);
}

function openTodosFor(conv: AnyObj, allTodos: AnyObj[]): AnyObj[] {
  const embedded = Array.isArray(conv?.todos) ? conv.todos : [];
  return [...embedded, ...allTodos.filter(todo => String(todo?.convId ?? "") === String(conv?.id ?? ""))]
    .filter(todo => normText(todo?.status || "open").toLowerCase() === "open");
}

function compactTask(todo: AnyObj) {
  return {
    id: todo?.id ?? null,
    reason: normText(todo?.reason) || null,
    taskClass: normText(todo?.taskClass) || null,
    summary: normText(todo?.summary).slice(0, 280),
    dueAt: toIso(todo?.dueAt)
  };
}

/**
 * The dealer-ride thank-you is published when the RIDE LEAD LANDS — the ingest
 * arm publishes `dealerRideInitialThankYouDraft` and SMSes the salesperson the
 * outcome prompt in the same breath ("the ride happened; thank them once while
 * the outcome stays with the salesperson"). Staff answer that prompt whenever
 * they get to it, so anchoring the customer-facing window to the OUTCOME
 * timestamp with a 60s grace calls the thank-you missing for every ride where
 * the salesperson took longer than a minute to reply — i.e. nearly all of them
 * (2026-08-01: Charles Desalvo, draft at 18:35:34Z, outcome at 18:36:48Z, 74s
 * apart → phantom P1 that failed the release gate). Anchor to the notify moment
 * when we have it, keeping the same grace.
 */
function dealerRideFollowUpAnchorMs(conv: AnyObj): number | null {
  const anchor = toMs(conv?.dealerRide?.staffNotify?.followUpSentAt);
  return Number.isFinite(anchor) ? anchor : null;
}

function customerFacingAfter(
  conv: AnyObj,
  outcomeAt: string,
  anchorMs: number | null = null
): OutcomeCase["customerFacingAfterOutcome"] {
  const outcomeMs = Date.parse(outcomeAt);
  if (!Number.isFinite(outcomeMs)) return [];
  const windowStartMs = Math.min(outcomeMs, anchorMs != null ? anchorMs : outcomeMs) - 60 * 1000;
  const messages = Array.isArray(conv?.messages) ? conv.messages : [];
  return messages
    .filter(msg => {
      if (normText(msg?.direction).toLowerCase() !== "out") return false;
      if (!isCustomerFacingProvider(msg?.provider)) return false;
      if (normText(msg?.draftStatus).toLowerCase() === "stale") return false;
      const body = normText(msg?.body);
      if (!body || isInternalActionLog(body)) return false;
      const msgMs = toMs(msg?.at);
      return Number.isFinite(msgMs) && msgMs >= windowStartMs;
    })
    .sort((a, b) => toMs(a?.at) - toMs(b?.at))
    .slice(0, 5)
    .map(msg => ({
      id: msg?.id ?? null,
      provider: normText(msg?.provider) || null,
      at: toIso(msg?.at),
      body: normText(msg?.body)
    }));
}

function cueTagsFor(note: string): string[] {
  const text = note.toLowerCase();
  const tags: string[] = [];
  const add = (tag: string, pattern: RegExp) => {
    if (pattern.test(text) && !tags.includes(tag)) tags.push(tag);
  };
  add("not_ready_or_thinking", /\b(not ready|think|thinking|wait|later|not now|next spring|several days|few days)\b/);
  add("specific_follow_up_time", /\b(next week|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2})\b/);
  add("call_requested", /\b(call|phone|ring|talk)\b/);
  add("docs_or_info_needed", /\b(proof|income|insurance|license|docs?|document|stip|information|info|need(s|ed)? more)\b/);
  add("finance_decision", /\b(approved|approval|declined|denied|not approved|bank|lender|credit)\b/);
  add("waiting_on_payoff", /\b(payoff|pay off|lien|title)\b/);
  add("hold_or_deposit", /\b(hold|deposit|reserved|on hold)\b/);
  add("sold_or_delivered", /\b(sold|bought|delivered|took delivery|congrats)\b/);
  add("lost_or_bought_elsewhere", /\b(bought elsewhere|went elsewhere|lost|not interested)\b/);
  add("related_party_context", /\b(daughter|son|wife|husband|girlfriend|boyfriend|friend|father|mother)\b/);
  add("inventory_or_model_context", /\b(street glide|road glide|fat boy|breakout|iron|sportster|trike|bike|motorcycle)\b/);
  return tags;
}

function parserTargetFor(family: OutcomeFamily): string {
  if (family === "finance") return "finance_outcome_update_parser";
  return "appointment_outcome_follow_up_plan_parser";
}

function proposedExpectedFor(row: OutcomeCase): AnyObj {
  if (row.family === "finance") {
    return {
      family: "finance",
      status: row.status,
      explicitOutcome: true,
      requiredInfo: row.cueTags.includes("docs_or_info_needed") ? "extract from note without inventing" : null,
      customerDraftPolicy: "safe_handoff_or_staff_review",
      forbid: ["rates", "payments", "approval terms", "lender claims unless present in note"],
      confidence: ">= configured finance outcome threshold"
    };
  }
  return {
    family: row.family,
    primaryStatus: row.primaryStatus,
    secondaryStatus: row.secondaryStatus,
    followUpNeeded:
      row.secondaryStatus === "needs_follow_up" ||
      row.secondaryStatus === "not_ready" ||
      row.status === "follow_up",
    customerDraftPolicy:
      row.family === "dealer_ride"
        ? "thank customer for the test ride; do not assume agreed next steps"
        : "draft only when the outcome requires customer-facing reschedule/follow-up",
    contextFacts: row.cueTags,
    confidence: ">= configured appointment outcome threshold"
  };
}

function recommendationType(row: OutcomeCase, relatedFindings: OutcomeFinding[]): RecommendationType {
  if (relatedFindings.some(f => f.suggestedFix.type === "guard_eval")) return "guard_eval";
  if (!row.note) return "no_change";
  if (row.status === "other" || row.secondaryStatus === "other") return "schema_review";
  if (row.cueTags.includes("related_party_context") || row.cueTags.includes("waiting_on_payoff")) {
    return "few_shot_example";
  }
  if (row.family === "finance" && row.cueTags.includes("docs_or_info_needed")) return "few_shot_example";
  if (row.cueTags.length) return "few_shot_example";
  return "no_change";
}

function noteSupportsAssumedNextSteps(note: string): boolean {
  return /\b(next step|talked|discussed|agreed|plan|planned|scheduled|appointment|call|come back|bring|send|text|follow up|follow-up)\b/i.test(
    note
  );
}

function firstIdentityName(text: string): string | null {
  const match = text.match(/\bthis is\s+([A-Za-z][A-Za-z'-]*)\b/i);
  return match?.[1] ? normText(match[1]) : null;
}

function latestCustomerText(row: OutcomeCase): string | null {
  return row.customerFacingAfterOutcome[0]?.body ?? null;
}

/**
 * A ride that ended in a SALE hands the customer to the post-sale lane, and the
 * pre-outcome "thanks for coming in for the test ride, let me know if questions
 * come up" draft is then WRONG — so the publisher correctly marks it stale when
 * the sale is logged. Charles Desalvo (2026-08-01) is the case: sold at 18:36Z,
 * thank-you draft staled, post_sale cadence active with the next touch already
 * scheduled. Demanding a separate thank-you there flags the system for doing the
 * right thing. Excluded only when the post-sale cadence is actually live and
 * scheduled to reach them — a sold ride with NO post-sale follow-through still
 * flags, because then nobody is talking to the buyer.
 */
function postSaleLaneOwnsFollowUp(row: OutcomeCase): boolean {
  return (
    String(row.status ?? "").toLowerCase() === "sold" &&
    String(row.cadenceKind ?? "").toLowerCase() === "post_sale" &&
    String(row.cadenceStatus ?? "").toLowerCase() === "active" &&
    !!row.nextDueAt
  );
}

function expectsDealerRideThankYou(row: OutcomeCase): boolean {
  if (row.family !== "dealer_ride") return false;
  const status = String(row.status ?? "").toLowerCase();
  const secondary = String(row.secondaryStatus ?? "").toLowerCase();
  if (status === "no_change" || secondary === "no_change") return false;
  if (row.preferredContactMethod === "phone") return false;
  if (postSaleLaneOwnsFollowUp(row)) return false;
  return true;
}

function hasOpenTask(row: OutcomeCase, pattern: RegExp): boolean {
  return row.openTasks.some(task => pattern.test(`${task.reason ?? ""} ${task.taskClass ?? ""} ${task.summary}`));
}

/**
 * The newest outcome recorded on this conversation AFTER `updatedMs`, or null if this outcome
 * is the latest one. Looks at the same three sources `collectCases` reads, independent of the
 * `--since-hours` window, so a superseding outcome outside the window still counts.
 */
function laterOutcomeAt(conv: AnyObj, updatedMs: number): string | null {
  const stamps = [
    conv?.dealerRide?.staffNotify?.outcome?.updatedAt,
    conv?.appointment?.staffNotify?.outcome?.updatedAt,
    conv?.financeOutcome?.updatedAt,
    conv?.financeOutcomeNotify?.pendingAt
  ]
    .map(value => toIso(value))
    .filter((iso): iso is string => !!iso && Date.parse(iso) > updatedMs)
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  return stamps[0] ?? null;
}

function collectCases(store: LoadedStore, sinceHours: number): OutcomeCase[] {
  const nowMs = Date.now();
  const sinceMs = sinceHours > 0 ? nowMs - sinceHours * 60 * 60 * 1000 : null;
  const cases: OutcomeCase[] = [];

  const pushOutcome = (conv: AnyObj, family: OutcomeFamily, source: string, rawOutcome: AnyObj) => {
    const updatedAt = toIso(rawOutcome?.updatedAt ?? rawOutcome?.pendingAt);
    if (!updatedAt) return;
    const updatedMs = Date.parse(updatedAt);
    if (sinceMs != null && updatedMs < sinceMs) return;
    const note = normText(rawOutcome?.note ?? rawOutcome?.reasonText);
    const id = `${family}:${conv?.id ?? conv?.leadKey ?? "conversation"}:${source}:${updatedAt}`;
    const openTasks = openTodosFor(conv, store.todos).map(compactTask);
    const row: OutcomeCase = {
      id,
      family,
      convId: normText(conv?.id ?? conv?.leadKey) || "unknown",
      leadKey: leadKey(conv),
      leadRef: leadRef(conv),
      customerName: leadName(conv),
      ownerName: normText(conv?.leadOwner?.name) || null,
      mode: normText(conv?.mode ?? conv?.conversationMode) || null,
      source,
      status: normText(rawOutcome?.status) || null,
      primaryStatus: normText(rawOutcome?.primaryStatus) || null,
      secondaryStatus: normText(rawOutcome?.secondaryStatus) || null,
      note,
      updatedAt,
      supersededByOutcomeAt: laterOutcomeAt(conv, updatedMs),
      followUpMode: normText(conv?.followUp?.mode) || null,
      followUpReason: normText(conv?.followUp?.reason) || null,
      cadenceStatus: normText(conv?.followUpCadence?.status) || null,
      cadenceKind: normText(conv?.followUpCadence?.kind) || null,
      nextDueAt: toIso(conv?.followUpCadence?.nextDueAt),
      preferredContactMethod: normText(conv?.lead?.preferredContactMethod).toLowerCase() || null,
      customerFacingAfterOutcome: customerFacingAfter(
        conv,
        updatedAt,
        family === "dealer_ride" ? dealerRideFollowUpAnchorMs(conv) : null
      ),
      openTasks,
      cueTags: cueTagsFor(note)
    };
    cases.push(row);
  };

  for (const conv of store.conversations) {
    const dealerRideOutcome = conv?.dealerRide?.staffNotify?.outcome;
    if (dealerRideOutcome?.updatedAt) {
      pushOutcome(conv, "dealer_ride", "dealerRide.staffNotify.outcome", dealerRideOutcome);
    }

    const appointmentOutcome = conv?.appointment?.staffNotify?.outcome;
    if (appointmentOutcome?.updatedAt) {
      pushOutcome(conv, "appointment", "appointment.staffNotify.outcome", appointmentOutcome);
    }

    const financeOutcome = conv?.financeOutcome;
    if (financeOutcome?.updatedAt) {
      pushOutcome(conv, "finance", "financeOutcome", financeOutcome);
    } else if (conv?.financeOutcomeNotify?.status === "pending" && conv?.financeOutcomeNotify?.pendingAt) {
      pushOutcome(conv, "finance", "financeOutcomeNotify.pending", {
        status: "pending",
        updatedAt: conv.financeOutcomeNotify.pendingAt,
        note: "Finance outcome marked pending"
      });
    }
  }

  return cases.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
}

function buildFindings(cases: OutcomeCase[]): OutcomeFinding[] {
  const findings: OutcomeFinding[] = [];
  const push = (
    row: OutcomeCase,
    issue: string,
    severity: FindingSeverity,
    title: string,
    detail: string,
    suggestedFix: OutcomeFinding["suggestedFix"],
    evidence: AnyObj = {}
  ) => {
    findings.push({
      id: `${issue}:${row.id}`,
      severity,
      family: row.family,
      issue,
      title,
      detail,
      caseId: row.id,
      leadRef: row.leadRef,
      customerName: row.customerName,
      evidence,
      suggestedFix
    });
  };

  for (const row of cases) {
    const outboundText = latestCustomerText(row) ?? "";
    if (expectsDealerRideThankYou(row) && !outboundText) {
      push(
        row,
        "missing_dealer_ride_customer_thank_you",
        "P1",
        "Dealer ride outcome did not create a customer thank-you draft",
        "Dealer ride outcomes that are not no-change should pass through the outcome draft publisher so staff can review a thank-you/check-in draft.",
        {
          type: "guard_eval",
          parserTarget: parserTargetFor(row.family),
          confidenceTarget: 0.82,
          action: "Add/keep a regression fixture for this status/note and verify Human/Suggest/Autopilot outcome behavior where applicable."
        },
        { outcome: row }
      );
    }

    if (outboundText && /\b(next steps we talked about|as discussed|like we talked|we discussed)\b/i.test(outboundText)) {
      if (!noteSupportsAssumedNextSteps(row.note)) {
        push(
          row,
          "assumed_agreed_next_steps",
          "P2",
          "Outcome draft assumed agreed next steps",
          "The generated text referenced an agreement or prior next steps that were not present in the outcome note.",
          {
            type: "guard_eval",
            parserTarget: parserTargetFor(row.family),
            confidenceTarget: 0.82,
            action: "Add a guard/eval that blocks agreement language unless the note explicitly supports it."
          },
          { note: row.note, customerFacingText: outboundText }
        );
      }
    }

    if (
      row.family === "dealer_ride" &&
      outboundText &&
      /\bi have (?:the|that)?\s*[a-z0-9][a-z0-9\s-]{0,80}\s+noted\b/i.test(outboundText)
    ) {
      push(
        row,
        "dealer_ride_vague_noted_language",
        "P3",
        "Outcome draft used vague noted-language",
        "Dealer ride outcome drafts should say the real status/action, not vague internal wording like having the bike noted.",
        {
          type: "guard_eval",
          parserTarget: parserTargetFor(row.family),
          confidenceTarget: 0.82,
          action: "Keep dealer-ride hold/follow-up copy status-specific and add examples when production feedback flags vague wording."
        },
        { customerFacingText: outboundText }
      );
    }

    const expectedOwnerFirst = firstName(row.ownerName);
    const actualIdentity = outboundText ? firstIdentityName(outboundText) : null;
    if (
      row.family === "dealer_ride" &&
      expectedOwnerFirst &&
      actualIdentity &&
      actualIdentity.toLowerCase() !== expectedOwnerFirst.toLowerCase()
    ) {
      push(
        row,
        "wrong_salesperson_identity",
        "P2",
        "Outcome draft used the wrong sender identity",
        "Dealer ride and appointment outcome drafts should use the assigned salesperson/owner when available.",
        {
          type: "guard_eval",
          parserTarget: parserTargetFor(row.family),
          confidenceTarget: 0.8,
          action: "Add a fixture that expects the lead owner name in outcome drafts."
        },
        { expectedOwnerFirst, actualIdentity, customerFacingText: outboundText }
      );
    }

    if (row.family === "appointment") {
      const needsFollowUp =
        row.status === "follow_up" ||
        row.secondaryStatus === "needs_follow_up" ||
        row.primaryStatus === "did_not_show" ||
        row.primaryStatus === "cancelled";
      const hasActiveCadence = row.cadenceStatus === "active" && !!row.nextDueAt;
      const hasFollowUpTask = hasOpenTask(row, /\b(follow|call|appointment|reschedule|schedule)\b/i);
      if (needsFollowUp && !outboundText && !hasActiveCadence && !hasFollowUpTask) {
        push(
          row,
          "appointment_outcome_missing_follow_up_action",
          "P1",
          "Appointment outcome did not create a visible follow-up action",
          "Appointment outcomes marked follow-up/no-show/cancelled should create a safe draft, active cadence, or staff task.",
          {
            type: "few_shot_example",
            parserTarget: parserTargetFor(row.family),
            confidenceTarget: 0.82,
            action: "Add a parser/eval fixture for this note and verify the outcome stage selects the right cadence or review draft."
          },
          { outcome: row }
        );
      }
    }

    if (row.family === "finance") {
      const status = String(row.status ?? "").toLowerCase();
      // BOTH finance routing checks below read `conv.followUp`, which is one mutable slot that
      // every later outcome rewrites. Once a NEWER outcome has landed, that slot describes the
      // newer event and the question "did THIS outcome route correctly?" is unanswerable from
      // the record — so firing a P1 on it reports a defect that the evidence cannot support.
      //
      // THE PHANTOM. John Zimmerman (+17169902571) recorded `financeOutcome.needs_more_info` at
      // 2026-08-12T13:59:38Z. He then CAME IN that afternoon, and at 21:07:24Z a rep recorded the
      // appointment outcome — "approved. went over numbers on new and pre-owned road glides...
      // Need to stay in touch" — which set `followUp.reason = appointment_outcome_follow_up` and
      // armed the right cadence. Nothing went wrong; the finance state was superseded by a real
      // customer visit seven hours later. It was the release gate's `outcome QA P1 1 > 0` failure
      // for 2026-08-13.
      //
      // This is NARROWER than it looks, and deliberately does not weaken the Kody Erhard fix
      // (phoneLogLead.ts): there a GENERIC phone-log re-notification clobbered a specific
      // `credit_app_needs_info` handoff, and a re-notification is not an outcome record — so it
      // never sets `supersededByOutcomeAt` and that finding still fires exactly as before. Only a
      // genuinely newer OUTCOME silences these two.
      const supersededRouting = !!row.supersededByOutcomeAt;
      if (
        status === "declined" &&
        !supersededRouting &&
        !(row.followUpReason === "financing_declined" && row.cadenceStatus === "active")
      ) {
        push(
          row,
          "finance_declined_missing_long_term_cadence",
          "P1",
          "Finance declined outcome did not start the long-term finance cadence",
          "Declined finance outcomes should keep follow-up safe, deterministic, and long-term.",
          {
            type: "guard_eval",
            parserTarget: parserTargetFor(row.family),
            confidenceTarget: 0.85,
            action: "Add an outcome-state invariant fixture for declined finance outcomes."
          },
          { followUpReason: row.followUpReason, cadenceStatus: row.cadenceStatus }
        );
      }
      // WHAT THIS CHECK ACTUALLY ASKS is in its own title: is the thread HELD for staff, so no
      // automation keeps talking finance at the customer? `credit_app_needs_info` is one way to
      // be in that state, not the definition of it. A thread parked in `manual_handoff` with its
      // cadence NOT running is held by construction — drafts are quiet and the owner owns it —
      // whatever reason string put it there.
      //
      // THE PHANTOM this fixes. Brent Marshall (+17169941544) recorded
      // `financeOutcome.needs_more_info` at 2026-08-13T17:27:43Z (a manual outbound about DMV
      // title paperwork). Twenty minutes later, at 17:47:32Z, the deal-progress route moved the
      // whole thread into `in_process_deal` — `setFollowUpMode(conv, "manual_handoff",
      // "in_process_deal")` plus `stopFollowUpCadence` (index.ts) — because he had bought the
      // bike and the thread was delivery logistics. The single `conv.followUp` slot then read
      // `in_process_deal`, the reason regex missed, and a P1 fired on a thread that is quieter
      // and safer than the state the check was asking for. It was the release gate's
      // `outcome QA P1 1 > 0` failure for 2026-08-13, and the readiness bar's operability P1.
      //
      // Deliberately NOT a blanket widening: an ACTIVE cadence still has to name a credit reason,
      // so the failure this check exists for — automation left running on a needs-more-info
      // finance thread, free to guess terms — fires exactly as it did before. The sibling
      // `declined` check above is untouched: there the desired end state is an ACTIVE long-term
      // cadence, so a manual handoff is a genuine miss of its invariant, not a stricter hold.
      const heldForStaffReview =
        row.followUpMode === "manual_handoff" && String(row.cadenceStatus ?? "").toLowerCase() !== "active";
      if (
        status === "needs_more_info" &&
        !supersededRouting &&
        !heldForStaffReview &&
        !/credit_app_needs_info/.test(String(row.followUpReason ?? ""))
      ) {
        push(
          row,
          "finance_needs_info_missing_manual_handoff",
          "P1",
          "Finance needs-more-info outcome did not hold for staff follow-up",
          "Needs-more-info finance outcomes should not guess terms; they should route to staff/business manager handoff.",
          {
            type: "guard_eval",
            parserTarget: parserTargetFor(row.family),
            confidenceTarget: 0.85,
            action: "Add an outcome-state invariant fixture for finance needs-more-info outcomes."
          },
          { followUpReason: row.followUpReason, followUpMode: row.followUpMode }
        );
      }
      if (
        outboundText &&
        /\b(?:\d+(?:\.\d+)?\s*%|apr|monthly payment|payment would be|\$[\d,]+|approved for|bank approved|lender approved)\b/i.test(
          outboundText
        ) &&
        !/\b(?:\d+(?:\.\d+)?\s*%|apr|\$[\d,]+|approved for|bank approved|lender approved|monthly payment|payment)\b/i.test(
          row.note
        )
      ) {
        push(
          row,
          "finance_outcome_unsafe_specific_claim",
          "P1",
          "Finance outcome draft made a specific claim not present in the note",
          "Finance drafts must not invent rates, payments, approval terms, lender decisions, or dollar amounts.",
          {
            type: "guard_eval",
            parserTarget: parserTargetFor(row.family),
            confidenceTarget: 0.9,
            action: "Add a finance safety fixture and keep deterministic finance invariant checks in the publisher."
          },
          { note: row.note, customerFacingText: outboundText }
        );
      }
    }
  }

  return findings;
}

function buildParserSeeds(cases: OutcomeCase[], findings: OutcomeFinding[]): ParserSeedCandidate[] {
  const seeds: ParserSeedCandidate[] = [];
  for (const row of cases) {
    if (!row.note || row.note.length < 8) continue;
    const relatedFindings = findings.filter(f => f.caseId === row.id);
    const recommendation = recommendationType(row, relatedFindings);
    if (recommendation === "no_change") continue;
    const parserTarget = parserTargetFor(row.family);
    const confidenceTarget = row.family === "finance" ? 0.85 : 0.82;
    const text = latestCustomerText(row);
    seeds.push({
      id: `seed:${row.id}`,
      family: row.family,
      recommendation,
      parserTarget,
      confidenceTarget,
      customerName: row.customerName,
      leadRef: row.leadRef,
      note: row.note,
      observed: {
        status: row.status,
        primaryStatus: row.primaryStatus,
        secondaryStatus: row.secondaryStatus,
        followUpMode: row.followUpMode,
        cadenceStatus: row.cadenceStatus,
        customerFacingText: text
      },
      proposedExpected: proposedExpectedFor(row),
      reason:
        recommendation === "guard_eval"
          ? "Observed outcome exposed a draft/state safety issue; add a regression guard."
          : recommendation === "schema_review"
            ? "Outcome note may need a richer parser field before few-shot examples are enough."
            : "Outcome note maps to existing labels; add as a few-shot/eval example if this pattern repeats.",
      cueTags: row.cueTags
    });
  }
  return seeds;
}

function countBy<T extends string>(rows: T[]): Array<{ value: T; count: number }> {
  const map = new Map<T, number>();
  for (const row of rows) map.set(row, (map.get(row) ?? 0) + 1);
  return [...map.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
}

function markdownReport(report: OutcomeQaReport): string {
  const lines: string[] = [];
  lines.push("# Outcome QA Report", "");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Source: \`${report.source.conversationsPath}\``);
  lines.push(`Window: ${report.source.sinceHours ? `last ${report.source.sinceHours}h` : "all time"}`);
  lines.push("");
  lines.push("## Summary", "");
  lines.push(`- Outcomes inspected: ${report.summary.outcomeCount}`);
  lines.push(`- Findings: ${report.summary.findingCount}`);
  lines.push(`- Parser seed candidates: ${report.summary.parserSeedCandidateCount}`);
  lines.push(
    `- Families: ${
      report.summary.byFamily.length
        ? report.summary.byFamily.map(row => `${row.family}=${row.count}`).join(", ")
        : "none"
    }`
  );
  lines.push("");
  lines.push("## Findings", "");
  if (!report.findings.length) {
    lines.push("No outcome QA findings in this window.");
  } else {
    for (const finding of report.findings.slice(0, 25)) {
      lines.push(`- ${finding.severity} ${finding.issue} (${finding.customerName ?? finding.leadRef ?? finding.caseId})`);
      lines.push(`  - ${finding.detail}`);
      lines.push(`  - Suggested: ${finding.suggestedFix.action}`);
    }
  }
  lines.push("", "## Parser Seed Candidates", "");
  if (!report.parserSeedCandidates.length) {
    lines.push("No parser/few-shot candidates in this window.");
  } else {
    for (const seed of report.parserSeedCandidates.slice(0, 25)) {
      lines.push(`- ${seed.recommendation} -> ${seed.parserTarget} (${seed.customerName ?? seed.leadRef ?? seed.id})`);
      lines.push(`  - Note: ${seed.note.slice(0, 220)}`);
      lines.push(`  - Expected: ${JSON.stringify(seed.proposedExpected)}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function buildOutcomeQaReport(store: LoadedStore, args: { conversationsPath: string; sinceHours: number }): OutcomeQaReport {
  const cases = collectCases(store, args.sinceHours);
  const findings = buildFindings(cases);
  const parserSeedCandidates = buildParserSeeds(cases, findings);
  const generatedAt = new Date().toISOString();
  const windowStart =
    args.sinceHours > 0 ? new Date(Date.now() - args.sinceHours * 60 * 60 * 1000).toISOString() : null;
  const familyCounts = countBy(cases.map(row => row.family)).map(row => ({
    family: row.value,
    count: row.count
  }));
  const findingCounts = countBy(findings.map(row => row.issue)).map(row => ({
    issue: row.value,
    count: row.count
  }));
  const recommendationCounts = countBy(parserSeedCandidates.map(row => row.recommendation)).map(row => ({
    type: row.value,
    count: row.count
  }));

  return {
    ok: true,
    generatedAt,
    source: {
      conversationsPath: args.conversationsPath,
      sinceHours: args.sinceHours || null,
      windowStart
    },
    summary: {
      outcomeCount: cases.length,
      findingCount: findings.length,
      parserSeedCandidateCount: parserSeedCandidates.length,
      byFamily: familyCounts,
      findingsByIssue: findingCounts,
      parserRecommendationsByType: recommendationCounts
    },
    cases,
    findings,
    parserSeedCandidates
  };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(parsed.conversationsPath)) {
    console.error(`conversations store not found: ${parsed.conversationsPath}`);
    process.exit(1);
  }
  const store = loadStore(parsed.conversationsPath);
  const report = buildOutcomeQaReport(store, {
    conversationsPath: parsed.conversationsPath,
    sinceHours: parsed.sinceHours
  });
  fs.mkdirSync(parsed.outDir, { recursive: true });
  const jsonPath = path.join(parsed.outDir, "outcome_qa_report.json");
  const mdPath = path.join(parsed.outDir, "outcome_qa_report.md");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, markdownReport(report));
  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir: parsed.outDir,
        outputs: { jsonPath, mdPath },
        summary: report.summary
      },
      null,
      2
    )
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
