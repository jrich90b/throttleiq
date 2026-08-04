/**
 * finance_outcome_notify:eval — the business-manager finance-outcome record.
 *
 * `conv.financeOutcomeNotify` is how we chase a finance outcome out of the business manager: mint a
 * reply token, text "what happened with the financing?", stamp what comes back. SEVEN places used
 * to hand-write that record — the token mint, the parsed-outcome write, the prompt sender, the
 * notification sender, the public outcome link (pending + resolved) and the staff-SMS reply lane
 * (pending + resolved). They now all ask `decideFinanceOutcomeNotifyState` and write through
 * `applyFinanceOutcomeNotifyState`.
 *
 * The un-stacking is BEHAVIOR-PRESERVING and the load-bearing table below is what proves it: the
 * eight ORIGINAL inline field-sets are re-encoded here and the referee must reproduce every one.
 * `decision_equivalence` cannot carry that proof — a brand-new referee has no baseline.
 *
 * THREE DIVERGENCES preserved on purpose and pinned here so a future tidy-up cannot erase them:
 *   D1 — THE TWO "PENDING" LANES DISAGREE. The public link writes `status:"pending"` + `pendingAt`;
 *        a manager who TEXTS "pending" gets `outcomePendingAt` and no `status` at all.
 *        `scripts/outcome_qa_audit.ts` only reports a pending outcome when it sees status+pendingAt,
 *        so the texted answer never reaches the report. Measured 2026-08-04 on the live store: 807
 *        conversations, 67 carry this record, ZERO carry either pending shape — portability, not live.
 *   D2 — THE TWO "RESOLVED" LANES stamp different clocks for the same event
 *        (`outcomePromptRespondedAt` vs `outcomePromptResolvedAt`). Neither has a consumer today,
 *        but both HAVE fired in production (4 responded / 1 resolved).
 *   D3 — `notify_sent` is the only lane that does NOT bump `updatedAt`. That field is the
 *        second-choice freshness input to the staff-SMS token matcher, so stamping it would widen
 *        the window in which an old token still matches a staff reply — the fail-toward-acting
 *        direction. Preserved.
 *
 * NOT divergences, pinned as such so the fix PR does not "repair" them: `token_mint` never replaces
 * an existing token (an inbound staff SMS is matched against it — re-minting would strand a manager
 * mid-reply), and `prompt_sent` keeps an existing `userId` when the caller has none.
 */
import assert from "node:assert/strict";

const { decideFinanceOutcomeNotifyState } = await import(
  "../services/api/src/domain/routeStateReducer.ts"
);
const { applyFinanceOutcomeNotifyState } = await import(
  "../services/api/src/domain/conversationStore.ts"
);
const { rankContention } = await import("../services/api/src/domain/stateWriterContention.ts");

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks += 1;
};

const NOW = "2026-08-04T17:00:00.000Z";

type Lane =
  | "token_mint"
  | "outcome_signal"
  | "prompt_sent"
  | "notify_sent"
  | "public_link_pending"
  | "public_link_resolved"
  | "staff_sms_pending"
  | "staff_sms_resolved";

// ---------------------------------------------------------------------------
// LOAD-BEARING: the eight ORIGINAL inline field-sets, re-encoded as a table.
//
// Each row is the exact set of `notifyState.*` keys that lane wrote before the un-stacking, read
// off the pre-change source:
//   token_mint          ensureFinanceOutcomeToken                        — outcomeToken (only if blank)
//   outcome_signal      applyFinanceOutcomeStatusFromSignal              — updatedAt, status
//   prompt_sent         maybePromptBusinessManagerFinanceOutcomeFallback — outcomePromptSentAt,
//                       lastPromptSourceMessageId, userId, phone, updatedAt
//   notify_sent         notifyBusinessManagerFinanceOutcome              — <status>SentAt ONLY
//   public_link_pending POST /public/appointment/outcome (pending)       — status, pendingAt,
//                       outcomePromptRespondedAt, updatedAt
//   public_link_resolved same endpoint (approved/declined/needs_info)    — outcomePromptRespondedAt,
//                       updatedAt
//   staff_sms_pending   staff OUTCOME reply, "pending" branch            — outcomePendingAt, updatedAt
//   staff_sms_resolved  staff OUTCOME reply, parsed-outcome branch       — outcomePromptResolvedAt,
//                       updatedAt
// ---------------------------------------------------------------------------
const ORIGINAL: Record<Lane, string[]> = {
  token_mint: ["outcomeToken"],
  outcome_signal: ["status", "updatedAt"],
  prompt_sent: [
    "lastPromptSourceMessageId",
    "outcomePromptSentAt",
    "phone",
    "updatedAt",
    "userId"
  ],
  notify_sent: ["declinedSentAt"],
  public_link_pending: ["outcomePromptRespondedAt", "pendingAt", "status", "updatedAt"],
  public_link_resolved: ["outcomePromptRespondedAt", "updatedAt"],
  staff_sms_pending: ["outcomePendingAt", "updatedAt"],
  staff_sms_resolved: ["outcomePromptResolvedAt", "updatedAt"]
};

