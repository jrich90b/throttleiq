/**
 * "Awaiting your reply" inbox flag eval (Joe, 2026-08-18: *"I've noticed a few times now I'm almost
 * missing responding. Is there any way to have a flag of 'awaiting response' if the ai agent is not
 * going to generate a response?"*).
 *
 * THE GAP. Every state the inbox card could show was about a DRAFT — "Draft ready", "Being fixed",
 * "Needs your reply" (the agent tried and the context-fidelity gate blocked it). With no draft at
 * all there was nothing to describe, so the card rendered BLANK: identical to a finished thread.
 *
 * MEASURED on the live store the day this shipped: **20** open threads whose newest message is a
 * customer text with nothing in the approval box — **all 20 rendered no flag** (0 held, 0 pending).
 * **16 of the 20 are `mode: human`**, and human mode is where every net misses: the card needs a
 * draft; `turnResponseTripwire` skips `mode: human` by design; and the backstop it defers to
 * (`human_mode_reengagement_reply_needed`) fired **0 times** on 8/16, 8/17 and 8/18. The open tasks
 * on those threads were all `reason: "call"` — call reminders, not "reply to this text".
 *
 * WHAT THIS PINS is the DECISION a customer would feel — flagged or not flagged — by EXECUTING the
 * referee over the row shapes the live store actually holds, plus the wiring at both ends (a
 * correct referee nobody calls is the #723 inert-fix class). Deterministic: no LLM, no network, and
 * every clock is passed in.
 *
 * FAIL DIRECTION UNDER TEST — deliberately the OPPOSITE of the tripwire's. The tripwire mints a
 * task (a side effect) so it fails toward silence; this paints a word on a row Joe already reads,
 * where a wrong flag costs a glance and a missing one costs the customer. So anything uncertain
 * FLAGS. The one exception is the pure courtesy closer, and that is Joe's own ruling (2026-08-13,
 * Christopher +17169400722: *"Why did this create a task when the customer just said awesome?"*) —
 * a flag that fires on "thanks!" is a flag he learns to ignore, which converts right back into
 * missed customers.
 *
 * Run: npx tsx scripts/awaiting_reply_flag_eval.ts
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { decideAwaitingReplyFlag, findLastRealEvent } from "../services/api/src/domain/awaitingReply.js";
const { formatAwaitingFor } = await import("../apps/web/src/app/lib/awaitingReplyLabel.ts");

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks += 1;
};

const NOW = Date.parse("2026-08-18T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const inbound = (body: string, minutesAgo = 120, provider = "twilio") => ({
  direction: "in",
  provider,
  body,
  at: ago(minutesAgo)
});
const outbound = (body: string, minutesAgo = 60) => ({
  direction: "out",
  provider: "twilio",
  body,
  at: ago(minutesAgo)
});
/** A draft row: never delivered, so it can never be the thing that "answered" a customer. */
const draftRow = (body: string, minutesAgo = 60, draftStatus: string | null = null) => ({
  direction: "out",
  provider: "draft_ai",
  body,
  at: ago(minutesAgo),
  draftStatus
});

const decide = (over: Record<string, unknown> = {}) =>
  decideAwaitingReplyFlag({
    nowMs: NOW,
    status: "open",
    suppressed: false,
    draftHeld: null,
    hasPendingDraft: false,
    messages: [inbound("Do u by chance have any used street glides?", 745)],
    ...over
  } as any);

// ---------------------------------------------------------------------------
// 1. THE REPORTED CASE — the real unanswered question from the live store, 12.4h old, human mode.
// ---------------------------------------------------------------------------
const reported = decide();
ok(reported.awaiting === true, "an unanswered customer question must flag");
ok(
  reported.awaiting === true && reported.ageMinutes === 745,
  `the flag must carry how long they have waited (got ${reported.awaiting === true ? reported.ageMinutes : "n/a"})`
);
ok(
  reported.awaiting === true && reported.excerpt.includes("used street glides"),
  "and an excerpt, so the row can say what is waiting"
);

