/**
 * Draft-judge received-history eval (agent-watch held-draft sweep, 2026-08-01).
 *
 * THE MISS this pins. Charles Desalvo `+17168614216` had a draft HELD by the live quality gate on
 * 2026-07-31T18:36:56Z with the judge reason:
 *
 *   "...It also misidentifies sender—previous outgoing was Alex"
 *
 * There was no previous outgoing. The thread's only `out` row was a `draft_ai` message with
 * `draftStatus: "stale"` — a draft nobody ever approved. `buildEffectiveHistory` handed it to the
 * judge as a plain `out:` turn, so the judge graded the candidate for consistency with a message
 * that was never delivered. That complaint is unsatisfiable by construction, which is exactly why
 * self-heal could not clear the hold, and the customer received NOTHING across two ADFs and four
 * days.
 *
 * THE FIX: the draft-quality judge reads `buildCustomerReceivedHistory` — every inbound, plus only
 * the outbounds a real provider delivered (`keepCustomerReceivedOutbounds`, the same allowlist that
 * already decides whether to re-introduce the agent).
 *
 * Fixture-driven and dealer-portable: no live dealer text, no per-dealer fact, no LLM call.
 * BOTH DIRECTIONS are pinned — a genuinely delivered outbound must still reach the judge, or this
 * fix would blind the gate to real sender/contradiction drift.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keepCustomerReceivedOutbounds } from "../services/api/src/domain/agentVoice.ts";
import {
  buildCustomerReceivedHistory,
  buildEffectiveHistory
} from "../services/api/src/domain/effectiveContext.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

// ── The replay fixture: the Desalvo shape, with fictional names/text.
// Two ADFs in, one AI draft that was never sent. Nothing has reached the customer.
const heldTurnShape = {
  id: "+15550001111",
  leadKey: "+15550001111",
  mode: "suggest",
  followUp: { mode: "active", reason: "post_sale" },
  lead: { firstName: "Riley", vehicle: { model: "Road King" }, source: "Dealer Lead App" },
  messages: [
    { direction: "in", provider: "sendgrid_adf", body: "WEB LEAD (ADF) Source: Traffic Log Pro Name: Riley" },
    { direction: "in", provider: "sendgrid_adf", body: "WEB LEAD (ADF) Source: Dealer Lead App Name: Riley" },
    {
      direction: "out",
      provider: "draft_ai",
      draftStatus: "stale",
      body: "Hey Riley, it's Danielle over at Lakeside Cycle Works. Thanks again for coming in."
    }
  ]
} as any;

// ── (a) The unsent draft is invisible to the judge — no phantom "previous outgoing".
const judged = buildCustomerReceivedHistory(heldTurnShape, 8);
assert.ok(judged.length > 0, "the judge still sees the customer's own turns");
assert.equal(
  judged.some(t => t.direction === "out" && /Danielle/.test(t.body)),
  false,
  "a never-sent draft_ai row must not reach the judge as a prior outgoing message"
);
assert.equal(
  judged.filter(t => t.direction === "in").length,
  2,
  "every inbound survives the filter — we only ever drop undelivered outbounds"
);

// ── (b) The unfiltered builder still carries it, so this is a judge-scoped narrowing and NOT a
// silent context change for the ~40 comprehension parsers and the draft generator.
const unfiltered = buildEffectiveHistory(heldTurnShape, 8);
assert.equal(
  unfiltered.some(t => t.direction === "out" && /Danielle/.test(t.body)),
  true,
  "buildEffectiveHistory is unchanged — the narrowing is opt-in at the judge call sites only"
);

// ── (c) FAIL DIRECTION THE OTHER WAY: a delivered outbound must still reach the judge, so a real
// sender switch / contradiction is still catchable. Without this the fix would blind the gate.
const deliveredShape = {
  ...heldTurnShape,
  messages: [
    ...heldTurnShape.messages,
    {
      direction: "out",
      provider: "twilio",
      body: "Hey Riley, it's Danielle over at Lakeside Cycle Works. Following up on the Road King."
    }
  ]
} as any;
const withDelivered = buildCustomerReceivedHistory(deliveredShape, 8);
assert.equal(
  withDelivered.filter(t => t.direction === "out" && /Following up on the Road King/.test(t.body)).length,
  1,
  "a twilio-delivered outbound is still part of the judge's thread"
);
assert.equal(
  withDelivered.some(t => t.direction === "out" && /Thanks again for coming in/.test(t.body)),
  false,
  "the stale draft stays dropped even once a real send exists"
);

// ── (d) The allowlist itself: every delivering provider is kept, every draft/log row is dropped.
for (const provider of ["twilio", "sendgrid", "human", "web_widget"]) {
  assert.equal(
    keepCustomerReceivedOutbounds([{ direction: "out", provider }]).length,
    1,
    `${provider} delivers to the customer — keep it`
  );
}
for (const provider of ["draft_ai", "voice_call", "voice_summary", "voice_transcript", "payment_event", "", "brand_new_provider"]) {
  assert.equal(
    keepCustomerReceivedOutbounds([{ direction: "out", provider }]).length,
    0,
    `${provider || "(blank)"} never reached the customer — drop it (unknown providers fail toward not-received)`
  );
}
assert.deepEqual(keepCustomerReceivedOutbounds(null), [], "null-safe");
assert.deepEqual(keepCustomerReceivedOutbounds(undefined), [], "undefined-safe");
assert.equal(
  keepCustomerReceivedOutbounds([{ direction: "in", provider: "draft_ai" }]).length,
  1,
  "the provider allowlist applies to OUTBOUNDS only — an inbound is never filtered"
);

// ── (e) Tripwire: the draft-quality judge call sites must not drift back to the unfiltered
// builder. Asserted on the judge invocations themselves, not on a file-wide call count, so
// unrelated buildHistory reuse stays free (see the eval-source-count-brittleness lesson).
const indexSrc = fs.readFileSync(path.join(repoRoot, "services/api/src/index.ts"), "utf8");
const judgeCalls = indexSrc.split("judgeDraftQualityWithLLM({").slice(1);
assert.ok(judgeCalls.length >= 2, "expected the shadow + pre-publish judge call sites");
for (const [i, call] of judgeCalls.entries()) {
  const args = call.slice(0, 400);
  assert.match(
    args,
    /history:\s*buildDraftJudgeHistory\(/,
    `judgeDraftQualityWithLLM call site #${i + 1} must read the RECEIVED-only thread`
  );
}

console.log("PASS draft_judge_received_history:eval");
