/**
 * INTAKE-SHAPE TEST — what breaks when dealer #2's data doesn't look like ours.
 *
 * WHY THIS EXISTS (Joe, 2026-07-30): the stranger test (scripts/stranger_dealer_test.ts)
 * proved a dealer we've never met gets its own IDENTITY — its name, persona, city and
 * hours, with none of ours leaking. But it fed the engine OUR shapes: our website's
 * inventory feed, our ADF dialect, our link conventions. Joe's question was exactly
 * right: "what happens when we have a different website to pull inventory off of, and
 * maybe the leads from a website form or widget differ, or the ADF looks a little
 * different — do we just have to set it up and test it to find out?"
 *
 * Mostly no, and this is why: the three intake surfaces are PURE FUNCTIONS over a
 * document. parseAdfXml(xml), parseFeed(xml) and extractFirstInventoryUrl(html, host)
 * need no dealership, no phone number, and no live website — so we can hand them
 * deliberately DIFFERENT-shaped inputs today and watch what survives.
 *
 * This harness does that and reports a per-field matrix. It is a MEASUREMENT, not a
 * pass/fail gate on the product: a variant we don't support is a GAP to know about
 * before go-live, not a bug to fix blind. The output doubles as the onboarding ask —
 * "send us one sample lead email and your feed URL" — because the residual unknown
 * (what THAT vendor actually emits) collapses to running their sample through here.
 *
 * ONE THING HERE IS A HARD FAILURE, not a gap: a product link must never be built from
 * ANOTHER dealer's host. That is the cross-dealer leak the stranger test exists to
 * prevent, so it is asserted rather than reported.
 *
 * Usage:
 *   npm run dealer_intake_shape:test
 *   REPORT_ROOT=/home/ubuntu/leadrider-runtime/americanharley/reports npm run dealer_intake_shape:test
 *
 * Writes {reportRoot}/intake_shape/latest.json + latest.md.
 * Pinned by dealer_intake_shape:eval (the harness's own logic — that it reports a known
 * gap AS a gap and never rounds an unsupported shape up to "supported").
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseAdfXml } from "../services/api/src/domain/adfParser.ts";
import { parseFeed } from "../services/api/src/domain/inventoryFeed.ts";
import { extractFirstInventoryUrl } from "../services/api/src/domain/inventoryUrlResolver.ts";

// ---------------------------------------------------------------------------
// Result shapes.
// ---------------------------------------------------------------------------

export type FieldCheck = {
  field: string;
  /** Required = the lead/unit is unusable without it. */
  required: boolean;
  present: boolean;
  value?: string | number | null;
};

export type VariantResult = {
  surface: "adf" | "feed" | "product_link";
  id: string;
  label: string;
  /** What a real vendor doing it this way looks like, in plain words, for the report. */
  realWorld: string;
  /** Every REQUIRED field came through (and any correctness expectation held). */
  supported: boolean;
  fields: FieldCheck[];
  missingRequired: string[];
  /** Set when the variant threw — treated as unsupported, never skipped. */
  error?: string;
  /** True for a variant whose failure would be a cross-dealer LEAK, not a gap. */
  safetyCritical?: boolean;
};

// ---------------------------------------------------------------------------
// Surface 1 — ADF lead dialects.
// ---------------------------------------------------------------------------

/** Wrap prospect XML in the standard ADF envelope. */
const adfDoc = (prospectInner: string, opts?: { root?: string; prospect?: string }) => {
  const root = opts?.root ?? "adf";
  const prospect = opts?.prospect ?? "prospect";
  return `<?xml version="1.0"?>\n<${root}>\n<${prospect} status="new">\n${prospectInner}\n</${prospect}>\n</${root}>`;
};

const BUY_VEHICLE = `<vehicle interest="buy" status="new">
  <year>2026</year><make>Harley-Davidson</make><model>Road Glide</model>
  <stock>U1234</stock><vin>1HD1KRM12PB600001</vin>
</vehicle>`;

const TRADE_VEHICLE = `<vehicle interest="trade-in" status="used">
  <year>2019</year><make>Harley-Davidson</make><model>Road King</model><odometer>18400</odometer>
</vehicle>`;

