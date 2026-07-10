/**
 * Loop digest eval (pure, no LLM, no email).
 *
 * Pins formatLoopDigest — the "surface" step that turns the loop's tier-tagged work order (next.json) into
 * the operator digest. Guarantees: healthy => no content (so the mailer stays quiet); with findings =>
 * Tier 2 (needs review) listed before Tier 1, the subject carries the counts, and every item shows its
 * tier/action/dimension/detail/conv so Joe can act. Plus a source guard that the mailer only sends when
 * there's content (or forced) and reuses the existing sendEmail.
 *
 * Run: npx tsx scripts/loop_digest_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { formatLoopDigest } from "../services/api/src/domain/loopDigest.ts";

// --- healthy store => no content, all-clear subject (mailer stays quiet). ---
{
  const d = formatLoopDigest({ generatedAt: "2026-06-25T13:00:00Z", workOrderCount: 0, workOrders: [], stop: true });
  assert.equal(d.hasContent, false, "healthy => no content");
  assert.match(d.subject, /all clear/i, "healthy => all-clear subject");
}

// --- with findings: counts in subject, Tier 2 before Tier 1, items carry the actionable detail. ---
{
  const payload = {
    generatedAt: "2026-06-25T13:00:00Z",
    feedGeneratedAt: "2026-06-25T12:50:00Z",
    workOrderCount: 3,
    notifyCount: 2,
    byTier: { "0": 0, "1": 1, "2": 2 },
    workOrders: [
      { convId: "+1", leadKey: "+1", dimension: "open_critic_finding", category: "discovery", severity: "P2", tier: 2, action: "escalate", notify: true, detail: "watch_set_for_wrong_model — opened a Road Glide watch; customer asked about a Street Glide" },
      { convId: "+2", leadKey: "+2", dimension: "human_correction_material", category: "comprehension", severity: "P2", tier: 1, action: "parser_fix_candidate", notify: true, autoMergeEligible: false, detail: "staff corrected the lead type" },
      { convId: "+3", leadKey: "+3", dimension: "watch_active_on_closed", category: "state", severity: "P2", tier: 1, action: "add_invariant_or_heal", notify: false, persistent: true, detail: "watch active on a closed conv" }
    ],
    stop: false
  };
  const d = formatLoopDigest(payload, { dealer: "americanharley" });
  assert.equal(d.hasContent, true, "findings => has content");
  assert.match(d.subject, /3 finding/, "subject carries the total");
  assert.match(d.subject, /2 need review/, "subject carries the needs-review count");
  assert.match(d.subject, /americanharley/, "subject carries the dealer label");
  // Tier 2 section appears before Tier 1 section (needs-review first).
  const t2idx = d.text.indexOf("NEEDS YOUR REVIEW");
  const t1idx = d.text.indexOf("Safe auto-patch");
  assert.ok(t2idx >= 0 && t1idx >= 0 && t2idx < t1idx, "Tier 2 (needs review) listed before Tier 1");
  // The Tier-2 finding's model-named class + detail + conv are all present (actionable).
  assert.match(d.text, /watch_set_for_wrong_model/, "the model-proposed class is shown");
  assert.match(d.text, /conv: \+1/, "the conv id is shown so Joe can find it");
  assert.match(d.text, /persistent/, "a persistent finding is tagged");
}

// --- source guard: the mailer only sends when there's content (or forced) + reuses sendEmail. ---
const mailer = fs.readFileSync("scripts/loop_digest.ts", "utf8");
assert.match(mailer, /formatLoopDigest/, "mailer uses the pure formatter");
assert.match(mailer, /!digest\.hasContent && !force/, "mailer skips sending when healthy (unless forced)");
assert.match(mailer, /import\("\.\.\/services\/api\/src\/domain\/emailSender\.ts"\)/, "mailer reuses the existing sendEmail (no new email infra)");
assert.match(mailer, /LOOP_DIGEST_ENABLED/, "mailer has a kill switch");

// --- Decision queue + age clock (Joe, 2026-07-09: reports "keep building… aren't touched") ---
{
  const aged = formatLoopDigest({
    generatedAt: "now",
    workOrderCount: 3,
    notifyCount: 2,
    byTier: { "0": 0, "1": 1, "2": 2 },
    workOrders: [
      { convId: "+1", dimension: "reported_issue", tier: 2, notify: true, detail: "operator-reported: cadence question", ageDays: 5 },
      { convId: "+2", dimension: "reported_issue", tier: 2, notify: true, detail: "operator-reported: routing question", ageDays: 0 },
      { convId: "+3", dimension: "corpus_replay_judge_fail", tier: 1, notify: false, detail: "replay", ageDays: 1 }
    ]
  });
  assert.ok(/⏰ Oldest untouched finding: 5 day/.test(aged.text), "digest leads with the oldest-untouched age");
  assert.ok(/1 item\(s\) are 48h\+ OVERDUE/.test(aged.text), "48h+ items are counted as OVERDUE");
  assert.ok(/DECISION QUEUE — reply by number/.test(aged.text), "the decision queue header invites a numbered reply");
  assert.ok(/1\. ⏰ OVERDUE 5d \[reported_issue\] \+1/.test(aged.text), "queue is numbered, oldest first, overdue-tagged");
  assert.ok(/2\. \(new\) \[reported_issue\] \+2/.test(aged.text), "fresh items are tagged (new)");
  const q1 = aged.text.indexOf("DECISION QUEUE");
  const t2 = aged.text.indexOf("NEEDS YOUR REVIEW");
  assert.ok(q1 >= 0 && t2 > q1, "the decision queue renders ABOVE the detail sections");
  // Tier-1-only payloads have no queue (nothing needs a human decision).
  const t1only = formatLoopDigest({
    generatedAt: "now", workOrderCount: 1, notifyCount: 0, byTier: { "0": 0, "1": 1, "2": 0 },
    workOrders: [{ convId: "+9", dimension: "corpus_replay_judge_fail", tier: 1, notify: false, detail: "x", ageDays: 0 }]
  });
  assert.ok(!/DECISION QUEUE/.test(t1only.text), "no decision queue when nothing needs Joe");
}

console.log("PASS loop digest eval — healthy=quiet, findings formatted (Tier 2 first, counts + conv + class), decision queue + age clock, mailer send-guard + reuse.");
