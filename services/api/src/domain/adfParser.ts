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
  inquiry?: string;
  stockId?: string;
  vin?: string;
  year?: string;
  vehicleDescription?: string;
  vehicleColor?: string;
  purchaseTimeframe?: string;
  hasMotoLicense?: boolean;
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

function stripHtml(s: string): string {
  return s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim();
}

function parseFromComment(comment?: string) {
  if (!comment) return {};
  const clean = stripHtml(comment);
  const inquiryMatch = clean.match(/your inquiry:\s*([^\n\r]+)/i);
  const stockMatch = clean.match(/inventory stock id:\s*([A-Z0-9-]+)/i);
  const vinMatch = clean.match(/vin:\s*([A-HJ-NPR-Z0-9]{8,17})/i);
  const yearMatch = clean.match(/inventory year:\s*(\d{4})/i);
  const itemMatch = clean.match(/inventory item:\s*([^\n\r]+)/i);
  const itemColor = extractColorFromDescription(
    itemMatch?.[1]?.trim(),
    stockMatch?.[1]?.trim() ?? null
  );
  const colorMatch = clean.match(/color:\s*([^\n\r]+)/i);
  const phoneMatch = clean.match(/phone:\s*([0-9\-\s\(\)\.]+)/i);
  const emailMatch = clean.match(/email:\s*([^\s\n\r]+)/i);
  const timeframeMatch = clean.match(/purchase timeframe:\s*([^\n\r]+)/i);
  const licenseMatch = clean.match(/valid motorcycle license\?\s*(yes|no)/i);
  const mileageMatch = clean.match(/mileage:\s*([0-9,]+)/i);
  const optionsMatch = clean.match(/options:\s*([^\n\r]+)/i);
  const optionsRaw = optionsMatch?.[1]?.trim().toLowerCase();
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
    year: yearMatch?.[1]?.trim(),
    item: itemMatch?.[1]?.trim(),
    color: colorMatch?.[1]?.trim() ?? itemColor,
    phone: phoneMatch?.[1]?.trim(),
    email: emailMatch?.[1]?.trim(),
    purchaseTimeframe: timeframeMatch?.[1]?.trim(),
    hasMotoLicense: licenseMatch ? licenseMatch[1].toLowerCase() === "yes" : undefined,
    mileage,
    sellOption
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
  const vin = text(vehicle?.vin) ?? parsedFromComment.vin;
  const stockId =
    text(vehicle?.stock) ?? text(vehicle?.stock_id) ?? text(vehicle?.stockid) ?? parsedFromComment.stockId;
  const year = text(vehicle?.year) ?? parsedFromComment.year;

  const vehicleDescription =
    [text(vehicle?.make), text(vehicle?.model), text(vehicle?.trim)]
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
  return {
    leadRef,
    firstName,
    lastName,
    email: finalEmail,
    phone: finalPhone,
    street,
    city,
    region,
    postal,
    mileage,
    sellOption: parsedFromComment.sellOption,
    inquiry,
    stockId,
    vin,
    year,
    vehicleDescription: desc,
    vehicleColor,
    purchaseTimeframe: parsedFromComment.purchaseTimeframe,
    hasMotoLicense: parsedFromComment.hasMotoLicense
  };
}
