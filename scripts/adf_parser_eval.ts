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

// HD.com "Request a Quote" carries the contact preference as a concatenated camelCase field
// inside Customer Comments ("PreferredMethodOfContact - text(sms)"), NOT the spaced
// "Preferred method of contact - " variant. The `\s+`-only label regex missed it, so
// preferredContactMethod came back undefined (Taliea Lloyd 2026-07-13).
const talieaQuoteRequestAdf = `<?xml version="1.0" encoding="UTF-8"?>
<?adf version="1.0"?>
<adf>
 <prospect>
   <requestdate>2026-07-13T18:15:51+00:00</requestdate>
   <id sequence="1" source="HD.com Request a Quote">11622</id>
   <vehicle interest="buy" status="NEW">
     <year>2025</year>
     <make>HARLEY-DAVIDSON</make>
     <model>Low Rider ST</model>
     <vin></vin>
   </vehicle>
   <customer>
     <contact>
       <name part="first">Taliea</name>
       <name part="last">Lloyd</name>
       <email>taliealloyd0721@gmail.com</email>
       <phone type="cellphone">7165366889</phone>
       <comment><![CDATA[Customer Comments: PreferredMethodOfContact - text(sms), InterestedInCustomizingMotorcycle - yes, CustomizeOptions - customizeAudio, customize-Fit-]]></comment>
     </contact>
   </customer>
   <provider>
     <name part="full" type="individual">HD.com Request a Quote</name>
   </provider>
 </prospect>
</adf>`;

// Joe, 2026-07-15: a sell/trade lead whose ONLY <vehicle> is the customer's OWN bike
// (interest="trade-in" / "sell") was landing as the motorcycle of interest. The single
// trade/sell-tagged vehicle must go to tradeVehicle and leave the interest fields EMPTY.
const tradeOnlySingleVehicleAdf = `<?xml version="1.0" encoding="UTF-8"?>
<?adf version="1.0"?>
<adf>
 <prospect>
   <requestdate>2026-07-15T14:00:00+00:00</requestdate>
   <id sequence="1" source="Traffic Log Pro">11702</id>
   <vehicle interest="trade-in" status="USED">
     <year>2019</year>
     <make>HARLEY-DAVIDSON</make>
     <model>Road King Special</model>
     <vin></vin>
     <odometer unit="MILES">12000</odometer>
   </vehicle>
   <customer>
     <contact>
       <name part="first">Casey</name>
       <name part="last">Traderman</name>
       <phone type="cellphone">7165551234</phone>
     </contact>
   </customer>
   <provider>
     <name part="full" type="individual">Trade Accelerator - Trade In</name>
   </provider>
 </prospect>
</adf>`;

const sellOnlySingleVehicleAdf = tradeOnlySingleVehicleAdf
  .replace('interest="trade-in"', 'interest="sell"')
  .replace("Road King Special", "Fat Bob 114")
  .replace("<year>2019</year>", "<year>2020</year>");

// Room58 "Request details" / "Book test ride" forms auto-populate the structured trade-in vehicle
// with the SAME model the customer is asking about — a form-mapping artifact, not a reported trade.
// Beth Bremer (Ref 11449, 2026-06-13): Vehicle "FXD Super Glide" / Trade-In "Super Glide", and her
// actual typed question ("I'm a smaller female... is the super glide a good option?") got answered
// with "Thanks for using our trade-in estimator on your Super Glide". A human rescued the live
// thread; the 2026-07-31 replay sweep reproduces the bad draft as a `critical`.
const room58MirroredTradeAdf = `<?xml version="1.0" encoding="UTF-8"?>
<?adf version="1.0"?>
<adf>
 <prospect>
   <requestdate>2026-06-13T05:50:27+00:00</requestdate>
   <id sequence="1" source="Room58 - Request details">11449</id>
   <vehicle interest="buy" status="NEW">
     <year>2026</year>
     <make>HARLEY-DAVIDSON</make>
     <model>FXD Super Glide</model>
     <vin></vin>
   </vehicle>
   <vehicle interest="trade-in">
     <make>HARLEY-DAVIDSON</make>
     <model>Super Glide</model>
     <vin></vin>
     <odometer unit="MILES"></odometer>
   </vehicle>
   <customer>
     <contact>
       <name part="first">Beth</name>
       <name part="last">Bremer</name>
       <email>beth.bremer@gmail.com</email>
       <phone type="cellphone">3088830093</phone>
       <comment><![CDATA[I sold my sportster several years back am interested in buying something that can travel a little bit further. I'm a smaller female and don't want a big cruiser, but am interested in something a little more long range than a sportster. Is the super glide a good option?]]></comment>
     </contact>
   </customer>
 </prospect>
</adf>`;

// Same mirror shape on a "Book test ride" form (Sanjeev Goms, Ref 11546) — the trade field mirrors
// with sloppy whitespace ("Sportster  S" vs "Sportster S"), which must still read as a mirror.
const room58MirroredTradeTestRideAdf = room58MirroredTradeAdf
  .replace("Room58 - Request details", "Room58 - Book test ride")
  .replace("<model>FXD Super Glide</model>", "<model>Sportster S</model>")
  .replace("<model>Super Glide</model>", "<model>Sportster  S</model>")
  .replace(/<comment>[\s\S]*<\/comment>/, "<comment><![CDATA[Test ride request for Sportster S. Preferred date: 29/6/2026. Preferred time: 12 pm.]]></comment>");

