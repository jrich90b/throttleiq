/**
 * campaign_copy_budget_eval
 *
 * Regression guard for the campaign copy LLM output-token budget.
 *
 * Production incident (7/15): SMS campaigns with an attached reference brief generated
 * generic template copy that ignored the brief. Root cause: the copy call
 * (gpt-5-mini, a reasoning model, prompt that asks for a full responsive HTML email
 * even for SMS-only) hit the max_output_tokens cap of 1800 EXACTLY — the JSON was
 * truncated, the parse failed, and generateCampaignContent fell back to a template
 * that never reads the brief. Raising the budget lets the JSON finish so the extracted
 * brief actually shapes the copy.
 *
 * This pins the budget above the value that truncated, so nobody silently drops it back.
 */
import { strict as assert } from "node:assert";
import { CAMPAIGN_COPY_MAX_OUTPUT_TOKENS } from "../services/api/src/domain/campaignBuilder.js";

// The old cap that truncated a full-email JSON in production.
const TRUNCATING_CAP = 1800;
// Floor with comfortable headroom over a full responsive HTML email + minimal reasoning.
const MIN_SAFE_BUDGET = 4000;

assert.ok(
  CAMPAIGN_COPY_MAX_OUTPUT_TOKENS > TRUNCATING_CAP,
  `campaign copy budget must exceed the ${TRUNCATING_CAP} that truncated in production (got ${CAMPAIGN_COPY_MAX_OUTPUT_TOKENS})`
);
assert.ok(
  CAMPAIGN_COPY_MAX_OUTPUT_TOKENS >= MIN_SAFE_BUDGET,
  `campaign copy budget must be >= ${MIN_SAFE_BUDGET} to fit a full email + reasoning (got ${CAMPAIGN_COPY_MAX_OUTPUT_TOKENS})`
);

console.log(`campaign_copy_budget_eval: OK (budget=${CAMPAIGN_COPY_MAX_OUTPUT_TOKENS})`);
