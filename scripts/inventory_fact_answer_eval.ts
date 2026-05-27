import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "inventory-fact-answer-"));
  process.env.DATA_DIR = tmp;
  process.env.INVENTORY_XML_URL = "http://127.0.0.1:9/inventory.xml";
  process.env.INVENTORY_FETCH_TIMEOUT_MS = "1";
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (String(args[0] ?? "").includes("[inventory-feed] fetch error")) return;
    warn(...args);
  };

  await fs.writeFile(
    path.join(tmp, "inventory_snapshot.json"),
    JSON.stringify(
      {
        items: [
          {
            key: "t36-25",
            stockId: "T36-25",
            vin: "1HD1KB716SB633746",
            year: "2025",
            make: "Harley-Davidson",
            model: "Street Glide",
            color: "Brilliant Red",
            condition: "new"
          }
        ]
      },
      null,
      2
    )
  );
  await fs.writeFile(
    path.join(tmp, "inventory_notes.json"),
    JSON.stringify(
      {
        notes: {
          "t36-25": {
            notes: [
              {
                id: "note_finance",
                label: "Financing Special",
                note: "Financing as low as 2.99%",
                updatedAt: "2026-05-21T23:54:02.048Z",
                expiresAt: "2026-06-30"
              }
            ],
            updatedAt: "2026-05-21T23:54:02.048Z"
          }
        }
      },
      null,
      2
    )
  );

  const { buildInventoryBackedVehicleFactAnswer } = await import(
    "../services/api/src/domain/inventoryFactAnswers.ts"
  );
  const conv = {
    lead: {
      vehicle: {
        year: "2025",
        model: "Street Glide",
        stockId: "T36-25",
        vin: "1HD1KB716SB633746",
        condition: "new"
      }
    },
    messages: []
  };

  const combined = await buildInventoryBackedVehicleFactAnswer({
    conv,
    decision: { questionType: "price", requestedFields: ["price"] },
    text: "What is the price and does this bike qualify for low interest?"
  });
  assert.equal(combined.handled, true);
  assert.match(combined.reply ?? "", /Financing Special/i);
  assert.match(combined.reply ?? "", /2\.99%/);
  assert.match(combined.reply ?? "", /published price/i);
  assert.match(combined.todoSummary ?? "", /Confirm price and final finance eligibility/i);

  const capped = await buildInventoryBackedVehicleFactAnswer({
    conv,
    decision: { questionType: "finance_program_eligibility", requestedFields: ["finance_program_eligibility", "price_cap"] },
    text: "Does this bike qualify for 2.99 interest under 25000?"
  });
  assert.equal(capped.handled, true);
  assert.match(capped.reply ?? "", /2\.99%/);
  assert.match(capped.reply ?? "", /under-\$25,000/i);

  const priceOnly = await buildInventoryBackedVehicleFactAnswer({
    conv,
    decision: { questionType: "price", requestedFields: ["price"] },
    text: "What is the price?"
  });
  assert.equal(priceOnly.handled, true);
  assert.doesNotMatch(priceOnly.reply ?? "", /2\.99%|Financing Special/i);
  assert.match(priceOnly.reply ?? "", /published price/i);

  const staleLatestLeadConv = {
    latestLead: {
      vehicle: {
        year: "2016",
        model: "Ultra Limited Peace Officer / Firefighter / Shrine Special Edition",
        condition: "used"
      }
    },
    lead: {
      vehicle: {
        year: "2021",
        model: "Street Glide Special",
        condition: "used"
      }
    },
    messages: []
  };
  const activeAdfLead = {
    vehicle: {
      year: "2021",
      model: "Street Glide Special",
      condition: "used"
    }
  };
  const activeLeadPrice = await buildInventoryBackedVehicleFactAnswer({
    conv: staleLatestLeadConv,
    lead: activeAdfLead,
    decision: { questionType: "price", requestedFields: ["price"] },
    text: "trade-in appraisal request"
  });
  assert.equal(activeLeadPrice.handled, true);
  assert.match(activeLeadPrice.reply ?? "", /2021 Street Glide Special/i);
  assert.doesNotMatch(activeLeadPrice.reply ?? "", /2016|Ultra Limited/i);

  console.log("All 4 inventory fact answer checks passed.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
