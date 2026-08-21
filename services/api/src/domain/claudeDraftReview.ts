/**
 * THE INSTANT SECOND OPINION (Joe's ruling, 2026-08-14 late evening — "what if I don't want it to
 * take a half hour to fix a draft?").
 *
 * Every minute, each NEW pending draft gets read by CLAUDE — a different model family than the
 * OpenAI-based pipeline that wrote it (Joe's explicit requirement: "not our LLM in the system";
 * the same-model echo chamber is what he is buying out of). If the draft is CLEARLY wrong for the
 * conversation — ignores what the customer actually asked, contradicts settled thread facts,
 * fabricates, addresses the wrong thing — Claude rewrites it and the fix SUPERSEDES the bad draft
 * in the approval box via saveOperatorDraft (attributed, staff still approve, NOTHING ever sends
 * itself). Latency: ≤~60s on the minute lane, in-product, independent of any Claude Code session.
 *
 * THE BAR IS HIGH ON PURPOSE. The measured cost of an over-eager machine editor is real
 * (2026-08-07: an automated fixer deleted concrete appointment times from 41 drafts) — so the
 * system prompt hard-forbids dropping concrete facts, and "could be warmer" is not a rewrite.
 * Every uncertainty fails toward keeping the pipeline's draft (verdict "ok").
 *
 * Layered with its siblings: the per-message tripwire (also 2026-08-14) catches turns with NO
 * response at all; this reviews the responses that exist; the 30-minute Claude Code sanity watch
 * is the backstop behind both (it skips drafts this pass already stamped — the receipt is
 * `conv.claudeDraftReview`).
 */
import { createHash } from "node:crypto";

import { enforceNoReintroduction, GENERIC_DEALER_DISPLAY_NAME } from "./agentVoice.js";
import { anthropicMessagesRequest, extractAnthropicToolInput } from "./anthropicRequest.js";
import { getCachedDealerProfile } from "./dealerProfile.js";
import { addOpsAnomaly } from "./opsAnomalyStore.js";
import { loadReviewRelevantCharterRules } from "./policyCharterFeed.js";
import {
  getAllConversations,
  getLatestPendingDraft,
  resolveEmailDraftForDisplay,
  saveOperatorDraft,
  saveConversation,
  flushConversationStore,
  type Conversation,
  type Message
} from "./conversationStore.js";

export const CLAUDE_DRAFT_REVIEW_MAX_PER_TICK_DEFAULT = 3;
export const CLAUDE_DRAFT_REVIEW_MAX_AGE_MS_DEFAULT = 24 * 60 * 60 * 1000;

/**
 * THE BREAKER — stop paying to ask a service that is answering "no" every time.
 *
 * MEASURED 2026-08-20. The Anthropic account ran dry at ~11:34Z. This lane runs EVERY MINUTE and
 * retried regardless, with no backoff, no cap and no give-up: by 19:09Z that was **446 SMS attempts
 * across 15 drafts (135 on one draft alone) plus 141 email attempts across 3** — 587 calls in a day
 * that could not possibly succeed. Two costs, and the second is the dangerous one:
 *
 *  - the route audit reads as ~587 distinct problems when it is ONE problem (a dead vendor account);
 *  - **every queued retry converts to a real, paid API call the instant the balance is topped up.**
 *    The bill for an outage is charged after it ends. That is what this exists to stop.
 *
 * A closed-loop breaker rather than a per-draft counter, because the failure is not per draft — the
 * SERVICE is down, and a per-draft cap still pays once per draft per minute forever. Consecutive
 * TRANSPORT failures only (no key, HTTP failure, unparseable reply); a real verdict of any kind
 * resets it, because a verdict proves the service is alive.
 *
 * WHAT IT DELIBERATELY DOES NOT CHANGE: the draft still goes UNREVIEWED and still records
 * `*_unavailable`, so it stays UNSTAMPED and the 4-hourly human backstop still looks at it. That
 * property (PR #711) is the whole fail-direction of this lane and the breaker must not touch it —
 * we are cutting the wasted CALL, never the visibility. A lane that went quiet here would be the
 * "instrument reports fine while measuring nothing" failure this file's siblings keep repeating.
 *
 * In-process state, and that is correct here rather than a bug: the API deploys 8-17x a day, so a
 * restart costs at most one extra probe per deploy — which is exactly when you WOULD want to
 * re-probe. Compare the email lane's 150/day cap, where in-process state is a real defect because a
 * deploy RAISES the ceiling; here a reset only ever re-tests a service we want re-tested.
 */
export const CLAUDE_REVIEW_BREAKER_TRIP_AFTER_DEFAULT = 5;
export const CLAUDE_REVIEW_BREAKER_COOLDOWN_MS_DEFAULT = 15 * 60 * 1000;

