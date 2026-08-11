/**
 * What bike (if any) is the page a website-widget lead was standing on? (2026-08-10)
 *
 * FIRST PARSER BUILT UNDER THE ZOD CONVENTION (AGENTS.md step 1, Joe 2026-08-10): the shape is
 * defined ONCE here — the JSON schema sent to the model, the TS type, and the runtime validation
 * all derive from `WidgetPageVehicleSchema`.
 *
 * ── WHY A PARSER AND NOT THE REGEX ────────────────────────────────────────────────────────────
 * `extractVehicleFromWidgetPageTitle` splits the title with one regex plus a colour word-list.
 * Measured 2026-08-09 over the WHOLE population (all 30 WEB TEXT WIDGET inbounds in the live
 * store, 19 distinct titles) that split is wrong wherever the colour is not a single known word:
 *
 *   "2014 …® Street Glide® Special Amber Whiskey"        -> colour bleeds into the model
 *   "2008 …® 1200 Nightster® Mirage Orange Pearl & Vivid Black"  -> two-tone colour, trailing "&"
 *   "2017 …® Breakout® Custom Colour Laguna Orange"      -> model/colour split in the wrong place
 *
 * It also requires a YEAR, so three real bike pages return nothing at all — `Fat Bob® 114`,
 * `Harley-Davidson Street® 750`, `Fat Boy® 30th anniversary`. And it cannot tell a motorcycle from
 * `Harley Serial 1 Ebicycle` / `Harley Serial 1 -sähköpyörä`, which is Harley's E-BICYCLE brand and
 * must never be attached to a lead as the bike they want.
 *
 * Those are semantic judgements about our own catalogue, which is what a parser is for.
 *
 * ── THE UNION IS THE POINT ────────────────────────────────────────────────────────────────────
 * A page title has three honest answers, not one: a specific motorcycle, a browse/serving page, or
 * a product that is not a motorcycle. A nullable `{year, model, color}` collapses the last two into
 * "no bike", which is the same value the model returns when it simply cannot read the title. The
 * discriminated union gives the model somewhere legitimate to put each, so a caller can tell
 * "this is the Staff page" from "this is an e-bicycle" from "I could not parse this".
 *
 * ── FAIL DIRECTION ────────────────────────────────────────────────────────────────────────────
 * A page-title bike is INFERRED — the customer stood on a page, they did not say a word about it.
 * So this module never returns a bare vehicle: it returns one stamped `source: "page_title"`, and
 * the caller is required to treat that differently from one the customer typed. That stamp is the
 * whole reason this reader could not be switched on before (it has never fired in production — a
 * `$` anchor with no `m` flag): fixing the regex alone would have started ASSERTING a bike nobody
 * mentioned, on ~5 leads, which is the wrong direction. See `widgetPageVehicleMayMakeAClaim`.
 *
 * Anything the parser is unsure about returns `browse_or_other`, i.e. no bike, i.e. today's
 * behaviour.
 */
import { z } from "zod";

export const WidgetPageVehicleSchema = z.object({
  page: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("motorcycle_detail"),
      year: z
        .string()
        .describe('4-digit model year if the title states one, else "". Never invent one.'),
      model: z
        .string()
        .describe(
          'The Harley-Davidson MODEL NAME only — no year, no colour, no ®/™, no dealer name. ' +
            'e.g. "Street Glide Special", "1200 Nightster", "Breakout", "Fat Bob 114".'
        ),
      color: z
        .string()
        .describe(
          'The factory colour exactly as written, including two-tone ("Mirage Orange Pearl & Vivid Black") ' +
            'and "Custom Colour …" names. "" when the title states no colour.'
        )
    }),
    z
      .object({ kind: z.literal("browse_or_other") })
      .describe(
        "A browse, inventory, service, parts, staff, events, contact or signup page — anything that " +
          "is not one specific motorcycle. ALSO the answer when the title cannot be read confidently."
      ),
    z
      .object({ kind: z.literal("non_motorcycle_product") })
      .describe(
        'A Harley product that is NOT a motorcycle — above all the Serial 1 e-bicycle ' +
          '("Harley Serial 1 Ebicycle", "Harley Serial 1 -sähköpyörä"). Never a bike to shop for.'
      )
  ]),
  confidence: z.number().min(0).max(1)
});

export type WidgetPageVehicleParse = z.infer<typeof WidgetPageVehicleSchema>;

/** A vehicle read off the page the customer was standing on — never something they said. */
export type WidgetPageVehicle = {
  year?: string;
  model?: string;
  color?: string;
  /** Always "page_title" here. Present so a caller can never mistake it for a customer's words. */
  source: "page_title";
};

/**
 * MAY this vehicle drive something the customer will read?
 *
 * NO for a page-title bike. Standing on a bike's page is evidence worth keeping as CONTEXT (the
 * agent knowing which page they came from is useful), but it is not the customer telling us what
 * they want, and a draft that says "about the 2014 Street Glide Special" turns a page view into a
 * claim they never made. Only a vehicle the customer actually named may do that.
 */
export function widgetPageVehicleMayMakeAClaim(vehicle: { source?: string } | null | undefined): boolean {
  return String(vehicle?.source ?? "") !== "page_title";
}

/** The confidence floor for acting on a page-title read (default 0.75). */
export function widgetPageVehicleConfidenceMin(): number {
  const raw = Number(process.env.LLM_WIDGET_PAGE_VEHICLE_CONFIDENCE_MIN);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.75;
}

/**
 * PURE. Turns a parse into the vehicle a caller may use, or null.
 *
 * Only `motorcycle_detail` above the confidence floor, and only when a model actually came back —
 * a year and a colour with no model is not a bike anyone can act on.
 */
