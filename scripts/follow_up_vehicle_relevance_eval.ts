import { strict as assert } from "node:assert";
import fs from "node:fs";

/**
 * Follow-up vehicle-relevance eval — don't paste a lead-attached vehicle into a
 * follow-up task label when the lead is about something else (Jumpstart simulator,
 * MSF / rider course). Real case: Jenny Zavala, an ADF "Room58 - Book test ride"
 * lead that carried Vehicle: Harley-Davidson Breakout but whose inquiry was
 * "test out the experience before booking an msf class" — the callback task read
 * "Call customer to follow up on 2026 Breakout", a Breakout she never referenced.
 *
 * Pins the pure domain decision (leadVehicleRelevantToFollowUp /
 * isRiderExperienceOrEducationText) plus a source guard that deriveTodoActionLabel
 * actually gates the model interpolation on it. Deterministic; no LLM.
 */

const { leadVehicleRelevantToFollowUp, isRiderExperienceOrEducationText } = await import(
  "../services/api/src/domain/followUpVehicleRelevance.ts"
);

// --- isRiderExperienceOrEducationText unit cases ---
for (const yes of [
  "I would like to test out the experience before booking an msf class.",
  "yes, I'm looking to book a day/time to try the Jumpstart",
  "do you do the jump start before the riding academy?",
  "where can I take the rider course?",
  "interested in the learn to ride experience before I buy"
]) {
  assert.equal(isRiderExperienceOrEducationText(yes), true, `should flag experiential: "${yes}"`);
}
for (const no of [
  "Is the Street Glide still available?",
  "what's the out the door price on the 2026 Road Glide",
  "can I come test ride the Breakout this weekend",
  "",
  null
]) {
  assert.equal(isRiderExperienceOrEducationText(no as any), false, `should NOT flag: "${no}"`);
}

// --- leadVehicleRelevantToFollowUp on conversations ---
const jumpstartLead = {
  lead: {
    vehicle: { year: "2026", make: "Harley-Davidson", model: "Breakout" },
    inquiry: "I would like to test out the experience before booking an msf class.",
    source: "Room58 - Book test ride"
  },
  messages: [
    { direction: "in", body: "WEB LEAD (ADF) ... Vehicle: Harley-Davidson Breakout" },
    { direction: "out", body: "We offer the Harley-Davidson Jumpstart..." },
    { direction: "in", body: "yes, I'm looking to book a day/time to try the Jumpstart" }
  ]
};
assert.equal(
  leadVehicleRelevantToFollowUp(jumpstartLead),
  false,
  "Jumpstart/MSF lead: attached Breakout is NOT follow-up relevant"
);

const realSalesLead = {
  lead: {
    vehicle: { year: "2026", make: "Harley-Davidson", model: "Street Glide" },
    inquiry: "Is the Street Glide still available? What's the price?",
    source: "Room58 - Request a quote"
  },
  messages: [{ direction: "in", body: "Is the Street Glide still available?" }]
};
assert.equal(
  leadVehicleRelevantToFollowUp(realSalesLead),
  true,
  "genuine vehicle-shopping lead: model stays follow-up relevant (no regression)"
);

// A lead whose only signal is the forced "Book test ride" source (no experiential
// text) must NOT be suppressed — the source string alone is not an experiential cue.
assert.equal(
  leadVehicleRelevantToFollowUp({
    lead: { vehicle: { model: "Fat Boy" }, inquiry: "", source: "Room58 - Book test ride" },
    messages: [{ direction: "in", body: "can I see it this weekend" }]
  }),
  true,
  "forced book-test-ride source alone does not suppress the model"
);

// --- Source guard: deriveTodoActionLabel must gate the model line on relevance ---
const idx = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.ok(
  /if \(model && leadVehicleRelevantToFollowUp\(conv\)\)/.test(idx),
  "deriveTodoActionLabel must gate the vehicle follow-up label on leadVehicleRelevantToFollowUp"
);

console.log("follow_up_vehicle_relevance:eval ok");
