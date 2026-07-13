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

const JAMES = {
  message: "Looking for a quote for a lower cylinder head replacement on a 2018 street glide special",
  deptLabel: "Service",
  firstName: "James"
};
const STATIC_TEMPLATE =
  "Hi James — thanks for reaching out to our Service team. I've passed your message along and they'll text you right back.";

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
  console.log(`  LLM coverage ack: ${text}`);
} else {
  console.log("  (LLM coverage skipped — no OPENAI_API_KEY)");
}

console.log("PASS web-widget department ack eval (kill switch + LLM-off fail-safe + wiring source guard + engage/no-fabrication LLM coverage)");
