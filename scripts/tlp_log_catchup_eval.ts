/**
 * TLP CRM-log catch-up eval (2026-07-06) — pins the crm_log_stale SELF-HEAL.
 *
 * Root cause (7/6 daily review): the serialized TLP queue is in-memory fire-and-forget — a
 * restart between "send" and "log" drops queued jobs with no failure recorded, so the CRM
 * gap is permanent (Kellen +17167995197's 7/3 Custom Coverage reminder, crm={}; Chuck
 * +17163197142's 7/1 second console send, 67s after a logged one). Prevention alone can't
 * close this class — the fix is a periodic catch-up sweep that re-queues conversations
 * whose latest REAL outbound is newer than their last CRM log.
 *
 * Pins:
 *   1. Decision table — findTlpLogCatchupCandidates (pure): candidate/skip per the
 *      fail-direction contract (unsure => skip; a missed catch-up self-heals next sweep).
 *   2. Retry back-off (2026-07-07) — a permanently-failing log (lead missing in the CRM —
 *      refs 10966/11252/10937) must not pin the oldest-gap-first batch every sweep. The
 *      sweep stamps crm.lastCatchupAttemptAt; retries double away (~30m→1h→2h→…→daily).
 *      FAIL DIRECTION: back-off never blocks a conv whose log SUCCEEDED since the attempt
 *      or that has a NEW outbound since — and an unparseable stamp counts as no stamp.
 *   3. Source guards — the interval is registered behind TLP_LOG_CATCHUP_MINUTES (0 = kill
 *      switch), re-queues through the SAME serialized logger (no second Chromium path),
 *      and the attempt stamp is written by the sweep path ONLY.
 *
 * Run: npx tsx scripts/tlp_log_catchup_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  findTlpLogCatchupCandidates,
  isTlpLeadNotFoundError
} from "../services/api/src/domain/tlpLogCatchup.ts";

const NOW = Date.parse("2026-07-06T12:00:00.000Z");
const min = (n: number) => n * 60 * 1000;
const day = (n: number) => n * 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

const conv = (over: any) => ({
  id: over.id ?? "+15550000001",
  lead: { leadRef: "12345" },
  crm: {},
  messages: [],
  ...over
});
const out = (atMs: number, provider = "twilio", extra: any = {}) => ({
  direction: "out",
  provider,
  at: iso(atMs),
  ...extra
});

// --- 1) Decision table ---

// The Kellen shape: leadRef present, real send 3 days ago, never logged => candidate.
assert.deepEqual(
  findTlpLogCatchupCandidates([conv({ id: "+17167995197", messages: [out(NOW - day(3))] })], NOW),
  ["+17167995197"],
  "a never-logged real outbound past the grace window is a catch-up candidate"
);

// The Chuck shape: logged at T, a SECOND real send after T never logged => candidate.
assert.deepEqual(
  findTlpLogCatchupCandidates(
    [conv({ id: "+17163197142", crm: { lastLoggedAt: iso(NOW - day(5) - min(1)) }, messages: [out(NOW - day(5) - min(1)), out(NOW - day(5))] })],
    NOW
  ),
  ["+17163197142"],
  "an outbound newer than the last CRM log is a catch-up candidate"
);

// Already logged up to (or past) the latest outbound => skip.
assert.deepEqual(
  findTlpLogCatchupCandidates(
    [conv({ crm: { lastLoggedAt: iso(NOW - day(1)) }, messages: [out(NOW - day(1))] })],
    NOW
  ),
  [],
  "a fully-logged conversation is not re-queued"
);

// Inside the grace window => skip (the normal send-path log may still be in flight).
assert.deepEqual(
  findTlpLogCatchupCandidates([conv({ messages: [out(NOW - min(5))] })], NOW),
  [],
  "a fresh outbound inside the grace window is left to the normal send-path log"
);

// No leadRef anywhere => skip (the logger would no-op; don't burn a queue slot).
assert.deepEqual(
  findTlpLogCatchupCandidates([conv({ lead: {}, messages: [out(NOW - day(2))] })], NOW),
  [],
  "no leadRef => nothing to log against => skip"
);
// latestLead.leadRef alone is enough.
assert.deepEqual(
  findTlpLogCatchupCandidates([conv({ lead: {}, latestLead: { leadRef: "9" }, messages: [out(NOW - day(2))] })], NOW),
  ["+15550000001"],
  "latestLead.leadRef also qualifies"
);

// draft_ai rows were never sent => not a real outbound => skip.
assert.deepEqual(
  findTlpLogCatchupCandidates([conv({ messages: [out(NOW - day(2), "draft_ai")] })], NOW),
  [],
  "an unsent draft_ai row must never trigger a CRM log"
);

// Ancient gaps beyond the lookback => skip (stale CRM value, first-rollout browser storm).
assert.deepEqual(
  findTlpLogCatchupCandidates([conv({ messages: [out(NOW - day(45))] })], NOW),
  [],
  "outbounds older than the lookback are not swept"
);

// Unparseable timestamps fail toward skip.
assert.deepEqual(
  findTlpLogCatchupCandidates([conv({ messages: [{ direction: "out", provider: "twilio", at: "garbage" }] })], NOW),
  [],
  "garbage timestamps => skip (never enqueue on uncertainty)"
);

// Batch cap + oldest-gap-first ordering.
const many = Array.from({ length: 8 }, (_, i) =>
  conv({ id: `+1555000000${i}`, messages: [out(NOW - day(1) - min(i))] })
);
const batch = findTlpLogCatchupCandidates(many, NOW);
assert.equal(batch.length, 5, "sweep batch is capped (backlog drains over multiple sweeps)");
assert.equal(batch[0], "+15550000007", "oldest gap drains first");

// --- 1b) Retry back-off (2026-07-07): permanently-failing logs must not pin the batch ---

// The 10966/11252/10937 shape: attempted 10 min ago, gap already days old (=> back-off
// capped at a day), log never landed => skip this sweep instead of burning Chromium again.
assert.deepEqual(
  findTlpLogCatchupCandidates(
    [conv({ crm: { lastCatchupAttemptAt: iso(NOW - min(10)) }, messages: [out(NOW - day(3))] })],
    NOW
  ),
  [],
  "a just-attempted still-failing log waits out its back-off"
);

// Back-off is CAPPED at a day: even a permanently-failing log retries daily, so a lead
// created late in the CRM still heals without manual action (never blocked for good).
assert.deepEqual(
  findTlpLogCatchupCandidates(
    [conv({ crm: { lastCatchupAttemptAt: iso(NOW - day(1) - min(1)) }, messages: [out(NOW - day(3))] })],
    NOW
  ),
  ["+15550000001"],
  "back-off is capped at a day — a stuck gap keeps retrying daily, never permanently blocked"
);

// Floor: a FRESH failure (gap ~25 min old at attempt) retries on the next sweep (~30 min) —
// transient portal hiccups shouldn't wait hours.
assert.deepEqual(
  findTlpLogCatchupCandidates(
    [conv({ crm: { lastCatchupAttemptAt: iso(NOW - min(35)) }, messages: [out(NOW - min(60))] })],
    NOW
  ),
  ["+15550000001"],
  "a fresh failure retries after the ~one-sweep back-off floor"
);

// Doubling: the wait grows with how long the gap has persisted — attempted 1h ago on a gap
// that was already 2h old => the next try waits ~2h, so this sweep skips.
assert.deepEqual(
  findTlpLogCatchupCandidates(
    [conv({ crm: { lastCatchupAttemptAt: iso(NOW - min(60)) }, messages: [out(NOW - min(180))] })],
    NOW
  ),
  [],
  "the retry wait grows with the age of the gap (graduated back-off)"
);

// FAIL DIRECTION: a NEW outbound after the attempt resets the back-off — a fresh customer
// send must never wait out a stale failure's clock.
assert.deepEqual(
  findTlpLogCatchupCandidates(
    [conv({ crm: { lastCatchupAttemptAt: iso(NOW - min(50)) }, messages: [out(NOW - day(2)), out(NOW - min(25))] })],
    NOW
  ),
  ["+15550000001"],
  "a newer send resets the back-off (fresh contact must not inherit a stale failure's wait)"
);

// FAIL DIRECTION: the log SUCCEEDED since the attempt (lastLoggedAt advanced past it) and a
// newer outbound landed => the old attempt stamp is stale, catch up normally.
assert.deepEqual(
  findTlpLogCatchupCandidates(
    [conv({
      crm: { lastCatchupAttemptAt: iso(NOW - day(2)), lastLoggedAt: iso(NOW - day(1)) },
      messages: [out(NOW - day(3)), out(NOW - min(30))]
    })],
    NOW
  ),
  ["+15550000001"],
  "a log that succeeded since the attempt clears the back-off for the next gap"
);

// FAIL DIRECTION: an unparseable attempt stamp counts as NO stamp — fail toward retrying,
// never toward a silent permanent CRM gap.
assert.deepEqual(
  findTlpLogCatchupCandidates(
    [conv({ crm: { lastCatchupAttemptAt: "garbage" }, messages: [out(NOW - day(2))] })],
    NOW
  ),
  ["+15550000001"],
  "a garbage attempt stamp never blocks a catch-up"
);

// The pinning scenario end-to-end: 3 permanently-blocked convs with the OLDEST gaps (they'd
// win the oldest-first sort) are backed off, so the 5 batch slots go to healable gaps.
const pinned = [
  ...Array.from({ length: 3 }, (_, i) =>
    conv({
      id: `+1666000000${i}`, // blocked: oldest gaps — they'd win the sort without back-off
      crm: { lastCatchupAttemptAt: iso(NOW - min(10)) },
      messages: [out(NOW - day(7 + i))]
    })
  ),
  ...Array.from({ length: 6 }, (_, i) =>
    conv({ id: `+1777000000${i}`, messages: [out(NOW - day(1) - min(i))] })
  )
];
const unpinnedBatch = findTlpLogCatchupCandidates(pinned, NOW);
assert.equal(unpinnedBatch.length, 5, "backed-off convs free their batch slots");
assert.ok(
  unpinnedBatch.every(id => id.startsWith("+1777")),
  "permanently-blocked convs no longer pin the oldest-first batch"
);

// --- 1c) Lead-not-in-CRM suppression (2026-07-12): a customer never logged into TLP first ---

// The classifier only fires on TLP's OWN definitive "no such lead" signals — a transient portal
// failure (login/MFA/timeout/selector) must stay retryable, never permanently drop a live lead.
assert.equal(
  isTlpLeadNotFoundError("lead: no quick-lookup result for ref 10966"),
  true,
  "the 'no results' banner is a confirmed not-found"
);
assert.equal(
  isTlpLeadNotFoundError("lead: no visible quick-lookup row matching ref 11607 and phone 7160000000"),
  true,
  "the 'no matching row' fallback is a confirmed not-found"
);
assert.equal(
  isTlpLeadNotFoundError(
    "lead: quick lookup failed; ref 10966: lead: no quick-lookup result for ref 10966 | phone 716... with ref 10966: lead: no visible quick-lookup row matching ref 10966 and phone 716..."
  ),
  true,
  "the wrapped 'quick lookup failed' error still classifies not-found via its leaf phrase"
);
assert.equal(
  isTlpLeadNotFoundError("lead launch timed out waiting for TLP login"),
  false,
  "a login/launch failure is transient, NOT a confirmed not-found (must keep retrying)"
);
assert.equal(
  isTlpLeadNotFoundError("selector #QL_Ref not found on page"),
  false,
  "selector drift is transient, NOT a lead-not-found (a missing selector is a portal-shape failure)"
);
assert.equal(isTlpLeadNotFoundError(""), false, "empty error never classifies as not-found");

// Sweep skip: a leadRef stamped not-found for THIS outbound is a dead end — don't re-hammer it.
assert.deepEqual(
  findTlpLogCatchupCandidates(
    [conv({
      crm: { leadRefNotFoundAtByLeadRef: { "12345": iso(NOW - min(30)) } },
      messages: [out(NOW - day(3))]
    })],
    NOW
  ),
  [],
  "a lead confirmed missing in the CRM is not re-queued every sweep (the noise this fixes)"
);

// The stamp is per-leadRef: a not-found marker for a DIFFERENT ref doesn't suppress this conv.
assert.deepEqual(
  findTlpLogCatchupCandidates(
    [conv({
      crm: { leadRefNotFoundAtByLeadRef: { "99999": iso(NOW - min(30)) } },
      messages: [out(NOW - day(3))]
    })],
    NOW
  ),
  ["+15550000001"],
  "a not-found stamp for a different ref does not suppress this conversation's ref"
);

// RECOVERY: a NEWER outbound than the not-found stamp re-opens the attempt — staff may have
// created the lead in TLP and texted again, so we try once more (fail toward re-logging).
assert.deepEqual(
  findTlpLogCatchupCandidates(
    [conv({
      crm: { leadRefNotFoundAtByLeadRef: { "12345": iso(NOW - day(2)) } },
      messages: [out(NOW - day(3)), out(NOW - min(30))]
    })],
    NOW
  ),
  ["+15550000001"],
  "a new send after the not-found stamp re-opens the log attempt (natural recovery)"
);

// --- 1d) Source guards for the not-found suppression path ---
const catchupSrc = fs.readFileSync(
  path.resolve("services/api/src/domain/tlpLogCatchup.ts"),
  "utf8"
);
assert.match(
  catchupSrc,
  /leadRefNotFoundAtByLeadRef\?\.\[leadRef\][\s\S]{0,120}notFoundAt >= outboundAt\)\s*continue/,
  "the sweep skips a leadRef confirmed not-found for this-or-older outbound"
);

// --- 2) Source guards ---
const indexSrc = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
assert.match(
  indexSrc,
  /TLP_LOG_CATCHUP_MINUTES/,
  "the catch-up sweep must be registered behind the TLP_LOG_CATCHUP_MINUTES kill switch"
);
assert.match(
  indexSrc,
  /findTlpLogCatchupCandidates\(getAllConversations\(\)[\s\S]{0,900}queueTlpLogForConversation\(conv\)/,
  "the sweep must re-queue through the SAME serialized TLP logger (no second Chromium path)"
);
// The attempt stamp (the back-off clock) is written+persisted BEFORE the re-queue…
assert.match(
  indexSrc,
  /findTlpLogCatchupCandidates\(getAllConversations\(\)[\s\S]{0,900}lastCatchupAttemptAt[\s\S]{0,200}saveConversation\(conv\);?[\s\S]{0,100}queueTlpLogForConversation\(conv\)/,
  "the sweep must stamp+persist crm.lastCatchupAttemptAt before re-queueing"
);
// …and by the sweep path ONLY — the send-path logger must never touch the back-off clock.
assert.equal(
  (indexSrc.match(/lastCatchupAttemptAt\s*=/g) ?? []).length,
  1,
  "crm.lastCatchupAttemptAt is written by the sweep path only"
);
// The logger catch classifies a confirmed not-found and stamps the marker instead of re-filing
// the generic failure question (which never deduped => the staff spam this replaces).
assert.match(
  indexSrc,
  /isTlpLeadNotFoundError\(err\?\.message \?\? err\)[\s\S]{0,220}setCrmLeadRefNotFound\(conv[\s\S]{0,300}buildTlpLeadNotFoundQuestion\(leadRef\)/,
  "on a confirmed not-found the logger stamps the marker + files the clear one-time note"
);
assert.match(
  indexSrc,
  /function hasOpenTlpLeadNotFoundQuestion[\s\S]{0,220}listOpenQuestions\(\)/,
  "the not-found note is deduped against open questions (one per conv+ref)"
);
const storeSrc = fs.readFileSync(
  path.resolve("services/api/src/domain/conversationStore.ts"),
  "utf8"
);
// A successful log clears the not-found marker so a resolved lead doesn't keep a stale dead-end flag.
assert.match(
  storeSrc,
  /export function setCrmLeadRefNotFound[\s\S]{0,400}leadRefNotFoundAtByLeadRef\[normalizedLeadRef\] = iso/,
  "setCrmLeadRefNotFound stamps the per-ref not-found marker"
);
assert.match(
  storeSrc,
  /delete conv\.crm\.leadRefNotFoundAtByLeadRef\[normalizedLeadRef\]/,
  "a successful log clears the not-found marker for that ref"
);
assert.equal(
  (storeSrc.match(/lastCatchupAttemptAt\s*=/g) ?? []).length,
  0,
  "the conversation store declares the stamp but never writes it (sweep-path only)"
);

// ci:eval wiring.
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
assert.ok(
  String(pkg.scripts?.["ci:eval"] ?? "").includes("tlp_log_catchup:eval"),
  "tlp_log_catchup:eval is wired into ci:eval"
);

console.log(
  "PASS tlp log catch-up eval (decision table incl. retry back-off + lead-not-in-CRM suppression/recovery + classifier + serialized-queue/kill-switch/sweep-only-stamp/not-found source guards)"
);
