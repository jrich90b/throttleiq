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
 *  3. Fail-direction: the intake block still creates the "reply in the marketplace inbox" handoff todo
 *     + manual_handoff — suppression never means "dropped".
 */
import fs from "node:fs";
import path from "node:path";

type Check = { id: string; actual: unknown; expected: unknown };
const check = (id: string, actual: unknown, expected: unknown): Check => ({ id, actual, expected });

const route = fs.readFileSync(path.join(process.cwd(), "services/api/src/routes/sendgridInbound.ts"), "utf8");

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
const intakeBlock = intakeStart >= 0 ? route.slice(intakeStart, intakeStart + 700) : "";
const intakeCreatesHandoff =
  intakeBlock.includes("reply in the marketplace inbox") &&
  /setFollowUpMode\(conv, "manual_handoff", "marketplace_relay"\)/.test(intakeBlock) &&
  /stopFollowUpCadence\(conv, "manual_handoff"\)/.test(intakeBlock);

const checks: Check[] = [
  check("publish_gate_suppresses_relay_lead", publishGateSuppressesRelay, true),
  check("publish_gate_has_no_mode_escape", publishGateHasNoModeEscape, true),
  check("relay_gate_precedes_draft_production", gateBeforeDraft, true),
  check("intake_still_creates_marketplace_handoff", intakeCreatesHandoff, true)
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