// FALSE-POSITIVE GUARD 1: a REAL trade that happens to name the same model keeps its own year, so
// it carries independent identity and must survive (trading a 2015 Iron 883 toward a 2022 Iron 883).
const sameModelRealTradeAdf = `<?xml version="1.0" encoding="UTF-8"?>
<?adf version="1.0"?>
<adf>
 <prospect>
   <requestdate>2026-06-20T12:00:00+00:00</requestdate>
   <id sequence="1" source="Room58 - Request details">11500</id>
   <vehicle interest="buy" status="USED">
     <year>2022</year>
     <make>HARLEY-DAVIDSON</make>
     <model>Iron 883</model>
   </vehicle>
   <vehicle interest="trade-in">
     <year>2015</year>
     <make>HARLEY-DAVIDSON</make>
     <model>Iron 883</model>
     <odometer unit="MILES">18000</odometer>
   </vehicle>
   <customer>
     <contact>
       <name part="first">Dale</name>
       <phone type="cellphone">7165550101</phone>
     </contact>
   </customer>
 </prospect>
</adf>`;

// FALSE-POSITIVE GUARD 2: the customer TYPED that they want to trade. Even with a bare mirrored
// field, their own words win and the trade stays (Dante Turello shape: "...I'd be looking to
// trade in as well").
const mirroredFieldButCustomerSaidTradeAdf = room58MirroredTradeAdf.replace(
  /<comment>[\s\S]*<\/comment>/,
  "<comment><![CDATA[Interested in the Super Glide, and I'd be looking to trade in my current bike as well.]]></comment>"
);

const markLead = parseAdfXml(markNicholsTradeAcceleratorAdf);
const room58MirrorLead = parseAdfXml(room58MirroredTradeAdf);
const room58MirrorTestRideLead = parseAdfXml(room58MirroredTradeTestRideAdf);
const sameModelRealTradeLead = parseAdfXml(sameModelRealTradeAdf);
const mirroredButSaidTradeLead = parseAdfXml(mirroredFieldButCustomerSaidTradeAdf);
const tradeOnlyLead = parseAdfXml(tradeOnlySingleVehicleAdf);
const sellOnlyLead = parseAdfXml(sellOnlySingleVehicleAdf);
const matthewLead = parseAdfXml(matthewWallValueMyTradeAdf);
const laricussLead = parseAdfXml(laricussTruncatedTradeAdf);
const completeParenLead = parseAdfXml(completeParenTradeAdf);
const hdfsCreditAppLead = parseAdfXml(hdfsCreditAppAdf);
const talieaLead = parseAdfXml(talieaQuoteRequestAdf);

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
  { id: "taliea_camelcase_preferred_contact", actual: talieaLead.preferredContactMethod, expected: "sms" },
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
  { id: "hdfs_credit_app_buy_model_intact", actual: hdfsCreditAppLead.vehicleModel, expected: "Low Rider S" },
  // Single trade-in-tagged vehicle: NOT the motorcycle of interest; lands in tradeVehicle.
  { id: "trade_only_no_interest_model", actual: tradeOnlyLead.vehicleModel, expected: undefined },
  { id: "trade_only_no_interest_year", actual: tradeOnlyLead.year, expected: undefined },
  { id: "trade_only_trade_model", actual: tradeOnlyLead.tradeVehicle?.model, expected: "Road King Special" },
  { id: "trade_only_trade_year", actual: tradeOnlyLead.tradeVehicle?.year, expected: "2019" },
  // interest="sell" behaves the same as trade-in.
  { id: "sell_only_no_interest_model", actual: sellOnlyLead.vehicleModel, expected: undefined },
  { id: "sell_only_trade_model", actual: sellOnlyLead.tradeVehicle?.model, expected: "Fat Bob 114" },
  { id: "sell_only_trade_year", actual: sellOnlyLead.tradeVehicle?.year, expected: "2020" },
  // Room58 form mirror: the phantom trade is dropped, and the bike of interest is untouched so the
  // first touch can answer the question the customer actually typed.
  { id: "room58_mirror_drops_phantom_trade", actual: room58MirrorLead.tradeVehicle, expected: undefined },
  { id: "room58_mirror_keeps_interest_model", actual: room58MirrorLead.vehicleModel, expected: "FXD Super Glide" },
  { id: "room58_mirror_keeps_interest_year", actual: room58MirrorLead.year, expected: "2026" },
  {
    id: "room58_mirror_keeps_customer_question",
    actual: (room58MirrorLead.comment ?? "").toLowerCase().includes("is the super glide a good option"),
    expected: true
  },
  // Whitespace-sloppy mirror on a test-ride form is still a mirror.
  {
    id: "room58_mirror_test_ride_drops_phantom_trade",
    actual: room58MirrorTestRideLead.tradeVehicle,
    expected: undefined
  },
  {
    id: "room58_mirror_test_ride_keeps_interest_model",
    actual: room58MirrorTestRideLead.vehicleModel,
    expected: "Sportster S"
  },
  // A real same-model trade carries its own year/mileage — never dropped.
  { id: "same_model_real_trade_kept", actual: sameModelRealTradeLead.tradeVehicle?.model, expected: "Iron 883" },
  { id: "same_model_real_trade_year_kept", actual: sameModelRealTradeLead.tradeVehicle?.year, expected: "2015" },
  { id: "same_model_real_trade_interest_year", actual: sameModelRealTradeLead.year, expected: "2022" },
  // The customer's own words beat the form mapping — bare mirror, but they said "trade in".
  {
    id: "mirrored_field_but_customer_said_trade_kept",
    actual: mirroredButSaidTradeLead.tradeVehicle?.model,
    expected: "Super Glide"
  },
  // A DISTINCT structured trade is untouched by the mirror guard (regression pin on the
  // long-standing Trade Accelerator shape).
  { id: "distinct_trade_unaffected_by_mirror_guard", actual: markLead.tradeVehicle?.model, expected: "FLHCS Heritage Class" }
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
