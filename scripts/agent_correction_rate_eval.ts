/**
 * agent_correction_rate:eval — pins the DEFINITION of "the agent had to be corrected".
 *
 * Joe, 2026-08-01: "track how often the user needs to change a reply when it's not a true turn
 * over — to see how often the user has to correct the agent."
 *
 * This metric decides whether the agent is good enough to sell to a second dealer
 * ([[north-star-readiness-bar]]). A metric that FLATTERS the agent is worse than no metric: it
 * would read "ready" when it is not. So every row below exists to stop an edit being excused on
 * weak grounds, and the fail direction is always "count it as a correction".
 *
 * The three legitimate exclusions, and the trap each one guards:
 *  - TURNOVER: the thread was handed to a person BEFORE the reply went out. The handoff must
 *    predate the send — reading the CURRENT mode would let a later handoff retroactively excuse
 *    an earlier bad draft, and would excuse more and more as threads accumulate handoffs.
 *  - OUT-OF-BAND: the rep supplied knowledge the agent had no access to. Real and common — live
 *    +17164792868 replaced "I'm not seeing one available" with an incoming trade nobody had
 *    entered yet. Requires an AFFIRMATIVE judge verdict; unknown never excuses.
 *  - COSMETIC: wording/length only, per the judge.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  bucketDraftEdit,
  classifiedCoverage,
  stampDraftProvenance,
  summarizeCorrectionBuckets,
  wasHandedOverBeforeSend
} from "../services/api/src/domain/agentCorrectionRate.ts";

const SENT = "2026-08-01T15:00:00.000Z";
const BEFORE = "2026-07-30T09:00:00.000Z";
const AFTER = "2026-08-01T18:00:00.000Z";
const material = { isMaterial: true, agentCouldHaveKnown: true, category: "wrong_intent", confidence: 0.9 };

// --- TURNOVER: only a handoff that PREDATES the send ---
assert.equal(
  bucketDraftEdit({ sentAt: SENT, followUpMode: "manual_handoff", followUpModeUpdatedAt: BEFORE, judge: material })
    .bucket,
  "turnover",
  "handed off before the send => turnover, not a correction"
);
assert.equal(
  bucketDraftEdit({ sentAt: SENT, followUpMode: "manual_handoff", followUpModeUpdatedAt: AFTER, judge: material })
    .bucket,
  "correction",
  "a handoff AFTER the send must not retroactively excuse the draft"
);
assert.equal(
  bucketDraftEdit({ sentAt: SENT, followUpMode: "manual_handoff", followUpModeUpdatedAt: null, judge: material })
    .bucket,
  "correction",
  "a handoff with no timestamp cannot be proven to predate the send => not excused"
);
assert.equal(
  bucketDraftEdit({ sentAt: SENT, followUpMode: "active", followUpModeUpdatedAt: BEFORE, judge: material }).bucket,
  "correction",
  "an ACTIVE thread is the agent's — an edit there is a correction"
);
assert.equal(wasHandedOverBeforeSend({ sentAt: SENT, followUpMode: "human", followUpModeUpdatedAt: BEFORE }), true);
assert.equal(wasHandedOverBeforeSend({ sentAt: SENT, followUpMode: "holding_inventory", followUpModeUpdatedAt: BEFORE }), false);

// --- OUT-OF-BAND: only an AFFIRMATIVE false excuses the agent ---
assert.equal(
  bucketDraftEdit({
    sentAt: SENT,
    followUpMode: "active",
    judge: { isMaterial: true, agentCouldHaveKnown: false, category: "missing_info", confidence: 0.9 }
  }).bucket,
  "out_of_band",
  "the rep knew something the agent could not => not the agent's error"
);
for (const unknown of [null, undefined]) {
  assert.equal(
    bucketDraftEdit({
      sentAt: SENT,
      followUpMode: "active",
      judge: { isMaterial: true, agentCouldHaveKnown: unknown as any, category: "wrong_fact" }
    }).bucket,
    "correction",
    "UNKNOWN must never excuse the agent — an unproven excuse would flatter the number"
  );
}

// --- COSMETIC ---
assert.equal(
  bucketDraftEdit({
    sentAt: SENT,
    followUpMode: "active",
    judge: { isMaterial: false, agentCouldHaveKnown: true, category: "voice_tone", confidence: 0.9 }
  }).bucket,
  "cosmetic",
  "wording-only edits are not corrections"
);

// --- UNCLASSIFIED: never silently folded into either side ---
for (const noVerdict of [null, undefined, { isMaterial: null } as any]) {
  assert.equal(
    bucketDraftEdit({ sentAt: SENT, followUpMode: "active", judge: noVerdict }).bucket,
    "unclassified",
    "an edit with no judge verdict is reported as unclassified, never guessed"
  );
}

// --- TOTALS + the honesty rules ---
{
  const totals = summarizeCorrectionBuckets([
    "correction",
    "correction",
    "out_of_band",
    "cosmetic",
    "turnover",
    "unclassified"
  ]);
  assert.equal(totals.edits, 6);
  assert.equal(totals.corrections, 2);
  assert.equal(totals.turnover, 1, "turnover is excluded from the rate entirely");
  assert.equal(totals.unclassified, 1);
  assert.equal(totals.attributable, 4, "denominator = correction + out_of_band + cosmetic");
  assert.equal(totals.correctionRate, 0.5);
  // Coverage tells you how much of the window the rate actually speaks for.
  assert.equal(classifiedCoverage(totals), 4 / 5, "coverage excludes turnover from both sides");
}
{
  // Nothing measurable must read as "not yet measured", NEVER as a flattering 0%.
  const empty = summarizeCorrectionBuckets([]);
  assert.equal(empty.correctionRate, null, "an unmeasured rate is null, not 0");
  assert.equal(classifiedCoverage(empty), null);
  const allUnclassified = summarizeCorrectionBuckets(["unclassified", "unclassified"]);
  assert.equal(allUnclassified.correctionRate, null, "all-unclassified is unmeasured, not 0%");
}

// --- PROVENANCE STAMP: the denominator ---
{
  const messages = [{ id: "m1", direction: "out" }, { id: "m2", direction: "out" }];
  assert.equal(stampDraftProvenance(messages, "m2", { draftEdited: false }), true);
  assert.equal((messages[1] as any).draftUsed, true, "an UNEDITED draft send is stamped — that is the denominator");
  assert.equal((messages[1] as any).draftEdited, false);
  assert.equal((messages[0] as any).draftUsed, undefined, "only the named message is stamped");
  // Best-effort: a miss must never throw (it would break a customer send).
  assert.equal(stampDraftProvenance(messages, "nope", { draftEdited: true }), false);
  assert.equal(stampDraftProvenance(null, "m1", { draftEdited: true }), false);
  assert.equal(stampDraftProvenance(messages, "", { draftEdited: true }), false);
}

// --- WIRING: the judge must actually be asked the out-of-band question, and both send paths
//     must stamp provenance — otherwise the definition above is unenforced theory.
{
  const llmDraft = fs.readFileSync(path.resolve("services/api/src/domain/llmDraft.ts"), "utf8");
  assert.ok(
    /required:\s*\[[^\]]*"agent_could_have_known"/.test(llmDraft),
    "the draft-edit judge REQUIRES agent_could_have_known (a nullable field would silently excuse edits)"
  );
  assert.ok(
    /agentCouldHaveKnown:\s*parsed\.agent_could_have_known\s*!==\s*false/.test(llmDraft),
    "an unparsed verdict must default to 'the agent could have known' (never excuse on a parse failure)"
  );
  const index = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
  assert.ok(index.includes("stampDraftProvenance"), "index.ts stamps draft provenance at the send path");
  assert.ok(
    index.includes("draftEditVerdict"),
    "the per-message verdict is persisted — conv.humanCorrection keeps only the latest material one"
  );
}

console.log("PASS agent correction rate — turnover/out-of-band/cosmetic exclusions, unmeasured != 0%, provenance stamp");
