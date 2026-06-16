/**
 * regen_nondestructive:eval — regenerate must never DESTROY a draft or substitute a canned template.
 *
 * History (6/16): the console "Regenerate" button wiped good drafts. The first fix mirrored the live
 * path's buildInvariantGuardFallbackReply into the regen path — but that emitted an off-topic CANNED
 * template ("Happy to help with payments. What term…" on a "can I use debit" turn), papering over
 * comprehension and cutting against the de-tangle plan (burn DOWN fail-safe fallbacks, don't add
 * them). Backed out (Joe). The right shape: when orchestrate's fresh draft trips an invariant guard,
 * the AI couldn't beat what's already there — so KEEP the existing draft (publishCustomerReplyDraft
 * blocks BEFORE discarding, so it's intact) and return it with skipped:false so the client preserves
 * it. Comprehension (FAQ/route parsers) produces the real reply, not a template.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
const countOf = (needle: string) => src.split(needle).length - 1;

// The regenerate handler region (route registration → its catch block).
const regenStart = src.indexOf('app.post("/conversations/:id/regenerate"');
assert.ok(regenStart > 0, "regenerate route must exist");
const regenEnd = src.indexOf('app.post("/conversations/:id/call"', regenStart);
assert.ok(regenEnd > regenStart, "could not bound the regenerate handler");
const regen = src.slice(regenStart, regenEnd);

// 1) NO canned-template fallback in the regenerate path (the anti-pattern is gone).
assert.ok(
  !/regenInvariantFallback/.test(regen),
  "regen path must NOT define/use regenInvariantFallback (canned-template fallback was backed out)"
);
assert.ok(
  !/buildInvariantGuardFallbackReply/.test(regen),
  "regen path must NOT emit buildInvariantGuardFallbackReply (no canned template — comprehension answers)"
);

// 2) The non-destructive keep-existing helper exists and does NOT discard the pending draft.
assert.ok(
  /const respondRegenerateKeepExisting = \(reason: string\) =>/.test(regen),
  "regen path must define respondRegenerateKeepExisting"
);
const keepFn = regen.slice(
  regen.indexOf("const respondRegenerateKeepExisting"),
  regen.indexOf("const respondRegenerateKeepExisting") + 700
);
assert.ok(
  /lastDraft\?\.body/.test(keepFn),
  "respondRegenerateKeepExisting must return the EXISTING draft (lastDraft.body)"
);
assert.ok(
  !/discardPendingDrafts/.test(keepFn),
  "respondRegenerateKeepExisting must NOT discard the pending draft (non-destructive)"
);

// 3) EVERY invariant-block site (SMS + email helpers AND the inline orchestrate-result publishes —
//    the path the live turn takes) keeps the existing draft instead of skipping/wiping.
const blockSkips = countOf("respondRegenerateKeepExisting(published.reason)");
assert.ok(
  blockSkips >= 4,
  `every invariant-block site must keep the existing draft (expected >=4, found ${blockSkips})`
);

console.log("PASS regen-nondestructive eval (no canned template; invariant-block keeps the existing draft)");