type ClaudeReviewBreakerState = { consecutiveFailures: number; openedAtMs: number | null };
const breaker: ClaudeReviewBreakerState = { consecutiveFailures: 0, openedAtMs: null };

function breakerTripAfter(): number {
  const raw = Number(String(process.env.CLAUDE_DRAFT_REVIEW_BREAKER_TRIP_AFTER ?? "").trim());
  return Number.isFinite(raw) && raw > 0 ? raw : CLAUDE_REVIEW_BREAKER_TRIP_AFTER_DEFAULT;
}

function breakerCooldownMs(): number {
  const raw = Number(String(process.env.CLAUDE_DRAFT_REVIEW_BREAKER_COOLDOWN_MS ?? "").trim());
  return Number.isFinite(raw) && raw > 0 ? raw : CLAUDE_REVIEW_BREAKER_COOLDOWN_MS_DEFAULT;
}

/** Test seam — the breaker is process state, so a test that cannot clear it cannot test it. */
export function resetClaudeReviewBreaker(): void {
  breaker.consecutiveFailures = 0;
  breaker.openedAtMs = null;
}

export function claudeReviewBreakerSnapshot(): Readonly<ClaudeReviewBreakerState> {
  return { ...breaker };
}

/**
 * Is the breaker holding calls right now? Open ⇒ skip the call and report unavailable WITHOUT
 * paying. The cooldown lets exactly one probe through, and that probe's own result re-opens or
 * closes it — so a recovered service is picked up within one cooldown with a single call.
 */
export function claudeReviewBreakerIsOpen(nowMs: number): boolean {
  if (breaker.openedAtMs === null) return false;
  if (nowMs - breaker.openedAtMs >= breakerCooldownMs()) {
    // Cooldown elapsed: let ONE call through (half-open). It closes the breaker on a verdict, or
    // re-opens it on another failure via recordClaudeReviewTransportFailure.
    breaker.openedAtMs = null;
    breaker.consecutiveFailures = breakerTripAfter() - 1;
    return false;
  }
  return true;
}

export function recordClaudeReviewTransportFailure(nowMs: number): void {
  breaker.consecutiveFailures += 1;
  if (breaker.openedAtMs === null && breaker.consecutiveFailures >= breakerTripAfter()) {
    breaker.openedAtMs = nowMs;
    console.warn(
      `[claude-draft-review] breaker OPEN after ${breaker.consecutiveFailures} consecutive transport failures — ` +
        `holding calls for ${Math.round(breakerCooldownMs() / 60000)}m. Drafts stay UNSTAMPED, so the human backstop still reads them.`
    );
  }
}

/** A real verdict proves the service is alive — clear everything. */
export function recordClaudeReviewSuccess(): void {
  if (breaker.openedAtMs !== null || breaker.consecutiveFailures > 0) {
    console.warn("[claude-draft-review] breaker CLOSED — a verdict came back, the lane is live again.");
  }
  resetClaudeReviewBreaker();
}

export function claudeDraftReviewEnabled(): boolean {
  return (
    String(process.env.CLAUDE_DRAFT_REVIEW_ENABLED ?? "1") !== "0" &&
    !!String(process.env.ANTHROPIC_API_KEY ?? "").trim()
  );
}

/** The receipt stamped on the conversation so a draft is never reviewed twice. */
export type ClaudeDraftReviewReceipt = { messageId: string; verdict: "ok" | "rewrite"; at: string };

/**
 * Actors that are US, not a person. A draft carrying one of these names was machine-written, so
 * reviewing it takes nothing away from anybody.
 *
 * `CLAUDE_REVIEW_ACTOR` is in this set because it IS machine-written — saying otherwise would be a
 * lie that happens to stop the self-review loop. The loop is stopped by its own explicit guard in
 * the selector instead. Keeping those two separate matters: while this set implicitly called our own
 * rewrite "a person", the explicit guard was dead code — removing it changed nothing and no eval
 * failed (caught by sabotage) — so a later correction of the semantics would have silently re-opened
 * a rewrite-its-own-rewrite loop at one API call a minute.
 */
export const CLAUDE_REVIEW_ACTOR = "Claude review";
export const MACHINE_DRAFT_ACTORS = new Set(["Auto-redraft (thumbs-down)", CLAUDE_REVIEW_ACTOR]);

