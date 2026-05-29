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

const matthewWallValueMyTradeAdf = `<?xml version="1.0" encoding="UTF-8"?>
<?adf version="1.0"?>
<adf>
 <prospect>
   <requestdate>2026-05-28T20:45:31+00:00</requestdate>
   <id sequence="1" source="HD Marketplace">11324</id>
   <vehicle interest="sell" status="">
     <year></year>
     <make></make>
     <model></model>
     <stock></stock>
     <vin></vin>
   </vehicle>
   <customer>
     <contact>
       <name part="first">Matthew</name>
       <name part="last">Wall</name>
       <email>matthew@example.com</email>
       <phone type="cellphone">7166979159</phone>
       <comment><![CDATA[Lead Captured Date:2026-05-28 <br />
Event Name: Value My Trade <br />
VIN: <br />
Model: XL883C <br />
Make: HARLEY-DAVIDSON <br />
Year: 2008 <br />
Mileage: 13200 <br />
Condition: MINIMAL WEAR <br />
Price: $600 - $1600 <br />
Preferred Contact Method: Phone <br />
Options: OPEN <br />
Description: Would like to know what you could do for trade or cash.]]></comment>
     </contact>
   </customer>
   <provider>
     <name part="full" type="individual">Marketplace - Value My Trade</name>
   </provider>
 </prospect>
</adf>`;

const markLead = parseAdfXml(markNicholsTradeAcceleratorAdf);
const matthewLead = parseAdfXml(matthewWallValueMyTradeAdf);

const checks: Check[] = [
  { id: "mark_lead_ref", actual: markLead.leadRef, expected: "11310" },
  { id: "mark_active_buy_year", actual: markLead.year, expected: "2021" },
  { id: "mark_active_buy_model", actual: markLead.vehicleModel, expected: "Street Glide Special" },
  { id: "mark_active_buy_condition", actual: markLead.vehicleCondition, expected: "used" },
  { id: "mark_trade_year", actual: markLead.tradeVehicle?.year, expected: "2018" },
  { id: "mark_trade_model", actual: markLead.tradeVehicle?.model, expected: "FLHCS Heritage Class" },
  { id: "mark_customer_first", actual: markLead.firstName, expected: "Mark" },
  { id: "mark_customer_last", actual: markLead.lastName, expected: "Nichols" },
  { id: "matthew_lead_ref", actual: matthewLead.leadRef, expected: "11324" },
  { id: "matthew_trade_year", actual: matthewLead.tradeVehicle?.year, expected: "2008" },
  { id: "matthew_trade_make", actual: matthewLead.tradeVehicle?.make, expected: "Harley-Davidson" },
  { id: "matthew_trade_model", actual: matthewLead.tradeVehicle?.model, expected: "Xl883c" },
  { id: "matthew_trade_mileage", actual: matthewLead.tradeVehicle?.mileage, expected: 13200 },
  { id: "matthew_trade_condition", actual: matthewLead.tradeVehicle?.condition, expected: "used" },
  { id: "matthew_sell_option", actual: matthewLead.sellOption, expected: "either" },
  { id: "matthew_preferred_contact", actual: matthewLead.preferredContactMethod, expected: "phone" },
  {
    id: "matthew_primary_not_metadata_year",
    actual: matthewLead.year === "2026" ? "2026" : "not_2026",
    expected: "not_2026"
  }
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

const combinedActiveSubject = `${markLead.year ?? ""} ${markLead.vehicleModel ?? ""}`.toLowerCase();
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
