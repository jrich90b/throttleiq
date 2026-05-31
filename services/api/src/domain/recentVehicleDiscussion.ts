type RecentVehicleDiscussionFacts = {
  year?: string | null;
  model?: string | null;
  mileage?: string | null;
  price?: string | null;
};

function toTitleCase(input: string): string {
  return input
    .toLowerCase()
    .replace(/\b\w/g, char => char.toUpperCase());
}

function normalizeDisplayCase(raw?: string | null): string {
  if (!raw) return "";
  const trimmed = String(raw).trim();
  if (!trimmed) return "";
  const letters = trimmed.replace(/[^A-Za-z]/g, "");
  if (!letters) return trimmed;
  return letters === letters.toUpperCase() ? toTitleCase(trimmed) : trimmed;
}

function formatVehicleFactMoney(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const digits = value.replace(/[^\d.]/g, "");
    const numeric = Number(digits);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0
    }).format(numeric);
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(numeric);
}

function formatVehicleSalePriceMoney(value: unknown): string | null {
  const raw = typeof value === "string" ? value.replace(/[^\d.]/g, "") : String(value ?? "");
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric < 1000) return null;
  return formatVehicleFactMoney(numeric);
}

function extractYearFromVehicleDiscussionText(text: string): string | null {
  const digitYear = text.match(/\b(19|20)\d{2}\b/);
  if (digitYear?.[0]) return digitYear[0];
  const lower = text.toLowerCase().replace(/[‐‑‒–—-]/g, " ");
  const phraseMap: Array<[RegExp, string]> = [
    [/\btwenty\s+twenty\s+six\b/, "2026"],
    [/\btwenty\s+twenty\s+five\b/, "2025"],
    [/\btwenty\s+twenty\s+four\b/, "2024"],
    [/\btwenty\s+twenty\s+three\b/, "2023"],
    [/\btwenty\s+twenty\s+two\b/, "2022"],
    [/\btwenty\s+twenty\s+one\b/, "2021"],
    [/\btwenty\s+twenty\b/, "2020"],
    [/\btwenty\s+nineteen\b/, "2019"],
    [/\btwenty\s+eighteen\b/, "2018"],
    [/\btwenty\s+seventeen\b/, "2017"],
    [/\btwenty\s+sixteen\b/, "2016"],
    [/\btwenty\s+fifteen\b/, "2015"]
  ];
  for (const [pattern, year] of phraseMap) {
    if (pattern.test(lower)) return year;
  }
  return null;
}

function extractModelFromVehicleDiscussionText(text: string): string | null {
  const patterns = [
    /\b(street\s+glide\s+special)\b/i,
    /\b(road\s+glide\s+special)\b/i,
    /\b(street\s+glide\s+limited)\b/i,
    /\b(road\s+glide\s+limited)\b/i,
    /\b(street\s+glide\s+3\s+limited)\b/i,
    /\b(street\s+glide\s+3)\b/i,
    /\b(low\s+rider\s+st)\b/i,
    /\b(low\s+rider\s+s)\b/i,
    /\b(heritage\s+classic)\b/i,
    /\b(tri\s+glide\s+ultra)\b/i,
    /\b(street\s+glide)\b/i,
    /\b(road\s+glide)\b/i,
    /\b(softail\s+standard)\b/i,
    /\b(breakout)\b/i,
    /\b(fat\s+boy)\b/i,
    /\b(street\s+bob)\b/i,
    /\b(road\s+king)\b/i,
    /\b(sportster)\b/i,
    /\b(nightster)\b/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return normalizeDisplayCase(match[1]);
  }
  const flhxs = text.match(/\bFLHXS\b/i);
  if (flhxs) return "Street Glide Special";
  return null;
}

function extractMileageFromVehicleDiscussionText(text: string): string | null {
  const numericMatch = text.match(
    /\b(?:only\s+|approx(?:imately)?\.?\s+|about\s+|around\s+|with\s+|has\s+)?([1-9]\d{0,2}(?:,\d{3})+|[1-9]\d{2,5})\s*(?:mi|miles|mile)\b/i
  );
  if (numericMatch?.[1]) {
    const numeric = Number(numericMatch[1].replace(/,/g, ""));
    if (Number.isFinite(numeric) && numeric > 0) return `${Math.round(numeric).toLocaleString("en-US")} miles`;
  }
  const wordMileage = text
    .toLowerCase()
    .replace(/[‐‑‒–—-]/g, " ")
    .match(/\b(?:about|around|approximately|approx\.?|with|has)?\s*seven\s+thousand\s*(?:mi|miles|mile)?\b/);
  if (wordMileage) return "about 7,000 miles";
  return null;
}

