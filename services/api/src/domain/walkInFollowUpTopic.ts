/**
 * Traffic Log Pro walk-in follow-up topic guard.
 *
 * A TLP ADF "Inquiry" field is frequently an INTERNAL staff log written ABOUT the customer
 * ("gave him trade in value on his 2018 Heritage that was here for inspection ($8000) (Step 2)"),
 * not a customer-stated follow-up topic. `extractTrafficLogProFollowUpTopic` lifts a topic out of
 * that field via an `about/on/with/regarding X` regex and the walk-in tail drops it verbatim into
 * the customer's FIRST text — which parroted an internal appraisal figure and third-person notes
 * back to the customer (+17168638237, 2026-07-22; the generated draft read "…I'll follow up about
 * his 2018 Heritage that was here for inspection ($8000)").
 *
 * This is a deterministic OUTPUT-safety guard (AGENTS.md: invariant/safety gates may be
 * deterministic — this never reads customer INTENT, it refuses to echo staff-log text). When the
 * extracted topic reads like an internal note — a dollar appraisal figure, a third-person reference
 * to the customer, or an internal-process phrase (appraisal / here-for-inspection / trade-in value /
 * "gave him") — reject it so the tail falls back to the generic "Thanks for stopping in today" line.
 * Fail-direction is safe: worst case we drop a legitimate topic and send the warm generic line; we
 * never leak internal specifics into a customer-facing message. Pinned by
 * walkin_internal_note_topic_guard:eval.
 */
/**
 * Repeat the walk-in's SPEC back to the customer (Joe ruling 2026-07-28 — Larry Godzich
 * +17164327329, 2026-07-27).
 *
 * Scott's Traffic Log Pro note read "Was in for the Back the Blue ride and was asking about
 * pre-owned trikes… Is looking for 2017-2020 Tri Glide in the $25,000 range (Step 2)", and the
 * whole first text back was "Thanks for stopping in today - I'll follow up about pre-owned
 * trikes." It was the day's only tone failure (65, intent_mismatch) — fluent, on-topic, and
 * blind to everything the salesperson actually wrote down.
 *
 * Built ONLY from the STRUCTURED slots the walk-in path already extracted (condition, year
 * range, model) — never from the note prose. That is the whole point of the guard below: a TLP
 * inquiry field is an internal staff log, so anything echoed to the customer has to come from a
 * parsed slot, not the sentence around it.
 *
 * The BUDGET is deliberately omitted even though it is extracted. A dollar figure in a walk-in
 * note is as likely to be a trade APPRAISAL as the customer's budget (the +17168638237 draft
 * that started this module parroted "($8000)" back), and no year/model recap is worth
 * re-opening that. Model and years are enough to prove we heard them.
 *
 * FAIL DIRECTION: purely additive copy that promises nothing — no watch, no callback, no
 * booking. With no model it returns "" and the tail is exactly today's line. Pinned by
 * walkin_internal_note_topic_guard:eval.
 */
export function buildWalkInSpecRecapClause(input: {
  modelLabel?: string | null;
  yearLabel?: string | null;
  condition?: "new" | "used" | null;
}): string {
  const model = String(input.modelLabel ?? "").trim();
  if (!model) return "";
  const years = String(input.yearLabel ?? "").trim();
  const condition = input.condition === "new" ? "new" : input.condition === "used" ? "pre-owned" : "";
  // Nothing beyond the model itself to confirm — the existing tail already names it.
  if (!years && !condition) return "";
  const spec = [condition, years, model].filter(Boolean).join(" ");
  return `Just so I've got it right — you're looking for a ${spec}.`;
}

