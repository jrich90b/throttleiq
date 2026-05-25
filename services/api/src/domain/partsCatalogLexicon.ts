export type PartsCatalogDepartmentIntent = "parts" | "apparel" | "none";

export type PartsCatalogLexiconMatch = {
  departmentIntent: PartsCatalogDepartmentIntent;
  partsTerms: string[];
  apparelTerms: string[];
  categories: string[];
};

type CatalogTermGroup = {
  category: string;
  terms: string[];
};

// Compact vocabulary derived from the Harley-Davidson P&A catalog sections/product headings,
// plus common dealership shorthand salespeople and customers use in text.
const PARTS_TERM_GROUPS: CatalogTermGroup[] = [
  {
    category: "windshields_fairing",
    terms: [
      "windshield",
      "windshields",
      "windscreen",
      "wind splitter",
      "fairing lowers",
      "fairing lower",
      "fairing pouch",
      "batwing fairing",
      "headlamp trim ring",
      "trim ring"
    ]
  },
  {
    category: "seating_backrests",
    terms: [
      "seat",
      "seats",
      "passenger pillion",
      "pillion",
      "saddlemen",
      "backrest",
      "passenger backrest",
      "backrest pad",
      "sissy bar",
      "sissybar",
      "upright",
      "seat hardware",
      "quick release seat"
    ]
  },
  {
    category: "luggage_saddlebags",
    terms: [
      "saddlebag",
      "saddlebags",
      "throw over saddlebags",
      "swingarm bag",
      "tour pak",
      "tour-pak",
      "luggage rack",
      "mounting rack",
      "docking hardware",
      "detachables",
      "latch kit",
      "bag liners",
      "touring luggage"
    ]
  },
  {
    category: "controls_foot_controls",
    terms: [
      "handlebar",
      "handlebars",
      "bars",
      "ape hanger",
      "apes",
      "riser",
      "risers",
      "hand grips",
      "heated grips",
      "grips",
      "footpeg",
      "footpegs",
      "highway peg",
      "highway pegs",
      "footboard",
      "footboards",
      "floorboard",
      "floorboards",
      "shift lever",
      "heel toe shifter",
      "heel toe shift lever",
      "brake lever",
      "clutch lever",
      "hand control lever",
      "switch housing",
      "switch cap"
    ]
  },
  {
    category: "protection_trim",
    terms: [
      "engine guard",
      "engine guards",
      "crash bar",
      "crash bars",
      "skid plate",
      "axle nut cover",
      "axle nut covers",
      "derby cover",
      "timer cover",
      "primary cover",
      "pushrod cover",
      "air cleaner trim",
      "chassis trim",
      "engine trim",
      "tank knee pad",
      "medallion",
      "medallions"
    ]
  },
  {
    category: "performance_engine_exhaust",
    terms: [
      "screamin eagle",
      "screamin' eagle",
      "air cleaner",
      "heavy breather",
      "ventilator",
      "cam",
      "cams",
      "stage i",
      "stage 1",
      "stage ii",
      "stage 2",
      "stage iii",
      "stage 3",
      "stage iv",
      "stage 4",
      "crate engine",
      "exhaust",
      "muffler",
      "mufflers",
      "slip on",
      "slip ons",
      "pipes",
      "headers",
      "tuner",
      "pro street tuner",
      "spark plug",
      "spark plugs",
      "milwaukee eight",
      "m8"
    ]
  },
  {
    category: "audio_lighting_gauges",
    terms: [
      "speaker",
      "speakers",
      "amplifier",
      "amp",
      "rockford",
      "audio",
      "gauge",
      "gauges",
      "spectra glo",
      "led light",
      "light pod",
      "headlamp",
      "daymaker",
      "turn signal",
      "turn signals",
      "lens kit",
      "light kit"
    ]
  },
  {
    category: "wear_items_suspension",
    terms: [
      "brake pads",
      "brake pad",
      "brake rotor",
      "brake rotors",
      "rotor",
      "rotors",
      "tire",
      "tires",
      "wheel",
      "wheels",
      "suspension",
      "shock",
      "shocks",
      "fork",
      "fork kit",
      "oil dipstick",
      "battery",
      "tie down straps"
    ]
  }
];

