/**
 * Subjectless web-lead handoff — decision table + wiring + the replay judge's design-accept.
 *
 * PRODUCTION MISS (Timothy Patrick, +13049475135, Ref 11753, "Room58 - Contact Us", 2026-08-08).
 * The ADF body ended `Inquiry:\nHome` — the PAGE the form sat on, not anything he typed — and the
 * lead fell all the way through to the purchase-intent fallback, which asked "Which bike are you
 * asking about?" about a bike nobody had named. Joe deleted that question by hand before sending.
 *
 * MEASURED 2026-08-09 across the dealer's two catch-all web forms: 26 leads, and ZERO let the
 * customer pick a bike — the `Harley-Davidson Full Line` they all carry is the form's own filler.
 * MEASURED 2026-08-10, the parser verdicts this referee reads (parseAdfDepartmentInterestWithLLM,
 * real prompt, live model), which is why the table below uses these exact numbers:
 *   "Home"                                          -> none    0.8
 *   "who is your hiring manager"                    -> none    0.8
 *   "please add me to your email list"              -> none    0.9
 *   "looking for a take off M-8 114 engine"         -> parts   0.92
 *   "do you have any 2026 Street Glides in stock"   -> vehicle 0.95
 *
 * WHAT THIS PINS — the DECISION (hand the lead to a person / leave the turn alone), never a label
 * spelling. The parser has several ways to say "no identifiable subject" and only one of them is
 * acted on, so `none` is asserted where the system genuinely branches on it and nowhere else.
 *
 * NO LLM: the referee is pure and the design-accept reads recorded rows, so this is deterministic
 * and cannot red-line the gate on a judge re-roll.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  decideNoSubjectWebLeadHandoff,
  toAdfDepartmentVerdict,
  NO_SUBJECT_WEB_LEAD_HANDOFF_REASON
} from "../services/api/src/domain/routeStateReducer.ts";

import {
  isNoSubjectWebLeadHandoffAckByDesign,
  isRoom58StandardHandoffAckByDesign,
  isEmptyInquiryAdfBody
} from "./corpus_replay_flywheel.ts";

const CONFIDENCE_MIN = 0.7;

const sendgrid = fs.readFileSync(path.resolve("services/api/src/routes/sendgridInbound.ts"), "utf8");

const PINNED_ACK = "Thanks — I got your inquiry. I’ll make sure the team follows up soon.";

/** Timothy's ADF body, verbatim from the live store. */
const TIMOTHY_BODY = [
  "WEB LEAD (ADF)",
  "Source: Room58 - Contact Us",
  "Ref: 11753",
  "Name: Timothy Patrick",
  "Email: timpatrick629@gmail.com",
  "Phone: 304-947-5135",
  "Year: 2026",
  "Vehicle: Harley-Davidson Full Line",
  "",
  "Inquiry:",
  "Home"
].join("\n");

// --- 1. The decision table -------------------------------------------------
// Every row states the DECISION, so a parser that words itself differently cannot break the gate.

const base = {
  isInitialAdf: true,
  hasNamedBike: false,
  hasInventoryIdentifiers: false,
  parserAccepted: true,
  confidence: 0.8,
  confidenceMin: CONFIDENCE_MIN
} as const;

type Row = {
  label: string;
  input: Parameters<typeof decideNoSubjectWebLeadHandoff>[0];
  handoff: boolean;
};

