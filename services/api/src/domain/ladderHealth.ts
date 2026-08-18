/**
 * LADDER HEALTH — is each lead lane still ADVANCING leads? (Joe, 2026-08-11.)
 *
 * WHY THIS EXISTS, and why the existing nets could not do it. The loop's three detection nets all ask
 * the same shape of question — *was this reply WRONG?* `conversation_outcome_audit` hunts state that
 * contradicts itself; `open_critic_sweep` asks "did we mishandle this lead?"; `intent_handled_audit`
 * asks "did we answer the right thing?". **A broken ladder is none of those.** A lead that never gets
 * asked anything has perfectly consistent state and a polite, on-topic reply. You only see the problem
 * when you count forty of them.
 *
 * MEASURED, and this is the whole argument: on 2026-08-11 the loop's work queue was EMPTY while
 * 35 of 37 walk-in first touches asked nothing, 11 approved credit applications had booked zero, and
 * 8% of active conversations were repeating a question word for word. Months of it, invisible, because
 * every net was per-conversation and every individual reply looked fine.
 *
 * The readiness bar cannot cover it either: one lane going dark is ~40 leads inside a 500-lead
 * average, a fraction of a percent.
 *
 * WHAT THIS IS: a COUNT, not a judgement. No LLM, no taxonomy — "how many of this lane's first touches
 * asked the customer anything, and how does that compare with the lane's own history?" A lane that
 * drops from 90% asking to 5% is unmistakable and needs nobody's opinion.
 *
 * THE THREE ALARMS, and why they are separate — each sends you to a different building:
 *   `ask_rate_collapsed` — the lane USED to ask and stopped. A regression; reproduce it, then fix code.
 *   `never_asks`         — the lane likely never had a ladder. A build candidate; write the copy.
 *   `uncontactable`      — the leads carry no phone and no email. Neither of the above: no wording
 *                          change can reach someone with no address, so the fix is upstream in the
 *                          vendor feed. Added 2026-08-11 after `never_asks` sent a run hunting for
 *                          missing copy on AutoDealers.Digital, whose 18 leads had nobody to send to.
 *   `staff_owned_first_touch` — a salesperson gets the first word on most of this lane. Our copy is
 *                          not what these customers read, so writing more of it cannot move the
 *                          number. Added 2026-08-12; see "WHOSE FIRST TOUCH" below.
 *
 * ## WHOSE FIRST TOUCH, AND WAS IT EVER SENT (2026-08-12)
 *
 * The ask rate exists to answer *"does OUR LADDER advance this lane?"*. As first written it answered a
 * looser question — *"did the first outbound ROW in the array ask anything?"* — and three populations
 * rode in on that looseness. All three drag the rate DOWN, so the instrument fails toward false
 * alarms rather than false silence; but a run sent to write copy for a lane whose number copy cannot
 * move is a tick spent in the wrong building, which is the exact failure #663 was about.
 *
 * MEASURED on the live store, 30-day window (173 leads), and the 60 days before it (327):
 *
 * - **A draft is not a touch.** `draft_ai` is the first outbound row on **108 of ~475 leads in 90
 *   days** — 23%. A `draft_ai` row is a draft in the approval box; when it is approved and sent it is
 *   re-recorded as `twilio`. So the row the sweep graded was, for a fifth of all leads, a message the
 *   customer never received. Same class as the cadence referee counting a stale draft as a delivered
 *   touch. Baseline Dealer Lead App read 0/32 asking on the old selection and 3/19 on the agent's own
 *   delivered first touches — a different answer to the question we meant to ask.
 * - **A salesperson's own text is not our ladder.** Staff type into the same thread from the console.
 *   `isStaffAuthoredOutbound` (the settled convention for every other scorer — the marker's PRESENCE
 *   proves a human sent it, its absence proves nothing) says 5 of 23 recent Traffic Log Pro first
 *   touches were typed by staff, one of them a bare parts URL that duly scored as "asked nothing".
 *   In the baseline window the unsourced lane ran **19 staff-typed against 2 agent-owned**.
 * - **A lead nobody texted is not a ladder that failed.** 4 of 23 recent Traffic Log Pro leads
 *   received no customer-facing message at all.
 *
 * An agent draft that staff EDITED before sending stays AGENT-owned: the agent wrote the rung, and if
 * it shipped without an ask that is ours. That split is what settled the lane this change came from —
 * of 23 Traffic Log Pro first touches, 5 were pure agent sends, 9 agent drafts staff edited, 5
 * staff-typed and 4 never sent; **0 of the 14 agent-owned asked anything, and only 1 of the 9 original
 * drafts did before staff touched it.** So the lane's `never_asks` alarm is TRUE and survives this
 * change — the count moves from 0/23 to 0/14, and the build candidate is still the copy.
 *
 * That is the outcome to want from an instrument fix: it sharpens the number without erasing the
 * finding. If sharpening a count makes a finding vanish, re-read the finding before believing it.
 *
 * FAIL DIRECTION: it only ever REPORTS. It cannot hold a reply, change a route, or fail a deploy. The
 * worst a false alarm costs is one person reading one line.
 */