export function widgetPageVehicleFromParse(
  parse: WidgetPageVehicleParse | null | undefined,
  opts?: { confidenceMin?: number }
): WidgetPageVehicle | null {
  if (!parse) return null;
  const min = opts?.confidenceMin ?? widgetPageVehicleConfidenceMin();
  if (!Number.isFinite(parse.confidence) || parse.confidence < min) return null;
  if (parse.page.kind !== "motorcycle_detail") return null;
  const model = String(parse.page.model ?? "").trim();
  if (!model) return null;
  const year = String(parse.page.year ?? "").trim();
  const color = String(parse.page.color ?? "").trim();
  return {
    model,
    ...(year ? { year } : {}),
    ...(color ? { color } : {}),
    source: "page_title"
  };
}

export const WIDGET_PAGE_VEHICLE_PROMPT_HEADER = [
  "You read the TITLE of a page on a Harley-Davidson dealership website. A customer opened the",
  "website's text-us widget while on that page. Decide what the page is about.",
  "Return only JSON matching the provided schema.",
  "",
  'Answer "motorcycle_detail" ONLY for one specific motorcycle — usually a detail page. Split the',
  "title into year / model / colour. The dealer name after the final | is never part of the model.",
  'Answer "browse_or_other" for inventory, search, service, parts, staff, events, contact and signup',
  "pages — and whenever you are not confident. That is the safe answer.",
  'Answer "non_motorcycle_product" for Harley products that are not motorcycles; the Serial 1',
  "e-bicycle is the one that actually shows up.",
  "",
  "Examples:",
  '- "2013 Harley-Davidson® Street Glide® Vivid Black | American Harley-Davidson®"',
  '    -> motorcycle_detail, year "2013", model "Street Glide", color "Vivid Black"',
  '- "2008 Harley-Davidson® 1200 Nightster® Mirage Orange Pearl & Vivid Black | American Harley-Davidson®"',
  '    -> motorcycle_detail, year "2008", model "1200 Nightster", color "Mirage Orange Pearl & Vivid Black"',
  '- "Fat Boy® 30th anniversary | American Harley-Davidson®"',
  '    -> motorcycle_detail, year "", model "Fat Boy 30th Anniversary", color ""',
  '- "Used Harley Davidson for Sale, Buffalo, North Tonawanda NY | American Harley-Davidson®"',
  "    -> browse_or_other",
  '- "Harley Serial 1 Ebicycle | American Harley-Davidson®"  -> non_motorcycle_product'
].join("\n");

/**
 * The JSON schema the model is given — DERIVED from the Zod definition above, never hand-written
 * beside it. That is the whole point of the convention: one definition, so the schema the model
 * follows and the type the compiler checks cannot drift apart.
 */
export function widgetPageVehicleJsonSchema(): { [key: string]: unknown } {
  return toStrictStructuredOutputSchema(z.toJSONSchema(WidgetPageVehicleSchema, { target: "draft-7" }));
}

/**
 * Make a Zod-derived JSON schema acceptable to OpenAI strict structured outputs.
 *
 * MEASURED 2026-08-10, the first time we tried a discriminated union — the API rejects it outright:
 *
 *   400 Invalid schema for response_format 'widget_page_vehicle_parser':
 *       In context=('properties','page'), 'oneOf' is not permitted.
 *
 * Zod emits `oneOf` for `z.discriminatedUnion`; strict mode permits `anyOf` only. The two mean the
 * same thing for a discriminated union (the `kind` literal makes the branches mutually exclusive),
 * so this rewrites the keyword and drops the `$schema` header the API also has no use for.
 *
 * Worth knowing before anyone reaches for a union again: the union pattern is sound, but it does
 * NOT work as Zod emits it. Without this step the parser returns null on every call and looks
 * simply "unable to read the title" — which is exactly how a dead guard hides.
 */
function toStrictStructuredOutputSchema(schema: unknown): { [key: string]: unknown } {
  const walk = (node: any): any => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: any = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$schema") continue;
      out[key === "oneOf" ? "anyOf" : key] = walk(value);
    }
    return out;
  };
  return walk(schema) as { [key: string]: unknown };
}

/**
 * Reads the page title. Returns null when the LLM is off, the title is empty, or the response does
 * not satisfy the schema — every one of those means "no bike", i.e. today's behaviour.
 *
 * llmDraft is imported LAZILY (it builds the OpenAI client at module load) so the pure half of this
 * file stays importable by the eval without credentials.
 */
export async function parseWidgetPageVehicleWithLLM(args: {
  pageTitle: string;
}): Promise<WidgetPageVehicleParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_WIDGET_PAGE_VEHICLE_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;
  const pageTitle = String(args.pageTitle ?? "").trim();
  if (!pageTitle) return null;

  const { requestStructuredJson } = await import("./llmDraft.js");
  const primaryModel =
    process.env.OPENAI_WIDGET_PAGE_VEHICLE_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_WIDGET_PAGE_VEHICLE_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const prompt = `${WIDGET_PAGE_VEHICLE_PROMPT_HEADER}\n\nPage title: ${pageTitle}`;

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "widget_page_vehicle_parser",
      schema: widgetPageVehicleJsonSchema(),
      maxOutputTokens: 120,
      debugTag: "llm-widget-page-vehicle-parser",
      debug: process.env.LLM_WIDGET_PAGE_VEHICLE_PARSER_DEBUG === "1"
    });

  const raw = (await runParse(primaryModel)) ?? (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!raw) return null;
  // Validate with the SAME definition the model was given. A response that does not satisfy it is
  // treated as "no bike" rather than repaired — our parsers fail toward doing nothing.
  const checked = WidgetPageVehicleSchema.safeParse(raw);
  return checked.success ? checked.data : null;
}
