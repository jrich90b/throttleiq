import { XMLParser } from "fast-xml-parser";

export type ParsedAdfLead = {
  leadRef?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  street?: string;
  city?: string;
  region?: string;
  postal?: string;
  mileage?: number;
  sellOption?: "cash" | "trade" | "either";
  leadSourceId?: number;
  inquiry?: string;
  comment?: string;
  stockId?: string;
  vin?: string;
  year?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleTrim?: string;
  vehicleDescription?: string;
  vehicleColor?: string;
  vehicleCondition?: "new" | "used";
  purchaseTimeframe?: string;
  hasMotoLicense?: boolean;
  emailOptIn?: boolean;
  smsOptIn?: boolean;
  phoneOptIn?: boolean;
  preferredContactMethod?: "email" | "sms" | "phone";
  preferredDate?: string;
  preferredTime?: string;
  tradeVehicle?: {
    year?: string;
    make?: string;
    model?: string;
    vin?: string;
    mileage?: number;
    color?: string;
    description?: string;
  };
};

function asArray<T>(v: T | T[] | undefined): T[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function text(v: any): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    if (typeof v["#text"] === "string") return v["#text"].trim();
  }
  return undefined;
}

function attr(v: any, name: string): string | undefined {
  if (!v || typeof v !== "object") return undefined;
  const direct = v[`@_${name}`] ?? v[name];
  if (typeof direct === "string") return direct.trim();
  return undefined;
}

function pickByType(list: any[], type: string): any | undefined {
  return list.find(v => {
    const t = attr(v, "type") ?? attr(v, "Type");
    return t?.toLowerCase().includes(type);
  });
}

function pickVehicle(v: any): any {
  if (!Array.isArray(v)) return v ?? {};
  const byInterest = v.find(x => (attr(x, "interest") ?? "").toLowerCase() === "buy");
  if (byInterest) return byInterest;
  const byStock = v.find(x => text(x?.stock) || text(x?.vin) || text(x?.year));
  return byStock ?? v[0] ?? {};
}

function pickTradeVehicle(v: any): any | null {
  if (!Array.isArray(v)) return null;
  const byInterest = v.find(x => (attr(x, "interest") ?? "").toLowerCase().includes("trade"));
  return byInterest ?? null;
}

function stripHtml(s: string): string {
  return s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim();
}

function normalizeCondition(raw?: string): "new" | "used" | undefined {
  if (!raw) return undefined;
  const t = raw.toLowerCase();
  if (t.includes("used") || t.includes("pre-owned") || t.includes("preowned")) return "used";
  if (t.includes("new")) return "new";
  return undefined;
}

function normalizeMake(raw?: string): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  if (!t) return undefined;
  if (/^harley[-\s]?davidson$/i.test(t) || /^h[-\s]?d$/i.test(t)) return "Harley-Davidson";
  return t;
}

function toTitleCase(input: string): string {
  return input
    .toLowerCase()
    .replace(/\b\w/g, char => char.toUpperCase());
}

function normalizeDisplayCase(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed) return undefined;
  const letters = trimmed.replace(/[^A-Za-z]/g, "");
  if (!letters) return trimmed;
  return letters === letters.toUpperCase() ? toTitleCase(trimmed) : trimmed;
}

