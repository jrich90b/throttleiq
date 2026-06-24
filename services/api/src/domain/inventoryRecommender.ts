/**
 * Inventory recommendation by budget + style (2026-06-24).
 *
 * When a customer asks us to PICK bikes for them — "give me some options", "~$200/mo",
 * "not cruisers", "both new and used" — the agent used to loop "which bike are you looking at
 * so I can run it correctly?" because every pricing path requires a model first (s R Gurajala
 * +17167506588, 2026-06-24). This module turns budget/style preferences into real inventory
 * suggestions: classify each unit's segment, filter, and rank by price (a budget-conscious
 * shopper wants the affordable end first).
 *
 * Deterministic structured extraction + ranking over our OWN inventory feed (AGENTS.md allows
 * deterministic for structured extraction / side-effect-free helpers). The COMPREHENSION of the
 * customer's request ("they want suggestions, exclude cruisers, ~$200/mo") is a typed LLM parser
 * (parseVehicleRecommendationRequestWithLLM); this module only classifies/filters/ranks.
 *
 * Payment honesty (Joe, 2026-06-24): we never quote a per-bike $/mo here — we don't have the
 * customer's rate/term/down. Suggestions show the unit PRICE and the reply offers to run exact
 * numbers. So ranking is by price, not by a fabricated monthly.
 */
import type { InventoryFeedItem } from "./inventoryFeed.js";

export type HarleySegment = "cruiser" | "touring" | "sport" | "adventure" | "trike" | "unknown";

