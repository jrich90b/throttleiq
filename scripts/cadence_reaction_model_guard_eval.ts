/**
 * Cadence reaction-echo model guard eval (pure, no LLM) — 2026-07-08.
 *
 * A tapback/reaction inbound ("Liked/Loved/Reacted ❤️ to “…”") QUOTES the agent's own outbound
 * verbatim — any model name inside it is the AGENT'S wording, not the customer's ask. The cadence
 * promo model picker (resolveCadencePreferredModelContext, index.ts) ranks recent customer inbounds
 * ABOVE the lead vehicle, so a reaction echo could out-rank the real lead model.
 *
 * Production miss (operator-reported, Chris Duchon +17164184478): lead vehicle = 2025 Road Glide
 * (the bike he's BUYING); his 'Liked "… Let me know how you make out on selling your Low Rider ST …"'
 * reaction echoed the agent's trade remark, the picker mined "Low Rider ST" + "2025" from it, and the
 * promo cadence texted him "quick update on the 2025 Low Rider St: $1,000 Customer Cash" — a promo
 * for the bike he's trading AWAY. Same class as the watch-model connective guard (#157): never mine
 * the agent's own words for a customer preference.
 *
 * Layers:
 *   1. Wrapper detection (pure) — isQuotedReactionInboundText recognizes the carrier-generated
 *      reaction formats (incl. the exact production body) and does NOT swallow real customer texts.
 *   2. Source guard — resolveCadencePreferredModelContext's inbound scan skips reaction bodies
 *      (index.ts carries a same-pattern twin of the detector; the filter must call it).
 *
 * Run: npx tsx scripts/cadence_reaction_model_guard_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { isQuotedReactionInboundText } from "../services/api/src/domain/regenerateSelection.ts";

// --- 1) Wrapper detection. ---
// The exact production reaction body (Chris Duchon, +17164184478) must be recognized.
const CHRIS_REACTION =
  "Liked “Hey Chris- Scott here from American H-D. Thanks for stopping in and giving us the chance to get you on the 2025 Road Glide. Let me know how you make out on selling your Low Rider ST and I will keep an eye out on my end”";
assert.equal(
  isQuotedReactionInboundText(CHRIS_REACTION),
  true,
  "the exact production 'Liked “…”' reaction (Chris Duchon) must be detected as a reaction echo"
);

// Other carrier reaction wrappers stay detected.
const REACTIONS: string[] = [
  'Loved "Hey Jason, the 2021 Street Glide Special is available"',
  // ❤️ = U+2764+VS16 and 👍🏼 = U+1F44D+skin-tone: the invisible companions must not break detection
  // (they did before this fix — Extended_Pictographic alone misses VS16/ZWJ/skin-tone modifiers).
  "Reacted ❤️ to “Hi Josh — this is Joe at American Harley-Davidson.”",
  "Reacted 👍🏼 to “Hey Chris- Scott here from American H-D.”",
  'Emphasized "See you Saturday at 10am"',
  'Le encanta "Hi Armando, gracias por visitarnos"'
];
for (const r of REACTIONS) {
  assert.equal(isQuotedReactionInboundText(r), true, `reaction wrapper must be detected: ${r.slice(0, 50)}…`);
}

// Real customer texts must NOT be swallowed — the skip must never hide a genuine model ask.
const REAL_TEXTS: string[] = [
  "I liked the Low Rider ST you showed me, what would payments look like?", // "liked" mid-sentence, no quote wrapper
  "Do you still have the 2025 Road Glide?",
  'My buddy said "get the Street Glide" — thoughts?', // quoted speech inside a real message
  "Loved it! When can I pick it up?" // enthusiasm, not a tapback wrapper
];
for (const t of REAL_TEXTS) {
  assert.equal(isQuotedReactionInboundText(t), false, `real customer text must NOT be treated as a reaction: ${t.slice(0, 50)}…`);
}

// --- 2) Source guard: the cadence model picker skips reaction echoes. ---
const api = fs.readFileSync("services/api/src/index.ts", "utf8");

// The recent-inbound scan inside resolveCadencePreferredModelContext must filter with the detector.
const fnStart = api.indexOf("function resolveCadencePreferredModelContext");
assert.ok(fnStart > 0, "resolveCadencePreferredModelContext must exist");
const fnSlice = api.slice(fnStart, fnStart + 3000);
assert.ok(
  /recentInbounds[\s\S]*?!isQuotedReactionInboundText\(String\(m\?\.body \?\? ""\)\)/.test(fnSlice),
  "resolveCadencePreferredModelContext's inbound scan must skip reaction-echo bodies (never mine the agent's own words)"
);
// The index.ts twin of the detector must exist (the filter calls the local copy).
assert.ok(
  /function isQuotedReactionInboundText\(/.test(api),
  "index.ts must carry the isQuotedReactionInboundText detector the filter calls"
);

console.log(
  `PASS cadence reaction-echo model guard — production body + ${REACTIONS.length} wrappers detected, ${REAL_TEXTS.length} real texts untouched, picker skip wired`
);
