/**
 * BARE-ACKNOWLEDGEMENT / LOST-SALE CLOSEOUT eval (2026-08-07).
 *
 * The defect: a courtesy word bought the whole turn a pass on comprehension.
 * `isShortAckText` is a word list ("thanks | ok | appreciate | ..."), and the human-mode
 * customer-disposition parser was gated on it, so ANY short sentence that ended politely
 * was ruled a non-event and the parser was never called.
 *
 *   Curran Terblanche +13105956498, 2026-08-04 20:50Z: "Found a better offer. Thanks"
 *
 * He had bought elsewhere. Nothing replied, nothing closed, and the lead stayed parked on
 * an inventory watch. Executed against his live record, the parser reads that turn
 * stepping_back / explicit / 0.90 and `canApplyDispositionCloseout` allows it — the parser
 * was simply never asked.
 *
 * Measured over the 30 days to 2026-08-07 (515 inbound Twilio turns): the old gate skipped
 * 87; `isBareAcknowledgementText` still skips 55 of those and lets 32 through, of which
 * exactly 3 produce a closeout — all three real walk-aways, all three previously silent.
 * Zero engaged turns flip. Those three, and a sample of the 29 that must NOT flip, are
 * pinned below by name.
 *
 * EXECUTED, not asserted from source text — except PART 4, which pins the WIRING, because
 * tsc cannot prove a predicate is still reached and a gate that is computed and never
 * consumed is the failure this eval exists to catch.
 *
 * Run: npx tsx scripts/bare_acknowledgement_disposition_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { isBareAcknowledgementText, isShortAckText, isEmojiOnlyText } = await import(
  "../services/api/src/domain/bareAcknowledgement.ts"
);
const { isReachOutWhenReadyCloseText, buildCustomerDispositionReply } = await import(
  "../services/api/src/domain/dispositionReply.ts"
);
const { isDispositionParserAccepted, canApplyDispositionCloseout } = await import(
  "../services/api/src/domain/transitionSafety.ts"
);

let n = 0;
const ok = (cond: boolean, msg: string) => {
  assert.equal(cond, true, msg);
  n++;
};

// ---------------------------------------------------------------------------
// PART 1 — the turns that MUST now reach the parser. Live rows, verbatim.
// Each one is a customer telling us they are gone; each one drew total silence.
// ---------------------------------------------------------------------------
const MUST_REACH_PARSER = [
  "Found a better offer. Thanks", // +13105956498, 2026-08-04 — the operator report
  "I find another bike i really wanted thanks for the help tho", // 2026-07-24
  "Not at this time thank you" // 2026-07-25
];
for (const text of MUST_REACH_PARSER) {
  ok(isShortAckText(text), `the OLD gate swallowed this turn: ${JSON.stringify(text)}`);
  ok(
    !isBareAcknowledgementText(text),
    `a walk-away that ends politely is not a bare acknowledgement: ${JSON.stringify(text)}`
  );
}

// ---------------------------------------------------------------------------
// PART 2 — the turns that MUST stay skipped. Nothing survives the courtesy words,
// so there is nothing to comprehend and no call worth paying for.
// ---------------------------------------------------------------------------
const MUST_STAY_SKIPPED = [
  "ok thanks",
  "Thanks",
  "Thank you",
  "Ok",
  "okay thanks!",
  "sounds good",
  "Will do",
  "perfect, thank you",
  "👍"
];
for (const text of MUST_STAY_SKIPPED) {
  ok(isBareAcknowledgementText(text), `nothing left to read here: ${JSON.stringify(text)}`);
}

// Emoji-only is bare whatever its length, and empty is neither.
ok(isEmojiOnlyText("😀 🔥"), "emoji-only text is recognised");
ok(isBareAcknowledgementText("😀 🔥"), "an emoji-only turn is a bare acknowledgement");
ok(!isBareAcknowledgementText(""), "an empty turn is not an acknowledgement");
ok(!isBareAcknowledgementText("   "), "whitespace is not an acknowledgement");

// KNOWN GAP, moved verbatim and deliberately NOT changed here: a skin-tone modifier
// (U+1F3FB..U+1F3FF) is Emoji_Modifier, not Extended_Pictographic, so "👍🏻" reads as
// non-emoji. Pinned so it is a documented shape rather than a silent surprise. It fails the
// safe way — the turn reaches the parser, which answers `none`, and nothing closes.
ok(!isEmojiOnlyText("👍🏻"), "a skin-toned emoji is not matched by the Extended_Pictographic test");
ok(!isBareAcknowledgementText("👍🏻"), "so it reaches the parser rather than being skipped");

// A turn with no courtesy word at all was never in scope and must not become bare — the new
// predicate can only ever NARROW the old gate, never widen what gets skipped.
const NEVER_IN_SCOPE = [
  "Do you have any black Street Glides in stock?",
  "I want to come look at it Saturday",
  "Whats the out the door price"
];
for (const text of NEVER_IN_SCOPE) {
  ok(!isShortAckText(text), `outside the old gate: ${JSON.stringify(text)}`);
  ok(!isBareAcknowledgementText(text), `and outside the new one too: ${JSON.stringify(text)}`);
}

// The narrowing is a strict subset: bare => short-ack, always. If this ever inverts, the gate
// has started skipping turns the old one parsed, which is a silent regression in the unsafe
// direction (more silence, not less).
for (const text of [...MUST_REACH_PARSER, ...MUST_STAY_SKIPPED, ...NEVER_IN_SCOPE]) {
  if (isBareAcknowledgementText(text)) {
    ok(isShortAckText(text), `bare implies short-ack: ${JSON.stringify(text)}`);
  }
}

// ---------------------------------------------------------------------------
// PART 3 — behavior preservation across the move out of index.ts, and the closeout
// chain the newly-parsed turn now reaches. No LLM: the parse shape is the one the live
// parser returned for this exact turn (stepping_back / explicit / 0.90).
// ---------------------------------------------------------------------------
ok(isShortAckText("ok thanks"), "isShortAckText still answers the question it always did");
ok(!isShortAckText("is it still available?"), "a question is still not an ack");
ok(
  !isShortAckText("thanks so much for all of your help over the last few weeks with everything"),
  "over 60 characters is still not a short ack"
);

// The moved reach-out-close detector reads OUR outbound copy, and still matches the builder's
// own output — the reason it belongs next to it.
ok(
  isReachOutWhenReadyCloseText("I hear you. If anything changes down the road, just give me a shout."),
  "the moved detector still matches the reply builder's own goodbye"
);
ok(!isReachOutWhenReadyCloseText("Found a better offer. Thanks"), "a customer turn is not our goodbye");

const CURRAN_PARSE = {
  disposition: "stepping_back",
  explicitDisposition: true,
  timeframeText: null,
  sellToDealerInterest: false,
  confidence: 0.9
};
const NOW = Date.parse("2026-08-04T20:50:36.295Z");
const curranConv = {
  id: "+13105956498",
  mode: "human",
  dialogState: { name: "inventory_watch_active", updatedAt: new Date(NOW - 36 * 3600 * 1000).toISOString() },
  inventoryWatch: { model: "Street 750", status: "active", exactness: "model_only", condition: "used" },
  messages: [
    { direction: "out", provider: "twilio", body: "Want to pick something out from what we have and still come in?", at: new Date(NOW - 36 * 3600 * 1000).toISOString() },
    { direction: "in", provider: "twilio", body: "Found a better offer. Thanks", at: new Date(NOW).toISOString() }
  ]
};

ok(isDispositionParserAccepted(CURRAN_PARSE), "the parser's read of this turn clears the accept floor");
ok(
  canApplyDispositionCloseout({
    conv: curranConv,
    text: "Found a better offer. Thanks",
    parsedAccepted: true,
    hasDecision: true,
    responseControlNotInterested: false,
    openTodos: [],
    schedulingConflictOpen: false
  }),
  "and no safety arm vetoes closing this lead"
);

// The veto arms still bite: an open scheduling negotiation outranks any disposition read.
ok(
  !canApplyDispositionCloseout({
    conv: curranConv,
    text: "Found a better offer. Thanks",
    parsedAccepted: true,
    hasDecision: true,
    responseControlNotInterested: false,
    openTodos: [],
    schedulingConflictOpen: true
  }),
  "an open scheduling negotiation still vetoes the closeout"
);

// The message he should have got is existing, already-approved copy — not new wording.
const reply = buildCustomerDispositionReply("Found a better offer. Thanks", "Curran");
ok(reply.trim().length > 0, "the closeout has something to say");
ok(
  reply === "I hear you. If anything changes down the road, just give me a shout.",
  "and it is the existing reach-out goodbye, not new copy"
);

// ---------------------------------------------------------------------------
// PART 4 — the wiring. A predicate nothing consumes is the bug, not the fix.
// ---------------------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const api = fs.readFileSync(path.join(here, "../services/api/src/index.ts"), "utf8");

ok(
  /import \{\s*isBareAcknowledgementText,\s*isEmojiOnlyText,\s*isShortAckText\s*\} from "\.\/domain\/bareAcknowledgement\.js";/.test(
    api
  ),
  "index.ts imports the ack predicates from the domain module"
);
ok(
  !/^function isShortAckText\(/m.test(api) && !/^function isEmojiOnlyText\(/m.test(api),
  "and no longer carries its own copy of them"
);

// The EXACT call shape. A gate fed the wrong variable, or renamed, would still typecheck.
const gateSite =
  "const humanModeDispositionShortAck = isBareAcknowledgementText(humanModeDispositionText);";
ok(api.includes(gateSite), "the human-mode disposition gate asks whether the turn is a BARE ack");
ok(
  !/humanModeDispositionShortAck\s*=\s*\n?\s*isShortAckText\(/.test(api),
  "and never falls back to the word list that swallowed the lost sale"
);

// CONSUMED: the gate must still be what decides parser eligibility, and only that.
const eligibility = api.slice(api.indexOf(gateSite), api.indexOf(gateSite) + 600);
ok(
  /humanModeDispositionParserEligible[\s\S]{0,400}!humanModeDispositionShortAck;/.test(eligibility),
  "the gate is consumed by the parser-eligibility check"
);

// The second half of the operator's ask: the closeout must SAY something, as a draft.
//
// 2026-08-07: the reply is no longer built inline here. All three closeout paths (live, human
// mode, regen) now go through applyDispositionCloseoutAndBuildReply so a lost-sale customer can
// get the "congrats, we're here for parts/service/gear" wording — see lost_sale_closeout_ack:eval,
// which owns that behaviour. What THIS eval still guards is unchanged and is the point: human mode
// must not go silent again, and whatever it says must be a DRAFT.
const humanBranchStart = api.indexOf("const humanModeCloseoutReply = await applyDispositionCloseoutAndBuildReply(");
ok(humanBranchStart > 0, "the human-mode closeout builds a reply through the shared builder");
const closeoutBody = api.slice(humanBranchStart, humanBranchStart + 1600);
ok(
  /return publishLiveTwilioReply\(humanModeCloseoutReply, undefined, \{ draftOnly: true \}\);/.test(
    closeoutBody
  ),
  "and publishes it — the human-mode closeout is never silent"
);
ok(
  /applyDispositionCloseoutAndBuildReply\(\s*conv,\s*humanModeDispositionText,/.test(closeoutBody),
  "built from THIS turn's text, not the thread"
);
ok(
  /\{ draftOnly: true \}/.test(closeoutBody),
  "as a DRAFT — a rep owns this thread, so the send stays their call"
);
ok(
  !/forceSend/.test(closeoutBody),
  "and never force-sends past suggest-mode review"
);

// Exactly one gate site: a second copy is the inline-duplicate pattern this repo un-stacks.
ok(
  api.split("isBareAcknowledgementText(").length - 1 === 1,
  "exactly one bare-acknowledgement gate site"
);

console.log(`bare_acknowledgement_disposition_eval: PASS (${n} assertions)`);
