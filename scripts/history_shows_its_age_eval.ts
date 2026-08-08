/**
 * history_shows_its_age:eval — the draft must be able to tell May from this morning.
 *
 * FOUND BY JOE, 2026-08-08, reading one draft and asking "was there something in the conversation
 * that he wanted to come in Saturday?" There was — from THREE MONTHS EARLIER, before he bought the
 * bike. Curtis Coshun (+17164005844):
 *
 *   05-14 us:  "where you thinking about coming in tomorrow or Saturday?"
 *   05-14 him: "first thing Saturday for sure, if not!"
 *   05-18 ---- he buys the bike ----
 *   07-17 him: "absolutely loving it, took short day today at work to go out for a ride"
 *   07-17 draft: "...confirm Saturday morning and I'll make sure the bike's ready to look over"
 *
 * ROOT CAUSE: a history turn is `{direction, body}`. It carries NO timestamp, so every message in
 * the thread looks equally current. On the live store this is not a corner case — of 774
 * conversations with 2+ messages, 441 (57%) have a last-20 window spanning more than 30 days,
 * 102 span more than 90, median window 40 days; 63 of 71 sold leads carry pre-purchase talk.
 *
 * A/B on Curtis's real thread, 3 runs each: unstamped produced the Saturday phantom 3/3 (one draft
 * inventing "I'll have Gio text tomorrow morning to lock a time"); stamped, 0/3.
 *
 * Stamping is chosen over TRUNCATION on purpose: cutting old turns would also drop which bike, the
 * budget, and what we have already said — trading a phantom for a forgetful agent.
 *
 * Run: npx tsx scripts/history_shows_its_age_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const { buildEffectiveHistory, formatHistoryTurnAge, HISTORY_AGE_STAMP_MIN_DAYS } = await import(
  "../services/api/src/domain/effectiveContext.ts"
);

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks += 1;
};

const DAY = 86_400_000;
const now = Date.parse("2026-07-17T14:31:42.835Z");

// --- 1) The age words, and the quiet zone. A same-day thread must be untouched.
for (const days of [0, 1, 3, 6]) {
  assert.equal(
    formatHistoryTurnAge(now - days * DAY, now),
    null,
    `${days} days is still "current" — stamping it would be noise on every ordinary thread`
  );
  checks += 1;
}
ok(/days ago/.test(String(formatHistoryTurnAge(now - 8 * DAY, now))), "8 days reads in days");
ok(/weeks ago/.test(String(formatHistoryTurnAge(now - 30 * DAY, now))), "a month reads in weeks");
ok(/months ago/.test(String(formatHistoryTurnAge(now - 64 * DAY, now))), "two months reads in months");
assert.equal(HISTORY_AGE_STAMP_MIN_DAYS, 7, "the quiet zone is a week — changing it changes every thread");
checks += 1;
// Junk must never produce a stamp rather than throwing or printing NaN at a customer.
for (const [a, b] of [[NaN, now], [now, NaN], [0, 0]] as [number, number][]) {
  assert.equal(formatHistoryTurnAge(a, b), null, "unusable timestamps yield no stamp");
  checks += 1;
}

// --- 2) THE REAL THREAD. Curtis's own messages are the fixture.
const conv: any = {
  id: "+17164005844",
  lead: { firstName: "Curtis" },
  messages: [
    { direction: "out", provider: "twilio", at: "2026-05-14T17:56:12.149Z", body: "where you thinking about coming in tomorrow or Saturday?" },
    { direction: "in", provider: "twilio", at: "2026-05-14T17:58:46.415Z", body: "But first thing Saturday for sure, if not!" },
    { direction: "out", provider: "twilio", at: "2026-07-17T14:30:12.356Z", body: "Hope you're enjoying the Ultra Classic!" },
    { direction: "in", provider: "twilio", at: "2026-07-17T14:31:42.835Z", body: "absolutely loving it, took short day today at work to go out for a ride" }
  ]
};

const plain = buildEffectiveHistory(conv, 20);
ok(
  plain.every(t => !/^\[\d+ (days|weeks|months) ago\]/.test(t.body)),
  "UNSTAMPED by default — the comprehension parsers read this same history and are tuned to its shape"
);

const stamped = buildEffectiveHistory(conv, 20, { stampAges: true });
assert.equal(stamped.length, plain.length, "stamping must not add or drop turns — no context is lost");
checks += 1;
ok(
  /^\[2 months ago\] where you thinking about coming in tomorrow or Saturday\?$/.test(stamped[0].body),
  `the May turn must carry its age — got ${JSON.stringify(stamped[0].body)}`
);
ok(
  /^\[2 months ago\] But first thing Saturday for sure/.test(stamped[1].body),
  "and so must HIS May answer — that is the sentence the draft was reading back to him"
);
ok(
  !/^\[/.test(stamped[2].body) && !/^\[/.test(stamped[3].body),
  "today's turns stay clean — the stamp marks what is OLD, it does not decorate everything"
);
ok(
  stamped[3].body.includes("absolutely loving it"),
  "and every word of the actual message survives"
);

// --- 3) WIRING, COUNTED. Both draft paths, and the parsers deliberately left alone.
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const draftSites = (index.match(/buildDraftHistory\(conv, 20\)/g) ?? []).length;
assert.equal(
  draftSites,
  2,
  `both the live and regenerate draft paths must use the stamped history; found ${draftSites}`
);
checks += 1;
ok(
  /safeOrchestrateInbound\("twilio_inbound", event, buildDraftHistory\(conv, 20\)/.test(index),
  "the LIVE draft path receives stamped history"
);
ok(
  /safeOrchestrateInbound\("regen", event, buildDraftHistory\(conv, 20\)/.test(index),
  "the REGENERATE draft path receives it too — the two must not drift"
);
ok(
  /function buildHistory\(conv: any, limit = 20\) \{\s*\n\s*return buildEffectiveHistory\(conv, limit\);/.test(index),
  "buildHistory stays UNSTAMPED — stamping every consumer would be a change to 87 parsers dressed up as a context fix"
);

console.log(`history_shows_its_age:eval OK (${checks} checks)`);
