/**
 * Watch-available reply eval (pure). Pins the inventory-watch "your bike is in stock" notification: beyond
 * announcing the unit it must (1) ASK if they're still looking and (2) offer a clean opt-out ("I'll take
 * you off the list"). A "no / all set / found one" reply is handled by the watch-opt-out parser
 * (decideWatchOptOutTurn → pauses the watch; pinned by watch_opt_out:eval), so the promise is backed.
 *
 * COLOR HONESTY (Joe ruling 2026-07-23 — Gregory +17165981862): a same-model different-color arrival
 * still fires, but the text must honestly disclose the color difference, and the composer must NEVER
 * claim the customer was watching for a color he didn't ask for. Gregory's model-only Street Glide
 * watch fired on a Teal Thunder unit as "a ... in Teal Thunder ... you were watching for" — pinned
 * below as the regression fixture.
 *
 * Run: npx tsx scripts/watch_available_reply_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildWatchAvailableReply } from "../services/api/src/domain/agentVoice.ts";

// Compatible color (customer asked for the color the unit arrived in) — the "in <color> you were
// watching for" claim is true and stays.
const r = buildWatchAvailableReply({
  firstName: "Mark",
  bikeLabel: "2025 Harley-Davidson Breakout",
  unitColor: "Billiard Gray",
  watchedColor: "Billiard Gray",
  availability: "new"
});
assert.ok(/Mark/.test(r), "names the customer");
assert.ok(/2025 Harley-Davidson Breakout in Billiard Gray/.test(r), "names the exact unit + color");
assert.ok(/still looking/i.test(r), "ASKS if they're still looking (the new behavior)");
assert.ok(/take you off the list/i.test(r), "offers a clean opt-out");
assert.ok(/just came in/.test(r), "new arrival => 'just came in'");
assert.ok(!/not the/i.test(r), "matching color => no difference disclosure");

// Gregory regression fixture (+17165981862, fired 2026-07-22): MODEL-ONLY watch (no color ever asked),
// Teal Thunder unit arrives. The unit's color is stated as the UNIT's color — never inside the
// "you were watching for" claim.
const gregory = buildWatchAvailableReply({
  firstName: "Gregory",
  bikeLabel: "2026 Harley-Davidson Street Glide",
  unitColor: "Teal Thunder / Vivid Black Chrome Trim",
  watchedColor: null,
  availability: "new"
});
assert.ok(
  !/in Teal Thunder[\s\S]*you were watching for/i.test(gregory),
  "model-only watch must NOT claim the customer was watching for the unit's color (Gregory bug)"
);
assert.ok(/Street Glide you were watching for/.test(gregory), "the watched-for claim covers the MODEL only");
assert.ok(/this one's Teal Thunder/i.test(gregory), "the unit's color still surfaces — as the unit's color");
assert.ok(/still looking/i.test(gregory) && /take you off the list/i.test(gregory), "still asks + opt-out");

// Different-color arrival with a captured asked-about color (Joe's ruled example): fire anyway, but
// honestly disclose — "it's Teal Thunder, not the Dark Billiard Gray you asked about".
const mismatch = buildWatchAvailableReply({
  firstName: "Gregory",
  bikeLabel: "2026 Harley-Davidson Street Glide",
  unitColor: "Teal Thunder",
  watchedColor: "Dark Billiard Gray",
  availability: "new"
});
assert.ok(/this one's Teal Thunder/i.test(mismatch), "different color => names the unit's actual color");
assert.ok(
  /not the Dark Billiard Gray you asked about/i.test(mismatch),
  "different color => honestly names the color the customer DID ask about"
);
assert.ok(
  !/in Teal Thunder[\s\S]*you were watching for/i.test(mismatch),
  "never claims the customer was watching for the arrived color"
);
assert.ok(/still looking/i.test(mismatch) && /take you off the list/i.test(mismatch), "still asks + opt-out");

// Containment counts as compatible: "Black" asked, "Vivid Black" arrived — no false disclosure.
const contained = buildWatchAvailableReply({
  bikeLabel: "Road Glide",
  unitColor: "Vivid Black",
  watchedColor: "Black",
  availability: "in_stock"
});
assert.ok(/in Vivid Black you were watching for/.test(contained), "contained color => compatible phrasing");
assert.ok(!/not the/i.test(contained), "contained color => no difference disclosure");

// Unit color UNKNOWN while the customer asked for a color: no color claim at all — never present
// the WATCH's color as if it were the unit's.
const unknownUnit = buildWatchAvailableReply({
  bikeLabel: "Street Glide",
  unitColor: null,
  watchedColor: "Dark Billiard Gray",
  availability: "in_stock"
});
assert.ok(!/Billiard Gray/i.test(unknownUnit), "unknown unit color => no color claim (not even the watched one)");
assert.ok(/is in stock now/.test(unknownUnit), "in_stock => 'is in stock now'");

// Availability variants.
assert.ok(/is in stock now/.test(buildWatchAvailableReply({ bikeLabel: "Road Glide", availability: "in_stock" })), "in_stock => 'is in stock now'");
assert.ok(/is available again/.test(buildWatchAvailableReply({ bikeLabel: "Iron 1200", availability: "again" })), "again => 'is available again'");

// Nameless lead still clean (no 'undefined'/'null'); still asks + opt-out.
const nn = buildWatchAvailableReply({ bikeLabel: "Sportster", availability: "in_stock" });
assert.ok(!/undefined|null/.test(nn) && /still looking/i.test(nn) && /take you off the list/i.test(nn), "nameless => clean + still asks + opt-out");

// Both watch-fire sites in the engine route through the builder (consistent message), and the opt-out
// parser exists to honor the promise.
const idx = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.ok((idx.match(/buildWatchAvailableReply\(\{/g) ?? []).length >= 2, "both watch-fire sites use the shared builder");
assert.ok(/decideWatchOptOutTurn/.test(idx), "the watch-opt-out path exists to pause the watch on a 'no/all set' reply");
// Color honesty wiring: both sites pass the unit's FEED color and the customer's asked-about color
// separately, and the old conflation (watch color presented as the unit's color) is gone.
assert.ok((idx.match(/unitColor: matchedItem\.color/g) ?? []).length >= 2, "both sites pass the unit's color from the FEED");
assert.ok((idx.match(/watchedColor: matchedWatch\.color/g) ?? []).length >= 2, "both sites pass the customer's asked-about color");
assert.ok(!/matchedItem\.color \?\? matchedWatch\.color/.test(idx), "the watch-color-as-unit-color conflation fallback is gone");

console.log("PASS watch-available reply eval — asks still-looking + opt-out, color honesty (Gregory fixture + mismatch disclosure + containment + unknown-unit), 3 availability states, both sites wired.");