/**
 * Say the committed return day back, and ask the one thing the note left open — the time.
 *
 * Ed Szulist (+17167255404, 2026-08-01). The Traffic Log Pro note said "COMING BACK NXT WEEK
 * TUESDAY AUGUST 4TH TO TEST RIDE A FEW DIFFERENT SPORTSTERS (Step 5)" and the whole first text
 * back was "Thanks again for your time. I'll follow up shortly with next steps." Stone rewrote it
 * by hand to ask what time window worked on the 4th, which is exactly what the recap above would
 * have done if it had a slot to speak from: "Sportsters" is a FAMILY, not a model, so
 * `buildWalkInSpecRecapClause` had no model, no year range and no condition, and returned "".
 *
 * Same law as its sibling: built ONLY from parsed slots (`return_visit` / `return_day_text`, plus
 * the catalog-backed family resolver), never from the note prose. The day itself is resolved by
 * the CALLER through `parseRequestedDateOnly` and handed in already split — this module owns copy,
 * not clocks, and takes `asOfIso` rather than reading one so the eval can pin the production turn.
 *
 * FAIL DIRECTION: returns "" for every lane but `committed_day`, for a confidence under the floor,
 * for a day that did not resolve, and for a day already past or absurdly far out — and "" is
 * byte-for-byte today's tail. The clause promises nothing: no booking, no watch, no callback. It
 * asks a question about a day the salesperson wrote down. Pinned by
 * walkin_internal_note_topic_guard:eval.
 */
const RETURN_DAY_MAX_AHEAD_DAYS = 45;

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The dealer-local Y/M/D of an instant, without dragging a date library in. */
function localDateParts(iso: string, timeZone: string): { year: number; month: number; day: number } | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(at);
    const pick = (t: string) => Number(parts.find(p => p.type === t)?.value ?? NaN);
    const year = pick("year");
    const month = pick("month");
    const day = pick("day");
    return Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)
      ? { year, month, day }
      : null;
  } catch {
    return null;
  }
}

/**
 * "Tuesday, Aug 4" for a resolved return day — or "" when it is in the past or more than
 * ~6 weeks out. The window matters because `parseRequestedDateOnly` ROLLS A BARE DATE FORWARD:
 * re-reading "August 4th" in September resolves to next year, and a draft must never invite
 * someone to a visit eleven months away.
 */
export function formatWalkInReturnDayLabel(
  parts: { year: number; month: number; day: number } | null | undefined,
  timeZone: string,
  asOfIso: string
): string {
  if (!parts) return "";
  const { year, month, day } = parts;
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return "";
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  const today = localDateParts(asOfIso, timeZone);
  if (!today) return "";
  const target = Date.UTC(year, month - 1, day);
  const from = Date.UTC(today.year, today.month - 1, today.day);
  const aheadDays = Math.round((target - from) / 86_400_000);
  if (aheadDays < 0 || aheadDays > RETURN_DAY_MAX_AHEAD_DAYS) return "";
  const weekday = WEEKDAY_LABELS[new Date(target).getUTCDay()] ?? "";
  const monthLabel = MONTH_LABELS[month - 1] ?? "";
  if (!weekday || !monthLabel) return "";
  return `${weekday}, ${monthLabel} ${day}`;
}

/**
 * A customer-facing plural for a FAMILY key ("sportster" → "Sportsters").
 *
 * The key comes from `referencesFamilyOnlyInText` (modelFamily.ts), which is catalog-backed and
 * already eval-pinned — deliberately reused instead of widening the walk-in path's own
 * `\bsportster\b` model hint, whose word boundary is what missed the plural in the first place.
 * Widening THAT would push a family label into `modelLabel`, which feeds the watch referee and the
 * spec recap: a far bigger blast radius than this sentence. An unmapped family returns "" and the
 * clause simply drops the phrase rather than inventing a name for it.
 */
export function formatWalkInFamilyLabel(familyKey: string | null | undefined): string {
  const key = String(familyKey ?? "").trim().toLowerCase();
  const labels: { [k: string]: string } = {
    sportster: "Sportsters",
    trike: "trikes",
    softail: "Softails",
    touring: "touring bikes"
  };
  return labels[key] ?? "";
}

/**
 * The dealer-local `YYYY-MM-DD` for an already-resolved return day, or "" when it did not resolve.
 *
 * Stored on the lead at ADF ingest so the CADENCE — which runs days later, in another process,
 * with no parser result in hand — can honour a day the parser already read. Deliberately a plain
 * calendar day and not an instant: the promise is "he said he'd come in on the 4th", and comparing
 * calendar days in the dealer's timezone is the only comparison that means that.
 */
