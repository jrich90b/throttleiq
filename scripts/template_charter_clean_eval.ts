/**
 * OUR OWN TEMPLATES MUST PASS OUR OWN CHARTER (2026-08-08).
 *
 * The release gate fails a day when a charter violation is TEMPLATE-SOURCED — banned filler, a
 * doubled article, a bare check-in, a dropped verb — because those are our code's words, not the
 * model's, and the threshold for them is zero. On 2026-08-07 the brand-new Riding Academy
 * wait-list->enrolled template sent "...I'm here if you need anything." to +15853170121 and dirtied
 * the gate the first time it ever fired. The phrase was Joe's own suggestion in the session that
 * built that copy ("maybe just say I'm here if you need anything") — and it is item 10 on the
 * charter's banned-filler list, which the SAME repo already tells the LLM never to use
 * (llmDraft.ts: "Never use these phrases: ... 'I'm here if you need anything' ...").
 *
 * That is the gap this eval closes: the prompt side was guarded, the deterministic side was not. A
 * template can only be caught in production, one dirty gate day per new template, and only after a
 * real customer has already received it.
 *
 * Two layers:
 *  1) BUILDERS — call the deterministic reply builders and run the charter's own `checkMessage` over
 *     what they return. Real function calls, no source pins; if a builder's copy regresses, this
 *     fails with the phrase named.
 *  2) SOURCE SWEEP — scan the reply-copy modules for charter-banned phrases inside string literals.
 *     This is the net that catches a NEW template nobody thought to add to layer 1. Prompt files
 *     (llmDraft.ts and friends) are deliberately out of scope: they quote banned phrases on purpose,
 *     as negative instructions and as parser INPUT exemplars ("last_draft: ...") describing copy we
 *     are teaching the model to recognize, not to emit.
 *
 * Run: npx tsx scripts/template_charter_clean_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkMessage } from "./voice_charter_audit.ts";

const A = await import("../services/api/src/domain/agentVoice.ts");

let n = 0;
const ok = (cond: boolean, msg: string) => {
  assert.equal(cond, true, msg);
  n++;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");

/** The charter checks that are OUR fault when they fire — the gate's template-sourced set. */
const TEMPLATE_SOURCED = new Set(["banned_phrase", "doubled_article", "bare_check_in", "dropped_verb"]);

function charterHits(text: string, smsLike = true): { check: string; detail: string }[] {
  return checkMessage(text, { firstOutbound: false, smsLike, staffHasSent: false }).filter(v =>
    TEMPLATE_SOURCED.has(v.check)
  );
}

// ---------------------------------------------------------------------------
// LAYER 1 — the deterministic builders, called for real
// ---------------------------------------------------------------------------
const NOTE = "Our riding academy manager will send you your e-course link.";
const builderCases: { label: string; text: string }[] = [];
for (const introduce of [true, false]) {
  builderCases.push({
    label: `waitlist_to_enrolled(introduce=${introduce})`,
    text: A.buildRidingAcademyWaitlistToEnrolledAck("Maya", "Alexandra", "American Harley-Davidson", {
      course: "New Rider Course",
      startDate: "8/15/2026",
      registrationNote: NOTE,
      introduce
    })
  });
  builderCases.push({
    label: `waitlist_to_enrolled_thin(introduce=${introduce})`,
    text: A.buildRidingAcademyWaitlistToEnrolledAck("Maya", "Alexandra", "American Harley-Davidson", { introduce })
  });
  builderCases.push({
    label: `completion(introduce=${introduce})`,
    text: A.buildRidingAcademyCompletionAck("Maya", "Alexandra", "American Harley-Davidson", {
      course: "New Rider Course",
      introduce
    })
  });
}

for (const c of builderCases) {
  const hits = charterHits(c.text);
  ok(hits.length === 0, `${c.label} must be charter-clean, found: ${hits.map(h => `${h.check}(${h.detail})`).join(", ")} in "${c.text}"`);
}

