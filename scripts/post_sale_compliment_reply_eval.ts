/**
 * A CUSTOMER WHO ALREADY BOUGHT THE BIKE IS NOT SHOPPING FOR IT (2026-08-13).
 *
 * The compliment-only reply used to be one fixed string:
 *   "Glad you like it! I can send more photos or a walkaround video. Anything specific you want to
 *    see?"
 *
 * MEASURED against the live store (852 conversations): that template has fired exactly TWICE, and
 * BOTH times the customer had already taken delivery of the bike they were complimenting.
 *  - +17169570162 tapped a ❤️ on his post-sale thank-you the day after buying a Road Glide Special
 *    and was AUTO-SENT the offer of photos and a walkaround video of the bike in his garage.
 *  - +17169086716 wrote "Enjoyed the ride home.. hoping to put some miles on the Deadwood nxt week";
 *    Joe deleted the offer by hand, sent "Glad you like it!", and filed the report — "should have
 *    not asked follow up questions. if you look the bike is already sold."
 *
 * So this is not a fallback that occasionally lands wrong: its entire measured population is
 * owners. Charter C1.7 already rules that `alreadyPurchased` is a structural exception decided in
 * CODE, and that the rule "binds our deterministic TEMPLATES exactly as it binds the LLM composer".
 * This eval pins that the template now asks the SAME referee the composer asks
 * (`advanceEveryReplySuppressed`), in BOTH paths, and that the warmth survives the suppression.
 *
 * The fail direction is safe by construction: suppression only ever REMOVES a push, so a false
 * positive costs a shopping offer and a false negative is the bug we are fixing.
 *
 * Run: npx tsx scripts/post_sale_compliment_reply_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkMessage } from "./voice_charter_audit.ts";

const G = await import("../services/api/src/domain/workflowRegressionGuards.ts");

let n = 0;
const ok = (cond: boolean, msg: string) => {
  assert.equal(cond, true, msg);
  n++;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");

const PUSH_WORDS = ["photos", "walkaround", "want to see"];
const WARMTH = "Glad you like it!";

// ---------------------------------------------------------------------------
// 1) BEHAVIOUR — an ordinary shopper still gets the offer and still gets asked.
// ---------------------------------------------------------------------------
const open = G.buildComplimentOnlyReply();
ok(open.startsWith(WARMTH), `an unsuppressed compliment reply still opens warm: ${open}`);
ok(open.includes("?"), `charter C1.7: an unsuppressed compliment reply still advances: ${open}`);
for (const word of PUSH_WORDS) {
  ok(open.includes(word), `an unsuppressed compliment reply still offers "${word}": ${open}`);
}
ok(
  G.buildComplimentOnlyReply({ suppression: {} }) === open,
  "an empty suppression object is the same as no suppression at all"
);

// ---------------------------------------------------------------------------
// 2) THE FIX — every C1.7 exception drops the push and keeps the warmth.
//    The exceptions are NOT re-declared here: they come from the shared referee, so a future
//    sixth exception is covered the day it is added rather than the day someone remembers this
//    file. `alreadyPurchased` is the reported one; the others ride the same code path.
// ---------------------------------------------------------------------------
const SUPPRESSED: { label: string; suppression: Record<string, unknown> }[] = [
  { label: "alreadyPurchased", suppression: { alreadyPurchased: true } },
  { label: "needsEmpathy", suppression: { needsEmpathy: true } },
  { label: "dispositionClosing", suppression: { dispositionClosing: true } },
  { label: "booked appointment", suppression: { appointment: { status: "booked" } } },
  { label: "confirmed appointment", suppression: { appointment: { status: "confirmed" } } },
  {
    label: "sold AND booked",
    suppression: { alreadyPurchased: true, appointment: { status: "confirmed" } }
  }
];
for (const c of SUPPRESSED) {
  const reply = G.buildComplimentOnlyReply({ suppression: c.suppression });
  ok(reply === WARMTH, `C1.7 suppression (${c.label}) leaves the warm ack alone: ${reply}`);
  ok(!reply.includes("?"), `C1.7 suppression (${c.label}) must not push a question: ${reply}`);
  for (const word of PUSH_WORDS) {
    ok(!reply.includes(word), `C1.7 suppression (${c.label}) drops "${word}": ${reply}`);
  }
}

// The exact turn Joe reported: an owner two days past delivery, warm about the ride home.
ok(
  G.buildComplimentOnlyReply({
    suppression: { appointment: null, alreadyPurchased: true }
  }) === WARMTH,
  "+17169086716 (FLHD Deadwood, sold 2026-08-11) gets the reply Joe sent by hand, not the offer"
);

// ---------------------------------------------------------------------------
// 3) OUR OWN CHARTER — both variants are copy we wrote, so they answer to it.
// ---------------------------------------------------------------------------
const TEMPLATE_SOURCED = new Set(["banned_phrase", "doubled_article", "bare_check_in", "dropped_verb"]);
for (const [label, text] of [
  ["unsuppressed", open],
  ["suppressed", WARMTH]
] as const) {
  const hits = checkMessage(text, { firstOutbound: false, smsLike: true, staffHasSent: false }).filter(
    v => TEMPLATE_SOURCED.has(v.check)
  );
  ok(hits.length === 0, `the ${label} compliment reply is charter-clean: ${JSON.stringify(hits)}`);
}

// ---------------------------------------------------------------------------
// 4) WIRING — the ratchet cannot prove this, so COUNT the call sites.
//    Both the live Twilio lane and the regenerate lane must hand the referee the same two facts.
//    An EXPECTED COUNT, not a "there exists one": unwiring a single path is the exact regression
//    this guards, and that is invisible to any presence check.
// ---------------------------------------------------------------------------
const indexSrc = fs.readFileSync(path.join(repo, "services/api/src/index.ts"), "utf8");
const CALL = "buildComplimentOnlyReply";
const callSites = indexSrc.split(CALL).length - 1;
ok(
  callSites === 3,
  `index.ts calls ${CALL} on both paths plus its import (expected 3 mentions, found ${callSites})`
);
// The WHOLE call, not the argument line on its own: `suppression: { appointment: conv.appointment,
// alreadyPurchased: !!conv.sale }` already appears elsewhere in index.ts (the prequal stage ask),
// so counting that string alone let an unwired call site through when this was sabotage-tested.
const WIRED_CALL = `${CALL}({
      suppression: { appointment: conv.appointment, alreadyPurchased: !!conv.sale }
    })`;
const wired = indexSrc.split(WIRED_CALL).length - 1;
ok(
  wired === 2,
  `both compliment call sites — live Twilio AND regenerate — pass the sale + appointment facts to the referee (expected 2, found ${wired})`
);
ok(
  !indexSrc.includes("I can send more photos or a walkaround video. Anything specific"),
  "the compliment copy lives in ONE builder — index.ts must not carry a second hardcoded copy"
);

const guardsSrc = fs.readFileSync(
  path.join(repo, "services/api/src/domain/workflowRegressionGuards.ts"),
  "utf8"
);
ok(
  guardsSrc.includes("advanceEveryReplySuppressed(args?.suppression ?? {})"),
  "the builder asks the SHARED C1.7 referee rather than re-testing conv.sale on its own"
);

console.log(`post_sale_compliment_reply_eval: PASS (${n} assertions)`);
