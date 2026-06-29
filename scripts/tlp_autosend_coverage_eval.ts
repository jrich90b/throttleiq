/**
 * TLP auto-send coverage eval (2026-06-29).
 *
 * Root cause (crm_log_stale): queueTlpLog/maybeLogTlp lived ONLY inside the manual POST
 * /conversations/:id/send handler, so the AUTO-SEND paths (post-sale cadence, appointment
 * confirmations, webhook autopilot) transmitted to the customer but never logged to TLP — a silent
 * CRM coverage gap (48 live convs, 0 failures recorded).
 *
 * This pins the PREVENTION wiring:
 *  - a module-level, extracted logTlpForConversation (so multiple paths share one logger),
 *  - a SERIALIZED queue (tlpLogChain) so the batched cadence path can't spawn concurrent Chromium
 *    and OOM the 2GB box (tlpLogCustomerContact launches its own browser per call, no internal lock),
 *  - queueTlpLogForConversation wired into the auto-send paths (cadence x3 + appt-confirm x2 +
 *    webhook), and the manual /send path delegating through the same serialized queue.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const src = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");

// Extracted, reusable, module-level logger (not trapped in the /send closure).
assert.match(src, /async function logTlpForConversation\(/, "logTlpForConversation must be a module-level function");

// Serialized queue: a single promise chain so at most ONE TLP browser job runs at a time.
assert.match(src, /let tlpLogChain: Promise<void> = Promise\.resolve\(\);/, "a module-level tlpLogChain must serialize TLP jobs");
assert.match(
  src,
  /function queueTlpLogForConversation\([\s\S]{0,200}tlpLogChain = tlpLogChain[\s\S]{0,160}\.then\(\(\) => logTlpForConversation\(/,
  "queueTlpLogForConversation must chain onto tlpLogChain (serialized, never concurrent)"
);

// Wired into the auto-send paths: cadence (email + sms fallback + twilio) + appointment-confirm
// (twilio + fallback) + webhook autopilot = 6 auto-send call sites (the manual /send delegate is extra).
const autosendMarkers = (src.match(/\[tlp-autosend-log\]/g) ?? []).length;
assert.ok(autosendMarkers >= 6, `auto-send paths must be wired to the TLP logger (found ${autosendMarkers} markers, need >=6)`);
const callSites = (src.match(/queueTlpLogForConversation\(conv/g) ?? []).length;
assert.ok(callSites >= 6, `queueTlpLogForConversation must be called from the auto-send paths (found ${callSites}, need >=6)`);

// The manual /send path delegates through the serialized queue (no duplicated inline TLP loop).
assert.match(
  src,
  /queueTlpLogForConversation\(conv, \{\s*explicitLeadRef: req\.body\?\.leadRef \?\? req\.body\?\.tlpLeadRef,\s*draftId\s*\}\)/,
  "the manual /send queueTlpLog must delegate to the serialized queueTlpLogForConversation"
);

// The webhook path logs only genuine AUTOPILOT sends (not suggest-mode forceSend compliance acks).
assert.match(
  src,
  /if \(webhookMode === "autopilot"\) \{\s*queueTlpLogForConversation\(conv\);/,
  "the webhook auto-send TLP log must be gated to autopilot mode"
);

// The draft_ai (suggest-mode, never sent) cadence branch must NOT log to TLP — guard against logging
// an unsent draft: the draft branch ends in advanceFollowUpCadence+continue with no TLP call adjacent.
assert.doesNotMatch(
  src,
  /"draft_ai", undefined, mediaUrls\);\s*\n\s*queueTlpLogForConversation/,
  "a draft_ai (unsent) outbound must never trigger a CRM log"
);

console.log("PASS tlp auto-send coverage eval");
