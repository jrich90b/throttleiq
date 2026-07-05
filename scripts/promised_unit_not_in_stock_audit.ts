/**
 * Promised-unit-not-in-stock audit — deterministic detector for the open-critic class where an
 * outbound over-promises a specific unit's availability ("I still have that Road Glide Limited
 * available for you to take for a test ride", "come in to go over the 2022 Heritage Classic") while
 * the lead has no pinned stock unit.
 *
 *   real run:  CONVERSATIONS_DB_PATH=/path/conversations.json npx tsx scripts/promised_unit_not_in_stock_audit.ts [--out FILE]
 *   self-test: npx tsx scripts/promised_unit_not_in_stock_audit.ts --self-test   (deterministic, for ci:eval)
 *
 * Read-only. Surfaces candidates for the loop to verify; the eventual hold/suppress guard reuses
 * leadHasPinnedSpecificUnit.
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {
  detectPromisedUnitNotInStock,
  leadHasPinnedSpecificUnit,
  assertsSpecificUnitAvailability
} from "../services/api/src/domain/promisedUnitAvailability.ts";

if (process.argv.includes("--self-test")) {
  // --- assertion detector: the two live phrasings flag; generic invites do NOT. ---
  assert.equal(
    assertsSpecificUnitAvailability("I still have that Road Glide Limited available for you to take for a test ride."),
    true,
    "‘still have that X available … test ride’ is a specific-unit assertion"
  );
  assert.equal(
    assertsSpecificUnitAvailability("Want to come in to go over the 2022 Heritage Classic this week?"),
    true,
    "‘come in to go over the X’ is a specific-unit assertion"
  );
  assert.equal(
    assertsSpecificUnitAvailability("Happy to line up a test ride whenever works for you — want me to grab a time?"),
    false,
    "a generic test-ride invite is NOT a specific-unit availability claim"
  );
  assert.equal(
    assertsSpecificUnitAvailability("Thanks for coming in! Let me know if you have any questions."),
    false,
    "an ordinary follow-up is not an assertion"
  );
  // Live false-positive classes (2026-06-28) that must NOT flag:
  assert.equal(
    assertsSpecificUnitAvailability("just checking back on the Street Glide. It looks like we still have one available for a test ride"),
    false,
    "HEDGED general availability (‘we still have ONE available’) is not a specific-unit claim"
  );
  assert.equal(
    assertsSpecificUnitAvailability("I received your credit approval! Would you like to come in to view the bike and go over the numbers?"),
    false,
    "‘come in … go over the NUMBERS’ is a finance invite, not a unit assertion"
  );
  assert.equal(
    assertsSpecificUnitAvailability("Customer: Thank you for calling American Harley Davidson. If you are calling for motorcycle sales, press one."),
    false,
    "a call-recording / IVR transcript is not an agent assertion"
  );

  // --- pinned-unit primitive. ---
  assert.equal(leadHasPinnedSpecificUnit({ lead: { vehicle: { stockId: "STK123" } } }), true, "a stock id is a pinned unit");
  assert.equal(leadHasPinnedSpecificUnit({ lead: { vehicle: { vin: "1HD..." } } }), true, "a VIN is a pinned unit");
  assert.equal(leadHasPinnedSpecificUnit({ hold: { stockId: "STK456" } }), true, "an active hold is a pinned unit");
  assert.equal(leadHasPinnedSpecificUnit({ recommendedUnits: [{ stockId: "STK789" }] }), true, "a recommended unit is pinned");
  assert.equal(
    leadHasPinnedSpecificUnit({ lead: { vehicle: { model: "Road Glide Limited", condition: "new_model_interest" } } }),
    false,
    "a bare model interest (no stock id/VIN) is NOT a pinned unit"
  );
  assert.equal(
    leadHasPinnedSpecificUnit({ lead: { vehicle: { model: "Heritage Classic", condition: "used" } } }),
    false,
    "a trade-target model with no stock id is NOT a pinned unit"
  );

  // --- end-to-end detector: the two live cases flag; pinned / generic do not. ---
  const cesar = detectPromisedUnitNotInStock({
    conv: { lead: { vehicle: { stockId: "", vin: "", condition: "new_model_interest" } } },
    outboundText: "Hey Cesare- Scott here. I still have that Road Glide Limited available for you to take for a test ride."
  });
  assert.ok(cesar?.flagged, "Cesar: specific-unit availability claim with no pinned unit => flagged");

  const jeff = detectPromisedUnitNotInStock({
    conv: { lead: { vehicle: { model: "Heritage Classic", year: "2022", condition: "used" } } },
    outboundText: "Want to come in to go over the 2022 Heritage Classic and talk trade numbers?"
  });
  assert.ok(jeff?.flagged, "Jeff: ‘come go over the X’ on a trade lead with no pinned unit => flagged");

  // NOT flagged: same assertion but a real pinned unit backs it.
  assert.equal(
    detectPromisedUnitNotInStock({
      conv: { lead: { vehicle: { stockId: "STK123", model: "Road Glide Limited" } } },
      outboundText: "I still have that Road Glide Limited available for a test ride."
    }),
    null,
    "a pinned stock unit backs the claim => not flagged"
  );
  // NOT flagged: generic invite, no pinned unit.
  assert.equal(
    detectPromisedUnitNotInStock({
      conv: { lead: { vehicle: { condition: "new_model_interest" } } },
      outboundText: "Happy to line up a test ride whenever works for you — want me to grab a time?"
    }),
    null,
    "a generic invite makes no specific-unit claim => not flagged"
  );

  console.log("PASS promised-unit-not-in-stock audit (self-test: assertion + pinned-unit + detector)");
  process.exit(0);
}

// --- real run ---
const convPath =
  process.env.CONVERSATIONS_DB_PATH ||
  (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "conversations.json") : "");
if (!convPath || !fs.existsSync(convPath)) {
  console.error("Set CONVERSATIONS_DB_PATH (or DATA_DIR) to the conversations.json to scan.");
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(convPath, "utf8"));
const conversations = Array.isArray(raw) ? raw : Array.isArray(raw?.conversations) ? raw.conversations : Object.values(raw);
const findings: Array<{ convId: string; excerpt: string }> = [];
for (const conv of conversations as any[]) {
  if (conv?.status === "closed") continue;
  const msgs = (conv?.messages ?? conv?.timeline ?? []).slice(-12);
  for (const m of msgs) {
    const dir = m?.direction ?? m?.role;
    if (dir !== "out" && dir !== "assistant" && dir !== "salesperson") continue;
    const found = detectPromisedUnitNotInStock({ conv, outboundText: m?.body ?? m?.text });
    if (found) {
      findings.push({ convId: String(conv?.id ?? conv?.leadKey ?? ""), excerpt: found.excerpt });
      break; // one per conversation
    }
  }
}
const lines = [
  `# Promised-unit-not-in-stock — ${findings.length} conversation(s) assert a specific unit's availability with no pinned stock unit`,
  `# Source: ${convPath}`,
  ""
];
for (const f of findings) lines.push(`## conv ${f.convId}\n  ${f.excerpt}\n`);
if (!findings.length) lines.push("(none)");
const out = lines.join("\n");
const outPath = process.env.PROMISED_UNIT_OUT || (process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "");
if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out + "\n", "utf8");
}
console.log(out);