const ROWS: Row[] = [
  {
    label: "Timothy: no bike on the lead, parser found no subject -> a person owns it",
    input: { ...base, department: "none" },
    handoff: true
  },
  {
    label: "the job application (also no subject) -> a person owns it",
    input: { ...base, department: "none", confidence: 0.8 },
    handoff: true
  },
  {
    label: "the promo-list signup at the parser's real 0.9 -> a person owns it",
    input: { ...base, department: "none", confidence: 0.9 },
    handoff: true
  },
  // --- everything below must keep TODAY'S behaviour ---
  {
    label: "a real parts request -> the department path still runs",
    input: { ...base, department: "parts", confidence: 0.92 },
    handoff: false
  },
  {
    label: "a real bike shopper on the same catch-all form -> the sales path still runs",
    input: { ...base, department: "vehicle", confidence: 0.95 },
    handoff: false
  },
  {
    label: "an apparel request -> unchanged",
    input: { ...base, department: "apparel", confidence: 0.97 },
    handoff: false
  },
  {
    label: "a rider-course request -> unchanged",
    input: { ...base, department: "riding_academy", confidence: 0.9 },
    handoff: false
  },
  {
    label: "a service request -> unchanged",
    input: { ...base, department: "service", confidence: 0.96 },
    handoff: false
  },
  {
    label: "no subject BUT the lead names a real bike -> we have something to talk about",
    input: { ...base, department: "none", hasNamedBike: true },
    handoff: false
  },
  {
    label: "no subject BUT the lead carries a stock id / VIN -> we know the unit",
    input: { ...base, department: "none", hasInventoryIdentifiers: true },
    handoff: false
  },
  {
    label: "parser did not answer -> unsure, so nothing changes",
    input: { ...base, department: null, parserAccepted: false },
    handoff: false
  },
  {
    label: "below the confidence floor -> unsure, so nothing changes",
    input: { ...base, department: "none", confidence: CONFIDENCE_MIN - 0.01 },
    handoff: false
  },
  {
    label: "exactly at the floor -> acted on (the floor is inclusive, same as the department route)",
    input: { ...base, department: "none", confidence: CONFIDENCE_MIN },
    handoff: true
  },
  {
    label: "NaN confidence -> unsure, so nothing changes",
    input: { ...base, department: "none", confidence: Number.NaN },
    handoff: false
  },
  {
    label: "not a first-touch web lead -> this referee never owns a mid-thread turn",
    input: { ...base, department: "none", isInitialAdf: false },
    handoff: false
  }
];

for (const row of ROWS) {
  const decision = decideNoSubjectWebLeadHandoff(row.input);
  assert.equal(decision.kind === "handoff", row.handoff, `decision table: ${row.label}`);
  // The marker is what a rep sees on the parked thread (`followUp.reason`) and what tells this
  // handoff apart from the twin form's in the store — a handoff that recorded nothing would be a
  // lead sitting in someone's queue with no stated reason for being there.
  if (row.handoff) {
    assert.equal(decision.reason, NO_SUBJECT_WEB_LEAD_HANDOFF_REASON, `handoff must carry its marker: ${row.label}`);
  } else {
    assert.equal(decision.reason, "", `a no-op must record nothing: ${row.label}`);
  }
}

// --- 2. Why the twin form's accept never covered this lead -----------------
// The whole defect in one assertion: Timothy's Inquiry is NOT empty (it holds a page name), so the
// empty-Inquiry gate the existing accept depends on can never see him.
assert.equal(
  isEmptyInquiryAdfBody(TIMOTHY_BODY),
  false,
  "Timothy's Inquiry carries a page name, so it is not the empty-Inquiry class"
);

// --- 3. The replay judge's design-accept ----------------------------------
// Fail-direction: keyed to the referee's OWN recorded decision, never to the body or the form name.
// That key is only truthful because the ADF route reports the decision on its response and the replay
// prefers the response over the sandbox copy — both halves are asserted at the bottom of this file.

const judgeMajor = { addressed: false, severity: "major" as const, reason: "ignored the customer's request" };
const judgeMinor = { addressed: false, severity: "minor" as const, reason: "no next step" };
const judgeOk = { addressed: true, severity: "minor" as const, reason: "" };

const handoffRow = {
  conversationId: "+13049475135",
  body: TIMOTHY_BODY,
  draft: `Hey Timothy, it's Alexandra over at American Harley-Davidson. ${PINNED_ACK}`,
  verdict: "candidate_safe" as const,
  router: { followUpMode: "manual_handoff", followUpReason: NO_SUBJECT_WEB_LEAD_HANDOFF_REASON }
};

