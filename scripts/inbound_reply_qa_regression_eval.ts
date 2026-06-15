import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const apiIndex = fs.readFileSync(path.join(repoRoot, "services/api/src/index.ts"), "utf8");
const adfRoute = fs.readFileSync(path.join(repoRoot, "services/api/src/routes/sendgridInbound.ts"), "utf8");
const inventoryFactAnswers = fs.readFileSync(
  path.join(repoRoot, "services/api/src/domain/inventoryFactAnswers.ts"),
  "utf8"
);
const shadowReplay = fs.readFileSync(path.join(repoRoot, "scripts/inbound_shadow_replay.ts"), "utf8");

const humanModeEligibilityStart = apiIndex.indexOf("const humanModeDispositionParserEligible =");
assert.ok(humanModeEligibilityStart >= 0, "human-mode disposition eligibility block should exist");
const humanModeEligibilityBlock = apiIndex.slice(humanModeEligibilityStart, humanModeEligibilityStart + 500);

assert.ok(
  !humanModeEligibilityBlock.includes("hasCustomerDispositionParserHintText(humanModeDispositionText)"),
  "human-mode disposition parser should use the same non-short-ack eligibility as the live path"
);

const initialPrefixStart = adfRoute.indexOf("const applyInitialAdfPrefix = async (text: string) => {");
assert.ok(initialPrefixStart >= 0, "initial ADF prefix helper should exist");
const initialPrefixBlock = adfRoute.slice(initialPrefixStart, initialPrefixStart + 1400);

assert.ok(
  initialPrefixBlock.includes("const prefixLeadProfile = activeAdfLeadProfile ?? conv.lead;"),
  "initial ADF prefix helper should prefer the active incoming ADF lead profile"
);
assert.ok(
  initialPrefixBlock.includes("normalizeDisplayCase(prefixLeadProfile?.firstName)"),
  "initial ADF prefix greeting should use the active ADF lead first name"
);
assert.ok(
  initialPrefixBlock.includes("String(prefixLeadProfile?.source ?? \"\").toLowerCase()"),
  "initial ADF prefix source handling should use the active ADF lead source"
);
assert.ok(
  initialPrefixBlock.includes("prefixLeadProfile?.vehicle?.model ?? prefixLeadProfile?.vehicle?.description ?? null"),
  "initial ADF prefix model label should use the active ADF vehicle context"
);

const vehicleInfoStart = adfRoute.indexOf("function buildInitialAdfVehicleInfoReply(args: {");
assert.ok(vehicleInfoStart >= 0, "initial ADF vehicle info helper should exist");
const vehicleInfoBlock = adfRoute.slice(vehicleInfoStart, vehicleInfoStart + 1200);
assert.ok(
  vehicleInfoBlock.includes("const scopedConv = scopeConversationToAdfLead(args.conv, args.lead);"),
  "initial ADF vehicle info helper should scope to the active ADF lead"
);
assert.ok(
  vehicleInfoBlock.includes("const vehicle = scopedConv?.lead?.vehicle ?? {};"),
  "initial ADF vehicle info helper should read vehicle context from the scoped ADF lead"
);
assert.ok(
  adfRoute.includes("lead: activeAdfLeadProfile,\n      decision: initialAdfVehicleInfoDecision"),
  "initial ADF vehicle info invocation should pass the active ADF lead profile"
);
assert.ok(
  adfRoute.includes("const followUpAdfVehicleInfoDecision =") &&
    adfRoute.includes("lead: activeAdfLeadProfile,\n      decision: followUpAdfVehicleInfoDecision"),
  "follow-up ADF vehicle info invocation should also pass the active ADF lead profile"
);
assert.ok(
  adfRoute.includes("const suppressInitialAdfVehicleInfoForTestRideIntent =") &&
    adfRoute.includes("!suppressInitialAdfVehicleInfoForTestRideIntent"),
  "initial ADF vehicle info fallback should not override explicit test-ride intent"
);
assert.ok(
  adfRoute.includes("const shouldForceExplicitInitialTestRideDraft =") &&
    adfRoute.includes("Thanks — I saw you’re interested in a test ride") &&
    adfRoute.includes("Yes — the ${modelLabel ?? \"bike\"} is available."),
  "initial test-ride ADF flow should rewrite stale specs fallbacks back to explicit availability/test-ride copy"
);

const locationReplyStart = adfRoute.indexOf("function buildInitialAdfDealerLocationReply(args: {");
assert.ok(locationReplyStart >= 0, "initial ADF dealer location helper should exist");
const locationReplyBlock = adfRoute.slice(locationReplyStart, locationReplyStart + 2200);
assert.ok(
  locationReplyBlock.includes("const scopedConv = scopeConversationToAdfLead(args.conv, args.lead);"),
  "initial ADF dealer location helper should scope to the active ADF lead"
);
assert.ok(
  locationReplyBlock.includes("const inventoryPrice = await findInventoryPrice({ stockId, vin, year, model });"),
  "initial ADF dealer location helper should look up current inventory price for combined location+price asks"
);
assert.ok(
  locationReplyBlock.includes("The current listed price"),
  "combined location+pricing ADF reply should provide listed-price wording when price data is available"
);
assert.ok(
  adfRoute.includes("draft = await buildInitialAdfDealerLocationReply({"),
  "initial ADF dealer location path should await the async combined location/pricing helper"
);
assert.ok(
  adfRoute.includes("lead: activeAdfLeadProfile,\n      dealerProfile,"),
  "initial ADF dealer location path should pass the active ADF lead profile"
);

