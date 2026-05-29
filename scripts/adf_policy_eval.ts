import {
  extractAdfInquiryCandidates,
  isPriceOnlyInquiryText,
  shouldForceInitialTestRideSourceScheduleCopy,
  shouldRouteRoom58PriceHandoff
} from "../services/api/src/domain/adfPolicy.ts";
import {
  isInternationalShippingInquiry,
  shouldDeclineInternationalShipping
} from "../services/api/src/domain/internationalShippingPolicy.ts";
import { resolveLeadRule } from "../services/api/src/domain/leadSourceRules.ts";

type Case = {
  id: string;
  run: () => boolean;
  expected: boolean;
};

const laurenInquiry =
  "inventory item: harley-davidson ultra limited 2022 flhtk u876-22 vivid black > inventory year: 2022 > inventory stock id:u876-22 > vin:1hd1knf12nb614098 > first name: lauren > last name: barron > phone: 2564812665 > email: laurenclairerager@gmail.com > your inquiry: price? > can we contact you via email?: yes > can we contact you via phone?: yes > can we contact you via text?: yes > client_id: 141185051.1775155965 price?";

const donaldInquiry =
  "looking for a 2026 fltrt road glide 3, let me know when we have one coming in. (step 2)";

const cases: Case[] = [
  {
    id: "lauren_embedded_price_detected",
    expected: true,
    run: () => {
      const candidates = extractAdfInquiryCandidates(laurenInquiry);
      return candidates.some(isPriceOnlyInquiryText);
    }
  },
  {
    id: "lauren_room58_price_routes_handoff",
    expected: true,
    run: () =>
      shouldRouteRoom58PriceHandoff({
        isInitialAdf: true,
        leadSourceLower: "room58 - request details",
        inquiryRaw: laurenInquiry,
        hasInventoryIdentifiers: true,
        pricingInquiryIntent: true
      })
  },
  {
    id: "sale_price_text_routes_room58_price_handoff",
    expected: true,
    run: () =>
      shouldRouteRoom58PriceHandoff({
        isInitialAdf: true,
        leadSourceLower: "room58 - request details",
        inquiryRaw: "What is the sale price",
        hasInventoryIdentifiers: true,
        pricingInquiryIntent: true
      })
  },
  {
    id: "price_plus_trade_not_price_only_handoff",
    expected: false,
    run: () =>
      shouldRouteRoom58PriceHandoff({
        isInitialAdf: true,
        leadSourceLower: "room58 - request details",
        inquiryRaw: "What the asking price i have a 2013 street glide to trade in what the trade in value would be?",
        hasInventoryIdentifiers: true,
        pricingInquiryIntent: true
      })
  },
  {
    id: "donald_walkin_not_room58_price_handoff",
    expected: false,
    run: () =>
      shouldRouteRoom58PriceHandoff({
        isInitialAdf: true,
        leadSourceLower: "traffic log pro",
        inquiryRaw: donaldInquiry,
        hasInventoryIdentifiers: false,
        pricingInquiryIntent: false
      })
  },
  {
    id: "marketplace_contact_dealer_routes_inventory_interest",
    expected: true,
    run: () => {
      const rule = resolveLeadRule("Marketplace - Contact a Dealer");
      return rule.bucket === "inventory_interest" && rule.cta === "check_availability";
    }
  },
  {
    id: "marketplace_sell_my_bike_routes_trade_sell",
    expected: true,
    run: () => {
      const rule = resolveLeadRule("Marketplace - Sell My Bike");
      return rule.bucket === "trade_in_sell" && rule.cta === "sell_my_bike";
    }
  },
  {
    id: "marketplace_value_my_trade_routes_trade_value",
    expected: true,
    run: () => {
      const rule = resolveLeadRule("Marketplace - Value My Trade");
      return rule.bucket === "trade_in_sell" && rule.cta === "value_my_trade";
    }
  },
  {
    id: "international_shipping_question_detected",
    expected: true,
    run: () =>
      isInternationalShippingInquiry(
        "Good afternoon, very nice motorcycle. I live in Honduras. Do you ship internationally?"
      )
  },
  {
    id: "dealer_disabled_international_shipping_declines",
    expected: true,
    run: () =>
      shouldDeclineInternationalShipping(
        { policies: { internationalShipping: { enabled: false } } },
        "I live in Honduras. Do you ship internationally?"
      )
  },
  {
    id: "dealer_enabled_international_shipping_does_not_decline",
    expected: false,
    run: () =>
      shouldDeclineInternationalShipping(
        { policies: { internationalShipping: { enabled: true } } },
        "I live in Honduras. Do you ship internationally?"
      )
  },
  {
    id: "new_vehicle_export_disabled_declines_new",
    expected: true,
    run: () =>
      shouldDeclineInternationalShipping(
        {
          policies: {
            internationalShipping: {
              enabled: true,
              newVehicleExportEnabled: false,
              usedVehicleExportEnabled: true
            }
          }
        },
        "I live in Honduras. Do you ship internationally?",
        { vehicleCondition: "new" }
      )
  },
  {
    id: "used_vehicle_export_enabled_allows_used",
    expected: false,
    run: () =>
      shouldDeclineInternationalShipping(
        {
          policies: {
            internationalShipping: {
              enabled: true,
              newVehicleExportEnabled: false,
              usedVehicleExportEnabled: true
            }
          }
        },
        "I live in Honduras. Do you ship internationally?",
        { vehicleCondition: "used" }
      )
  },
  {
    id: "source_only_test_ride_forces_schedule_copy",
    expected: true,
    run: () =>
      shouldForceInitialTestRideSourceScheduleCopy({
        isInitialAdf: true,
        inferredBucket: "test_ride",
        inferredCta: "schedule_test_ride",
        leadSourceLower: "hd.com online test ride request",
        draft: "Hi Glenn — This is Alexandra at American Harley-Davidson. Thanks for reaching out. How can I help?"
      })
  },
  {
    id: "existing_test_ride_copy_not_overwritten",
    expected: false,
    run: () =>
      shouldForceInitialTestRideSourceScheduleCopy({
        isInitialAdf: true,
        inferredBucket: "test_ride",
        inferredCta: "schedule_test_ride",
        leadSourceLower: "hd.com online test ride request",
        draft: "Thanks — I saw you’re interested in a test ride. What day works best for you?"
      })
  },
  {
    id: "non_initial_test_ride_source_not_forced",
    expected: false,
    run: () =>
      shouldForceInitialTestRideSourceScheduleCopy({
        isInitialAdf: false,
        inferredBucket: "test_ride",
        inferredCta: "schedule_test_ride",
        leadSourceLower: "hd.com online test ride request",
        draft: "Thanks for reaching out. How can I help?"
      })
  }
];

let passed = 0;
for (const c of cases) {
  const actual = c.run();
  const ok = actual === c.expected;
  if (ok) passed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.id} expected=${c.expected} actual=${actual}`);
}

if (passed !== cases.length) {
  console.error(`\n${cases.length - passed} failures out of ${cases.length} cases`);
  process.exit(1);
}

console.log(`\nAll ${cases.length} ADF policy checks passed.`);
