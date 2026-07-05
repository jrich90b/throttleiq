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
    // SPECIFIC touring glides only — a bare "glide" would wrongly grab Super/Wide/Sport Glide,
    // which are Dyna/Softail CRUISERS (caught live, s R Gurajala 2026-06-24).
    re: /\b(street[\s-]?glide|road[\s-]?glide|road[\s-]?king|electra[\s-]?glide|ultra|tour(?:ing)?)\b/i
  },
  {
    segment: "sport",
    re: /\b(sportster|iron ?(?:883|1200)?|forty[\s-]?eight|roadster|super[\s-]?low|nightster|street ?(?:500|750|rod)|livewire|rev'?max|1200 ?custom|48\b)\b/i
  },
  {
    segment: "cruiser",
    // Includes the literal word "cruiser" — feeds carry units named e.g. "Twin Cruiser" that must
    // be excluded when the customer says "not cruisers" (caught live, s R Gurajala 2026-06-24).
    re: /\b(cruiser|fat[\s-]?boy|fat[\s-]?bob|low[\s-]?rider|softail|heritage|breakout|street[\s-]?bob|sport[\s-]?glide|slim|deluxe|night[\s-]?train|wide[\s-]?glide|super[\s-]?glide|switchback|dyna|v[\s-]?rod|vrsc|standard)\b/i
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
  // When the SAME reply will append a disclaimed payment estimate (recommend-and-quote in one turn),
  // drop the trailing "Want me to run exact monthly numbers?" CTA — the estimate carries its own CTA,
  // and asking to run numbers immediately before running them reads awkwardly.
  omitNumbersCta?: boolean;
}): string {
  const name = String(args.firstName ?? "").trim();
  const opener = name ? `Sure thing, ${name}.` : "Sure thing.";
  const budget = Number(args.monthlyBudget);
  const lowBudget = Number.isFinite(budget) && budget > 0 && budget <= 250;
  const intro = lowBudget
    ? `Around $${Math.round(budget).toLocaleString("en-US")}/mo usually means used. Here are a few that could fit:`
    : "Here are a few that could fit:";
  const lines = args.matches.map(m => `• ${unitLabel(m)}`).join("\n");
  const tail = args.omitNumbersCta ? "" : "\nWant me to run exact monthly numbers on any of these?";
  return `${opener} ${intro}\n${lines}${tail}`;
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

// --- Recommended-unit media (photos/links/colors) follow-up (2026-06-24) --------------------------
// After we suggest units, the customer often asks "can I see the pictures and color?" — and the agent
// punted ("I don't have the links yet") even though the feed carries each unit's listing url + color
// (s R Gurajala +17167506588). We PERSIST the suggested units (incl. url) on the conversation so a
// follow-up can answer with the REAL links. The links are assembled deterministically — a customer-
// facing URL must be exact, so we never let the LLM compose it (AGENTS.md: structured output is
// deterministic).
export type RecommendedUnit = {
  year?: string | null;
  model?: string | null;
  color?: string | null;
  price?: number | null;
  stockId?: string | null;
  url?: string | null;
  images?: string[];
};

export function toRecommendedUnits(matches: InventoryFeedItem[]): RecommendedUnit[] {
  return (matches ?? []).slice(0, 6).map(m => ({
    year: m.year ?? null,
    model: m.model ?? null,
    color: m.color ?? null,
    price: m.price ?? null,
    stockId: m.stockId ?? null,
    url: m.url ?? null,
    images: Array.isArray(m.images) ? m.images.slice(0, 4) : []
  }));
}

function unitDisplayName(u: RecommendedUnit): string {
  return [String(u.year ?? "").trim(), String(u.model ?? "").trim()].filter(Boolean).join(" ").trim() || "that one";
}

// MMS-reliable image formats only — carriers handle jpg/png well but choke on webp/avif (the dealer
// feed mixes them). A unit whose only images are webp falls back to its listing link.
const MMS_IMAGE_RE = /\.(jpe?g|png)(\?|$)/i;
// Keep MMS small/deliverable — a few photos, spread one-per-unit, never the whole gallery.
const MAX_MMS_PHOTOS = 3;

/**
 * Deterministic reply to "show me pics/colors/links" of the units we already suggested. Prefers
 * actually ATTACHING photos over links (links break / get blocked — s R Gurajala, 2026-06-24): up to
 * MAX_MMS_PHOTOS MMS-friendly images, one per unit. Any unit we couldn't attach a photo for but that
 * has a listing url is LINKED instead. Returns { reply, mediaUrls }; null when there's nothing real to
 * send (no photo and no url for any unit) so the caller doesn't punt or fabricate a link.
 */
export function buildRecommendedUnitsMediaReply(args: {
  firstName?: string | null;
  units: RecommendedUnit[];
}): { reply: string; mediaUrls: string[] } | null {
  const units = args.units ?? [];
  const mediaUrls: string[] = [];
  const photographed = new Set<RecommendedUnit>();
  for (const u of units) {
    if (mediaUrls.length >= MAX_MMS_PHOTOS) break;
    const img = (Array.isArray(u.images) ? u.images : []).find(x => MMS_IMAGE_RE.test(String(x ?? "")));
    if (img) {
      mediaUrls.push(String(img).trim());
      photographed.add(u);
    }
  }
  const linkLines = units
    .filter(u => !photographed.has(u) && /^https?:\/\//i.test(String(u.url ?? "")))
    .map(u => `• ${unitDisplayName(u)}${u.color ? ` (${String(u.color).trim()})` : ""}: ${String(u.url).trim()}`);
  if (!mediaUrls.length && !linkLines.length) return null;
  const name = String(args.firstName ?? "").trim();
  const opener = name ? `Here you go, ${name}!` : "Here you go!";
  const parts = [opener];
  if (linkLines.length) parts.push(linkLines.join("\n"));
  parts.push("Want me to run numbers on one of these?");
  return { reply: parts.join("\n"), mediaUrls };
}