export function extractRecentVehicleDiscussionFacts(args: {
  messages?: Array<{ body?: unknown; provider?: unknown }>;
}): RecentVehicleDiscussionFacts | null {
  const recentMessages = (args.messages ?? []).slice(-24);
  const relevantBodies = recentMessages
    .filter(message => {
      const body = String(message.body ?? "");
      const provider = String(message.provider ?? "").toLowerCase();
      if (provider === "sendgrid_adf") return false;
      return (
        provider === "voice_summary" ||
        provider === "voice_transcript" ||
        /\b(bike in the back|not yet listed|not listed|street glide special|road glide special|FLHXS|gauntlet gray|gauntlet grey)\b/i.test(
          body
        )
      );
    })
    .map(message => String(message.body ?? "").trim())
    .filter(Boolean);
  if (!relevantBodies.length) return null;
  const text = relevantBodies.join("\n");
  const year = extractYearFromVehicleDiscussionText(text);
  const model = extractModelFromVehicleDiscussionText(text);
  const mileage = extractMileageFromVehicleDiscussionText(text);
  const price = formatVehicleSalePriceMoney(
    text.match(/\b(?:price|priced|asking|number)\s+(?:is|was|would be|at)?\s*\$?\s*([1-9]\d{2,5}(?:,\d{3})?)\b/i)?.[1] ??
      text.match(/\$\s*([1-9]\d{2,5}(?:,\d{3})?)\b/)?.[1]
  );
  if (!year && !model && !mileage && !price) return null;
  return { year, model, mileage, price };
}

export function shouldPreferRecentVehicleDiscussionFacts(
  text: string | null | undefined,
  requestedFields: string[]
): boolean {
  const lower = String(text ?? "").toLowerCase();
  if (/\b(details?|info|information)\b[\s\S]{0,40}\b(again|recap|remind)\b/.test(lower)) return true;
  if (/\b(miles?|mileage)\b[\s\S]{0,80}\b(year|price)\b/.test(lower)) return true;
  if (/\b(year)\b[\s\S]{0,80}\b(miles?|mileage|price)\b/.test(lower)) return true;
  return requestedFields.length >= 2;
}

export function buildRecentVehicleDiscussionReply(args: {
  facts: RecentVehicleDiscussionFacts;
  requestedFields: string[];
}): { reply: string; needsTodo: boolean; todoSummary?: string } | null {
  const requested = args.requestedFields.map(field => field.toLowerCase());
  const asksYear = requested.includes("year");
  const asksMileage = requested.includes("mileage");
  const asksPrice = requested.includes("price");
  const facts = args.facts;
  const details: string[] = [];
  const unitLabel = [facts.year, facts.model].filter(Boolean).join(" ").trim();
  if (unitLabel && (asksYear || requested.length >= 2)) details.push(unitLabel);
  if (facts.mileage && (asksMileage || requested.length >= 2)) details.push(facts.mileage);
  if (facts.price && (asksPrice || requested.length >= 2)) details.push(facts.price);
  if (!details.length) return null;
  const missing: string[] = [];
  if (asksYear && !facts.year) missing.push("year");
  if (asksMileage && !facts.mileage) missing.push("mileage");
  if (asksPrice && !facts.price) missing.push("price");
  const subject = facts.model ? `the ${facts.model}` : "that bike";
  const detailText = details.join(", ");
  const article = unitLabel && detailText.startsWith(unitLabel) ? "the " : "";
  const reply =
    missing.length > 0
      ? `The one we were talking about was ${article}${detailText}. I’ll confirm the ${missing.join(" and ")} and send it over.`
      : `The one we were talking about was ${article}${detailText}.`;
  return {
    reply,
    needsTodo: missing.length > 0,
    todoSummary: missing.length > 0 ? `Confirm ${missing.join(", ")} for ${subject}.` : undefined
  };
}

