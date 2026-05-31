import { strict as assert } from "node:assert";
import { extractRecentVehicleDiscussionFacts } from "../services/api/src/domain/recentVehicleDiscussion.ts";

function main() {
  const adfOnly = extractRecentVehicleDiscussionFacts({
    messages: [
      {
        provider: "sendgrid_adf",
        body: "WEB LEAD (ADF)\nYear: 2022\nVehicle: Harley-Davidson Street Glide Special\nInquiry: year and mileage?"
      }
    ]
  });
  assert.equal(adfOnly, null);

  const withVoice = extractRecentVehicleDiscussionFacts({
    messages: [
      {
        provider: "sendgrid_adf",
        body: "WEB LEAD (ADF)\nYear: 2022\nVehicle: Harley-Davidson Street Glide Special\nInquiry: year and mileage?"
      },
      {
        provider: "voice_summary",
        body: "Customer is looking at a 2021 Street Glide Special with about 10,300 miles. They asked for year and mileage."
      }
    ]
  });
  assert.equal(withVoice?.year, "2021");
  assert.equal(withVoice?.model, "Street Glide Special");
  assert.equal(withVoice?.mileage, "10,300 miles");

  console.log("All recent vehicle discussion checks passed.");
}

main();