const ADF_VARIANTS: {
  id: string;
  label: string;
  realWorld: string;
  xml: string;
  /** Extra correctness expectation beyond "required fields present". */
  expect?: (lead: any) => string | null;
}[] = [
  {
    id: "canonical",
    label: "Standard ADF, lowercase elements, name split into parts",
    realWorld: "What our current providers send. The ADF/XML spec's own shape.",
    xml: adfDoc(`<id source="Room58">L-9001</id>
<customer><contact>
  <name part="first">Dana</name><name part="last">Whitfield</name>
  <email>dana.whitfield@example.com</email>
  <phone type="cell">4195550188</phone>
</contact></customer>
${BUY_VEHICLE}`)
  },
  {
    id: "full_name_single_field",
    label: 'Whole name in one field (part="full")',
    realWorld: "Common with web-form vendors that only collect one name box.",
    xml: adfDoc(`<customer><contact>
  <name part="full">Dana Whitfield</name>
  <email>dana.whitfield@example.com</email>
  <phone type="cell">4195550188</phone>
</contact></customer>
${BUY_VEHICLE}`),
    expect: lead =>
      lead?.firstName === "Dana" && lead?.lastName === "Whitfield"
        ? null
        : `expected the single name field to split into Dana / Whitfield, got ${JSON.stringify([lead?.firstName, lead?.lastName])}`
  },
  {
    id: "phone_without_type",
    label: "Phone with no type attribute",
    realWorld: "Vendors that send one phone number and don't label it cell vs home.",
    xml: adfDoc(`<customer><contact>
  <name part="first">Dana</name><name part="last">Whitfield</name>
  <email>dana.whitfield@example.com</email>
  <phone>4195550188</phone>
</contact></customer>
${BUY_VEHICLE}`)
  },
  {
    id: "trade_listed_before_buy",
    label: "Trade vehicle listed BEFORE the one they want to buy",
    realWorld:
      "Element order is not guaranteed by the spec. Getting this wrong quotes the customer their own trade-in.",
    xml: adfDoc(`<customer><contact>
  <name part="first">Dana</name><name part="last">Whitfield</name>
  <email>dana.whitfield@example.com</email>
  <phone type="cell">4195550188</phone>
</contact></customer>
${TRADE_VEHICLE}
${BUY_VEHICLE}`),
    expect: lead =>
      lead?.vehicleModel === "Road Glide"
        ? null
        : `the vehicle of interest must be the BUY vehicle (Road Glide), got "${lead?.vehicleModel}"`
  },
  {
    id: "minimal_fields",
    label: "Bare minimum: name, email, and a model",
    realWorld: "A sparse widget lead with no phone, no stock number, no VIN.",
    xml: adfDoc(`<customer><contact>
  <name part="first">Dana</name><name part="last">Whitfield</name>
  <email>dana.whitfield@example.com</email>
</contact></customer>
<vehicle interest="buy"><year>2026</year><make>Harley-Davidson</make><model>Road Glide</model></vehicle>`)
  },
  {
    id: "capitalized_elements",
    label: "Capitalized element names (<ADF><Prospect><Customer>)",
    realWorld:
      "Some vendors capitalize tags. XML is case-sensitive and our reader looks for lowercase, so this is expected to come back empty.",
    xml: `<?xml version="1.0"?>\n<ADF>\n<Prospect status="new">\n<Customer><Contact>
  <Name part="first">Dana</Name><Name part="last">Whitfield</Name>
  <Email>dana.whitfield@example.com</Email>
  <Phone type="cell">4195550188</Phone>
</Contact></Customer>
<Vehicle interest="buy"><Year>2026</Year><Make>Harley-Davidson</Make><Model>Road Glide</Model></Vehicle>
</Prospect>\n</ADF>`
  },
  {
    id: "namespace_prefixed",
    label: "Namespace-prefixed elements (<adf:prospect>)",
    realWorld: "Enterprise CRM exports sometimes namespace everything.",
    xml: `<?xml version="1.0"?>\n<adf:adf xmlns:adf="http://www.adf.org">\n<adf:prospect status="new">
<adf:customer><adf:contact>
  <adf:name part="first">Dana</adf:name><adf:name part="last">Whitfield</adf:name>
  <adf:email>dana.whitfield@example.com</adf:email>
</adf:contact></adf:customer>
<adf:vehicle interest="buy"><adf:year>2026</adf:year><adf:make>Harley-Davidson</adf:make><adf:model>Road Glide</adf:model></adf:vehicle>
</adf:prospect>\n</adf:adf>`
  },
  {
    id: "no_adf_envelope",
    label: "Bare <prospect> with no <adf> wrapper",
    realWorld: "Some senders omit the outer envelope. Our reader falls back to the document root.",
    xml: `<?xml version="1.0"?>\n<prospect status="new">
<customer><contact>
  <name part="first">Dana</name><name part="last">Whitfield</name>
  <email>dana.whitfield@example.com</email>
  <phone type="cell">4195550188</phone>
</contact></customer>
${BUY_VEHICLE}
</prospect>`
  }
];