assert.equal(
  isNoSubjectWebLeadHandoffAckByDesign(handoffRow, judgeMajor),
  true,
  "the handoff ack is the designed reply, even when the judge calls it major"
);
assert.equal(
  isNoSubjectWebLeadHandoffAckByDesign(handoffRow, judgeMinor),
  true,
  "same row, judge-minor: still the designed reply"
);
assert.equal(
  isNoSubjectWebLeadHandoffAckByDesign(handoffRow, judgeOk),
  false,
  "a row the judge already passed is not the accept's business"
);
assert.equal(
  isNoSubjectWebLeadHandoffAckByDesign(
    { ...handoffRow, draft: "Hey Timothy — which bike are you asking about?" },
    judgeMajor
  ),
  false,
  "if the branch ever engages the lead instead of handing it off, the row surfaces again"
);
assert.equal(
  isNoSubjectWebLeadHandoffAckByDesign({ ...handoffRow, router: { followUpReason: null } }, judgeMajor),
  false,
  "no marker means the referee never handed this lead off — an ignored ask must still fail"
);
assert.equal(
  isNoSubjectWebLeadHandoffAckByDesign({ ...handoffRow, router: { followUpReason: "room58_standard" } }, judgeMajor),
  false,
  "a DIFFERENT handoff reason is the twin accept's business, not this one's"
);
// The property the flywheel's own self-test defends: a customer who wrote a real question and got
// this ack anyway must STILL fail. They never carry this marker, so they never reach the accept.
assert.equal(
  isNoSubjectWebLeadHandoffAckByDesign(
    {
      ...handoffRow,
      body: `${TIMOTHY_BODY}\nIs the Low Rider ST still in stock, and what is your best out-the-door price?`,
      router: { followUpReason: null }
    },
    judgeMajor
  ),
  false,
  "a real unanswered question stays a miss — this accept must never blind the sweep to one"
);
// The twin accept must NOT have widened: Larry's row still needs its own form name + empty Inquiry,
// and Timothy's body satisfies neither.
assert.equal(
  isRoom58StandardHandoffAckByDesign(handoffRow, judgeMajor),
  false,
  "the existing Room58 - Standard accept stays exactly as narrow as it was"
);

// The accept also requires the pinned ack, so pin how FEW places emit it: two deliberate handoff
// branches today (the twin form's, and this slice's). A third borrower must force a re-read of the
// accept rather than quietly inheriting an excuse from the nightly judge.
const ackCopySites = sendgrid.split("I’ll make sure the team follows up soon.").length - 1;
assert.equal(
  ackCopySites,
  2,
  "exactly two branches send the pinned handoff ack — if that changed, re-read isNoSubjectWebLeadHandoffAckByDesign before touching this number"
);

// --- 3b. The marker has to REACH the recorded row ---------------------------
// This is the half that was measured wrong first and would have made the accept inert: the replay
// harness reads its router fields out of a sandbox copy the debounced handler never flushes, so the
// route has to REPORT the decision and the harness has to prefer the report.
assert.ok(
  sendgrid.includes("followUpReason: conv.followUp?.reason ?? null"),
  "the ADF route must report its handoff reason — the store copy a replay sees is the PRE-turn state"
);
const replay = fs.readFileSync(path.resolve("scripts/inbound_shadow_replay.ts"), "utf8");
assert.ok(
  replay.includes("followUpReason: adfRouter.followUpReason ?? convAfter?.followUp?.reason ?? null"),
  "the replay must prefer the ROUTE'S reported reason over the sandbox copy, in that order"
);
assert.ok(
  replay.includes("followUpReason: parsed?.followUpReason ?? null"),
  "submitAdf must read the reason off the response body, or adfRouter carries nothing to prefer"
);

// --- 4. WIRING — a ratchet cannot prove this, so count the call sites ------
// Trap: every one of these sits beside another decide*/apply* call, so a lookback-style check
// credits presence and passes on an unwired branch. Each assertion below names an EXPECTED COUNT.

const callSites = sendgrid.split("decideNoSubjectWebLeadHandoff({").length - 1;
assert.equal(callSites, 1, "the referee is asked exactly once, at the fallback that carried the bug");

const refereeImportLine = sendgrid
  .split("\n")
  .find(line => line.startsWith("import") && line.includes("decideNoSubjectWebLeadHandoff"));
assert.ok(refereeImportLine, "the referee must be imported, not re-implemented locally");
assert.ok(
  String(refereeImportLine).includes("domain/routeStateReducer"),
  "the referee must come from routeStateReducer — that is where route decisions live"
);

