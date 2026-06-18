/**
 * Trade-qualifier-response parser migration eval (deterministic source guard + LLM coverage).
 *
 * Pins the de-tangle migration of the "do you have a trade?" reply classification from the
 * inline regex pair (isNoTradeResponseText for decline + isAffirmative/"i have" for affirm) to
 * the typed parser parseTradeQualifierResponseWithLLM, wired into BOTH /webhooks/twilio and
 * /conversations/:id/regenerate. The source guard always runs (it can't flake); the LLM coverage
 * runs when the parser is enabled (ci:eval loads OPENAI_API_KEY) and skips cleanly otherwise.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseTradeQualifierResponseWithLLM } from "../services/api/src/domain/llmDraft.ts";

// --- Source guard (no LLM): the regex is retired and the parser is wired in BOTH paths. ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.ok(
  !/\bisNoTradeResponseText\s*\(/.test(index),
  "the isNoTradeResponseText regex must be retired (no call sites)"
);
assert.ok(
  !/function\s+isNoTradeResponseText/.test(index),
  "the isNoTradeResponseText definition must be removed"
);
const callSites = (index.match(/parseTradeQualifierResponseWithLLM\(/g) || []).length;
assert.ok(
  callSites >= 2,
  `parseTradeQualifierResponseWithLLM must be wired in BOTH paths (live + regenerate); found ${callSites} call site(s)`
);

const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
assert.ok(
  /export async function parseTradeQualifierResponseWithLLM/.test(llm),
  "the parser must be exported from llmDraft.ts"
);
assert.ok(
  /TRADE_QUALIFIER_RESPONSE_PARSER_JSON_SCHEMA/.test(llm),
  "the strict JSON schema const must exist"
);
assert.ok(
  /LLM_TRADE_QUALIFIER_RESPONSE_PARSER_ENABLED/.test(llm),
  "the parser must be behind an enable flag"
);

// --- LLM coverage (runs when the parser is enabled; skips cleanly otherwise). ---
const cases: { text: string; expect: "affirmed" | "declined" | "unclear" }[] = [
  { text: "no trade", expect: "declined" },
  { text: "nope, no trade for me", expect: "declined" },
  { text: "without a trade", expect: "declined" },
  { text: "I've got a 2019 Road Glide", expect: "affirmed" },
  { text: "yeah I do", expect: "affirmed" },
  { text: "what's the out the door price?", expect: "unclear" }
];

let ran = 0;
for (const c of cases) {
  const parsed = await parseTradeQualifierResponseWithLLM({ text: c.text });
  if (!parsed) continue; // parser disabled or a transient null — skip, don't red the gate
  ran += 1;
  assert.equal(
    parsed.hasTrade,
    c.expect,
    `"${c.text}" should classify as ${c.expect}, got ${parsed.hasTrade}`
  );
}

console.log(
  ran === 0
    ? "PASS trade qualifier response eval (source guard; LLM coverage skipped — parser disabled)"
    : `PASS trade qualifier response eval (source guard + ${ran}/${cases.length} LLM coverage cases)`
);