/**
 * Fields a lead needs before we can work it. Field names are ParsedAdfLead's own — note
 * the vehicle year is `year`, not `vehicleYear`.
 *
 * `vehicleColor` is deliberately NOT reported here: the ADF reader derives colour from the
 * free-text description/comment rather than a structured element, so its emptiness is a
 * property of the input's prose, not of the document's shape — including it would show a
 * permanent, misleading blank on every variant.
 */
const ADF_REQUIRED = ["firstName", "email", "year", "vehicleMake", "vehicleModel"];
const ADF_REPORTED = [
  "leadRef",
  "firstName",
  "lastName",
  "email",
  "phone",
  "year",
  "vehicleMake",
  "vehicleModel",
  "stockId",
  "vin"
];

export function runAdfVariants(): VariantResult[] {
  return ADF_VARIANTS.map(variant => {
    try {
      const lead: any = parseAdfXml(variant.xml);
      const fields: FieldCheck[] = ADF_REPORTED.map(field => {
        const value = lead?.[field];
        const present = value != null && String(value).trim() !== "";
        return { field, required: ADF_REQUIRED.includes(field), present, value: present ? value : null };
      });
      const missingRequired = fields.filter(f => f.required && !f.present).map(f => f.field);
      const expectationError = variant.expect ? variant.expect(lead) : null;
      return {
        surface: "adf" as const,
        id: variant.id,
        label: variant.label,
        realWorld: variant.realWorld,
        supported: missingRequired.length === 0 && !expectationError,
        fields,
        missingRequired,
        error: expectationError ?? undefined
      };
    } catch (err) {
      return {
        surface: "adf" as const,
        id: variant.id,
        label: variant.label,
        realWorld: variant.realWorld,
        supported: false,
        fields: [],
        missingRequired: [...ADF_REQUIRED],
        error: err instanceof Error ? err.message : String(err)
      };
    }
  });
}

// ---------------------------------------------------------------------------
// Surface 2 — inventory feed schemas.
// ---------------------------------------------------------------------------

