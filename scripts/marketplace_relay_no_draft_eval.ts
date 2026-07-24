/**
 * marketplace_relay_no_draft:eval — a marketplace-relay ADF lead (AutoDealers.Digital / Facebook
 * Marketplace with NO phone) has no direct SMS/email channel, so the ADF pipeline must NOT publish an
 * auto draft — the reply happens in the marketplace/Facebook inbox. Operator-reported 2026-07-10
 * (adf_ref_11534, Howard Dale: "auto dealer digital, cannot sms from here, has to be handled in
 * facebook"). The intake block already routes these to a handoff todo + manual_handoff, but it falls
 * through to the publish gate and a dead draft still got generated: 7 relay leads carried an
 * undeliverable draft_ai (adf_ref_11592 2026-07-07 was a LIVE pending draft the operator had to discard).
 *
 * Source-guard pins (same style as call_only_lead_silence:eval):
 *  1. publishAdfDraftForPreferredContact suppresses on relayOnlyMarketplaceLead UNCONDITIONALLY.
 *  2. The gate sits AFTER the phone-preferred gate and BEFORE the draft is appended (applyAdfReplyInvariant),
 *     so no draft_ai / email draft is produced for a channel-less relay lead.
 *  3. Fail-direction: the intake block still creates the marketplace-relay handoff todo
 *     + manual_handoff — suppression never means "dropped".
 *
 * Joe ruling 2026-07-24 (owned Facebook task + ready-to-paste reply): full FB automation is OUT,
 * so a relay lead must (a) drop a "reply in Facebook Marketplace" task OWNED BY THE LEAD OWNER and
 * (b) carry a warm, ready-to-paste first reply attached to that task (folded into the todo summary,
 * no frontend change) so a rep pastes it into Facebook in ~10 seconds. This extends the guard to
 * pin (a)+(b) while (c) the NO-sendable-draft guard above still holds — the paste reply is
 * REFERENCE copy, never a LeadRider-sendable draft_ai. 15 relay leads since 7/11 got zero contact
 * off the old generic handoff; this is the fix.
 */
import fs from "node:fs";
import path from "node:path";
import { buildMarketplaceRelayFirstTouchReply, buildMarketplaceRelayTaskSummary } from "../services/api/src/domain/marketplaceRelay.js";

type Check = { id: string; actual: unknown; expected: unknown };
const check = (id: string, actual: unknown, expected: unknown): Check => ({ id, actual, expected });

const route = fs.readFileSync(path.join(process.cwd(), "services/api/src/routes/sendgridInbound.ts"), "utf8");
const store = fs.readFileSync(path.join(process.cwd(), "services/api/src/domain/conversationStore.ts"), "utf8");

// --- 1. the publish gate suppresses relay leads unconditionally ---
const publishStart = route.indexOf("const publishAdfDraftForPreferredContact");
const publishBlock = publishStart >= 0 ? route.slice(publishStart, publishStart + 2600) : "";
const publishGateSuppressesRelay =
  /if \(relayOnlyMarketplaceLead\) \{\s*\n\s*return \{ ok: false, reason: "marketplace_relay" \};\s*\n\s*\}/.test(
    publishBlock
  );
const publishGateHasNoModeEscape = !/relayOnlyMarketplaceLead && systemMode/.test(publishBlock);

// --- 2. the gate precedes draft production (invariant apply / appendOutbound) ---
const relayIdx = publishBlock.indexOf("if (relayOnlyMarketplaceLead)");
const invariantIdx = publishBlock.indexOf("const invariant = applyAdfReplyInvariant(text)");
const appendIdx = publishBlock.indexOf("appendOutbound(conv");
const gateBeforeDraft = relayIdx >= 0 && invariantIdx > relayIdx && (appendIdx === -1 || appendIdx > relayIdx);