/** Run one lane through the applier on an empty conversation and report the keys it wrote. */
function writtenKeys(lane: Lane, extra: Record<string, unknown> = {}): string[] {
  const conv: any = { id: "c1" };
  applyFinanceOutcomeNotifyState(conv, {
    lane,
    nowIso: NOW,
    outcomeStatus: "declined",
    sentStatus: "declined",
    mintedToken: "tok123",
    promptSourceMessageId: "msg-1",
    promptUserId: "u-9",
    promptPhone: "+15550001111",
    ...extra
  } as any);
  return Object.keys(conv.financeOutcomeNotify ?? {}).sort();
}

for (const [lane, expected] of Object.entries(ORIGINAL) as [Lane, string[]][]) {
  const got = writtenKeys(lane);
  ok(
    JSON.stringify(got) === JSON.stringify([...expected].sort()),
    `${lane}: must write exactly ${JSON.stringify([...expected].sort())}, wrote ${JSON.stringify(got)}`
  );
  const d = decideFinanceOutcomeNotifyState({
    lane,
    outcomeStatus: "declined",
    sentStatus: "declined"
  });
  ok(typeof d.why === "string" && d.why.includes(lane), `${lane}: why must name the lane`);
}

// ---------------------------------------------------------------------------
// D3 — `notify_sent` is the ONLY lane that skips `updatedAt`.
// ---------------------------------------------------------------------------
for (const lane of Object.keys(ORIGINAL) as Lane[]) {
  const touches = decideFinanceOutcomeNotifyState({ lane }).touchUpdatedAt;
  const expectTouch = lane !== "notify_sent" && lane !== "token_mint";
  ok(
    touches === expectTouch,
    `${lane}: touchUpdatedAt must be ${expectTouch} (D3 preserves notify_sent's omission), got ${touches}`
  );
}
ok(
  decideFinanceOutcomeNotifyState({ lane: "notify_sent" }).divergence ===
    "notify_sent_does_not_bump_updated_at",
  "D3 must stay NAMED on the notify_sent decision"
);

// ---------------------------------------------------------------------------
// D1 — the two PENDING lanes must keep answering differently.
// ---------------------------------------------------------------------------
{
  const link = decideFinanceOutcomeNotifyState({ lane: "public_link_pending" });
  const sms = decideFinanceOutcomeNotifyState({ lane: "staff_sms_pending" });
  ok(link.status === "pending", "public_link_pending must write status=pending (the QA audit reads it)");
  ok(link.stampPendingAt === true, "public_link_pending must stamp pendingAt");
  ok(sms.status === null, "staff_sms_pending must NOT write a status — D1, preserved");
  ok(sms.stampPendingAt === false, "staff_sms_pending must NOT stamp pendingAt — D1, preserved");
  ok(sms.answerStamp === "pending_only", "staff_sms_pending stamps outcomePendingAt and nothing else");
  ok(
    typeof link.divergence === "string" && typeof sms.divergence === "string",
    "both halves of D1 must stay NAMED on their decisions"
  );
}

// ---------------------------------------------------------------------------
// D2 — the two RESOLVED lanes must keep stamping different clocks.
// ---------------------------------------------------------------------------
{
  ok(
    decideFinanceOutcomeNotifyState({ lane: "public_link_resolved" }).answerStamp === "responded",
    "public_link_resolved stamps outcomePromptRespondedAt"
  );
  const sms = decideFinanceOutcomeNotifyState({ lane: "staff_sms_resolved" });
  ok(sms.answerStamp === "resolved", "staff_sms_resolved stamps outcomePromptResolvedAt — D2, preserved");
  ok(
    sms.divergence === "staff_sms_resolved_stamps_a_different_answer_clock_than_the_public_link",
    "D2 must stay NAMED on the staff_sms_resolved decision"
  );
  // Neither resolved lane may write the OUTCOME itself — that is `outcome_signal`'s job, and both
  // callers invoke it first. If a resolved lane started writing `status`, it would overwrite the
  // parsed outcome with nothing on the lanes where the parse was low-confidence.
  for (const lane of ["public_link_resolved", "staff_sms_resolved"] as const) {
    ok(
      decideFinanceOutcomeNotifyState({ lane }).status === null,
      `${lane} must leave the outcome status to outcome_signal`
    );
  }
}