const FEED_VARIANTS: { id: string; label: string; realWorld: string; xml: string }[] = [
  {
    id: "canonical_inventory_item",
    label: "<inventory><item> with our exact field names",
    realWorld: "What our current website feed emits.",
    xml: `<inventory><item>
  <stocknumber>U1234</stocknumber><vin>1HD1KRM12PB600001</vin>
  <year>2026</year><make>Harley-Davidson</make><model>Road Glide</model>
  <color>Vivid Black</color><condition>new</condition>
  <url>https://example-dealer.example.com/inventory/12345/2026-road-glide</url>
  <price>28999</price><mileage>12</mileage>
</item></inventory>`
  },
  {
    id: "items_item_container",
    label: "<items><item> container",
    realWorld: "A different plural wrapper. Already handled.",
    xml: `<items><item>
  <stocknumber>U1234</stocknumber><vin>1HD1KRM12PB600001</vin>
  <year>2026</year><make>Harley-Davidson</make><model>Road Glide</model>
  <color>Vivid Black</color><price>28999</price>
</item></items>`
  },
  {
    id: "british_colour_spelling",
    label: "British spelling <colour>",
    realWorld: "A vendor using <colour>. Colour drives 'is the black one in stock' answers.",
    xml: `<inventory><item>
  <stocknumber>U1234</stocknumber><year>2026</year><make>Harley-Davidson</make><model>Road Glide</model>
  <colour>Vivid Black</colour><price>28999</price>
</item></inventory>`
  },
  {
    id: "stock_number_alias",
    label: "<stock_number> instead of <stocknumber>",
    realWorld:
      "An extremely common naming difference. Stock number is how we tie a reply to a specific unit.",
    xml: `<inventory><item>
  <stock_number>U1234</stock_number><year>2026</year><make>Harley-Davidson</make><model>Road Glide</model>
  <color>Vivid Black</color><price>28999</price>
</item></inventory>`
  },
  {
    id: "attribute_style_fields",
    label: "Fields as XML attributes on <item> instead of child elements",
    realWorld: "A whole family of feed generators does it this way.",
    xml: `<inventory><item stocknumber="U1234" vin="1HD1KRM12PB600001" year="2026" make="Harley-Davidson" model="Road Glide" color="Vivid Black" price="28999" /></inventory>`
  },
  {
    id: "nested_attribute_list",
    label: "Generic <attribute name=\"...\"> value list",
    realWorld: "Feeds that model everything as name/value pairs.",
    xml: `<inventory><item>
  <attribute name="stocknumber">U1234</attribute>
  <attribute name="year">2026</attribute>
  <attribute name="make">Harley-Davidson</attribute>
  <attribute name="model">Road Glide</attribute>
  <attribute name="color">Vivid Black</attribute>
</item></inventory>`
  },
  {
    id: "vehicle_element_name",
    label: "<vehicles><vehicle> instead of <item>",
    realWorld: "Plenty of feeds call the row a vehicle, not an item.",
    xml: `<vehicles><vehicle>
  <stocknumber>U1234</stocknumber><year>2026</year><make>Harley-Davidson</make><model>Road Glide</model>
  <color>Vivid Black</color><price>28999</price>
</vehicle></vehicles>`
  },
  {
    id: "unknown_container",
    label: "A row element we've never seen (<catalog><product>)",
    realWorld:
      "The permanent tail: no alias list is ever complete. This variant exists so the harness always has one shape it genuinely cannot read — that is what keeps 'reports a gap as a gap' testable after every round of tolerance work, instead of quietly asserting that some real feed stays broken.",
    xml: `<catalog><product>
  <stocknumber>U1234</stocknumber><year>2026</year><make>Harley-Davidson</make><model>Road Glide</model>
</product></catalog>`
  }
];

/** Without these a unit can't be matched to a customer's question or offered by name. */
const FEED_REQUIRED = ["stockId", "year", "make", "model"];
const FEED_REPORTED = ["stockId", "vin", "year", "make", "model", "color", "condition", "url", "price", "mileage"];

export function runFeedVariants(): VariantResult[] {
  return FEED_VARIANTS.map(variant => {
    try {
      const items = parseFeed(variant.xml);
      const item: any = items[0] ?? {};
      const fields: FieldCheck[] = FEED_REPORTED.map(field => {
        const value = item?.[field];
        const present = value != null && String(value).trim() !== "" && !(Array.isArray(value) && !value.length);
        return { field, required: FEED_REQUIRED.includes(field), present, value: present ? value : null };
      });
      const missingRequired = fields.filter(f => f.required && !f.present).map(f => f.field);
      const noRows = items.length === 0;
      return {
        surface: "feed" as const,
        id: variant.id,
        label: variant.label,
        realWorld: variant.realWorld,
        supported: !noRows && missingRequired.length === 0,
        fields,
        missingRequired: noRows ? [...FEED_REQUIRED] : missingRequired,
        error: noRows ? "the feed produced no rows at all — the container element was not recognized" : undefined
      };
    } catch (err) {
      return {
        surface: "feed" as const,
        id: variant.id,
        label: variant.label,
        realWorld: variant.realWorld,
        supported: false,
        fields: [],
        missingRequired: [...FEED_REQUIRED],
        error: err instanceof Error ? err.message : String(err)
      };
    }
  });
}

// ---------------------------------------------------------------------------
// Surface 3 — product-link conventions on the dealer's website.
// ---------------------------------------------------------------------------

const DEALER_HOST = "example-dealer.example.com";