// ONE OWNER for "did a human type this?". `scoringExclusions` has carried that predicate since
// 2026-07-23 and its own header records why a second hand-maintained copy is the bug: the copies
// drift, and only one of them learns. Fail-safe by construction — the author marker's PRESENCE proves
// a human sent it; its ABSENCE proves nothing and is never used to skip.
import { isStaffAuthoredOutbound } from "./scoringExclusions.js";

export type LadderWindowCounts = {
  leads: number;
  /** Agent-owned first touches that asked the customer something. Denominator is `agentFirstTouches`. */
  asked: number;
  replied: number;
  booked: number;
  /**
   * Leads carrying a phone number or an email address — i.e. someone we can actually reach.
   *
   * Counted because a lane can score 0% asked for three completely different reasons, and the fix is
   * in a different building for each: no ladder (write one), nobody to send it to (a broken feed), or
   * a RELAY lane where no channel is supposed to exist and a rep answers off-channel (nothing to fix
   * — see RELAY_LANES).
   */
  contactable: number;
  /**
   * RELAY lanes only: leads whose staff task exists — the relay lead's entire outreach. Left at 0 on
   * every other lane, and reported as UNKNOWN when the caller supplies no todo list.
   */
  relayHandedToStaff: number;
  /**
   * First touches the AGENT owns — a message it sent, or a draft it wrote that staff edited before
   * sending. This is the ask rate's denominator: the only population our copy can move.
   */
  agentFirstTouches: number;
  /**
   * First touches a staff member typed from scratch. Counted and reported, never graded — see
   * `staff_owned_first_touch`.
   */
  staffFirstTouches: number;
  /**
   * Agent-owned first touches delivered at or after this lane's declared fix boundary — i.e. the
   * only turns that can say anything about whether the shipped ladder works. Left at 0 on every
   * lane with no boundary declared, where it is never read. See `LADDER_FIX_BOUNDARIES`.
   */
  agentFirstTouchesSinceFix: number;
  /**
   * Leads that never received a customer-facing message at all. NOT a ladder failure: a rung that was
   * never sent cannot ask anything, and the fix is upstream of the wording.
   */
  neverTexted: number;
};

export type LadderLaneHealth = {
  source: string;
  /** Set when the lane is DECLARED as having no ladder — carries the reason, and suppresses alarms. */
  noLadderByDesign?: string | null;
  recent: LadderWindowCounts;
  baseline: LadderWindowCounts;
  askRateRecent: number | null;
  askRateBaseline: number | null;
  /** Set when the lane is a DECLARED relay lane — carries the reason, and redirects the check. */
  relayByDesign?: string | null;
  alarm:
    | "ask_rate_collapsed"
    | "never_asks"
    | "ladder_shipped_unexercised"
    | "uncontactable"
    | "staff_owned_first_touch"
    | "relay_task_missing"
    | null;
  why: string;
};

export type LadderHealthReport = {
  windowDays: number;
  baselineDays: number;
  lanes: LadderLaneHealth[];
  alarms: LadderLaneHealth[];
  summary: {
    lanesScanned: number;
    leadsRecent: number;
    /** Agent-owned first touches that asked something — out of `agentFirstTouchesRecent`, not `leadsRecent`. */
    askedRecent: number;
    agentFirstTouchesRecent: number;
    staffFirstTouchesRecent: number;
    neverTextedRecent: number;
    bookedRecent: number;
  };
};

/**
 * A lane needs this many leads in the recent window before an alarm may fire at all.
 *
 * MEASURED PRECEDENT: the canary's ratio rule tripped on a healthy build because an 8-hour slice
 * carried ~2 drafts — "a x2 ratio rule on a base that small trips on ordinary variation". Most lanes
 * here run single digits per month, so the floor is absolute, not a ratio.
 */
