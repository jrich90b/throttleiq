import { decideWebTextWidgetSalesClassification } from "./routeStateReducer.js";
import type { WebTextWidgetSalesLeadParse } from "./llmDraft.js";

export type WebTextWidgetDepartment = "sales" | "service" | "parts" | "apparel";

export type WebTextWidgetClassification = {
  bucket: "inventory_interest" | "trade_in_sell" | "service" | "parts" | "apparel";
  cta:
    | "check_availability"
    | "value_my_trade"
    | "service_request"
    | "parts_request"
    | "apparel_request";
};

/** parseWebTextWidgetSalesLeadWithLLM's intent values, mirrored so this module stays dependency-light. */
export type WebTextWidgetSalesParserIntent =
  | "buy_inventory"
  | "buy_inventory_with_trade"
  | "sell_or_trade"
  | "finance_or_payment"
  | "general_sales"
  | "none";

export type WebTextWidgetVehicle = {
  year?: string;
  model?: string;
  color?: string;
  condition?: "new" | "used";
};

export type WebTextWidgetSalesVehicleContext = {
  requestedVehicle?: WebTextWidgetVehicle;
  tradeVehicle?: WebTextWidgetVehicle;
  sellOption?: "cash" | "trade" | "either";
  /**
   * The typed widget-sales parser's OWN verdict for this turn. The regex extractor never sets
   * these two — they exist so the classification referee can ask the parser, not the keywords.
   */
  parserIntent?: WebTextWidgetSalesParserIntent;
  parserHasRequestedVehicle?: boolean;
};

export function normalizeWebTextWidgetDepartment(raw?: string | null): WebTextWidgetDepartment | null {
  const t = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!t) return null;
  if (/\bsales?\b|inventory|bike|motorcycle/.test(t)) return "sales";
  if (/\bservice\b|repair|maintenance|oil change|inspection/.test(t)) return "service";
  if (/\bparts?\b|accessor/.test(t)) return "parts";
  if (/\bapparel\b|motor clothes|motorclothes|clothing|gear|helmet|merch/.test(t)) return "apparel";
  return null;
}

export function webTextWidgetDepartmentLabel(department: WebTextWidgetDepartment): string {
  if (department === "apparel") return "Motor Clothes";
  return department.replace(/^\w/, c => c.toUpperCase());
}

/**
 * The department alone can only ever say "buy side" (see decideWebTextWidgetSalesClassification —
 * that is exactly how a seller got an availability tag). Pass the resolved sales context and the
 * PARSER's verdict decides; omit it and this stays the department-only default it always was.
 */
export function webTextWidgetClassification(
  department: WebTextWidgetDepartment,
  context?: WebTextWidgetSalesVehicleContext | null
): WebTextWidgetClassification {
  const decision = decideWebTextWidgetSalesClassification({
    department,
    parserIntent: context?.parserIntent ?? null,
    parserHasRequestedVehicle: !!context?.parserHasRequestedVehicle
  });
  return { bucket: decision.bucket, cta: decision.cta };
}

export function webTextWidgetTodoReason(
  department: WebTextWidgetDepartment
): "service" | "parts" | "apparel" | null {
  if (department === "service" || department === "parts" || department === "apparel") {
    return department;
  }
  return null;
}

export function buildWebTextWidgetInboundBody(args: {
  department: WebTextWidgetDepartment;
  name?: string | null;
  message: string;
  pageUrl?: string | null;
  pageTitle?: string | null;
}): string {
  const lines = [
    "WEB TEXT WIDGET",
    `Department: ${webTextWidgetDepartmentLabel(args.department)}`,
    args.name ? `Name: ${args.name}` : "",
    args.pageTitle ? `Page: ${args.pageTitle}` : "",
    args.pageUrl ? `URL: ${args.pageUrl}` : "",
    "",
    "Message:",
    args.message
  ];
  return lines.filter((line, idx) => idx >= 5 || String(line).trim()).join("\n").trim();
}

export function extractWebTextWidgetCustomerMessage(body: string): string {
  const text = String(body ?? "").trim();
  const match = text.match(/(?:^|\n)Message:\s*([\s\S]+)$/i);
  return String(match?.[1] ?? text).trim();
}

function extractWebTextWidgetPageTitle(body: string): string {
  const text = String(body ?? "").trim();
  const match = text.match(/(?:^|\n)Page:\s*([^\n]+)$/i);
  return String(match?.[1] ?? "").trim();
}

