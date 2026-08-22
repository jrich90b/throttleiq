/**
 * The quiet-thread nudge's prompt surface (extracted from llmDraft.ts, 2026-08-21).
 *
 * Lives on its own for the reason every other `*Prompt.ts` in this directory does: llmDraft.ts is
 * the second-largest file in the repo and every parser prompt that stays inline makes the next one
 * harder to find. Extracting it also lets `human_thread_nudge:eval` assert the ACTUAL prompt string
 * instead of grepping a character-window of llmDraft.ts source — a window that had silently stopped
 * covering the end of this prompt (see the eval's compEnd note).
 *
 * WHAT THE NUDGE IS: a rep has been texting a customer personally and the customer went quiet. The
 * bump continues the REP's own thread in the rep's voice — no persona intro, no new facts. It lands
 * as a suggest-mode draft. `humanThreadNudge.ts` owns WHETHER to bump; this owns WHAT it says.
 */

import { PAST_EVENT_GUARD_DEFAULT_TIMEZONE } from "./pastEventGuard.js";
import { describeThreadLineAge, formatThreadLineStamp } from "./threadRecency.js";

export interface HumanThreadNudgePromptArgs {
  firstName?: string | null;
  /** The last few DELIVERED thread messages, oldest first — already filtered and capped. */
  recentMessages: { direction: "in" | "out"; body: string; at?: string | null }[];
  /** The instant the bump is being written. Absent ⇒ lines render undated (see the note below). */
  nowMs?: number;
  /** The dealership's zone. Defaults to the same constant the lane's past-event guard uses. */
  timeZone?: string;
}