/**
 * LANES THAT DELIBERATELY HAVE NO LADDER, each with the reason.
 *
 * This list is the point, not an escape hatch. It does the job of a coverage registry in the only way
 * that matters: a NEW source we have never seen either starts asking, or shows up here with a reason,
 * or alarms. **It does not demand a ladder; it demands a decision** — the same contract
 * `decision_registry_coverage:eval` uses for referees.
 *
 * ⚠️ Adding a lane here is a claim that pushing an appointment on it would be WRONG. It is not a way
 * to quiet a lane we simply have not got to yet.
 *
 * ## THE WALK-IN FAMILY IS NOT DECLARED HERE — it was, and the declaration was wrong (2026-08-11)
 *
 * `Traffic Log Pro`, `Walk In` and `Dealer Lead App` are ONE family: `WALK_IN_SOURCE_RE` in
 * `conversationStore.ts` treats all three as walk-ins, and `inferWalkIn` routes on it. Two of the
 * three were declared here on the day this file was written, and both reasons turned out to be false:
 *
 * - *"a VOICE lane — the first outbound is a call, not a text"* (Traffic Log Pro). MEASURED on the
 *   live store: **16 of 22** leads in the 30-day window received a real customer-facing SMS, and only
 *   5 of those texts asked anything. The bodies are ordinary first touches — *"Thanks for stopping in
 *   today… let me know if I can answer any other questions"*. The lead ORIGIN is a phone log; what we
 *   SEND is a text, and it is the passive one.
 * - *"they are already standing in the store"* (Walk In). This is the exact assumption Joe overruled
 *   on 2026-08-11 (`90d33585`, #655): 49 of 66 Dealer Lead App leads had ridden a bike here, and they
 *   still get asked back in — *"want to set up a time to stop in and check it out?"*. Having visited
 *   is a reason to change the WORDING ("stop BACK in"), never a reason to stop asking.
 *
 * The cost of the mistake was the whole point of the instrument: 28 of the 30 walk-in-family leads
 * were invisible to the only net built to catch a lane that stopped advancing leads — and the family
 * is the best-converting volume source we own (14% booked). #655 built the ask at the Dealer Lead App
 * call site only, so the two sibling lanes carrying the volume still need the copy; with the
 * suppression in place, nothing would ever have said so.
 *
 * ⚠️ THE LESSON, for the next lane someone wants to declare: a reason about where the lead CAME FROM
 * ("it's a phone lane", "they were in the store") is not a reason about what we SEND. Check the
 * outbound bodies before declaring a lane silent by design.
 *
 * ## RIDING ACADEMY WAS THE THIRD MIS-DECLARATION, AND IT IS THE SAME MISTAKE (2026-08-18)
 *
 * Declared here as *"course enrolment, not a motorcycle purchase"* — a statement about the lead's
 * ORIGIN, which is the one shape this file already warns is not a reason. Measured on the live store
 * (all 14 Riding Academy leads, every one created inside the last 90 days):
 *
 * - We text this lane HEAVILY: **18 agent-authored rows across the 8 most recent leads** — course
 *   pricing (*"The current price is $321"*), enrolment confirmations, wait-list follow-ups, and a
 *   real ask when a seat frees up (*"I may have a spot that will open up for this weekends class.
 *   Are you still interested?"*). It is an active, agent-owned conversational lane, not a receipt.
 * - The 30-day sweep graded **9 agent-owned first touches at a 0% ask rate**, and the suppression is
 *   the only reason that row never alarmed.
 *
 * The declaration was also load-bearing in the wrong direction: because the lane was silent by
 * design, nothing flagged that it mis-routes into the BIKE ladder. Two live examples in the same
 * window — +15854782032 (Maya), whose second lead form drew *"I can ballpark payments once I confirm
 * the exact price. If you'd like to stop in, what day and time works best?"* on a COURSE enrolment,
 * and +17167857284 (Ulises), who asked *"will I lose my seat?"* and was answered with dealership
 * hours and appointment availability.
 *
 * ⚠️ WHAT THE ALARM MEANS HERE, so the next reader does not "fix" it with a bike ask: the right ask
 * on this lane is COURSE-shaped (confirm the start date, hold the seat, are you set for the range
 * day) — never an appointment to look at a motorcycle. "Not a bike ask" was the true half of the old
 * reason; "therefore no ask at all" was the false half, and it silenced the lane for both.
 */
export const NO_LADDER_LANES: { pattern: RegExp; why: string }[] = [
  { pattern: /ride challenge|sweeps|rsvp/i, why: "a marketing signup, not a buyer" }
];

export function laneHasNoLadderByDesign(source: string): string | null {
  return NO_LADDER_LANES.find(l => l.pattern.test(source))?.why ?? null;
}

