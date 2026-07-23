/**
 * Web-widget department handoff ack eval (2026-07-13).
 *
 * A Service/Parts/Apparel web-form lead used to get a STATIC "I've passed your message along and
 * they'll text you right back" template that ignored the customer's specific typed request — so
 * James Browne's "quote for a lower cylinder head replacement on a 2018 Street Glide Special" got a
 * generic handoff that the draft-quality gate correctly HELD (it dropped the request). The fix
 * generates the ack with the LLM (buildDepartmentHandoffAckWithLLM): engage the specific request,
 * commit the department to follow up, NEVER fabricate a price/availability (no DMS), and fall back
 * to the safe static template on any failure.
 *
 * Pins: kill switch + LLM-off fail-safe (deterministic), the index.ts wiring (source guard), and —
 * when a key is present — LLM coverage on James's exact request (engages + no fabricated price).
 *
 * Run: npx tsx scripts/web_widget_department_ack_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildDepartmentHandoffAckWithLLM } from "../services/api/src/domain/llmDraft.ts";
import {
  buildDeptHandoffAckFallback,
  buildWebTextWidgetSalesAckFallback
} from "../services/api/src/domain/webWidgetAckTemplates.ts";

const JAMES = {
  message: "Looking for a quote for a lower cylinder head replacement on a 2018 street glide special",
  deptLabel: "Service",
  firstName: "James"
};
const STATIC_TEMPLATE = buildDeptHandoffAckFallback({ firstName: "James", deptLabel: "Service" });

// No immediate-reply promise, ever (Tom Bradsky +16054313150, 2026-07-04): his Parts web
// form arrived mid-day on the July 4 holiday and the old template promised "they'll text
// you right back" — staff had to hand-edit the send to "they'll text you back on Monday"
// (human_correction_material). The ack — static OR LLM — commits the department to follow
// up but never promises WHEN. This is an eval assertion over OUR OWN template output
// (structured copy check), not customer-intent comprehension.
const IMMEDIATE_REPLY_PROMISE_RE =
  /right (?:back|away)|straight back|momentarily|immediately|in (?:a|just a) (?:minute|moment|second|bit|few minutes)|within (?:the hour|minutes|a few minutes)|shortly|very soon|asap|right now|(?:text|get back to|reach out to|contact|call) you (?:today|soon|tonight)/i;

// --- Deterministic fail-safes (no LLM needed) ---

// Kill switch: LLM_DEPARTMENT_ACK_ENABLED=0 => null (caller uses the static template).
{
  const prev = process.env.LLM_DEPARTMENT_ACK_ENABLED;
  process.env.LLM_DEPARTMENT_ACK_ENABLED = "0";
  assert.equal(await buildDepartmentHandoffAckWithLLM(JAMES), null, "kill switch returns null (static template)");
  if (prev === undefined) delete process.env.LLM_DEPARTMENT_ACK_ENABLED;
  else process.env.LLM_DEPARTMENT_ACK_ENABLED = prev;
}

// LLM disabled => null (fail-safe; never blocks, caller falls back).
{
  const prevEnabled = process.env.LLM_ENABLED;
  process.env.LLM_ENABLED = "0";
  assert.equal(await buildDepartmentHandoffAckWithLLM(JAMES), null, "LLM off => null (fail-safe to template)");
  if (prevEnabled === undefined) delete process.env.LLM_ENABLED;
  else process.env.LLM_ENABLED = prevEnabled;
}

// Empty message => null (nothing to engage).
assert.equal(
  await buildDepartmentHandoffAckWithLLM({ ...JAMES, message: "  " }),
  null,
  "empty request => null"
);

// --- Approved static fallback templates: warm, committed, NO reply-time promise ---
{
  // Tom's exact production shape: Parts form, first name known.
  const tomAck = buildDeptHandoffAckFallback({ firstName: "Tom", deptLabel: "Parts" });
  assert.equal(
    tomAck,
    "Hi Tom — thanks for reaching out to our Parts team. I've passed your message along and they'll get back to you as soon as they can.",
    "dept handoff ack is the approved timing-neutral template"
  );
  const deptVariants = [
    tomAck,
    buildDeptHandoffAckFallback({ firstName: null, deptLabel: "Service" }),
    buildDeptHandoffAckFallback({ firstName: "", deptLabel: "" })
  ];
  for (const v of deptVariants) {
    assert.doesNotMatch(v, IMMEDIATE_REPLY_PROMISE_RE, `dept ack promises no reply time: ${v}`);
    assert.match(v, /passed your message along/i, "dept ack still reads as a design-accepted handoff (replay classifier shape)");
    assert.match(v, /they'll get back to you/i, "dept ack still commits the department to follow up");
  }
  // Sales widget "never leave silence" ack (live + regen share this builder).
  const salesVariants = [
    buildWebTextWidgetSalesAckFallback({ firstName: "Mike", year: 2013, model: "Street Glide" }),
    buildWebTextWidgetSalesAckFallback({ firstName: null })
  ];
  assert.match(salesVariants[0], /the 2013 Street Glide/, "sales ack references the requested unit");
  assert.match(salesVariants[1], /about that\b/, "sales ack degrades gracefully with no unit context");
  for (const v of salesVariants) {
    assert.doesNotMatch(v, IMMEDIATE_REPLY_PROMISE_RE, `sales widget ack promises no reply time: ${v}`);
    assert.match(v, /I'll get back to you/i, "sales widget ack still commits to a follow-up");
  }
}

// The LLM prompt carries the same hard rule (so the engaged ack can't re-introduce the promise).
{
  const llmDraftSrc = fs.readFileSync(path.resolve("services/api/src/domain/llmDraft.ts"), "utf8");
  assert.ok(
    llmDraftSrc.includes("NEVER promise WHEN the team will reply"),
    "buildDepartmentHandoffAckWithLLM prompt forbids reply-time promises"
  );
}

// --- Source guard: index.ts engages via the LLM and falls back to the static template ---
const indexSrc = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
assert.match(
  indexSrc,
  /buildDepartmentHandoffAckWithLLM\(\{ message, deptLabel, firstName \}\)/,
  "the department path calls buildDepartmentHandoffAckWithLLM with the customer's message"
);
assert.match(
  indexSrc,
  /const deptAck = deptAckEngaged \|\| deptAckFallback/,
  "the department path falls back to the static template when the LLM ack is unavailable"
);

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
assert.ok(
  String(pkg.scripts?.["ci:eval"] ?? "").includes("web_widget_department_ack:eval"),
  "web_widget_department_ack:eval is wired into ci:eval"
);

// --- LLM coverage on James's exact request (skipped when no key) ---
if (process.env.OPENAI_API_KEY) {
  process.env.LLM_ENABLED = "1";
  const ack = await buildDepartmentHandoffAckWithLLM(JAMES);
  assert.ok(ack && ack.trim().length > 0, "LLM produces a non-empty ack for a real request");
  const text = String(ack);
  assert.notEqual(text, STATIC_TEMPLATE, "the LLM ack is not the generic static template");
  assert.doesNotMatch(text, /"i've passed your message along"/i, "the ack does not fall back to the passive handoff line");
  // Engages the SPECIFIC request (references the job/part/bike the customer named).
  assert.match(
    text,
    /cylinder|head|street\s*glide|glide|quote|replacement/i,
    "the ack references the customer's specific request (engages, not canned)"
  );
  // NEVER fabricates a price / dollar figure (no DMS).
  assert.doesNotMatch(text, /\$\s?\d/, "the ack contains no fabricated dollar price");
  assert.doesNotMatch(text, /\b\d{2,5}\s*(dollars|bucks)\b/i, "the ack states no fabricated price in words");
  // NEVER promises when the department will reply (Tom Bradsky, July 4).
  assert.doesNotMatch(text, IMMEDIATE_REPLY_PROMISE_RE, `the LLM ack promises no reply time: ${text}`);
  console.log(`  LLM coverage ack: ${text}`);

  // Tom Bradsky's exact production request (Parts form on a holiday).
  const tomLLM = await buildDepartmentHandoffAckWithLLM({
    message: "Are parts available for the serial 1 ebikes",
    deptLabel: "Parts",
    firstName: "Tom"
  });
  assert.ok(tomLLM && tomLLM.trim().length > 0, "LLM produces an ack for Tom's parts request");
  assert.doesNotMatch(String(tomLLM), IMMEDIATE_REPLY_PROMISE_RE, `Tom's ack promises no reply time: ${tomLLM}`);
  assert.doesNotMatch(String(tomLLM), /\$\s?\d/, "Tom's ack contains no fabricated price");
  console.log(`  LLM coverage ack (Tom): ${tomLLM}`);
} else {
  console.log("  (LLM coverage skipped — no OPENAI_API_KEY)");
}

console.log("PASS web-widget department ack eval (kill switch + LLM-off fail-safe + wiring source guard + engage/no-fabrication LLM coverage)");
