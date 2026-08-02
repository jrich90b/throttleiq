/**
 * No-response judge eval (STEP 1 — shadow). The second inline judge of the self-correcting loop.
 *
 * The draft judge only fires when a draft IS produced, so a wrongful SILENCE (the agent should have
 * replied but stayed quiet) is invisible to it. This judge (judgeShouldRespondWithLLM) runs at the
 * suppress / no-response decision points and asks: did this turn warrant a reply? The pure gate
 * (decideNoResponseJudge) maps the verdict to pass / flag_missing_response. STEP 1 ships DARK — it
 * only shadow-logs wrongful silences; producing a reply in place of silence is a later, approve-first step.
 *
 * Layers: (1) source guard (judge + gate + flags exist; the shadow hook is wired into BOTH the regen
 * chokepoint and the live terminal no-response; STEP-1-shadow-only assertion), (2) pure decision table
 * (pass on silence-ok / low-confidence / no-verdict; flag only on a confident should_respond; live only
 * when the flag is on), (3) LLM coverage — a real ask flags as wrongful silence; an ack/opt-out/closeout
 * does NOT (the false-positive guard: don't manufacture replies).
 *
 * Run gated: LLM_ENABLED=1 LLM_SHOULD_RESPOND_JUDGE_ENABLED=1 npx tsx scripts/no_response_judge_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { judgeShouldRespondWithLLM } from "../services/api/src/domain/llmDraft.ts";
import { decideNoResponseJudge, DRAFT_QUALITY_MIN_CONFIDENCE } from "../services/api/src/domain/draftQualityGate.ts";
import { resolveNoResponseTrace } from "../services/api/src/domain/noResponseTrace.ts";

// --- 1) Source guard (no LLM). ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
const gate = fs.readFileSync("services/api/src/domain/draftQualityGate.ts", "utf8");

assert.ok(/export async function judgeShouldRespondWithLLM/.test(llm), "the judge must be exported from llmDraft.ts");
assert.ok(/SHOULD_RESPOND_JUDGE_JSON_SCHEMA/.test(llm), "the strict JSON schema const must exist");
assert.ok(/LLM_SHOULD_RESPOND_JUDGE_ENABLED/.test(llm), "the judge must be behind an enable flag");
assert.ok(/export function decideNoResponseJudge/.test(gate), "the pure gate must be in draftQualityGate.ts");
assert.ok(
  /NO_RESPONSE_JUDGE_ENABLED/.test(gate) && /NO_RESPONSE_JUDGE_SHADOW/.test(gate),
  "the live-enable + shadow flags must exist"
);
const callSites = (index.match(/void runNoResponseJudgeShadow\(/g) || []).length;
assert.ok(
  callSites >= 4,
  `the shadow hook must be wired at the regen chokepoint + EVERY judged live silence terminal; found ${callSites}`
);

// --- 1b) COVERAGE ratchet (2026-08-02) -----------------------------------------------------------
// The judge was wired at exactly ONE live terminal (`routing_parser_no_response`) and so almost never
// ran: 10 events in the whole route-outcome history, against ~220 on the two terminals below. That is
// why the shadow log held a single wrongful-silence flag ever — not because the agent never wrongly
// goes quiet, but because nothing was watching where it actually goes quiet. A judge with no coverage
// reads as "all clear", which is the dangerous direction.
//
// Each entry: a silence terminal we CLAIM to judge. The hook must appear within the same block, i.e.
// before that branch's `return`. Anchored on the outcome string so moving code can't silently drop it.
const JUDGED_SILENCE_TERMINALS: Array<{ anchor: string; why: string }> = [
  { anchor: 'logRouteOutcome("short_ack_no_reply")', why: "lexical ack test — an ack+question lands here too" },
  // Anchored on the live BRANCH CONDITION, not the outcome string: `customer_ack_no_response` also
  // appears earlier in the REGEN path, so an outcome-string anchor silently graded the wrong block.
  {
    anchor: "if ((customerAckNoResponse || customerWillProvideTimeFallback",
    why: "the largest live silence terminal (ack / response-control / will-provide-time)"
  },
  { anchor: 'logRouteOutcome("routing_parser_no_response"', why: "the original wiring" }
];
for (const { anchor, why } of JUDGED_SILENCE_TERMINALS) {
  const at = index.indexOf(anchor);
  assert.ok(at > 0, `silence terminal anchor missing from index.ts: ${anchor}`);
  const window = index.slice(at, at + 2400);
  const hookAt = window.indexOf("void runNoResponseJudgeShadow(");
  const returnAt = window.indexOf("return res.status(200)");
  assert.ok(
    hookAt >= 0 && (returnAt < 0 || hookAt < returnAt),
    `silence terminal "${anchor}" (${why}) must run the wrongful-silence judge BEFORE it returns`
  );
}

// The deliberate NON-coverage, recorded so a future reader knows these are choices, not oversights:
//   opt-out / wrong-number       — compliance silence; second-guessing it is the one unsafe direction
//   reaction_only_inbound        — an iOS tapback has nothing to answer; judging it is pure LLM spend
//   owner_thread_step_back       — already raises a `call` todo to the lead owner; a human IS looking
//   in_process_deal_staff_todo   — same, a staff todo already exists
//   human_thread_nudge_*         — PROACTIVE suppression; the cadence-quality judge owns that lane
assert.ok(
  /compliance silence|Shadow: we read this as a bare/.test(index),
  "the judged silence terminals must carry their reasoning inline"
);
assert.ok(/STEP 1 is shadow-only: never produce a reply/.test(index), "STEP 1 must be shadow-only (no live reply)");
// Social-reciprocation opportunities ("have a good weekend!") surface in shadow so staff can decide.
// The stage string moved from index.ts to domain/noResponseTrace.ts when the trace shaping was
// extracted (2026-08-02) — pin it at its NEW home, and keep asserting the judge still categorises it.
const trace = fs.readFileSync("services/api/src/domain/noResponseTrace.ts", "utf8");
assert.ok(
  /social_reciprocation/.test(llm) && /no_response\.social_reciprocation/.test(trace),
  "social-reciprocation must be categorized (llmDraft) + surfaced on its own trace stage (noResponseTrace)"
);
assert.ok(
  /resolveNoResponseTrace\(/.test(index),
  "index.ts must shape its trace through the pure resolver, not re-derive the stage inline"
);

// --- 2) Decision-table coverage (pure). ---
type V = Parameters<typeof decideNoResponseJudge>[0]["verdict"];
type Row = { id: string; input: Parameters<typeof decideNoResponseJudge>[0]; action: string; live: boolean };
const rows: Row[] = [
  { id: "no_verdict_pass", input: { enabled: true, verdict: null }, action: "pass", live: false },
  { id: "silence_ok_pass", input: { enabled: true, verdict: { shouldRespond: false, confidence: 0.95 } as V }, action: "pass", live: false },
  { id: "should_respond_shadow_when_off", input: { enabled: false, verdict: { shouldRespond: true, confidence: 0.95 } as V }, action: "flag_missing_response", live: false },
  { id: "should_respond_live_when_on", input: { enabled: true, verdict: { shouldRespond: true, confidence: 0.95 } as V }, action: "flag_missing_response", live: true },
  { id: "below_confidence_pass", input: { enabled: true, verdict: { shouldRespond: true, confidence: DRAFT_QUALITY_MIN_CONFIDENCE - 0.01 } as V }, action: "pass", live: false },
  { id: "at_floor_acts", input: { enabled: true, verdict: { shouldRespond: true, confidence: DRAFT_QUALITY_MIN_CONFIDENCE } as V }, action: "flag_missing_response", live: true }
];
for (const r of rows) {
  const d = decideNoResponseJudge(r.input);
  assert.equal(d.action, r.action, `gate[${r.id}] action expected ${r.action}, got ${d.action}`);
  assert.equal(d.live, r.live, `gate[${r.id}] live expected ${r.live}, got ${d.live}`);
}

// --- 2b) Trace shaping (pure, no LLM) — which finding, and whether it is recorded at all. ---------
{
  const flagged = { action: "flag_missing_response" as const, live: false };
  const flaggedLive = { action: "flag_missing_response" as const, live: true };
  const passed = { action: "pass" as const, live: false };

  assert.equal(
    resolveNoResponseTrace({ verdict: null, decision: flagged, inboundText: "hi" }),
    null,
    "no verdict => record nothing"
  );
  assert.equal(
    resolveNoResponseTrace({
      verdict: { shouldRespond: false, category: "no_reply" },
      decision: passed,
      inboundText: "ok thanks"
    }),
    null,
    "a correct silence on a pure ack is not a finding — never record it"
  );
  assert.equal(
    resolveNoResponseTrace({
      verdict: { shouldRespond: true, category: "answer_needed" },
      decision: flagged,
      inboundText: "what time do you close?"
    })?.stage,
    "no_response.shadow",
    "a wrongful silence while dark records as shadow"
  );
  assert.equal(
    resolveNoResponseTrace({
      verdict: { shouldRespond: true, category: "answer_needed" },
      decision: flaggedLive,
      inboundText: "what time do you close?"
    })?.stage,
    "no_response.flag",
    "...and as a live flag once the judge is enforcing"
  );
  assert.equal(
    resolveNoResponseTrace({
      verdict: { shouldRespond: false, category: "social_reciprocation" },
      decision: passed,
      inboundText: "have a good weekend!"
    })?.stage,
    "no_response.social_reciprocation",
    "a warm closer is an opportunity, recorded on its own stage"
  );
  // THE ONE THAT MATTERS: a social closer the gate ALSO flagged must file as the wrongful silence,
  // or a real dropped ask gets quietly downgraded to a nice-to-have and never counted.
  assert.equal(
    resolveNoResponseTrace({
      verdict: { shouldRespond: true, category: "social_reciprocation" },
      decision: flagged,
      inboundText: "thanks! and what time do you close?"
    })?.stage,
    "no_response.shadow",
    "the stronger finding wins — a flagged silence is never filed as social reciprocation"
  );
  const detail = resolveNoResponseTrace({
    verdict: { shouldRespond: true, category: "answer_needed", confidence: 0.91, reason: "x".repeat(400) },
    decision: flagged,
    inboundText: "y".repeat(400)
  })!.detail;
  assert.equal(detail.confidence, 0.91, "confidence carries through");
  assert.ok(String(detail.reason).length <= 180, "reason is truncated");
  assert.ok(String(detail.inboundPreview).length <= 140, "inbound preview is truncated");
}

// --- 3) LLM coverage (gated; skips cleanly). ---
const cases: { id: string; inbound: string; wantRespond: boolean; wantCategory?: string }[] = [
  { id: "price_question", inbound: "What is the asking price?", wantRespond: true, wantCategory: "answer_needed" },
  { id: "media_request", inbound: "can you send me a couple pics of it?", wantRespond: true, wantCategory: "answer_needed" },
  { id: "availability_question", inbound: "is it still available?", wantRespond: true, wantCategory: "answer_needed" },
  // Social closers: NOT a dropped ask (should_respond false) but surfaced as a reciprocation chance.
  { id: "social_weekend", inbound: "have a good weekend!", wantRespond: false, wantCategory: "social_reciprocation" },
  { id: "pure_ack", inbound: "👍", wantRespond: false, wantCategory: "no_reply" },
  { id: "opt_out", inbound: "STOP", wantRespond: false, wantCategory: "no_reply" }
];

let ran = 0;
for (const c of cases) {
  const v = await judgeShouldRespondWithLLM({ inbound: c.inbound });
  if (!v) continue; // judge disabled / transient null — skip, don't red the gate
  ran += 1;
  assert.equal(
    v.shouldRespond,
    c.wantRespond,
    `[${c.id}] expected should_respond=${c.wantRespond}, got ${v.shouldRespond} (${v.reason})`
  );
  if (c.wantCategory) {
    assert.equal(v.category, c.wantCategory, `[${c.id}] expected category=${c.wantCategory}, got ${v.category} (${v.reason})`);
  }
}

console.log(
  ran === 0
    ? `PASS no response judge eval (source guard + ${rows.length} decision-table rows; LLM coverage skipped — judge disabled)`
    : `PASS no response judge eval (source guard + ${rows.length} decision-table rows + ${ran}/${cases.length} LLM coverage cases)`
);
