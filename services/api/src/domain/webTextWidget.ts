export type WebTextWidgetDepartment = "sales" | "service" | "parts" | "apparel";

export type WebTextWidgetClassification = {
  bucket: "inventory_interest" | "service" | "parts" | "apparel";
  cta: "check_availability" | "service_request" | "parts_request" | "apparel_request";
};

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

export function webTextWidgetClassification(
  department: WebTextWidgetDepartment
): WebTextWidgetClassification {
  if (department === "service") return { bucket: "service", cta: "service_request" };
  if (department === "parts") return { bucket: "parts", cta: "parts_request" };
  if (department === "apparel") return { bucket: "apparel", cta: "apparel_request" };
  return { bucket: "inventory_interest", cta: "check_availability" };
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

function titleCaseVehicleModel(raw: string): string {
  const clean = String(raw ?? "")
    .replace(/\bharley(?:-|\s+)?davidson\b/gi, "")
    .replace(/\bh-?d\b/gi, "")
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
  const colorMatch = lower.match(/\b(?:its|it's|color(?: is)?|in)\s+([a-z]+(?:\s+on\s+[a-z]+)?)\b/);
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

export function extractWebTextWidgetSalesVehicleContext(message: string): WebTextWidgetSalesVehicleContext | null {
  const text = extractWebTextWidgetCustomerMessage(message)
    .replace(/([a-z0-9])\.([A-Z])/g, "$1. $2")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;

  const requestedMatch = text.match(
    /\b(?:want(?:ed)?\s+to\s+buy|looking\s+(?:to\s+buy|at|for)|interested\s+in|buy)\s+(?:the|a|an)?\s*((?:19|20)\d{2})?\s*([a-z0-9][a-z0-9\s-]{2,80}?)(?=(?:\s*[.!?])|\s+i\s+(?:have|can|will|would)\b|$)/i
  );
  const tradeMatch = text.match(
    /\b(?:i\s+have|i'?ve\s+got|my|trade(?:\s+in)?)\s+(?:a|an|the)?\s*(?:brand\s+new|new|used|pre[-\s]?owned)?\s*((?:19|20)\d{2})\s+([a-z0-9][a-z0-9\s-]{2,80}?)(?=\s+that\b|\s+i\s+(?:can|will|would)\b|[.!?]|$)/i
  );

  const requestedVehicle = parseVehicleFromMatch(requestedMatch, text);
  const tradeVehicle = parseVehicleFromMatch(tradeMatch, text);
  if (tradeVehicle) {
    const color = colorFromSalesWidgetText(text);
    if (color) tradeVehicle.color = color;
  }
  const cash = /\bcash\b/i.test(text);
  const trade = /\btrade\b|\bmake a deal\b/i.test(text);
  const sellOption = cash && trade ? "either" : cash ? "cash" : trade ? "trade" : undefined;
  if (!requestedVehicle && !tradeVehicle && !sellOption) return null;
  return {
    ...(requestedVehicle ? { requestedVehicle } : {}),
    ...(tradeVehicle ? { tradeVehicle } : {}),
    ...(sellOption ? { sellOption } : {})
  };
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