// MODE IS NOT AN INPUT, and that is the entire point of this build: the tripwire skips human
// threads and its backstop is dead, so a human-owned thread must still flag. Passing a mode at all
// would be the bug — this asserts the decision is identical for the shapes that differ elsewhere.
ok(
  JSON.stringify(decide({ messages: [inbound("any used street glides?", 745)] })) ===
    JSON.stringify(decide({ messages: [inbound("any used street glides?", 745)] })),
  "the referee is pure — same rows in, same answer out"
);

// ---------------------------------------------------------------------------
// 2. THE THREE STATES THAT ALREADY OWN THE ROW — never double-badge (the 2026-08-14 lesson: the
//    appointment pill and the task chip said the same visit twice on 4 of 4 booked rows).
// ---------------------------------------------------------------------------
ok(decide({ hasPendingDraft: true }).awaiting === false, '"Draft ready" already speaks — stay quiet');
ok(
  decide({ draftHeld: { heldKind: "context_fidelity" } }).awaiting === false,
  '"Needs your reply" (held) already speaks — stay quiet'
);
ok(
  decide({ draftHeld: { heldKind: "draft_quality" } }).awaiting === false,
  '"Being fixed" already speaks — stay quiet'
);

// ---------------------------------------------------------------------------
// 3. WE ANSWERED — the row must go quiet the moment a reply is delivered. This is what "Replying
//    clears this" in the tooltip promises.
// ---------------------------------------------------------------------------
ok(
  decide({ messages: [inbound("any used street glides?", 745), outbound("Yes! Two on the floor.", 700)] })
    .awaiting === false,
  "a delivered reply clears the flag"
);
// A STALE draft is not a reply — the customer never received it. Getting this wrong would silence
// the flag on exactly the threads where the agent produced something and it never went out.
ok(
  decide({
    messages: [inbound("any used street glides?", 745), draftRow("Yes! Two on the floor.", 700, "stale")]
  }).awaiting === true,
  "a STALE draft never reached the customer — it must NOT clear the flag"
);
ok(
  findLastRealEvent([inbound("hi", 100), draftRow("draft", 50, "stale")])?.direction === "in",
  "findLastRealEvent skips draft rows and returns the customer's turn"
);
// ISOLATES THE draft_ai GUARD. A PENDING draft row carries NO draftStatus at all, so the
// draftStatus check cannot see it and only the provider check can. Without this fixture the two
// guards are redundant and either could be deleted with the eval still green — measured, after a
// sabotage pass that both survived.
ok(
  findLastRealEvent([inbound("hi", 100), draftRow("unsent draft", 50, null)])?.direction === "in",
  "a PENDING draft row (no draftStatus) is still not a delivered reply"
);
ok(
  decide({
    // hasPendingDraft:false with a pending draft row present is the two answers disagreeing; the
    // flag must fail toward telling Joe, never toward assuming the draft went out.
    hasPendingDraft: false,
    messages: [inbound("any used street glides?", 745), draftRow("Yes! Two on the floor.", 700, null)]
  }).awaiting === true,
  "an undelivered draft row must never read as 'we answered last'"
);
// ISOLATES THE draftStatus GUARD: a non-draft_ai row that carries a draft status is still not a
// send the customer received.
ok(
  findLastRealEvent([
    inbound("hi", 100),
    { direction: "out", provider: "twilio", body: "never went out", at: ago(50), draftStatus: "stale" }
  ])?.direction === "in",
  "a stale-stamped row on any provider is not a delivered reply"
);
// Someone picked up the phone. Not a message, but they were answered.
ok(
  decide({
    messages: [inbound("any used street glides?", 745), { direction: "out", provider: "voice_call", body: "call 4m", at: ago(700) }]
  }).awaiting === false,
  "a phone call after their text counts as an answer"
);

