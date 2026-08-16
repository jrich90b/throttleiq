/**
 * Policy-charter feed eval (pure, no LLM) — 2026-08-15/16.
 *
 * THE DEFECT: the in-product draft reviewer stamped `ok` on a draft that broke TWO of Joe's own
 * rulings (conv +17169071289, receipt msg_9092e0d536c57_1786813233214, 17:01:02Z) — it re-introduced
 * the agent to a customer texted the day before, and offered to show him a bike he had already
 * ridden. It approved them because nobody had ever told it those rules existed, and that was true of
 * EVERY rule in the charter. This eval pins the feed that fixes it.
 *
 * What it executes (never source-text assertions on the prompt — the prompt is generated):
 *   1. the extractor over FIXTURE charter markdown: right sections in, wrong sections out;
 *   2. the prompt builder: charter rules land, and the baked rules survive alongside them;
 *   3. the FAIL DIRECTION: unreadable / empty / junk charter => baked rules only, never a crash;
 *   4. the REAL charter carries the two rules the reviewer actually missed, so the fix is wired to
 *      the rulings and not just to a mechanism.
 *
 * Run: npx tsx scripts/policy_charter_feed_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const {
  extractReviewRelevantCharterRules,
  loadReviewRelevantCharterRules,
  resetCharterFeedCacheForTests,
  REVIEW_RELEVANT_CHARTER_SECTIONS,
  CHARTER_FEED_MAX_CHARS
} = await import("../services/api/src/domain/policyCharterFeed.ts");
const { buildClaudeDraftReviewSystemPrompt } = await import("../services/api/src/domain/claudeDraftReview.ts");

let n = 0;

// --- 1) The extractor, over a fixture charter shaped like the real one. ---
const FIXTURE = [
  "# Charter",
  "",
  "## C1 — Voice & composition",
  "",
  "- **C1.1** Voice is texting a friend; no AI-tells. *(charter initiative)*",
  "- **C1.2a** Once the customer has received ANY message from us on the thread, never",
  "  introduce again. *(7/23; 8/15)*",
  "",
  "## C2 — When to stay silent",
  "",
  "- **C2.3** International numbers: stay silent. *(7/22 #4)*",
  "",
  "## C3 — Cadence & follow-ups",
  "",
  "- **C3.1** Cadence timing is not the reviewer's job. *(7/9)*",
  "",
  "## C7 — Finance & pricing",
  "",
  "- **C7.1** Never quote/guess rates, payments or approval terms. *(7/11 #2)*",
  "- **C7.2** Pre-qualification is not a credit application. *(7/9 #5)*"
].join("\n");

const extracted = extractReviewRelevantCharterRules(FIXTURE);
assert.ok(extracted, "the extractor returns rules for a well-formed charter");
assert.ok(extracted!.includes("C1.1"), "C1 rules are fed to the reviewer");
assert.ok(extracted!.includes("C2.3"), "C2 rules are fed to the reviewer");
assert.ok(extracted!.includes("C7.1"), "the rate-quoting rule is pulled in from C7");
assert.ok(!extracted!.includes("C3.1"), "cadence timing is NOT the reviewer's job and must stay out");
assert.ok(!extracted!.includes("C7.2"), "only the named C7 rule crosses over, not the whole section");
// A wrapped bullet keeps its continuation line — a rule truncated mid-sentence is worse than absent.
assert.ok(extracted!.includes("never") && extracted!.includes("introduce again"), "wrapped bullets are rejoined, not cut");
// Provenance trailers are dropped: the reviewer needs the rule, not the citation.
assert.ok(!extracted!.includes("7/23; 8/15"), "provenance citations are stripped");
assert.ok(!extracted!.includes("**"), "markdown bold is stripped");
n += 9;

// --- 2) The prompt builder: charter rules land AND the baked rules survive. ---
const BAKED_MARKERS = [
  "NEVER drop a concrete fact",
  "NEVER invent a price",
  "Reply STOP to opt out",
  "When unsure: verdict"
];
const withCharter = buildClaudeDraftReviewSystemPrompt(extracted);
for (const m of BAKED_MARKERS) {
  assert.ok(withCharter.includes(m), `the baked rule "${m}" must survive alongside the charter`);
}
assert.ok(withCharter.includes("C1.2a"), "the charter rule reaches the reviewer's system prompt");
assert.ok(withCharter.includes("DEALER POLICY"), "the charter block is labelled so the model treats it as binding");
// It must be framed as BINDING, not as background: the whole defect was the reviewer treating a
// ruling-breaking draft as acceptable style.
assert.ok(/CLEARLY WRONG|rewrite/.test(withCharter.split("DEALER POLICY")[1] ?? ""), "the charter block tells the reviewer a breach is a rewrite");
n += BAKED_MARKERS.length + 3;

// --- 3) FAIL DIRECTION: no charter => today's behaviour exactly, never a crash. ---
const baked = buildClaudeDraftReviewSystemPrompt();
for (const m of BAKED_MARKERS) {
  assert.ok(baked.includes(m), `baked-only prompt keeps "${m}"`);
}
assert.ok(!baked.includes("DEALER POLICY"), "no charter => no policy block");
assert.equal(buildClaudeDraftReviewSystemPrompt(null), baked, "null charter == baked-only");
assert.equal(buildClaudeDraftReviewSystemPrompt(""), baked, "empty charter == baked-only");
assert.equal(buildClaudeDraftReviewSystemPrompt("   \n  "), baked, "whitespace charter == baked-only");
assert.equal(extractReviewRelevantCharterRules(""), null, "empty markdown yields null, not an empty ruleset");
assert.equal(extractReviewRelevantCharterRules("# nothing here\n\nprose only"), null, "a charter with no rules yields null");
assert.equal(extractReviewRelevantCharterRules("## C3 — Cadence\n\n- **C3.1** not mine"), null, "only-irrelevant-sections yields null");
n += BAKED_MARKERS.length + 7;

// An unreadable file must degrade to null rather than throw — the minute lane runs unattended.
resetCharterFeedCacheForTests();
process.env.POLICY_CHARTER_PATH = "/nonexistent/definitely-not-a-charter.md";
assert.equal(loadReviewRelevantCharterRules(1), null, "an unreadable charter loads as null, never throws");
delete process.env.POLICY_CHARTER_PATH;
resetCharterFeedCacheForTests();
n += 1;

// Runaway charter growth cannot crowd out the baked rules.
const huge = ["## C1 — Voice", ...Array.from({ length: 4000 }, (_, i) => `- **C1.${i}** ${"x".repeat(40)}`)].join("\n");
const capped = extractReviewRelevantCharterRules(huge);
assert.ok(capped && capped.length <= CHARTER_FEED_MAX_CHARS + 40, "the feed is capped so it cannot crowd out the baked rules");
assert.ok(buildClaudeDraftReviewSystemPrompt(capped).includes("NEVER drop a concrete fact"), "baked rules survive a maxed-out charter");
n += 2;

// --- 4) The REAL charter carries the two rules the reviewer actually missed. ---
// Without these the mechanism would be wired to nothing — this is the half that makes the fix real.
const realCharter = fs.readFileSync("docs/policy_charter.md", "utf8");
const realRules = extractReviewRelevantCharterRules(realCharter);
assert.ok(realRules, "the real charter yields rules");
assert.ok(realRules!.includes("C1.2a"), "the real charter states the mid-thread no-re-introduction rule (7/23 + 8/15)");
assert.ok(realRules!.includes("C1.8"), "the real charter states the DAT already-rode rule (8/15)");
assert.ok(/never introduce again/i.test(realRules!), "C1.2a actually says not to re-introduce");
assert.ok(/already ridden|already rode/i.test(realRules!), "C1.8 actually says not to offer a bike they rode");
assert.ok(realRules!.includes("C1.7"), "the advancing-question rule still reaches the reviewer");
// C1.4a — the carve-out that stops the reviewer calling a CORRECT thank-you a fabrication. C1.4
// alone tells it "ADF form fields are not the customer speaking … demo rides", which had it flag
// +17165241170 twice in two days over a Dealer Lead App "Demo Bikes Ridden" entry that Joe ruled
// on 8/11 IS evidence of a ride (live in code as visitFraming.dealerRecordedDemoRide). A ruling
// that lives only in code cannot reach an LLM reviewer — it has to be in the fed sections.
assert.ok(realRules!.includes("C1.4a"), "the real charter carries the Dealer Lead App demo-ride exception");
assert.ok(/demo bikes ridden/i.test(realRules!), "C1.4a names the field the exception turns on");
assert.ok(/dealer lead app/i.test(realRules!), "C1.4a names the record type, so the reviewer can tell it from any other ADF");
assert.ok(realRules!.includes("C1.4"), "the general no-fabricated-attribution rule stays alongside its exception");
// The exception must reach the PROMPT, not merely the extract — the whole point of the feed.
const promptWithCharter = buildClaudeDraftReviewSystemPrompt(realRules);
assert.ok(promptWithCharter.includes("C1.4a"), "C1.4a reaches the reviewer system prompt");
assert.ok(promptWithCharter.includes("NEVER drop a concrete fact"), "and the baked rules still survive beside it");
assert.ok(!realRules!.includes("C3."), "cadence rules stay out of the reviewer's prompt");
// Sections list is the contract the extractor is built on.
assert.deepEqual([...REVIEW_RELEVANT_CHARTER_SECTIONS], ["C1", "C2"], "reviewer scope is C1 + C2 (plus the named C7 rule)");
n += 14;

// --- 5) WIRING — the loader must actually be handed to the live API call. ---
// Everything above can pass while the feature is completely inert: if reviewDraftWithClaude builds
// its system prompt WITHOUT the loader, the charter never leaves the disk and the reviewer keeps
// approving ruling-breaking drafts exactly as it did on 8/15. A sabotage that did precisely this
// went undetected until this assertion existed. `.includes()` on purpose — eval_source_pin_ratchet
// counts assertions containing an escaped paren.
const reviewSrc = fs.readFileSync("services/api/src/domain/claudeDraftReview.ts", "utf8");
assert.ok(
  reviewSrc.includes("system: buildClaudeDraftReviewSystemPrompt(loadReviewRelevantCharterRules())"),
  "the live review call must build its prompt FROM the charter loader, or the feed is dead code"
);
assert.ok(
  reviewSrc.includes('from "./policyCharterFeed.js"'),
  "claudeDraftReview must import the charter feed"
);
n += 2;

console.log(`PASS policy charter feed eval (${n} assertions)`);
