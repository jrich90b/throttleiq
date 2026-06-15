/**
 * Cadence template voice eval — every SMS cadence template bank must pass the
 * Agent Voice Charter (AGENTS.md) and preserve its outbound state-signal class
 * (scheduling prompt, short-list ask, media offer, preference clarifier).
 *
 * Banks are extracted from services/api/src/index.ts source so this eval pins
 * the real strings; placeholder rendering covers both label states.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import { checkMessage } from "./voice_charter_audit.ts";

const BANKS = [
  "FOLLOW_UP_MESSAGES",
  "TEST_RIDE_FOLLOW_UP_MESSAGES",
  "FOLLOW_UP_VARIANTS_WITH_SLOTS",
  "SELL_FOLLOW_UP_VARIANTS_WITH_SLOTS",
  "FOLLOW_UP_VARIANTS_NO_SLOTS",
  "FOLLOW_UP_VARIANTS_NO_MODEL_NO_SLOTS",
  "ENGAGED_FOLLOW_UP_VARIANTS_WITH_SLOTS",
  "ENGAGED_FOLLOW_UP_VARIANTS_NO_SLOTS",
  "SELL_FOLLOW_UP_MESSAGES",
  "TRADE_IN_FOLLOW_UP_MESSAGES",
  "FRESH_INFO_FOLLOW_UPS",
  "SOFT_EXIT_FOLLOW_UPS",
  "FOLLOW_UP_VARIANTS_WITH_SLOTS_CHALLENGER",
  "FOLLOW_UP_VARIANTS_NO_SLOTS_CHALLENGER"
] as const;

function extractBankStrings(source: string, bankName: string): string[] {
  const start = source.indexOf(`const ${bankName}`);
  assert.ok(start >= 0, `bank ${bankName} must exist in index.ts`);
  const openIdx = source.indexOf("=", start);
  const end = source.indexOf("\n};", openIdx) >= 0 ? source.indexOf("\n};", openIdx) : Infinity;
  const endArr = source.indexOf("\n];", openIdx) >= 0 ? source.indexOf("\n];", openIdx) : Infinity;
  const block = source.slice(openIdx, Math.min(end, endArr));
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    const s = m[1];
    if (s.length >= 12) out.push(s);
  }
  assert.ok(out.length > 0, `bank ${bankName} must contain template strings`);
  return out;
}

function renderTemplate(template: string, withLabel: boolean): string {
  const ctx: Record<string, string> = {
    name: "Sam",
    agent: "Joe",
    labelClause: withLabel ? " about the 2024 Road Glide" : "",
    onLabelClause: withLabel ? " on the 2024 Road Glide" : "",
    forLabelClause: withLabel ? " for the 2024 Road Glide" : "",
    label: withLabel ? " the 2024 Road Glide" : " a model",
    extraLine: "",
    offersLine: "",
    model: "Road Glide",
    modelYear: "2024 Road Glide",
    trade: "your Street Bob",
    bike: "your 2016 Street Glide",
    a: "Saturday 10am",
    b: "Sunday 1pm"
  };
  let out = template;
  for (const [key, value] of Object.entries(ctx)) {
    out = out.replace(new RegExp(`\\{${key}\\}`, "g"), value);
  }
  return out.replace(/\s+/g, " ").trim();
}

// Copies of the outbound state-signal detectors in services/api (kept in sync
// by the source assertions at the bottom).
const SHORTLIST_RE =
  /\b(want me to send|i can send|happy to send)\b[\s\S]{0,100}\b(short list|couple models?|list of bikes?|options that fit)\b/i;
const SCHEDULING_RE =
  /(what day|what time|when.*available|schedule|appointment|come in|stop by|stop in|book|reserve|test ride|demo ride|which works best)/i;
const MEDIA_RE = /\b(photo|photos|pic|pics|picture|pictures|walkaround|walk around|video|clip)\b/;

const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");

let checked = 0;
for (const bank of BANKS) {
  for (const template of extractBankStrings(apiSource, bank)) {
    assert.ok(!template.includes("—"), `[${bank}] no em-dashes in cadence templates: "${template}"`);
    for (const withLabel of [true, false]) {
      const rendered = renderTemplate(template, withLabel);
      assert.ok(!rendered.includes("{"), `[${bank}] unrendered placeholder in: "${rendered}"`);
      assert.ok(!/\bthe the\b/i.test(rendered), `[${bank}] doubled article in: "${rendered}"`);
      assert.ok(
        !/\s(?:on|for)\s+(?:and|so)\s|\s(?:on|for)[?.!,]|\b(?:on|for) about\b/.test(rendered),
        `[${bank}] dangling clause grammar in: "${rendered}"`
      );
      const violations = checkMessage(rendered, {
        firstOutbound: false,
        smsLike: true,
        staffHasSent: false
      });
      assert.deepEqual(
        violations,
        [],
        `[${bank}] charter violation(s) ${JSON.stringify(violations)} in: "${rendered}"`
      );
      checked++;
    }
  }
}

// Signal-class preservation: these specific templates drive dialog state and
// must keep their detector class after any rewording.
const followUps = extractBankStrings(apiSource, "FOLLOW_UP_MESSAGES");
assert.ok(SCHEDULING_RE.test(renderTemplate(followUps[4], true)), "FOLLOW_UP_MESSAGES[4] must stay a scheduling prompt");
assert.ok(SHORTLIST_RE.test(renderTemplate(followUps[6], false)), "FOLLOW_UP_MESSAGES[6] must keep the short-list signal");
assert.ok(MEDIA_RE.test(renderTemplate(followUps[1], true).toLowerCase()), "FOLLOW_UP_MESSAGES[1] must stay a media offer");

for (const t of extractBankStrings(apiSource, "TEST_RIDE_FOLLOW_UP_MESSAGES")) {
  assert.ok(SCHEDULING_RE.test(renderTemplate(t, true)), `test-ride template must stay a scheduling prompt: "${t}"`);
}
for (const t of extractBankStrings(apiSource, "FOLLOW_UP_VARIANTS_WITH_SLOTS")) {
  assert.ok(SCHEDULING_RE.test(renderTemplate(t, true)), `slot variant must stay a scheduling prompt: "${t}"`);
}

const noSlots = extractBankStrings(apiSource, "FOLLOW_UP_VARIANTS_NO_SLOTS");
assert.ok(
  noSlots.some(t => SHORTLIST_RE.test(renderTemplate(t, false))),
  "FOLLOW_UP_VARIANTS_NO_SLOTS must keep at least one short-list signal template"
);
assert.ok(
  noSlots.some(t => MEDIA_RE.test(renderTemplate(t, true).toLowerCase())),
  "FOLLOW_UP_VARIANTS_NO_SLOTS must keep at least one media-offer template"
);
const noModel = extractBankStrings(apiSource, "FOLLOW_UP_VARIANTS_NO_MODEL_NO_SLOTS");
assert.ok(
  noModel.some(t => SHORTLIST_RE.test(renderTemplate(t, false))),
  "FOLLOW_UP_VARIANTS_NO_MODEL_NO_SLOTS must keep at least one short-list signal template"
);

// Early-promotion discovery message keeps its short-list + clarifier signals.
assert.match(
  apiSource,
  /happy to send a short list\. What style are you leaning toward/,
  "early-promotion discovery message must keep short-list + leaning-toward signals"
);

// Detector copies above must match the real implementations.
assert.match(
  apiSource,
  /function draftHasSchedulingPrompt\(text: string\): boolean \{\s*return \/\(what day\|what time\|when\.\*available\|schedule\|appointment\|come in\|stop by\|stop in\|book\|reserve\|test ride\|demo ride\|which works best\)\/i/,
  "draftHasSchedulingPrompt regex changed; update the copy in this eval"
);
const storeSource = await fs.readFile(
  path.resolve("services/api/src/domain/conversationStore.ts"),
  "utf8"
);
assert.ok(
  storeSource.includes(
    "/\\b(want me to send|i can send|happy to send)\\b[\\s\\S]{0,100}\\b(short list|couple models?|list of bikes?|options that fit)\\b/i"
  ),
  "outboundAsksForShortList regex changed; update the copy in this eval"
);

console.log(`PASS cadence template voice eval (${checked} rendered template checks)`);
