/**
 * first_touch_autosend:eval — pins decideFirstTouchAutoSend (scope A).
 * Self-test only (no network, no live data). Proves three things:
 *   1) DARK = exact no-op — flag off ⇒ never send, whatever else is true.
 *   2) the single positive case (enabled + first-touch + deterministic + deliverable + clean).
 *   3) every fail-safe — each hold-the-draft reason resolves to send=false.
 * See docs/first_touch_autosend_spec.md. Run: npm run first_touch_autosend:eval
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  decideFirstTouchAutoSend,
  isFirstTouchAckAutoSendEnabled,
  buildFirstTouchShadowRecord,
  type FirstTouchAutoSendInput
} from "../services/api/src/domain/firstTouchAutoSend.ts";

const base: FirstTouchAutoSendInput = {
  enabled: true,
  isFirstTouch: true,
  isDeterministicReply: true,
  suppressed: false,
  callOnly: false,
  optedOut: false,
  invariantAllow: true,
  hasDeliverablePhone: true
};

function run(): void {
  // 1) Dark = exact no-op: flag off ⇒ never send, regardless of everything else.
  const off = decideFirstTouchAutoSend({ ...base, enabled: false });
  assert.equal(off.send, false, "flag off must never send");
  assert.equal(off.reason, "flag_off");
  // even with every other signal eligible, an off flag is still off.
  assert.equal(decideFirstTouchAutoSend({ ...base, enabled: false, suppressed: false }).send, false);

  // 2) The one positive case.
  const ok = decideFirstTouchAutoSend(base);
  assert.equal(ok.send, true, "first-touch deterministic deliverable should send when enabled");
  assert.equal(ok.reason, "first_touch_deterministic_ack");

  // 3) Fail-safe cases — every one holds the draft (send=false) with its reason.
  const fails: Array<[Partial<FirstTouchAutoSendInput>, string]> = [
    [{ isFirstTouch: false }, "not_first_touch"],
    [{ isDeterministicReply: false }, "llm_substantive_reply"],
    [{ suppressed: true }, "suppressed"],
    [{ optedOut: true }, "opted_out"],
    [{ callOnly: true }, "call_only"],
    [{ invariantAllow: false }, "invariant_block"],
    [{ hasDeliverablePhone: false }, "no_deliverable_phone"]
  ];
  for (const [patch, reason] of fails) {
    const d = decideFirstTouchAutoSend({ ...base, ...patch });
    assert.equal(d.send, false, `must hold draft when ${reason}`);
    assert.equal(d.reason, reason, `reason for ${JSON.stringify(patch)}`);
  }

  // Compliance precedence: suppression / opt-out beat an otherwise-eligible first touch.
  assert.equal(decideFirstTouchAutoSend({ ...base, suppressed: true }).send, false, "suppressed beats eligible");
  assert.equal(decideFirstTouchAutoSend({ ...base, optedOut: true }).send, false, "opted_out beats eligible");

  // Both call sites (ADF SMS opener now; any Twilio first-touch later) share ONE
  // decision fn ⇒ identical verdict for identical inputs (parity by construction).
  assert.deepEqual(decideFirstTouchAutoSend(base), decideFirstTouchAutoSend({ ...base }), "same inputs ⇒ same decision");

  // Env reader defaults to OFF (dark by default).
  const saved = process.env.FIRST_TOUCH_ACK_AUTOSEND;
  delete process.env.FIRST_TOUCH_ACK_AUTOSEND;
  assert.equal(isFirstTouchAckAutoSendEnabled(), false, "unset flag ⇒ disabled (dark by default)");
  process.env.FIRST_TOUCH_ACK_AUTOSEND = "0";
  assert.equal(isFirstTouchAckAutoSendEnabled(), false, "flag=0 ⇒ disabled");
  process.env.FIRST_TOUCH_ACK_AUTOSEND = "1";
  assert.equal(isFirstTouchAckAutoSendEnabled(), true, "flag=1 ⇒ enabled");
  if (saved === undefined) delete process.env.FIRST_TOUCH_ACK_AUTOSEND;
  else process.env.FIRST_TOUCH_ACK_AUTOSEND = saved;

  // Shadow record builder (STEP 1 evidence log): carries the decision verdict +
  // the actual ack text and risk context, and clips long fields for readability.
  const rec = buildFirstTouchShadowRecord({
    at: "2026-07-13T12:00:00.000Z",
    convId: "+15551234567",
    leadKey: "+15551234567",
    leadName: "Test Rider",
    model: "Street Glide",
    leadSource: "Room58 - Book test ride",
    inboundText: "Interested in the Street Glide, any availability?",
    ackText: "Hi Test — this is Alexandra at American Harley-Davidson. Thanks for reaching out about the Street Glide; let me pull the details and follow up shortly.",
    decision: decideFirstTouchAutoSend(base)
  });
  assert.equal(rec.wouldSend, true, "record mirrors the send decision");
  assert.equal(rec.reason, "first_touch_deterministic_ack", "record carries the decision reason");
  assert.equal(rec.leadName, "Test Rider");
  assert.ok(rec.ack.includes("Alexandra"), "record carries the actual ack text");
  const held = buildFirstTouchShadowRecord({
    at: "2026-07-13T12:00:00.000Z",
    convId: null,
    leadKey: null,
    ackText: "",
    decision: decideFirstTouchAutoSend({ ...base, isDeterministicReply: false })
  });
  assert.equal(held.wouldSend, false, "held decision ⇒ wouldSend false");
  assert.equal(held.reason, "llm_substantive_reply");
  assert.equal(held.leadName, null, "missing optional fields clip to null");
  assert.equal(held.inbound, null);
  const clipped = buildFirstTouchShadowRecord({
    at: "t",
    convId: "c",
    leadKey: "k",
    inboundText: "x".repeat(500),
    ackText: "y".repeat(800),
    decision: decideFirstTouchAutoSend(base)
  });
  assert.ok(clipped.inbound!.length <= 241, "inbound clipped");
  assert.ok(clipped.ack.length <= 601, "ack clipped");

  // 4) STEP 2 live-send wiring source guards (sendgridInbound.ts ADF opener). Ships DARK — these
  //    prove the send path exists, is gated by the REAL flag (not hardcoded on), wires the REAL
  //    compliance inputs, keeps send==record parity (footer before send), and falls back to a held
  //    draft on any send failure.
  const adfSrc = fs.readFileSync(path.resolve("services/api/src/routes/sendgridInbound.ts"), "utf8");
  assert.ok(adfSrc.includes("async function sendCustomerFirstTouchSms("), "STEP 2: customer first-touch SMS sender exists");
  // The live decision is gated by the REAL flag (dark by default), NOT hardcoded enabled:true.
  assert.ok(
    adfSrc.includes("enabled: isFirstTouchAckAutoSendEnabled()"),
    "STEP 2: the live auto-send decision reads the real flag (dark by default)"
  );
  // Real compliance inputs are wired (STEP 1 stubbed these false).
  assert.ok(
    adfSrc.includes("suppressed: typeof leadKey === \"string\" && isSuppressed(leadKey)"),
    "STEP 2: suppression is wired from isSuppressed(leadKey)"
  );
  assert.ok(adfSrc.includes("optedOut: isOptOutKeywordInbound("), "STEP 2: opt-out is wired from the inbound text");
  // Send/record parity: footer applied to the body BEFORE the send, so the sent text == recorded text.
  assert.ok(
    adfSrc.includes("ensureInitialSmsOptOutFooter(conv, invariant.draftText, { provider: \"twilio\", to: leadKey })"),
    "STEP 2: STOP footer is applied before send (send==record parity)"
  );
  // On send success it records a real "twilio" outbound; on failure it falls back to a held draft.
  assert.ok(
    /appendOutbound\(conv, sendResult\.from \?\? "dealership", leadKey, publishedBody, "twilio", sendResult\.sid/.test(adfSrc),
    "STEP 2: a successful send is recorded as a real twilio outbound (send==record)"
  );
  assert.ok(
    /send failed -> held draft/.test(adfSrc),
    "STEP 2: a send failure falls back to the held draft (never lose the message)"
  );

  console.log("PASS first-touch-autosend eval (dark no-op + 1 send case + 7 fail-safes + parity + shadow record + STEP 2 wiring)");
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) run();
