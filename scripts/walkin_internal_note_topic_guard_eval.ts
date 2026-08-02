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
  describeWalkInNoteProvenance
} from "../services/api/src/domain/walkInFollowUpTopic.ts";
import { buildIntentJudgePrompt } from "./intent_handled_audit.ts";
import { hasAdfFinanceApplicationContext } from "../services/api/src/domain/workflowRegressionGuards.ts";
import {
  buildWalkInOutcomePrompt,
  coerceUnmetInventoryWant,
  extractWatchDirectiveSegment,
  hasWatchIntentPhrase
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

console.log("PASS walk-in internal-note follow-up topic guard eval (+ slot-only spec recap, TLP finance-context guard, judge provenance)");
