/**
 * ADF form re-submission eval (pure, no LLM).
 *
 * Pins the Jerill White class (+14354061493, open-critic repeated_generic_reply, Joe-approved
 * 2026-07-02): the same lead re-submitting the SAME structured web form (only the CRM Ref
 * changes) must not restart the first-touch script — three submissions in three minutes drew
 * three near-identical "I got your inquiry" drafts. Detection is structured-field comparison
 * (Source/Vehicle/Stock/VIN/normalized Inquiry), never free-text comprehension; ANY field
 * difference runs the full pipeline (fail toward answering).
 *
 * Run: npx tsx scripts/adf_resubmission_eval.ts
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";

import {
  buildAdfResubmissionAck,
  detectAdfFormResubmission,
  extractAdfStructuredFields
} from "../services/api/src/domain/adfResubmission.ts";

let n = 0;
const eq = (a: unknown, b: unknown, m: string) => {
  assert.deepEqual(a, b, m);
  n++;
};

const body = (ref: number, opts?: { vehicle?: string; inquiry?: string }) =>
  `WEB LEAD (ADF)\nSource: Room58 - Standard\nRef: ${ref}\nName: Jerill White\nEmail: jeriol@msn.com\nPhone: 4354061493\nYear: 2026\nVehicle: ${opts?.vehicle ?? "Harley-Davidson Full Line"}\n\nInquiry:\n${opts?.inquiry ?? ""}`;

const NOW = Date.parse("2026-07-01T00:21:30.000Z");
const mkMessages = () => [
  { direction: "in", provider: "sendgrid_adf", body: body(11568), at: "2026-07-01T00:18:00.000Z" },
  { direction: "out", provider: "draft_ai", body: "Hey Jerill, thanks — I got your inquiry.", at: "2026-07-01T00:18:30.000Z" },
  { direction: "in", provider: "sendgrid_adf", body: body(11569), at: "2026-07-01T00:20:00.000Z" }
];

// --- 1) Field extraction: Ref is volatile and excluded. ---
{
  const a = extractAdfStructuredFields(body(11568));
  const b = extractAdfStructuredFields(body(99999));
  eq(a, b, "structured fields ignore the volatile Ref number");
  eq(extractAdfStructuredFields("Just a plain SMS"), null, "non-ADF text extracts nothing");
}

// --- 2) The Jerill replay: identical form again => resubmission. ---
{
  const r = detectAdfFormResubmission({ messages: mkMessages(), newBody: body(11570), nowMs: NOW });
  eq(r.resubmission, true, "identical form re-submitted => resubmission");
  eq(r.priorCount >= 1, true, "prior identical submissions counted");
  eq(r.hoursSinceLastOutbound != null && r.hoursSinceLastOutbound < 24, true, "burst carries a fresh last-outbound age");
}

// --- 3) Fail-toward-answering: any real difference is NOT a resubmission. ---
{
  const changedInquiry = detectAdfFormResubmission({
    messages: mkMessages(),
    newBody: body(11570, { inquiry: "Do you have the Low Rider ST in stock?" }),
    nowMs: NOW
  });
  eq(changedInquiry.resubmission, false, "a NEW inquiry text runs the full pipeline");
  const changedVehicle = detectAdfFormResubmission({
    messages: mkMessages(),
    newBody: body(11570, { vehicle: "Harley-Davidson Low Rider ST" }),
    nowMs: NOW
  });
  eq(changedVehicle.resubmission, false, "a different vehicle runs the full pipeline");
  const noPriorOutbound = detectAdfFormResubmission({
    messages: [{ direction: "in", provider: "sendgrid_adf", body: body(11568), at: "2026-07-01T00:18:00.000Z" }],
    newBody: body(11569),
    nowMs: NOW
  });
  eq(noPriorOutbound.resubmission, false, "no ack ever sent for the prior form => not a resubmission (full pipeline)");
  const outsideWindow = detectAdfFormResubmission({
    messages: [
      { direction: "in", provider: "sendgrid_adf", body: body(11000), at: "2026-05-01T00:00:00.000Z" },
      { direction: "out", provider: "twilio", body: "ack", at: "2026-05-01T00:10:00.000Z" }
    ],
    newBody: body(11570),
    nowMs: NOW
  });
  eq(outsideWindow.resubmission, false, "a months-old prior submission is outside the window");
}

// --- 4) Ack safety. ---
{
  const ack = buildAdfResubmissionAck("Jerill", "Alexandra", "American Harley-Davidson");
  assert.ok(/Jerill/.test(ack) && /Alexandra/.test(ack) && /American Harley-Davidson/.test(ack), "ack identifies lead + agent + dealer");
  n++;
  for (const banned of [/\b(still available|in stock)\b/i, /\bwhat day|set up a time|schedule\b/i, /\bgood luck\b/i]) {
    assert.ok(!banned.test(ack), `resubmission ack must not contain ${banned}`);
    n++;
  }
}

// --- 5) Wiring: detected before append, returned before discardPendingDrafts (burst keeps the
//        original pending first-touch draft), todo created, ack only when last outbound >= 24h. ---
const route = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");
const seam = route.slice(route.indexOf("const adfResubmission = detectAdfFormResubmission"), route.indexOf('note: "adf_resubmission"') + 200);
assert.ok(seam.length > 400, "resubmission seam present in the ADF flow");
assert.ok(seam.indexOf("appendInbound(conv, event)") < seam.indexOf("if (adfResubmission.resubmission)"), "inbound recorded before the guard returns");
assert.ok(!seam.slice(0, seam.indexOf("if (adfResubmission.resubmission)")).includes("discardPendingDrafts"), "guard runs BEFORE discardPendingDrafts (burst keeps the pending first-touch)");
assert.ok(/hoursSinceLastOutbound == null \|\| adfResubmission\.hoursSinceLastOutbound >= 24/.test(seam), "ack drafts only when the previous outbound is >=24h old");
n += 4;

console.log(`PASS adf resubmission eval (${n} assertions)`);