function titleCaseVehicleModel(raw: string): string {
  const clean = String(raw ?? "")
    .replace(/\bharley(?:-|\s+)?davidson\b/gi, "")
    .replace(/\bh-?d\b/gi, "")
    .replace(/\b(?:to\s+trade|for\s+trade|trade\s+in|taking\s+in\s+on\s+trade|(?:you|we)\s+are\s+taking\s+in\s+on\s+trade)\b[\s\S]*$/i, "")
    .replace(/\bthat\b[\s\S]*$/i, "")
    .replace(/\bi\s+(?:can|will|would|have|am|was)\b[\s\S]*$/i, "")
    .replace(/\b(?:with|if|for|thanks?|thank you)\b[\s\S]*$/i, "")
    .replace(/[^a-z0-9\s-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  return clean
    .split(/\s+/)
    .map(word => {
      const lower = word.toLowerCase();
      if (/^(cvo|flhxs|flhc|vin)$/.test(lower)) return lower.toUpperCase();
      return lower.replace(/^\w/, c => c.toUpperCase());
    })
    .join(" ");
}

function conditionFromText(raw: string, year?: string): "new" | "used" | undefined {
  const text = String(raw ?? "").toLowerCase();
  if (/\bbrand\s+new\b|\bnew\b/.test(text)) return "new";
  if (/\bused\b|\bpre[-\s]?owned\b/.test(text)) return "used";
  const numericYear = Number(year);
  const currentYear = new Date().getFullYear();
  if (Number.isFinite(numericYear) && numericYear > 1900 && numericYear < currentYear) return "used";
  return undefined;
}

function colorFromSalesWidgetText(text: string): string | undefined {
  const lower = String(text ?? "").toLowerCase();
  if (/\bblack\s+on\s+black\b/.test(lower)) return "Black on Black";
  const colorMatch = lower.match(
    /\b(?:its|it's|color(?: is)?|in)\s+((?:vivid\s+black|black|blue|red|white|gray|grey|silver|green|orange|yellow|purple|brown)(?:\s+on\s+(?:black|blue|red|white|gray|grey|silver|green|orange|yellow|purple|brown))?)\b/
  );
  const color = titleCaseVehicleModel(colorMatch?.[1] ?? "");
  return color || undefined;
}

function parseVehicleFromMatch(match: RegExpMatchArray | null, sourceText: string): WebTextWidgetVehicle | undefined {
  if (!match) return undefined;
  const year = String(match[1] ?? "").trim() || undefined;
  const model = titleCaseVehicleModel(String(match[2] ?? ""));
  if (!model) return undefined;
  return {
    ...(year ? { year } : {}),
    model,
    condition: conditionFromText(match[0] ?? sourceText, year)
  };
}

function extractVehicleFromWidgetPageTitle(pageTitle: string): WebTextWidgetVehicle | undefined {
  const title = String(pageTitle ?? "").trim();
  if (!title) return undefined;
  const productTitle = title.split("|")[0]?.trim() ?? title;
  const match = productTitle.match(
    /\b((?:19|20)\d{2})\s+Harley(?:-|\s+)?Davidson[®™]?\s+(.+?)(?:\s+(Vivid Black|Black on Black|Black|Blue|Red|White|Gray|Grey|Silver|Green|Orange|Yellow|Purple|Brown))?\s*$/i
  );
  if (!match) return undefined;
  const year = String(match[1] ?? "").trim();
  const model = titleCaseVehicleModel(String(match[2] ?? ""));
  const color = titleCaseVehicleModel(String(match[3] ?? ""));
  if (!model) return undefined;
  return {
    ...(year ? { year } : {}),
    model,
    ...(color ? { color } : {}),
    condition: conditionFromText(productTitle, year)
  };
}

export function extractWebTextWidgetSalesVehicleContext(message: string): WebTextWidgetSalesVehicleContext | null {
  const fullBody = String(message ?? "");
  const text = extractWebTextWidgetCustomerMessage(fullBody)
    .replace(/([a-z0-9])\.([A-Z])/g, "$1. $2")
    .replace(/\s+/g, " ")
    .trim();
  const pageTitle = extractWebTextWidgetPageTitle(fullBody);
  if (!text) return null;

  const requestedMatch = text.match(
    /\b(?:want(?:ed)?\s+to\s+buy|looking\s+(?:to\s+buy|at|for)|interested\s+in|buy)\s+(?:the|a|an|that)?\s*(?:brand\s+new|new|used|pre[-\s]?owned)?\s*(?:(?:vivid\s+black|black|blue|red|white|gray|grey|silver|green|orange|yellow|purple|brown)\s+)?((?:19|20)\d{2})?\s*([a-z0-9][a-z0-9\s-]{2,80}?)(?=(?:\s*[.!?])|\s+i\s+(?:have|can|will|would)\b|$)/i
  );
  const tradeMatch = text.match(
    /\b(?:i\s+have|i'?ve\s+got|my|trade(?:\s+in)?)\s+(?:a|an|the)?\s*(?:brand\s+new|new|used|pre[-\s]?owned)?\s*(?:(?:vivid\s+black|black|blue|red|white|gray|grey|silver|green|orange|yellow|purple|brown)\s+)?((?:19|20)\d{2})\s+([a-z0-9][a-z0-9\s-]{2,80}?)(?=\s+that\b|\s+i\s+(?:can|will|would)\b|[.!?]|$)/i
  );

  const requestedVehicle = parseVehicleFromMatch(requestedMatch, text) ?? extractVehicleFromWidgetPageTitle(pageTitle);
  const tradeVehicle = parseVehicleFromMatch(tradeMatch, text);
  if (tradeVehicle) {
    const color = colorFromSalesWidgetText(text);
    if (color) tradeVehicle.color = color;
  }
  const cash = /\bcash\b/i.test(text);
  const dealerIncomingTrade = /\b(?:taking|take|coming|came|took)\s+in\s+on\s+trade\b/i.test(text);
  const trade =
    !dealerIncomingTrade && /\btrade\b|\bmake a deal\b|\bsell\s+(?:my|the|our)\b|\bapprais/i.test(text);
  const sellOption = cash && trade ? "either" : cash ? "cash" : trade ? "trade" : undefined;
  if (!requestedVehicle && !tradeVehicle && !sellOption) return null;
  return {
    ...(requestedVehicle ? { requestedVehicle } : {}),
    ...(tradeVehicle ? { tradeVehicle } : {}),
    ...(sellOption ? { sellOption } : {})
  };
}

export function webTextWidgetSalesParserAccepted(parsed: WebTextWidgetSalesLeadParse | null): boolean {
  if (!parsed) return false;
  const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
  const min = Number(process.env.LLM_WEB_TEXT_WIDGET_SALES_CONFIDENCE_MIN ?? 0.74);
  if (confidence < min) return false;
  const hasRequested = !!String(parsed.requestedVehicle?.model ?? "").trim();
  const hasTrade = !!String(parsed.tradeVehicle?.model ?? "").trim();
  const hasSellOption = parsed.sellOption !== "none";
  return parsed.explicitRequest || hasRequested || hasTrade || hasSellOption;
}

function webTextWidgetParsedVehicleToContext(
  vehicle?: WebTextWidgetSalesLeadParse["requestedVehicle"]
): WebTextWidgetVehicle | undefined {
  const year = String(vehicle?.year ?? "").trim();
  const model = String(vehicle?.model ?? "").replace(/\s+/g, " ").trim();
  const color = String(vehicle?.color ?? "").replace(/\s+/g, " ").trim();
  const condition = vehicle?.condition === "new" || vehicle?.condition === "used" ? vehicle.condition : undefined;
  if (!year && !model && !color && !condition) return undefined;
  return {
    ...(year ? { year } : {}),
    ...(model ? { model } : {}),
    ...(color ? { color } : {}),
    ...(condition ? { condition } : {})
  };
}

/**
 * The typed parser's result as a context. It carries the parser's OWN verdict (parserIntent,
 * parserHasRequestedVehicle) alongside the slots, because that verdict is what
 * decideWebTextWidgetSalesClassification asks — not the department, and not a keyword scan
 * (+17169839279). This lives here rather than in index.ts so an eval can execute the whole chain
 * from a raw parse: a source-text pin could not tell that the verdict had stopped being carried.
 */
export function webTextWidgetParserResultToContext(
  parsed: WebTextWidgetSalesLeadParse | null
): WebTextWidgetSalesVehicleContext | null {
  if (!webTextWidgetSalesParserAccepted(parsed)) return null;
  const requestedVehicle = webTextWidgetParsedVehicleToContext(parsed?.requestedVehicle);
  const tradeVehicle = webTextWidgetParsedVehicleToContext(parsed?.tradeVehicle);
  const sellOption = parsed?.sellOption && parsed.sellOption !== "none" ? parsed.sellOption : undefined;
  if (!requestedVehicle && !tradeVehicle && !sellOption) return null;
  return {
    ...(requestedVehicle ? { requestedVehicle } : {}),
    ...(tradeVehicle ? { tradeVehicle } : {}),
    ...(sellOption ? { sellOption } : {}),
    ...(parsed?.intent ? { parserIntent: parsed.intent } : {}),
    ...(requestedVehicle ? { parserHasRequestedVehicle: true } : {})
  };
}

/**
 * Merge the typed parser's read of a widget sales lead with the regex extractor's, and it is the
 * PARSER that owns "is there a bike this customer wants to buy".
 *
 * Beverly Hennig (+17169839279, 2026-08-05) asked "Do you take used Harley's on consignment or buy
 * outright?" — the extractor's requested-vehicle regex has a bare `buy` alternative, so "or buy
 * outright?" minted a phantom bike called "Outright" into lead.vehicle AND conv.inventoryContext,
 * which is draft context: the widget ack fallback narrates conv.inventoryContext.model straight back
 * at the customer. The extractor's answer then UNCONDITIONALLY overrode the parser's, which had read
 * her correctly as a seller.
 *
 * So: on a positive sell-side verdict the extractor's requested vehicle is dropped. Every other
 * case keeps today's precedence exactly — an unaccepted parse (null parsedContext) still falls back
 * to the extractor, and a parser that DID name a requested vehicle still yields the model text to
 * the extractor. One behaviour delta, in the direction of comprehension over keywords.
 */
export function mergeWebTextWidgetSalesContext(
  parsedContext: WebTextWidgetSalesVehicleContext | null,
  extractedContext: WebTextWidgetSalesVehicleContext | null,
  customerText: string
): WebTextWidgetSalesVehicleContext | null {
  if (!parsedContext) return extractedContext;
  if (!extractedContext) return parsedContext;
  const sellSide = decideWebTextWidgetSalesClassification({
    department: "sales",
    parserIntent: parsedContext.parserIntent ?? null,
    parserHasRequestedVehicle: !!parsedContext.parserHasRequestedVehicle
  }).sellSide;
  const requestedVehicle = sellSide
    ? undefined
    : extractedContext.requestedVehicle ?? parsedContext.requestedVehicle;
  const hasExplicitTradeSignal =
    !!extractedContext.tradeVehicle ||
    !!extractedContext.sellOption ||
    /\btrade\b|\bsell\s+(?:my|the|our)\b|\bcash\b|\bmake a deal\b|\bapprais/i.test(customerText);
  const tradeVehicle = hasExplicitTradeSignal
    ? extractedContext.tradeVehicle ?? parsedContext.tradeVehicle
    : undefined;
  const sellOption = hasExplicitTradeSignal
    ? extractedContext.sellOption ?? parsedContext.sellOption
    : extractedContext.sellOption;
  const merged: WebTextWidgetSalesVehicleContext = {
    ...(requestedVehicle ? { requestedVehicle } : {}),
    ...(tradeVehicle ? { tradeVehicle } : {}),
    ...(sellOption ? { sellOption } : {}),
    ...(parsedContext.parserIntent ? { parserIntent: parsedContext.parserIntent } : {}),
    ...(parsedContext.parserHasRequestedVehicle ? { parserHasRequestedVehicle: true } : {})
  };
  return Object.keys(merged).length ? merged : null;
}

function formatWidgetVehicle(vehicle?: WebTextWidgetVehicle): string {
  if (!vehicle) return "";
  return [vehicle.year, vehicle.model].filter(Boolean).join(" ").trim();
}

export function buildWebTextWidgetSalesBuyTradeDraft(args: {
  firstName?: string | null;
  context: WebTextWidgetSalesVehicleContext | null;
}): string | null {
  const requested = formatWidgetVehicle(args.context?.requestedVehicle);
  const trade = formatWidgetVehicle(args.context?.tradeVehicle);
  if (!requested || !trade) return null;
  const firstName = String(args.firstName ?? "").trim() || "there";
  return (
    `Hi ${firstName} - thanks for reaching out. ` +
    `I can help with the ${requested} and take a look at your ${trade} trade. ` +
    "Send over the VIN and photos when you can, and I'll have the team confirm the bike details and trade options."
  );
}

function widgetMessageHasPriceOrAvailabilityIntent(message: string): {
  price: boolean;
  availability: boolean;
} {
  const text = extractWebTextWidgetCustomerMessage(message).toLowerCase();
  return {
    price: /\b(price|pricing|cost|how much|quote)\b/.test(text),
    availability: /\b(available|availability|still available|still there|in stock)\b/.test(text)
  };
}

export function buildWebTextWidgetRequestedVehicleDraft(args: {
  firstName?: string | null;
  message: string;
  context: WebTextWidgetSalesVehicleContext | null;
}): string | null {
  const requested = formatWidgetVehicle(args.context?.requestedVehicle);
  if (!requested || args.context?.tradeVehicle) return null;
  const firstName = String(args.firstName ?? "").trim() || "there";
  const intent = widgetMessageHasPriceOrAvailabilityIntent(args.message);
  if (!intent.price && !intent.availability) return null;
  if (intent.price && intent.availability) {
    return `Hi ${firstName} - thanks for reaching out. I'll have the team confirm the current price and availability on the ${requested} and send it over.`;
  }
  if (intent.availability) {
    return `Hi ${firstName} - thanks for reaching out. I'll have the team confirm availability on the ${requested} and send it over.`;
  }
  return `Hi ${firstName} - thanks for reaching out. I'll have the team confirm the current price on the ${requested} and send it over.`;
}