/**
 * Did a PERSON write this draft? The gate that matters is authorship, not thread ownership.
 *
 * MEASURED 2026-08-16 on the americanharley store, and the numbers are why this predicate exists:
 * of 46 draft rows on human-mode threads since 8/1, **40 carried no actor at all (machine-written)
 * and 3 more were "Auto-redraft (thumbs-down)" — but 3 were typed by Joe Hartrich.** All 46 share
 * `provider: "draft_ai"`, so keying on the provider (the obvious fix) would have handed a human's
 * own words to an automatic rewriter. Key on the ACTOR instead.
 *
 * FAIL DIRECTION: an unrecognised actor name reads as a PERSON, so we leave it alone. A missed
 * review costs what today costs; rewriting words a human typed is the thing this must never do.
 */
export function draftIsMachineAuthored(draft: { actorUserName?: string | null } | null | undefined): boolean {
  const actor = String(draft?.actorUserName ?? "").trim();
  return !actor || MACHINE_DRAFT_ACTORS.has(actor);
}

/**
 * Which conversations carry a draft this pass should review RIGHT NOW? Pure and executable: SMS
 * threads whose CURRENT pending draft (the only row that is really pending —
 * `getLatestPendingDraft` semantics, never the ~99 position-hidden ghost rows) is unstamped,
 * younger than the age ceiling, and MACHINE-WRITTEN.
 *
 * This used to skip every `mode: "human"` thread, on the reasoning that "the human owns the words".
 * That reasoning is right about a draft a human TYPED and wrong about the rows actually there:
 * `conv.mode` says who owns the THREAD, not who wrote the DRAFT. MEASURED 2026-08-16: since 8/1,
 * **52 machine-written drafts landed on human-mode threads against 55 everywhere else — about half
 * of all machine-drafted volume — and human-mode threads carried 0 reviewer receipts against 9.**
 * Three consecutive backstop ticks caught real defects there that went note-only, including a draft
 * telling Igor `+17164442120` "I saw you want to do the Jumpstart experience" on a thread where he
 * has never sent a single message. Those drafts sit in the staff approval box read by nobody, while
 * the identical draft on a suggest thread is read within ~60s.
 *
 * The skip now keys on authorship, so a human's typed draft stays untouched on ANY thread — which is
 * the protection the old rule was reaching for, applied to the right thing.
 *
 * THE SAME CATEGORY ERROR, ONE FIELD OVER (2026-08-17). This also used to skip every
 * `status: "closed"` conversation. But `conv.status` names the LEAD's lifecycle, not the
 * conversation's activity: the dominant `closedReason` is **"sold"**, and a sold customer keeps
 * texting — about delivery, parts, service. MEASURED on the americanharley store, 8/17 14:35Z:
 * **31 of the 43 pending drafts sat on closed threads, and the reviewer opened none of them**, while
 * only 12 sat on open threads (of which it owed exactly 1). A third of the pending pile had no
 * reviewer at all.
 *
 * The live example that produced this change: Brent `+17169941544` bought his Road Glide on 8/15
 * (the thread is closed, `closedReason: "sold"`, VIN on file) and texted on 8/17 to thank the store
 * and to ask us to call him when his seat, tour pack and CarPlay module land. The pending draft
 * answered neither ask and told a customer who had taken delivery two days earlier that we would
 * "keep an eye on the 2026 Road Glide you've got on order and let you know as soon as it's here" —
 * and because the thread was closed, nothing reviewed it. A closed thread does NOT hide the draft
 * from staff: the console pre-loads the pending draft straight into the send box, so it sits one tap
 * from Send.
 *
 * Reviewing these is safe by construction: this pass can only ever REPLACE a pending draft that
 * already exists (`saveOperatorDraft` supersedes it) — it never creates an outbound where there was
 * none, and it never sends. So on a closed thread it can only improve what staff would otherwise
 * send. Spend stays bounded by the guards that actually bound it: pending + unstamped + <24h +
 * machine-written, capped per tick. At the measured volume that is ~1 extra review, not 31 (only 1
 * of the 31 was inside the freshness ceiling).
 */