function parseColorTrimFromItem(item?: string) {
  if (!item) return {};
  let working = item.replace(/\s+/g, " ").trim();
  if (!working) return {};

  let trim: string | undefined;
  const trimMatch = working.match(/\b([A-Za-z0-9][A-Za-z0-9\s&-]{0,40})\s+Trim\b/i);
  if (trimMatch?.[0]) {
    trim = trimMatch[0].trim();
    working = working.replace(trimMatch[0], " ").trim();
  }

  working = working.replace(/\b(19|20)\d{2}\b/g, " ").trim();
  working = working.replace(/\b[A-Z]{2,5}\d{0,3}\b/g, " ").trim();
  working = working.replace(/\bharley[-\s]?davidson\b/gi, " ").replace(/\bh[-\s]?d\b/gi, " ");
  working = working.replace(/\s+/g, " ").trim();

  let color: string | undefined;
  if (working) {
    const tokens = working.split(/\s+/);
    const colorKeywords = [
      "Black",
      "White",
      "Red",
      "Blue",
      "Gray",
      "Grey",
      "Silver",
      "Gold",
      "Green",
      "Orange",
      "Yellow",
      "Purple",
      "Pink",
      "Pearl",
      "Ember",
      "Billiard",
      "Whiskey",
      "Cobalt",
      "Sapphire",
      "Teal",
      "Sky",
      "Sand",
      "Ice",
      "Storm",
      "Azure",
      "Crimson",
      "Charcoal",
      "Denim",
      "Eclipse",
      "Sunset",
      "Midnight",
      "Stiletto",
      "Abyss",
      "Smoke",
      "Frost",
      "Gunship",
      "Atlas",
      "Metallic"
    ];
    for (let len = Math.min(3, tokens.length); len >= 1; len--) {
      const candidate = tokens.slice(-len).join(" ");
      if (colorKeywords.some(k => candidate.toLowerCase().includes(k.toLowerCase()))) {
        color = candidate.trim();
        break;
      }
    }
  }

  return { color, trim };
}

