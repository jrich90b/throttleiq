import {
  findInventoryMatches,
  findInventoryPrice,
  getInventoryFeed,
  type InventoryFeedItem
} from "./inventoryFeed.js";

type VehicleFactDecisionLike = {
  questionType: string;
  requestedFields?: string[];
};

type InventoryFactAnswer = {
  handled: boolean;
  reply?: string;
  needsTodo?: boolean;
  todoReason?: string;
  todoSummary?: string;
  item?: InventoryFeedItem | null;
};

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeModelForMatch(value: unknown): string {
  return normalizeText(value)
    .replace(/\bharley[-\s]?davidson\b/gi, "")
    .replace(/\bh[-\s]?d\b/gi, "")
    .replace(/^[-:,\s]+|[-:,\s]+$/g, "")
    .trim();
}

function normalizeCondition(value: unknown): string {
  return normalizeText(value).toLowerCase();
}

function formatMoney(value: unknown): string | null {
  const numeric =
    typeof value === "string"
      ? Number(value.replace(/[^\d.]/g, ""))
      : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(numeric);
}

function scoreVehicleForLookup(vehicle: any): number {
  if (!vehicle) return 0;
  let score = 0;
  if (normalizeText(vehicle.stockId ?? vehicle.stock)) score += 8;
  if (normalizeText(vehicle.vin)) score += 8;
  if (normalizeText(vehicle.year)) score += 2;
  if (normalizeModelForMatch(vehicle.model ?? vehicle.description)) score += 2;
  if (normalizeText(vehicle.color)) score += 1;
  if (normalizeCondition(vehicle.condition) && normalizeCondition(vehicle.condition) !== "new_model_interest") score += 1;
  return score;
}

