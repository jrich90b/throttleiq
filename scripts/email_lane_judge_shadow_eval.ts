/**
 * email_lane_judge_shadow:eval — the email/ADF lane's drafts are WATCHED, and only watched.
 *
 * Background (2026-08-02): the sendgrid lane wrote 48% of the week's AI drafts and called no judge
 * — including the first message every new web lead receives. This shadow closes the coverage gap
 * without changing a single customer outcome: every draft is judged by claude-sonnet-5 (the
 * bake-off winner), the verdict lands in reports/email_lane_judge/*.jsonl, and nothing consumes
 * it. The week of records is the evidence for the enforce decision (Step 3, Joe's call).
 *
 * What must stay true, in fail-direction order:
 *  1. COVERAGE PARITY: every `"draft_ai"` append in sendgridInbound has a shadow call — a new
 *     draft site without one recreates the unwatched-lane gap silently.
 *  2. NEVER AWAITED: an awaited shadow would put ~4s of judge latency into the inbound path.
 *  3. Fire-and-forget void + capped: it cannot throw, block, or run up a bill.
 *  4. A failed judge call records verdict:null — never a verdict, never "agreement".
 *
 * Run: npx tsx scripts/email_lane_judge_shadow_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  claimEmailLaneJudgeSlot,
  emailLaneJudgeDailyCap,
  emailLaneJudgeModel,
  isEmailLaneJudgeShadowEnabled,
  resetEmailLaneJudgeSpend,
  runEmailLaneJudgeShadow
} from "../services/api/src/domain/emailLaneJudgeShadow.ts";

// --- flag semantics: default ON (Joe approved the watch step), "0" is the only off switch -------
delete process.env.EMAIL_LANE_JUDGE_SHADOW;
assert.equal(isEmailLaneJudgeShadowEnabled(), true, "unset => shadow ON (the gap is the default-off state)");
process.env.EMAIL_LANE_JUDGE_SHADOW = "0";
assert.equal(isEmailLaneJudgeShadowEnabled(), false, "'0' disables");
process.env.EMAIL_LANE_JUDGE_SHADOW = "1";
assert.equal(isEmailLaneJudgeShadowEnabled(), true, "'1' enables");
delete process.env.EMAIL_LANE_JUDGE_SHADOW;

// --- model: Sonnet per the 8/2 bake-off (26 consensus holds + 1 unilateral vs Opus's 14) --------
delete process.env.EMAIL_LANE_JUDGE_MODEL;
assert.equal(emailLaneJudgeModel(), "claude-sonnet-5", "default judge is claude-sonnet-5");
process.env.EMAIL_LANE_JUDGE_MODEL = " claude-opus-5 ";
assert.equal(emailLaneJudgeModel(), "claude-opus-5", "overridable without a deploy");
delete process.env.EMAIL_LANE_JUDGE_MODEL;

// --- the cap is real, per-call, UTC-day-scoped, and garbage-tolerant ----------------------------
resetEmailLaneJudgeSpend();
assert.equal(claimEmailLaneJudgeSlot("2026-08-02", 2), true, "1st allowed");
assert.equal(claimEmailLaneJudgeSlot("2026-08-02", 2), true, "2nd allowed");
assert.equal(claimEmailLaneJudgeSlot("2026-08-02", 2), false, "3rd refused at cap");
assert.equal(claimEmailLaneJudgeSlot("2026-08-03", 2), true, "UTC date roll resets");
resetEmailLaneJudgeSpend();
assert.equal(claimEmailLaneJudgeSlot("2026-08-02", 0), false, "cap 0 disables outright");
delete process.env.EMAIL_LANE_JUDGE_DAILY_CAP;
assert.equal(emailLaneJudgeDailyCap(), 150, "default cap");
process.env.EMAIL_LANE_JUDGE_DAILY_CAP = "garbage";
assert.equal(emailLaneJudgeDailyCap(), 150, "garbage cap => default, never unlimited");
process.env.EMAIL_LANE_JUDGE_DAILY_CAP = "-3";
assert.equal(emailLaneJudgeDailyCap(), 150, "negative cap => default, never unlimited");
delete process.env.EMAIL_LANE_JUDGE_DAILY_CAP;

// --- inert without a key / without a draft / without an inbound; and returns NOTHING ------------
resetEmailLaneJudgeSpend();
const savedKey = process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
assert.equal(
  runEmailLaneJudgeShadow({ id: "c1", messages: [{ direction: "in", body: "hi" }] }, "a draft"),
  undefined,
  "void — no caller can ever act on a shadow verdict"
);
// A proactive draft with no inbound is skipped — same domain rule as the SMS judge.
process.env.ANTHROPIC_API_KEY = "test-key-never-called";
process.env.EMAIL_LANE_JUDGE_DAILY_CAP = "0"; // belt: even if it got past the guards, no spend
assert.equal(
  runEmailLaneJudgeShadow({ id: "c2", messages: [{ direction: "out", body: "we texted first" }] }, "a draft"),
  undefined,
  "no inbound => skipped, no throw"
);
assert.equal(runEmailLaneJudgeShadow({ id: "c3", messages: [] }, "   "), undefined, "blank draft => skipped");
assert.equal(runEmailLaneJudgeShadow(null, "a draft"), undefined, "null conv => skipped, no throw");
delete process.env.EMAIL_LANE_JUDGE_DAILY_CAP;
if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
else process.env.ANTHROPIC_API_KEY = savedKey;

// --- WIRING: coverage parity + never awaited ----------------------------------------------------
const sendgrid = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");
const draftAppends = (sendgrid.match(/"draft_ai"/g) ?? []).length;
const shadowCalls = (sendgrid.match(/runEmailLaneJudgeShadow\(conv/g) ?? []).length;
assert.ok(draftAppends >= 5, `expected the known 5 draft_ai sites, found ${draftAppends} — if sites were removed, update this floor`);
assert.equal(
  shadowCalls,
  draftAppends,
  `COVERAGE PARITY: ${draftAppends} draft_ai append(s) but ${shadowCalls} shadow call(s) — a new email-lane ` +
    "draft site must call runEmailLaneJudgeShadow right after appendOutbound, or that draft is invisible again"
);
for (const m of sendgrid.matchAll(/(await\s+)?runEmailLaneJudgeShadow\(/g)) {
  assert.equal(m[1], undefined, "runEmailLaneJudgeShadow must NEVER be awaited — ~4s of judge latency does not belong in the inbound path");
}

console.log(
  `PASS email-lane judge shadow — default-on watch, sonnet-5, capped, void, ${shadowCalls}/${draftAppends} draft sites covered, never awaited`
);