/**
 * LANES WHOSE LADDER HAS ALREADY SHIPPED — the boundary their evidence must be read against.
 *
 * ── THE PROBLEM THIS SOLVES ───────────────────────────────────────────────────────────────────
 * `never_asks` means "this lane may have no ladder — a BUILD candidate, write the copy". That is
 * the right reading only while no copy exists. Once a fix ships, the 30-day window still holds
 * mostly PRE-FIX turns, so the lane keeps alarming with a diagnosis that has become false, and the
 * alarm still says "write the copy" — for copy that is already written and deployed.
 *
 * MEASURED on `Traffic Log Pro`: PR #702 (`579b8078`, deployed 2026-08-14T02:15Z) wired
 * `appendWalkInFirstTouchAsk` into the walk-in first touch. Three consecutive agent-loop ticks
 * (2026-08-16 00:15Z, 04:15Z, 08:15Z) each re-derived from scratch that the alarm was built
 * entirely on pre-fix turns, and each spent real effort doing it. Since that deploy the lane has
 * had exactly ONE inbound — step 9 (SOLD BIKE), correctly outside the 1-4 first-touch band, and
 * staff-typed besides. Zero graded evidence either way.
 *
 * ── THIS IS NOT A SUPPRESSION, AND THE DIFFERENCE IS THE WHOLE POINT ──────────────────────────
 * `NO_LADDER_LANES` silences a lane forever. This silences nothing. It splits one alarm into two,
 * on a fact the instrument can check for itself:
 *   - ZERO agent-owned first touches since the fix shipped ⇒ `ladder_shipped_unexercised`. Still an
 *     alarm, still printed; it just stops saying "write the copy" about copy that already exists.
 *   - SOME agent-owned first touches since the fix, and still nothing asked ⇒ it stays `never_asks`,
 *     and the text now says the shipped fix looks INERT. That is the loud case, and today it is
 *     indistinguishable from the quiet one.
 * That second half is the reason to build this rather than declare the lane silent: an inert fix is
 * the failure mode that bit #721 (shipped, then overwritten by a later writer) and nearly bit #725.
 * This turns a permanently-noisy alarm into a detector for exactly that.
 *
 * ── FAIL DIRECTION ────────────────────────────────────────────────────────────────────────────
 * Safe in every direction. No boundary declared, an unparseable date, or a date old enough that
 * post-fix touches exist ⇒ the lane alarms exactly as it does today. A boundary can only ever
 * reclassify a lane with LITERALLY ZERO graded evidence since its fix — a window in which no claim
 * about the copy is possible anyway. It cannot silence a lane that has been exercised.
 *
 * ⚠️ Same discipline as `NO_LADDER_LANES`: an entry here is a claim that a fix SHIPPED, so it
 * carries the PR and the deploy timestamp. Verify the fix is live before adding one — a boundary
 * dated to a fix that was later reverted would read post-fix silence as "not exercised yet" forever.
 */
export const LADDER_FIX_BOUNDARIES: { pattern: RegExp; shippedAt: string; what: string }[] = [
  {
    pattern: /^traffic log pro/i,
    shippedAt: "2026-08-14T02:15:00Z",
    what: "PR #702 (579b8078) wired appendWalkInFirstTouchAsk into the walk-in first touch"
  }
];

export function laneFixBoundary(source: string): { shippedAt: string; what: string } | null {
  const hit = LADDER_FIX_BOUNDARIES.find(l => l.pattern.test(source));
  if (!hit) return null;
  // An unparseable date must not create a boundary — that would silently reclassify a lane on a
  // typo. No usable timestamp ⇒ behave exactly as if nothing had been declared.
  return Number.isFinite(Date.parse(hit.shippedAt)) ? { shippedAt: hit.shippedAt, what: hit.what } : null;
}

/**
 * RELAY LANES — the customer has NO SMS, email or phone channel BY DESIGN, and is answered by hand
 * off-channel. Not a lane we failed to write copy for, and not a broken feed.
 *
 * **Joe ruled this on 2026-07-24 and restated it on 2026-08-12: "you cannot sms email or call dealer
 * digital leads through lead rider."** AutoDealers.Digital leads are Facebook Marketplace relays —
 * the customer lives in the Marketplace inbox, so the ADF carries a name, a stock number and
 * "Inquiry: Lead arrived" and nothing else. Full Facebook automation is RULED OUT (driving a personal
 * account's Messenger UI = Meta ToS violation + ban risk). What we ship instead already exists:
 * `domain/marketplaceRelay.ts` hands the LEAD OWNER a task with a ready-to-paste first reply, and the
 * publish gate suppresses any sendable draft (`marketplace_relay_no_draft:eval`, PR #285, 7/24).
 *
 * ⚠️ **Why this list exists at all — I got this wrong twice.** The sweep raised `uncontactable` here
 * and this file concluded "the fix is upstream, with the vendor feed". That went into the alarm text,
 * into memory, and into two run reports to Joe as an open item needing a vendor call — for a question
 * he had already answered and BUILT three weeks earlier, in this repo, with an eval. A repeat alarm on
 * a ruled behaviour is worse than no alarm: it spends the attention a hands-off loop exists to save.
 * Before calling an absence a defect, grep the source name in `services/api/src` and find out whether
 * we already have a deliberate path for it.
 *
 * ⚠️ **And this is NOT the #663 mistake in reverse.** That failure was a lane silenced on an
 * unverified reason. This one is verified three ways: Joe's ruling, the shipped relay path, and the
 * live store — 18 of 18 leads carry no phone and no email, 18 of 18 got the relay task, and there are
 * ZERO outbound rows (measured 2026-08-12). A relay lane is therefore not silenced, it is REDIRECTED:
 * the sweep stops grading copy nobody can receive and starts watching the only thing that can
 * actually break here — whether the rep still gets the task.
 */