export function buildHumanThreadNudgePrompt(args: HumanThreadNudgePromptArgs): string {
  const firstName = String(args.firstName ?? "").trim();
  // MEASURED 2026-08-22 on William Higgins +17165233086. On 8/18 he said "I could get there about
  // 3pm if that works" and Scott answered "That should work!". THREE DAYS LATER this lane drafted
  // "Still good for about 3pm today, William — want me to hold it and have paperwork ready when you
  // arrive?" — asserting a three-day-old time as if it were happening today, on a thread carrying
  // NO appointment at all. Replayed against the real anchors, the undated prompt reproduced it
  // 4 times in 6, once almost word for word.
  //
  // CAUSE: the call site had `at` on every anchor and mapped it away, so eight messages spanning
  // four days rendered as one continuous exchange. Same defect the draft REVIEWER was fixed for on
  // 8/21 (`7ef1cb29`) — and it bites harder here, because the nudge is the one composer that BY
  // DEFINITION only ever fires after the thread has gone quiet for days.
  const nowMs = Number(args.nowMs);
  const datable = Number.isFinite(nowMs);
  // The box runs UTC and the dealership does not, so an unzoned stamp is off by hours and can be
  // off by a DAY. Same constant `referencesPastDatedEvent` uses on this lane's composed text.
  const timeZone = String(args.timeZone ?? "").trim() || PAST_EVENT_GUARD_DEFAULT_TIMEZONE;
  const historyLines = (args.recentMessages ?? []).map(m => {
    const who = m.direction === "in" ? "Customer" : "Rep";
    const when = datable ? formatThreadLineStamp(m.at, nowMs, timeZone) : "";
    return `${who}${when}: ${String(m.body).replace(/\s+/g, " ").slice(0, 220)}`;
  });
  // How long the thread has actually been dead, stated as a number rather than "a few days". The
  // stamps alone were measurably not enough: with per-line dates but this line still vague, the
  // composer went on asserting "3pm today" in 2 of 6 replays. The gap has to be the first thing
  // it reads, because the gap is the whole reason this lane exists.
  const lastAtMs = (() => {
    const stamps = (args.recentMessages ?? [])
      .map(m => Date.parse(String(m.at ?? "")))
      .filter(ms => Number.isFinite(ms));
    return stamps.length ? Math.max(...stamps) : NaN;
  })();
  const gapDays = datable && Number.isFinite(lastAtMs) ? describeThreadLineAge(lastAtMs, nowMs, timeZone) : "";
  return [
    datable && gapDays
      ? `A dealership REP has been personally texting this customer. NOTHING HAS BEEN SAID IN THIS THREAD SINCE ${gapDays.toUpperCase()} — the last line below is ${gapDays}, not a live exchange you are joining.`
      : "A dealership REP has been personally texting this customer. The customer went quiet a few days ago.",
    "Write ONE short bump that CONTINUES the rep's own thread — it must read as the rep circling",
    "back, picking up exactly where the conversation left off.",
    "",
    "HARD RULES:",
    "- You ARE the rep continuing their own thread. NEVER introduce yourself, NEVER sign a name, no",
    '  "this is X from the dealership", no persona switch.',
    "- Anchor on where the conversation actually left off — REFER to the topic in a few words, do",
    "  NOT re-explain it. The customer already read what the rep sent.",
    // Joe, 2026-08-21, on Michael Layman +15856894382: "the nudge really should not repeat what was
    // already relayed to the customer". Scott texted the HDFS 30-day / hard-inquiry explanation on
    // 8/18; the bump three days later restated that same explanation almost sentence for sentence.
    // CAUSE: "anchor on the last thing sent" + "zero new facts" left RESTATING it as the
    // lowest-effort output satisfying both rules — the prompt was steering into the defect.
    //
    // Fixed HERE rather than with a lexical suppressor downstream: measured across all 29 live
    // nudge threads, word-overlap cannot separate re-explaining a policy (the defect) from chasing
    // a document we already asked for (the lane working — +17166090270 title pics, +17164728139
    // driver's licence). Only something that understands the sentence can tell those apart.
    "- ADVANCE, NEVER RESTATE. Do not repeat, re-explain, paraphrase or summarise anything the rep",
    "  ALREADY said in this thread — a policy, a price, a timeline, how something works, what we can",
    "  or cannot do. If the rep already explained it, the bump's job is to ask what the customer",
    "  wants to DO about it. WRONG: re-stating the finance rule the rep explained on Monday. RIGHT:",
    '  "Did you want me to go ahead and get that application started?"',
    "- Chasing something we ASKED FOR is not restating: if the rep requested a document, a photo or a",
    "  number and it never arrived, asking for it again IS the bump's job. Keep it to the ask.",
    // The rule below exists because "ZERO new facts" did NOT cover this. In the William Higgins
    // failure the 3pm was genuinely in the thread — the model invented only the DAY, which no rule
    // named. A stored time and a stored day are separable, and only the time was protected.
    ...(datable
      ? [
          "- EVERY LINE BELOW IS STAMPED WITH WHEN IT WAS SENT, AND THE DATES ARE REAL. A day or time",
          "  the thread agreed on days ago does NOT carry forward to today on its own. Never say a",
          "  stored time is happening \"today\", \"still on\", or \"all set\" — that is a fact about TODAY",
          "  that nobody stated, even when the time itself came from the thread. If a plan was left",
          "  open days back, the bump RE-OPENS it (\"did you still want to come grab it this week?\"),",
          "  it never asserts it. Do not name a specific day or time the customer has not confirmed",
          "  since."
        ]
      : []),
    "- ZERO new facts: no prices, payments, availability, dates, appointment times, or specs the rep",
    "  did not already state. A bump asks or offers — it never informs. Between this rule and the one",
    "  above you add nothing new AND repeat nothing old, so the bump is almost entirely a QUESTION",
    "  about the next step.",
    "- Match the rep's own tone from the thread (casual, contractions). 1-2 short sentences, no",
    '  exclamation-mark spam, no "just checking in!" filler phrasing, no "Reply STOP".',
    firstName
      ? `- The customer's first name is ${firstName}; use it naturally or not at all.`
      : "- The customer's name is unknown — do not invent one.",
    "",
    "Examples:",
    'thread ends: Rep sent a dyno sheet, customer said "Awesome" then went quiet -> {"nudge":"Any thoughts since you looked over that dyno sheet? Happy to dig up anything else on the Breakout."}',
    'thread ends: Rep said the trike order timeline, customer went quiet -> {"nudge":"Wanted to circle back on the trike — still want me to keep that build moving for you?"}',
    'thread ends: Customer asked about trade value, rep answered, quiet since -> {"nudge":"Been thinking it over? If the trade numbers helped, I can line up a time for you to swing in whenever works."}',
    // The counter-example is the real 8/21 failure, verbatim, so the model sees the exact shape it
    // produced. A rule the model can recite but not apply is worth less than one bad example.
    "thread ends: Rep explained he cannot pull a credit app from another dealer but can submit a new one to HDFS within 30 days without a second hard inquiry, customer went quiet",
    '  -> WRONG {"nudge":"We can\'t pull the app from the other dealer, but if it was submitted to HDFS within the last 30 days we can submit a new one without another hard inquiry. Want me to get that started?"} (that just re-reads the rep\'s own message back to him)',
    '  -> RIGHT {"nudge":"Still want me to get that application going on our end? Takes me two minutes if you are good with it."}',
    // The chase, so "never restate" cannot be over-applied into silence on the threads where a bump
    // is most useful. This pair is the live +17164728139 exchange.
    "thread ends: Rep asked for the co-buyer's driver's licence number to run the approval, customer went quiet",
    '  -> RIGHT {"nudge":"Still need that licence number to run the approval — able to send it over?"} (asking again for something that never arrived is the job, not a restatement)',
    // The real 8/21 failure, verbatim, for the same reason the restatement counter-example is here.
    ...(datable
      ? [
          "thread ends: Customer said days ago he could get there about 3pm and the rep said that should work; quiet since, nothing booked",
          '  -> WRONG {"nudge":"Still good for about 3pm today — want me to hold it and have paperwork ready when you arrive?"} (the 3pm was days ago; "today" is invented, and nothing was ever booked)',
          '  -> RIGHT {"nudge":"Never did catch up with you on picking it up — what day works this week?"}'
        ]
      : []),
    "",
    datable ? "The thread (oldest first, each line stamped with when it was sent):" : "The thread (oldest first):",
    ...historyLines,
    "",
    'Return only JSON: { "nudge": "<the SMS text>" }'
  ].join("\n");
}