export function formatWalkInReturnDayIso(
  parts: { year: number; month: number; day: number } | null | undefined
): string {
  if (!parts) return "";
  const { year, month, day } = parts;
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return "";
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * ON the day a walk-in customer said he'd come back, ask about THAT — not about photos and payments.
 *
 * Ed Szulist (+17167255404), operator-reported 2026-08-04T13:02Z: *"it says he's going come back
 * today, so the follow up may say something like just checking to see if we are still good for
 * today."* His Traffic Log Pro note (8/1) read "COMING BACK NXT WEEK TUESDAY AUGUST 4TH TO TEST RIDE
 * A FEW DIFFERENT SPORTSTERS". The FIRST touch got it right — `buildWalkInReturnVisitTail` above
 * said the day back and asked for a time. Then on Tuesday the 4th at 13:00:26 the cadence went out
 * as "Hey Ed, just checking back on the Softail Slim. Want me to send photos or price and payment
 * numbers?" — a cold generic check-in on the exact day he'd named. Staff rewrote it by hand three
 * minutes later ("Are we still good today to come in for some test rides?") and again at 14:13.
 *
 * WHY the cadence was blind, precisely: `inferCadencePersonalizationFallback` reads only INBOUND
 * CUSTOMER MESSAGES, and Ed never texted — his commitment lives in the walk-in note. The note lane
 * is separately one-shot (`walkInCommentUsedAt`), and the copy it produces is a prose regex ladder
 * with no arm for a named day (see `walkInCommentFollowUp.ts`). Whatever it produced was then
 * overwritten anyway by `buildEarlyCadencePromotionOverride`, which is the sentence that shipped.
 *
 * Same law as its siblings: built ONLY from the parsed `return_visit` / `return_day_text` slots,
 * resolved to a calendar day at ingest and stored — never from the note prose, and never re-read
 * from it here. This module owns copy, not clocks, so the day and "now" are both handed in.
 *
 * FAIL DIRECTION: returns "" for a missing day, an unparseable day, and any day that is not TODAY
 * in the dealer's timezone — and "" is byte-for-byte today's behaviour. It promises nothing (no
 * booking, no hold, no callback); it asks the one question the salesperson would ask. The caller is
 * responsible for the "he already booked" case, which the cadence loop already refuses to run past.
 */
export function buildWalkInReturnDayCheckInLine(input: {
  name: string;
  returnDayIso?: string | null;
  timeZone: string;
  asOfIso: string;
  familyLabel?: string | null;
  testRide?: boolean | null;
}): string {
  const day = String(input.returnDayIso ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
  const today = localDateParts(input.asOfIso, input.timeZone);
  if (!today) return "";
  const todayIso = formatWalkInReturnDayIso(today);
  if (!todayIso || todayIso !== day) return "";
  const name = String(input.name ?? "").trim();
  const greeting = name ? `Hey ${name}, ` : "";
  const family = String(input.familyLabel ?? "").trim();
  // "What time works best" is the wording the sibling tail already uses — clean against the
  // banned-phrase and voice-charter guards. A second phrasing for the same ask would just be a new
  // surface for them to police.
  const close =
    family && input.testRide
      ? `I'll have a few ${family} ready for you.`
      : "I'll make sure we're ready for you.";
  return `${greeting}just making sure we're still on for today. What time works best? ${close}`;
}

/**
 * "12:00 PM" for an already-resolved clock time — or "" when the numbers are not a clock time.
 *
 * The caller resolves the time (this module owns copy, not clocks, exactly as the day label
 * above). Deliberately the same `h:mm AM/PM` shape the appointment record's own `whenText` uses,
 * so a customer who later gets a booking confirmation sees the same time written the same way.
 */
export function formatWalkInReturnTimeLabel(
  hour24: number | null | undefined,
  minute: number | null | undefined
): string {
  // `Number(null)` is 0, so an ABSENT hour would format as midnight and state a time nobody
  // named — the one failure this helper must never have. Absent means absent.
  if (hour24 === null || hour24 === undefined) return "";
  const h = Number(hour24);
  const m = Number(minute ?? 0);
  if (!Number.isInteger(h) || h < 0 || h > 23) return "";
  if (!Number.isInteger(m) || m < 0 || m > 59) return "";
  const meridiem = h < 12 ? "AM" : "PM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${meridiem}`;
}

/**
 * A walk-in who named a day AND a time gets that time said back — not silence.
 *
 * Paul Harrigan (+17169467451, Walk In ref 11779, 2026-08-11). Scott's note read "…Wants to take
 * it for a test ride on Saturday 8/15/2026 at 12pm (Step 4)", and the whole first text back was
 * "Thanks for stopping in - I'll follow up about the 2020 FLTRXS Road Glide Special." The
 * Saturday-noon test ride — the one load-bearing fact in the note — was never mentioned. Scott
 * rewrote the draft by hand and booked the ride himself (`human_correction_material`), and the
 * nightly replay filed it P1.
 *
 * The parser was NOT wrong. Executed against the verbatim live note it returns
 * `return_visit: "committed_day_and_time"`, `return_day_text: "Saturday 8/15/2026 at 12pm"`,
 * confidence 0.95, `test_ride_requested: true` — 4 runs out of 4, no instability. Every consumer
 * then threw it away: this builder returned "" for anything that was not `committed_day`, on the
 * reasoning that with both day and time settled "there is nothing to ask". There is: whether it
 * still stands. A customer who committed to a day gets a sentence about it; the customer who
 * committed HARDER got nothing.
 *
 * IT DOES NOT BOOK. The note is a salesperson's log, not a customer confirming to us, so creating
 * a calendar event off it would be an irreversible side effect taken on one party's say-so
 * (AGENTS.md fail-direction). It states the day and time back and asks one question — the whole
 * point being that the customer's answer is what makes it real.
 *
 * FAIL DIRECTION, all the way to today's behaviour: no time label (the slot text carried no clock
 * time, or it did not resolve) falls back to the `committed_day` sentence, which asks for the time
 * rather than asserting one; no day label returns "", which is byte-for-byte today's tail. It
 * promises no figure, no hold, no booking. Pinned by walkin_day_and_time_confirm:eval.
 */
export function buildWalkInReturnVisitTail(input: {
  ackSentence: string;
  returnVisit: string;
  confidence?: number | null;
  confidenceMin: number;
  dayLabel?: string | null;
  timeLabel?: string | null;
  familyLabel?: string | null;
  testRide?: boolean | null;
}): string {
  if (input.returnVisit !== "committed_day" && input.returnVisit !== "committed_day_and_time") {
    return "";
  }
  const confidence = typeof input.confidence === "number" ? input.confidence : 0;
  if (!(confidence >= input.confidenceMin)) return "";
  const day = String(input.dayLabel ?? "").trim();
  if (!day) return "";
  const ack = String(input.ackSentence ?? "").trim();
  const family = String(input.familyLabel ?? "").trim();
  const time = String(input.timeLabel ?? "").trim();
  if (time) {
    const close =
      family && input.testRide
        ? `I'll have a few ${family} ready for you.`
        : "I'll make sure we're ready for you.";
    // Ends on the question (charter C1.7). "Just confirming" claims nothing we have not been
    // told and nothing we have not done — there is no booking behind this sentence.
    return [ack, `Just confirming ${day} at ${time}.`, close, "Does that still work?"]
      .filter(Boolean)
      .join(" ");
  }
  // "what time works best" is the existing soft-visit invite's wording, already clean against the
  // banned-phrase and voice-charter guards — a second phrasing for the same ask would just be a
  // new surface for them to police.
  const ask = `What time works best ${day}?`;
  const close =
    family && input.testRide
      ? `I'll have a few ${family} ready for you.`
      : "I'll make sure we're ready for you.";
  return [ack, ask, close].filter(Boolean).join(" ");
}

/**
 * Tell the intent judge WHO WROTE the inbound it is about to grade.
 *
 * WHY (2026-07-31): the agent side of this module already knows a Traffic Log Pro walk-in
 * "Inquiry" is an internal staff log written ABOUT the customer. The intent judge was never told.
 * `buildIntentJudgePrompt` hands it the synthetic ADF body under the fixed label "Customer's
 * latest message", so the judge reads a salesperson's note as the customer's own words, invents a
 * customer ask out of it, and fails the reply for not fulfilling an ask nobody made.
 *
 * The pinned case (+17169705448, msg_9d8dbbc321971_1775078277067): the TLP note read "reach to to
 * schedule a test ride for the end of next week when the weather looks better. (Step 3)". That is
 * a staff instruction to follow up LATER — and the code honors it deliberately
 * (`extractWeatherFollowUpPlan` defers the whole cadence to a weather-suitable date). The judge
 * graded it "the customer's request was to schedule a test ride", severity MAJOR, and the flywheel
 * filed a P1 `corpus_replay_judge_fail`. Three of the 25 replay work orders in the 7/31 feed are
 * walk-ins; 44 leads in the live store carry a walk-in note.
 *
 * This states PROVENANCE ONLY — never what a good reply looks like. The judge still decides, so a
 * reply that genuinely fails the note (a walk-in note asking for email updates answered with
 * "thanks for the update") still fails. Returns null unless the note is actually the prose in the
 * body, so a body the note does not appear in is never relabeled. Fail direction: with no match
 * the prompt is byte-identical to today's.
 */
export function describeWalkInNoteProvenance(input: {
  body?: string | null;
  walkIn?: boolean | null;
  walkInComment?: string | null;
}): string | null {
  if (!input?.walkIn) return null;
  const note = String(input.walkInComment ?? "").replace(/\s+/g, " ").trim();
  if (!note) return null;
  const normalize = (v: string | null | undefined) =>
    String(v ?? "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const normNote = normalize(note);
  // Only claim provenance when the note IS the narrative text the judge is reading.
  if (!normNote || !normalize(input.body).includes(normNote)) return null;
  return [
    "PROVENANCE: this inbound is a dealership lead RECORD, not a message the customer typed.",
    `Its narrative text is a salesperson's walk-in log written ABOUT an in-store visit: "${note}".`,
    "Judge the reply against what that staff note actually calls for — do not treat the note's",
    "words as an ask the customer just sent."
  ].join(" ");
}

export function isInternalNoteFollowUpTopic(topic: string | null | undefined): boolean {
  const raw = String(topic ?? "").trim();
  if (!raw) return false;
  const t = raw.toLowerCase();
  // A specific dollar figure — an internal appraisal/price, never echoed in a first-touch.
  if (/\$\s?\d/.test(raw)) return true;
  // Third-person reference to the customer — staff writing ABOUT them ("his 2018 Heritage").
  // A customer naming their OWN follow-up topic would not say "his/her".
  if (/\b(?:his|him|her|hers)\b/.test(t)) return true;
  // Internal-process phrasing a customer wouldn't use to name their own follow-up topic.
  if (
    /\bhere for inspection\b|\bfor inspection\b|\btrade[- ]?in value\b|\bapprais(?:al|ed|e)\b|\bgave (?:him|her|them)\b/.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Say what the walk-in was ABOUT — the bike, not the phrase trailing it.
 *
 * Rick Williamson Jr. (+17165241170, 2026-08-04, TLP ref 11729). Scott's note read "Rick Jr. was
 * in for the back the blue ride and showed interest in the 2021 Road Glide Special we have ON THE
 * FLOOR with the 131ci engine. Ran some numbers on his trade in. Needs follow up (Step 2)", and
 * the whole first text back was:
 *
 *   "Thanks for stopping in - I'll follow up about the floor with the 131ci engine."
 *
 * `extractTrafficLogProFollowUpTopic` finds a topic by taking the first `about|on|with|regarding`
 * in the note and everything up to the next `.` or `;`. Here the first such word is the "on" in
 * "we have ON the floor", so the topic became the locative modifier. It is the grammar equivalent
 * of reading "the car in the garage with the sunroof" and wanting to discuss the garage. Same
 * failure, same corpus: Brent Marshall's note yields "black motor" and Larry Godzich's yields
 * "pre-owned trikes" — the modifier and the vague family, never the unit.
 *
 * This is the SAME LAW as `buildWalkInSpecRecapClause` beside it, and charter C1.6: a walk-in ack
 * speaks from the PARSED SLOTS, never from note prose. So when the walk-in path resolved a model,
 * that model IS the subject and the prose span is discarded — not sanitized, discarded, because
 * no amount of cleaning makes a staff log's sentence fragment safe to promise a customer.
 *
 * FAIL DIRECTION, three ways, all toward today's behavior:
 *  - empty prose topic in ⇒ empty out. This can never INVENT a follow-up promise on a note that
 *    never asked for one; it only ever changes the subject of a sentence we were already sending.
 *  - no model slot ⇒ today's prose topic survives untouched (still behind
 *    `isInternalNoteFollowUpTopic`), so Larry-class notes don't regress to silence.
 *  - a timing-only topic ("next week") is a WHEN, not a WHAT — passed through so the caller's
 *    timing-aware line can keep pairing it with the model itself.
 *
 * The caller passes `proseIsTimingOnly` rather than this module importing the predicate: this file
 * is a dependency-free leaf and stays that way. Pinned by walkin_internal_note_topic_guard:eval.
 */
export function resolveWalkInFollowUpSubject(input: {
  proseTopic?: string | null;
  modelLabel?: string | null;
  yearLabel?: string | null;
  proseIsTimingOnly?: boolean | null;
}): string {
  const prose = String(input.proseTopic ?? "").replace(/\s+/g, " ").trim();
  // No topic extracted → no promise to re-aim. Never manufacture one.
  if (!prose) return "";
  if (input.proseIsTimingOnly) return prose;
  const model = String(input.modelLabel ?? "").replace(/\s+/g, " ").trim();
  // "bike" is `formatWatchModelForMessage`'s placeholder for "no model resolved", not a model.
  if (!model || /^bike$/i.test(model)) return prose;
  const year = String(input.yearLabel ?? "").replace(/\s+/g, " ").trim();
  // Some model labels already carry the year ("2021 Road Glide Special" — extractWalkInModelHint
  // joins them). Never say the year twice.
  const modelCarriesYear = /(?:^|\s)(?:19|20)\d{2}(?:\s|-|$)/.test(model);
  const spec = year && !modelCarriesYear ? `${year} ${model}` : model;
  return `the ${spec}`;
}

/**
 * Answer the PRICE the salesperson wrote down, instead of offering to watch for a bike the
 * customer has already been shown.
 *
 * Mike Marcaccio (+17165702519, Traffic Log Pro ref 11775, 2026-08-11). The note read "Mike was in
 * on Saturday 8/8 talking with Brian. Asked if we had any used Street Glides in stock and showed
 * him the 2023. Follow up on price (Step 2)" — so we HAVE the bike, he has SEEN it, and the one
 * open item is the number. The first text back was "I'll keep an eye out for Street Glide and let
 * you know if one comes in": it contradicts our own note, drops the price ask, and asks nothing.
 * The availability tail had overwritten the pricing tail set a few lines above it, because the
 * block that writes it was gated on every other walk-in signal except this one.
 *
 * Built ONLY from parsed slots (condition / year / model), never the note prose — same law as
 * `buildWalkInSpecRecapClause` beside it, and for the same reason: a Traffic Log Pro inquiry field
 * is an internal staff log ("talking with Brian", "($8000)") and nothing in it may be echoed.
 *
 * IT NEVER STATES A FIGURE. The promise is that a person will bring the numbers, which is true the
 * moment it is sent; quoting money is not this module's job and not the agent's.
 *
 * The closing ask is the caller's `buildWalkInSoftTimingAsk` string (visitFraming.ts), passed in
 * rather than imported so this file stays a dependency-free leaf. Walk-ins have already been here,
 * so it is the "stop BACK in" wording — Joe ruling 31, dealer-lead-app-is-a-walk-in.
 *
 * FAIL DIRECTION: replaces a FALSE availability claim with a truthful commitment. It promises no
 * figure, no booking, no watch and no callback window. With no model it degrades to today's exact
 * pricing line, so the worst case is the sentence that ships today plus one question. Pinned by
 * walkin_pricing_ask_tail:eval.
 */
export function buildWalkInPricingFollowUpTail(input: {
  modelLabel?: string | null;
  yearLabel?: string | null;
  condition?: "new" | "used" | null;
  softAsk?: string | null;
}): string {
  const ask = String(input.softAsk ?? "").trim();
  const withAsk = (base: string) => (ask ? `${base} ${ask}` : base);
  const model = String(input.modelLabel ?? "").replace(/\s+/g, " ").trim();
  // "bike" is `formatWatchModelForMessage`'s placeholder for "no model resolved", not a model.
  if (!model || /^bike$/i.test(model)) {
    return withAsk("I’ll follow up with pricing details and next steps.");
  }
  const year = String(input.yearLabel ?? "").replace(/\s+/g, " ").trim();
  const modelCarriesYear = /(?:^|\s)(?:19|20)\d{2}(?:\s|-|$)/.test(model);
  const condition = input.condition === "new" ? "new" : input.condition === "used" ? "pre-owned" : "";
  const spec = [condition, year && !modelCarriesYear ? year : "", model].filter(Boolean).join(" ");
  return withAsk(`I’ll get you the numbers on the ${spec}.`);
}

/**
 * May the availability/watch tail speak on a walk-in first touch?
 *
 * Lifted verbatim out of `routes/sendgridInbound.ts` so it can be EXECUTED by an eval — a
 * source-text assertion cannot prove a route file still asks the question (the ratchet trap:
 * un-wiring a guard leaves every pure assertion green). The only NEW term is the pricing one.
 *
 * `hasPricingFollowupIntent` outranks it because the two sentences answer different questions and
 * only one of them was asked. "I'll keep an eye out for a used Street Glide" is a reply to "do you
 * have one"; the note that carries a price follow-up has already answered that — usually by saying
 * the customer stood next to the bike. Availability is what we say when we have nothing else.
 */
export function shouldWalkInAvailabilityTailSpeak(input: {
  modelLabel?: string | null;
  hasPricingFollowupIntent?: boolean | null;
  hasCompletedTestRideSignal?: boolean | null;
  hasDealProgressSignal?: boolean | null;
  hasHoldSignal?: boolean | null;
  hasResumeHoldSignal?: boolean | null;
  hasReminderRequest?: boolean | null;
}): boolean {
  if (!String(input.modelLabel ?? "").trim()) return false;
  if (input.hasPricingFollowupIntent) return false;
  return !(
    input.hasCompletedTestRideSignal ||
    input.hasDealProgressSignal ||
    input.hasHoldSignal ||
    input.hasResumeHoldSignal ||
    input.hasReminderRequest
  );
}

/**
 * Does a walk-in staff note state that the open item is the PRICE?
 *
 * Moved here from `routes/sendgridInbound.ts` unchanged, for the reason `hasWatchIntentPhrase`
 * moved into walkInInventoryWant.ts: an eval must exercise the expression that actually runs, not
 * a hand-copy that drifts (PR #432). Behaviour is byte-identical to the inline version.
 *
 * KEEP arm under the fail-direction test (AGENTS.md): this reads a SALESPERSON'S OWN LOG, not a
 * customer's intent — "Follow up on price (Step 2)" is a staff instruction with a fixed vocabulary,
 * and it is deterministic structured extraction, not comprehension. It also only ever selects which
 * true sentence we send; removing it fails toward the generic availability line, which is the bug.
 * The parser arm still runs beside it at the call site and either one is enough.
 */
export function hasWalkInPricingFollowUpPhrase(text?: string | null): boolean {
  const source = String(text ?? "");
  if (!source.trim()) return false;
  return (
    /\b(follow up|follow-up|check in|circle back|touch base)\b[\s\S]{0,40}\b(pricing|price|numbers?)\b/i.test(
      source
    ) ||
    /\b(pricing|price|numbers?)\b[\s\S]{0,40}\b(follow up|follow-up|check in|circle back|touch base)\b/i.test(
      source
    )
  );
}

/**
 * The walk-in FIRST-TOUCH closing ask — does this reply get one?
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────────
 * The ladder-health sweep has alarmed on `Traffic Log Pro` for five consecutive runs: **15
 * agent-owned first touches, 0 asked anything.** Reading the sent bodies says why — every branch of
 * the walk-in tail ends with a PROMISE FROM US and never a question to them:
 *   "Thanks for stopping in - I'll follow up about pre-owned trikes."
 *   "Thanks for stopping in - I'll check back in soon like we discussed."
 *   "Thanks for stopping in. If you want, I can send a quick recap on the Road King."
 * These are the warmest leads the store has — they were physically in the building — and we close
 * the first text by telling them to wait for us.
 *
 * #655 already built the ask Joe asked for and wired it at ONE call site
 * (`buildDealerLeadAppPostRideReply`); #673 wired it to the pricing tail. The sibling lane carrying
 * the volume never got it. **This adds no new copy class:** the sentence is Joe's own wording from
 * 2026-08-11, produced by `buildWalkInSoftTimingAsk` (visitFraming.ts) and passed IN by the caller,
 * so this file stays a dependency-free leaf.
 *
 * ── THE POLICY, and the measured reason for each guard ────────────────────────────────────────
 * FIRST-TOUCH BAND ONLY (`step <= 4`). Steps 5-8 are already deep in a deal — the customer sat
 * down, numbers are being worked, finance is running — and those tails legitimately promise "I'll
 * follow up with final numbers". Bolting "want to stop back in?" onto a live worksheet is noise,
 * not a ladder. Step 9 is post-sale.
 * NEVER TWO QUESTIONS. If the reply already asks something it keeps its own question; the
 * advancing-question rule is ONE question and a stacked pair reads as a bot.
 * NOT WHEN A RETURN VISIT IS ALREADY COMMITTED. Ed Szulist and Paul Harrigan told us in the intake
 * note exactly when they are coming back (#681). Asking "want to set up a time?" of someone who
 * named a day is the re-ask failure the whole ladder work exists to stop.
 * NOT ON AN INVENTORY WATCH. When the tail is "I'll keep an eye out for a Road King and let you
 * know if one comes in", there is nothing here to come and see — inviting them in contradicts the
 * sentence immediately before it. Measured: 3 of the 15 alarmed first touches are this shape
 * (Tom Jeffree, Craig Tamborski, Scott Mateyunas), and they are the ones that must stay as they are.
 * NOT ON FINANCE / DEAL-PROGRESS / HOLD / COMPLETED-RIDE turns, where the true next step is
 * someone calling them and the tail already says so.
 *
 * ── FAIL DIRECTION ────────────────────────────────────────────────────────────────────────────
 * Safe. A miss is exactly today's behaviour (the reply ships unchanged, asking nothing). An
 * over-fire adds one soft, day-less invitation to a customer who has already been in the store —
 * the sentence Joe specified for this lane. It books nothing, claims nothing, states no figure.
 * Pure, so `walkin_first_touch_ask:eval` EXECUTES it instead of asserting on route source text —
 * the same reason `shouldWalkInAvailabilityTailSpeak` was lifted out of the route.
 */
export function appendWalkInFirstTouchAsk(input: {
  /** The fully assembled reply (greeting + tail + addendum). The ask always lands LAST. */
  reply: string | null | undefined;
  /** Walk-in ladder step (1-9). A non-Traffic-Log-Pro turn passes 0 and never asks. */
  step: number;
  /** `buildWalkInSoftTimingAsk(alreadyVisited, inStock)` from the caller — never built here. */
  softAsk?: string | null;
  /**
   * Any state where the invitation would be wrong or redundant: a committed return visit, an
   * inventory watch, finance/deal progress, a hold, a completed test ride. The caller already has
   * these signals in scope; this module does not re-derive them.
   */
  suppressed?: boolean;
}): string {
  const reply = String(input.reply ?? "");
  if (!reply.trim()) return reply;
  const step = Math.trunc(Number(input.step));
  if (!Number.isFinite(step) || step < 1 || step > 4) return reply; // first-touch band only
  if (input.suppressed) return reply;
  if (reply.includes("?")) return reply; // it already asks — never stack a second question
  const ask = String(input.softAsk ?? "").trim();
  if (!ask) return reply;
  return `${reply.trimEnd()} ${ask}`;
}
