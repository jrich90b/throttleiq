/**
 * Draft prompt fingerprint eval (pure, no LLM).
 *
 * This instrument exists to answer ONE question: when the same customer turn produces a different
 * reply, did the model sample differently or did we hand it a different prompt? Two ways it could
 * lie, both pinned here:
 *   - MASK TOO LITTLE and the clock inside the prompt ("Today is", dealer hours, appointment slots
 *     built from now) makes every pair look like upstream drift — a false bug hunt on every turn;
 *   - MASK TOO MUCH and real drift disappears into the mask — the instrument reports "identical"
 *     while an inventory price or a parser result quietly changed underneath.
 *
 * Run: npx tsx scripts/draft_prompt_fingerprint_eval.ts
 */
import assert from "node:assert/strict";
import {
  buildDraftPromptFingerprint,
  hashPromptSections,
  maskVolatileClockValues,
  resolveDraftFingerprintDir
} from "../services/api/src/domain/draftPromptFingerprint.ts";

const base = (today: string, slot: string, price: string) => ({
  at: "2026-08-06T09:00:00.000Z",
  model: "gpt-5-mini",
  instructions: "You are a dealership assistant.",
  input: [
    "Lead facts:",
    `- inventoryListPrice: ${price}`,
    "",
    "Suggested appointment slots (if any):",
    slot,
    "",
    "Customer inquiry:",
    "that's too much money for a 2019",
    "",
    `Today is: ${today}`
  ].join("\n"),
  leadKey: "+15551234567",
  channel: "sms"
});

// --- 1) The clock moved and NOTHING else: must NOT read as upstream drift. ---
const runA = buildDraftPromptFingerprint(base("2026-08-06", "Thu, Aug 6, 9:30 AM", "$21,495"));
const runB = buildDraftPromptFingerprint(base("2026-08-07", "Fri, Aug 7, 11:30 AM", "$21,495"));
assert.notEqual(runA.hash, runB.hash, "the prompt genuinely differed, so the raw hash must differ");
assert.equal(
  runA.stableHash,
  runB.stableHash,
  "a date/time-only difference must NOT report as upstream drift — this is the trap the whole design is built around"
);

// --- 2) A real fact changed: must read as drift, even though the clock also moved. ---
const runC = buildDraftPromptFingerprint(base("2026-08-07", "Fri, Aug 7, 11:30 AM", "$19,995"));
assert.notEqual(
  runA.stableHash,
  runC.stableHash,
  "an inventory price change is exactly the upstream drift this must catch — masking must not swallow it"
);

// --- 3) The mismatch must say WHERE, or it is just 'different' with extra steps. ---
const secA = hashPromptSections(base("2026-08-06", "Thu, Aug 6, 9:30 AM", "$21,495").input);
const secC = hashPromptSections(base("2026-08-07", "Fri, Aug 7, 11:30 AM", "$19,995").input);
const moved = Object.keys(secA).filter(k => secA[k] !== secC[k]);
assert.deepEqual(moved, ["Lead facts"], `only the price section moved, got: ${moved.join(", ") || "(none)"}`);
assert.ok(
  Object.keys(secA).includes("Customer inquiry"),
  "sections must be keyed by the prompt's own headings so a human can read the culprit"
);

// --- 4) Identical input ⇒ identical fingerprint. Otherwise 'sampling' can never be proven. ---
const twice = buildDraftPromptFingerprint(base("2026-08-06", "Thu, Aug 6, 9:30 AM", "$21,495"));
assert.equal(runA.hash, twice.hash, "the same payload must fingerprint identically");
assert.equal(runA.chars, twice.chars, "character count must be stable for the same payload");

// The instructions half is sent too — a change confined to it is still a different prompt.
const instrChanged = buildDraftPromptFingerprint({
  ...base("2026-08-06", "Thu, Aug 6, 9:30 AM", "$21,495"),
  instructions: "You are a dealership assistant. Always offer a test ride."
});
assert.notEqual(runA.stableHash, instrChanged.stableHash, "a change in `instructions` must register");

// --- 5) Storage contract: off by default, kill switch wins, never writes on a dev machine. ---
assert.equal(resolveDraftFingerprintDir({}), null, "no configured root ⇒ off, so dev machines stay clean");
assert.equal(
  resolveDraftFingerprintDir({ REPORT_ROOT: "/r", DRAFT_PROMPT_FINGERPRINT_DISABLED: "1" }),
  null,
  "kill switch must win over a configured root"
);
assert.equal(resolveDraftFingerprintDir({ REPORT_ROOT: "/r" }), "/r/draft_prompt_fingerprint");
assert.equal(
  resolveDraftFingerprintDir({ REPORT_ROOT: "/r", DRAFT_PROMPT_FINGERPRINT_DIR: "/explicit" }),
  "/explicit",
  "an explicit dir beats REPORT_ROOT"
);

// --- 6) The mask is deliberately NARROW. These must survive it. ---
const kept = maskVolatileClockValues("stock T42-26 VIN 1HD1KB717TB631635 price $21,495 mileage 9,881");
assert.ok(kept.includes("T42-26") && kept.includes("1HD1KB717TB631635"), "stock and VIN must survive masking");
assert.ok(kept.includes("$21,495") && kept.includes("9,881"), "prices and mileage must survive masking");
// The WHOLE timestamp must go, not just its date half — a leftover "09:00:00" still moves the
// hash on every run. (Asserting only that the date is gone passes even with the ISO rule deleted,
// because the plain-date rule covers for it. Sabotaging the ISO rule proved that assertion hollow.)
const isoMasked = maskVolatileClockValues("captured at 2026-08-06T09:00:00.123Z for lead 42");
assert.ok(!/\d{2}:\d{2}:\d{2}/.test(isoMasked), `ISO timestamps must be fully masked, got: ${isoMasked}`);
assert.ok(isoMasked.includes("lead 42"), "masking must not eat surrounding content");
assert.equal(
  buildDraftPromptFingerprint({ ...base("2026-08-06", "Thu, Aug 6, 9:30 AM", "$21,495"), instructions: "sent 2026-08-06T09:00:00Z" }).stableHash,
  buildDraftPromptFingerprint({ ...base("2026-08-06", "Thu, Aug 6, 9:30 AM", "$21,495"), instructions: "sent 2026-08-06T17:42:11Z" }).stableHash,
  "two prompts differing ONLY by an ISO timestamp must share a stableHash"
);

console.log("PASS draft prompt fingerprint eval — clock-vs-drift discrimination, section localisation, storage contract");