// Keyword → segment. Order matters: trike and touring are checked before cruiser because some
// trikes/baggers share cruiser-ish names. Sportster/Street/Nightster are "sport" (NOT cruiser) so
// "not cruisers" still surfaces the entry-level bikes a budget shopper can actually afford — Harley's
// own taxonomy separates Sport from Cruiser, and it's the helpful read for "$200/mo, not cruisers".
const SEGMENT_RULES: { segment: HarleySegment; re: RegExp }[] = [
  { segment: "trike", re: /\b(tri[\s-]?glide|freewheeler|trike)\b/i },
  { segment: "adventure", re: /\b(pan[\s-]?america|pan[\s-]?am)\b/i },
  {
    segment: "touring",
    re: /\b(street[\s-]?glide|road[\s-]?glide|road[\s-]?king|electra[\s-]?glide|ultra|tour|glide ?(?:special|ultra|limited)?)\b/i
  },
  {
    segment: "sport",
    re: /\b(sportster|iron ?(?:883|1200)?|forty[\s-]?eight|roadster|super[\s-]?low|nightster|street ?(?:500|750|rod)|livewire|rev'?max|1200 ?custom|48\b)\b/i
  },
  {
    segment: "cruiser",
    re: /\b(fat[\s-]?boy|fat[\s-]?bob|low[\s-]?rider|softail|heritage|breakout|street[\s-]?bob|sport[\s-]?glide|slim|deluxe|night[\s-]?train|wide[\s-]?glide|super[\s-]?glide|switchback|dyna|v[\s-]?rod|vrsc|standard)\b/i
  }
];

export function classifyHarleySegment(model: string | null | undefined): HarleySegment {
  const text = String(model ?? "").trim();
  if (!text) return "unknown";
  for (const rule of SEGMENT_RULES) {
    if (rule.re.test(text)) return rule.segment;
  }
  return "unknown";
}

function normalizeCondition(condition: string | null | undefined): "new" | "used" {
  return /\b(used|pre[\s-]?owned|cpo|certified)\b/i.test(String(condition ?? "")) ? "used" : "new";
}

export type RecommendationPrefs = {
  // "new" | "used" | "both" | null (null/both => no condition filter).
  condition?: "new" | "used" | "both" | null;
  excludeSegments?: HarleySegment[];
  includeSegments?: HarleySegment[];
};

/**
 * Pick up to `limit` suggestions from the feed for the given preferences. Pure (takes items in).
 *   - condition: filter to new/used when asked (both/null => keep all)
 *   - excludeSegments / includeSegments: filter by classified segment ("not cruisers" => exclude)
 *   - requires a usable price (we present price + offer to run numbers)
 *   - ranked by price ASC (budget shoppers want the affordable end), one unit per model for variety
 */
export function recommendInventory(
  items: InventoryFeedItem[],
  prefs: RecommendationPrefs,
  limit = 3
): InventoryFeedItem[] {
  const include = new Set((prefs.includeSegments ?? []).filter(Boolean));
  const exclude = new Set((prefs.excludeSegments ?? []).filter(Boolean));
  const wantCondition = prefs.condition && prefs.condition !== "both" ? prefs.condition : null;

  const eligible = (items ?? []).filter(i => {
    const price = Number(i?.price);
    if (!Number.isFinite(price) || price <= 0) return false; // need a price to suggest
    if (!String(i?.model ?? "").trim()) return false;
    if (wantCondition && normalizeCondition(i.condition) !== wantCondition) return false;
    const segment = classifyHarleySegment(i.model);
    if (exclude.has(segment)) return false;
    if (include.size && !include.has(segment)) return false;
    return true;
  });

  eligible.sort((a, b) => Number(a.price) - Number(b.price));

  const out: InventoryFeedItem[] = [];
  const seenModels = new Set<string>();
  for (const item of eligible) {
    const key = String(item.model ?? "").trim().toLowerCase();
    if (seenModels.has(key)) continue; // one unit per model — show variety, not 3 of the same
    seenModels.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function priceLabel(price: number | null | undefined): string {
  const n = Number(price);
  return Number.isFinite(n) && n > 0 ? `$${Math.round(n).toLocaleString("en-US")}` : "";
}

function unitLabel(item: InventoryFeedItem): string {
  const year = String(item?.year ?? "").trim();
  const model = String(item?.model ?? "").trim();
  const price = priceLabel(item?.price);
  const name = [year, model].filter(Boolean).join(" ").trim() || "this one";
  // "at" rather than an em-dash: the voice charter caps em-dashes at 1, and this is a list.
  return price ? `${name} at ${price}` : name;
}

/**
 * Reply listing the suggested units. Never quotes a per-bike $/mo (we don't have terms) — shows
 * price and offers to run exact numbers. Honest budget note when the monthly target is low.
 */
export function buildVehicleRecommendationReply(args: {
  firstName?: string | null;
  matches: InventoryFeedItem[];
  monthlyBudget?: number | null;
}): string {
  const name = String(args.firstName ?? "").trim();
  const opener = name ? `Sure thing, ${name}.` : "Sure thing.";
  const budget = Number(args.monthlyBudget);
  const lowBudget = Number.isFinite(budget) && budget > 0 && budget <= 250;
  const intro = lowBudget
    ? `Around $${Math.round(budget).toLocaleString("en-US")}/mo usually means used. Here are a few that could fit:`
    : "Here are a few that could fit:";
  const lines = args.matches.map(m => `• ${unitLabel(m)}`).join("\n");
  return `${opener} ${intro}\n${lines}\nWant me to run exact monthly numbers on any of these?`;
}

/**
 * Fallback when we confidently detected a "pick some for me" request but have no priced unit that
 * fits (feed empty/unavailable, or everything was filtered out). Never loop back to "which bike?" —
 * commit to following up. The caller creates an owner todo so a human pulls options.
 */
export function buildVehicleRecommendationFollowupReply(firstName?: string | null): string {
  const name = String(firstName ?? "").trim();
  const opener = name ? `Sure thing, ${name}.` : "Sure thing.";
  return `${opener} Let me pull a few that fit what you're after and text them right over.`;
}

export function buildVehicleRecommendationTodoSummary(firstName?: string | null): string {
  const who = String(firstName ?? "").trim() || "Customer";
  return `${who} asked for bike suggestions by budget/style but we had no priced match to send. Pull a few options that fit and follow up.`;
}