export const RELAY_LANES: { pattern: RegExp; why: string }[] = [
  {
    pattern: /autodealers\.digital|autodealersdigital|facebook marketplace/i,
    why: "a Facebook Marketplace relay — no SMS/email/phone channel exists (Joe 7/24, restated 8/12); a rep answers it in the Marketplace inbox from a paste-ready task"
  }
];

export function laneIsRelayByDesign(source: string): string | null {
  return RELAY_LANES.find(l => l.pattern.test(source))?.why ?? null;
}

/**
 * Did this relay lead reach a human at all? A relay lead's whole outreach IS the staff task, so its
 * presence is the lane's health and its absence is the only real failure mode.
 *
 * Deliberately checks that a task EXISTS rather than matching the task's wording. The summary text
 * has already changed once (the 7/24 build folded the paste-ready reply into it, so 13 of the 18
 * leads in today's window carry the older one-liner) — a wording match would have read those 13 as
 * "no task" and raised the false alarm this change exists to remove.
 *
 * FAIL DIRECTION: no todo list supplied ⇒ coverage is reported as UNKNOWN and nothing alarms. An
 * instrument that cannot see the task must not accuse anyone.
 */
export function relayLeadHasStaffTask(convId: string, todosByConv: Map<string, number>): boolean {
  return (todosByConv.get(convId) ?? 0) > 0;
}

export const LADDER_MIN_RECENT_LEADS = 5;
/** Never-asked needs a bigger base: a lane can legitimately go 5 quiet leads without a ladder break. */
export const LADDER_MIN_NEVER_ASKS_LEADS = 8;
/** A collapse means the lane USED to ask and now does not. Step change, not a wobble. */
export const LADDER_HEALTHY_ASK_RATE = 0.7;
export const LADDER_COLLAPSED_ASK_RATE = 0.3;

/**
 * Did this message ask the customer anything?
 *
 * ⚠️ Strips URLs first. A credit-application link carries `?dealerid=` and is not a question — the
 * same trap that made an earlier repeat-detector count links as questions (2026-08-11).
 */
export function messageAsksSomething(body: string | null | undefined): boolean {
  return String(body ?? "").replace(/https?:\/\/\S+/g, " ").includes("?");
}

/**
 * Outbound rows that are NOT a message the customer received.
 *
 * MEASURED over 90 days of outbound rows: `draft_ai` 504 (first row on 108 leads), `voice_summary`
 * 280, `voice_call` 219 (first on 7), `voice_transcript` 194, `payment_event` 1. None of those is
 * text we sent someone; `twilio` (1,872), `sendgrid` (93) and `human` (13) are.
 *
 * A DENY-list, not an allow-list, and deliberately so: an unrecognised provider stays COUNTED. A false
 * "delivered" leaves the lane on today's diagnosis and costs one line; a false "never sent" would drop
 * a whole lane out of the ask rate silently, and a wrong suppression is invisible forever (#663).
 */
export const NON_DELIVERED_OUTBOUND_PROVIDERS = new Set([
  "draft_ai",
  "voice_summary",
  "voice_transcript",
  "voice_call",
  "payment_event"
]);

/** Did the customer actually receive this outbound row? See NON_DELIVERED_OUTBOUND_PROVIDERS. */
export function isDeliveredCustomerText(msg: { direction?: string | null; provider?: string | null }): boolean {
  if (String(msg?.direction) !== "out") return false;
  return !NON_DELIVERED_OUTBOUND_PROVIDERS.has(String(msg?.provider ?? "").trim());
}

