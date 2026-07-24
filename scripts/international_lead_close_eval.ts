/**
 * International (out-of-country) lead log + close eval (pure decision table + wiring, no LLM).
 *
 * Joe ruling 2026-07-22 on +6282245353758 (Indonesia): "leave it but make sure the crm is updated
 * with international lead and close it." So the SILENCE stays — we never reply overseas — but the
 * lead stops sitting open with nobody on it: a CRM "international lead" note lands and the
 * conversation closes.
 *
 * This adds a SIDE EFFECT (close + CRM write), so it is pinned as a decision table AND in BOTH
 * paths (/webhooks/twilio and /conversations/:id/regenerate).
 *
 * FAIL DIRECTION pinned here: DOMESTIC. Anything not readable as a clean non-+1 E.164 number is
 * handled normally — a false positive would silence AND close a real local customer.
 *
 * Run: npx tsx scripts/international_lead_close_eval.ts
 */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  decideInternationalLeadTurn,
  internationalDialCode,
  isInternationalLeadPhone
} from "../services/api/src/domain/routeStateReducer.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

let n = 0;
const eq = (a: unknown, b: unknown, m: string) => {
  assert.deepEqual(a, b, m);
  n++;
};
const ok = (v: unknown, m: string) => {
  assert.ok(v, m);
  n++;
};

// --- 1) Country-code extraction (structured, not comprehension). ---
eq(internationalDialCode("+6282245353758"), "62", "Joe's Indonesia case reads as +62");
eq(internationalDialCode("+447911123456"), "44", "UK reads as +44");
eq(internationalDialCode("+79123456789"), "7", "Russia is the other single-digit code");
eq(internationalDialCode("+35311234567"), "353", "a three-digit code (Ireland) is read as three digits");
// Domestic / unreadable => null (never guess).
for (const domestic of [
  "+17168304817", // US
  "+14165551234", // Canada — same +1 plan, same dealer market
  "+18765551234", // NANP Caribbean
  "7168304817", // not E.164 (no +) — never guess
  "716-830-4817",
  "AMERICANHD", // alphanumeric sender id
  "12345", // short code
  "+", // junk
  "",
  null,
  undefined
]) {
  eq(internationalDialCode(domestic as any), null, `"${domestic}" is NOT international (fail toward domestic)`);
  eq(isInternationalLeadPhone(domestic as any), false, `"${domestic}" does not flag as an international lead`);
}
eq(isInternationalLeadPhone("+6282245353758"), true, "the Indonesia number flags");

// --- 2) Decision table. ---
const base = { provider: "twilio", channel: "sms" as const, fromPhone: "+6282245353758", alreadyLogged: false };
{
  const d = decideInternationalLeadTurn(base);
  ok(d, "an inbound SMS from an overseas number produces a decision");
  eq(d!.kind, "international_lead_log_close", "kind");
  eq(d!.routeOutcome, "international_lead_log_close", "route outcome");
  eq(d!.shouldStop, true, "the turn stops here");
  eq(d!.shouldReply, false, "Joe's ruling keeps the silence — we never reply");
  eq(d!.closeReason, "international_lead", "close reason");
  eq(d!.logCrmNote, true, "first detection writes the CRM note");
  ok(/International lead/i.test(d!.crmNote), "the CRM note says international lead");
  ok(d!.crmNote.includes("+62"), "the CRM note carries the country code");
}
{
  // A SECOND text from the same number still stops + re-closes (appendInbound reopens a closed
  // thread on any real inbound), but must not re-write the CRM note.
  const d = decideInternationalLeadTurn({ ...base, alreadyLogged: true });
  ok(d, "a repeat overseas text still returns a stop decision (never falls through to a reply)");
  eq(d!.shouldReply, false, "still silent on the repeat");
  eq(d!.logCrmNote, false, "the CRM note is written once, not once per text");
}
eq(
  decideInternationalLeadTurn({ ...base, fromPhone: "+17168304817" }),
  null,
  "a US number is never an international lead"
);
eq(
  decideInternationalLeadTurn({ ...base, provider: "sendgrid_adf" }),
  null,
  "only the SMS lane is gated (phone country code is the whole signal)"
);
eq(
  decideInternationalLeadTurn({ ...base, channel: "email" }),
  null,
  "email channel is out of scope"
);

// --- 3) Wiring: one shared applier, BOTH paths. ---
{
  const indexSrc = fs.readFileSync(path.join(repoRoot, "services/api/src/index.ts"), "utf8");
  ok(
    indexSrc.includes("function applyInternationalLeadCloseout("),
    "there is ONE shared applier for the close + CRM side effect"
  );
  const decideCalls = (indexSrc.match(/decideInternationalLeadTurn\(\{/g) ?? []).length;
  eq(decideCalls, 2, "the centralized decision is called in exactly two places (live + regen)");
  const applyCalls = (indexSrc.match(/applyInternationalLeadCloseout\(conv, /g) ?? []).length;
  eq(applyCalls, 2, "the same applier runs in both paths — no mirrored side effects");
  ok(
    /applyInternationalLeadCloseout[\s\S]{0,900}closeConversation\(conv, decision\.closeReason\)/.test(indexSrc),
    "the applier closes the conversation"
  );
  ok(
    /applyInternationalLeadCloseout[\s\S]{0,1200}queueTlpLogForConversation\(conv, \{ noteHeader: decision\.crmNote \}\)/.test(
      indexSrc
    ),
    "the applier writes the CRM note through the EXISTING TLP logger"
  );
  ok(
    /applyInternationalLeadCloseout[\s\S]{0,900}discardPendingDrafts\(conv, "international_lead"\)/.test(indexSrc),
    "any pending draft is discarded — nothing may go out to an overseas number"
  );
  ok(
    indexSrc.includes("return respondRegenerateSkipped(internationalDecision.routeOutcome)"),
    "regenerate returns no draft for an international lead"
  );
  ok(
    !/const regenInternational/.test(indexSrc),
    "no hand-mirrored `const regen*` local — the regen path calls the shared decision inline"
  );
}

console.log(`PASS international-lead log+close eval (${n} assertions)`);
