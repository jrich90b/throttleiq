/**
 * Watch-fire review eval (source-level guards on a customer-adjacent engine change).
 *
 * The watch-fire-miss backlog (a watcher whose bike is in stock but wasn't a fresh arrival, so the cron
 * held off) is cleared by an operator-triggered IN-STOCK review pass. The non-negotiables: it DRAFTS ONLY
 * (suggest mode — staff approve; nothing auto-sent), it only activates on the explicit opt (the regular
 * cron is unchanged: new-arrival-only + the bulk guard), and it reuses the engine's existing guards.
 *
 * Run: npx tsx scripts/watch_fire_review_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const idx = fs.readFileSync("services/api/src/index.ts", "utf8");

// Opt-in mode on the engine; the regular cron call (no opts) is unchanged.
assert.match(idx, /async function processInventoryWatchlist\(targetConvId\?: string, opts\?: \{ includeInStock\?: boolean \}\)/, "engine takes an includeInStock opt");
assert.match(idx, /\(opts\?\.includeInStock \? items : newItems\)\.filter\(i => isWatchCandidateAvailable\(i\)\)/, "includeInStock broadens candidates to ALL available in-stock; default = new-arrivals only (cron unchanged)");
assert.match(idx, /!opts\?\.includeInStock && !scanPlan\.allowNotifications/, "the new-arrival bulk guard is bypassed ONLY for a deliberate review pass");
assert.match(idx, /void processInventoryWatchlist\(\);/, "the regular cron still calls the engine with NO opts (unchanged behavior)");

// DRAFTS ONLY — the review pass must never auto-send (it goes through the same draft_ai path).
assert.match(idx, /appendOutbound\(conv, "salesperson", to, reply, "draft_ai"/, "watch notifications are DRAFTS (draft_ai), never sent — staff approve in the console");

// The operator trigger endpoint exists, drafts only, and uses the in-stock mode.
assert.match(idx, /app\.post\("\/debug\/watch-fire-review"/, "the operator review-trigger endpoint exists");
assert.match(idx, /processInventoryWatchlist\(undefined, \{ includeInStock: true \}\)/, "the endpoint runs the in-stock review pass");
assert.match(idx, /suggest mode; nothing sent/, "the endpoint is explicit that nothing is sent (drafts for review)");

console.log("PASS watch-fire review eval — in-stock review pass drafts only (suggest mode), opt-in (cron unchanged), reuses engine guards, operator endpoint wired.");
