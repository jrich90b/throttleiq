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

// Trade Accelerator truncates the model mid-string, landing inside an open paren:
// "C50K8 Boulevard (Two-Tone)" arrives as "C50K8 Boulevard (Two". The dangling "(Two"
// was leaking straight into customer drafts (Laricuss Nelson, Ref 11466). We strip the
// unclosed parenthetical from BOTH the trade and the active vehicle.
const laricussTruncatedTradeAdf = `<?xml version="1.0" encoding="UTF-8"?>
<?adf version="1.0"?>
<adf>
 <prospect>
   <requestdate>2026-06-15T22:09:12+00:00</requestdate>
   <id sequence="1" source="Trade Accelerator">11466</id>
   <vehicle interest="buy" status="NEW">
     <year>2026</year>
     <make>HARLEY-DAVIDSON</make>
     <model>Road Glide (Spec</model>
     <vin></vin>
   </vehicle>
   <vehicle interest="trade-in">
     <year>2008</year>
     <make>SUZUKI</make>
     <model>C50K8 Boulevard (Two</model>
     <vin></vin>
     <odometer unit="MILES"></odometer>
   </vehicle>
   <customer>
     <contact>
       <name part="first">Laricuss</name>
       <name part="last">Nelson</name>
       <email>nelsonlaricuss@gmail.com</email>
       <phone type="cellphone">7162202658</phone>
       <comment><![CDATA[trade-in appraisal request]]></comment>
     </contact>
   </customer>
   <provider>
     <name part="full" type="individual">Trade Accelerator - Trade In</name>
   </provider>
 </prospect>
</adf>`;

// A COMPLETE parenthetical must be left untouched — only unclosed fragments are stripped.
const completeParenTradeAdf = `<?xml version="1.0" encoding="UTF-8"?>
<?adf version="1.0"?>
<adf>
 <prospect>
   <requestdate>2026-06-15T22:09:12+00:00</requestdate>
   <id sequence="1" source="Trade Accelerator">11467</id>
   <vehicle interest="buy" status="NEW">
     <year>2026</year>
     <make>HARLEY-DAVIDSON</make>
     <model>Road Glide</model>
     <vin></vin>
   </vehicle>
   <vehicle interest="trade-in">
     <year>2008</year>
     <make>SUZUKI</make>
     <model>Boulevard (Two-Tone)</model>
     <vin></vin>
   </vehicle>
   <customer>
     <contact>
       <name part="first">Test</name>
       <name part="last">Complete</name>
       <phone type="cellphone">7160000000</phone>
       <comment><![CDATA[trade-in appraisal request]]></comment>
     </contact>
   </customer>
 </prospect>
</adf>`;

// HDFS credit-application comment describes the vehicle being FINANCED ("Model Year: 2020, Model: Low
// Rider S"), not a trade-in — no sell/trade context markers anywhere in the comment. The bare "model
// year"/"model" labels used to leak through regardless, fabricating a tradeVehicle that was never in
// the source ADF (a Harley Financial Services credit app, Ref-equivalent case).
const hdfsCreditAppAdf = `<?xml version="1.0" encoding="UTF-8"?>
<?adf version="1.0"?>
<adf>
 <prospect>
   <requestdate>2026-06-29T15:00:00+00:00</requestdate>
   <id sequence="1" source="HDFS COA Online">11700</id>
   <vehicle interest="buy" status="NEW">
     <year>2020</year>
     <make>HARLEY-DAVIDSON</make>
     <model>Low Rider S</model>
     <vin></vin>
   </vehicle>
   <customer>
     <contact>
       <name part="first">Test</name>
       <name part="last">Applicant</name>
       <email>test.applicant@example.com</email>
       <phone type="cellphone">7160000001</phone>
       <comment><![CDATA[App ID: 1014003463, Model Year: 2020, Model: Low Rider S]]></comment>
     </contact>
   </customer>
   <provider>
     <name part="full" type="individual">HDFS COA Online</name>
   </provider>
 </prospect>
</adf>`;

const markLead = parseAdfXml(markNicholsTradeAcceleratorAdf);
const matthewLead = parseAdfXml(matthewWallValueMyTradeAdf);
const laricussLead = parseAdfXml(laricussTruncatedTradeAdf);
const completeParenLead = parseAdfXml(completeParenTradeAdf);
const hdfsCreditAppLead = parseAdfXml(hdfsCreditAppAdf);

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
  },
  // Dangling "(Two" stripped from the trade model + description (the leak into drafts)
  { id: "laricuss_trade_model_sanitized", actual: laricussLead.tradeVehicle?.model, expected: "C50K8 Boulevard" },
  {
    id: "laricuss_trade_desc_no_open_paren",
    actual: (laricussLead.tradeVehicle?.description ?? "").includes("("),
    expected: false
  },
  // Same strip applied to the active/buy vehicle model
  { id: "laricuss_buy_model_sanitized", actual: laricussLead.vehicleModel, expected: "Road Glide" },
  // Complete parenthetical preserved — only UNCLOSED fragments are stripped
  { id: "complete_paren_trade_model_preserved", actual: completeParenLead.tradeVehicle?.model, expected: "Boulevard (Two-Tone)" },
  // HDFS credit-app comment ("Model Year: 2020, Model: Low Rider S") describes the FINANCED vehicle, not
  // a trade-in — no sellVehicleFieldContext markers present, so no tradeVehicle should be fabricated.
  { id: "hdfs_credit_app_no_fabricated_trade", actual: hdfsCreditAppLead.tradeVehicle, expected: undefined },
  { id: "hdfs_credit_app_buy_model_intact", actual: hdfsCreditAppLead.vehicleModel, expected: "Low Rider S" }
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
