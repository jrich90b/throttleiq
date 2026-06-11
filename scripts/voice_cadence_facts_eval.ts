/**
 * Voice-aware cadence facts eval. Fixture: David Gaeddert +17165872648 —
 * phone quote $14,995 / $16,534 OTD for the 2017 Breakout and a stated
 * pre-owned ~$15k budget never reached the cadence copy.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import { checkMessage } from "./voice_charter_audit.ts";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "eval-no-live-key";
const { applyVoiceDurableFacts, buildVoiceFactsCadenceLine } = await import(
  "../services/api/src/domain/voiceCadenceFacts.ts"
);

const nowIso = "2026-06-11T16:00:00.000Z";
const now = new Date(nowIso);

// Quote facts render the full quote line, deterministically.
const conv: any = {};
assert.equal(
  applyVoiceDurableFacts(
    conv,
    {
      quotedUnit: "pre-owned Breakout",
      quotedPrice: 14995,
      otdPrice: 16534,
      budgetMax: 0,
      wantsPreowned: true,
      preferences: [],
      blockers: ["needs new plates"],
      confidence: 0.95
    },
    { nowIso }
  ),
  true
);
const quoteLine = buildVoiceFactsCadenceLine(conv, now);
assert.equal(
  quoteLine,
  "That pre-owned Breakout we went over on the phone is still here at $14,995, about $16,534 out the door."
);
assert.deepEqual(
  checkMessage(quoteLine!, { firstOutbound: false, smsLike: true, staffHasSent: false }),
  [],
  "quote line must be charter-clean"
);

// A later call without a quote must not erase the earlier quote.
assert.equal(
  applyVoiceDurableFacts(
    conv,
    {
      quotedUnit: "",
      quotedPrice: 0,
      otdPrice: 0,
      budgetMax: 15000,
      wantsPreowned: true,
      preferences: ["long stretch rear tire"],
      blockers: [],
      confidence: 0.9
    },
    { nowIso }
  ),
  true
);
assert.equal(conv.voiceFacts.quotedPrice, 14995, "earlier quote preserved");
assert.equal(conv.voiceFacts.budgetMax, 15000, "budget merged");
assert.match(buildVoiceFactsCadenceLine(conv, now)!, /\$14,995/, "quote still wins the line");

// Budget-only facts render the watch line.
const budgetConv: any = {};
applyVoiceDurableFacts(
  budgetConv,
  {
    quotedUnit: "",
    quotedPrice: 0,
    otdPrice: 0,
    budgetMax: 15000,
    wantsPreowned: true,
    preferences: [],
    blockers: [],
    confidence: 0.92
  },
  { nowIso }
);
assert.equal(
  buildVoiceFactsCadenceLine(budgetConv, now),
  "Still keeping an eye out for pre-owned options around $15,000 for you."
);

// Low confidence and empty parses apply nothing.
const emptyConv: any = {};
assert.equal(
  applyVoiceDurableFacts(
    emptyConv,
    { quotedUnit: "2017 Breakout", quotedPrice: 14995, otdPrice: 0, budgetMax: 0, wantsPreowned: false, preferences: [], blockers: [], confidence: 0.4 },
    { nowIso }
  ),
  false,
  "low-confidence parses are dropped"
);
assert.equal(buildVoiceFactsCadenceLine(emptyConv, now), null);

// Post-sale conversations never render quote lines.
const soldConv: any = {
  closedReason: "sold",
  voiceFacts: { quotedUnit: "Breakout", quotedPrice: 14995, otdPrice: null, budgetMax: null, wantsPreowned: null, preferences: [], blockers: [], updatedAt: nowIso }
};
assert.equal(buildVoiceFactsCadenceLine(soldConv, now), null, "sold customers never get quote lines");
const postSaleConv: any = {
  followUpCadence: { kind: "post_sale" },
  voiceFacts: { quotedUnit: "Breakout", quotedPrice: 14995, otdPrice: null, budgetMax: null, wantsPreowned: null, preferences: [], blockers: [], updatedAt: nowIso }
};
assert.equal(buildVoiceFactsCadenceLine(postSaleConv, now), null, "post-sale cadences never get quote lines");

// Stale facts (45+ days) stop rendering.
const staleConv: any = {
  voiceFacts: { quotedUnit: "Breakout", quotedPrice: 14995, otdPrice: null, budgetMax: null, wantsPreowned: null, preferences: [], blockers: [], updatedAt: "2026-04-01T00:00:00.000Z" }
};
assert.equal(buildVoiceFactsCadenceLine(staleConv, now), null, "stale facts excluded");

// Wiring pins: ingestion + all three cadence append sites + parser fixture.
const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
assert.match(apiSource, /parseVoiceDurableFactsWithLLM\(\{ summary: summaryText/, "voice summary ingestion must extract durable facts");
assert.equal(
  (apiSource.match(/buildVoiceFactsCadenceLine\(conv, now\)/g) ?? []).length,
  3,
  "all three cadence personalization sites must append the voice facts line"
);
const llmSource = await fs.readFile(path.resolve("services/api/src/domain/llmDraft.ts"), "utf8");
assert.match(llmSource, /was quoted \$14,995 asking price/, "parser few-shots pin the production fixture");

console.log("PASS voice cadence facts eval");
