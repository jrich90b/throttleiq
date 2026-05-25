import { matchPartsCatalogLexicon } from "../services/api/src/domain/partsCatalogLexicon.js";

type Fixture = {
  id: string;
  text: string;
  expectedDepartment: "parts" | "apparel" | "none";
  expectedTerm: string;
};

const fixtures: Fixture[] = [
  {
    id: "sissy_bar_alias_parts",
    text: "Can you order a sissy bar for my Low Rider ST?",
    expectedDepartment: "parts",
    expectedTerm: "sissy bar"
  },
  {
    id: "apes_alias_parts",
    text: "How much to install apes on a Street Glide?",
    expectedDepartment: "parts",
    expectedTerm: "apes"
  },
  {
    id: "slip_ons_alias_parts",
    text: "Do you carry slip ons for a 2024 Road Glide?",
    expectedDepartment: "parts",
    expectedTerm: "slip ons"
  },
  {
    id: "modular_helmet_apparel",
    text: "Do you have a modular helmet in XL?",
    expectedDepartment: "apparel",
    expectedTerm: "modular helmet"
  },
  {
    id: "riding_jacket_apparel",
    text: "Looking for a riding jacket and gloves in 2XL.",
    expectedDepartment: "apparel",
    expectedTerm: "riding jacket"
  },
  {
    id: "size_alone_not_apparel",
    text: "Do you have an XL Street Glide?",
    expectedDepartment: "none",
    expectedTerm: ""
  }
];

let passed = 0;
const failures: string[] = [];

for (const fixture of fixtures) {
  const actual = matchPartsCatalogLexicon(fixture.text);
  const terms = [...actual.partsTerms, ...actual.apparelTerms];
  const okDepartment = actual.departmentIntent === fixture.expectedDepartment;
  const okTerm = fixture.expectedTerm ? terms.includes(fixture.expectedTerm) : terms.length === 0;
  if (okDepartment && okTerm) {
    passed += 1;
    console.log(`PASS ${fixture.id}`);
  } else {
    failures.push(
      `${fixture.id} expected=${JSON.stringify({
        department: fixture.expectedDepartment,
        term: fixture.expectedTerm
      })} actual=${JSON.stringify(actual)}`
    );
    console.error(`FAIL ${fixture.id}`);
  }
}

console.log(`Parts catalog lexicon checks: ${passed}/${fixtures.length}`);
if (failures.length) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("All checks passed.");