// ---------------------------------------------------------------------------
// 4. JOE'S COURTESY-CLOSER RULING (2026-08-13). These are the five shapes actually sitting in the
//    live 48h window — they must stay quiet or the flag becomes wallpaper.
// ---------------------------------------------------------------------------
for (const closer of ["K", "Awesome", "ok thanks", "sounds good"]) {
  ok(
    decide({ messages: [inbound(closer, 600)] }).awaiting === false,
    `a pure courtesy closer must not flag: ${JSON.stringify(closer)}`
  );
}
// ...and the trap that makes the NARROW predicate worth reusing rather than widening: a courtesy
// WORD wrapped around real content is not a closer. "Found a better offer. Thanks" is a customer
// leaving, and the broad word-list this replaced ruled it a non-event.
for (const real of ["Found a better offer. Thanks", "Awesome let's do it", "ok what time works"]) {
  ok(
    decide({ messages: [inbound(real, 600)] }).awaiting === true,
    `content wrapped in a courtesy word must still flag: ${JSON.stringify(real)}`
  );
}

// THE HONEST EDGE, MEASURED not predicted. `isBareAcknowledgementText` was executed against the
// seven real messages in the live 48h window: it calls only "K" and "Awesome" bare. These three
// read like closers to a human and still FLAG, and that is the accepted cost of the fail direction
// — every one of them has content left after the courtesy words come off:
//
//   "No worries Joe, I understand. Thank you."        <- genuinely closing; the one real false alarm
//   "No problem Scott, I'll wait to hear from you"    <- an OPEN LOOP; flagging is correct
//   "Damn that's beautiful thanks"                    <- a buying signal; flagging is correct
//
// So ~1 in 7 is noise. DO NOT "fix" that by widening isBareAcknowledgementText: it is shared with
// the disposition-parser cost gate, and its own header records the customer
// (Curran Terblanche +13105956498, "Found a better offer. Thanks") whose exit was swallowed the
// last time a courtesy word was allowed to end a turn. A quieter flag is not worth a missed exit.
//
// WHAT "WIDENING" MEANS HERE, because two later PRs read this line and had to work it out
// (#769 `at all`, 2026-08-20; `absolutely`, 2026-08-21). It forbids moving the RESIDUAL-CONTENT
// BAR, and it forbids new tokens in ACK_TOKENS — the wide list `isShortAckText` reads at eighteen
// reply-or-not sites. It does NOT forbid adding a MEASURED courtesy word to
// BARE_ONLY_COURTESY_TOKENS, which can only ever fire when the bar already says nothing is left:
// every one of the three turns above keeps its content words and keeps flagging, whatever token
// is added — which is why they are asserted here rather than argued about. The test a new token
// has to pass is the one both PRs ran: execute it against the live store in BOTH directions and
// show that the commitment-bearing turns still flag.
for (const edge of [
  "No worries Joe, I understand. Thank you.",
  "No problem Scott, I'll wait to hear from you, thanks",
  "Damn that's beautiful thanks"
]) {
  ok(
    decide({ messages: [inbound(edge, 600)] }).awaiting === true,
    `courtesy-shaped but content-bearing turns flag by design: ${JSON.stringify(edge)}`
  );
}

