/**
 * Active-deal disposition closeout guard. Production incident 2026-06-11:
 * Dave Batka +17169982451 — credit app submitted 3 hours earlier, open
 * credit-approval task, "Showed / finance needs more info" outcome — archived
 * as customer_sell_on_own (0.9) nine seconds after texting "I am going to
 * take care of the pipes myself".
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const {
  canApplyDispositionCloseout,
  hasActiveDealCloseoutBlockers,
  hasUnitInfoRequestText,
  hasQualificationCriteriaAnswerText,
  shouldSuppressDispositionCloseout
} = await import("../services/api/src/domain/transitionSafety.ts");

const nowMs = Date.parse("2026-06-11T19:08:28.000Z");
const batka: any = {
  id: "+17169982451",
  messages: [
    {
      direction: "in",
      provider: "sendgrid_adf",
      at: "2026-06-11T16:26:16.000Z",
      body: "WEB LEAD (ADF)\nSource: HDFS COA Online\nApp ID: 1013954557, Model Year: 2026, Model: Road Glide Limited"
    }
  ],
  appointment: { staffNotify: { outcome: { note: "Showed — finance needs more info", updatedAt: "2026-06-11T15:30:00.000Z" } } }
};
const openTodos = [{ convId: "+17169982451", reason: "approval", summary: "Credit approval task" }];

assert.equal(hasActiveDealCloseoutBlockers(batka, { openTodos, nowMs }), true, "credit todo blocks closeout");
assert.equal(
  hasActiveDealCloseoutBlockers({ ...batka, id: "other" }, { openTodos: [], nowMs }),
  true,
  "recent credit-app ADF alone blocks closeout"
);
assert.equal(
  hasActiveDealCloseoutBlockers(
    { id: "x", messages: [], appointment: batka.appointment },
    { openTodos: [], nowMs }
  ),
  true,
  "recent finance-pending appointment outcome blocks closeout"
);
assert.equal(
  hasActiveDealCloseoutBlockers({ id: "x", messages: [] }, { openTodos: [], nowMs }),
  false,
  "no active-deal signals = no block"
);
// Stale signals stop blocking.
assert.equal(
  hasActiveDealCloseoutBlockers(
    {
      id: "x",
      messages: [{ direction: "in", provider: "sendgrid_adf", at: "2026-05-01T00:00:00.000Z", body: "App ID: 99" }]
    },
    { openTodos: [], nowMs }
  ),
  false,
  "old credit ADF outside the window does not block"
);

// The full gate: Dave's exact situation must refuse the closeout even with an
// accepted 0.9 parse.
assert.equal(
  canApplyDispositionCloseout({
    conv: batka,
    text: "I am going to take care of the pipes myself",
    parsedAccepted: true,
    hasDecision: true,
    openTodos
  }),
  false,
  "active financing must veto disposition closeout regardless of parser confidence"
);
assert.equal(
  canApplyDispositionCloseout({
    conv: { id: "y", messages: [] },
    text: "I'm going to sell my bike myself, thanks anyway",
    parsedAccepted: true,
    hasDecision: true,
    openTodos: []
  }),
  true,
  "clean sell-on-own without active deal still closes"
);

// Unit-info-request guard. Production miss 2026-07-22 (Jaydon Gerolimos +16813891971):
// a watch-alert reply that deferred AND asked for pictures + price was closed out with
// "I hear you. If anything changes down the road, just give me a shout."
const JAYDON =
  "Im still interested but not in the market right now. I do however still like to know when bikes come in! Could o see pictures of that 883 and the price?";
assert.equal(hasUnitInfoRequestText(JAYDON), true, "pictures + price ask is a live unit-info request");
assert.equal(
  hasUnitInfoRequestText("Not buying today but keep me posted. How many miles on that one?"),
  true,
  "mileage ask is a live unit-info request"
);
assert.equal(
  hasUnitInfoRequestText("Can you send me some pics of it?"),
  true,
  "bare pics ask is a live unit-info request"
);
assert.equal(
  hasUnitInfoRequestText("What's the out the door price?"),
  true,
  "out-the-door price ask is a live unit-info request"
);
// Genuine closeouts carry no unit-info ask and must stay closeable.
for (const closeout of [
  "Money's just too tight right now, I've got to stop looking for a while.",
  "I think I'm going to keep my bike and hold off for now.",
  "I'm just going to sell it myself.",
  "I'm not looking right now but I'll get a hold of you when I'm ready.",
  "I am going to take care of the pipes myself"
]) {
  assert.equal(hasUnitInfoRequestText(closeout), false, `must not read a unit-info ask in: ${closeout}`);
}
assert.equal(
  canApplyDispositionCloseout({
    conv: { id: "+16813891971", messages: [] },
    text: JAYDON,
    parsedAccepted: true,
    hasDecision: true,
    openTodos: []
  }),
  false,
  "a turn that asks for pictures and price must never close the lead, however confident the disposition parse"
);
assert.equal(
  canApplyDispositionCloseout({
    conv: { id: "z", messages: [] },
    text: "Money's just too tight right now, I've got to stop looking for a while.",
    parsedAccepted: true,
    hasDecision: true,
    openTodos: []
  }),
  true,
  "a genuine budget stop with no live ask still closes"
);

// ── OPEN SCHEDULING CONFLICT (William Indelicato +17163591526, 2026-07-24) ──────────────────
// msg_2e66f70720313_1784929050013. Scott spent four turns pinning down a service-visit day:
//   out: "Can you get here first thing in the morning on Wednesday?"
//   in:  "I can try I have an appointment at 9a on Wednesday"
//   out: "What time do you think you can be here on Wednesday?"
//   in:  "Unsure I have to have injections into my shoulder"
// That last turn parsed as stepping_back. Eleven seconds later the lead was CLOSED and
// followUp went paused_indefinite (reason "customer_stepping_back"), with the taper draft
// "I hear you. If anything changes down the road, just give me a shout." Staff overrode it
// with "Ok Let me know what day works best for you and I will try to accommodate".
//
// The signal is the inbound-reply-action parser's scheduling_conflict_open slot — it is the
// only scheduling parser that runs UNCONDITIONALLY, and the hint-gated appointment-timing /
// customer-ack parsers were both skipped on this turn (no weekday, no clock token).
const SHOULDER = "Unsure I have to have injections into my shoulder";
assert.equal(
  canApplyDispositionCloseout({
    conv: { id: "+17163591526", messages: [] },
    text: SHOULDER,
    parsedAccepted: true,
    hasDecision: true,
    openTodos: [],
    schedulingConflictOpen: true
  }),
  false,
  "an open scheduling negotiation must never close the lead, however confident the disposition parse"
);
// FAIL DIRECTION: the arm is ADDITIVE. With the flag off this turn still closes exactly as it
// does on main today — a parser false negative can only leave today's behavior, never regress
// something that worked. (That is what makes a parser signal admissible next to the
// deterministic KEEP arms, which must NOT be migrated.)
assert.equal(
  canApplyDispositionCloseout({
    conv: { id: "+17163591526", messages: [] },
    text: SHOULDER,
    parsedAccepted: true,
    hasDecision: true,
    openTodos: [],
    schedulingConflictOpen: false
  }),
  true,
  "flag off => unchanged behavior; the scheduling-conflict arm only ever ADDS a suppression"
);
// The veto suppresses the CLOSEOUT, it does not manufacture a decision: no decision, no close.
assert.equal(
  canApplyDispositionCloseout({
    conv: { id: "+17163591526", messages: [] },
    text: SHOULDER,
    parsedAccepted: true,
    hasDecision: false,
    openTodos: [],
    schedulingConflictOpen: true
  }),
  false,
  "no disposition decision => nothing to close, with or without the conflict veto"
);
// A real withdrawal is NOT a scheduling conflict and must still close (the parser is instructed
// to return false when the customer steps back) — otherwise this arm would make leads unclosable.
assert.equal(
  canApplyDispositionCloseout({
    conv: { id: "+17163591526", messages: [] },
    text: "I'll pass, I'm not doing it this year.",
    parsedAccepted: true,
    hasDecision: true,
    openTodos: [],
    schedulingConflictOpen: false
  }),
  true,
  "a genuine withdrawal mid-scheduling still closes"
);
assert.equal(
  shouldSuppressDispositionCloseout({ id: "+17163591526", messages: [] }, SHOULDER, {
    schedulingConflictOpen: true
  }),
  true,
  "the guard itself reads the scheduling-conflict arm"
);

// Wiring + parser pins.
const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
assert.ok(
  (apiSource.match(/openTodos: listOpenTodos\(\)/g) ?? []).length >= 3,
  "all disposition closeout gates must pass open todos"
);
const llmSource = await fs.readFile(path.resolve("services/api/src/domain/llmDraft.ts"), "utf8");
assert.match(
  llmSource,
  /I am going to take care of the pipes myself/,
  "disposition parser few-shots pin the production fixture"
);
assert.match(
  llmSource,
  /handling parts, accessories, pipes, installs, or service themselves/i,
  "disposition parser rules exclude self-service scope statements"
);
assert.match(
  llmSource,
  /Not-buying-now but still SUBSCRIBED, or with a live ask/,
  "disposition parser rules carve out the alert-keeper / live-ask turn"
);
assert.match(
  llmSource,
  /Could o see pictures of that 883 and the price/,
  "disposition parser few-shots pin the Jaydon Gerolimos production fixture"
);

// ---------------------------------------------------------------------------
// Production miss 2026-07-30 — Shad Stymus +17164208856. We asked "should I focus on new,
// used, or both? ... share your budget range"; he ANSWERED with criteria and was closed out.
// One level out from Jaydon: he asks us nothing, so no ask-shaped arm can catch it.
// ---------------------------------------------------------------------------
const SHAD =
  "Sorry been busy with work most likely used and the lowest monthly payments is the best for me at this moment as I have alot of hospital bills for my daughter which is not in the best health at the moment.  Thank you sincerely, Shad stymus.";

assert.equal(
  hasQualificationCriteriaAnswerText(SHAD),
  true,
  "the Shad production turn answers our qualifying question with buying criteria"
);
assert.equal(
  hasQualificationCriteriaAnswerText(
    "Sorry for the slow reply, work has been nuts. Probably used, and honestly the lowest monthly payment I can get is what matters most."
  ),
  true,
  "the criteria answer generalizes past the medical framing"
);
assert.equal(
  hasQualificationCriteriaAnswerText("Looking for a pre-owned Breakout if you get one in."),
  true,
  "a stated condition preference is a buying criterion"
);

// NEGATIVES — a bare defer, hardship, or apology with NO criteria must still close, or we
// would never stop texting a customer who asked us to.
for (const closeout of [
  "Not right now, please stop texting me.",
  "Money's just too tight right now, I've got to stop looking for a while.",
  "I'm not looking right now but I'll get a hold of you when I'm ready.",
  "I think I'm going to keep my bike and hold off for now.",
  "Sorry, been busy with work. I'll get back to you.",
  "I used to ride but not anymore.",
  "I ended up buying a used 2016 in Ohio. Thank you, I appreciate it."
]) {
  assert.equal(
    hasQualificationCriteriaAnswerText(closeout),
    false,
    `must not read a qualification answer in: ${closeout}`
  );
}

assert.equal(
  canApplyDispositionCloseout({
    conv: { id: "+17164208856", messages: [] },
    text: SHAD,
    parsedAccepted: true,
    hasDecision: true,
    openTodos: []
  }),
  false,
  "a turn that answers our own qualifying question with buying criteria must never close the lead, however confident the disposition parse"
);
assert.equal(
  canApplyDispositionCloseout({
    conv: { id: "z", messages: [] },
    text: "Not right now, please stop texting me.",
    parsedAccepted: true,
    hasDecision: true,
    openTodos: []
  }),
  true,
  "a clean stop-texting turn with no criteria still closes"
);

assert.match(
  llmSource,
  /Answering OUR qualifying question is ENGAGED/,
  "disposition parser rules carve out the answer-to-our-question turn"
);
assert.match(
  llmSource,
  /lowest monthly payments is the best for me at this moment/,
  "disposition parser few-shots pin the Shad Stymus production fixture"
);
assert.match(
  apiSource,
  /hasQualificationCriteriaAnswerText\(t\)/,
  "the health-update arm must not swallow a buying-criteria answer"
);

// BOTH PATHS (AGENTS.md law): live /webhooks/twilio, regenerate, and the human-mode arm must
// all feed the scheduling-conflict veto, or a lead closed on the live path would survive regen
// (or the reverse) and the two lanes would drift.
assert.ok(
  (apiSource.match(/schedulingConflictOpen: isSchedulingConflictStillOpen\(/g) ?? []).length >= 3,
  "all three disposition closeout gates (live + regen + human-mode) must pass the scheduling-conflict veto"
);
assert.match(
  apiSource,
  /schedulingConflictStillWilling: isSchedulingConflictStillOpen\(regenInboundReplyActionParse\)/,
  "the regen scheduling decision must read the same parser slot as live"
);
// The parser owns the comprehension — pin the production turn as a few-shot so a prompt edit
// cannot silently drop the lesson (AGENTS.md: fix a miss with few-shots + a fixture, not regex).
const inboundActionSource = await fs.readFile(
  path.resolve("services/api/src/domain/inboundReplyActionPrompt.ts"),
  "utf8"
);
assert.match(
  inboundActionSource,
  /Unsure I have to have injections into my shoulder/,
  "the inbound-reply-action few-shots pin the William Indelicato production turn"
);
assert.match(
  inboundActionSource,
  /my kid has a game that afternoon/,
  "a no-medical-words paraphrase keeps the lesson from being memorized off 'injections'"
);

console.log("PASS disposition close guard eval");
