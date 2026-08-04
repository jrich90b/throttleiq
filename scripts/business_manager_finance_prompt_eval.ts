import { strict as assert } from "node:assert";
import fs from "node:fs";

/**
 * business_manager_finance_prompt:eval — pins the referee for the UNPROMPTED business-manager
 * "finance outcome needed" SMS + task (Joe ruling 2026-08-04: "a pre qual should not create a
 * finance outcome").
 *
 * Production signal — Christopher Szczesny +17169400722, lead ref 11721:
 *   - arrived 2026-08-02 from "Marketplace - Prequal" ⇒ classification
 *     { bucket: "finance_prequal", cta: "prequalify", ruleName: "prequal_lead" } — an ORIGIN
 *     label that never expires;
 *   - by 2026-08-04 the thread was pure inventory ("Could u tell me if it's new or used and yes
 *     can u dsend pics", "I'm looking for a used road glide with some goodies already on it"),
 *     dialogState `inventory_answered`, and the record carried NO credit app, NO financeOutcome,
 *     NO finance appointment;
 *   - 15:11 a staff-initiated call hit his voicemail → 15:12:35 `followUp.reason` became
 *     `finance_no_contact` and the no-contact handler texted Stone "Finance outcome needed: …
 *     Reply OUTCOME <token> APPROVED | DECLINED | NEEDS_INFO | PENDING" plus an open task.
 *
 * Deterministic; no LLM, no IO beyond reading index.ts to prove the wiring.
 */

const { decideBusinessManagerFinanceOutcomePrompt } = await import(
  "../services/api/src/domain/routeStateReducer.ts"
);

// ---- 1. THE PRODUCTION MISS: prequal origin + a voicemail is NOT a finance outcome ----
const chris = decideBusinessManagerFinanceOutcomePrompt({
  leadCta: "prequalify",
  leadBucket: "finance_prequal",
  followUpReason: "finance_no_contact",
  appointmentType: null
});
assert.equal(chris.prompt, false, "+17169400722: a Marketplace-Prequal origin alone must not prompt the business manager");
assert.equal(chris.reason, "prequal_origin_only", "the skip names the prequal origin so it is legible in a trace");

// The bucket on its own (no cta) is equally insufficient — same origin label, different field.
assert.equal(
  decideBusinessManagerFinanceOutcomePrompt({ leadBucket: "finance_prequal" }).prompt,
  false,
  "bucket finance_prequal alone never prompts"
);
assert.equal(
  decideBusinessManagerFinanceOutcomePrompt({ leadCta: "prequalify" }).prompt,
  false,
  "cta prequalify alone never prompts"
);

// ---- 2. REAL FINANCE ARTEFACTS still prompt (we did not silence the lane) ----
// hdfs_coa_online carries bucket `finance_prequal` TOO (leadSourceRules), so the cta is the only
// thing separating a SUBMITTED credit application from a soft prequal form. This is the case that
// would regress if someone "simplified" the referee by dropping the bucket/cta split.
const coa = decideBusinessManagerFinanceOutcomePrompt({
  leadCta: "hdfs_coa",
  leadBucket: "finance_prequal",
  followUpReason: null,
  appointmentType: null
});
assert.equal(coa.prompt, true, "a submitted HDFS credit application still prompts");
assert.equal(coa.reason, "finance_artifact:credit_app_online", "…and says which artefact");

for (const reason of [
  "credit_app",
  "credit_app_cosigner",
  "credit_app_needs_info",
  "credit_app_approved",
  "financing_declined"
]) {
  const d = decideBusinessManagerFinanceOutcomePrompt({ leadBucket: "finance_prequal", followUpReason: reason });
  assert.equal(d.prompt, true, `live finance state ${reason} still prompts`);
  assert.equal(d.reason, "finance_artifact:follow_up_reason", `${reason} reports the follow-up-reason artefact`);
}

const appt = decideBusinessManagerFinanceOutcomePrompt({ appointmentType: "Finance_Discussion" });
assert.equal(appt.prompt, true, "a booked finance_discussion appointment still prompts (case-insensitive)");
assert.equal(appt.reason, "finance_artifact:finance_appointment", "…and names the appointment artefact");

