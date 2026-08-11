/**
 * outbound_echo_guard:eval — pins isEchoedInboundOpening (leadInGuards.ts) + its wiring into the
 * self-heal loop + the composer prompt rule.
 *
 * Recurring miss (Joe, 2026-07-27): the reply LLM opens by PARROTING the customer's words back.
 * Real case — customer "Might be able to swing tomorrow after work…" → draft "might be able to swing
 * tomorrow after work can work. Just give me a heads up…". It reads robotic + starts lowercase. The
 * guard flags a reply whose OPENING is a >=4-word verbatim run of the customer's message, so the
 * self-heal loop re-drafts it in the agent's own words. It must NOT flag natural 2-3 word reuse.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { isEchoedInboundOpening } from "../services/api/src/domain/leadInGuards.ts";
import { deterministicHealTriggers, stillTriggered } from "../services/api/src/domain/selfHealSteering.ts";

// ---- THE REPORTED MISS: an 8-word verbatim echo at the opening → flagged. ----
assert.equal(
  isEchoedInboundOpening(
    "might be able to swing tomorrow after work can work. Just give me a heads up when you know the exact time so I can have everything lined up.",
    "Might be able to swing tomorrow after work…"
  ),
  true,
  "the reported miss: draft parrots the customer's opening sentence → echo"
);

// Punctuation / case / trailing ellipsis do not hide the echo.
assert.equal(
  isEchoedInboundOpening("MIGHT BE ABLE TO SWING tomorrow", "might be able to swing tomorrow after work"),
  true,
  "case-insensitive echo still flagged"
);

// A one-throwaway-word lead before the echo still counts (opening within the first word or two).
assert.equal(
  isEchoedInboundOpening("Sure — can you send me the stock number and VIN please", "can you send me the stock number"),
  true,
  "an echo beginning at reply word 2 (after a short lead word) is flagged"
);

// ---- NATURAL, NON-ECHO acknowledgements: NOT flagged. ----
assert.equal(
  isEchoedInboundOpening(
    "Tomorrow after work works great — just shoot me a heads up when you know the exact time and I'll have everything lined up for you.",
    "Might be able to swing tomorrow after work…"
  ),
  false,
  "the CLEAN rewrite (2-3 word reuse) is NOT an echo"
);
assert.equal(
  isEchoedInboundOpening("Sounds good, see you then!", "I can swing by tomorrow after work"),
  false,
  "a natural ack that shares no long run is not an echo"
);
assert.equal(
  isEchoedInboundOpening("Yes, we have the Road Glide in stock.", "do you have the Road Glide in stock"),
  false,
  "a short shared phrase mid-reply (not a 4+ run at the opening) is not an echo"
);
// Guard the boundaries: exactly 3 shared opening words is NOT enough; 4+ is.
assert.equal(isEchoedInboundOpening("tomorrow after work works for me", "swing by tomorrow after work sometime"), false, "3-word opening overlap ('tomorrow after work') is natural, not an echo");
assert.equal(isEchoedInboundOpening("swing by tomorrow after work today", "I can swing by tomorrow after work"), true, "5-word opening overlap is an echo");
// Empty / tiny inputs never flag.
assert.equal(isEchoedInboundOpening("", "might be able to swing tomorrow"), false, "empty reply → not an echo");
assert.equal(isEchoedInboundOpening("ok sounds good", ""), false, "empty inbound → not an echo");
assert.equal(isEchoedInboundOpening("see you then", "yes"), false, "sub-threshold inbound → not an echo");

// ---- WIRING: the composer PROMPT forbids parroting, and the self-heal loop uses the detector. ----
const draftSrc = fs.readFileSync(path.resolve("services/api/src/domain/llmDraft.ts"), "utf8");
assert.ok(
  /Never OPEN by repeating the customer's own words back/i.test(draftSrc),
  "the composer prompt forbids opening by repeating the customer's words"
);
// The trigger moved into selfHealSteering.deterministicHealTriggers (2026-08-11), where it now sits
// beside its sibling "you already asked me that". This eval FOLLOWED it rather than being loosened:
// the checks below EXECUTE the real functions, which is stronger than the source pins they replace,
// plus one call-site check that behaviour cannot prove from the outside.
const ECHO_DRAFT = "might be able to swing tomorrow after work can work. Just give me a heads up.";
const ECHO_INBOUND = "Might be able to swing tomorrow after work…";
const triggers = deterministicHealTriggers({ draft: ECHO_DRAFT, inbound: ECHO_INBOUND, history: [] });
assert.equal(triggers.echoesInbound, true, "an echoed opening fires the deterministic trigger");
assert.equal(triggers.any, true, "…so it bypasses the 'draft is good' short-circuit and forces a re-draft");
assert.equal(
  stillTriggered(triggers, { draft: ECHO_DRAFT, inbound: ECHO_INBOUND, history: [] }),
  true,
  "a re-draft that still echoes is NOT accepted as healed"
);
assert.equal(
  stillTriggered(triggers, { draft: "Tomorrow after work works great — I'll have it ready.", inbound: ECHO_INBOUND, history: [] }),
  false,
  "a re-draft in the agent's own words IS a heal"
);
const clean = deterministicHealTriggers({ draft: "Sounds good, I'll have it ready.", inbound: ECHO_INBOUND, history: [] });
assert.equal(clean.echoesInbound, false, "an ordinary reply does not trigger");

// The call sites themselves — `.includes()`, never a regex with an escaped paren (eval_source_pin_ratchet).
assert.ok(draftSrc.includes("deterministicHealTriggers({ draft: original, inbound, history: args.ctx.history })"), "self-heal computes the triggers on the original draft");
assert.ok(draftSrc.includes("!triggers.any &&"), "the triggers bypass the 'draft is good' short-circuit");
assert.ok(draftSrc.includes("stillTriggered(triggers, { draft: steered, inbound, history: args.ctx.history })"), "and the re-draft is re-checked before it counts as healed");

console.log("PASS outbound_echo_guard — parrot detector + composer prompt rule + self-heal trigger wiring");