// The matcher has to actually be able to fail, or every assertion above is vacuous. (The 8/8 fixture
// trap: a guard built only from negative assertions passes happily on a broken harness.)
ok(
  charterHits("Good news - a seat opened up. I'm here if you need anything.").some(h => h.check === "banned_phrase"),
  "the charter matcher still catches the exact phrase this eval was written for"
);

// ---------------------------------------------------------------------------
// LAYER 1b — charter C1.7: our TEMPLATES end with an advancing question too
// ---------------------------------------------------------------------------
/**
 * The salesperson arm (every reply ends with one question that advances the lead) went live on the
 * LLM draft path 2026-08-08. The finance-submission acks are hardcoded templates, so it could not
 * reach them: measured over the 30 days to 8/8, 41 credit/prequal acks went out and only 5 asked
 * anything — and one of those five was Joe hand-editing this very template to add "What bike do you
 * have your eye on?". Same blind spot this file was created for, one rule along.
 *
 * These assert the DECISION (does the ack end by asking something that advances the lead, and does
 * it STOP asking when the shared suppression referee says don't push), never the wording — except
 * for the placeholder case, where the wording IS the ruling: Joe's own edit.
 */
const G = await import("../services/api/src/domain/workflowRegressionGuards.ts");
const M = await import("../services/api/src/domain/modelDeflection.ts");

const REAL_MODEL = "Road Glide Special";
for (const kind of ["prequal", "credit_app"] as const) {
  for (const introduce of [true, false]) {
    const ack = G.buildFinanceSubmissionAck({
      kind,
      introduce,
      firstName: "Ryan",
      when: "Monday morning",
      bikeLabel: REAL_MODEL
    });
    // POSITIVE: the ack must still BE an acknowledgement — a builder that returned only a question
    // (or an empty string) would satisfy any "ends with ?" assertion on its own.
    ok(
      ack.includes(kind === "prequal" ? "pre-qualification submission" : "credit application"),
      `${kind}(introduce=${introduce}) must still acknowledge the submission: ${ack}`
    );
    ok(ack.includes("finance team"), `${kind}(introduce=${introduce}) must still name the handoff: ${ack}`);
    ok(ack.includes("Monday morning"), `${kind}(introduce=${introduce}) must still carry the timing phrase: ${ack}`);
    // THE DECISION: it ends by asking, and asks exactly once.
    ok(ack.trim().endsWith("?"), `charter C1.7: ${kind}(introduce=${introduce}) must end with a question: ${ack}`);
    ok(
      (ack.match(/\?/g) ?? []).length === 1,
      `charter C1.7 asks exactly ONE question, ${kind}(introduce=${introduce}) asked ${(ack.match(/\?/g) ?? []).length}: ${ack}`
    );
    ok(ack.includes(REAL_MODEL), `a known model is asked about by name: ${ack}`);
    const hits = charterHits(ack);
    ok(hits.length === 0, `${kind}(introduce=${introduce}) must be charter-clean, found: ${hits.map(h => h.check).join(", ")}`);
  }
}

// A placeholder/description model asks WHICH bike — Joe's own hand-edit, 2026-08-07, on the lead
// whose vehicle field read "Harley sportster/sports-style bike". The wording is the ruling here.
for (const placeholder of ["", "Harley-Davidson Full Line", "Other", "FXR/LS/WX model", "Harley sportster/sports-style bike"]) {
  ok(
    G.buildFinanceAckAdvancingQuestion(placeholder) === "What bike do you have your eye on?",
    `a non-specific lead model (${JSON.stringify(placeholder)}) must ask which bike, not name it back`
  );
}
ok(
  G.buildFinanceAckAdvancingQuestion(REAL_MODEL).includes(REAL_MODEL),
  "a specific lead model is named in the question rather than asked for"
);

