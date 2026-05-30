import {
  extractAdfXmlFromEmail,
  parseAdfXml,
  type ParsedAdfLead
} from "../services/api/src/domain/adfParser.ts";
import { resolveLeadRule } from "../services/api/src/domain/leadSourceRules.ts";

type FieldCheck = {
  id: string;
  actual: unknown;
  expected: unknown;
};

type LeadSmokeCase = {
  id: string;
  source: string;
  sourceId?: number;
  xml: string;
  checks: (lead: ParsedAdfLead) => FieldCheck[];
};

function adf({
  source,
  leadRef,
  provider,
  vehicles,
  first = "Alex",
  last = "Customer",
  email = "alex.customer@example.com",
  phone = "7165550100",
  comment,
  city = "North Tonawanda",
  region = "NY",
  postal = "14120"
}: {
  source: string;
  leadRef: string;
  provider: string;
  vehicles?: string;
  first?: string;
  last?: string;
  email?: string;
  phone?: string;
  comment?: string;
  city?: string;
  region?: string;
  postal?: string;
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<?adf version="1.0"?>
<adf>
  <prospect>
    <requestdate>2026-05-30T12:00:00+00:00</requestdate>
    <id sequence="1" source="${source}">${leadRef}</id>
    ${
      vehicles ??
      `<vehicle interest="buy" status="USED">
        <year>2025</year>
        <make>HARLEY-DAVIDSON</make>
        <model>Street Bob</model>
        <stock>U123-25</stock>
        <vin>1HD1ABC10PB123456</vin>
      </vehicle>`
    }
    <customer>
      <contact>
        <name part="first">${first}</name>
        <name part="last">${last}</name>
        <email>${email}</email>
        <phone type="cellphone">${phone}</phone>
        <address>
          <city>${city}</city>
          <regioncode>${region}</regioncode>
          <postalcode>${postal}</postalcode>
        </address>
        ${comment ? `<comment><![CDATA[${comment}]]></comment>` : ""}
      </contact>
    </customer>
    <provider>
      <name part="full" type="individual">${provider}</name>
    </provider>
  </prospect>
</adf>`;
}

function check(id: string, actual: unknown, expected: unknown): FieldCheck {
  return { id, actual, expected };
}

function checkIncludes(id: string, actual: unknown, expectedFragment: string): FieldCheck {
  const normalized = String(actual ?? "").toLowerCase();
  return {
    id,
    actual: normalized.includes(expectedFragment.toLowerCase()),
    expected: true
  };
}

function expectRule(id: string, source: string, sourceId: number | undefined, bucket: string, cta: string) {
  const rule = resolveLeadRule(source, sourceId);
  return [
    check(`${id}_rule_bucket`, rule.bucket, bucket),
    check(`${id}_rule_cta`, rule.cta, cta)
  ];
}

const cases: LeadSmokeCase[] = [
  {
    id: "room58_request_details_inventory",
    source: "Room58 - Request Details",
    xml: adf({
      source: "Room58 - Request Details",
      leadRef: "90001",
      provider: "Room58 - Request Details",
      vehicles: `<vehicle interest="buy" status="USED">
        <year></year>
        <make></make>
        <model>Full Line</model>
        <stock></stock>
        <vin></vin>
      </vehicle>`,
      first: "Lauren",
      last: "Barron",
      phone: "2564812665",
      email: "lauren@example.com",
      comment: `Inventory Item: Harley-Davidson Ultra Limited 2022 FLHTK U876-22 Vivid Black <br />
Inventory Year: 2022 <br />
Inventory Stock ID: U876-22 <br />
VIN: 1HD1KNF12NB614098 <br />
Your inquiry: price? <br />
Can we contact you via email?: Yes <br />
Can we contact you via phone?: Yes <br />
Can we contact you via text?: Yes`
    }),
    checks: lead => [
      check("lead_ref", lead.leadRef, "90001"),
      check("first_name", lead.firstName, "Lauren"),
      check("phone", lead.phone, "2564812665"),
      check("year", lead.year, "2022"),
      check("stock", lead.stockId, "U876-22"),
      check("vin", lead.vin, "1HD1KNF12NB614098"),
      check("model_from_inventory_item", lead.vehicleModel, "Full Line"),
      check("color", lead.vehicleColor, "Vivid Black"),
      check("inquiry", lead.inquiry, "price?"),
      check("email_opt_in", lead.emailOptIn, true),
      check("phone_opt_in", lead.phoneOptIn, true),
      check("sms_opt_in", lead.smsOptIn, true)
    ]
  },
  {
    id: "marketplace_contact_dealer_inventory",
    source: "Marketplace - Contact a Dealer",
    xml: adf({
      source: "Marketplace - Contact a Dealer",
      leadRef: "90002",
      provider: "Marketplace - Contact a Dealer",
      first: "Marcus",
      last: "Reed",
      phone: "7165550202",
      email: "marcus@example.com",
      vehicles: `<vehicle interest="buy" status="NEW">
        <year>2025</year>
        <make>HARLEY-DAVIDSON</make>
        <model>Road Glide</model>
        <stock>N425-25</stock>
        <vin>1HD1MAL10SB425000</vin>
        <colorcombination><exteriorcolor>Billiard Gray</exteriorcolor></colorcombination>
      </vehicle>`,
      comment: `Lead Captured Date: 2026-05-30 <br />
Your inquiry: Is this still available? <br />
Preferred contact method: SMS <br />
Email Opt-In: Yes <br />
Phone Opt-In: Yes`
    }),
    checks: lead => [
      check("lead_ref", lead.leadRef, "90002"),
      check("condition", lead.vehicleCondition, "new"),
      check("year", lead.year, "2025"),
      check("make", lead.vehicleMake, "Harley-Davidson"),
      check("model", lead.vehicleModel, "Road Glide"),
      check("stock", lead.stockId, "N425-25"),
      check("preferred_contact", lead.preferredContactMethod, "sms"),
      check("inquiry", lead.inquiry, "Is this still available?"),
      ...expectRule("marketplace_contact_dealer_inventory", "Marketplace - Contact a Dealer", undefined, "inventory_interest", "check_availability")
    ]
  },
  {
    id: "marketplace_value_my_trade",
    source: "Marketplace - Value My Trade",
    xml: adf({
      source: "HD Marketplace",
      leadRef: "90003",
      provider: "Marketplace - Value My Trade",
      first: "Matthew",
      last: "Wall",
      phone: "7166979159",
      email: "matthew@example.com",
      vehicles: `<vehicle interest="sell" status="">
        <year></year>
        <make></make>
        <model></model>
        <stock></stock>
        <vin></vin>
      </vehicle>`,
      comment: `Lead Captured Date: 2026-05-30 <br />
Event Name: Value My Trade <br />
VIN: 1HD4CR2128K123456 <br />
Model: XL883C <br />
Make: HARLEY-DAVIDSON <br />
Year: 2008 <br />
Mileage: 13,200 <br />
Condition: MINIMAL WEAR <br />
Preferred Contact Method: Phone <br />
Options: OPEN <br />
Description: Would like to know what you could do for trade or cash.`
    }),
    checks: lead => [
      check("lead_ref", lead.leadRef, "90003"),
      check("preferred_contact", lead.preferredContactMethod, "phone"),
      check("sell_option", lead.sellOption, "either"),
      check("trade_year", lead.tradeVehicle?.year, "2008"),
      check("trade_make", lead.tradeVehicle?.make, "Harley-Davidson"),
      check("trade_model", lead.tradeVehicle?.model, "Xl883c"),
      check("trade_mileage", lead.tradeVehicle?.mileage, 13200),
      check("trade_condition", lead.tradeVehicle?.condition, "used"),
      ...expectRule("marketplace_value_my_trade", "Marketplace - Value My Trade", undefined, "trade_in_sell", "value_my_trade")
    ]
  },
  {
    id: "marketplace_sell_my_bike",
    source: "Marketplace - Sell My Bike",
    xml: adf({
      source: "HD Marketplace",
      leadRef: "90004",
      provider: "Marketplace - Sell My Bike",
      first: "Nate",
      last: "Seller",
      phone: "7165550404",
      email: "nate@example.com",
      vehicles: `<vehicle interest="sell" status="">
        <year></year>
        <make></make>
        <model></model>
      </vehicle>`,
      comment: `Event Name: Sell My Bike <br />
Year: 2017 <br />
Make: Harley-Davidson <br />
Model: Street Glide Special <br />
Mileage: 22000 <br />
Trade Options: sell outright for cash <br />
Preferred method of contact - email`
    }),
    checks: lead => [
      check("lead_ref", lead.leadRef, "90004"),
      check("preferred_contact_variant", lead.preferredContactMethod, "email"),
      check("sell_option", lead.sellOption, "cash"),
      check("trade_year", lead.tradeVehicle?.year, "2017"),
      check("trade_model", lead.tradeVehicle?.model, "Street Glide Special"),
      check("trade_mileage", lead.tradeVehicle?.mileage, 22000),
      ...expectRule("marketplace_sell_my_bike", "Marketplace - Sell My Bike", undefined, "trade_in_sell", "sell_my_bike")
    ]
  },
  {
    id: "traffic_log_pro_buy_plus_trade_update",
    source: "Traffic Log Pro",
    xml: adf({
      source: "Traffic Log Pro",
      leadRef: "90005",
      provider: "Trade Accelerator - Trade In",
      first: "Mark",
      last: "Nichols",
      phone: "5852976349",
      email: "mark@example.com",
      vehicles: `<vehicle interest="buy" status="USED">
        <year>2021</year>
        <make>HARLEY-DAVIDSON</make>
        <model>Street Glide Special</model>
        <stock></stock>
        <vin></vin>
      </vehicle>
      <vehicle interest="trade-in">
        <year>2018</year>
        <make>HARLEY-DAVIDSON</make>
        <model>FLHCS Heritage Class</model>
        <odometer unit="MILES"></odometer>
      </vehicle>`,
      comment: `Pre-Inspection Trade-In Value Estimate <br />
Event Name: PowerSports TV Trade In <br />
Email Opt-In: Yes <br />
Phone Opt-In: Yes`
    }),
    checks: lead => [
      check("lead_ref", lead.leadRef, "90005"),
      check("active_buy_year", lead.year, "2021"),
      check("active_buy_model", lead.vehicleModel, "Street Glide Special"),
      check("trade_year", lead.tradeVehicle?.year, "2018"),
      check("trade_model", lead.tradeVehicle?.model, "FLHCS Heritage Class"),
      check("does_not_use_prior_private_seller_vehicle", `${lead.year ?? ""} ${lead.vehicleModel ?? ""}`.includes("2016"), false),
      ...expectRule("traffic_log_pro_buy_plus_trade_update", "Traffic Log Pro", undefined, "in_store", "contact_us")
    ]
  },
  {
    id: "hdfs_credit_application",
    source: "HDFS COA Online",
    sourceId: 2852,
    xml: adf({
      source: "HDFS COA Online",
      leadRef: "90006",
      provider: "HDFS COA Online",
      first: "Joseph",
      last: "Highway",
      phone: "7169090569",
      email: "joseph@example.com",
      vehicles: `<vehicle interest="buy" status="NEW">
        <year></year>
        <make>HARLEY-DAVIDSON</make>
        <model>Full Line</model>
      </vehicle>`,
      comment: `App ID: 1013910342, Model Year: 2025, Model: Heritage Classic <br />
Source ID: 2852 <br />
Email Opt-In: Yes <br />
Phone Opt-In: Yes`
    }),
    checks: lead => [
      check("lead_ref", lead.leadRef, "90006"),
      check("source_id", lead.leadSourceId, 2852),
      check("year_from_model_year", lead.year, "2025"),
      check("model_from_comment_over_full_line", lead.vehicleModel, "Heritage Classic"),
      check("condition", lead.vehicleCondition, "new"),
      ...expectRule("hdfs_credit_application", "HDFS COA Online", 2852, "finance_prequal", "hdfs_coa")
    ]
  },
  {
    id: "hdcom_test_ride_request",
    source: "HD.COM ONLINE TEST RIDE REQUEST",
    sourceId: 2814,
    xml: adf({
      source: "HD.COM ONLINE TEST RIDE REQUEST",
      leadRef: "90007",
      provider: "HD.COM ONLINE TEST RIDE REQUEST",
      first: "Glenn",
      last: "Rider",
      phone: "7165550707",
      email: "glenn@example.com",
      vehicles: `<vehicle interest="buy" status="NEW">
        <year>2026</year>
        <make>HARLEY-DAVIDSON</make>
        <model>Low Rider S</model>
        <stock>LR26</stock>
      </vehicle>`,
      comment: `Your inquiry: I would like to book a test ride <br />
Preferred Date: 2026-06-03 <br />
Preferred Time: 2:00 PM <br />
Valid Motorcycle License? Yes <br />
Purchase Timeframe: 1-3 months <br />
Source ID: 2814`
    }),
    checks: lead => [
      check("lead_ref", lead.leadRef, "90007"),
      check("year", lead.year, "2026"),
      check("model", lead.vehicleModel, "Low Rider S"),
      check("preferred_date", lead.preferredDate, "2026-06-03"),
      check("preferred_time", lead.preferredTime, "2:00 PM"),
      check("has_moto_license", lead.hasMotoLicense, true),
      check("purchase_timeframe", lead.purchaseTimeframe, "1-3 months"),
      ...expectRule("hdcom_test_ride_request", "HD.COM ONLINE TEST RIDE REQUEST", 2814, "test_ride", "schedule_test_ride")
    ]
  },
  {
    id: "walkin_watch_note",
    source: "Traffic Log Pro",
    xml: adf({
      source: "Traffic Log Pro",
      leadRef: "90008",
      provider: "Traffic Log Pro",
      first: "Donald",
      last: "Walker",
      phone: "7165550808",
      email: "donald@example.com",
      vehicles: `<vehicle interest="buy" status="USED">
        <year></year>
        <make>HARLEY-DAVIDSON</make>
        <model>Full Line</model>
      </vehicle>`,
      comment: `Step 2 <br />
Your inquiry: looking for a 2026 FLTRT Road Glide 3, let me know when we have one coming in. <br />
Purchase Timeframe: 3-12 months <br />
Valid Motorcycle License? Yes`
    }),
    checks: lead => [
      check("lead_ref", lead.leadRef, "90008"),
      check("model_from_inquiry_not_full_line", lead.vehicleModel, "Full Line"),
      checkIncludes("inquiry_keeps_watch_language", lead.inquiry, "Road Glide 3"),
      check("purchase_timeframe", lead.purchaseTimeframe, "3-12 months"),
      check("has_moto_license", lead.hasMotoLicense, true),
      ...expectRule("walkin_watch_note", "Traffic Log Pro", undefined, "in_store", "contact_us")
    ]
  },
  {
    id: "dealer_lead_app_demo_ride",
    source: "Dealer Lead App",
    xml: adf({
      source: "Dealer Lead App",
      leadRef: "90009",
      provider: "Dealer Lead App",
      first: "Scott",
      last: "Heaton",
      phone: "7168740538",
      email: "scott@example.com",
      vehicles: `<vehicle interest="buy" status="NEW">
        <year>2025</year>
        <make>HARLEY-DAVIDSON</make>
        <model>Freewheeler</model>
      </vehicle>`,
      comment: `Customer Comments: Stone Giuga Marketing Questions: Dealer Lead App - Type: Y <br />
SalesPerson: Stone Giuga-Stone Giuga <br />
How many years have you owned your Harley-Davidson motorcycle? More than 4 years <br />
Do you expect to make a motorcycle purchase in the near future? Yes, in 3-12 months <br />
Which model of motorcycle are you interested in? 2025,TRIKE,FREEWHEELER <br />
Demo Bikes Ridden: 2025,TRIKE,FREEWHEELER <br />
Email Opt-In:Yes`
    }),
    checks: lead => [
      check("lead_ref", lead.leadRef, "90009"),
      check("year", lead.year, "2025"),
      check("model", lead.vehicleModel, "Freewheeler"),
      checkIncludes("comment_keeps_demo_bike_fields", lead.comment, "Demo Bikes Ridden"),
      check("email_opt_in", lead.emailOptIn, true)
    ]
  },
  {
    id: "contact_us_hiring_inquiry",
    source: "HD.COM CONTACT US",
    xml: adf({
      source: "HD.COM CONTACT US",
      leadRef: "90010",
      provider: "HD.COM CONTACT US",
      first: "Jim",
      last: "Serio",
      phone: "7165538851",
      email: "jim@example.com",
      vehicles: `<vehicle interest="buy" status="">
        <year></year>
        <make></make>
        <model></model>
      </vehicle>`,
      comment: `Inquiry: To Whom It May Concern, I am interested in interviewing for your Service Manager position. Please let me know if you wish to schedule an interview. Sincerely, Jim Serio`
    }),
    checks: lead => [
      check("lead_ref", lead.leadRef, "90010"),
      check("first_name", lead.firstName, "Jim"),
      checkIncludes("inquiry_keeps_hiring_text", lead.inquiry, "Service Manager position"),
      check("does_not_invent_vehicle", lead.vehicleModel, undefined)
    ]
  }
];

const extractedEmailAdf = adf({
  source: "Marketplace - Contact a Dealer",
  leadRef: "90011",
  provider: "Marketplace - Contact a Dealer",
  first: "Email",
  last: "Lead",
  phone: "7165551111",
  email: "email.lead@example.com",
  comment: "Your inquiry: Can you send more photos?"
});

const emailExtractionCases: FieldCheck[] = [
  check(
    "email_extraction_html_escaped",
    parseAdfXml(extractAdfXmlFromEmail(undefined, extractedEmailAdf.replace(/</g, "&lt;").replace(/>/g, "&gt;")) ?? "")
      .leadRef,
    "90011"
  ),
  check(
    "email_extraction_quoted_printable",
    parseAdfXml(extractAdfXmlFromEmail(`prefix ${extractedEmailAdf.replace(/=/g, "=3D")} suffix`, undefined) ?? "")
      .inquiry,
    "Can you send more photos?"
  )
];

const checks: FieldCheck[] = [];
for (const c of cases) {
  const lead = parseAdfXml(c.xml);
  checks.push(...c.checks(lead).map(result => ({ ...result, id: `${c.id}.${result.id}` })));
}
checks.push(...emailExtractionCases);

let passed = 0;
for (const result of checks) {
  const ok = JSON.stringify(result.actual) === JSON.stringify(result.expected);
  if (ok) passed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${result.id} expected=${JSON.stringify(result.expected)} actual=${JSON.stringify(
      result.actual
    )}`
  );
}

if (passed !== checks.length) {
  console.error(`\n${checks.length - passed} failures out of ${checks.length} ADF smoke checks`);
  process.exit(1);
}

console.log(`\nAll ${checks.length} ADF smoke checks passed.`);