function pickBestVehicleForLookup(conv: any): any {
  const candidates = [
    conv?.latestLead?.vehicle,
    conv?.lead?.vehicle,
    conv?.originalLead?.vehicle
  ].filter(Boolean);
  return candidates
    .map((vehicle, index) => ({ vehicle, index, score: scoreVehicleForLookup(vehicle) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.vehicle ?? {};
}

function formatUnitLabel(conv: any, item?: InventoryFeedItem | null, sourceVehicle?: any): string {
  const leadVehicle = sourceVehicle ?? pickBestVehicleForLookup(conv);
  const year = normalizeText(item?.year ?? leadVehicle?.year);
  const model =
    normalizeModelForMatch(item?.model ?? leadVehicle?.model ?? leadVehicle?.description) ||
    "bike";
  return [year, model].filter(Boolean).join(" ").trim() || "bike";
}

function parseRequestedApr(text: string): number | null {
  const match = text.match(/\b(\d+(?:\.\d+)?)\s*%?\s*(?:apr|interest|rate)\b/i);
  const value = Number(match?.[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parseRequestedPriceCap(text: string): number | null {
  const match = text.match(
    /\b(?:under|below|less than|up to|max(?:imum)?|cap(?:ped)? at)\s*\$?\s*([1-9]\d{1,2}(?:,\d{3})+|[1-9]\d{3,5}|[1-9]\d?)\s*k?\b/i
  );
  if (!match?.[1]) return null;
  const raw = match[1].replace(/,/g, "");
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (/\bk\b/i.test(match[0]) && value < 1000) return value * 1000;
  return value;
}

async function resolveConversationInventoryItem(conv: any): Promise<{
  item: InventoryFeedItem | null;
  price: number | null;
  sourceVehicle: any;
}> {
  const leadVehicle = pickBestVehicleForLookup(conv);
  const stockId = normalizeText(leadVehicle?.stockId ?? leadVehicle?.stock);
  const vin = normalizeText(leadVehicle?.vin);
  const year = normalizeText(leadVehicle?.year);
  const model = normalizeModelForMatch(leadVehicle?.model ?? leadVehicle?.description);

  const exact = await findInventoryPrice({
    stockId: stockId || null,
    vin: vin || null,
    year: year || null,
    model: model || null
  });
  if (exact?.item) {
    return { item: exact.item, price: exact.price ?? exact.item.price ?? null, sourceVehicle: leadVehicle };
  }

  const items = await getInventoryFeed();
  if (stockId || vin) {
    const direct =
      items.find(item => stockId && normalizeText(item.stockId).toLowerCase() === stockId.toLowerCase()) ??
      items.find(item => vin && normalizeText(item.vin).toLowerCase() === vin.toLowerCase()) ??
      null;
    if (direct) return { item: direct, price: direct.price ?? null, sourceVehicle: leadVehicle };
  }

  if (model) {
    const matches =
      (await findInventoryMatches({ year: year || null, model })) ??
      [];
    if (matches.length) return { item: matches[0], price: matches[0].price ?? null, sourceVehicle: leadVehicle };
  }

  const leadPrice = Number(leadVehicle?.listPrice ?? leadVehicle?.price);
  return {
    item: null,
    price: Number.isFinite(leadPrice) && leadPrice > 0 ? leadPrice : null,
    sourceVehicle: leadVehicle
  };
}

function isLikelyLowAprEligible(item: InventoryFeedItem | null, conv: any): {
  modelYearEligible: boolean;
  isNew: boolean;
  year: string;
} {
  const leadVehicle = conv?.lead?.vehicle ?? {};
  const year = normalizeText(item?.year ?? leadVehicle?.year);
  const condition = normalizeCondition(item?.condition ?? leadVehicle?.condition);
  const isNew = !condition || condition.includes("new");
  const modelYearEligible = isNew && (year === "2024" || year === "2025");
  return { modelYearEligible, isNew, year };
}

export async function buildInventoryBackedVehicleFactAnswer(args: {
  conv: any;
  decision: VehicleFactDecisionLike;
  text: string;
}): Promise<InventoryFactAnswer> {
  const questionType = String(args.decision?.questionType ?? "");
  if (
    questionType !== "price" &&
    questionType !== "otd_total" &&
    questionType !== "finance_program_eligibility"
  ) {
    return { handled: false };
  }

  const { item, price, sourceVehicle } = await resolveConversationInventoryItem(args.conv);
  const unitLabel = formatUnitLabel(args.conv, item, sourceVehicle);
  const priceText = formatMoney(price);

  if (questionType === "price" || questionType === "otd_total") {
    if (priceText) {
      const exactTotal =
        questionType === "otd_total"
          ? " I’ll still confirm the exact out-the-door total with tax and fees."
          : "";
      return {
        handled: true,
        reply: `The listed price on the ${unitLabel} is ${priceText} before tax and fees.${exactTotal}`,
        needsTodo: questionType === "otd_total",
        todoReason: "pricing",
        todoSummary:
          questionType === "otd_total"
            ? `Confirm exact out-the-door total for ${unitLabel}. Customer asked: ${args.text}`
            : undefined,
        item
      };
    }
    return {
      handled: true,
      reply: `I don’t see a published price in the inventory feed for the ${unitLabel}, so I’ll have the team confirm it and send it over.`,
      needsTodo: true,
      todoReason: "pricing",
      todoSummary: `Confirm sale price for ${unitLabel}. Customer asked: ${args.text}`,
      item
    };
  }

  const apr = parseRequestedApr(args.text);
  const priceCap = parseRequestedPriceCap(args.text);
  const eligibility = isLikelyLowAprEligible(item, args.conv);
  const aprText = apr ? `${apr}%` : "the low-interest";
  const capText = priceCap ? ` and the under-${formatMoney(priceCap)} price cap` : "";

  if (!apr && !priceCap) {
    return {
      handled: true,
      reply: `I don’t want to guess on finance eligibility for the ${unitLabel}. I’ll have the team confirm the current program and follow up.`,
      needsTodo: true,
      todoReason: "pricing",
      todoSummary: `Turn over finance program eligibility for ${unitLabel}. Customer asked: ${args.text}`,
      item
    };
  }

  if (!eligibility.modelYearEligible) {
    const yearText = eligibility.year ? `${eligibility.year} ` : "";
    return {
      handled: true,
      reply: `I don’t want to guess on that. The ${yearText}${unitLabel.replace(/^\d{4}\s+/, "")} does not clearly match the basic new 2024/2025 inventory criteria, so I’ll have the team verify the current program before quoting it.`,
      needsTodo: true,
      todoReason: "pricing",
      todoSummary: `Turn over finance program eligibility for ${unitLabel}. Customer asked: ${args.text}`,
      item
    };
  }

  if (priceCap && !priceText) {
    return {
      handled: true,
      reply: `The ${unitLabel} matches the basic new 2024/2025 inventory criteria for ${aprText} APR, but I don’t see a published price in the inventory feed to verify the under-${formatMoney(priceCap)} part. I’ll have the team confirm both.`,
      needsTodo: true,
      todoReason: "pricing",
      todoSummary: `Turn over price and finance program eligibility for ${unitLabel}. Customer asked: ${args.text}`,
      item
    };
  }

  if (priceCap && price && price > priceCap) {
    return {
      handled: true,
      reply: `The ${unitLabel} matches the basic new 2024/2025 inventory criteria, but the listed price I see is ${priceText}, which is over ${formatMoney(priceCap)}. I’ll confirm the current program details before quoting it.`,
      needsTodo: true,
      todoReason: "pricing",
      todoSummary: `Turn over finance program eligibility for ${unitLabel}. Customer asked: ${args.text}`,
      item
    };
  }

  return {
    handled: true,
    reply: `Based on the inventory feed, the ${unitLabel} matches the basic new 2024/2025 criteria for ${aprText} APR${capText}${priceText ? ` with a listed price of ${priceText}` : ""}. I’ll still have the team confirm the current program details before quoting it as eligible.`,
    needsTodo: true,
    todoReason: "pricing",
    todoSummary: `Turn over finance program eligibility for ${unitLabel}. Customer asked: ${args.text}`,
    item
  };
}