// The suppression referee is the SAME one the composer uses — a template that kept asking after a
// booking would push a customer who is already coming in.
for (const suppression of [
  { appointment: { status: "booked", startLocal: "2026-08-11T10:00" } },
  { appointment: { status: "confirmed" } },
  { alreadyPurchased: true },
  { needsEmpathy: true },
  { dispositionClosing: true }
]) {
  const ack = G.buildFinanceSubmissionAck({
    kind: "credit_app",
    introduce: true,
    firstName: "Dale",
    when: "Monday morning",
    bikeLabel: REAL_MODEL,
    suppression
  });
  ok(ack.includes("credit application"), `a suppressed ack is still an acknowledgement: ${ack}`);
  ok(!ack.includes("?"), `charter C1.7 suppression (${Object.keys(suppression)[0]}) must not push a question: ${ack}`);
}

// The visit question used where the copy already names the bike (orchestrator's finance ack).
ok(G.buildFinanceAckVisitQuestion().trim().endsWith("?"), "the visit question must be a question");
ok(charterHits(G.buildFinanceAckVisitQuestion()).length === 0, "the visit question must be charter-clean");

// The placeholder referee must keep REAL models specific — widening it to catch category
// descriptions is what makes the question right, and over-widening would silently stop ~7 sites
// from naming a bike they legitimately know. Measured 2026-08-08: exactly 3 of 548 live leads flip.
for (const real of [
  "Ultra Limited Peace Officer / Firefighter / Shrine Special Edition", // slash-separated, REAL
  "Road Glide Special",
  "Pan America 1250 ST",
  "Low Rider S",
  "Street Bob",
  "Nightster"
]) {
  ok(M.isSpecificModel(real), `"${real}" is a real bookable model and must stay specific`);
}
for (const desc of ["FXR/LS/WX model", "Harley sportster/sports-style bike", "mid-sized Harley (Softail/heritage-style)"]) {
  ok(M.isPlaceholderModel(desc), `"${desc}" is a category description, not a bookable model`);
}

// ---------------------------------------------------------------------------
// LAYER 2 — source sweep over the reply-copy modules
// ---------------------------------------------------------------------------
/**
 * Files that BUILD customer-facing deterministic copy. Prompt/parser modules are excluded on
 * purpose (see the header): they quote banned phrases as negative instructions and as input
 * exemplars. Add a module here when it starts returning sentences we send.
 */
const COPY_MODULES = [
  "services/api/src/domain/agentVoice.ts",
  "services/api/src/domain/orchestrator.ts",
  "services/api/src/routes/sendgridInbound.ts",
  // Holds the finance-submission ack copy (2026-08-08), so it now returns sentences we send.
  "services/api/src/domain/workflowRegressionGuards.ts"
];

/** Strip comments so a comment ABOUT a banned phrase (like this file's own header) never fires. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** Every string literal in the file, un-escaped enough to phrase-match. */
function stringLiterals(src: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const raw = m[1] ?? m[2] ?? m[3] ?? "";
    if (raw.length < 12) continue;
    out.push(raw.replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\$\{[^}]*\}/g, " "));
  }
  return out;
}

let scanned = 0;
for (const rel of COPY_MODULES) {
  const src = stripComments(fs.readFileSync(path.join(repo, rel), "utf8"));
  const literals = stringLiterals(src);
  ok(literals.length > 20, `${rel} must yield string literals to scan (got ${literals.length})`);
  for (const lit of literals) {
    scanned++;
    // Only banned_phrase is swept here: the other three template-sourced checks are grammar faults
    // that depend on the RENDERED sentence (placeholders filled in), which layer 1 covers by calling
    // the builders. A raw literal with an unfilled slot would false-fire on those.
    const hits = checkMessage(lit, { firstOutbound: false, smsLike: true, staffHasSent: false }).filter(
      v => v.check === "banned_phrase"
    );
    ok(hits.length === 0, `${rel} contains charter-banned copy "${hits[0]?.detail}": ${lit.slice(0, 160)}`);
  }
}
ok(scanned > 200, `the sweep must actually cover the copy modules (scanned ${scanned} literals)`);

console.log(`template_charter_clean_eval: PASS (${n} assertions, ${scanned} literals swept)`);
