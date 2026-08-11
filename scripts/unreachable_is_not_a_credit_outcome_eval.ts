/**
 * "Couldn't reach them" is a separate answer, not a credit verdict (Joe, 2026-08-11: "build the
 * separate button").
 *
 * MEASURED on the live store before building: of 14 finance tasks marked `needs_more_info`, most were
 * not about missing information at all — *"Phone number is not reachable"*, *"4th call attempt that
 * does not go through"*, *"Call will not go through"*, *"remind stone to follow up in two weeks"*.
 * Staff were using the lender-contingency bucket as a catch-all for customers they could not REACH.
 *
 * That conflation is why nothing could safely act on `needs_more_info`: it would ask a customer for a
 * pay stub when the real problem is that nobody has answered the phone.
 *
 * Two halves, both pinned here:
 *   the STAFF half — a fourth option on the outcome form, and a handler that records it WITHOUT
 *     writing a finance outcome;
 *   the COMPREHENSION half — the call/SMS parser learns `unreachable`, so a reply that never
 *     connected stops landing in the lender bucket.
 *
 * Run: npx tsx scripts/unreachable_is_not_a_credit_outcome_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

const src = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");

// --- THE BUTTON ------------------------------------------------------------------------------
assert.ok(
  src.includes(`<option value="unreachable">Couldn't reach them</option>`),
  "the staff outcome form offers 'Couldn't reach them'"
);
assert.ok(src.includes(`if (financeOutcomeRaw === "unreachable") {`), "and the handler has a branch for it");
assert.ok(
  src.includes("recordFinanceCustomerUnreachable(conv, { note, token, nowIso })"),
  "which records it through the one writer"
);

// --- IT IS NEVER STORED AS A CREDIT VERDICT ---------------------------------------------------
// The SMS lane feeds applyFinanceOutcomeStatusFromSignal. `unreachable` must not be in that list.
// Anchor FORWARD from the gate — `applyFinanceOutcomeStatusFromSignal` is DEFINED earlier in the
// file than it is called, so slicing to its first occurrence produced an empty region and every
// assertion below "passed" on nothing. Take a fixed window after the gate instead.
const gateAt = src.indexOf("financeParsed?.explicitOutcome");
assert.ok(gateAt > 0, "the SMS finance-verdict gate must exist");
const verdictGate = src.slice(gateAt, gateAt + 400);
assert.ok(verdictGate.includes(`financeParsed.outcome === "approved"`), "approved is a verdict");
assert.ok(verdictGate.includes(`financeParsed.outcome === "declined"`), "declined is a verdict");
assert.ok(verdictGate.includes(`financeParsed.outcome === "needs_more_info"`), "needs_more_info is a verdict");
assert.ok(
  !verdictGate.includes(`financeParsed.outcome === "unreachable"`),
  "…and unreachable is NOT — it must never be written as a finance outcome"
);

async function main(): Promise<void> {
  // --- THE PARSER LEARNED IT, and the prompt keeps it apart from the lender bucket -------------
  const prompt: any = await import("../services/api/src/domain/financeOutcomePrompt.ts");
  assert.match(prompt.FINANCE_OUTCOME_UNREACHABLE_MAPPING, /never a lender verdict/i, "the mapping says what it is not");
  assert.match(prompt.FINANCE_OUTCOME_UNREACHABLE_RULE, /never needs_more_info/i, "the rule keeps the two apart");

  // Every exemplar is a REAL staff note copied off the live store. Three teach `unreachable`; the
  // fourth is the deliberate contrast — we DID reach them and the lender wants something.
  const ex: string[] = prompt.FINANCE_OUTCOME_UNREACHABLE_EXAMPLES;
  assert.equal(ex.length, 4, "three unreachable exemplars plus one contrast");
  const unreachable = ex.filter(e => e.includes('"outcome":"unreachable"'));
  assert.equal(unreachable.length, 3, "three real unreachable notes");
  for (const real of ["Phone number is not reachable", "4th call attempt that does not go through", "Called and left voicemail"]) {
    assert.ok(ex.some(e => e.includes(real)), `the real staff note "${real}" is taught`);
  }
  assert.ok(
    ex.some(e => e.includes('"outcome":"needs_more_info"') && /pay stub/i.test(e)),
    "and the contrast case — reached them, lender wants a document — stays needs_more_info"
  );

  // --- THE STORE WRITER: a task, no outcome ------------------------------------------------------
  // Importing the store hydrates one — point it at a temp dir so this never writes into the repo.
  process.env.DATA_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), "unreachable-eval-"));
  delete process.env.CONVERSATIONS_DB_PATH;
  const { recordFinanceCustomerUnreachable } = await import("../services/api/src/domain/conversationStore.ts");
  const conv: any = { id: "c", leadKey: "+17165550000", messages: [], lead: {} };
  recordFinanceCustomerUnreachable(conv, { note: "4th call attempt", token: "tok", nowIso: "2026-08-11T12:00:00.000Z" });
  assert.equal(conv.financeOutcome, undefined, "NO finance outcome is written — it is not a verdict");
  assert.ok(conv.financeOutcomeNotify, "the prompt state is stamped so the manager stops being nagged");
  assert.notEqual(
    String(conv.financeOutcomeNotify?.status ?? ""),
    "resolved",
    "…but NOT as resolved: the outcome is still unknown and a person still owns it"
  );

  console.log("PASS unreachable — a separate answer, recorded as a task, never as a credit verdict.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
