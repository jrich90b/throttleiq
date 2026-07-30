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
  hasDeliverablePhoneKey,
  isDuplicateRecentFirstTouchAck,
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
  hasDeliverablePhone: true,
  alreadyContacted: false,
  duplicateRecentAck: false
};

const ACK = "Hey Layla, it's Alexandra over at American Harley-Davidson. Thanks for signing up for this year's ride challenge.";

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
    [{ hasDeliverablePhone: false }, "no_deliverable_phone"],
    [{ alreadyContacted: true }, "already_contacted"],
    [{ duplicateRecentAck: true }, "duplicate_recent_ack"]
  ];
  for (const [patch, reason] of fails) {
    const d = decideFirstTouchAutoSend({ ...base, ...patch });
    assert.equal(d.send, false, `must hold draft when ${reason}`);
    assert.equal(d.reason, reason, `reason for ${JSON.stringify(patch)}`);
  }

  // Compliance precedence: suppression / opt-out beat an otherwise-eligible first touch.
  assert.equal(decideFirstTouchAutoSend({ ...base, suppressed: true }).send, false, "suppressed beats eligible");
  assert.equal(decideFirstTouchAutoSend({ ...base, optedOut: true }).send, false, "opted_out beats eligible");

  // --- Duplicate prevention: the two cases the pre-flip shadow review actually caught. -------------
  // CASE 1 (conv +15126299400, 2026-07-28/29/30): a vendor re-pushes the SAME lead every morning, so
  // isFirstTouch is true each day. Without alreadyContacted the customer gets the identical greeting
  // once a day. isFirstTouch alone must NOT be enough to send.
  const dayTwo = decideFirstTouchAutoSend({ ...base, isFirstTouch: true, alreadyContacted: true });
  assert.equal(dayTwo.send, false, "a re-pushed lead the customer already heard from must not re-send");
  assert.equal(dayTwo.reason, "already_contacted");

  // CASE 2 (conv +17163084498): two ADFs 13s apart produced two near-identical acks. The prior SENT
  // copy carries the STOP footer while the candidate does not — the guard must still match.
  const sentAt = Date.parse("2026-07-30T11:37:46.000Z");
  const nowMs = Date.parse("2026-07-30T11:37:59.000Z");
  const priorSent = [
    { direction: "out", provider: "twilio", at: new Date(sentAt).toISOString(), body: `${ACK} Reply STOP to opt out.` }
  ];
  assert.equal(
    isDuplicateRecentFirstTouchAck(priorSent, ACK, { nowMs }),
    true,
    "a footer-bearing sent copy of the same ack is still a duplicate"
  );

  // Held DRAFTS are not duplicates — draft_ai was never delivered, so a real send must still go out
  // (this is the fail-OPEN direction we DO want; the opposite would silence every first touch).
  assert.equal(
    isDuplicateRecentFirstTouchAck(
      [{ direction: "out", provider: "draft_ai", at: new Date(sentAt).toISOString(), body: ACK }],
      ACK,
      { nowMs }
    ),
    false,
    "an unsent draft_ai copy must NOT count as already-delivered"
  );
  // Inbound echoes of our own text (customer quoting us) are not our outbound.
  assert.equal(
    isDuplicateRecentFirstTouchAck(
      [{ direction: "in", provider: "twilio", at: new Date(sentAt).toISOString(), body: ACK }],
      ACK,
      { nowMs }
    ),
    false,
    "an INBOUND message must never be read as our own prior send"
  );
  // A different ack to the same lead is not a duplicate.
  assert.equal(
    isDuplicateRecentFirstTouchAck(priorSent, "Hey Layla, your bike is ready for pickup.", { nowMs }),
    false,
    "different text is not a duplicate"
  );
  // Outside the window ⇒ not a recent duplicate (alreadyContacted is what covers the long tail).
  assert.equal(
    isDuplicateRecentFirstTouchAck(priorSent, ACK, { nowMs: sentAt + 48 * 60 * 60 * 1000 }),
    false,
    "beyond the window the recency guard stands down"
  );
  // Fail-SAFE: unreadable candidate text, or an equivalent send with an unparseable timestamp, holds.
  assert.equal(isDuplicateRecentFirstTouchAck(priorSent, "", { nowMs }), true, "blank candidate ⇒ hold");
  assert.equal(
    isDuplicateRecentFirstTouchAck([{ direction: "out", provider: "twilio", at: "not-a-date", body: ACK }], ACK, { nowMs }),
    true,
    "equivalent send with an unreadable timestamp ⇒ hold"
  );
  // A thread with no history is not a duplicate (the ordinary brand-new lead).
  assert.equal(isDuplicateRecentFirstTouchAck([], ACK, { nowMs }), false, "empty history ⇒ not a duplicate");

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
  // Evidence stream: the MAIN opener logs first-touch acks (log-only, never send —
  // isDeterministicReply false so wouldSend is honestly false), gated on first-touch + the debug
  // flag, so the shadow report shows a full streak of real first-touch messages before any flip.
  assert.ok(
    /Evidence stream \(LOG-ONLY/.test(adfSrc),
    "evidence stream: the main first-touch opener logs (log-only) what it would send"
  );
  assert.ok(
    /if \(isInitialAdf && firstTouchAutoSendDebugEnabled\(\)\) \{[\s\S]{0,600}?isDeterministicReply: false/.test(adfSrc),
    "evidence stream: the main-opener log is first-touch + debug gated and NOT auto-send-eligible"
  );

  // --- BOTH-PATHS / no-silent-skip tripwire (added after the 2026-07-30 cross-model review asked,
  //     correctly, whether the duplicate guard could be absent on another reply path).
  // The answer today is that first-touch auto-send is ADF/SendGrid-ONLY: there is no Twilio cold
  // opener, and regenerate never sends. Rather than leave that as a claim in a PR description, pin
  // it — every production call site must live in sendgridInbound.ts AND supply both duplicate-guard
  // fields. If someone later adds a Twilio or regenerate call site, or forgets a guard field at a new
  // one, this fails instead of shipping a path where duplicates are silently unguarded.
  const gateCallSitePattern = /decideFirstTouchAutoSend\(/g;
  const adfCallSites = (adfSrc.match(gateCallSitePattern) ?? []).length;
  assert.equal(adfCallSites, 3, "the ADF opener has exactly 3 gate call sites (live send + 2 shadow logs)");
  // Every call site is reached from one of exactly two input objects, and BOTH carry the guards.
  //
  // Scoped to the gate's own INPUT OBJECTS rather than counting the guard strings file-wide. A
  // file-wide count conflates this gate with any UNRELATED decision in the same file that
  // legitimately reads the same thread-history helper — the phone-log recap gate does exactly that,
  // and a bare count would have failed on it while proving nothing about first-touch. The two input
  // objects are the shared `firstTouchGateInputs` literal (used by the live send and its shadow log
  // via spread) and the inline literal at the main-opener shadow log.
  const gateInputBlocks: string[] = [];
  {
    const sharedIdx = adfSrc.indexOf("const firstTouchGateInputs = {");
    assert.ok(sharedIdx > 0, "the shared first-touch gate input object must exist");
    const sharedEnd = adfSrc.indexOf("\n    };", sharedIdx);
    assert.ok(sharedEnd > sharedIdx, "the shared gate input object must be terminated");
    gateInputBlocks.push(adfSrc.slice(sharedIdx, sharedEnd));
    const inlineRe = /decideFirstTouchAutoSend\(\{([\s\S]{0,1500}?)\n\s*\}\)/g;
    let match: RegExpExecArray | null;
    while ((match = inlineRe.exec(adfSrc)) !== null) {
      // The spread form reuses the shared object already captured above.
      if (match[1].includes("...firstTouchGateInputs")) continue;
      gateInputBlocks.push(match[1]);
    }
  }
  assert.equal(
    gateInputBlocks.length,
    2,
    "the gate is fed by exactly 2 input objects (shared live-send literal + main-opener inline literal)"
  );
  for (const block of gateInputBlocks) {
    assert.match(
      block,
      /alreadyContacted: hasCustomerReceivedOutbound\(conv\?\.messages\)/,
      "duplicate guard: every gate input object wires alreadyContacted from the real thread history"
    );
    assert.match(
      block,
      /duplicateRecentAck: isDuplicateRecentFirstTouchAck\(conv\?\.messages, invariant\.draftText\)/,
      "duplicate guard: every gate input object wires duplicateRecentAck from the real ack text"
    );
  }
  // No OTHER production file may call the gate — index.ts hosts /webhooks/twilio and
  // /conversations/:id/regenerate, and neither has any business auto-sending a first touch.
  const twilioAndRegeneratePath = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
  assert.ok(
    !gateCallSitePattern.test(twilioAndRegeneratePath),
    "no first-touch auto-send call site in index.ts (/webhooks/twilio + regenerate) — ADF lane only"
  );
  assert.ok(
    !/FIRST_TOUCH_ACK_AUTOSEND/.test(twilioAndRegeneratePath),
    "index.ts does not read the auto-send flag — if a Twilio cold opener is ever added it must wire the guards"
  );

  // --- Deliverable-phone key. The check WAS `leadKey.startsWith("+")` inline, but leadKey is
  // stored as BARE DIGITS — so it rejected every SMS lead and the feature could never fire. In the
  // 2026-07-27..30 shadow corpus that was 218 of 218 otherwise-eligible first-touch leads, which
  // is why "0 auto-sends" was evidence of nothing. Real leadKeys from that corpus are pinned here.
  for (const deliverable of ["7164789799", "5126299400", "7168185994", "+17164789799", "17164789799", "(716) 478-9799"]) {
    assert.strictEqual(
      hasDeliverablePhoneKey(deliverable),
      true,
      `real production leadKey must be deliverable: ${deliverable}`
    );
  }
  // Fail-safe: anything that is not a phone still holds the draft.
  for (const notAPhone of ["rspenc29@gmail.com", "", "   ", "abc", "12345", null, undefined, 7164789799]) {
    assert.strictEqual(
      hasDeliverablePhoneKey(notAPhone as unknown),
      false,
      `non-phone lead key must NOT be treated as deliverable: ${String(notAPhone)}`
    );
  }
  // The two call sites must use the shared helper, not re-inline a raw prefix test.
  assert.ok(
    !/leadKey\.startsWith\("\+"\)/.test(adfSrc),
    "the raw startsWith('+') deliverability test must not come back — it rejects bare-digit leadKeys"
  );
  // Scoped to the gate's own input objects (see gateInputBlocks above) — a file-wide count would
  // also catch unrelated gates in this file that correctly reuse the same shared helper.
  for (const block of gateInputBlocks) {
    assert.match(
      block,
      /hasDeliverablePhone: hasDeliverablePhoneKey\(leadKey\)/,
      "every first-touch gate input object must use the shared deliverable-phone helper"
    );
  }
  // Deliverability and suppression must agree on what a phone IS — they gate the same send.
  const suppressionSrc = fs.readFileSync(
    path.join(process.cwd(), "services/api/src/domain/suppressionStore.ts"),
    "utf8"
  );
  assert.ok(
    /export function normalizePhone/.test(suppressionSrc),
    "suppression's normalizePhone is the shared definition of a phone number"
  );

  console.log("PASS first-touch-autosend eval (dark no-op + 1 send case + 9 fail-safes + duplicate prevention + parity + shadow record + STEP 2 wiring + evidence stream + deliverable-phone key)");
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) run();
