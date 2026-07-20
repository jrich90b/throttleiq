/**
 * Price-drop watch — the "price change on something they were interested in" cadence value trigger
 * (Joe 2026-07-20: later proactive touches must carry real value, never filler).
 *
 * Deterministic by design (structured extraction + a state side-effect, which AGENTS.md allows —
 * there is no customer intent to comprehend here): we anchor the asking price of the lead's unit of
 * interest the first time the value gate looks at the conversation, and fire ONE touch when the live
 * inventory feed later shows that unit at a meaningfully lower price. After firing, the anchor
 * re-arms at the new price so only a FURTHER drop can fire again.
 *
 * Unit of interest resolution (first hit wins): the lead vehicle's stockId, then the inventory
 * watch's lastNotifiedStockId (the exact unit a watch fire already told them about).
 *
 * FAIL DIRECTION: anything unresolvable (no stockId, unit gone from the feed, no price, no anchor,
 * drop under the threshold) → null — no touch. A missed price-drop is a lost nicety; a fabricated or
 * stale price texted to a customer is a real harm, so every uncertain path returns null.
 */
import type { Conversation } from "./conversationStore.js";
import { getInventoryFeed, type InventoryFeedItem } from "./inventoryFeed.js";

/** Minimum drop (dollars) that counts as real news. Env PRICE_DROP_MIN_DELTA overrides. */
export const PRICE_DROP_MIN_DELTA_DEFAULT = 250;

export function priceDropMinDelta(): number {
  const raw = String(process.env.PRICE_DROP_MIN_DELTA ?? "").trim();
  if (!raw) return PRICE_DROP_MIN_DELTA_DEFAULT; // Number("") is 0 — an unset env must not zero the threshold
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : PRICE_DROP_MIN_DELTA_DEFAULT;
}

export type PriceDropDecision =
  | { fire: false; reason: string }
  | { fire: true; oldPrice: number; newPrice: number };

/** Pure: does the current price vs the anchored price constitute a real drop? */
export function decideInterestUnitPriceDrop(args: {
  anchorStockId?: string | null;
  anchorPrice?: number | null;
  currentStockId?: string | null;
  currentPrice?: number | null;
  minDelta: number;
}): PriceDropDecision {
  const anchorStock = String(args.anchorStockId ?? "").trim().toLowerCase();
  const currentStock = String(args.currentStockId ?? "").trim().toLowerCase();
  if (!anchorStock || !currentStock) return { fire: false, reason: "no_stock_id" };
  if (anchorStock !== currentStock) return { fire: false, reason: "different_unit" };
  const anchor = Number(args.anchorPrice);
  const current = Number(args.currentPrice);
  if (!Number.isFinite(anchor) || anchor <= 0) return { fire: false, reason: "no_anchor_price" };
  if (!Number.isFinite(current) || current <= 0) return { fire: false, reason: "no_current_price" };
  if (anchor - current < args.minDelta) return { fire: false, reason: "below_threshold" };
  return { fire: true, oldPrice: anchor, newPrice: current };
}

const fmtPrice = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/**
 * One warm, human line about the drop — three rotating shapes so repeat leads don't all read the
 * same template. Tone backstop: cadence sends still pass the live cadence-quality judge.
 */
export function buildPriceDropMessage(args: {
  firstName?: string | null;
  unitLabel: string;
  oldPrice: number;
  newPrice: number;
  variantSeed: number;
}): string {
  const name = String(args.firstName ?? "").trim();
  const greet = name ? `${name}, ` : "";
  const greetHey = name ? `Hey ${name} — ` : "Hey — ";
  const label = args.unitLabel.trim() || "the bike you were looking at";
  const now = fmtPrice(args.newPrice);
  const was = fmtPrice(args.oldPrice);
  const variants = [
    `${greetHey}the ${label} you were looking at just came down to ${now} (was ${was}). Worth another look?`,
    `${greet}quick heads up — that ${label} dropped to ${now} from ${was}. Want me to send the details?`,
    `Good news ${name || "for you"} — the ${label} is now ${now}, down from ${was}. Want to come take a look?`
  ];
  const idx = Math.abs(Math.trunc(args.variantSeed)) % variants.length;
  return variants[idx].replace(/\s+/g, " ").trim();
}

function resolveInterestStockId(conv: Conversation): string | null {
  const leadStock = String((conv.lead?.vehicle as any)?.stockId ?? "").trim();
  if (leadStock) return leadStock;
  const watches = Array.isArray((conv as any).inventoryWatches) ? (conv as any).inventoryWatches : [];
  for (const w of watches) {
    const s = String(w?.lastNotifiedStockId ?? "").trim();
    if (s) return s;
  }
  const single = String((conv.inventoryWatch as any)?.lastNotifiedStockId ?? "").trim();
  return single || null;
}

function unitLabelOf(item: InventoryFeedItem): string {
  return [item.year, item.make, item.model].map(v => String(v ?? "").trim()).filter(Boolean).join(" ");
}

export type InterestUnitPriceDrop = {
  stockId: string;
  oldPrice: number;
  newPrice: number;
  message: string;
};

/**
 * Resolve (and arm) the price-drop trigger for a conversation. Side-effects on `conv` (caller's tick
 * already persists it): ARMS the anchor when absent or when the unit of interest changed. Returns the
 * fire-able drop or null. The caller COMMITS a fired drop via commitInterestUnitPriceDropFire — the
 * anchor only re-arms at the new price when the touch is actually used (the gate may pick a higher-
 * precedence trigger, and a regen draft must not consume the fire).
 */
export async function resolveInterestUnitPriceDrop(conv: Conversation): Promise<InterestUnitPriceDrop | null> {
  const stockId = resolveInterestStockId(conv);
  if (!stockId) return null;
  let item: InventoryFeedItem | undefined;
  try {
    const feed = await getInventoryFeed();
    const key = stockId.toLowerCase();
    item = feed.find(
      i => String(i.stockId ?? "").trim().toLowerCase() === key || String(i.vin ?? "").trim().toLowerCase() === key
    );
  } catch {
    return null;
  }
  const price = Number(item?.price);
  if (!item || !Number.isFinite(price) || price <= 0) return null;

  const anchor = conv.interestUnitPriceAnchor;
  const anchorMatches = anchor && String(anchor.stockId).trim().toLowerCase() === stockId.toLowerCase();
  if (!anchorMatches) {
    // First sighting (or the unit of interest changed): arm the anchor, nothing to fire yet.
    conv.interestUnitPriceAnchor = { stockId, price, at: new Date().toISOString() };
    return null;
  }
  const decision = decideInterestUnitPriceDrop({
    anchorStockId: anchor!.stockId,
    anchorPrice: anchor!.price,
    currentStockId: stockId,
    currentPrice: price,
    minDelta: priceDropMinDelta()
  });
  if (!decision.fire) return null;
  const outboundCount = (conv.messages ?? []).filter((m: any) => m?.direction === "out").length;
  return {
    stockId,
    oldPrice: decision.oldPrice,
    newPrice: decision.newPrice,
    message: buildPriceDropMessage({
      firstName: conv.lead?.firstName,
      unitLabel: unitLabelOf(item),
      oldPrice: decision.oldPrice,
      newPrice: decision.newPrice,
      variantSeed: outboundCount
    })
  };
}

/** Re-anchor at the fired price so only a FURTHER drop can fire again. Call ONLY when the touch is used. */
export function commitInterestUnitPriceDropFire(conv: Conversation, drop: InterestUnitPriceDrop): void {
  conv.interestUnitPriceAnchor = { stockId: drop.stockId, price: drop.newPrice, at: new Date().toISOString() };
}
