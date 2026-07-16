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
const { applyVoiceDurableFacts, buildVoiceFactsCadenceLine, fillLeadVehicleFromVoiceFacts } = await import(
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

// Preference that IS the model we already offer must NOT produce a "watching for" line —
// it contradicts the in-stock offer in the cadence body (Alexander Roehre, Ref 11233:
// phone-mined "Street Glide" preference on a Street Glide lead).
const offeredModelConv: any = { lead: { vehicle: { model: "Street Glide" } } };
applyVoiceDurableFacts(
  offeredModelConv,
  { quotedUnit: "", quotedPrice: 0, otdPrice: 0, budgetMax: 0, wantsPreowned: false, preferences: ["Street Glide"], blockers: [], confidence: 0.9 },
  { nowIso }
);
assert.equal(
  buildVoiceFactsCadenceLine(offeredModelConv, now),
  null,
  "no 'watching for' line for the model we already offer (Alexander Roehre 11233)"
);

// A genuinely different model the customer mentioned on the call still surfaces a watch line.
const novelPrefConv: any = { lead: { vehicle: { model: "Street Glide" } } };
applyVoiceDurableFacts(
  novelPrefConv,
  { quotedUnit: "", quotedPrice: 0, otdPrice: 0, budgetMax: 0, wantsPreowned: false, preferences: ["Road Glide"], blockers: [], confidence: 0.9 },
  { nowIso }
);
assert.equal(
  buildVoiceFactsCadenceLine(novelPrefConv, now),
  "Still watching for something with Road Glide for you.",
  "a different model still surfaces a watch line"
);

// Mixed: the offered model is dropped, the novel one is kept.
const mixedPrefConv: any = { lead: { vehicle: { description: "Harley-Davidson Street Glide" } } };
applyVoiceDurableFacts(
  mixedPrefConv,
  { quotedUnit: "", quotedPrice: 0, otdPrice: 0, budgetMax: 0, wantsPreowned: false, preferences: ["Street Glide", "Road Glide"], blockers: [], confidence: 0.9 },
  { nowIso }
);
assert.equal(
  buildVoiceFactsCadenceLine(mixedPrefConv, now),
  "Still watching for something with Road Glide for you.",
  "offered model filtered, novel preference kept"
);

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

// ── Fill-only-when-empty motorcycle-of-interest write-back (Joe, 2026-07-15) ──
const baseFacts = {
  quotedUnit: "",
  discussedUnit: "",
  quotedPrice: 0,
  otdPrice: 0,
  budgetMax: 0,
  wantsPreowned: false,
  preferences: [],
  blockers: [],
  confidence: 0.9
};

// 1) Empty field + discussed unit => filled (year split out).
{
  const c: any = { lead: {} };
  assert.equal(
    fillLeadVehicleFromVoiceFacts(c, { ...baseFacts, discussedUnit: "2021 Street Glide Special" }),
    true,
    "empty motorcycle-of-interest must fill from the discussed unit"
  );
  assert.equal(c.lead.vehicle.model, "Street Glide Special");
  assert.equal(c.lead.vehicle.year, "2021");
}

// 2) Placeholder ("Harley-Davidson Other" / "Full Line") counts as empty => filled.
{
  const c: any = { lead: { vehicle: { model: "Harley-Davidson Other" } } };
  assert.equal(
    fillLeadVehicleFromVoiceFacts(c, { ...baseFacts, discussedUnit: "Fat Bob 114" }),
    true,
    "a placeholder model must be treated as unknown and filled"
  );
  assert.equal(c.lead.vehicle.model, "Fat Bob 114");
}

// 3) A REAL model is never overwritten (fill-only; over-attachment is the worse failure mode).
{
  const c: any = { lead: { vehicle: { model: "Road Glide Limited" } } };
  assert.equal(
    fillLeadVehicleFromVoiceFacts(c, { ...baseFacts, discussedUnit: "Street Glide" }),
    false,
    "a real motorcycle-of-interest must never be overwritten by a call"
  );
  assert.equal(c.lead.vehicle.model, "Road Glide Limited");
}

// 4) No unit discussed (sell/trade-only or service call) => no-op.
{
  const c: any = { lead: {} };
  assert.equal(fillLeadVehicleFromVoiceFacts(c, { ...baseFacts }), false, "no discussed unit => no write");
  assert.equal(c.lead.vehicle, undefined);
}

// 5) Low confidence => no-op.
{
  const c: any = { lead: {} };
  assert.equal(
    fillLeadVehicleFromVoiceFacts(c, { ...baseFacts, discussedUnit: "Street Glide", confidence: 0.4 }),
    false,
    "below the confidence floor => no write"
  );
}

// 6) quotedUnit works as the fallback source when discussedUnit is empty.
{
  const c: any = { lead: {} };
  assert.equal(
    fillLeadVehicleFromVoiceFacts(c, { ...baseFacts, quotedUnit: "2017 Breakout" }),
    true,
    "a quoted unit fills when no discussed unit is present"
  );
  assert.equal(c.lead.vehicle.model, "Breakout");
  assert.equal(c.lead.vehicle.year, "2017");
}

// Wiring pin: the live voice ingestion site must call the fill helper.
assert.match(
  apiSource,
  /fillLeadVehicleFromVoiceFacts\(conv, voiceFactsParse\)/,
  "the live voice-summary ingestion site must attempt the motorcycle-of-interest fill"
);
// Parser pin: the discussed_unit slot must exist with the trade/sell exclusion rule.
assert.match(llmSource, /discussed_unit/, "voice facts schema must carry discussed_unit");
assert.match(
  llmSource,
  /NEVER the bike they own, are trading in, or want to sell/,
  "discussed_unit prompt must exclude the trade/sell bike"
);

console.log("PASS voice cadence facts eval");
