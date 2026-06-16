/**
 * regen_invariant_fallback:eval — both-paths parity guard for the regenerate invariant path.
 *
 * Real bug (Bobby Kindred, +17165701338, 6/16): clicking "Regenerate" on a manual_handoff deal
 * showed the AI-thinking spinner and then wiped the existing good draft with nothing to replace
 * it. Root cause: when orchestrate's draft tripped an invariant guard (e.g.
 * manual_handoff_inventory_prompt_guard), the LIVE twilio path emitted a safe fallback reply via
 * buildInvariantGuardFallbackReply, but the REGENERATE path called respondRegenerateSkipped —
 * which discardPendingDrafts() (marks the pending draft stale) and returns no draft. That is a
 * route-parity violation: live falls back, regen silently destroys the draft.
 *
 * Fix: the regen SMS + email publish helpers now try regenInvariantFallback (which wraps
 * buildInvariantGuardFallbackReply) and publish that draft before falling through to the skip.
 * This eval is a deterministic source guard that pins the parity so it can't regress.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");

// 1) The regen path defines a fallback that wraps the SAME builder the live path uses.
assert.ok(
  /const regenInvariantFallback = \(/.test(src),
  "regen path must define regenInvariantFallback"
);
assert.ok(
  /const regenInvariantFallback[\s\S]{0,400}buildInvariantGuardFallbackReply\(/.test(src),
  "regenInvariantFallback must wrap buildInvariantGuardFallbackReply (the live-path builder)"
);

// 2) The SMS regen helper tries the fallback (and publishes it) BEFORE respondRegenerateSkipped.
const smsHelper = src.slice(
  src.indexOf("const respondWithSmsRegeneratedDraft ="),
  src.indexOf("const respondWithEmailRegeneratedDraft =")
);
assert.ok(smsHelper.length > 0, "respondWithSmsRegeneratedDraft must exist");
assert.ok(
  /regenInvariantFallback\(published\.reason/.test(smsHelper),
  "SMS regen helper must call regenInvariantFallback on an invariant block"
);
assert.ok(
  /draft_invariant_fallback_published/.test(smsHelper),
  "SMS regen helper must publish the fallback draft (route outcome draft_invariant_fallback_published)"
);
assert.ok(
  smsHelper.indexOf("regenInvariantFallback(published.reason") <
    smsHelper.lastIndexOf("respondRegenerateSkipped(published.reason)"),
  "SMS regen helper must try the fallback BEFORE skipping (fallback precedes the skip)"
);

// 3) EVERY regen skip site (the SMS+email helpers AND the inline orchestrate-result publish that
//    Bobby's turn actually hits) must try the fallback first. Count the skip sites and require an
//    equal number of fallback attempts so a new skip path can't silently regress the wipe.
const countOf = (needle: string) => src.split(needle).length - 1;
const skipSites = countOf("respondRegenerateSkipped(published.reason)");
const fallbackAttempts = countOf("regenInvariantFallback(published.reason");
assert.ok(skipSites >= 4, `expected >=4 invariant-block skip sites in the regen path, found ${skipSites}`);
assert.ok(
  fallbackAttempts >= skipSites,
  `every invariant-block skip (${skipSites}) must try regenInvariantFallback first (found ${fallbackAttempts})`
);
assert.ok(
  countOf("draft_invariant_fallback_published") >= 4,
  "both the SMS helper and the inline SMS/email publishes must publish the fallback draft"
);

// 4) The builder itself still answers the guard that bit us (manual_handoff_inventory_prompt_guard)
//    with a follow-up holding reply — so the fallback is never empty for that reason.
const builder = src.slice(
  src.indexOf("function buildInvariantGuardFallbackReply("),
  src.indexOf("function buildInvariantGuardFallbackReply(") + 1600
);
assert.ok(
  /manual_handoff_inventory_prompt_guard/.test(builder) && /follow up/i.test(builder),
  "buildInvariantGuardFallbackReply must return a follow-up reply for manual_handoff_inventory_prompt_guard"
);

console.log("PASS regen-invariant-fallback eval (regen emits the live fallback, never a silent draft-wipe)");