function parseFromComment(comment?: string) {
  if (!comment) return {};
  const clean = stripHtml(comment);
  const parsePreferredContactMethod = (text: string): "email" | "sms" | "phone" | undefined => {
    const normalized = String(text ?? "").toLowerCase();
    if (!normalized) return undefined;
    const explicitMatch = normalized.match(
      /preferred contact method\s*[:\-]?\s*(email|e-mail|text|sms|phone|call|voice)/i
    );
    const token = explicitMatch?.[1]?.toLowerCase();
    if (token) {
      if (token === "email" || token === "e-mail") return "email";
      if (token === "text" || token === "sms") return "sms";
      if (token === "phone" || token === "call" || token === "voice") return "phone";
    }
    if (/\b(email|e-mail)\s+only\b/.test(normalized)) return "email";
    if (/\b(text|sms)\s+only\b/.test(normalized)) return "sms";
    if (/\b(phone|call|voice)\s+only\b/.test(normalized)) return "phone";
    return undefined;
  };
  const inquiryMatch = clean.match(/your inquiry:\s*([^\n\r]+)/i);
  const stockMatch = clean.match(/inventory stock id:\s*([A-Z0-9-]+)/i);
  const vinMatch = clean.match(/vin:\s*([A-HJ-NPR-Z0-9]{8,17})/i);
  const yearMatch = clean.match(/inventory year:\s*(\d{4})/i);
  const modelYearMatch = clean.match(/model year:\s*(\d{4})/i);
  const itemMatch = clean.match(/inventory item:\s*([^\n\r]+)/i);
  const itemDetails = parseColorTrimFromItem(itemMatch?.[1]?.trim());
  const itemColor = extractColorFromDescription(
    itemMatch?.[1]?.trim(),
    stockMatch?.[1]?.trim() ?? null
  );
  const colorMatch = clean.match(/color:\s*([^\n\r]+)/i);
  const makeMatch = clean.match(/\bmake\s*:\s*([^\n\r,]+)/i);
  const modelMatch = clean.match(/\bmodel\s*:\s*([^\n\r,]+)/i);
  const trimMatch = clean.match(/\btrim\s*:\s*([^\n\r,]+)/i);
  const statusMatch = clean.match(/status\s*[:=]\s*\"?(new|used|pre[-\s]?owned)\"?/i);
  const phoneMatch = clean.match(/phone:\s*([0-9\-\s\(\)\.]+)/i);
  const emailMatch = clean.match(/email:\s*([^\s\n\r]+)/i);
  const timeframeMatch = clean.match(/purchase timeframe:\s*([^\n\r]+)/i);
  const licenseMatch = clean.match(/valid motorcycle license\?\s*(yes|no)/i);
  const mileageMatch = clean.match(/mileage:\s*([0-9,]+)/i);
  const optionsMatch = clean.match(/options:\s*([^\n\r]+)/i);
  const optionsRaw = optionsMatch?.[1]?.trim().toLowerCase();
  const preferredDateMatch = clean.match(/preferred date:\s*([^\n\r]+)/i);
  const preferredTimeMatch = clean.match(/preferred time:\s*([^\n\r]+)/i);
  const emailOptInMatch =
    clean.match(/email opt-?in:\s*(yes|no)/i) ||
    clean.match(/can we contact you via email\?:\s*(yes|no)/i);
  const phoneOptInMatch =
    clean.match(/phone opt-?in:\s*(yes|no)/i) ||
    clean.match(/can we contact you via phone\?:\s*(yes|no)/i);
  const smsOptInMatch =
    clean.match(/text opt-?in:\s*(yes|no)/i) ||
    clean.match(/can we contact you via text\?:\s*(yes|no)/i);
  const preferredContactMethod = parsePreferredContactMethod(clean);
  const sourceIdMatch = clean.match(/source id:\s*(\d+)/i);
  const leadSourceId = sourceIdMatch?.[1] ? Number(sourceIdMatch[1]) : undefined;
  let sellOption: "cash" | "trade" | "either" | undefined;
  if (optionsRaw) {
    if (optionsRaw.includes("cash")) sellOption = "cash";
    else if (optionsRaw.includes("trade")) sellOption = "trade";
    else if (optionsRaw.includes("open")) sellOption = "either";
  }
  const mileage =
    mileageMatch?.[1] != null ? Number(mileageMatch[1].replace(/,/g, "")) : undefined;
  return {
    inquiry: inquiryMatch?.[1]?.trim(),
    stockId: stockMatch?.[1]?.trim(),
    vin: vinMatch?.[1]?.trim(),
    year: yearMatch?.[1]?.trim() ?? modelYearMatch?.[1]?.trim(),
    item: itemMatch?.[1]?.trim(),
    make: normalizeMake(makeMatch?.[1]?.trim()),
    model: modelMatch?.[1]?.trim(),
    trim: trimMatch?.[1]?.trim() ?? itemDetails.trim,
    color: colorMatch?.[1]?.trim() ?? itemDetails.color ?? itemColor,
    condition: normalizeCondition(statusMatch?.[1]),
    phone: phoneMatch?.[1]?.trim(),
    email: emailMatch?.[1]?.trim(),
    purchaseTimeframe: timeframeMatch?.[1]?.trim(),
    hasMotoLicense: licenseMatch ? licenseMatch[1].toLowerCase() === "yes" : undefined,
    mileage,
    sellOption,
    leadSourceId,
    preferredDate: preferredDateMatch?.[1]?.trim(),
    preferredTime: preferredTimeMatch?.[1]?.trim(),
    emailOptIn: emailOptInMatch ? emailOptInMatch[1].toLowerCase() === "yes" : undefined,
    phoneOptIn: phoneOptInMatch ? phoneOptInMatch[1].toLowerCase() === "yes" : undefined,
    smsOptIn: smsOptInMatch ? smsOptInMatch[1].toLowerCase() === "yes" : undefined,
    preferredContactMethod
  };
}

function extractColorFromDescription(desc?: string | null, stockId?: string | null): string | undefined {
  if (!desc) return undefined;
  const clean = desc.replace(/\s+/g, " ").trim();
  if (stockId) {
    const idx = clean.toLowerCase().indexOf(stockId.toLowerCase());
    if (idx >= 0) {
      const tail = clean.slice(idx + stockId.length).trim();
      if (tail && tail.length <= 80) {
        return tail.replace(/^(two[-\s]?tone)\s+/i, "").trim();
      }
    }
  }
  const colorMatch = clean.match(/color[:\-\s]+(.+)$/i);
  if (colorMatch?.[1]) return colorMatch[1].trim();
  return undefined;
}

function findAdfInBlob(blob: string): string | null {
  const lower = blob.toLowerCase();
  const start = lower.indexOf("<adf");
  const end = lower.lastIndexOf("</adf>");
  if (start === -1 || end === -1) return null;
  return blob.slice(start, end + "</adf>".length);
}

function decodeQuotedPrintable(input: string): string {
  if (!input) return "";
  const softBreak = input.replace(/=\s*\r?\n/g, "");
  return softBreak.replace(/=([A-Fa-f0-9]{2})/g, (_m, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

export function extractAdfXmlFromEmail(textBody?: string, htmlBody?: string): string | null {
  const blob = [textBody, htmlBody].filter(Boolean).join("\n");
  let found = findAdfInBlob(blob);
  if (found) return decodeQuotedPrintable(found);

  const unescaped = blob
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  found = findAdfInBlob(unescaped);
  if (found) return decodeQuotedPrintable(found);

  const qp = decodeQuotedPrintable(unescaped);
  found = findAdfInBlob(qp);
  return found ? decodeQuotedPrintable(found) : null;
}

export function parseAdfXml(adfXml: string): ParsedAdfLead {
  const cleaned = decodeQuotedPrintable(adfXml);
  const parser = new XMLParser({ ignoreAttributes: false });
  const doc = parser.parse(cleaned);
  const adf = doc?.adf ?? doc;
  const prospect = adf?.prospect;
  let leadRef = text(prospect?.id);
  if (!leadRef) {
    const match = cleaned.match(/<prospect[^>]*>[\s\S]*?<id[^>]*>([^<]+)<\/id>/i);
    leadRef = match?.[1]?.trim();
  }

  const customer = prospect?.customer;
  const contactList = asArray(customer?.contact);
  const contact =
    contactList.find(c => c?.phone || c?.email || c?.name) ?? contactList[0];

  const nameNodes = asArray(contact?.name);
  let firstName: string | undefined;
  let lastName: string | undefined;
  for (const n of nameNodes) {
    const part = attr(n, "part")?.toLowerCase();
    const value = text(n);
    if (!value) continue;
    if (part === "first") firstName = value;
    else if (part === "last") lastName = value;
    else if (part === "full" && (!firstName || !lastName)) {
      const [f, ...rest] = value.split(/\s+/);
      if (!firstName) firstName = f;
      if (!lastName && rest.length) lastName = rest.join(" ");
    }
  }
  firstName = normalizeDisplayCase(firstName);
  lastName = normalizeDisplayCase(lastName);

  const emails = asArray(contact?.email);
  const email = text(emails[0]);

  const phones = asArray(contact?.phone);
  const preferredPhone = pickByType(phones, "cell") ?? pickByType(phones, "mobile") ?? phones[0];
  const phone = text(preferredPhone);
  const address = contact?.address ?? {};
  const street = text(address?.street?.[0] ?? address?.street ?? address?.line1 ?? address?.line);
  const city = text(address?.city);
  const region = text(address?.regioncode ?? address?.region ?? address?.state);
  const postal = text(address?.postalcode ?? address?.postal);

  const request = prospect?.request ?? {};
  const commentText = text(contact?.comment) ?? text(request?.comment) ?? text(request?.comments);
  const parsedFromComment = parseFromComment(commentText);
  const inquiry =
    parsedFromComment.inquiry ??
    text(request?.comments) ??
    text(request?.comment) ??
    text(prospect?.comments) ??
    undefined;

  const vehicleRaw = prospect?.vehicle ?? request?.vehicle ?? {};
  const vehicle = pickVehicle(vehicleRaw);
  const tradeVehicleRaw = pickTradeVehicle(vehicleRaw);
  const vin = text(vehicle?.vin) ?? parsedFromComment.vin;
  const stockId =
    text(vehicle?.stock) ?? text(vehicle?.stock_id) ?? text(vehicle?.stockid) ?? parsedFromComment.stockId;
  const year = text(vehicle?.year) ?? parsedFromComment.year;
  let vehicleMake = normalizeMake(text(vehicle?.make)) ?? parsedFromComment.make;
  let vehicleModel = text(vehicle?.model) ?? parsedFromComment.model;
  if (vehicleModel) {
    const makeInModelMatch = vehicleModel.match(/\b(harley[-\s]?davidson|h[-\s]?d)\b/i);
    if (makeInModelMatch) {
      vehicleMake = "Harley-Davidson";
      vehicleModel = vehicleModel.replace(makeInModelMatch[0], "").trim();
    }
    vehicleModel = vehicleModel.replace(/^[\s\-–—:,]+|[\s\-–—:,]+$/g, "").trim();
  }
  vehicleModel = normalizeDisplayCase(vehicleModel);
  let vehicleTrim = text(vehicle?.trim) ?? parsedFromComment.trim;
  vehicleTrim = normalizeDisplayCase(vehicleTrim);
  const vehicleCondition =
    normalizeCondition(attr(vehicle, "status") ?? attr(vehicleRaw, "status")) ??
    parsedFromComment.condition;

  const vehicleDescription =
    [vehicleMake, vehicleModel, vehicleTrim]
      .filter(Boolean)
      .join(" ") || text(vehicle?.description);
  const odometerRaw = text(vehicle?.odometer);
  const odometerVal =
    odometerRaw != null ? Number(String(odometerRaw).replace(/,/g, "")) : undefined;
  const mileage = odometerVal ?? parsedFromComment.mileage;

  const desc = vehicleDescription || parsedFromComment.item;
  const vehicleColor =
    parsedFromComment.color ??
    extractColorFromDescription(desc, stockId ?? parsedFromComment.stockId ?? null);
  const textOnly = stripHtml(cleaned);
  const emailFromText = textOnly.match(/email:\s*([^\s\n\r]+)/i)?.[1]?.trim();
  const phoneFromText = textOnly.match(/phone:\s*([0-9][0-9\-\s\(\)\.]+)/i)?.[1]?.trim();
  const finalEmail =
    email ??
    parsedFromComment.email ??
    cleaned.match(/<email[^>]*>([^<]+)<\/email>/i)?.[1]?.trim() ??
    emailFromText;
  const finalPhone =
    phone ??
    parsedFromComment.phone ??
    cleaned.match(/<phone[^>]*>([^<]+)<\/phone>/i)?.[1]?.trim() ??
    phoneFromText;

  let tradeVehicle: ParsedAdfLead["tradeVehicle"] | undefined;
  if (tradeVehicleRaw) {
    const tradeYear = text(tradeVehicleRaw?.year);
    const tradeMake = text(tradeVehicleRaw?.make);
    let tradeModel = text(tradeVehicleRaw?.model);
    const tradeVin = text(tradeVehicleRaw?.vin);
    const tradeOdometerRaw = text(tradeVehicleRaw?.odometer);
    const tradeMileage =
      tradeOdometerRaw != null ? Number(String(tradeOdometerRaw).replace(/,/g, "")) : undefined;
    tradeModel = normalizeDisplayCase(tradeModel);
    const tradeDesc =
      [tradeMake, tradeModel].filter(Boolean).join(" ") ||
      text(tradeVehicleRaw?.description) ||
      undefined;
    tradeVehicle = {
      year: tradeYear,
      make: tradeMake,
      model: tradeModel,
      vin: tradeVin,
      mileage: tradeMileage,
      description: tradeDesc
    };
  }
  return {
    leadRef,
    firstName,
    lastName,
    email: finalEmail,
    phone: finalPhone,
    emailOptIn: parsedFromComment.emailOptIn,
    phoneOptIn: parsedFromComment.phoneOptIn,
    smsOptIn: parsedFromComment.smsOptIn,
    preferredContactMethod: parsedFromComment.preferredContactMethod,
    street,
    city,
    region,
    postal,
    mileage,
    sellOption: parsedFromComment.sellOption,
    leadSourceId: parsedFromComment.leadSourceId,
    inquiry,
    comment: commentText ?? undefined,
    stockId,
    vin,
    year,
    vehicleMake,
    vehicleModel,
    vehicleTrim,
    vehicleDescription: desc,
    vehicleColor,
    vehicleCondition,
    purchaseTimeframe: parsedFromComment.purchaseTimeframe,
    hasMotoLicense: parsedFromComment.hasMotoLicense,
    preferredDate: parsedFromComment.preferredDate,
    preferredTime: parsedFromComment.preferredTime,
    tradeVehicle
  };
}