const LINK_VARIANTS: {
  id: string;
  label: string;
  realWorld: string;
  html: string;
  /**
   * "link"           — a dealer on this platform SHOULD get a product link. No link = a
   *                    capability gap, reported as unsupported even though the code is
   *                    behaving as written. The dealer's-eye view is the honest one: if
   *                    their customers get no link, the feature does not work for them.
   * "no_link_safety" — a link here would be a cross-dealer LEAK. No link = correct.
   */
  expect: "link" | "no_link_safety";
  safetyCritical?: boolean;
}[] = [
  {
    id: "relative_numeric_path",
    label: "/inventory/12345/2026-road-glide",
    realWorld: "Our current website's convention.",
    html: `<a href="/inventory/12345/2026-road-glide-special">View</a>`,
    expect: "link"
  },
  {
    id: "absolute_same_host",
    label: "Absolute URL on the dealer's own host",
    realWorld: "Same convention, written out in full.",
    html: `<a href="https://${DEALER_HOST}/inventory/12345/2026-road-glide">View</a>`,
    expect: "link"
  },
  {
    id: "slug_only_path",
    label: "/new-inventory/2026-road-glide-special (no numeric id)",
    realWorld:
      "A different dealer-website platform. Our matcher requires a numeric id in the path, so a dealer on this platform gets NO product links — safe, but silently degraded.",
    html: `<a href="/new-inventory/2026-road-glide-special-u1234">View</a>`,
    expect: "link"
  },
  {
    id: "query_param_id",
    label: "/vehicle-details?vehicleId=12345",
    realWorld:
      "Platforms that pass the unit id as a query parameter. Also yields NO product links today.",
    html: `<a href="/vehicle-details?vehicleId=12345">View</a>`,
    expect: "link"
  },
  {
    id: "foreign_host_inventory_path",
    label: "Another dealer's absolute /inventory/ URL on the page",
    realWorld:
      "A syndication widget or backlink to a DIFFERENT dealership. Building a link from this would send our customer to a competitor — a cross-dealer leak, not a gap.",
    html: `<a href="https://some-other-dealership.example.net/inventory/999/2026-road-glide">View</a>`,
    expect: "no_link_safety",
    safetyCritical: true
  }
];

export function runLinkVariants(): VariantResult[] {
  return LINK_VARIANTS.map(variant => {
    try {
      const url = extractFirstInventoryUrl(variant.html, DEALER_HOST);
      const gotUrl = typeof url === "string" && url.length > 0;
      const wantUrl = variant.expect === "link";
      // A safety-critical variant must produce NO url; and any url we do build must be
      // on the dealer's own host.
      const onDealerHost = gotUrl ? url!.toLowerCase().includes(DEALER_HOST) : true;
      const met = gotUrl === wantUrl && onDealerHost;
      return {
        surface: "product_link" as const,
        id: variant.id,
        label: variant.label,
        realWorld: variant.realWorld,
        supported: met,
        fields: [
          { field: "productUrl", required: wantUrl, present: gotUrl, value: gotUrl ? url : null },
          { field: "onDealerHost", required: true, present: onDealerHost }
        ],
        missingRequired: wantUrl && !gotUrl ? ["productUrl"] : !onDealerHost ? ["onDealerHost"] : [],
        error: !onDealerHost
          ? `built a link on a foreign host: ${url}`
          : gotUrl && !wantUrl
            ? `expected no link for this convention but got ${url}`
            : undefined,
        safetyCritical: variant.safetyCritical
      };
    } catch (err) {
      return {
        surface: "product_link" as const,
        id: variant.id,
        label: variant.label,
        realWorld: variant.realWorld,
        supported: false,
        fields: [],
        missingRequired: ["productUrl"],
        error: err instanceof Error ? err.message : String(err),
        safetyCritical: variant.safetyCritical
      };
    }
  });
}

// ---------------------------------------------------------------------------
// Grading + report.
// ---------------------------------------------------------------------------

export type IntakeShapeResult = {
  at: string;
  /** Variants whose REQUIRED fields all survived. */
  supported: number;
  total: number;
  /** Shapes we do not handle — the pre-go-live knowledge, not bugs. */
  gaps: VariantResult[];
  /** Cross-dealer leaks. Any entry here is a real defect, not a gap. */
  safetyFailures: VariantResult[];
  bySurface: Record<string, { supported: number; total: number }>;
  variants: VariantResult[];
};

/**
 * Grade a run. The distinction that matters, and the reason this is not just a pass/fail
 * eval: an unsupported SHAPE is a gap (we learn it before onboarding a dealer who uses
 * it), while a safety-critical failure is a DEFECT (we would send one dealer's customer
 * to another dealer). They are counted separately so the second can never hide inside
 * the first.
 */