function emptyCounts(): LadderWindowCounts {
  return {
    leads: 0,
    asked: 0,
    replied: 0,
    booked: 0,
    contactable: 0,
    relayHandedToStaff: 0,
    agentFirstTouches: 0,
    staffFirstTouches: 0,
    agentFirstTouchesSinceFix: 0,
    neverTexted: 0
  };
}

/**
 * Can we reach this lead at all — is there a phone number or an email address on it?
 *
 * Deliberately generous: ANY non-empty phone or email counts. The point is to separate "we have a way
 * in and did not use it" from "the feed handed us a name and a stock number and nothing else", and a
 * false "yes" simply leaves the lane on today's `never_asks` diagnosis.
 */
export function leadIsContactable(conv: any): boolean {
  const lead = conv?.lead ?? {};
  return !!String(lead.phone ?? "").trim() || !!String(lead.email ?? "").trim();
}

/**
 * Ask rate over the population our copy can actually move: agent-owned first touches. Staff-typed
 * messages and leads we never texted are counted separately and reported, never graded.
 */
function rate(counts: LadderWindowCounts): number | null {
  return counts.agentFirstTouches > 0 ? counts.asked / counts.agentFirstTouches : null;
}

export function assessLadderHealth(input: {
  conversations: any[];
  /**
   * The store's top-level `todos`. Optional, and RELAY lanes are the only thing that reads it: a relay
   * lead's whole outreach is its staff task. Omit it and relay coverage reads UNKNOWN and nothing
   * alarms — an instrument that cannot see the task must not accuse anyone.
   */
  todos?: any[];
  now: Date | number;
  windowDays?: number;
  baselineDays?: number;
}): LadderHealthReport {
  const nowMs = typeof input.now === "number" ? input.now : input.now.getTime();
  const windowDays = input.windowDays ?? 30;
  const baselineDays = input.baselineDays ?? 60;
  const recentFrom = nowMs - windowDays * 24 * 60 * 60 * 1000;
  const baselineFrom = recentFrom - baselineDays * 24 * 60 * 60 * 1000;

  const todosSupplied = Array.isArray(input.todos);
  const todosByConv = new Map<string, number>();
  for (const t of input.todos ?? []) {
    const id = String((t as any)?.convId ?? "").trim();
    if (id) todosByConv.set(id, (todosByConv.get(id) ?? 0) + 1);
  }

  const lanes = new Map<string, { recent: LadderWindowCounts; baseline: LadderWindowCounts }>();
  for (const conv of input.conversations ?? []) {
    const createdAt = Date.parse(String(conv?.createdAt ?? ""));
    if (!Number.isFinite(createdAt) || createdAt < baselineFrom) continue;
    const bucket = createdAt >= recentFrom ? "recent" : "baseline";
    const source = String(conv?.lead?.source ?? "").trim() || "(no source)";
    if (!lanes.has(source)) lanes.set(source, { recent: emptyCounts(), baseline: emptyCounts() });
    const counts = lanes.get(source)![bucket as "recent" | "baseline"];
    counts.leads += 1;
    if (leadIsContactable(conv)) counts.contactable += 1;
    if (todosSupplied && laneIsRelayByDesign(source) && relayLeadHasStaffTask(String(conv?.id ?? ""), todosByConv)) {
      counts.relayHandedToStaff += 1;
    }

    const messages: any[] = Array.isArray(conv?.messages) ? conv.messages : [];
    // The first thing the customer actually RECEIVED — not the first outbound row, which is a draft
    // in the approval box on ~23% of leads. See NON_DELIVERED_OUTBOUND_PROVIDERS.
    const firstOut = messages.find(isDeliveredCustomerText);
    if (!firstOut) {
      counts.neverTexted += 1;
    } else if (isStaffAuthoredOutbound(firstOut)) {
      // A salesperson typed this themselves. Reported, never graded: our copy is not what this
      // customer read, so it can neither earn credit nor take blame for the lane's ask rate.
      counts.staffFirstTouches += 1;
    } else {
      // Ours — either the agent sent it, or the agent drafted it and staff edited before sending
      // (`originalDraftBody` present, which is what keeps an edited draft on our side of the line).
      counts.agentFirstTouches += 1;
      if (messageAsksSomething(firstOut.body)) counts.asked += 1;
      // Only turns delivered at or after this lane's declared fix can say anything about whether the
      // shipped ladder works. An undeclared lane has no boundary and this stays 0, unread.
      const boundary = laneFixBoundary(source);
      if (boundary) {
        const deliveredAt = Date.parse(String(firstOut?.at ?? ""));
        if (Number.isFinite(deliveredAt) && deliveredAt >= Date.parse(boundary.shippedAt)) {
          counts.agentFirstTouchesSinceFix += 1;
        }
      }
    }

    const firstOutAt = Date.parse(String(firstOut?.at ?? ""));
    if (
      Number.isFinite(firstOutAt) &&
      messages.some(m => String(m?.direction) === "in" && Date.parse(String(m?.at ?? "")) > firstOutAt)
    ) {
      counts.replied += 1;
    }
    if (conv?.appointment?.whenIso || conv?.appointment?.whenText) counts.booked += 1;
  }

  const out: LadderLaneHealth[] = [];
  for (const [source, w] of lanes) {
    const askRateRecent = rate(w.recent);
    const askRateBaseline = rate(w.baseline);
    let alarm: LadderLaneHealth["alarm"] = null;
    let why = "healthy or below the reporting floor";

    const byDesign = laneHasNoLadderByDesign(source);
    const relayWhy = laneIsRelayByDesign(source);
    const declaredFix = laneFixBoundary(source);
    // A boundary only applies to a report generated AFTER the fix shipped. Re-running the sweep over
    // an older window (or replaying a past date) must read exactly as it read at the time — at that
    // moment the copy genuinely did not exist yet, so `never_asks` was the correct diagnosis and
    // reclassifying it retroactively would rewrite history to say the opposite.
    const fixBoundary = declaredFix && nowMs >= Date.parse(declaredFix.shippedAt) ? declaredFix : null;
    if (byDesign) {
      why = `no ladder by design: ${byDesign}`;
    } else if (relayWhy) {
      // A RELAY lane is off-channel BY DESIGN (Joe 7/24, restated 8/12) — see RELAY_LANES. Grading its
      // copy or its reach is grading something that is supposed to be absent, so neither `never_asks`
      // nor `uncontactable` may fire here. What CAN break is the rep never being told, so that is what
      // this checks instead. Redirected, not silenced.
      if (!todosSupplied) {
        why = `relay lane: ${relayWhy} — staff-task coverage NOT CHECKED (no todo list supplied)`;
      } else if (w.recent.relayHandedToStaff >= w.recent.leads) {
        why = `relay lane: ${relayWhy} — all ${w.recent.leads} handed to the lead owner`;
      } else {
        // The real failure mode: a lead with no channel AND nobody told to answer it is a lead nobody
        // can reach at all.
        alarm = "relay_task_missing";
        why = `${w.recent.leads - w.recent.relayHandedToStaff} of ${w.recent.leads} relay leads got NO staff task — this lane has no other way to be answered`;
      }
    } else if (w.recent.leads >= LADDER_MIN_RECENT_LEADS) {
      const collapsed =
        w.baseline.leads >= LADDER_MIN_RECENT_LEADS &&
        (askRateBaseline ?? 0) >= LADDER_HEALTHY_ASK_RATE &&
        (askRateRecent ?? 0) <= LADDER_COLLAPSED_ASK_RATE;
      if (collapsed) {
        alarm = "ask_rate_collapsed";
        why = `this lane used to ask (${Math.round((askRateBaseline ?? 0) * 100)}%) and now does not (${Math.round((askRateRecent ?? 0) * 100)}%)`;
      } else if (w.recent.leads >= LADDER_MIN_NEVER_ASKS_LEADS && w.recent.contactable === 0) {
        // NOT a ladder problem. MEASURED 2026-08-11 on AutoDealers.Digital: 18 of 18 recent leads
        // carry no phone and no email — the ADF is a name, a stock number and "Inquiry: Lead arrived".
        // The three that appeared to have an address had the DEALER's own (gio@americanharley-…), which
        // the ADF parser correctly refused to store. Every other lane in the same window is ~100%
        // contactable, so this test discriminates rather than blankets.
        //
        // It still ALARMS — a lane we cannot reach is a real problem — but calling it `never_asks` sent
        // a run hunting for missing copy, and no wording change can reach someone with no address.
        //
        // ⚠️ CORRECTED 2026-08-12: this comment used to end "the fix is upstream, with the vendor
        // feed", and on the lane that produced the measurement above that was WRONG — AutoDealers.
        // Digital is a Facebook Marketplace RELAY, unreachable by design and already handled by a
        // paste-ready staff task (Joe ruled it 7/24, `domain/marketplaceRelay.ts`, PR #285). It is now
        // classified above as a relay lane and never reaches this branch. What survives here is the
        // GENUINELY undeclared case: a lane nobody has ruled on, where "call the vendor" is one
        // hypothesis and "this is a relay we have not declared yet" is the other. Establish which
        // before reporting it as a defect.
        //
        // Checked BEFORE never_asks on purpose: a lane with nobody to reach obviously never asks, so
        // whichever runs first owns the diagnosis, and the contact defect is the deeper cause.
        alarm = "uncontactable";
        why = `${w.recent.leads} leads and not one carries a phone or an email — nothing we write can reach them; this is a lead-feed defect, not a missing ladder`;
      } else if (
        w.recent.leads >= LADDER_MIN_NEVER_ASKS_LEADS &&
        w.recent.staffFirstTouches > w.recent.agentFirstTouches
      ) {
        // NOT a ladder problem either. A salesperson gets the first word on most of this lane, so what
        // these customers read is not our copy and writing more of it cannot move the number. Measured
        // 2026-08-12: the unsourced baseline lane ran 19 staff-typed first touches against 2 of ours.
        //
        // It still ALARMS — a lane the agent never opens is worth a decision (is that deliberate?) —
        // but naming it `never_asks` would send the next run to write copy nobody will send.
        //
        // Checked BEFORE never_asks for the same reason `uncontactable` is: a lane we do not open
        // obviously never asks, and whichever test runs first owns the diagnosis.
        alarm = "staff_owned_first_touch";
        why =
          `${w.recent.staffFirstTouches} of ${w.recent.leads} first touches were typed by staff and only ` +
          `${w.recent.agentFirstTouches} by the agent — our copy is not what this lane reads, so a wording change cannot move it`;
      } else if (
        w.recent.leads >= LADDER_MIN_NEVER_ASKS_LEADS &&
        w.recent.asked === 0 &&
        w.baseline.asked === 0 &&
        fixBoundary &&
        w.recent.agentFirstTouchesSinceFix === 0
      ) {
        // The ladder EXISTS and shipped; the window simply predates it. Checked BEFORE never_asks for
        // the same reason `uncontactable` and `staff_owned_first_touch` are: this lane obviously never
        // asked in a window that ended before the copy existed, and whichever test runs first owns the
        // diagnosis. Still an alarm — an unexercised lane is worth a line — but it must not send the
        // next run to write copy that is already deployed. See LADDER_FIX_BOUNDARIES.
        alarm = "ladder_shipped_unexercised";
        why =
          `the ladder for this lane already shipped — ${fixBoundary.what}, live ${fixBoundary.shippedAt} — and NOT ONE ` +
          `agent-owned first touch has landed since. Every one of the ${w.recent.agentFirstTouches} graded touches in ` +
          `this window predates the fix, so this number cannot say whether it works. Do not write new copy; wait for traffic`;
      } else if (
        w.recent.leads >= LADDER_MIN_NEVER_ASKS_LEADS &&
        w.recent.asked === 0 &&
        w.baseline.asked === 0
      ) {
        // Not a break — a lane that never had a ladder at all.
        alarm = "never_asks";
        why = fixBoundary
          ? // A fix shipped, the lane HAS been exercised since, and still nothing asked. This is the
            // loud case: the deployed ladder looks INERT (the #721 failure mode — shipped, wired, and
            // silently overridden downstream). Reproduce by executing the fix's own path before
            // writing anything new.
            `${w.recent.agentFirstTouchesSinceFix} agent-owned first touches have landed since ${fixBoundary.what} ` +
            `went live ${fixBoundary.shippedAt}, and not one asked anything — the shipped ladder looks INERT. ` +
            `Execute its path against a real lead before writing new copy`
          : `${w.recent.agentFirstTouches} agent-owned first touches and not one asked anything — this lane may have no ladder` +
            (w.recent.staffFirstTouches || w.recent.neverTexted
              ? ` (of ${w.recent.leads} leads, ${w.recent.staffFirstTouches} were staff-typed and ${w.recent.neverTexted} never texted — neither is graded)`
              : "");
      }
    }
    out.push({ source, noLadderByDesign: byDesign, relayByDesign: relayWhy, recent: w.recent, baseline: w.baseline, askRateRecent, askRateBaseline, alarm, why });
  }

  out.sort((a, b) => b.recent.leads - a.recent.leads);
  return {
    windowDays,
    baselineDays,
    lanes: out,
    alarms: out.filter(l => l.alarm),
    summary: {
      lanesScanned: out.length,
      leadsRecent: out.reduce((n, l) => n + l.recent.leads, 0),
      askedRecent: out.reduce((n, l) => n + l.recent.asked, 0),
      agentFirstTouchesRecent: out.reduce((n, l) => n + l.recent.agentFirstTouches, 0),
      staffFirstTouchesRecent: out.reduce((n, l) => n + l.recent.staffFirstTouches, 0),
      neverTextedRecent: out.reduce((n, l) => n + l.recent.neverTexted, 0),
      bookedRecent: out.reduce((n, l) => n + l.recent.booked, 0)
    }
  };
}