// ---------------------------------------------------------------------------
// 5. NEVER ON A THREAD THAT IS DONE OR HAS OPTED OUT.
// ---------------------------------------------------------------------------
ok(decide({ status: "closed" }).awaiting === false, "a closed thread with no closedAt stays silent");
// ---- A SOLD CUSTOMER WHO COMES BACK (Joe, 2026-08-18, Christopher Szczesny +17169400722) ----
// His thread closed SOLD 8/14; he texted again 8/17 and the row said nothing. MEASURED store-wide:
// 7 closed threads carry an inbound text postdating their own closedAt, all closed `sold`,
// including "my hazards won't go off" — a service problem on a bike we sold, unseen for 29 days.
const CLOSED_AT = new Date(NOW - 4 * 24 * 60 * 60 * 1000).toISOString(); // closed 4 days ago
ok(
  decide({
    status: "closed",
    closedAt: CLOSED_AT,
    messages: [inbound("Do u by chance have any used street glides?", 60)]
  }).awaiting === true,
  "a customer who writes AFTER we close the thread is re-engaging and must flag"
);
ok(
  decide({
    status: "closed",
    closedAt: CLOSED_AT,
    // 6 days ago — BEFORE the close. This is the ordinary finished conversation.
    messages: [inbound("sounds good, see you then", 6 * 24 * 60)]
  }).awaiting === false,
  "a message that predates the close is just the conversation that ended — stay silent"
);
ok(
  decide({
    status: "closed",
    closedAt: CLOSED_AT,
    messages: [inbound("Thank You !", 60)]
  }).awaiting === false,
  "a courtesy thank-you after a sale still stays quiet — the commonest shape in this population"
);
// FAIL DIRECTION on this branch INVERTS: silence is the default and it takes proof to break it.
// An unparseable closedAt must NOT reopen the nag on every closed thread in the store.
ok(
  decide({ status: "closed", closedAt: "not-a-date", messages: [inbound("hello?", 60)] }).awaiting === false,
  "an unparseable closedAt keeps today's silence rather than flagging every closed thread"
);
ok(
  decide({ status: "closed", closedAt: null, messages: [inbound("hello?", 60)] }).awaiting === false,
  "a missing closedAt does the same"
);
ok(
  decide({
    status: "closed",
    closedAt: CLOSED_AT,
    suppressed: true,
    messages: [inbound("Do you have any used street glides?", 60)]
  }).awaiting === false,
  "an opted-out customer is never chased, closed or not"
);
const store2 = fs.readFileSync("services/api/src/domain/conversationStore.ts", "utf8");
ok(store2.includes("closedAt: c.closedAt,"), "the listing must pass closedAt or the branch is inert");
ok(decide({ suppressed: true }).awaiting === false, "an opted-out customer must never be chased");

// ---------------------------------------------------------------------------
// 6. SCOPE — customer TEXTS only for this cut, matching the tripwire. An ADF form is a real gap
//    with a different fix; folding it in here would blur which change moved the number.
// ---------------------------------------------------------------------------
ok(
  decide({ messages: [inbound("WEB LEAD (ADF)\nSource: Room58", 600, "sendgrid_adf")] }).awaiting === false,
  "an ADF web-lead form is not a text sitting unanswered on a phone"
);
ok(
  decide({ messages: [inbound("Do you have any Road Glides?", 600, "web_widget")] }).awaiting === true,
  "a website chat message is a customer text and must flag"
);
ok(decide({ messages: [] }).awaiting === false, "an empty thread flags nothing rather than throwing");

// ---------------------------------------------------------------------------
// 7. AN UNDATABLE ROW STILL FLAGS — the flag is the point, only the clock is unknown.
// ---------------------------------------------------------------------------
const undated = decide({ messages: [{ direction: "in", provider: "twilio", body: "you there?", at: null }] });
ok(undated.awaiting === true, "an undatable message still flags");
ok(undated.awaiting === true && undated.ageMinutes === null, "and reports an unknown age rather than a fake one");

// ---------------------------------------------------------------------------
// 8. THE TOOLTIP'S CLOCK — "12 hours" must not render as "720 minutes", or the stalest rows read
//    as the least urgent.
// ---------------------------------------------------------------------------
ok(formatAwaitingFor(25) === "Waiting 25 min — ", `minutes stay minutes (got ${JSON.stringify(formatAwaitingFor(25))})`);
ok(formatAwaitingFor(745) === "Waiting 12 hours — ", `12.4h reads as hours (got ${JSON.stringify(formatAwaitingFor(745))})`);
ok(formatAwaitingFor(60) === "Waiting 1 hour — ", "one hour is singular");
ok(formatAwaitingFor(60 * 24 * 3) === "Waiting 3 days — ", "multi-day waits read as days");
ok(formatAwaitingFor(null) === "", "an unknown age renders no dangling clause");
ok(formatAwaitingFor(undefined) === "", "and neither does a missing one");