export function gradeIntakeShape(variants: VariantResult[], at: string): IntakeShapeResult {
  const bySurface: Record<string, { supported: number; total: number }> = {};
  for (const variant of variants) {
    const bucket = (bySurface[variant.surface] ??= { supported: 0, total: 0 });
    bucket.total += 1;
    if (variant.supported) bucket.supported += 1;
  }
  const failures = variants.filter(v => !v.supported);
  return {
    at,
    supported: variants.filter(v => v.supported).length,
    total: variants.length,
    gaps: failures.filter(v => !v.safetyCritical),
    safetyFailures: failures.filter(v => v.safetyCritical),
    bySurface,
    variants
  };
}

const SURFACE_LABELS: Record<string, string> = {
  adf: "Lead emails (ADF)",
  feed: "Inventory feed",
  product_link: "Product links on the dealer's website"
};

function renderMarkdown(result: IntakeShapeResult): string {
  const lines: string[] = [];
  lines.push("# Intake-shape test — what breaks when dealer #2's data looks different");
  lines.push("");
  lines.push(`Ran ${result.at}. **${result.supported} of ${result.total} shapes handled.**`);
  lines.push("");
  if (result.safetyFailures.length) {
    lines.push("## CROSS-DEALER LEAK — fix before anything else");
    for (const variant of result.safetyFailures) {
      lines.push(`- **${variant.label}** — ${variant.error ?? "safety expectation failed"}`);
    }
    lines.push("");
  }
  for (const surface of ["adf", "feed", "product_link"]) {
    const rows = result.variants.filter(v => v.surface === surface);
    if (!rows.length) continue;
    const bucket = result.bySurface[surface];
    lines.push(`## ${SURFACE_LABELS[surface]} — ${bucket.supported}/${bucket.total} handled`);
    lines.push("");
    lines.push("| Shape | Handled | What's missing |");
    lines.push("| --- | --- | --- |");
    for (const variant of rows) {
      const missing = variant.missingRequired.length
        ? variant.missingRequired.join(", ")
        : variant.error
          ? "—"
          : "nothing";
      lines.push(`| ${variant.label} | ${variant.supported ? "yes" : "**no**"} | ${missing} |`);
    }
    lines.push("");
    for (const variant of rows.filter(v => !v.supported)) {
      lines.push(`- **${variant.label}** — ${variant.realWorld}`);
      if (variant.error) lines.push(`  - ${variant.error}`);
      const degraded = variant.fields.filter(f => !f.required && !f.present).map(f => f.field);
      if (degraded.length) lines.push(`  - also empty (non-blocking): ${degraded.join(", ")}`);
    }
    lines.push("");
  }
  lines.push("## What to ask a new dealer for");
  lines.push("");
  lines.push(
    "The residual unknown is what THAT vendor actually emits, and it collapses to two artifacts:"
  );
  lines.push("");
  lines.push("1. **One sample lead email** (a real ADF, forwarded) — run it through `parseAdfXml`.");
  lines.push("2. **Their inventory feed URL** (or one sample of its output) — run it through `parseFeed`.");
  lines.push("");
  lines.push(
    "Both are minutes of work and turn go-live surprises into a checklist item. A field this " +
      "harness reports empty is a field the reply engine will silently not mention."
  );
  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name: string) => {
    const index = argv.indexOf(name);
    if (index >= 0) return argv[index + 1] || "";
    const prefix = `${name}=`;
    return argv.find(a => a.startsWith(prefix))?.slice(prefix.length) || "";
  };
  const reportRoot = arg("--report-root") || process.env.REPORT_ROOT || path.resolve(process.cwd(), "reports");
  const outDir = path.join(reportRoot, "intake_shape");

  const variants = [...runAdfVariants(), ...runFeedVariants(), ...runLinkVariants()];
  const result = gradeIntakeShape(variants, new Date().toISOString());

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(outDir, "latest.md"), renderMarkdown(result) + "\n");

  console.log(
    JSON.stringify(
      {
        ok: true,
        supported: result.supported,
        total: result.total,
        gaps: result.gaps.length,
        safetyFailures: result.safetyFailures.length,
        bySurface: result.bySurface,
        outDir
      },
      null,
      2
    )
  );
  // A cross-dealer leak is the one thing that fails the command.
  if (result.safetyFailures.length) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