const APPAREL_TERM_GROUPS: CatalogTermGroup[] = [
  {
    category: "helmets",
    terms: [
      "helmet",
      "helmets",
      "modular helmet",
      "full face helmet",
      "half helmet",
      "open face helmet",
      "helmet shield",
      "face shield",
      "visor"
    ]
  },
  {
    category: "riding_gear",
    terms: [
      "motorclothes",
      "motor clothes",
      "riding gear",
      "gear",
      "jacket",
      "jackets",
      "riding jacket",
      "leather jacket",
      "mesh jacket",
      "glove",
      "gloves",
      "riding gloves",
      "boot",
      "boots",
      "riding boots",
      "rain gear",
      "heated gear",
      "vest",
      "chaps",
      "riding pants"
    ]
  },
  {
    category: "casual_merch",
    terms: [
      "apparel",
      "clothing",
      "merch",
      "merchandise",
      "shirt",
      "shirts",
      "t shirt",
      "tee shirt",
      "hoodie",
      "hoodies",
      "sweatshirt",
      "hat",
      "cap",
      "beanie",
      "gift card"
    ]
  },
  {
    category: "apparel_fit",
    terms: [
      "small",
      "medium",
      "large",
      "xl",
      "2xl",
      "3xl",
      "4xl",
      "size small",
      "size medium",
      "size large",
      "size xl",
      "size 2xl",
      "size 3xl"
    ]
  }
];

const AMBIGUOUS_APPAREL_ONLY_TERMS = new Set([
  "small",
  "medium",
  "large",
  "xl",
  "2xl",
  "3xl",
  "4xl",
  "size small",
  "size medium",
  "size large",
  "size xl",
  "size 2xl",
  "size 3xl"
]);

function normalizeCatalogText(input: unknown): string {
  return String(input ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[®™©]/g, "")
    .replace(/[’‘]/g, "'")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9+/'\\s-]+/g, " ")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function includesNormalizedTerm(normalizedText: string, term: string): boolean {
  const normalizedTerm = normalizeCatalogText(term);
  if (!normalizedText || !normalizedTerm) return false;
  const escaped = normalizedTerm
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return new RegExp(`(?:^|\\b)${escaped}(?:\\b|$)`).test(normalizedText);
}

function collectMatches(normalizedText: string, groups: CatalogTermGroup[]) {
  const terms: string[] = [];
  const categories = new Set<string>();
  for (const group of groups) {
    for (const term of group.terms) {
      if (includesNormalizedTerm(normalizedText, term)) {
        terms.push(term);
        categories.add(group.category);
      }
    }
  }
  return { terms: Array.from(new Set(terms)), categories };
}

export function matchPartsCatalogLexicon(text: string | null | undefined): PartsCatalogLexiconMatch {
  const normalizedText = normalizeCatalogText(text);
  if (!normalizedText) {
    return { departmentIntent: "none", partsTerms: [], apparelTerms: [], categories: [] };
  }
  const parts = collectMatches(normalizedText, PARTS_TERM_GROUPS);
  const apparel = collectMatches(normalizedText, APPAREL_TERM_GROUPS);
  const meaningfulApparelTerms = apparel.terms.filter(term => !AMBIGUOUS_APPAREL_ONLY_TERMS.has(term));
  const apparelTerms = meaningfulApparelTerms.length ? apparel.terms : [];
  const partsTerms = parts.terms;
  const departmentIntent: PartsCatalogDepartmentIntent =
    apparelTerms.length && !partsTerms.length
      ? "apparel"
      : partsTerms.length && !apparelTerms.length
        ? "parts"
        : partsTerms.length && apparelTerms.length
          ? partsTerms.length >= apparelTerms.length
            ? "parts"
            : "apparel"
          : "none";
  const categories = Array.from(new Set([...parts.categories, ...apparel.categories]));
  return {
    departmentIntent,
    partsTerms,
    apparelTerms,
    categories
  };
}

export function buildPartsCatalogParserHint(text: string | null | undefined): string {
  const match = matchPartsCatalogLexicon(text);
  if (!match.partsTerms.length && !match.apparelTerms.length) return "";
  const parts = match.partsTerms.slice(0, 12).join(", ");
  const apparel = match.apparelTerms.slice(0, 12).join(", ");
  return [
    "Catalog vocabulary hint:",
    parts ? `- parts/accessory terms matched: ${parts}` : "",
    apparel ? `- MotorClothes/apparel terms matched: ${apparel}` : "",
    match.categories.length ? `- categories: ${match.categories.slice(0, 8).join(", ")}` : "",
    "- Treat this as a routing hint only; require the full message to be asking about availability, price, ordering, fitment, install, size, or status before routing away from sales."
  ]
    .filter(Boolean)
    .join("\n");
}