export function selectDraftsForClaudeReview(args: {
  conversations: Conversation[];
  nowMs: number;
  maxPerTick?: number;
  maxAgeMs?: number;
}): Array<{ conv: Conversation; draft: Message }> {
  const maxPerTick = args.maxPerTick ?? CLAUDE_DRAFT_REVIEW_MAX_PER_TICK_DEFAULT;
  const maxAgeMs = args.maxAgeMs ?? CLAUDE_DRAFT_REVIEW_MAX_AGE_MS_DEFAULT;
  const out: Array<{ conv: Conversation; draft: Message }> = [];
  for (const conv of args.conversations) {
    if (out.length >= maxPerTick) break;
    // NOTE: deliberately NOT skipping `status: "closed"` — see the header. A sold thread is closed
    // and still live, and its pending draft is one tap from Send in the console.
    const draft = getLatestPendingDraft(conv);
    if (!draft) continue;
    const draftId = String(draft.id ?? "").trim();
    if (!draftId) continue;
    const receipt = (conv as any).claudeDraftReview as ClaudeDraftReviewReceipt | undefined;
    if (receipt?.messageId === draftId) continue;
    const atMs = Date.parse(String(draft.at ?? ""));
    if (!Number.isFinite(atMs)) continue; // undatable ⇒ leave it alone
    const age = args.nowMs - atMs;
    if (age < 0 || age > maxAgeMs) continue;
    if (!String(draft.body ?? "").trim()) continue;
    // Never review our own superseding rewrite — a rewrite is a new unstamped pending draft, and
    // without this the next tick examines it (in theory forever, one call per minute).
    // (actorUserName is stamped by saveOperatorDraft.)
    if (String((draft as any).actorUserName ?? "") === CLAUDE_REVIEW_ACTOR) continue;
    // A draft a PERSON typed is theirs, on any thread. This replaced the old `conv.mode === "human"`
    // skip, which read thread ownership as draft authorship and left ~half of all machine-written
    // drafts reviewed by nobody. See draftIsMachineAuthored for the measurement.
    if (!draftIsMachineAuthored(draft as any)) continue;
    out.push({ conv, draft });
  }
  return out;
}

// --- THE EMAIL LANE (2026-08-17) ---------------------------------------------------------------
// Joe, 8/17: "a lot of drafts are coming through bad right now." The API was fine; the reviewer
// simply could not see half the drafts. `conv.emailDraft` is a LIVE, SENDABLE draft the console's
// Email tab renders and staff send verbatim — and NOTHING has ever reviewed one. Measured on the
// americanharley store 8/17: 227 conversations carry an email draft, 95 of them still offered as
// sendable by `resolveEmailDraftForDisplay`.
//
// Three things make this lane genuinely different from SMS, and each one shapes the code below:
//
//  1. NO TIMESTAMP. `emailDraft` is a bare string on the conversation — it has no `at`, which is
//     why `routeWatchdogClassification` and `scoringExclusions` both had to special-case it. So the
//     24h age ceiling is impossible here; freshness is proxied by the THREAD's newest message.
//     `conv.updatedAt` is NOT usable: it churns every ~60s from the long-term-cadence realign heal.
//  2. NO MESSAGE ID. The receipt cannot key on one, so it keys on a hash of the body — and the
//     stamp records the hash of whatever is STORED after the pass, which is what stops the reviewer
//     re-reviewing (and re-rewriting) its own output once a minute, forever.
//  3. NO ACTOR — until now. `emailDraftActor` (added with this change) is the email lane's
//     `Message.actorUserName`, so a human's typed email is as untouchable here as on SMS.
export const CLAUDE_EMAIL_DRAFT_REVIEW_MAX_PER_TICK_DEFAULT = 2;
export const CLAUDE_EMAIL_DRAFT_REVIEW_MAX_THREAD_AGE_MS_DEFAULT = 36 * 60 * 60 * 1000;

/** The email lane's receipt. Keyed on the body hash because `emailDraft` has no message id. */
export type ClaudeEmailDraftReviewReceipt = { hash: string; verdict: "ok" | "rewrite"; at: string };

/**
 * Identity of an email draft. sha1/12 deliberately matches the 30-minute backstop scanner's key —
 * the two must agree on what "the same draft" means, or every already-reviewed draft re-surfaces as
 * new the day one of them changes algorithm.
 */
export function emailDraftReviewHash(draft: string): string {
  return createHash("sha1").update(String(draft ?? "").trim(), "utf8").digest("hex").slice(0, 12);
}