// A prequal-origin lead that LATER gets a real credit app comes back into the lane — the ruling
// is about the origin label alone, not a permanent exclusion of prequal leads.
assert.equal(
  decideBusinessManagerFinanceOutcomePrompt({
    leadCta: "prequalify",
    leadBucket: "finance_prequal",
    followUpReason: "credit_app"
  }).prompt,
  true,
  "a prequal lead with a real credit app in flight DOES prompt"
);

// ---- 3. Everything else stays quiet, and junk input fails toward silence ----
assert.equal(decideBusinessManagerFinanceOutcomePrompt({}).reason, "no_finance_context", "an empty conversation never prompts");
assert.equal(
  decideBusinessManagerFinanceOutcomePrompt({
    leadCta: "request_a_quote",
    leadBucket: "inventory_interest",
    followUpReason: "price_confirm"
  }).prompt,
  false,
  "an ordinary inventory lead never prompts"
);
assert.equal(
  decideBusinessManagerFinanceOutcomePrompt({ leadCta: undefined, followUpReason: null, appointmentType: "" }).prompt,
  false,
  "null/empty fields fail toward NOT texting staff"
);

// ---- 4. THE TWO GATES ARE NOT INTERCHANGEABLE ----
// The broad test still says yes to Christopher (that is its job — it reads an outcome a human
// already picked). Only the narrow referee says no. If these two ever agree on this input, the
// prequal ruling has been undone.
const { isFinanceOutcomeContext, shouldPromptBusinessManagerFinanceOutcome } = await import(
  "../services/api/src/domain/financeOutcomeGates.ts"
);
const chrisConv = {
  classification: { bucket: "finance_prequal", cta: "prequalify", ruleName: "prequal_lead" },
  followUp: { reason: "finance_no_contact" },
  lead: { firstName: "Christopher", lastName: "Szczesny", leadRef: "11721", source: "Marketplace - Prequal" }
};
assert.equal(isFinanceOutcomeContext(chrisConv), true, "the BROAD test still matches a prequal lead (human-recorded outcomes keep working)");
assert.equal(
  shouldPromptBusinessManagerFinanceOutcome(chrisConv).prompt,
  false,
  "+17169400722: the NARROW referee refuses to nag the business manager off a prequal origin"
);
assert.equal(shouldPromptBusinessManagerFinanceOutcome(chrisConv).reason, "prequal_origin_only", "…and says why");

// ---- 5. WIRING: the prompt path asks the narrow gate; the To-Do outcome path keeps the broad one ----
const indexSrc = fs.readFileSync(new URL("../services/api/src/index.ts", import.meta.url), "utf8");
const fallbackAt = indexSrc.indexOf("async function maybePromptBusinessManagerFinanceOutcomeFallback");
assert.ok(fallbackAt > 0, "the business-manager fallback prompt still exists");
const fallbackBody = indexSrc.slice(fallbackAt, fallbackAt + 1200);
assert.match(
  fallbackBody,
  /shouldPromptBusinessManagerFinanceOutcome\(conv\)\.prompt/,
  "the unprompted business-manager SMS gates on the narrow referee"
);
assert.doesNotMatch(
  fallbackBody,
  /isFinanceOutcomeContext\(conv\)/,
  "the broad origin-label test is no longer the gate for the unprompted SMS"
);
// The To-Do outcome endpoint READS an outcome a human already picked — it legitimately keeps the
// broad test, so a staff member marking a prequal lead "declined" still records the outcome.
assert.match(
  indexSrc,
  /isFinanceApprovalTodo[\s\S]{0,200}isFinanceOutcomeContext\(conv\)/,
  "the human-recorded To-Do outcome path still uses the broad finance-context test"
);

console.log(
  "PASS business_manager_finance_prompt eval — prequal origin alone never nags the business manager; credit app / live finance state / finance appointment still do; human-recorded outcomes unaffected"
);
