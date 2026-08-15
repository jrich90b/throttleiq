/**
 * What the draft-quality judge is fed: its thread history, and — on web-lead-form turns — the
 * LEAD RECORD. Pure, no I/O.
 *
 * On a form there is no ask to grade — the judge prompt says so in as many words ("a form's fields
 * are NOT requests", added to stop it inventing an ask out of `Payment Status: Failed`) — so
 * `intent_ok` passed those turns by construction. This supplies what a form DOES carry, the record
 * plus how engaged the thread already is, so the judge can ask "does this reply FIT?" instead.
 *
 * David Ventry `+17164233848`, 2026-08-13: an HDFS COA form on a mid-deal thread, answered with a
 * generic "are you looking at a specific bike?", passed the gate, and Scott retyped it by hand.
 * Measured over 30 days: web-lead forms are 15% of customer turns but 33% of the wrong-intent
 * corrections staff made themselves.
 *
 * Lives here rather than in index.ts because index.ts is at its size ceiling by design
 * (`source_size_ratchet:eval`) — the guard caught this on the first attempt and it was right to.
 */
import { keepCustomerReceivedOutbounds } from "./agentVoice.js";
import { buildCustomerReceivedHistory } from "./effectiveContext.js";
import type { DraftQualityLeadIntake } from "./draftQualityJudgePrompt.js";
import { isLeadIntakeFormInbound } from "./scoringExclusions.js";

/**
 * Returns `null` on every ordinary typed message — which is what keeps those judge prompts
 * byte-identical. Only a structured lead-intake payload produces a record.
 *
 * `priorReplyCount` counts what the customer actually RECEIVED: an unsent draft is not a reply they
 * saw, so a lead whose only prior "reply" is a pending draft is still a first touch and still gets
 * its introduction.
 */
export function buildDraftJudgeLeadRecord(conv: any, inbound: string): DraftQualityLeadIntake | null {
  if (!isLeadIntakeFormInbound(inbound)) return null;
  const lead = conv?.lead ?? {};
  const vehicle = lead?.vehicle ?? {};
  const year = String(vehicle?.year ?? "").trim();
  const model = String(vehicle?.model ?? vehicle?.description ?? "").trim();
  const priorReplyCount = keepCustomerReceivedOutbounds(
    Array.isArray(conv?.messages) ? conv.messages : []
  ).filter((m: any) => m?.direction === "out" && String(m?.body ?? "").trim()).length;
  return {
    source: String(lead?.source ?? "").trim() || null,
    vehicle: [year, model].filter(Boolean).join(" ") || null,
    inquiry: String(lead?.inquiry ?? lead?.comment ?? "").trim() || null,
    priorReplyCount,
    threadStage: String(conv?.followUp?.reason ?? conv?.dialogState?.name ?? "").trim() || null
  };
}

/**
 * Thread context for the DRAFT-QUALITY JUDGE only — received turns only. The judge asks "is this
 * draft right for this customer, given what they've heard from us"; an unsent `draft_ai` row is
 * not something they heard. See `buildCustomerReceivedHistory` for the case that motivated it.
 * Every other `buildHistory` consumer (the comprehension parsers, the draft generator) keeps the
 * full effective history on purpose.
 */
export function buildDraftJudgeHistory(conv: any, limit = 8) {
  return buildCustomerReceivedHistory(conv, limit);
}