// ---------------------------------------------------------------------------
// NOT divergences — pinned so the D1/D2 fix PR does not flatten the deliberate rules.
// ---------------------------------------------------------------------------
{
  const conv: any = { financeOutcomeNotify: { outcomeToken: "already-here" } };
  applyFinanceOutcomeNotifyState(conv, { lane: "token_mint", nowIso: NOW, mintedToken: "fresh" });
  ok(
    conv.financeOutcomeNotify.outcomeToken === "already-here",
    "token_mint must KEEP an existing token — an inbound staff SMS is matched against it"
  );
  ok(
    conv.financeOutcomeNotify.updatedAt === undefined,
    "token_mint must not stamp the record's clock — generating a token is not a manager event"
  );

  const kept: any = { financeOutcomeNotify: { userId: "u-old" } };
  applyFinanceOutcomeNotifyState(kept, {
    lane: "prompt_sent",
    nowIso: NOW,
    promptUserId: "   ",
    promptPhone: "+15550001111"
  });
  ok(
    kept.financeOutcomeNotify.userId === "u-old",
    "prompt_sent must KEEP an existing userId when the caller has none — the matcher falls back on it"
  );
}

// ---------------------------------------------------------------------------
// The per-status SENT latch — this is what stops us texting the manager twice.
// ---------------------------------------------------------------------------
for (const [sentStatus, latch] of [
  ["approved", "approvedSentAt"],
  ["declined", "declinedSentAt"],
  ["needs_more_info", "needsInfoSentAt"]
] as const) {
  const d = decideFinanceOutcomeNotifyState({ lane: "notify_sent", sentStatus });
  ok(d.sentLatch === latch, `notify_sent/${sentStatus} must latch ${latch}, got ${d.sentLatch}`);
}
// JUNK INPUT targets the referee's SHAPE, not its rules. A missing status must still latch
// something — the original's `else` branch was needs-info, and latching NOTHING would let the same
// manager notification go out on every pass.
ok(
  decideFinanceOutcomeNotifyState({ lane: "notify_sent" }).sentLatch === "needsInfoSentAt",
  "notify_sent with no status must fall to the original's else branch, not to no latch at all"
);
ok(
  decideFinanceOutcomeNotifyState({ lane: "outcome_signal" }).status === null,
  "outcome_signal with no parsed outcome must write no status rather than a junk one"
);

// ---------------------------------------------------------------------------
// WIRING: no unrefereed writer of this field may survive outside the applier.
// This is what goes red if a call site is unwired from the referee.
// ---------------------------------------------------------------------------
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve("services/api/src");
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (entry.name.endsWith(".ts")) {
        files.push({ path: path.relative(process.cwd(), full), text: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(root);
  const entry = rankContention(files, { minWrites: 1 }).find(
    f => f.field === "financeOutcomeNotify"
  );
  const offending = entry?.unrefereedWriterSites ?? [];
  ok(
    offending.length === 0,
    "every financeOutcomeNotify writer must ask the referee — unrefereed: " +
      offending.map(s => `${s.file}:${s.line}`).join(", ")
  );
  // The STRONGER invariant, and the one that actually goes red when a call site is unwired.
  // `unrefereedWriterSites` alone cannot carry this: two of the seven lanes sit within 40 lines of
  // ANOTHER applier call, so restoring their inline write reads as "refereed" and the check above
  // stays green (verified by sabotage, 2026-08-04 — the same credit/collapse artifact this program
  // has now hit six times). Requiring EVERY raw write to live in the applier has no such blind spot.
  const strays = (entry?.writeSites ?? []).filter(
    s => !s.file.endsWith("domain/conversationStore.ts")
  );
  ok(
    strays.length === 0,
    "financeOutcomeNotify may only be written inside applyFinanceOutcomeNotifyState — strays: " +
      strays.map(s => `${s.file}:${s.line}`).join(", ")
  );
}

// ---------------------------------------------------------------------------
// The referee must be REGISTERED, or the next un-stacking ships with no evidence for it.
// ---------------------------------------------------------------------------
{
  const { buildDecisionRegistry } = await import("../services/api/src/domain/decisionFingerprint.ts");
  const reducer = await import("../services/api/src/domain/routeStateReducer.ts");
  const registry = buildDecisionRegistry(reducer as any);
  ok(
    registry.some(e => (e.covers ?? []).includes("decideFinanceOutcomeNotifyState")),
    "decideFinanceOutcomeNotifyState must be sampled in buildDecisionRegistry"
  );
  const lanesSampled = registry.filter(e => e.name.startsWith("financeOutcomeNotify:")).length;
  ok(lanesSampled === 8, `all eight lanes must be sampled separately, found ${lanesSampled}`);
}

console.log(`finance_outcome_notify:eval OK (${checks} checks)`);