assert.ok(
  apiIndex.includes("function shouldHandleManualQuoteDetailsReceived") &&
    apiIndex.includes("manualQuoteDetailSignalCount") &&
    apiIndex.includes("manual_quote_details_received"),
  "manual quote detail follow-up should have a narrow shared containment guard"
);
assert.ok(
  apiIndex.includes("buildManualQuoteDetailsReceivedReply()") &&
    apiIndex.includes("those quote details help"),
  "manual quote detail follow-up should acknowledge supplied details instead of restating list price"
);
assert.ok(
  adfRoute.includes("trafficLogOperationalDealProgressNote") &&
    adfRoute.includes("draft: suppressWalkInAutoAck || trafficLogOperationalDealProgressNote ? null : ack"),
  "TLP operational walk-in deal-progress notes should not return customer-facing draft text"
);
assert.ok(
  shadowReplay.includes("source:\\s*traffic log pro") &&
    shadowReplay.includes("dealer trade") &&
    shadowReplay.includes("return true;"),
  "shadow replay should treat operational TLP step notes as expected no-response when customer-facing publication is suppressed"
);
assert.ok(
  !inventoryFactAnswers.includes("published price in the inventory feed"),
  "pending-price customer wording should not expose inventory-feed internals"
);
assert.ok(
  adfRoute.includes("function syncInventoryContextToActiveAdfLead") &&
    adfRoute.includes("syncInventoryContextToActiveAdfLead(conv, activeAdfLeadProfile);"),
  "ADF inbound should sync inventory context to the active parsed lead before downstream reply selection"
);
assert.ok(
  apiIndex.includes("function isInventoryUnitClarificationQuestion") &&
    apiIndex.includes("function buildInventoryUnitClarificationReply") &&
    apiIndex.includes("inventory_unit_clarification_reply"),
  "Twilio inventory clarification turns should route through a shared clarification reply path for suggest/autopilot parity"
);
assert.ok(
  adfRoute.includes("if (followUpAdfVehicleFactDecision && !creditLeadContextBlocksVehicleInfo)") &&
    adfRoute.includes("const walkInCallbackContextText = [walkInCleanedComment, effectiveInquiry, event.body]") &&
    adfRoute.includes("const trafficLogWalkInCallbackContainmentText = ["),
  "ADF follow-up vehicle-fact replies should stay behind finance context, and walk-in callback detection should inspect combined inquiry text with an early containment guard"
);
assert.ok(
  adfRoute.includes("traffic_log_pro_walkin_callback_request") &&
    adfRoute.includes("walkInParserExplicitCallbackRequest") &&
    adfRoute.includes("hasWalkInCallbackStatusRequestText") &&
    adfRoute.includes("we\\s+get\\s+(?:it|the bike|the unit)") &&
    adfRoute.includes('note: "walk_in_callback_requested"'),
  "Walk-in ADF callback/status notes should route through parser-owned callback handling instead of the generic recap draft"
);
assert.ok(
  apiIndex.includes('regenParserExplicitCallbackRequest') &&
    apiIndex.includes("const regenWalkInCallbackText = [") &&
    apiIndex.includes('hasWalkInCallbackStatusRequestText') &&
    apiIndex.includes("we\\s+get\\s+(?:it|the bike|the unit)") &&
    apiIndex.includes('walk_in_callback_requested') &&
    apiIndex.includes('event.provider === "sendgrid_adf"'),
  "Regenerate should preserve no-draft callback handling for walk-in ADF callback/status notes"
);
assert.ok(
  adfRoute.includes("creditLeadContextBlocksVehicleInfo") &&
    adfRoute.includes("!creditLeadContextBlocksVehicleInfo"),
  "ADF vehicle-info fallback should stay behind active finance/credit-app context"
);
assert.ok(
  apiIndex.includes("const latestInboundCreditContext =") &&
    apiIndex.includes("if (mentionedUser && !latestInboundCreditContext"),
  "Credit-app regenerate flow should block salesperson-mention fact replies when finance handoff state is active"
);

assert.ok(
  apiIndex.includes('app.get("/mdf/portal-runner/install.sh", requireManager') &&
    apiIndex.includes('pathname.startsWith("/mdf/portal-runner/tasks")'),
  "MDF runner install.sh stays manager-gated and the public-path list is scoped to the machine /tasks endpoint (not the broad /mdf/portal-runner prefix, which would skip auth and 403 every manager)"
);

console.log("PASS inbound reply QA regression checks");