// The parser verdict has to be CARRIED to the referee, and that link is the one a source pin cannot
// hold: a mapping that hardcodes `accepted: false` looks exactly like a correct one. It lives in
// toAdfDepartmentVerdict now, so EXECUTE the whole chain from the parser's real output shapes.
const mapperUses = sendgrid.split("toAdfDepartmentVerdict(").length - 1;
assert.equal(mapperUses, 2, "the verdict comes from the shared mapper twice: the empty default, and the parse");
assert.ok(
  sendgrid.includes("adfDepartmentVerdict = toAdfDepartmentVerdict(adfDepartmentParse)"),
  "the mapper must be fed the PARSER's output — that is the link the referee's own table cannot check"
);
for (const field of [
  "parserAccepted: adfDepartmentVerdict.accepted",
  "department: adfDepartmentVerdict.department",
  "confidence: adfDepartmentVerdict.confidence"
]) {
  assert.ok(sendgrid.includes(field), `the call site must read the parser verdict: ${field}`);
}

// End to end: the parser's REAL measured output -> the mapper -> the referee -> the decision.
for (const c of [
  { label: "Timothy's page name", parse: { department: "none", item: null, confidence: 0.8 }, handoff: true },
  { label: "the promo-list signup", parse: { department: "none", item: null, confidence: 0.9 }, handoff: true },
  { label: "the take-off engine (parts)", parse: { department: "parts", item: "M-8 114 engine", confidence: 0.92 }, handoff: false },
  { label: "a real bike shopper", parse: { department: "vehicle", item: "2026 Street Glide", confidence: 0.95 }, handoff: false },
  { label: "the parser never answered", parse: null, handoff: false }
]) {
  const verdict = toAdfDepartmentVerdict(c.parse);
  const decision = decideNoSubjectWebLeadHandoff({
    isInitialAdf: true,
    hasNamedBike: false,
    hasInventoryIdentifiers: false,
    parserAccepted: verdict.accepted,
    department: verdict.department,
    confidence: verdict.confidence,
    confidenceMin: CONFIDENCE_MIN
  });
  assert.equal(decision.kind === "handoff", c.handoff, `parse -> mapper -> referee: ${c.label}`);
}
// A parse that arrived must never be reported as absent, and an absent one must never be confident.
assert.equal(toAdfDepartmentVerdict({ department: "none", confidence: 0.8 }).accepted, true, "a real parse is accepted");
assert.equal(toAdfDepartmentVerdict(null).accepted, false, "no parse is not an accepted parse");
assert.equal(toAdfDepartmentVerdict(null).confidence, 0, "no parse carries no confidence");

// The design-accept has to be ASKED by the scorer — an accept nothing calls is a phantom P1 waiting
// to happen (the whole reason this slice widened the accept at all).
const flywheel = fs.readFileSync(path.resolve("scripts/corpus_replay_flywheel.ts"), "utf8");
assert.ok(
  flywheel.includes("isNoSubjectWebLeadHandoffAckByDesign(row, score.judge)"),
  "adjustScore must consult the design-accept, not merely export it"
);

// The side effects: the lead is handed to a person the same way the twin form's branch does it.
const handoffBlock = sendgrid.slice(
  sendgrid.indexOf("decideNoSubjectWebLeadHandoff({"),
  sendgrid.indexOf("decideNoSubjectWebLeadHandoff({") + 2200
);
assert.ok(handoffBlock.includes(PINNED_ACK), "the handoff sends the twin form's pinned ack, not new copy");
assert.ok(handoffBlock.includes("addTodo(conv,"), "a person has to be told the lead is theirs");
assert.ok(
  handoffBlock.includes("setFollowUpMode(conv, \"manual_handoff\", noSubjectHandoff.reason)"),
  "the referee's own reason is what gets recorded — that string is what the replay accept reads"
);
assert.ok(
  handoffBlock.includes("stopFollowUpCadence(conv, \"manual_handoff\")"),
  "a lead a human now owns must not keep drawing automatic nudges"
);
// And the old copy must survive for every lead the referee did NOT claim.
assert.ok(
  handoffBlock.includes("Which bike are you asking about?"),
  "the previous ask stays as the else branch — this slice narrows it, it does not delete it"
);

console.log(`no_subject_web_lead_handoff:eval PASS (${ROWS.length} decision rows, 5 parse->referee chains, 8 accept cases, 1 call site, 3 marker hops)`);