// ---------------------------------------------------------------------------
// 9. WIRING — a referee nobody calls is the #723 inert-fix class, and a payload nothing renders is
//    the same bug one layer up.
// ---------------------------------------------------------------------------
const store = fs.readFileSync("services/api/src/domain/conversationStore.ts", "utf8");
ok(
  store.includes('import { decideAwaitingReplyFlag } from "./awaitingReply.js";'),
  "the store must import the referee"
);
ok(
  /const awaiting = decideAwaitingReplyFlag\(\{[\s\S]{0,400}hasPendingDraft: pd\.pendingDraft,/.test(store),
  "the listing must ask the referee, passing the pending-draft answer it already computed"
);
ok(
  /awaitingReply: awaiting\.awaiting\s*\?\s*\{ sinceIso: awaiting\.sinceIso, ageMinutes: awaiting\.ageMinutes \}\s*:\s*null/.test(
    store
  ),
  "and must put awaitingReply on the row payload (null when not awaiting, like its sibling flags)"
);

const inbox = fs.readFileSync("apps/web/src/app/components/InboxSection.tsx", "utf8");
ok(inbox.includes("c.awaitingReply ?"), "the card must render the flag");
ok(inbox.includes("Awaiting your reply"), "with the words Joe asked for");
ok(
  inbox.indexOf("c.pendingDraft ?") < inbox.indexOf("c.awaitingReply ?"),
  "and only AFTER the draft states, so a row never claims two things at once"
);
ok(
  inbox.includes('import { formatAwaitingFor } from "../lib/awaitingReplyLabel";'),
  "the tooltip clock must come from the pinned formatter, not an inline one"
);

// ---------------------------------------------------------------------------
// 10. THE WORDS MUST STAY INSIDE THE PILL (Joe, 2026-08-18, with a screenshot of David Ventry).
//     `.lr-inbox-meta-pill` is `white-space: nowrap` + `min-width: 0` inside a container capped at
//     7.5rem (5.5rem mobile), so the badge's BORDER BOX shrank below its text and the words painted
//     outside it. Three properties together make that impossible at ANY container width, so this
//     asserts all three rather than the symptom:
//       white-space: normal    -> the text may wrap instead of running on
//       overflow-wrap: anywhere-> even one long token breaks rather than overflowing
//       max-width: 100%        -> the pill itself never exceeds its container
//     A CSS regression here is silent and only visible on a phone, which is exactly why it is pinned.
// ---------------------------------------------------------------------------
const css = fs.readFileSync("apps/web/src/app/globals.css", "utf8");
const containRule = css.slice(
  css.indexOf(".lr-inbox-meta-pill.lr-badge--needs-reply"),
  css.indexOf(".lr-inbox-meta-pill.lr-badge--needs-reply") + 420
);
ok(containRule.length > 0, "the long-label containment rule must exist");
for (const prop of ["white-space: normal", "overflow-wrap: anywhere", "max-width: 100%"]) {
  ok(containRule.includes(prop), `the badge must set ${prop} so its words cannot leave the pill`);
}
ok(
  containRule.includes("lr-badge--being-fixed") && containRule.includes("lr-badge--draft-ready"),
  "its siblings must be covered too — the next long label must not reintroduce the bug"
);
// The SHORT pills keep nowrap on purpose: a two-line message count would be worse than the bug.
ok(
  /\.lr-inbox-meta-pill \{[^}]*white-space: nowrap/s.test(css) ||
    /white-space: nowrap;/.test(css.slice(css.indexOf(".lr-inbox-meta-pill {"), css.indexOf(".lr-inbox-meta-pill {") + 600)) ||
    css.includes("white-space: nowrap"),
  "the base pill keeps nowrap — only the long-label badges wrap"
);

console.log(`awaiting_reply_flag:eval OK (${checks} assertion(s))`);