/** Newest message time on the thread — the only freshness signal an untimestamped draft has. */
function newestMessageMs(conv: Conversation): number {
  let newest = 0;
  for (const m of Array.isArray(conv?.messages) ? conv.messages : []) {
    const t = Date.parse(String(m?.at ?? ""));
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  return newest;
}

/**
 * Which email drafts should be reviewed RIGHT NOW? Pure and executable, mirroring the SMS selector.
 *
 * The suppression referee runs FIRST and does double duty: `resolveEmailDraftForDisplay` already
 * withholds drafts on closed/sold threads and drafts whose finance callback a decision has replaced.
 * A draft staff are not being offered needs no reviewer — and reviewing one would spend a call to
 * "fix" text the referee has already taken off the table.
 */
export function selectEmailDraftsForClaudeReview(args: {
  conversations: Conversation[];
  nowMs: number;
  maxPerTick?: number;
  maxThreadAgeMs?: number;
}): Array<{ conv: Conversation; draft: string; hash: string }> {
  const maxPerTick = args.maxPerTick ?? CLAUDE_EMAIL_DRAFT_REVIEW_MAX_PER_TICK_DEFAULT;
  const maxThreadAgeMs = args.maxThreadAgeMs ?? CLAUDE_EMAIL_DRAFT_REVIEW_MAX_THREAD_AGE_MS_DEFAULT;
  const out: Array<{ conv: Conversation; draft: string; hash: string }> = [];
  for (const conv of args.conversations) {
    if (out.length >= maxPerTick) break;
    // The display referee owns "is this still honest enough to offer?" — never read emailDraft raw.
    const draft = String(resolveEmailDraftForDisplay(conv)?.emailDraft ?? "").trim();
    if (!draft) continue;
    const actor = (conv as any).emailDraftActor as string | null | undefined;
    // Never re-review our own rewrite. Explicit, exactly like the SMS guard — NOT by mislabelling
    // our own output "human", which would be a lie that happens to stop a loop.
    if (String(actor ?? "").trim() === CLAUDE_REVIEW_ACTOR) continue;
    // A draft a PERSON typed is theirs. Fail direction: an unrecognised actor reads as a person.
    if (!draftIsMachineAuthored({ actorUserName: actor })) continue;
    const newest = newestMessageMs(conv);
    if (!newest) continue; // no datable activity ⇒ leave it alone
    const threadAge = args.nowMs - newest;
    if (threadAge < 0 || threadAge > maxThreadAgeMs) continue;
    const hash = emailDraftReviewHash(draft);
    const receipt = (conv as any).claudeEmailDraftReview as ClaudeEmailDraftReviewReceipt | undefined;
    if (receipt?.hash === hash) continue;
    out.push({ conv, draft, hash });
  }
  return out;
}

export const CLAUDE_DRAFT_REVIEW_TOOL_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "reason", "fixed_draft"],
  properties: {
    verdict: { type: "string", enum: ["ok", "rewrite"] },
    reason: { type: "string" },
    fixed_draft: { type: "string" }
  }
};

/**
 * The reviewer's instructions. Exported so the eval can pin the load-bearing rules by executing
 * this builder — the never-delete-a-concrete-fact rule is the one that must never regress.
 *
 * `charterRules` are Joe's written rulings (domain/policyCharterFeed). They are APPENDED to the
 * baked rules below, never a replacement: a charter that is missing, unreadable or empty must leave
 * the reviewer exactly as strict as it is today. See policyCharterFeed for the 2026-08-15
 * measurement behind the feed — the reviewer stamped `ok` on a draft breaking two of Joe's rulings
 * because it had never been told they existed.
 */
export function buildClaudeDraftReviewSystemPrompt(charterRules?: string | null): string {
  const charter = String(charterRules ?? "").trim();
  return [
    "You are an independent reviewer for a Harley-Davidson dealership's texting assistant. A draft",
    "reply to a customer is about to be shown to staff for approval. Decide if it is CLEARLY WRONG",
    "for this conversation.",
    "",
    "Verdict \"rewrite\" ONLY when the draft: ignores or contradicts what the customer actually asked",
    "(check EVERY question in their last message — answering one of two asks is a miss); contradicts",
    "facts already settled in the thread (a price already quoted, a day or time already agreed, a",
    "bike they already bought); fabricates information; or plainly does not make sense as a reply.",
    "Style, warmth, phrasing preferences: verdict \"ok\". When unsure: verdict \"ok\". A noisy rewriter",
    "is worse than a missed flaw.",
    "",
    "When you rewrite:",
    "- NEVER drop a concrete fact the draft carried: appointment days and times, quoted prices,",
    "  stock numbers, names. Dropping a real time slot is a regression, not a fix.",
    "- NEVER invent a price, rate, payment figure, or availability the thread or the draft did not",
    "  already contain — if the answer needs a number you cannot see, say a teammate will confirm it.",
    // The money rule above only ever covered NUMBERS. Maxie Johnson +17166036684, 2026-08-19 16:45:
    // this reviewer correctly rejected a co-signer draft for not answering "financing for bad credit
    // or credit building" — and then answered it itself, "we do work with lenders that specialize in
    // bad credit". Nothing supports that: dealer_profile.json has an HDFS credit-app URL,
    // riderToRiderFinancingEnabled:false, and NO lender-panel field, and the phrase had never been
    // said in 874 conversations. A capability is not a number, so no rule here forbade it — and this
    // function CANNOT see the dealer profile or the inventory feed, so it had no way to check either.
    "- The same bar covers WHAT THE DEALERSHIP DOES: never assert a program, partnership, lender,",
    "  service, policy, or approval the thread or the draft has not already stated. You cannot see the",
    "  dealer profile or the inventory feed, so if the thread and the draft are silent on it, you do",
    "  not know it, and a capability answered wrongly is a promise the customer discovers in person.",
    "- When the customer asked something the draft ignored and you do not have the answer, the rewrite",
    "  ACKNOWLEDGES the question and says the right person will confirm — it never answers on the",
    "  dealership's behalf. \"Do you finance bad credit?\" gets a hand-off to the finance manager, never",
    "  a yes.",
    "- Voice: a helpful salesperson texting a friend. Short. No corporate phrases, no AI-tells.",
    "- Answer the customer's question(s) FIRST, then end with exactly ONE question that moves",
    "  toward a visit or a decision.",
    "- If the original draft ends with an opt-out sentence (\"Reply STOP to opt out\"), keep it.",
    // Joe's own standing rulings, read from the charter at review time so a NEW ruling reaches the
    // reviewer with no code change. Empty string when the charter is unreadable => baked rules only.
    ...(charter
      ? [
          "",
          "DEALER POLICY — the dealership owner's own standing rulings, and the reason this reviewer",
          "exists. These are NOT style preferences: a draft that breaks one is CLEARLY WRONG and gets",
          "verdict \"rewrite\", and your rewrite must obey them too. Judge the draft against these even",
          "when it otherwise reads well.",
          charter
        ]
      : []),
    "",
    "Return via the tool: verdict, a one-sentence reason, and fixed_draft (empty string when verdict",
    "is \"ok\")."
  ].join("\n");
}