// --- 3. fail-direction: the intake block still creates the marketplace handoff todo + manual_handoff ---
const intakeStart = route.indexOf("if (relayOnlyMarketplaceLead) {");
const intakeBlock = intakeStart >= 0 ? route.slice(intakeStart, intakeStart + 2600) : "";
const intakeCreatesHandoff =
  /addTodo\(/.test(intakeBlock) &&
  /setFollowUpMode\(conv, "manual_handoff", "marketplace_relay"\)/.test(intakeBlock) &&
  /stopFollowUpCadence\(conv, "manual_handoff"\)/.test(intakeBlock);

// --- 4. Joe ruling 7/24: the task carries a ready-to-paste reply AND is owned by the lead owner ---
// (a) intake composes a first-touch reply and folds it into the todo summary (attached, paste-able)
const intakeAttachesReply =
  /buildMarketplaceRelayFirstTouchReply\(/.test(intakeBlock) &&
  /addTodo\(\s*conv,\s*"other",\s*buildMarketplaceRelayTaskSummary\(/s.test(intakeBlock);
// (b) the task is owned — addTodo receives the lead owner (and addTodo defaults to conv.leadOwner)
const intakePassesOwner = /conv\.leadOwner/.test(intakeBlock);
const addTodoDefaultsOwnerToLeadOwner =
  /owner\?\.id \?\? conv\?\.leadOwner\?\.id/.test(store) &&
  /owner\?\.name \?\? conv\?\.leadOwner\?\.name/.test(store);

// (c) functional: the composer returns warm, context-filled paste copy, and the summary wraps it
//     with a clear "reply in Facebook Marketplace" label — NOT a sendable draft.
const sampleReply = buildMarketplaceRelayFirstTouchReply({
  firstName: "Howard",
  agentName: "Scott",
  dealerName: "American Harley-Davidson",
  vehicleLabel: "2024 Street Glide"
});
const replyIsWarmContextFilled =
  sampleReply.length > 40 &&
  sampleReply.includes("Howard") &&
  sampleReply.includes("Scott") &&
  sampleReply.includes("American Harley-Davidson") &&
  sampleReply.includes("2024 Street Glide");
// graceful degradation: missing name/vehicle still yields a usable paste reply (never dropped)
const bareReply = buildMarketplaceRelayFirstTouchReply({ agentName: "", dealerName: "", vehicleLabel: "" });
const replyDegradesGracefully = bareReply.length > 40 && bareReply.includes("Thanks for reaching out");
const taskSummary = buildMarketplaceRelayTaskSummary(sampleReply);
const summaryEmbedsPasteReply =
  taskSummary.includes(sampleReply) &&
  /Facebook Marketplace/i.test(taskSummary) &&
  /copy-paste/i.test(taskSummary);

const checks: Check[] = [
  check("publish_gate_suppresses_relay_lead", publishGateSuppressesRelay, true),
  check("publish_gate_has_no_mode_escape", publishGateHasNoModeEscape, true),
  check("relay_gate_precedes_draft_production", gateBeforeDraft, true),
  check("intake_still_creates_marketplace_handoff", intakeCreatesHandoff, true),
  check("intake_attaches_ready_to_paste_reply", intakeAttachesReply, true),
  check("intake_passes_lead_owner", intakePassesOwner, true),
  check("add_todo_defaults_owner_to_lead_owner", addTodoDefaultsOwnerToLeadOwner, true),
  check("reply_is_warm_context_filled", replyIsWarmContextFilled, true),
  check("reply_degrades_gracefully", replyDegradesGracefully, true),
  check("task_summary_embeds_paste_reply", summaryEmbedsPasteReply, true)
];

const failures = checks.filter(c => JSON.stringify(c.actual) !== JSON.stringify(c.expected));
if (failures.length) {
  console.error("FAIL marketplace_relay_no_draft eval:");
  for (const f of failures) console.error(`  - ${f.id}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`);
  process.exit(1);
}
console.log(
  `PASS marketplace relay no-draft eval (${checks.length} assertions) — channel-less marketplace-relay leads get a handoff, never an undeliverable auto draft`
);
