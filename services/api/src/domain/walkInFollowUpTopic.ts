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

export function buildWalkInReturnVisitTail(input: {
  ackSentence: string;
  returnVisit: string;
  confidence?: number | null;
  confidenceMin: number;
  dayLabel?: string | null;
  familyLabel?: string | null;
  testRide?: boolean | null;
}): string {
  if (input.returnVisit !== "committed_day") return "";
  const confidence = typeof input.confidence === "number" ? input.confidence : 0;
  if (!(confidence >= input.confidenceMin)) return "";
  const day = String(input.dayLabel ?? "").trim();
  if (!day) return "";
  const ack = String(input.ackSentence ?? "").trim();
  const family = String(input.familyLabel ?? "").trim();
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
