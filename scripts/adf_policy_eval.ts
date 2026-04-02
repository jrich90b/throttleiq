import {
  extractAdfInquiryCandidates,
  isPriceOnlyInquiryText,
  shouldRouteRoom58PriceHandoff
} from "../services/api/src/domain/adfPolicy.ts";

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