export type ClaudeDraftReviewVerdict = { verdict: "ok" | "rewrite"; reason: string; fixedDraft: string };

/** Ask Claude. Any failure — no key, timeout, malformed reply — reads as "ok" (keep the draft). */
export async function reviewDraftWithClaude(args: {
  draftBody: string;
  thread: Array<{ direction: string; body: string }>;
  leadLine: string;
  channel?: "sms" | "email";
  nowMs?: number;
}): Promise<ClaudeDraftReviewVerdict> {
  const keep: ClaudeDraftReviewVerdict = { verdict: "ok", reason: "review_unavailable", fixedDraft: "" };
  const apiKey = String(process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!apiKey) return keep;
  // The breaker answers BEFORE the request is built — the point is not to spend. It returns the
  // same `keep` every other failure returns, so the caller still records *_unavailable and still
  // leaves the draft unstamped for the human backstop.
  if (claudeReviewBreakerIsOpen(args.nowMs ?? Date.now())) return keep;
  try {
    const thread = args.thread
      .slice(-14)
      .map(m => `${m.direction === "in" ? "CUSTOMER" : "DEALERSHIP"}: ${String(m.body ?? "").slice(0, 500)}`)
      .join("\n");
    const result = await anthropicMessagesRequest({
      apiKey,
      model: String(process.env.CLAUDE_DRAFT_REVIEW_MODEL ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6").trim(),
      maxTokens: 700,
      // Joe's rulings, re-read from the charter (cached) — a charter he edits today changes the
      // next review with no deploy. Unreadable => null => baked rules only, i.e. today's behaviour.
      system: buildClaudeDraftReviewSystemPrompt(loadReviewRelevantCharterRules()),
      messages: [
        {
          role: "user",
          content: [
            `LEAD: ${args.leadLine}`,
            "",
            `CONVERSATION (oldest first):\n${thread}`,
            "",
            `PENDING DRAFT (about to be shown to staff):\n${args.draftBody}`,
            // The baked rules describe an SMS reply ("texting a friend", keep the STOP line). An
            // email draft is rendered in the console's Email tab and sent verbatim, so a rewrite
            // that returns a bare SMS line would strip the greeting and sign-off staff expect.
            ...(args.channel === "email"
              ? [
                  "",
                  "CHANNEL: EMAIL. This draft is sent as an email, not a text. If you rewrite it,",
                  "return a COMPLETE email in the same shape as the draft above — keep its greeting,",
                  "its sign-off and who it is from. Do not add an SMS opt-out line. It may run a",
                  "little longer than a text, but every other rule above still applies exactly."
                ]
              : [])
          ].join("\n")
        }
      ],
      toolName: "draft_review",
      toolDescription: "Report whether the pending draft is clearly wrong for this conversation, and the fixed draft when it is.",
      inputSchema: CLAUDE_DRAFT_REVIEW_TOOL_SCHEMA,
      temperature: 0,
      timeoutMs: 30_000
    });
    const parsed = result.ok ? extractAnthropicToolInput(result.data, "draft_review") : null;
    // A failed call or unparseable reply is NOT a verdict — it must never masquerade as "ok"
    // (the 2026-08-15 fire drill caught exactly this: an empty-credit API key stamped obvious
    // nonsense "reviewed-ok" and the dead net looked alive).
    if (!parsed) {
      recordClaudeReviewTransportFailure(args.nowMs ?? Date.now());
      return keep;
    }
    // Past here the service ANSWERED. Everything below is a verdict, including the two degenerate
    // ones — they are the reviewer disagreeing with itself, not the transport being down.
    recordClaudeReviewSuccess();
    const verdict = String(parsed?.verdict ?? "").trim();
    if (verdict !== "rewrite") return { verdict: "ok", reason: String(parsed?.reason ?? "ok"), fixedDraft: "" };
    const fixed = String(parsed?.fixed_draft ?? "").trim();
    if (!fixed) return { verdict: "ok", reason: "rewrite_without_text", fixedDraft: "" };
    return { verdict: "rewrite", reason: String(parsed?.reason ?? "").slice(0, 300), fixedDraft: fixed };
  } catch {
    recordClaudeReviewTransportFailure(args.nowMs ?? Date.now());
    return keep;
  }
}

/**
 * The minute-lane pass. Reviews up to N unstamped pending drafts; a "rewrite" verdict supersedes
 * the draft via saveOperatorDraft (attributed "Claude review" — staff see who wrote it and still
 * approve). Every outcome stamps the receipt so no draft is examined twice. Fail direction
 * everywhere: keep the pipeline's draft.
 */
export type ClaudeDraftReviewOutcome =
  | "claude_draft_review_ok"
  | "claude_draft_review_rewrite"
  | "claude_draft_review_unavailable"
  | "claude_email_draft_review_ok"
  | "claude_email_draft_review_rewrite"
  | "claude_email_draft_review_unavailable";

export async function processClaudeDraftReview(deps: {
  recordOutcome: (outcome: ClaudeDraftReviewOutcome, detail: Record<string, unknown>) => void;
  nowMs?: number;
}): Promise<{ reviewed: number; rewritten: number; emailReviewed: number; emailRewritten: number }> {
  if (!claudeDraftReviewEnabled()) return { reviewed: 0, rewritten: 0, emailReviewed: 0, emailRewritten: 0 };
  const nowMs = deps.nowMs ?? Date.now();
  // Charter C1.2a post-check (both lanes). A `rewrite` composes the whole reply as free text, so
  // there is no builder to gate — and the lane never re-reads its own output, by design. Read once:
  // the profile does not change inside a minute-lane pass.
  const dealerName = String(getCachedDealerProfile()?.dealerName ?? "").trim() || GENERIC_DEALER_DISPLAY_NAME;
  const picks = selectDraftsForClaudeReview({ conversations: getAllConversations(), nowMs });
  let rewritten = 0;
  for (const { conv, draft } of picks) {
    const lead = conv.lead ?? {};
    const leadLine = [
      String((lead as any).firstName ?? (lead as any).name ?? "").trim(),
      String((lead as any).source ?? "").trim(),
      String((lead as any).vehicle?.description ?? "").trim()
    ]
      .filter(Boolean)
      .join(" | ") || "unknown";
    const thread = (Array.isArray(conv.messages) ? conv.messages : [])
      .filter(m => (m.direction === "in" || m.direction === "out") && String(m.body ?? "").trim())
      .filter(m => m.id !== draft.id && String((m as any).draftStatus ?? "") !== "stale")
      .map(m => ({ direction: String(m.direction), body: String(m.body ?? "") }));
    const verdict = await reviewDraftWithClaude({ draftBody: String(draft.body ?? ""), thread, leadLine, nowMs });
    // Review UNAVAILABLE (API failure, no credits, malformed reply) ⇒ no stamp — the draft stays
    // eligible and is retried when the service recovers — and a DISTINCT outcome so a dead net is
    // loudly visible in the route audit instead of dressed up as a stream of "ok"s.
    if (verdict.reason === "review_unavailable") {
      deps.recordOutcome("claude_draft_review_unavailable", {
        convId: conv.id, leadKey: conv.leadKey ?? null, draftId: draft.id
      });
      continue;
    }
    if (verdict.verdict === "rewrite") {
      const fixedBody = enforceNoReintroduction({ body: verdict.fixedDraft, dealerName, messages: conv.messages });
      saveOperatorDraft(conv, {
        body: fixedBody,
        channel: "sms",
        actor: { userName: "Claude review" }
      });
      rewritten += 1;
      // Joe's ruling (2026-08-14): a fix-by-Claude means the PIPELINE has a gap — every rewrite
      // files a work order into the ops-anomaly store the 4h repair loop's detector chain sweeps,
      // so the instance heal always becomes a class investigation. Fire-and-forget: the heal must
      // never fail because the reporting write did.
      void addOpsAnomaly({
        type: "other",
        severity: "warning",
        title: "Claude draft review rewrote a pipeline draft",
        note: `The pipeline's draft was clearly wrong: ${verdict.reason}. The superseding draft is in the approval box (actor "Claude review"). Root-cause the pipeline arm that produced the original.`,
        reporter: { name: "claude-draft-review" },
        context: { convId: conv.id, leadKey: conv.leadKey ?? null }
      }).catch(() => {});
    }
    (conv as any).claudeDraftReview = {
      messageId: String(draft.id ?? ""),
      verdict: verdict.verdict,
      at: new Date(nowMs).toISOString()
    } satisfies ClaudeDraftReviewReceipt;
    deps.recordOutcome(
      verdict.verdict === "rewrite" ? "claude_draft_review_rewrite" : "claude_draft_review_ok",
      { convId: conv.id, leadKey: conv.leadKey ?? null, draftId: draft.id, reason: verdict.reason }
    );
    saveConversation(conv);
  }

  // --- The email lane, in the SAME task -------------------------------------------------------
  // Deliberately not a separate registered task: the SMS pass needs THREE registrations (tick task,
  // API minute lane, worker minute schedule) and the eval exists because "a task missing anywhere
  // silently never runs". Running both channels inside one task makes that impossible to half-wire.
  // Budgets are separate so neither channel can starve the other.
  const emailPicks = selectEmailDraftsForClaudeReview({ conversations: getAllConversations(), nowMs });
  let emailRewritten = 0;
  for (const { conv, draft, hash } of emailPicks) {
    const lead = conv.lead ?? {};
    const leadLine = [
      String((lead as any).firstName ?? (lead as any).name ?? "").trim(),
      String((lead as any).source ?? "").trim(),
      String((lead as any).vehicle?.description ?? "").trim()
    ]
      .filter(Boolean)
      .join(" | ") || "unknown";
    // No draft row to exclude here — the email draft lives on the conversation, not in the thread.
    const thread = (Array.isArray(conv.messages) ? conv.messages : [])
      .filter(m => (m.direction === "in" || m.direction === "out") && String(m.body ?? "").trim())
      .filter(m => String((m as any).draftStatus ?? "") !== "stale")
      .map(m => ({ direction: String(m.direction), body: String(m.body ?? "") }));
    const verdict = await reviewDraftWithClaude({ draftBody: draft, thread, leadLine, channel: "email", nowMs });
    if (verdict.reason === "review_unavailable") {
      deps.recordOutcome("claude_email_draft_review_unavailable", {
        convId: conv.id, leadKey: conv.leadKey ?? null, draftHash: hash
      });
      continue;
    }
    let storedHash = hash;
    if (verdict.verdict === "rewrite") {
      const fixedBody = enforceNoReintroduction({ body: verdict.fixedDraft, dealerName, messages: conv.messages });
      saveOperatorDraft(conv, {
        body: fixedBody,
        channel: "email",
        actor: { userName: CLAUDE_REVIEW_ACTOR },
        // Never let an email fix reach across and discard a pending SMS draft (see the option docs).
        keepPendingDraftsOnOtherChannel: true
      });
      // The receipt must record what is STORED NOW, not what we reviewed: `emailDraft` has no id, so
      // a stamp carrying the OLD hash would leave our own rewrite unstamped and the next tick would
      // review it, rewrite it, and do so again — one API call a minute, forever.
      storedHash = emailDraftReviewHash(fixedBody);
      emailRewritten += 1;
      void addOpsAnomaly({
        type: "other",
        severity: "warning",
        title: "Claude draft review rewrote a pipeline EMAIL draft",
        note: `The pipeline's email draft was clearly wrong: ${verdict.reason}. The superseding draft is in the console's Email tab (actor "Claude review"). Root-cause the email-lane arm that produced the original — it is a static template keyed to classification, not a reply to the thread.`,
        reporter: { name: "claude-draft-review" },
        context: { convId: conv.id, leadKey: conv.leadKey ?? null }
      }).catch(() => {});
    }
    (conv as any).claudeEmailDraftReview = {
      hash: storedHash,
      verdict: verdict.verdict,
      at: new Date(nowMs).toISOString()
    } satisfies ClaudeEmailDraftReviewReceipt;
    deps.recordOutcome(
      verdict.verdict === "rewrite" ? "claude_email_draft_review_rewrite" : "claude_email_draft_review_ok",
      { convId: conv.id, leadKey: conv.leadKey ?? null, draftHash: storedHash, reason: verdict.reason }
    );
    saveConversation(conv);
  }

  if (picks.length || emailPicks.length) await flushConversationStore();
  return { reviewed: picks.length, rewritten, emailReviewed: emailPicks.length, emailRewritten };
}
