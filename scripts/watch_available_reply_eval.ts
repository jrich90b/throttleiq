/**
 * Watch-available reply eval (pure). Pins the inventory-watch "your bike is in stock" notification: beyond
 * announcing the unit it must (1) ASK if they're still looking and (2) offer a clean opt-out ("I'll take
 * you off the list"). A "no / all set / found one" reply is handled by the watch-opt-out parser
 * (decideWatchOptOutTurn → pauses the watch; pinned by watch_opt_out:eval), so the promise is backed.
 *
 * Run: npx tsx scripts/watch_available_reply_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildWatchAvailableReply } from "../services/api/src/domain/agentVoice.ts";

const r = buildWatchAvailableReply({ firstName: "Mark", bikeLabel: "2025 Harley-Davidson Breakout", colorText: " in Billiard Gray", availability: "new" });
assert.ok(/Mark/.test(r), "names the customer");
assert.ok(/2025 Harley-Davidson Breakout in Billiard Gray/.test(r), "names the exact unit + color");
assert.ok(/still looking/i.test(r), "ASKS if they're still looking (the new behavior)");
assert.ok(/take you off the list/i.test(r), "offers a clean opt-out");
assert.ok(/just came in/.test(r), "new arrival => 'just came in'");

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

console.log("PASS watch-available reply eval — asks still-looking + offers opt-out, 3 availability states, both sites + opt-out backed.");
