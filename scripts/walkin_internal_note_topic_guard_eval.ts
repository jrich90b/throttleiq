/**
 * Walk-in internal-note follow-up topic guard eval.
 *
 * Pins the fail-safe guard that stops a Traffic Log Pro walk-in ack from parroting an INTERNAL
 * staff-log "Inquiry" back to the customer (+17168638237, 2026-07-22: a generated first-touch draft
 * read "…I'll follow up about his 2018 Heritage that was here for inspection ($8000)"). The guard
 * rejects an extracted follow-up topic that reads like an internal note; the tail then falls back to
 * the generic "Thanks for stopping in today" line (fail-safe).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  isInternalNoteFollowUpTopic,
  buildWalkInSpecRecapClause,
  buildWalkInReturnVisitTail,
  formatWalkInReturnDayLabel,
  formatWalkInFamilyLabel,
  describeWalkInNoteProvenance,
  resolveWalkInFollowUpSubject
} from "../services/api/src/domain/walkInFollowUpTopic.ts";
import { referencesFamilyOnlyInText } from "../services/api/src/domain/modelFamily.ts";
import { parseRequestedDateOnly } from "../services/api/src/domain/conversationStore.ts";
import { buildIntentJudgePrompt } from "./intent_handled_audit.ts";
import {
  hasAdfFinanceApplicationContext,
  buildTimingAwareWalkInFollowUpLine,
  isTimingOnlyFollowUpTopic
} from "../services/api/src/domain/workflowRegressionGuards.ts";
import {
  buildWalkInOutcomePrompt,
  coerceUnmetInventoryWant,
  coerceWalkInReturnVisit,
  coerceWalkInOutcomeState,
  extractWatchDirectiveSegment,
  hasWatchIntentPhrase,
  resolveWalkInNoteColor,
  WALK_IN_OUTCOME_EXAMPLES
} from "../services/api/src/domain/walkInInventoryWant.ts";

// The exact production failure topic, and each internal-note tell in isolation → rejected.
assert.equal(
  isInternalNoteFollowUpTopic("his 2018 Heritage that was here for inspection ($8000)"),
  true,
  "the +17168638237 internal appraisal note must be rejected"
);
assert.equal(isInternalNoteFollowUpTopic("his 2018 Heritage"), true, "third-person 'his' about the customer");
assert.equal(isInternalNoteFollowUpTopic("her trade"), true, "third-person 'her' about the customer");
assert.equal(isInternalNoteFollowUpTopic("trade in value of $8000"), true, "a dollar appraisal figure");
assert.equal(isInternalNoteFollowUpTopic("$12,500 offer"), true, "any specific dollar figure");
assert.equal(isInternalNoteFollowUpTopic("gave him the trade-in value"), true, "internal 'gave him' phrasing");
assert.equal(isInternalNoteFollowUpTopic("the bike that was here for inspection"), true, "internal 'here for inspection'");
assert.equal(isInternalNoteFollowUpTopic("the appraisal on the trade"), true, "internal 'appraisal'");

// Legit customer-stated follow-up topics are KEPT — the guard must not over-suppress.
for (const ok of [
  "pricing on the Street Glide",
  "the Road Glide",
  "financing options",
  "a test ride this weekend",
  "the new models",
  "colors and availability"
]) {
  assert.equal(isInternalNoteFollowUpTopic(ok), false, `legit topic kept: ${ok}`);
}
assert.equal(isInternalNoteFollowUpTopic(""), false, "empty → no topic to reject");
assert.equal(isInternalNoteFollowUpTopic(null), false, "null → false");

// Wiring: the Traffic Log Pro topic extractor must actually call the guard (both are in the intake
// path; there is no regen twin — buildTrafficLogProWalkInTail has a single caller).
const sendgrid = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");
assert.ok(
  /isInternalNoteFollowUpTopic\(/.test(sendgrid),
  "extractTrafficLogProFollowUpTopic must call isInternalNoteFollowUpTopic so an internal note can't become the topic"
);

// --- Spec recap: say back what the salesperson wrote down (Joe ruling 2026-07-28) ----------
// Larry Godzich +17164327329, 2026-07-27. Scott's note: "…asking about pre-owned trikes… Is
// looking for 2017-2020 Tri Glide in the $25,000 range (Step 2)". The whole first text back was
// "Thanks for stopping in today - I'll follow up about pre-owned trikes." — the day's only tone
// failure (65, intent_mismatch), fluent and blind to the specifics.
assert.equal(
  buildWalkInSpecRecapClause({ modelLabel: "Tri Glide", yearLabel: "2017-2020", condition: "used" }),
  "Just so I've got it right — you're looking for a pre-owned 2017-2020 Tri Glide.",
  "Larry's logged spec is repeated back to him"
);
assert.equal(
  buildWalkInSpecRecapClause({ modelLabel: "Street Glide", yearLabel: "", condition: "new" }),
  "Just so I've got it right — you're looking for a new Street Glide.",
  "condition alone is enough to be worth confirming"
);
assert.equal(
  buildWalkInSpecRecapClause({ modelLabel: "Road Glide", yearLabel: "2024", condition: null }),
  "Just so I've got it right — you're looking for a 2024 Road Glide.",
  "a single year reads as a year, not a range (formatWatchYearLabel feeds this)"
);
// Nothing to confirm beyond the model the tail already names → stay silent rather than pad.
assert.equal(buildWalkInSpecRecapClause({ modelLabel: "Road Glide" }), "", "model alone adds nothing");
assert.equal(buildWalkInSpecRecapClause({ modelLabel: "", yearLabel: "2017-2020", condition: "used" }), "", "no model => no recap");
assert.equal(buildWalkInSpecRecapClause({}), "", "no slots => no recap");

// THE POINT OF THIS MODULE: the recap is built from parsed SLOTS, never note prose. A budget
// figure is deliberately not a slot it accepts — a dollar amount in a walk-in note is as likely
// to be a trade appraisal as a budget, which is the leak the guard above exists to stop.
for (const clause of [
  buildWalkInSpecRecapClause({ modelLabel: "Heritage", yearLabel: "2018", condition: "used" }),
  buildWalkInSpecRecapClause({ modelLabel: "Tri Glide", yearLabel: "2017-2020", condition: "used" })
]) {
  assert.doesNotMatch(clause, /\$\s?\d/, "a recap never carries a dollar figure");
  assert.doesNotMatch(clause, /\b(?:his|him|her|hers)\b/i, "a recap never carries third-person staff phrasing");
  assert.equal(isInternalNoteFollowUpTopic(clause), false, "a recap must pass the internal-note guard it sits beside");
}

// Wiring: the Traffic Log Pro step tail must actually append the recap.
assert.ok(
  /buildWalkInSpecRecapClause\(\{/.test(sendgrid),
  "the TLP walk-in tail must append the spec recap (Larry Godzich)"
);

// --- A staff note that MENTIONS credit is not a credit-app lead (Brent Marshall, 7/29) --------
// Same principle as everything above: on a Traffic Log Pro payload the Inquiry field is our own
// staff log, so routing may not be read out of its prose. +17169941544 was classified
// finance_prequal/hdfs_coa — payments_handoff, an approval todo, a manual handoff, a stopped
// cadence, and a first draft claiming "Thanks — I received your credit application" — because the
// salesperson's note happened to say "…we would need to redo credit application".
const BRENT_TLP_NOTE =
  "Looking for a 2026 Road Glide in Dark Billiard gray with black motor. Told him we have one " +
  "coming in but not till late August and we would need to redo credit application.";
assert.equal(
  hasAdfFinanceApplicationContext({
    leadSource: "Traffic Log Pro",
    proseTexts: ["Traffic Log Pro", BRENT_TLP_NOTE, BRENT_TLP_NOTE],
    appIdTexts: [BRENT_TLP_NOTE],
    trafficLogPayloadHint: true,
    walkInSignalHint: false
  }),
  false,
  "+17169941544: a TLP staff note that merely mentions a credit application is NOT a credit-app lead"
);
// The other staff-log shapes we see in TLP Inquiry fields must stay clean too.
for (const note of [
  "Customer called asking about FLHD Deadwood availability. I gave him book values and said we would run a credit app if he wants numbers.",
  "Robert came in asking about pre-owned trikes. Told him to prequalify online. (Step 2)",
  "Told her the finance application can wait until she picks a bike."
]) {
  assert.equal(
    hasAdfFinanceApplicationContext({
      leadSource: "Traffic Log Pro",
      proseTexts: ["Traffic Log Pro", note],
      appIdTexts: [note],
      trafficLogPayloadHint: true,
      walkInSignalHint: false
    }),
    false,
    `TLP staff log stays a sales lead: ${note.slice(0, 48)}…`
  );
}

// POSITIVE CONTROLS — every path a REAL application arrives on must still route. These are the
// live shapes: the Source names the credit product, or the TLP payload carries an `App ID:`.
assert.equal(
  hasAdfFinanceApplicationContext({
    leadSource: "HDFS COA Online",
    proseTexts: ["HDFS COA Online", "App ID: 1013958809, Model Year: 2016, Model: Roadster"],
    appIdTexts: ["App ID: 1013958809, Model Year: 2016, Model: Roadster"],
    trafficLogPayloadHint: false,
    walkInSignalHint: false
  }),
  true,
  "+12707344947: an HDFS COA Online lead is still a credit-app lead"
);
assert.equal(
  hasAdfFinanceApplicationContext({
    leadSource: "Marketplace - Rider to Rider Credit App",
    proseTexts: ["Marketplace - Rider to Rider Credit App", "App ID: 101393"],
    appIdTexts: ["App ID: 101393"],
    trafficLogPayloadHint: false,
    walkInSignalHint: false
  }),
  true,
  "+17162658201: a Rider to Rider Credit App lead is still a credit-app lead"
);
assert.equal(
  hasAdfFinanceApplicationContext({
    leadSource: "Traffic Log Pro",
    proseTexts: ["Traffic Log Pro", "App ID: 1013958809"],
    appIdTexts: ["App ID: 1013958809"],
    trafficLogPayloadHint: true,
    walkInSignalHint: false
  }),
  true,
  "a TLP payload with a structured App ID: really did post an application"
);
// A recognized WALK-IN still vetoes the App ID arm — unchanged from the prior contract.
assert.equal(
  hasAdfFinanceApplicationContext({
    leadSource: "Traffic Log Pro",
    proseTexts: ["Traffic Log Pro", "Customer stopped in. App ID: 1013958809"],
    appIdTexts: ["Customer stopped in. App ID: 1013958809"],
    trafficLogPayloadHint: true,
    walkInSignalHint: true
  }),
  false,
  "walkInSignalHint still vetoes the App ID arm"
);
// NON-TLP ADFs are unchanged: there the inquiry text really is the customer talking.
assert.equal(
  hasAdfFinanceApplicationContext({
    leadSource: "Room58 - Request details",
    proseTexts: ["Room58 - Request details", "I filled out a credit application last week, any word?"],
    appIdTexts: ["I filled out a credit application last week, any word?"],
    trafficLogPayloadHint: false,
    walkInSignalHint: false
  }),
  true,
  "a customer's OWN words on a web form still signal finance context"
);
assert.equal(
  hasAdfFinanceApplicationContext({
    leadSource: "Room58 - Request details",
    proseTexts: ["Room58 - Request details", "Do you have any Road Glides in stock?"],
    appIdTexts: ["Do you have any Road Glides in stock?"],
    trafficLogPayloadHint: false,
    walkInSignalHint: false
  }),
  false,
  "an ordinary web inquiry is not a finance lead"
);
assert.equal(hasAdfFinanceApplicationContext({}), false, "no fields → no finance context");

// Wiring: intake must go through the helper, and the old inline prose regex must be gone (that
// regex reading lead.inquiry on a TLP payload IS the defect).
assert.ok(
  /hasAdfFinanceApplicationContext\(\{/.test(sendgrid),
  "adfFinanceContextSignal must be computed by hasAdfFinanceApplicationContext"
);
assert.doesNotMatch(
  sendgrid,
  /credit\\s\*app\(\?:lication\)\?[\s\S]{0,200}\.test\(\s*\[leadSource, lead\.comment/,
  "the inline finance regex over lead.inquiry/comment must not come back"
);

// ── The intent judge must be told the walk-in note is STAFF-written ────────────────────
// The agent side of this module already knows a TLP "Inquiry" is an internal staff log. The judge
// did not: it read the note as the customer's words, invented an ask, and filed a P1
// corpus_replay_judge_fail on a reply that honored the note exactly.
{
  // THE PRODUCTION TURN (+17169705448, msg_9d8dbbc321971_1775078277067, replayed 2026-07-30).
  // Scott's note defers the follow-up; extractWeatherFollowUpPlan defers the cadence to match.
  const note = "Reach to to schedule a test ride for the end of next week when the weather looks better. (Step 3)";
  const body = [
    "WEB LEAD (ADF)",
    "Source: Traffic Log Pro",
    "Ref: 10879",
    "Name: Dan Lamancuso",
    "Year: 2026",
    "Vehicle: Harley-Davidson Street Glide",
    "",
    "Inquiry:",
    "reach to to schedule a test ride for the end of next week when the weather looks better. (step 3)"
  ].join("\n");

  const prov = describeWalkInNoteProvenance({ body, walkIn: true, walkInComment: note });
  assert.ok(prov, "the pinned walk-in turn must carry provenance (case-insensitive note match)");
  assert.match(prov!, /not a message the customer typed/, "provenance must say the customer did not write it");
  assert.ok(prov!.includes(note), "provenance must quote the staff note verbatim");
  // PROVENANCE ONLY: it must never coach the judge toward a verdict, or it would launder real
  // misses (a walk-in note asking for email updates answered with "thanks for the update").
  assert.doesNotMatch(prov!, /addressed|acceptable|by design|do not fail|counts as/i, "must not tell the judge what passes");

  // Fail direction — every path that is not a confirmed walk-in note returns null, leaving the
  // prompt byte-identical to today's.
  assert.equal(describeWalkInNoteProvenance({ body, walkIn: false, walkInComment: note }), null, "not a walk-in lead");
  assert.equal(describeWalkInNoteProvenance({ body, walkIn: true, walkInComment: "" }), null, "no note");
  assert.equal(
    describeWalkInNoteProvenance({ body, walkIn: true, walkInComment: "Wants a Road Glide in the spring" }),
    null,
    "a note the body does not carry is never used to relabel the inbound"
  );
  assert.equal(
    describeWalkInNoteProvenance({ body: "Do you have any 883s left?", walkIn: true, walkInComment: note }),
    null,
    "a real customer SMS on a walk-in thread stays the customer's own words"
  );

  // Prompt wiring: provenance replaces the false "Customer's latest message" label.
  const base = {
    convId: "+17169705448",
    at: "2026-04-01T21:17:57.066Z",
    replyText: "Thanks for stopping in. I'll plan to follow up end of next week.",
    replyKind: "draft" as const,
    context: []
  };
  const withProv = buildIntentJudgePrompt({ ...base, inboundText: body, inboundProvenance: prov });
  assert.match(withProv, /Latest inbound record:/, "a staff-note inbound is not labelled as the customer's message");
  assert.doesNotMatch(withProv, /Customer's latest message:/, "the false label must be gone");
  assert.ok(withProv.includes(prov!), "the prompt carries the provenance line");

  const plain = buildIntentJudgePrompt({ ...base, inboundText: "Do you have any 883s left?" });
  assert.match(plain, /Customer's latest message:/, "a real customer message keeps today's label");
  assert.doesNotMatch(plain, /PROVENANCE:/, "no provenance line without a walk-in note");
}

// Wiring: EVERY site that builds an IntentJudgeCandidate must populate provenance, or that judge
// keeps grading the staff note as customer speech. reproduce_confirm_sweep is the one that decides
// whether a pinned finding still reproduces — an unlabelled judge there re-confirms the very
// false positives this fixes (caught by the PR #368 cross-model reviewer).
const JUDGE_CALL_SITES = [
  "scripts/corpus_replay_flywheel.ts",
  "scripts/intent_handled_audit.ts",
  "scripts/reproduce_confirm_sweep.ts"
];
// These two cache verdicts on disk; the live audit judges fresh every run.
const CACHED_JUDGE_SITES = new Set(["scripts/corpus_replay_flywheel.ts", "scripts/reproduce_confirm_sweep.ts"]);
for (const site of JUDGE_CALL_SITES) {
  const src = fs.readFileSync(site, "utf8");
  assert.match(src, /inboundProvenance/, `${site} must pass inboundProvenance to the judge`);
  if (!CACHED_JUDGE_SITES.has(site)) continue;
  // A cached verdict judged WITHOUT provenance graded a different question — never reuse it.
  assert.match(src, /"##walkin-prov"/, `${site} judge cache key must change when provenance applies`);
}
// No FOURTH site may appear unlabelled: every IntentJudgeCandidate construction is accounted for.
{
  const all = fs
    .readdirSync("scripts")
    .filter(f => f.endsWith(".ts") && !f.endsWith("_eval.ts"))
    .filter(f => /:\s*IntentJudgeCandidate\s*=/.test(fs.readFileSync(`scripts/${f}`, "utf8")))
    .map(f => `scripts/${f}`)
    .sort();
  assert.deepEqual(
    all,
    JUDGE_CALL_SITES.filter(s => all.includes(s)).sort(),
    `a new judge call site must pass provenance too — found ${JSON.stringify(all)}`
  );
}

// --- A logged WANT must be able to start a watch (Larry Godzich, operator-reported 8/1) -------
// Same lead as the spec recap above, one level deeper. The 7/28 ruling made the reply SAY the
// spec back ("you're looking for a pre-owned 2017-2020 Tri Glide") while still keeping no watch,
// so the text described a watch we were not keeping. Operator, 2026-08-01: "THIS SHOULD HAVE
// TRIGGERED A WATCH FROM THE ADF."
const LARRY_TLP_NOTE =
  "Was in for the Back the Blue ride and was asking about pre-owned trikes. Showed him and " +
  "his wife Kim the 2019 we have in the back (waiting on lien release). Is looking for " +
  "2017-2020 Tri Glide in the $25,000 range (Step 2)";

// THE DEFECT, PINNED NEGATIVELY: the regex arm cannot ever carry this note, because a
// salesperson's log contains no notify verb. This is why the fix had to be a parser and not
// another phrase — do not "solve" a future miss like this by widening the regex.
assert.equal(
  hasWatchIntentPhrase(LARRY_TLP_NOTE),
  false,
  "Larry's note carries no notify verb — the KEEP regex arm structurally cannot watch it"
);
assert.equal(
  extractWatchDirectiveSegment(LARRY_TLP_NOTE),
  "",
  "no 'watch for' directive segment either"
);
// ...and the arm still fires on the notes it was written for (it is a KEEP, not dead code).
for (const withVerb of [
  "please watch for a 2024-2025 pre-owned street glide",
  "let me know when one comes in",
  "keep an eye out for a Road Glide in vivid black"
]) {
  assert.equal(hasWatchIntentPhrase(withVerb), true, `KEEP arm still fires: ${withVerb}`);
}

// The want lane fails CLOSED: anything the prompt might invent later reads as "no watch",
// never as the one watchable lane.
assert.equal(coerceUnmetInventoryWant("open_search"), "open_search");
assert.equal(coerceUnmetInventoryWant("OPEN_SEARCH "), "open_search", "case/space tolerated");
for (const bad of ["", null, undefined, "watch", "openSearch", "yes", 1, {}]) {
  assert.equal(coerceUnmetInventoryWant(bad as unknown), "none", `unknown lane => none: ${String(bad)}`);
}

// The prompt surface must actually teach the lanes, or the schema field is decoration. Pin the
// production note as a few-shot and the three negative lanes drawn from the real TLP corpus.
const wantPrompt = buildWalkInOutcomePrompt({ text: LARRY_TLP_NOTE, historyLines: [] });
assert.ok(wantPrompt.includes(LARRY_TLP_NOTE), "the production turn rides in the prompt as a few-shot");
for (const lane of ["open_search", "specific_unit", "order", "incoming_allocated"]) {
  assert.ok(wantPrompt.includes(lane), `the prompt must define the ${lane} lane`);
}
assert.match(
  wantPrompt,
  /lien\s+release/i,
  "the prompt must say a unit we cannot deliver yet does not satisfy the want — that is the whole Larry case"
);
// The prompt keeps its ORIGINAL job intact: the walk-in state enum must survive the extraction.
for (const state of ["deposit_left", "sold_delivered", "docs_or_insurance_pending"]) {
  assert.ok(wantPrompt.includes(state), `the extracted prompt still teaches state=${state}`);
}

// THE "king" INSIDE "loo-king" COLLISION (#406) IS LOAD-BEARING HERE: this note reads
// "Is loo-king for". Any model resolution over it must be whole-word, or Larry gets a Road King
// watch instead of a Tri Glide one.
assert.equal(
  /\bking\b/i.test(LARRY_TLP_NOTE),
  false,
  "'looking' must not offer a whole-word 'king' — the substring watch-model collision stays dead"
);

// WIRING: the ADF walk-in lane must ask the referee, and must no longer compose its own
// parser-or-regex pair inline (AGENTS.md: route decisions are centralized and pure).
assert.ok(
  /decideWalkInInventoryWatchTurn\(\{/.test(sendgrid),
  "the walk-in watch gate must go through decideWalkInInventoryWatchTurn"
);
assert.doesNotMatch(
  sendgrid,
  /hasWatchIntent\s*=\s*hasWatchIntentFromParser\s*\|\|\s*hasWatchIntentFromText/,
  "the inline `parser || regex` watch gate must be gone — the referee owns this decision"
);
// DARK BY DEFAULT: the new arm ships off. A flag that defaults ON would make this PR a
// behavior change rather than the shadow it claims to be.
assert.ok(
  /WALKIN_INVENTORY_WANT_WATCH\s*===\s*"1"/.test(sendgrid),
  "the want arm must be opt-IN (=== \"1\"), so an unset env is today's behavior"
);
assert.ok(
  /walkin_want_watch shadow/.test(sendgrid),
  "the dark arm must log what it WOULD have watched, or the flip has no evidence behind it"
);

// --- The committed return day (Ed Szulist +17167255404, 2026-08-01) ---------------------------
// The Traffic Log Pro note named the day he was walking in on; the draft said "I'll follow up
// shortly with next steps" and Stone rewrote it by hand to ask for a time window. Same law as the
// spec recap above: the clause is built from parsed SLOTS, never the note prose.
const ED_TLP_NOTE =
  "COMING BACK NXT WEEK TUESDAY AUGUST 4TH TO TEST RIDE A FEW DIFFERENT SPORTSTERS (Step 5)";
const ED_ASOF = "2026-08-01T18:20:05.402Z"; // the production turn's clock, injected — never Date.now()
const ED_TZ = "America/New_York";

// The day resolves through the SAME parser the scheduling lane uses, and renders as a label.
assert.equal(
  formatWalkInReturnDayLabel(parseRequestedDateOnly("Tuesday August 4th", ED_TZ), ED_TZ, ED_ASOF),
  "Tuesday, Aug 4",
  "Ed's logged return day resolves and renders"
);

// THE PRODUCTION TURN: what the first text back should have said.
const edTail = buildWalkInReturnVisitTail({
  ackSentence: "Thanks again for your time.",
  returnVisit: "committed_day",
  confidence: 0.95,
  confidenceMin: 0.8,
  dayLabel: "Tuesday, Aug 4",
  familyLabel: formatWalkInFamilyLabel(referencesFamilyOnlyInText(ED_TLP_NOTE)),
  testRide: true
});
assert.equal(
  edTail,
  "Thanks again for your time. What time works best Tuesday, Aug 4? I'll have a few Sportsters ready for you.",
  "+17167255404: the committed day is said back and the open question is asked"
);
// Pin the SHIPPED draft as the defect, so it cannot quietly return.
assert.notEqual(
  edTail,
  "Thanks again for your time. I'll follow up shortly with next steps.",
  "the generic promise is the bug, not the fallback for this note"
);

// FAIL-CLOSED MATRIX — every one of these is today's behavior (an empty clause → generic tail).
const base = {
  ackSentence: "Thanks again for your time.",
  returnVisit: "committed_day",
  confidence: 0.95,
  confidenceMin: 0.8,
  dayLabel: "Tuesday, Aug 4",
  familyLabel: "Sportsters",
  testRide: true
};
assert.equal(buildWalkInReturnVisitTail({ ...base, returnVisit: "tentative" }), "", "no day named => nothing to ask");
assert.equal(buildWalkInReturnVisitTail({ ...base, returnVisit: "none" }), "", "no return commitment => silent");
assert.equal(
  buildWalkInReturnVisitTail({ ...base, returnVisit: "committed_day_and_time" }),
  "",
  "day AND time already settled => never ask a customer for a time they gave us"
);
assert.equal(buildWalkInReturnVisitTail({ ...base, confidence: 0.7 }), "", "under the confidence floor => silent");
assert.equal(buildWalkInReturnVisitTail({ ...base, confidence: null }), "", "no confidence => silent");
assert.equal(buildWalkInReturnVisitTail({ ...base, dayLabel: "" }), "", "a day that did not resolve => silent");
// The family phrase is optional; the ask is not.
assert.equal(
  buildWalkInReturnVisitTail({ ...base, familyLabel: "" }),
  "Thanks again for your time. What time works best Tuesday, Aug 4? I'll make sure we're ready for you.",
  "an unmapped family drops the phrase rather than inventing a name"
);

// THE DATE WINDOW. parseRequestedDateOnly ROLLS A BARE DATE FORWARD, so re-reading "August 4th"
// in September resolves to next year — a draft must never invite someone to a visit 11 months out.
assert.equal(
  formatWalkInReturnDayLabel(parseRequestedDateOnly("August 4th", ED_TZ), ED_TZ, "2026-09-01T12:00:00.000Z"),
  "",
  "a rolled-forward date beyond the window renders nothing"
);
assert.equal(
  formatWalkInReturnDayLabel({ year: 2026, month: 7, day: 30 }, ED_TZ, ED_ASOF),
  "",
  "a day already past renders nothing"
);
assert.equal(formatWalkInReturnDayLabel(null, ED_TZ, ED_ASOF), "", "an unresolvable day renders nothing");
assert.equal(
  formatWalkInReturnDayLabel({ year: 2026, month: 8, day: 1 }, ED_TZ, ED_ASOF),
  "Saturday, Aug 1",
  "today itself still counts as a return day"
);

// THE FAMILY FALLBACK IS THE EXISTING CATALOG RESOLVER, NOT A NEW REGEX. This is the whole reason
// the note produced no model: the walk-in path's own hint is word-bounded and the note says the
// PLURAL. Widening that regex would push a family into modelLabel, which feeds the watch referee.
assert.equal(referencesFamilyOnlyInText(ED_TLP_NOTE.toLowerCase()), "sportster", "the family resolver reads the plural");
assert.equal(/\b(?:sportster)\b/i.test("SPORTSTERS"), false, "the plural is why the model hint missed — do NOT widen that regex");
assert.equal(formatWalkInFamilyLabel("sportster"), "Sportsters");
assert.equal(formatWalkInFamilyLabel("nightster"), "", "an unmapped family gets no invented label");
assert.equal(formatWalkInFamilyLabel(null), "");

// The clause obeys the law of the module it lives in.
assert.equal(isInternalNoteFollowUpTopic(edTail), false, "the return-visit clause passes the internal-note guard");
assert.doesNotMatch(edTail, /\$\s?\d/, "never a dollar figure");
assert.doesNotMatch(edTail, /\b(?:his|him|her|hers)\b/i, "never third-person staff phrasing");

// COERCION FAILS CLOSED — an unknown lane must read as "say nothing", never as the speaking one.
for (const bad of ["", null, undefined, "yes", "committedDay", "committed", 1, {}]) {
  assert.equal(coerceWalkInReturnVisit(bad as unknown), "none", `unrecognized return_visit => none: ${String(bad)}`);
}
assert.equal(coerceWalkInReturnVisit("committed_day"), "committed_day");
assert.equal(coerceWalkInReturnVisit(" Tentative "), "tentative", "trimmed and lowercased like its want sibling");
assert.equal(coerceWalkInReturnVisit(" COMMITTED_DAY "), "committed_day", "case/whitespace is normalized, not rejected");

// The state coercion moved out of llmDraft.ts (it paid for the new fields). Same fifteen strings.
for (const state of ["deposit_left", "sold_delivered", "docs_or_insurance_pending", "hold_cleared"]) {
  assert.equal(coerceWalkInOutcomeState(state), state, `state survives the move: ${state}`);
}
for (const bad of ["", null, "dealFinalizing", "unknown", 7]) {
  assert.equal(coerceWalkInOutcomeState(bad as unknown), "none", `unrecognized state => none: ${String(bad)}`);
}

// THE PROMPT MUST ACTUALLY TEACH THE SLOTS, and teach the trap: most dates in these notes are OURS.
const edPrompt = buildWalkInOutcomePrompt({ text: ED_TLP_NOTE, historyLines: [] });
for (const token of ["return_visit", "return_day_text", "return_visit_confidence", "committed_day_and_time", "tentative"]) {
  assert.ok(edPrompt.includes(token), `the prompt teaches ${token}`);
}
assert.ok(edPrompt.includes(ED_TLP_NOTE), "the production turn rides as a few-shot");
assert.match(edPrompt, /projected ship date/i, "an OUR-date negative is taught (a ship date is not a visit)");
assert.match(edPrompt, /never in follow_up_window_text/i, "the day must not double-book with the follow-up window");
assert.match(edPrompt, /A date that is OURS/i, "the prompt states the trap in so many words");

// WIRING, pinned as ORDERING rather than source syntax. Each index is checked against -1 first:
// a missing needle makes indexOf return -1, and -1 < everything, so an unguarded ordering
// assertion passes while guarding nothing (the failure mode that cost a sibling eval its grip).
const specRecapAt = sendgrid.indexOf("buildWalkInSpecRecapClause(");
const returnTailAt = sendgrid.indexOf("buildWalkInReturnVisitTail(");
const confidenceFloorAt = sendgrid.indexOf("WALKIN_RETURN_VISIT_CONFIDENCE_MIN");
const addendumAt = sendgrid.indexOf("const buildWalkInAddendum");
for (const [label, at] of [
  ["buildWalkInSpecRecapClause", specRecapAt],
  ["buildWalkInReturnVisitTail", returnTailAt],
  ["WALKIN_RETURN_VISIT_CONFIDENCE_MIN", confidenceFloorAt],
  ["buildWalkInAddendum", addendumAt]
] as [string, number][]) {
  assert.notEqual(at, -1, `the walk-in lane must still contain ${label}`);
}
assert.ok(specRecapAt < returnTailAt, "the return-visit tail is decided after the spec recap it supersedes");
assert.ok(returnTailAt < confidenceFloorAt, "the builder call carries its own confidence floor");
assert.ok(confidenceFloorAt < addendumAt, "the clause is settled before the addendum decides whether to add a test-ride ask");
// The slot must NOT be gated on walkInOutcomeAccepted — that gate needs an explicit_state from the
// state enum, which a "coming back to ride" note never has, so it would never fire.
assert.doesNotMatch(
  sendgrid.slice(returnTailAt - 600, returnTailAt),
  /walkInOutcomeAccepted[\s\S]{0,80}returnVisit/,
  "the return-visit slot must not ride on walkInOutcomeAccepted — unreachable for this note class"
);

// --- The follow-up subject is the BIKE, not the phrase trailing it (Joe report 2026-08-04) -----
// Rick Williamson Jr. +17165241170, Traffic Log Pro ref 11729, first touch sent
// 2026-08-04T14:10:16.148Z. Joe's report: "Why did this saying follow up on 'floor' in the
// original draft?"
//
// The note (production text, byte-for-byte):
//   "Rick Jr. was in for the back the blue ride and showed interest in the 2021 Road Glide Special
//    we have on the floor with the 131ci engine. Ran some numbers on his trade in. Needs follow up
//    (Step 2)"
// What shipped:
//   "Thanks for stopping in - I'll follow up about the floor with the 131ci engine."
//
// `extractTrafficLogProFollowUpTopic` takes the first about|on|with|regarding in the note and
// everything to the next `.` — here the "on" in "we have ON the floor" — so the topic became the
// locative modifier. The prose values pinned below are that extractor's VERIFIED output on the
// production text; the fix is that they can no longer BE the subject when a model slot resolved.
//
// NOTE ON SCOPE: this section asserts the TOPIC/subject field only. The colour half of the same
// two leads ("Back the Blue" → lead.vehicle.color = "blue") is a separate finding.
const RICK_JR_PROSE_TOPIC = "the floor with the 131ci engine";
const RICK_JR_SHIPPED_LINE = "Thanks for stopping in - I'll follow up about the floor with the 131ci engine.";

const rickJrSubject = resolveWalkInFollowUpSubject({
  proseTopic: RICK_JR_PROSE_TOPIC,
  modelLabel: "Road Glide Special",
  yearLabel: "2021",
  proseIsTimingOnly: false
});
assert.equal(rickJrSubject, "the 2021 Road Glide Special", "the subject is the unit, not the locative modifier");
const rickJrLine = buildTimingAwareWalkInFollowUpLine({
  base: "Thanks for stopping in -",
  followUpTopic: rickJrSubject,
  modelLabel: "Road Glide Special"
});
assert.equal(
  rickJrLine,
  "Thanks for stopping in - I'll follow up about the 2021 Road Glide Special.",
  "Rick Jr.'s first touch names the bike he came in for"
);
// The shipped sentence itself, pinned negatively — this is the defect, not a paraphrase of it.
assert.notEqual(rickJrLine, RICK_JR_SHIPPED_LINE, "the 2026-08-04 draft must not be reproducible");
assert.doesNotMatch(rickJrLine, /\bthe floor\b/i, "'the floor' is where the bike sits, never the topic");
assert.doesNotMatch(rickJrLine, /131ci/i, "an engine spec is a modifier, not a follow-up subject");

// Rick Williamson Sr. +17168609581, TLP ref 11728 — same event, same day, LATENT: his draft took
// the watch tail so this prose never shipped. Pinned because the next note like it will.
const rickSrSubject = resolveWalkInFollowUpSubject({
  proseTopic: "for the back the blue ride and was asking about pricing on Road Glide 3",
  modelLabel: "Road Glide 3",
  yearLabel: "",
  proseIsTimingOnly: false
});
assert.equal(rickSrSubject, "the Road Glide 3", "a whole clause is not a subject either");
assert.doesNotMatch(
  buildTimingAwareWalkInFollowUpLine({
    base: "Thanks for stopping in -",
    followUpTopic: rickSrSubject,
    modelLabel: "Road Glide 3"
  }),
  /follow up about for the back the blue ride/i,
  "the ungrammatical 'about for the back the blue ride' can no longer be composed"
);

// The two notes ALREADY in this corpus, now actually asserted on this field. Larry's
// "pre-owned trikes" (the vague family) and Brent's "black motor" (the modifier again) were both
// sitting in the fixtures with nothing binding them to a topic value.
assert.equal(
  resolveWalkInFollowUpSubject({
    proseTopic: "pre-owned trikes",
    modelLabel: "Tri Glide",
    yearLabel: "2017-2020",
    proseIsTimingOnly: false
  }),
  "the 2017-2020 Tri Glide",
  "Larry Godzich: the logged spec beats the vague family"
);
assert.equal(
  resolveWalkInFollowUpSubject({ proseTopic: "black motor", modelLabel: "Road Glide", yearLabel: "2026" }),
  "the 2026 Road Glide",
  "Brent Marshall: a finish is a modifier, not the unit"
);

// FAIL DIRECTIONS — every one of them lands on today's behaviour, never on new copy.
assert.equal(
  resolveWalkInFollowUpSubject({ proseTopic: "", modelLabel: "Road Glide Special", yearLabel: "2021" }),
  "",
  "no topic in => no topic out; this must never INVENT a follow-up promise"
);
assert.equal(resolveWalkInFollowUpSubject({}), "", "no inputs => no subject");
assert.equal(
  resolveWalkInFollowUpSubject({ proseTopic: "pre-owned trikes", modelLabel: "", yearLabel: "2017-2020" }),
  "pre-owned trikes",
  "no model slot => today's prose topic survives (never a regression to silence)"
);
assert.equal(
  resolveWalkInFollowUpSubject({ proseTopic: "pre-owned trikes", modelLabel: "bike" }),
  "pre-owned trikes",
  "'bike' is formatWatchModelForMessage's no-model placeholder, not a model"
);
assert.equal(
  resolveWalkInFollowUpSubject({ proseTopic: "the floor", modelLabel: "Road Glide Special", yearLabel: "" }),
  "the Road Glide Special",
  "no year in hand => the model alone, never a guessed year"
);
// extractWalkInModelHint joins the year INTO the label ("2021 Road Glide Special"). Saying it
// twice would be its own defect.
for (const label of ["2021 Road Glide Special", "2017-2020 Tri Glide"]) {
  const subject = resolveWalkInFollowUpSubject({ proseTopic: "the floor", modelLabel: label, yearLabel: "2021" });
  assert.equal(subject, `the ${label}`, `a year-carrying label is not double-stamped: ${label}`);
  // "2017-2020 Tri Glide" legitimately carries two years (a RANGE) — what must never happen is the
  // same year appearing twice because it was prepended onto a label that already had it.
  assert.equal((subject.match(/\b2021\b/g) ?? []).length <= 1, true, `the year is never stamped twice: ${label}`);
}
// A timing-only topic is a WHEN. It passes through so the timing-aware line keeps pairing it with
// the model — the existing +17168638237-era behaviour, unchanged.
for (const when of ["next week", "tomorrow", "Tuesday"]) {
  assert.equal(
    resolveWalkInFollowUpSubject({
      proseTopic: when,
      modelLabel: "Road Glide Special",
      yearLabel: "2021",
      proseIsTimingOnly: isTimingOnlyFollowUpTopic(when)
    }),
    when,
    `timing-only topic preserved: ${when}`
  );
}
assert.equal(
  buildTimingAwareWalkInFollowUpLine({
    base: "Thanks for stopping in -",
    followUpTopic: "next week",
    modelLabel: "Road Glide Special"
  }),
  "Thanks for stopping in - I'll follow up next week about the Road Glide Special.",
  "the timing-aware sentence still composes exactly as before"
);

// A slot-built subject must pass the internal-note guard it sits beside — same law, same module.
for (const subject of [rickJrSubject, rickSrSubject]) {
  assert.equal(isInternalNoteFollowUpTopic(subject), false, "a slot-built subject is never internal-note text");
  assert.doesNotMatch(subject, /\$\s?\d/, "a subject never carries a dollar figure");
  assert.doesNotMatch(subject, /\b(?:his|him|her|hers)\b/i, "a subject never carries third-person staff phrasing");
}

// WIRING. The prose topic must reach the referee and nothing else: a branch still reading the raw
// extractor output would leave the defect live on that step.
const proseTopicAt = sendgrid.indexOf("const proseFollowUpTopic = extractTrafficLogProFollowUpTopic(");
const subjectRefereeAt = sendgrid.indexOf("const followUpTopic = resolveWalkInFollowUpSubject({");
for (const [label, at] of [
  ["const proseFollowUpTopic = extractTrafficLogProFollowUpTopic(", proseTopicAt],
  ["const followUpTopic = resolveWalkInFollowUpSubject({", subjectRefereeAt]
] as [string, number][]) {
  assert.notEqual(at, -1, `the TLP walk-in tail must contain: ${label}`);
}
assert.ok(proseTopicAt < subjectRefereeAt, "the prose topic is extracted, then refereed — never used raw");
assert.doesNotMatch(
  sendgrid,
  /const followUpTopic = extractTrafficLogProFollowUpTopic\(/,
  "the raw extractor output must not be the tail's follow-up topic any more"
);
assert.match(
  sendgrid,
  /proseIsTimingOnly: isTimingOnlyFollowUpTopic\(proseFollowUpTopic\)/,
  "the caller owns the timing predicate so walkInFollowUpTopic.ts stays a dependency-free leaf"
);
// The year has to actually arrive. `yearRangeLabel` alone is empty for a note naming ONE year,
// which is exactly Rick Jr.'s case — that is why singleYear is in the expression.
assert.match(
  sendgrid,
  /yearLabel: yearRangeLabel \|\| \(singleYear \? String\(singleYear\) : ""\)/,
  "the TLP tail is handed the stated year, range or single"
);

console.log("PASS walk-in internal-note follow-up topic guard eval (+ slot-only spec recap, slot-built follow-up subject, committed return day, TLP finance-context guard, judge provenance)");

// --- A ride's NAME is not the bike's paint colour (+17168609581, 2026-08-04) ---------------
// Rick Williamson Sr.'s note said he "was on for the back the blue ride"; the keyword colour list
// saw "blue", `lead.vehicle.color` became blue, the match against our three 2026 Road Glide 3s
// (Iron Horse Metallic, Dark Billiard Gray, Vivid Black) failed, and the lane told him we'd "keep
// an eye out" for a bike we had three of. His pricing question was never answered, and a watch for
// a blue Road Glide 3 was armed that could never fire. Same note class, same day, same event:
// +17165241170 and +17164327329 (LARRY_TLP_NOTE above) both came out blue too.
const RICK_SR_TLP_NOTE =
  "Rick was on for the back the blue ride and was asking about pricing on Road Glide 3. " +
  "Needs follow up (Step 2)";
const RICK_JR_TLP_NOTE =
  "Rick Jr. was in for the back the blue ride and showed interest in the 2021 Road Glide Special " +
  "we have on the floor with the 131ci engine. Ran some numbers on his trade in. Needs follow up (Step 2)";

// THE PRECEDENCE IS THE FIX. The old call site read `keyword ?? parser`, so a correct parser answer
// could never win. A CONFIDENT EMPTY parser answer — "there is no bike colour in this note" — is a
// real answer and must beat the keyword, or nothing changes for Rick.
assert.equal(
  resolveWalkInNoteColor({ parserColor: "", parserConfidence: 0.95, keywordColor: "blue" }),
  undefined,
  "a confident 'no bike colour here' beats the keyword list — the +17168609581 fix"
);
// ANTI-OVER-SUPPRESSION: a colour a staff note genuinely states must survive. Blanking every
// walk-in colour would be the lazy fix and would regress Brent Marshall's Dark Billiard Gray.
assert.equal(
  resolveWalkInNoteColor({ parserColor: "Dark Billiard Gray", parserConfidence: 0.95, keywordColor: "gray" }),
  "Dark Billiard Gray",
  "a colour the note really states is kept, and beats the coarser keyword hit"
);
// FAIL DIRECTION: the keyword arm survives only where the parser did not answer.
assert.equal(
  resolveWalkInNoteColor({ parserColor: "", parserConfidence: 0.4, keywordColor: "vivid black" }),
  "vivid black",
  "below the floor the keyword fallback still runs — this can only ever REMOVE a colour, never invent one"
);
assert.equal(
  resolveWalkInNoteColor({ parserColor: "", parserConfidence: null, keywordColor: "red" }),
  "red",
  "parser absent (LLM failed) => today's behaviour, unchanged"
);
assert.equal(
  resolveWalkInNoteColor({ parserColor: "", parserConfidence: 0.95, keywordColor: null }),
  undefined,
  "nothing stated anywhere => no colour"
);
assert.equal(
  resolveWalkInNoteColor({ parserColor: "  Teal Thunder  ", parserConfidence: 0.9, keywordColor: "blue" }),
  "Teal Thunder",
  "the parser's answer is trimmed, not re-derived"
);
// The floor is configurable, and exactly-at-floor counts as answered.
assert.equal(
  resolveWalkInNoteColor({ parserColor: "", parserConfidence: 0.8, keywordColor: "blue" }),
  undefined,
  "at the floor the parser has answered"
);
assert.equal(
  resolveWalkInNoteColor({ parserColor: "", parserConfidence: 0.85, keywordColor: "blue", confidenceMin: 0.9 }),
  "blue",
  "a raised floor puts the keyword fallback back in charge"
);

// THE GOLD LABELS. Both Back-the-Blue notes ride in the few-shot corpus, and both must be labelled
// with NO colour — case-insensitively, because Larry's note capitalises "Back the Blue" and Rick's
// lowercases it. Nobody may "fix" this with a literal-case match.
const backTheBlueExamples = WALK_IN_OUTCOME_EXAMPLES.filter(ex => /back the blue/i.test(ex));
assert.ok(
  backTheBlueExamples.length >= 2,
  "both Back-the-Blue production notes stay pinned as few-shots (lowercase and capitalised)"
);
for (const ex of backTheBlueExamples) {
  assert.match(ex, /"desired_color":""/, "a charity ride's name is never labelled as paint");
}
// ...and the corpus still teaches the POSITIVE case, or the model learns "walk-in notes have no
// colour", which is the over-suppression failure.
assert.ok(
  WALK_IN_OUTCOME_EXAMPLES.some(ex => /"desired_color":"Dark Billiard Gray"/.test(ex)),
  "a genuinely stated colour is still taught as a colour"
);
// Every few-shot answers the slot — a corpus that half-answers a required field teaches the model
// to omit it, and the schema is strict.
for (const ex of WALK_IN_OUTCOME_EXAMPLES) {
  assert.match(ex, /"desired_color":/, "every walk-in few-shot answers the colour slot");
  assert.match(ex, /"desired_color_confidence":/, "…and carries its own confidence");
}

// THE PROMPT MUST TEACH THE CLASS, NOT THE INSTANCE. A blocklist of event names is precisely the
// move this eval's regex warning forbids.
const rickPrompt = buildWalkInOutcomePrompt({ text: RICK_SR_TLP_NOTE, historyLines: [] });
for (const token of ["desired_color", "desired_color_confidence"]) {
  assert.ok(rickPrompt.includes(token), `the prompt teaches ${token}`);
}
assert.ok(rickPrompt.includes(RICK_SR_TLP_NOTE), "the reported production turn rides as a few-shot");
assert.match(rickPrompt, /Blue Knights/i, "the rule is taught as a CLASS with more than one instance");
assert.match(rickPrompt, /CHARITY/i, "event/ride/chapter/charity names are named as the category");
assert.match(rickPrompt, /paint colour|PAINT COLOUR/, "the slot is scoped to the bike's paint, not any colour word");

// PROVENANCE: a Traffic Log Pro "Inquiry" is our own CRM log, so it may not mint the lead's colour
// by keyword match. Pinned as ORDERING (each index guarded against -1 first, per the note above).
const tlpHintAt = sendgrid.indexOf("const isTrafficLogProPayloadHint");
const colorMintAt = sendgrid.indexOf("const inquiryColorHint");
const parserColorAt = sendgrid.indexOf("resolveWalkInNoteColor(");
for (const [label, at] of [
  ["isTrafficLogProPayloadHint", tlpHintAt],
  ["inquiryColorHint", colorMintAt],
  ["resolveWalkInNoteColor", parserColorAt]
] as [string, number][]) {
  assert.notEqual(at, -1, `the walk-in colour lane must still contain ${label}`);
}
assert.ok(
  tlpHintAt < colorMintAt,
  "the TLP provenance hint is known BEFORE the keyword colour mint, so it can gate it"
);
assert.ok(
  colorMintAt < parserColorAt,
  "the keyword mint is the early/intake step; the parser-first resolve happens later, with the note parsed"
);
assert.doesNotMatch(
  sendgrid.slice(Math.max(0, colorMintAt - 200), colorMintAt),
  /if \(!lead\.vehicleColor\) \{\s*$/,
  "the colour mint must carry a provenance condition beyond 'no colour yet'"
);

console.log("PASS walk-in internal-note follow-up topic guard eval (+ slot-only spec recap, committed return day, TLP finance-context guard, judge provenance, ride-name-is-not-paint colour slot)");
