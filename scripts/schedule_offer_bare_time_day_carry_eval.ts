/**
 * Schedule-offer bare-time day-carry eval.
 *
 * Production fixture: +17165701338 (American Harley, 2026-06-26). In dialogState
 * schedule_offer_sent (offered slots: Fri 3:00 PM, Fri 5:00 PM, Sat 11:30 AM) the customer
 * proposed a same-day time that was NOT offered — "Can I come at 12" / "1230" (12:30). The
 * agent drafted a vague "12:30 works. I can set up a time." — no slot check, no lock-in, no
 * appointment created — and the customer believed he was booked and showed up ("Im running
 * late").
 *
 * ROOT CAUSE: the customer-ack `ask_for_available_times` arm ran the slot search on the RAW
 * inbound. "1230" carries no weekday, so extractRequestedScheduleWindowClauses produced no
 * clause, the search returned nothing, and the turn degraded to the vague-deferral fallback.
 * (Distinct from the reschedule branch fixed in 6fb77dd2 — this lead has NO bookedEventId.)
 *
 * FIX (both paths): when the raw inbound yields no slots, retry the search from the parser's
 * NORMALIZED day+time (customerAckActionRequestedPhrase -> normalizedText), which carries the
 * offered day. A reinforcing parser few-shot teaches the bare/compact concrete-time proposal
 * to populate requested.day + normalized_text. Fail-safe: an empty/dayless phrase still
 * returns no slots; suggest-mode proposes a lock-in / nearest slot, never a phantom confirm.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const { parseRequestedDayTime } = await import(
  "../services/api/src/domain/conversationStore.ts"
);

const TZ = "America/New_York";
const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
const draftSource = await fs.readFile(path.resolve("services/api/src/domain/llmDraft.ts"), "utf8");

// ── Source pins: the retry-from-parser-normalized-phrase must exist in BOTH the live
// /webhooks/twilio and the /conversations/:id/regenerate customer-ack arms.
assert.equal(
  (apiSource.match(/\[schedule-offer-bare-time-day-carry\]/g) ?? []).length,
  2,
  "schedule-offer bare-time day-carry retry must be wired in BOTH the live and regen arms"
);
// Each marked block must drive the retry off the parser's normalized phrase, not raw event.body.
assert.match(
  apiSource,
  /customerAckActionRequestedPhrase\(customerAckActionParse\)/,
  "live ask_for_available_times retry must use the parser's normalized requested phrase"
);
assert.match(
  apiSource,
  /customerAckActionRequestedPhrase\(regenCustomerAckActionParse\)/,
  "regen ask_for_available_times retry must use the parser's normalized requested phrase"
);

// ── Parser few-shot pin: the bare/compact concrete-time proposal must carry the offered day.
assert.match(
  draftSource,
  /Customer: Can I come at 12 1230/,
  "customer-ack parser must have a few-shot for the bare/compact time proposal"
);
assert.match(
  draftSource,
  /"normalized_text":"friday 12:30"/,
  "that few-shot must normalize the proposal to a carried day + time (friday 12:30)"
);

// ── Behavioral pins (real exported parseRequestedDayTime): WHY raw search failed and WHY the
// normalized phrase fixes it.
assert.equal(
  parseRequestedDayTime("1230", TZ),
  null,
  "a bare/compact time alone must not resolve to a concrete day (raw search correctly found nothing)"
);
assert.equal(
  parseRequestedDayTime("12:30", TZ),
  null,
  "a bare time alone must not resolve to a concrete day"
);
const resolved = parseRequestedDayTime("friday 12:30", TZ);
assert.ok(resolved, "the parser's normalized day+time must resolve to a concrete window");
assert.equal(resolved!.dayOfWeek, "friday", "normalized phrase carries the offered Friday");
assert.equal(resolved!.hour24, 12, "12:30 PM proposal resolves to 12:xx");
assert.equal(resolved!.minute, 30, "12:30 minute must be carried exactly");

console.log("PASS schedule offer bare-time day-carry eval");
