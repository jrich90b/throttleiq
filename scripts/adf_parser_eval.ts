import { parseAdfXml } from "../services/api/src/domain/adfParser.ts";

type Check = {
  id: string;
  actual: unknown;
  expected: unknown;
};

const markNicholsTradeAcceleratorAdf = `<?xml version="1.0" encoding="UTF-8"?>
<?adf version="1.0"?>
<adf>
 <prospect>
   <requestdate>2026-05-27T18:35:40+00:00</requestdate>
   <id sequence="1" source="Traffic Log Pro">11310</id>
   <vehicle interest="buy" status="USED">
     <year>2021</year>
     <make>HARLEY-DAVIDSON</make>
     <model>Street Glide Special</model>
     <stock></stock>
     <vin></vin>
     <price currency="USD">0.00</price>
   </vehicle>
   <vehicle interest="trade-in">
     <year>2018</year>
     <make>HARLEY-DAVIDSON</make>
     <model>FLHCS Heritage Class</model>
     <vin></vin>
     <odometer unit="MILES"></odometer>
   </vehicle>
   <customer>
     <contact>
       <name part="first">Mark</name>
       <name part="last">Nichols</name>
       <email>Mainpoint22@gmail.com</email>
       <phone type="cellphone">5852976349</phone>
       <comment><![CDATA[Pre-Inspection Trade-In Value Estimate <br />
Rough Trade In Wholesale: $7,925 <br />
Clean Trade In Wholesale: $9,295 <br />
Average Retail: $11,915 <br />
Suggested List Price: $21,249 <br />
Prices Shown to Customer <br />
Rough Trade In Wholesale: $7,925 <br />
Clean Trade In Wholesale: $9,295 <br />
<br />
Event Name: PowerSports TV Trade In <br />
///Customer Information/// <br />
Language: EN <br />
<br />
///Opt-In/// <br />
Email Opt-In: Yes  <br />
Phone Opt-In: Yes <br />
Mail Opt-In: Yes]]></comment>
     </contact>
   </customer>
   <provider>
     <name part="full" type="individual">Trade Accelerator - Trade In</name>
   </provider>
 </prospect>
</adf>`;

const lead = parseAdfXml(markNicholsTradeAcceleratorAdf);

const checks: Check[] = [
  { id: "lead_ref", actual: lead.leadRef, expected: "11310" },
  { id: "active_buy_year", actual: lead.year, expected: "2021" },
  { id: "active_buy_model", actual: lead.vehicleModel, expected: "Street Glide Special" },
  { id: "active_buy_condition", actual: lead.vehicleCondition, expected: "used" },
  { id: "trade_year", actual: lead.tradeVehicle?.year, expected: "2018" },
  { id: "trade_model", actual: lead.tradeVehicle?.model, expected: "FLHCS Heritage Class" },
  { id: "customer_first", actual: lead.firstName, expected: "Mark" },
  { id: "customer_last", actual: lead.lastName, expected: "Nichols" }
];

let passed = 0;
for (const check of checks) {
  const ok = JSON.stringify(check.actual) === JSON.stringify(check.expected);
  if (ok) passed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${check.id} expected=${JSON.stringify(check.expected)} actual=${JSON.stringify(
      check.actual
    )}`
  );
}

const combinedActiveSubject = `${lead.year ?? ""} ${lead.vehicleModel ?? ""}`.toLowerCase();
if (combinedActiveSubject.includes("2016") || combinedActiveSubject.includes("ultra limited")) {
  console.log(`FAIL active_subject_not_prior_private_seller actual=${JSON.stringify(combinedActiveSubject)}`);
} else {
  passed += 1;
  console.log("PASS active_subject_not_prior_private_seller");
}

const total = checks.length + 1;
if (passed !== total) {
  console.error(`\n${total - passed} failures out of ${total} ADF parser checks`);
  process.exit(1);
}

console.log(`\nAll ${total} ADF parser checks passed.`);
