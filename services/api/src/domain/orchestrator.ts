// services/api/src/domain/orchestrator.ts
import { loadSystemPrompt } from "./loadPrompt.js";
import type { InboundMessageEvent, OrchestratorResult } from "./types.js";
import {
  classifySmallTalkWithLLM,
  parseDialogActWithLLM,
  generateDraftWithLLM,
  summarizeConversationMemoryWithLLM
} from "./llmDraft.js";
import { resolveInventoryUrlByStock } from "./inventoryUrlResolver.js";
import { checkInventorySalePendingByUrl, type InventoryStatus } from "./inventoryChecker.js";
import {
  findInventoryMatches,
  findInventoryPrice,
  findPriceRange,
  getInventoryFeed,
  hasInventoryForModelYear
} from "./inventoryFeed.js";
import { listInventoryHolds, normalizeInventoryHoldKey } from "./inventoryHolds.js";
import { listInventorySolds, normalizeInventorySoldKey } from "./inventorySolds.js";
import { findMsrpPricing, getMsrpColorNames } from "./msrpPriceList.js";
import { getInventoryNote } from "./inventoryNotes.js";
import { getDealerProfile } from "./dealerProfile.js";
import { getAllModels, isModelInRecentYears } from "./modelsByYear.js";
import type { LeadProfile } from "./conversationStore.js";
import { parsePreferredDateTime, parseRequestedDayTime } from "./conversationStore.js";
import { getSchedulerConfig, dayKey, getPreferredSalespeople } from "./schedulerConfig.js";
import { getAuthedCalendarClient, queryFreeBusy } from "./googleCalendar.js";
import {
  generateCandidateSlots,
  expandBusyBlocks,
  pickSlotsForSalesperson,
  formatSlotLocal,
  localPartsToUtcDate
} from "./schedulerEngine.js";

function simpleIntent(body: string): OrchestratorResult["intent"] {
  const t = body.toLowerCase();
  if (detectTradeRequest(t)) {
    return "TRADE_IN";
  }
  if (/(stock|vin|available|availability|still there)/.test(t)) return "AVAILABILITY";
  if (/(price|otd|out the door|payment|monthly)/.test(t)) return "PRICING";
  if (/(finance|credit|apr)/.test(t)) return "FINANCING";
  if (/(test ride|ride it|demo)/.test(t)) return "TEST_RIDE";
  if (/(spec|seat height|weight|hp|horsepower|torque)/.test(t)) return "SPECS";
  return "GENERAL";
}

function detectTradeRequest(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\b(trade[-\s]?in|trade in|trading in|trade appraisal|trade value|value my trade|trade price|trade quote|trade offer)\b/.test(
      t
    ) ||
    /\bon trade\b/.test(t) ||
    /\b(what|how much)\b.*\b(on|for)\s+trade\b/.test(t) ||
    /\bwhat would you give me\b.*\b(on|for)\s+trade\b/.test(t)
  );
}

function hasStrongIntentSignal(text: string): boolean {
  const t = text.toLowerCase();
  return (
    detectTradeRequest(t) ||
    /(stock|vin|available|availability|still there|in stock)/.test(t) ||
    /(price|pricing|tax|fees|total|otd|out the door|payment|monthly|finance|credit|apr|down|term|budget|\bdeal(?:s)?\b|rebate|incentive)/.test(t) ||
    /(test ride|ride it|demo|ride up|take a ride|check it out|look at (it|the)|see (it|the)|come (in|by|up|down)|stop by|swing by|visit|drive (up|down))/i.test(t) ||
    /(call me|give me a call|call back|callback|please call)/.test(t) ||
    /(appointment|schedule|book|set up|come in|stop in|visit)/.test(t) ||
    /(hours|open|close|location|address|where are you)/.test(t)
  );
}

function isEmojiOnly(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (/[a-z0-9]/i.test(t)) return false;
  return t.length <= 6;
}

function extractDayPart(text: string): string | null {
  const t = String(text ?? "").toLowerCase();
  const m = t.match(/\b(morning|afternoon|evening|tonight)\b/);
  if (!m) return null;
  return m[1] === "tonight" ? "evening" : m[1];
}

function extractDayName(text: string): string | null {
  const t = String(text ?? "").toLowerCase();
  const m = t.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (!m) return null;
  return m[1].replace(/^\w/, c => c.toUpperCase());
}

function isShortPleasantry(text: string): boolean {
  const raw = String(text ?? "").trim();
  if (!raw) return false;
  const t = raw.toLowerCase();
  if (/^(yes|yeah|yep|yup|no|nah|nope)$/i.test(t)) return false;
  if (/[0-9]/.test(t)) return false;
  if (/\?/.test(t)) return false;
  if (hasStrongIntentSignal(t)) return false;
  const tokens = t
    .replace(/[^a-z0-9\s]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length || tokens.length > 5) return false;
  const allowed = new Set([
    "ok",
    "okay",
    "k",
    "kk",
    "thanks",
    "thank",
    "you",
    "thx",
    "ty",
    "appreciate",
    "it",
    "got",
    "sounds",
    "good",
    "cool",
    "awesome",
    "great",
    "perfect",
    "no",
    "problem",
    "np",
    "alright",
    "alrighty",
    "lol",
    "haha",
    "ha"
  ]);
  const pleasantry = new Set([
    "thanks",
    "thank",
    "thx",
    "ty",
    "appreciate",
    "got",
    "sounds",
    "good",
    "cool",
    "awesome",
    "great",
    "perfect",
    "problem",
    "np",
    "alright",
    "alrighty",
    "lol",
    "haha",
    "ha"
  ]);
  if (!tokens.every(tok => allowed.has(tok))) return false;
  if (!tokens.some(tok => pleasantry.has(tok))) return false;
  return true;
}

function isSmallTalkCandidate(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (/[0-9]/.test(t)) return false;
  if (/\?/.test(t)) return false;
  if (hasStrongIntentSignal(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length <= 10 && t.length <= 120;
}

function pickSmallTalkReply(seed: string): string {
  const gratitude = [
    "You're welcome!",
    "Anytime!",
    "Happy to help!"
  ];
  const ack = [
    "Got it.",
    "Sounds good.",
    "You got it."
  ];
  const raw = String(seed ?? "");
  if (!raw) return "Got it.";
  const lower = raw.toLowerCase();
  const pool = /(thank|thx|ty|appreciate)/.test(lower) ? gratitude : ack;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash + raw.charCodeAt(i)) % pool.length;
  }
  return pool[hash];
}

function buildDialogActReply(args: {
  act: "trust_concern" | "frustration" | "objection" | "preference" | "clarification" | "none";
  topic: "used_inventory" | "new_inventory" | "pricing" | "trade" | "scheduling" | "service" | "general";
  nextAction: "reassure_then_clarify" | "empathize_then_offer_help" | "ask_one_clarifier" | "normal_flow";
  askFocus?: "model" | "budget" | "timing" | "condition" | "other" | null;
  lead?: LeadProfile | null;
}): string | null {
  const modelLabel = normalizeModelLabel(args.lead?.vehicle?.model ?? args.lead?.vehicle?.description);
  const yearLabel = args.lead?.vehicle?.year ? `${args.lead?.vehicle?.year} ` : "";
  const usedLabel = modelLabel === "that bike" ? "used bike" : `used ${yearLabel}${modelLabel}`.trim();
  const clarifier =
    args.askFocus === "model"
      ? "Are you set on that model or open to similar options?"
      : args.askFocus === "budget"
        ? "What budget range would you like me to target?"
        : args.askFocus === "timing"
          ? "Are you shopping now or a bit later?"
          : args.askFocus === "condition"
            ? "Are you set on pre-owned, or open to new as well?"
            : "What matters most so I can narrow this down for you?";

  if (args.topic === "used_inventory" && (args.act === "trust_concern" || args.nextAction === "reassure_then_clarify")) {
    return (
      "Totally get it — buying through a dealer usually gives a lot more peace of mind than private listings. " +
      `I can help you find a ${usedLabel}. ${clarifier}`
    );
  }
  if (args.nextAction === "empathize_then_offer_help") {
    return `I get that — that can definitely be frustrating. I can help with that. ${clarifier}`;
  }
  if (args.nextAction === "ask_one_clarifier") {
    return clarifier;
  }
  if (args.act === "frustration" || args.act === "objection" || args.act === "preference" || args.act === "clarification") {
    return `Got it. ${clarifier}`;
  }
  return null;
}

function detectManagerRequest(text: string): boolean {
  const t = text.toLowerCase();
  return /(speak to (the )?manager|sales manager|general manager|\bgm\b)/.test(t);
}

function detectApprovalStatus(text: string): boolean {
  const t = text.toLowerCase();
  return /(am i approved|approved|denied|credit decision|status of my application)/.test(t);
}

function detectCallbackRequest(text: string): boolean {
  const t = text.toLowerCase();
  const customerWillCall =
    /\b(i(?:'|’)ll|i will)\s+call\b/.test(t) ||
    /\bcall for (an )?appointment\b/.test(t) ||
    /\bcall (to )?(set|schedule) (an )?appointment\b/.test(t) ||
    /\bcheck my schedule\b/.test(t) ||
    /\blet you know when i(?:'|’)m coming in\b/.test(t) ||
    /\blet you know when i am coming in\b/.test(t);
  if (customerWillCall) return false;
  const hasCallback =
    /(call me|call him|call her|give me a call|give (him|her) a call|reach me|reach him|reach her|contact me|can you call|can you have|please call|have .* call)/.test(
      t
    );
  const hasTimeframe =
    /(today|tomorrow|this weekend|this week|next week|tuesday|wednesday|thursday|friday|saturday|sunday|monday|\bmon\b|\btue\b|\bwed\b|\bthu\b|\bfri\b|\bsat\b|\bsun\b|\b\d{1,2}:\d{2}\s*(am|pm)?\b|\b\d{1,2}\s*(am|pm)\b)/.test(
      t
    );
  const hasPhone = /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(t);
  const hasTrade = detectTradeRequest(t);
  return hasCallback || (hasTimeframe && (hasPhone || hasTrade));
}

function detectHoursRequest(text: string): boolean {
  const t = text.toLowerCase();
  const hasDay = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(t);
  return (
    /\bhours?\b/.test(t) ||
    /(what time.*open|what time.*close|when.*open|when.*close|opening hours|closing time)/.test(t) ||
    (hasDay &&
      /(how about|what about|can you do|could you do|can't do|cant do|can't make|cant make)/.test(t))
  );
}

function formatHoursRange(open: string, close: string): string {
  return `${open}–${close}`;
}

function formatDayLabel(day: string): string {
  return day.slice(0, 3).replace(/^\w/, c => c.toUpperCase());
}

function formatBusinessHours(hours?: Record<string, any> | null): string | null {
  if (!hours) return null;
  const dayOrder = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const entries = dayOrder
    .map(day => ({ day, open: hours?.[day]?.open, close: hours?.[day]?.close }))
    .filter(d => d.open && d.close);
  if (!entries.length) return null;

  const groups: Array<{ start: number; end: number; open: string; close: string }> = [];
  for (let i = 0; i < entries.length; i++) {
    const { open, close } = entries[i];
    const prev = groups[groups.length - 1];
    if (prev && prev.open === open && prev.close === close && prev.end === i - 1) {
      prev.end = i;
    } else {
      groups.push({ start: i, end: i, open, close });
    }
  }

  const parts = groups.map(g => {
    const startDay = formatDayLabel(entries[g.start].day);
    const endDay = formatDayLabel(entries[g.end].day);
    const label = g.start === g.end ? startDay : `${startDay}–${endDay}`;
    return `${label} ${formatHoursRange(g.open, g.close)}`;
  });
  return parts.join(", ");
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function detectSalespersonMention(text: string): Promise<string | null> {
  const t = String(text ?? "").toLowerCase();
  if (!t) return null;
  try {
    const cfg = await getSchedulerConfig();
    const list = (cfg.salespeople ?? []).map(p => p.name).filter(Boolean) as string[];
    for (const name of list) {
      const nameLower = name.toLowerCase();
      if (nameLower && t.includes(nameLower)) return name;
      const first = nameLower.split(/\s+/)[0];
      if (first && first.length > 2) {
        const re = new RegExp(`\\b${escapeRegExp(first)}\\b`, "i");
        if (re.test(text)) return name.split(/\s+/)[0];
      }
    }
  } catch {}
  return null;
}

function detectExactNumberPressure(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /(out the door|\botd\b|final price|total price|including tax|fees included|send me the price|what's the lowest|lowest price|best price)/.test(
      t
    )
  );
}

function detectPaymentPressure(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /(monthly payment|payments?\b|what.*payment|payment.*(month|monthly)|how much.*(payment|monthly)|how much down|\$\s*\d+[,\d]*\s*(\/\s*mo|\/\s*month|per month|a month|monthly)|\bapr\b|term)/.test(
      t
    )
  );
}

function detectDownPaymentQuestion(text: string): boolean {
  const t = text.toLowerCase();
  return /(how much|what|what would|what do|do i need|need).*(down payment|downpayment|down|deposit)/.test(
    t
  );
}

function detectFinanceRequest(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /(credit app|credit application|apply for credit|finance application|prequal|pre-qual|prequalify|financing|finance)\b/.test(
      t
    ) ||
    (/\b(how|where|can i)\b.*\bapply\b/.test(t) &&
      !/\b(job|career|careers|hiring|position|positions|opening|openings|employment|resume|cv|recruit|recruiter|hr)\b/.test(
        t
      ))
  );
}

function detectDepositRequest(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(leave|put|place|make)\b.*\b(deposit|hold)\b|\bdeposit\b.*\b(bike|unit|it)\b/.test(
    t
  );
}

function pickDepositLeadIn(text: string): string {
  const t = text.toLowerCase();
  if (/(thanks|thank you|appreciate)/.test(t)) return "You're welcome.";
  if (/(i left|already left|left a deposit)/.test(t)) return "Thanks for the update.";
  if (/(can you|could you|would you)/.test(t)) return "Sure.";
  if (/(i want|i'd like|i would like|looking to|want to)/.test(t)) return "Absolutely.";
  return "Sounds good.";
}

function detectPendingIntents(text: string): Set<
  "PRICING" | "PAYMENTS" | "FINANCING" | "AVAILABILITY" | "SCHEDULING" | "TRADE"
> {
  const t = String(text ?? "");
  const intents = new Set<
    "PRICING" | "PAYMENTS" | "FINANCING" | "AVAILABILITY" | "SCHEDULING" | "TRADE"
  >();
  if (detectPaymentPressure(t) || detectPaymentFollowUp(t, [])) intents.add("PAYMENTS");
  if (detectFinanceRequest(t)) intents.add("FINANCING");
  if (/(price|pricing|msrp|cost|how much|what's the price|what is the price|out the door|\botd\b|tax|fees|deal|rebate|incentive)/i.test(t)) {
    intents.add("PRICING");
  }
  if (/(available|availability|still there|in stock|do you have|have any)/i.test(t)) intents.add("AVAILABILITY");
  if (hasSchedulingIntent(t) || extractDayName(t) || extractDayPart(t) || /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i.test(t)) {
    intents.add("SCHEDULING");
  }
  if (detectTradeRequest(t)) intents.add("TRADE");
  return intents;
}

function mergePendingInboundText(
  currentText: string,
  history: { direction: "in" | "out"; body: string }[]
): string {
  const latest = String(currentText ?? "").trim();
  if (!latest) return currentText;
  if (isSmallTalkCandidate(latest)) return currentText;
  const items = Array.isArray(history) ? history : [];
  if (items.length < 2) return currentText;
  const lastOutIdx = (() => {
    let idx = -1;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (items[i]?.direction === "out") {
        idx = i;
        break;
      }
    }
    return idx;
  })();
  const inboundSince = items.slice(lastOutIdx + 1).filter(m => m.direction === "in" && m.body);
  if (inboundSince.length <= 1) return currentText;
  const latestIntents = detectPendingIntents(latest);
  let merged = latest;
  let added = 0;
  for (let i = inboundSince.length - 2; i >= 0; i -= 1) {
    const body = String(inboundSince[i]?.body ?? "").trim();
    if (!body) continue;
    if (/web lead\s*\(adf\)/i.test(body)) continue;
    if (isSmallTalkCandidate(body)) continue;
    const intents = detectPendingIntents(body);
    const addsNew = [...intents].some(intent => !latestIntents.has(intent));
    if (!addsNew && latestIntents.size > 0) continue;
    merged = `${body} ${merged}`.trim();
    intents.forEach(intent => latestIntents.add(intent));
    added += 1;
    if (added >= 2) break;
  }
  return merged;
}

function extractPreferredTermMonths(text: string): number | null {
  const t = text.toLowerCase();
  const termMatch = t.match(/\b(60|72|84)\s*(month|mo|mos|months|term)?\b/);
  if (termMatch) return Number(termMatch[1]);
  return null;
}

function parseDownPayment(text: string): { amount: number; assumedThousands: boolean } | null {
  const t = text.toLowerCase();
  const match = t.match(
    /(?:\$\s*)?(\d{1,3}(?:,\d{3})+|\d+)\s*(k|grand)?\s*(?:down|down payment|deposit|dp|put down)/
  );
  if (!match) return null;
  const rawNum = Number(String(match[1]).replace(/,/g, ""));
  if (!Number.isFinite(rawNum) || rawNum <= 0) return null;
  const hasK = !!match[2];
  const hasDollar = t.includes("$");
  let amount = rawNum;
  let assumedThousands = false;
  if (hasK) {
    amount = rawNum * 1000;
  } else if (!hasDollar && rawNum <= 99) {
    amount = rawNum * 1000;
    assumedThousands = true;
  }
  return { amount, assumedThousands };
}

function calcMonthlyPayment(principal: number, apr: number, months: number): number {
  const rate = apr / 12;
  if (rate <= 0) return principal / months;
  const pow = Math.pow(1 + rate, months);
  return (principal * rate * pow) / (pow - 1);
}

function calcAffordablePrincipal(monthlyPayment: number, apr: number, months: number): number {
  const rate = apr / 12;
  if (rate <= 0) return monthlyPayment * months;
  const pow = Math.pow(1 + rate, months);
  return monthlyPayment * ((pow - 1) / (rate * pow));
}

function estimateDownNeededForTargetPayment(opts: {
  targetMonthly: number;
  price: number;
  isUsed: boolean;
  termMonths: number;
  taxRate: number;
}): number {
  const fee = opts.isUsed ? 300 : 1200;
  const aprConservative = opts.isUsed ? 0.09 : 0.08;
  const total = (opts.price + fee) * (1 + opts.taxRate);
  const affordablePrincipal = calcAffordablePrincipal(opts.targetMonthly, aprConservative, opts.termMonths);
  return Math.max(0, total - Math.max(0, affordablePrincipal));
}

function buildMonthlyPaymentLine(opts: {
  priceMin: number;
  priceMax: number;
  isUsed: boolean;
  termMonths: number;
  taxRate: number;
  downPayment?: number;
  downPaymentAssumed?: boolean;
}): string {
  const nf = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const feeMin = opts.isUsed ? 200 : 1200;
  const feeMax = opts.isUsed ? 300 : 1200;
  const taxRate = Number.isFinite(opts.taxRate) ? opts.taxRate : 0;
  let totalMin = (opts.priceMin + feeMin) * (1 + taxRate);
  let totalMax = (opts.priceMax + feeMax) * (1 + taxRate);
  if (opts.downPayment && opts.downPayment > 0) {
    totalMin = Math.max(0, totalMin - opts.downPayment);
    totalMax = Math.max(0, totalMax - opts.downPayment);
  }
  const aprMin = opts.isUsed ? 0.08 : 0.06;
  const aprMax = opts.isUsed ? 0.09 : 0.08;
  const low = calcMonthlyPayment(totalMin, aprMin, opts.termMonths);
  const high = calcMonthlyPayment(totalMax, aprMax, opts.termMonths);
  const round10 = (v: number) => Math.round(v / 10) * 10;
  const payLow = nf.format(round10(low));
  const payHigh = nf.format(round10(high));
  const priceLabel =
    opts.priceMin === opts.priceMax
      ? nf.format(opts.priceMin)
      : `${nf.format(opts.priceMin)}–${nf.format(opts.priceMax)}`;
  const downLabel =
    opts.downPayment && opts.downPayment > 0
      ? `${opts.downPaymentAssumed ? "assuming " : ""}${nf.format(opts.downPayment)} down, `
      : "";

  return (
    `Ballpark, on about ${priceLabel}, ${downLabel}` +
    `you’re around ${payLow}–${payHigh}/mo at ${opts.termMonths} months ` +
    `before taxes and fees, based on your APR.`
  );
}

function buildFinanceAppLine(profile: Awaited<ReturnType<typeof getDealerProfile>> | null): string {
  const url = String(profile?.creditAppUrl ?? "").trim();
  if (url) {
    return `If you want to get started, you can submit the credit app online here: ${url}. Or you can stop by the dealership and get it done in person.`;
  }
  return "If you want to get started, you can submit a credit app online. Or you can stop by the dealership and get it done in person.";
}

function buildOutOfStockHumanOptionsLine(): string {
  return "If you'd like, you can stop by and we can go over availability and pricing, or I can text you as soon as one comes in.";
}

function buildOutOfStockPreferencePrompt(args: {
  requestedCondition: "new" | "used" | null;
  color?: string | null;
}): string {
  if (args.color) return "";
  if (args.requestedCondition === "new") {
    return "Are you after a certain color or finish (chrome vs blacked-out)?";
  }
  return "Are you after a certain color?";
}

function extractColorMention(text?: string | null, knownColors?: string[]): string | null {
  const t = String(text ?? "").toLowerCase();
  if (!t) return null;
  if (Array.isArray(knownColors) && knownColors.length) {
    const sorted = [...knownColors].sort((a, b) => b.length - a.length);
    for (const color of sorted) {
      const key = String(color ?? "").trim();
      if (!key) continue;
      if (t.includes(key.toLowerCase())) return key;
    }
    const words = t.replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean);
    const maxDistance = 1;
    const distance = (a: string, b: string): number => {
      if (a === b) return 0;
      if (!a || !b) return Math.max(a.length, b.length);
      if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
      const dp: number[] = [];
      for (let j = 0; j <= b.length; j++) dp[j] = j;
      for (let i = 1; i <= a.length; i++) {
        let prev = dp[0];
        dp[0] = i;
        let minRow = dp[0];
        for (let j = 1; j <= b.length; j++) {
          const tmp = dp[j];
          const cost = a[i - 1] === b[j - 1] ? 0 : 1;
          dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
          prev = tmp;
          if (dp[j] < minRow) minRow = dp[j];
        }
        if (minRow > maxDistance) return maxDistance + 1;
      }
      return dp[b.length];
    };
    for (const color of sorted) {
      const key = String(color ?? "").trim();
      if (!key) continue;
      const tokens = key.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean);
      if (!tokens.length) continue;
      const matched = tokens.every(token =>
        words.some(w => {
          if (w === token) return true;
          if (token.length < 4 || w.length < 4) return false;
          return distance(w, token) <= maxDistance;
        })
      );
      if (matched) return key;
    }
  }
  const colorMatch = t.match(
    /\b(black|white|gray|grey|silver|red|blue|green|yellow|orange|purple|maroon|gold|brown|tan|cream|ivory|pink|magenta|aqua|teal|olive)\b/
  );
  if (!colorMatch) return null;
  const word = colorMatch[1];
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function findRecentInboundColor(
  history: { direction: "in" | "out"; body: string }[] | undefined,
  knownColors: string[]
): string | null {
  if (!history?.length) return null;
  const inbound = [...history].reverse().filter(h => h.direction === "in");
  for (const msg of inbound.slice(0, 20)) {
    const color = extractColorMention(msg.body, knownColors);
    if (color) return color;
  }
  return null;
}

function looksLikePaymentEstimateMessage(text: string): boolean {
  const t = text.toLowerCase();
  return /(ballpark|\/mo|per month|monthly|payments?)/.test(t);
}

function detectPaymentFollowUp(text: string, history: { direction: "in" | "out"; body: string }[]): boolean {
  const t = String(text ?? "").toLowerCase();
  const lastOutbound = [...(history ?? [])].reverse().find(h => h.direction === "out")?.body ?? "";
  if (!looksLikePaymentEstimateMessage(lastOutbound)) return false;
  const hasTerm = extractPreferredTermMonths(t) != null;
  const hasDown = /(down|down payment|deposit|dp|put down)/.test(t);
  return hasTerm || hasDown;
}

function detectFinanceApplyFollowUp(
  text: string,
  history: { direction: "in" | "out"; body: string }[]
): boolean {
  const t = String(text ?? "").toLowerCase();
  const applyAsk = /\b(apply|application)\b/.test(t);
  if (!applyAsk) return false;
  if (
    /\b(job|career|careers|hiring|position|positions|opening|openings|employment|resume|cv|recruit|recruiter|hr)\b/.test(
      t
    )
  ) {
    return false;
  }
  if (/\b(credit|finance|financing|loan|apr|payment|monthly|down)\b/.test(t)) return true;
  const recentOutbound = [...(history ?? [])].reverse().filter(h => h.direction === "out").slice(0, 2);
  return recentOutbound.some(msg =>
    /\b(credit app|finance application|prequal|pre-qual|monthly|\/\s*mo|down payment|ballpark|apr|term)\b/i.test(
      String(msg.body ?? "")
    )
  );
}

function detectPricingOrPayment(text: string, intent?: OrchestratorResult["intent"]): boolean {
  if (intent === "PRICING" || intent === "FINANCING") return true;
  const t = text.toLowerCase();
  return /(price|\bdeal(?:s)?\b|discount|lowest|\botd\b|out the door|payment|monthly|down|apr|term)/.test(t);
}

function isUsedDealerTrustStatement(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  const mentionsUsed = /\b(used|pre[-\s]?owned)\b/.test(t);
  const trustLanguage =
    /\b(bummer|peace of mind|sketchy|facebook|fb marketplace|craigslist|through a dealer|from a dealer|prefer a dealer)\b/.test(
      t
    );
  const explicitAsk =
    /\?/.test(t) ||
    /\b(price|payment|otd|out the door|quote|available|availability|in stock|still there|call|schedule|book|appointment|test ride|trade|finance|apr)\b/.test(
      t
    );
  return mentionsUsed && trustLanguage && !explicitAsk;
}

function detectCorporateIntent(text: string): boolean {
  const t = text.toLowerCase();
  const tokens = t.split(/[^a-z0-9]+/).filter(Boolean);
  const hasToken = (w: string) => tokens.includes(w);
  const hasAnyToken = (list: string[]) => list.some(hasToken);
  const applyOrApplication = /\b(apply|application)\b/.test(t);
  const employmentContext =
    /\b(job|career|careers|hiring|position|positions|opening|openings|opportunity|opportunities|employment|resume|cv|recruit|recruiter|internship|internships)\b/.test(
      t
    ) || (hasToken("human") && hasToken("resources")) || hasToken("hr");
  const employmentIntent =
    /\b(employment|career|careers|job opening|job openings|open position|open positions|hiring|recruit|recruiter|resume|cv|internship|internships)\b/.test(
      t
    ) ||
    (applyOrApplication && employmentContext) ||
    (hasToken("job") && /\b(hiring|apply|application|opening|position|opportunity|opportunities|career|careers)\b/.test(t));
  return (
    /(harley[-\s]?davidson corporate|harley corporate|corporate office|headquarters|\bhq\b)/.test(t) ||
    /(customer service|complaint|feedback|warranty|recall|vin lookup|information on.*vin|vin information)/.test(t) ||
    employmentIntent ||
    (hasToken("human") && hasToken("resources")) ||
    hasToken("hr") ||
    hasToken("media") ||
    hasToken("press") ||
    /business relations/.test(t)
  );
}

if (process.env.DEBUG_INTENT_TESTS === "1") {
  const cases: Array<[string, boolean]> = [
    ["blue with chrome trim", false],
    ["wow beautiful paint job", false],
    ["how do i apply?", false],
    ["need HR contact", true],
    ["press inquiry", true],
    ["career opportunities", true],
    ["customer service complaint", true],
    ["do you have a 2026 street glide", false]
  ];
  for (const [input, expected] of cases) {
    const got = detectCorporateIntent(input);
    if (got !== expected) {
      console.log("[intent-test] corporate mismatch", { input, expected, got });
    }
  }
}

function isNonUsPhone(from?: string): boolean {
  const raw = String(from ?? "").trim();
  return raw.startsWith("+") && !raw.startsWith("+1");
}

function detectInternationalBuyer(text: string, from?: string): boolean {
  const t = text.toLowerCase();
  const country =
    /(canada|uk|united kingdom|england|ireland|australia|new zealand|germany|france|mexico|brazil|india|china|philippines|nigeria|south africa|uae|dubai|saudi|kuwait|qatar|singapore|malaysia|thailand|indonesia|italy|spain|sweden|norway|denmark|netherlands|switzerland|poland|ukraine|russia|pakistan|bangladesh|vietnam|peru|chile|argentina|colombia|venezuela)/.test(
      t
    );
  const intlPhrases = /(outside the united states|outside the us|international|overseas|export|ship abroad|ship overseas)/.test(t);
  const purchaseIntent =
    /(buy|purchase|order|quote|price|availability|ship|export|deliver|send to|sell)/.test(t);
  return (isNonUsPhone(from) && purchaseIntent) || ((country || intlPhrases) && purchaseIntent);
}

function hasSchedulingIntent(text: string): boolean {
  const t = text.toLowerCase();
  const hasDayToken = /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(t);
  const hasTimeWord = /\b(\d{1,2})(?::\d{2})?\s*(am|pm)\b/.test(t);
  const hasAtHour = /\b(?:at|for|around|by)\s*(\d{1,2})\b(?!\s*\/)/.test(t);
  const hasBareHour = /\b(1[0-2]|[1-9])\b(?!\s*\/)/.test(t);
  if (hasDayToken && (hasTimeWord || hasAtHour || hasBareHour)) return true;
  return (
    /(appointment|appt|schedule|book|reserve)/.test(t) ||
    /(come in|stop in|stop by|swing by|visit)/.test(t) ||
    /(test ride|demo ride)/.test(t) ||
    /(trade appraisal|appraisal|value my trade)/.test(t) ||
    /(finance|credit|prequal)/.test(t) ||
    /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/.test(t)
  );
}

function toTitleCase(label: string): string {
  return label
    .toLowerCase()
    .split(/\s+/)
    .map(word => {
      if (!word) return "";
      return word[0].toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function normalizeModelLabel(label?: string | null): string {
  if (!label) return "that bike";
  const trimmed = label.trim();
  if (!trimmed) return "that bike";
  if (isUnknownModel(trimmed)) return "that bike";
  const letters = trimmed.replace(/[^A-Za-z]/g, "");
  const isAllCaps = letters.length > 0 && letters === letters.toUpperCase();
  return isAllCaps ? toTitleCase(trimmed) : trimmed;
}

function mapMsrpModelAlias(model?: string | null): string | null {
  const raw = String(model ?? "").toLowerCase().trim();
  if (!raw) return null;
  if (/road glide\s*3/.test(raw) || /\brg3\b/.test(raw) || /\bfltrt\b/.test(raw)) {
    return "Road Glide Trike";
  }
  return model ?? null;
}

function isUnknownModel(label?: string | null): boolean {
  if (!label) return true;
  const trimmed = label.trim().toLowerCase();
  if (!trimmed) return true;
  return trimmed === "other" || /\bother\b/.test(trimmed) || /\bfull\s*line\b/.test(trimmed);
}

function buildScheduleInvite(hasConcreteInventory: boolean): string {
  if (hasConcreteInventory) {
    return "I can set up a time to stop in and check out the bike and go over options.";
  }
  return "I can set up a time to stop in.";
}

function isCreditAppSource(source?: string | null, sourceId?: number | null): boolean {
  const creditIds = new Set([2852, 2883, 2915, 2946, 2949, 2955, 2956, 2928, 2930]);
  if (sourceId != null && creditIds.has(sourceId)) return true;
  const s = (source ?? "").toLowerCase();
  return (
    /credit application|apply for credit|finance application|prequal|pre-qual|prequalify|coa|dfi/.test(s) ||
    /hdfs.*prequal|hdfs.*credit/.test(s)
  );
}

function inferAppointmentType(
  text: string
): "inventory_visit" | "test_ride" | "trade_appraisal" | "finance_discussion" {
  const t = text.toLowerCase();
  if (/(test ride|demo ride)/.test(t)) return "test_ride";
  if (detectTradeRequest(t) || /\bappraisal\b/.test(t)) return "trade_appraisal";
  if (/(finance|credit|prequal|hdfs|payment)/.test(t)) return "finance_discussion";
  return "inventory_visit";
}

type HandoffReason = "pricing" | "payments" | "approval" | "manager" | "other";

function buildLongTermMessage(timeframe?: string, hasLicense?: boolean) {
  const tf = timeframe ? timeframe.trim() : "a future";
  if (hasLicense === true) {
    return `Hi, this is Brooke at American Harley-Davidson. You mentioned a ${tf} timeline. I’m here when you’re ready. Just reach out when the time is right.`;
  }
  return `Hi, this is Brooke at American Harley-Davidson. You mentioned a ${tf} timeline. I’m here when you’re ready. Just reach out when the time is right.`;
}

function deriveModelFromDescription(desc?: string | null): string | null {
  if (!desc) return null;
  let s = desc.replace(/\s+/g, " ").trim();
  s = s.replace(/^harley[- ]?davidson\s+/i, "");
  s = s.replace(/\b(20\d{2})\b/, "").trim();
  return s || null;
}

function deriveYearFromText(text?: string | null): string | null {
  if (!text) return null;
  const m = text.match(/\b(20\d{2})\b/);
  return m?.[1] ?? null;
}

function resolveModelFromText(
  text: string | null | undefined,
  models: string[]
): string | null {
  const t = String(text ?? "").toLowerCase();
  if (!t || !models.length) return null;
  const sorted = [...models].sort((a, b) => b.length - a.length);
  return sorted.find(m => t.includes(m.toLowerCase())) ?? null;
}

const DEFAULT_MODEL_FALLBACK = [
  "CVO Road Glide ST",
  "CVO Street Glide ST",
  "Road Glide ST",
  "Street Glide ST",
  "Road Glide",
  "Street Glide",
  "Road King",
  "Pan America",
  "Pan America Special",
  "Pan America ST",
  "Sportster S",
  "Nightster S",
  "Nightster",
  "Low Rider ST",
  "Low Rider S",
  "Fat Boy",
  "Heritage Classic",
  "Breakout",
  "Street Bob",
  "Softail Standard",
  "Electra Glide",
  "Ultra Limited",
  "Tri Glide",
  "Freewheeler",
  "Iron 883",
  "Forty-Eight",
  "Fat Bob",
  "Softail"
];

function getModelCandidates(inventoryModels: string[]): string[] {
  const allModels = getAllModels();
  const merged = [...inventoryModels, ...allModels, ...DEFAULT_MODEL_FALLBACK]
    .map(m => String(m ?? "").trim())
    .filter(Boolean);
  return Array.from(new Set(merged));
}

function normalizeModelMatchText(text?: string | null): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveModelsFromText(
  text: string | null | undefined,
  models: string[]
): string[] {
  const t = normalizeModelMatchText(text);
  if (!t || !models.length) return [];
  const sorted = [...models].sort((a, b) => b.length - a.length);
  const matches: string[] = [];
  for (const model of sorted) {
    const key = normalizeModelMatchText(model);
    if (!key) continue;
    if (t.includes(key)) matches.push(model);
  }
  return Array.from(new Set(matches));
}

function extractMonthlyBudget(text?: string | null): number | null {
  if (!text) return null;
  const t = String(text);
  const capped = t.match(/\b(?:no more than|max(?:imum)?|under|<=?)\s*\$?\s*([0-9][0-9,]{1,6})\b/i);
  if (capped?.[1]) return Number(capped[1].replace(/,/g, ""));
  const dollar = t.match(/\$\s*([0-9][0-9,]{1,6})\b/);
  if (dollar && /\b(month|monthly|mo)\b/i.test(t)) {
    return Number(dollar[1].replace(/,/g, ""));
  }
  return null;
}

function isUsedCondition(condition?: string | null, year?: string | null): boolean {
  const cond = String(condition ?? "").toLowerCase();
  if (/(pre|used|pre-owned|preowned|owned)/.test(cond)) return true;
  const yearNum = year ? Number(year) : null;
  if (!cond && yearNum && Number.isFinite(yearNum)) {
    const nowYear = new Date().getFullYear();
    return yearNum <= nowYear - 2;
  }
  return false;
}

function normalizeRequestedInventoryCondition(raw?: string | null): "new" | "used" | null {
  const t = String(raw ?? "").toLowerCase().trim();
  if (!t) return null;
  if (/(pre|used|pre-owned|preowned|owned)/.test(t)) return "used";
  if (/\bnew\b/.test(t)) return "new";
  return null;
}

function detectRequestedInventoryConditionFromText(text?: string | null): "new" | "used" | null {
  return normalizeRequestedInventoryCondition(text);
}

function inferInventoryItemCondition(item: any): "new" | "used" | null {
  const explicit = normalizeRequestedInventoryCondition(item?.condition);
  if (explicit) return explicit;
  const yearNum = Number(String(item?.year ?? ""));
  if (Number.isFinite(yearNum) && yearNum > 0) {
    const nowYear = new Date().getFullYear();
    return yearNum <= nowYear - 2 ? "used" : "new";
  }
  return null;
}

function inventoryItemMatchesRequestedCondition(
  item: any,
  requestedCondition: "new" | "used" | null
): boolean {
  if (!requestedCondition) return true;
  return inferInventoryItemCondition(item) === requestedCondition;
}

function formatRequestedConditionPrefix(condition: "new" | "used" | null): string {
  return condition ? `${condition} ` : "";
}

function resolveModelFromHistory(
  history: { direction: "in" | "out"; body: string }[] | undefined,
  models: string[]
): string | null {
  if (!history?.length || !models.length) return null;
  const ordered = [...history].reverse();
  for (const msg of ordered) {
    const match = resolveModelFromText(msg.body, models);
    if (match) return match;
  }
  return null;
}

function inferRequestedDay(text: string): string | null {
  const t = text.toLowerCase();
  if (/(sat|saturday)/.test(t)) return "saturday";
  if (/(sun|sunday)/.test(t)) return "sunday";
  if (/(mon|monday)/.test(t)) return "monday";
  if (/(tue|tuesday)/.test(t)) return "tuesday";
  if (/(wed|wednesday)/.test(t)) return "wednesday";
  if (/(thu|thursday)/.test(t)) return "thursday";
  if (/(fri|friday)/.test(t)) return "friday";
  if (/(today)/.test(t)) return "today";
  if (/(tomorrow)/.test(t)) return "tomorrow";
  return null;
}

function looksLikeOptOut(body: string): boolean {
  const t = String(body ?? "").trim().toLowerCase();
  if (!t) return false;
  if (/\?/.test(t)) return false;
  if (detectPricingOrPayment(t) || detectPaymentPressure(t) || detectExactNumberPressure(t)) {
    return false;
  }
  if (detectCallbackRequest(t)) return false;
  if (
    /(schedule|book|appointment|come in|stop in|set up|availability|available|in stock|test ride|demo|hours|open|close|location|address)/.test(
      t
    )
  ) {
    return false;
  }
  return t === "stop" || t === "unsubscribe" || t === "cancel";
}

function stripRescheduleOffers(text: string): string {
  return text
    .split("\n")
    .filter(line => !/^\s*if you need a different time/i.test(line.trim()))
    .join("\n")
    .trim();
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  return aStart < bEnd && bStart < aEnd;
}

function enforceNoPrematureBooking(draft: string, appointment: any) {
  if (appointment?.status === "confirmed") return draft;

  const out = draft
    .replace(
      /\b(i have you|you('| a)?re|you are)\s+(scheduled|booked|confirmed|all set|set)\b/gi,
      "I can set up a time"
    )
    .replace(/\bsee you\b/gi, "I can set up a time")
    .trim();
  return out;
}

export async function orchestrateInbound(
  event: InboundMessageEvent,
  history: { direction: "in" | "out"; body: string }[],
  ctx?: {
    appointment?: any;
    followUp?: any;
    leadSource?: string | null;
    bucket?: string | null;
    cta?: string | null;
    lead?: LeadProfile | null;
    pricingAttempts?: number;
    allowSchedulingOffer?: boolean;
    schedulingText?: string | null;
    callbackRequestedOverride?: boolean;
    appointmentTypeOverride?: "inventory_visit" | "test_ride" | "trade_appraisal" | "finance_discussion";
    voiceSummary?: string | null;
    memorySummary?: string | null;
    memorySummaryShouldUpdate?: boolean;
    inventoryWatch?: any;
    inventoryWatches?: any;
    hold?: any;
    sale?: any;
    pickup?: any;
    weather?: { bad?: boolean; cold?: boolean; snow?: boolean } | null;
  }
): Promise<OrchestratorResult> {
  await loadSystemPrompt("orchestrator");

  let flowDebug: OrchestratorResult["debugFlow"] | null = null;
  const finalize = (result: OrchestratorResult): OrchestratorResult => {
    const out: OrchestratorResult = {
      ...result,
      suggestedSlots: result.suggestedSlots ?? [],
      debugFlow: result.debugFlow ?? flowDebug ?? undefined
    };
    console.log("[orchestrateInbound] return", {
      provider: event.provider,
      suggestedSlotsLen: out.suggestedSlots?.length ?? 0
    });
    return out;
  };

  const useLLM = process.env.LLM_ENABLED === "1" && !!process.env.OPENAI_API_KEY;

  if (looksLikeOptOut(event.body)) {
    return finalize({
      intent: "GENERAL",
      stage: "ENGAGED",
      shouldRespond: true,
      draft: "Got it — I won’t message you again."
    });
  }

  const mergedBody = mergePendingInboundText(String(event.body ?? ""), history ?? []);
  if (mergedBody && mergedBody !== event.body) {
    event.body = mergedBody;
  }

  const canSmallTalk =
    event.provider !== "sendgrid_adf" &&
    event.provider !== "debug" &&
    event.provider !== "voice_transcript";
  if (canSmallTalk) {
    const rawText = String(event.body ?? "").trim();
    const quickSmallTalk = isEmojiOnly(rawText) || isShortPleasantry(rawText);
    const gratitude =
      /(thanks|thank you|thx|ty|appreciate)/i.test(rawText) &&
      !/\?/.test(rawText) &&
      !hasStrongIntentSignal(rawText);
    let smallTalk = quickSmallTalk || gratitude;
    if (!smallTalk && useLLM && isSmallTalkCandidate(rawText)) {
      const classified = await classifySmallTalkWithLLM({ text: rawText, history });
      if (classified?.smallTalk && (classified.confidence ?? 0) >= 0.7) {
        smallTalk = true;
      }
    }
    if (smallTalk) {
      const draft = pickSmallTalkReply(rawText);
      return finalize({
        intent: "GENERAL",
        stage: "ENGAGED",
        shouldRespond: true,
        draft,
        smallTalk: true
      });
    }
  }

  const leadSourceRaw = (ctx?.leadSource ?? ctx?.lead?.source ?? "").toLowerCase();
  const isSellMyBike = /sell my bike/.test(leadSourceRaw);
  const hasPriorOutbound =
    Array.isArray(history) &&
    history.some(m => m.direction === "out");
  if (isSellMyBike) {
    const leadFirst = ctx?.lead?.firstName?.trim() || "there";
    const yearLabel = ctx?.lead?.vehicle?.year ? `${ctx.lead.vehicle.year} ` : "";
    const modelLabel = normalizeModelLabel(ctx?.lead?.vehicle?.model ?? ctx?.lead?.vehicle?.description);
    const mileage = ctx?.lead?.vehicle?.mileage;
    const mileageLine = mileage ? ` I have the mileage at ${mileage.toLocaleString()}.` : " What’s the mileage?";
    const sellOption = ctx?.lead?.sellOption ?? null;
    const optionLine =
      sellOption === "cash"
        ? "Are you looking for a straight cash offer, or would you consider trading toward another bike?"
        : sellOption === "trade"
          ? "What are you hoping to trade into?"
          : sellOption === "either"
            ? "Are you leaning more toward a cash offer or trade credit?"
            : "Are you looking for a cash offer or trade credit?";
    const weatherBad = !!ctx?.weather?.bad;
    const pickup = ctx?.pickup ?? {};
    const pickupKnown = !!pickup?.town;
    const pickupEligible = pickup?.eligible === true;
    const pickupPendingTown = pickup?.stage === "need_town";
    const pickupUnknown = !pickupKnown && !pickupPendingTown;
    const wantsPickupPrompt = weatherBad && pickupUnknown;
    const pickupOfferLine = pickupEligible
      ? " If the weather’s rough, we can pick the bike up."
      : weatherBad && pickupKnown && pickup?.eligible === false
        ? ""
        : "";

    if (hasPriorOutbound) {
      const followUp =
        sellOption === "cash"
          ? `Got it — for a straight cash offer, we’ll need an in‑person appraisal.${pickupOfferLine} If you want to stop in, I can set a time.`
          : sellOption === "trade"
            ? "Great — what model are you hoping to trade into?"
            : sellOption === "either"
              ? "Understood — are you leaning more toward a cash offer or trade credit?"
              : "Are you looking for a cash offer or trade credit?";
      if (wantsPickupPrompt) {
        const prompt =
          "Got it — for a straight cash offer, we’ll need an in‑person appraisal. " +
          "If the weather’s rough, we can pick the bike up. What town are you located in?";
        return finalize({
          intent: "TRADE_IN",
          stage: "ENGAGED",
          shouldRespond: true,
          draft: prompt,
          pickupUpdate: { stage: "need_town" }
        });
      }
      return finalize({
        intent: "TRADE_IN",
        stage: "ENGAGED",
        shouldRespond: true,
        draft: followUp
      });
    }
    if (wantsPickupPrompt) {
      const draft =
        `Hi ${leadFirst} — thanks for reaching out about selling your ${yearLabel}${modelLabel}. ` +
        `I can help with a trade‑in appraisal.${mileageLine} If the weather’s rough, we can pick the bike up. ` +
        "What town are you located in?";
      return finalize({
        intent: "TRADE_IN",
        stage: "ENGAGED",
        shouldRespond: true,
        draft,
        pickupUpdate: { stage: "need_town" }
      });
    }
    const draft =
      `Hi ${leadFirst} — thanks for reaching out about selling your ${yearLabel}${modelLabel}. ` +
      `I can help with a trade‑in appraisal.${mileageLine} ${optionLine}` +
      `${pickupOfferLine} If you want to stop in, I can set a time.`;
    return finalize({
      intent: "TRADE_IN",
      stage: "ENGAGED",
      shouldRespond: true,
      draft
    });
  }

  const sourceId = ctx?.lead?.sourceId ?? null;
  const isCreditAppLead = isCreditAppSource(leadSourceRaw, sourceId);
  if (isCreditAppLead && event.provider === "sendgrid_adf") {
    const leadFirst = ctx?.lead?.firstName?.trim() || "there";
    const yearLabel = ctx?.lead?.vehicle?.year ? `${ctx.lead.vehicle.year} ` : "";
    const modelLabel = normalizeModelLabel(ctx?.lead?.vehicle?.model ?? ctx?.lead?.vehicle?.description);
    const dealerProfile = await getDealerProfile();
    const agentName = dealerProfile?.agentName ?? "Brooke";
    const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
    const draft =
      `Hi ${leadFirst} — thanks for your interest in the ${yearLabel}${modelLabel}. ` +
      `This is ${agentName} at ${dealerName}. We received your online credit application. ` +
      "I’ll have our business manager reach out to go over your options.";
    return finalize({
      intent: "FINANCING",
      stage: "ENGAGED",
      shouldRespond: true,
      draft,
      handoff: { required: true, reason: "approval", ack: draft }
      });
  }

  const isDemoRideEventLead = ctx?.bucket === "event_promo" && ctx?.cta === "demo_ride_event";
  if (isDemoRideEventLead && event.provider === "sendgrid_adf") {
    const dealerProfile = await getDealerProfile();
    const agentName = dealerProfile?.agentName ?? "Brooke";
    const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
    const leadFirst = ctx?.lead?.firstName?.trim() || "there";
    const yearLabel = ctx?.lead?.vehicle?.year ? `${ctx.lead.vehicle.year} ` : "";
    const modelLabel = normalizeModelLabel(ctx?.lead?.vehicle?.model ?? ctx?.lead?.vehicle?.description);
    const bikeLabel = `${yearLabel}${modelLabel}`.trim() || "that bike";
    const draft =
      `Hi ${leadFirst} — thanks for your recent demo ride on the ${bikeLabel}. ` +
      `This is ${agentName} at ${dealerName}. ` +
      `If you want more details on the ${bikeLabel}, I’m happy to help.`;
    return finalize({
      intent: "GENERAL",
      stage: "ENGAGED",
      shouldRespond: true,
      draft
    });
  }

  const corporateIntent = !isSellMyBike && detectCorporateIntent(event.body);
  const internationalBuyer = detectInternationalBuyer(event.body, event.from);
  if (corporateIntent || internationalBuyer) {
    const dealerProfile = await getDealerProfile();
    const agentName = dealerProfile?.agentName ?? "Brooke";
    const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
    if (corporateIntent) {
      const ack =
        `Hi, this is ${agentName} at ${dealerName}. ` +
        "We’re a dealership, not Harley‑Davidson corporate. " +
        "For corporate assistance, please call 800‑258‑2464.";
      return finalize({
        intent: "GENERAL",
        stage: "ENGAGED",
        shouldRespond: true,
        draft: ack,
        autoClose: { reason: "corporate" }
      });
    }
    const ack =
      `Hi, this is ${agentName} at ${dealerName}. ` +
      "Thanks for reaching out. We can only sell to customers in the United States.";
    return finalize({
      intent: "GENERAL",
      stage: "ENGAGED",
      shouldRespond: true,
      draft: ack,
      autoClose: { reason: "international" }
    });
  }

  const intent = simpleIntent(event.body);
  const pricingAttempts = ctx?.pricingAttempts ?? 0;
  const managerRequest = detectManagerRequest(event.body);
  const approvalStatus = detectApprovalStatus(event.body);
  const callbackRequest =
    typeof ctx?.callbackRequestedOverride === "boolean"
      ? ctx.callbackRequestedOverride
      : detectCallbackRequest(event.body);
  const depositRequest = detectDepositRequest(event.body);
  const hoursRequest = detectHoursRequest(event.body);
  const pricingIntent =
    detectPricingOrPayment(event.body, intent) ||
    /request a quote|raq/i.test(ctx?.leadSource ?? "");

  if (isUsedDealerTrustStatement(event.body)) {
    const model = normalizeModelLabel(
      ctx?.lead?.vehicle?.model ?? ctx?.lead?.vehicle?.description
    );
    const yearLabel = ctx?.lead?.vehicle?.year ? `${ctx.lead.vehicle.year} ` : "";
    const modelLine = model ? `${yearLabel}${model}`.trim() : "that model";
    return finalize({
      intent: "GENERAL",
      stage: "ENGAGED",
      shouldRespond: true,
      draft:
        `Totally get it — buying through a dealer usually gives a lot more peace of mind than Facebook. ` +
        `I can keep an eye out for a used ${modelLine} and send over options as soon as we get one. ` +
        "Are you set on that model or open to similar ones?"
    });
  }

  const dialogActParserEligible =
    useLLM &&
    process.env.LLM_DIALOG_ACT_PARSER_ENABLED === "1" &&
    event.provider === "twilio";
  const dialogActParse =
    dialogActParserEligible &&
    intent === "GENERAL" &&
    !pricingIntent &&
    !depositRequest &&
    !hoursRequest &&
    !managerRequest &&
    !approvalStatus &&
    !callbackRequest
      ? await parseDialogActWithLLM({
          text: event.body,
          history,
          lead: ctx?.lead ?? undefined
        })
      : null;
  const dialogActConfidence =
    typeof dialogActParse?.confidence === "number" ? dialogActParse.confidence : 0;
  const dialogActConfidenceMin = Number(process.env.LLM_DIALOG_ACT_CONFIDENCE_MIN ?? 0.75);
  const dialogActAccepted =
    !!dialogActParse &&
    dialogActParse.act !== "none" &&
    !dialogActParse.explicitRequest &&
    dialogActConfidence >= dialogActConfidenceMin;
  if (process.env.DEBUG_DIALOG_ACT === "1" && dialogActParse) {
    console.log("[llm-dialog-act]", {
      act: dialogActParse.act,
      topic: dialogActParse.topic,
      explicitRequest: dialogActParse.explicitRequest,
      nextAction: dialogActParse.nextAction,
      askFocus: dialogActParse.askFocus,
      confidence: dialogActParse.confidence
    });
  }
  if (dialogActAccepted) {
    const dialogActDraft = buildDialogActReply({
      act: dialogActParse.act,
      topic: dialogActParse.topic,
      nextAction: dialogActParse.nextAction,
      askFocus: dialogActParse.askFocus,
      lead: ctx?.lead ?? null
    });
    if (dialogActDraft) {
      return finalize({
        intent: "GENERAL",
        stage: "ENGAGED",
        shouldRespond: true,
        draft: dialogActDraft
      });
    }
  }

  if (depositRequest) {
    const dealerProfile = await getDealerProfile();
    const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
    const agentName = dealerProfile?.agentName ?? "Brooke";
    const firstName = ctx?.lead?.firstName?.trim() || "";
    const greeting = firstName ? `Hi ${firstName} — ` : "";
    const leadIn = pickDepositLeadIn(event.body);
    const modelLabel = normalizeModelLabel(
      ctx?.lead?.vehicle?.model ?? ctx?.lead?.vehicle?.description
    );
    const yearLabel = ctx?.lead?.vehicle?.year ? `${ctx.lead.vehicle.year} ` : "";
    const bikeLabel = modelLabel ? `${yearLabel}${modelLabel}`.trim() : null;
    const unitLine = bikeLabel ? ` for the ${bikeLabel}` : "";
    const draft = `${greeting}${leadIn} To leave a deposit${unitLine}, you can either stop by or I can have someone from ${dealerName} call you and take it by phone. Which do you prefer?`;
    return finalize({
      intent: "GENERAL",
      stage: "ENGAGED",
      shouldRespond: true,
      draft
    });
  }

  const noTradeMentioned =
    /(no trade|no trade[-\s]?in|no tradein|don't have a trade|dont have a trade|without a trade)/i.test(
      event.body
    );
  if (
    (intent === "TRADE_IN" || detectTradeRequest(event.body)) &&
    !noTradeMentioned &&
    detectTradeRequest(event.body) &&
    /(how|what|price|value|appraisal|bring|see it|pickup|pick up|give me|give)/i.test(event.body)
  ) {
    const trade = ctx?.lead?.tradeVehicle ?? {};
    const tradeYear = trade?.year ? `${trade.year} ` : "";
    const tradeMake = trade?.make ? `${trade.make} ` : "";
    const tradeModel = trade?.model ?? trade?.description ?? "";
    const tradeLabel = `${tradeYear}${tradeMake}${tradeModel}`.replace(/\s+/g, " ").trim();
    const hasTrade = tradeLabel.length > 0;
    const mileage = trade?.mileage;
    const mileageLine = mileage ? `I have it at about ${mileage.toLocaleString()} miles. ` : "";
    const mileageAsk = mileage ? "" : "How many miles are on it?";
    const leadLine = hasTrade ? `I have you on a ${tradeLabel}. ` : "";
    const draft =
      "Totally fair question. " +
      leadLine +
      mileageLine +
      "We can start with an estimate based on the bike details. " +
      "If the numbers look good, you can bring it in for an appraisal or I can schedule a pickup. " +
      mileageAsk;
    return finalize({
      intent: "TRADE_IN",
      stage: "ENGAGED",
      shouldRespond: true,
      draft
    });
  }
  const exactPressure = detectExactNumberPressure(event.body);
  const pricingAttempted = pricingIntent && pricingAttempts === 0;
  const stockIdFromText = event.body.match(/\b[A-Z0-9]{1,5}-\d{1,4}\b/i)?.[0]?.toUpperCase() ?? null;

  let handoff: { required: true; reason: HandoffReason } | null = null;
  let callbackRequested = false;

  if (managerRequest) {
    if (!useLLM) {
      const ack = "Got it — I’ll have a manager follow up shortly.";
      return finalize({
        intent,
        stage: "ENGAGED",
        shouldRespond: true,
        draft: ack,
        handoff: { required: true, reason: "manager", ack }
      });
    }
    if (!handoff) handoff = { required: true, reason: "manager" };
  }

  if (approvalStatus) {
    if (!useLLM) {
      const ack = "Got it — I’ll have our team check the status and follow up shortly.";
      return finalize({
        intent,
        stage: "ENGAGED",
        shouldRespond: true,
        draft: ack,
        handoff: { required: true, reason: "approval", ack }
      });
    }
    if (!handoff) handoff = { required: true, reason: "approval" };
  }

  if (callbackRequest) {
    if (!useLLM) {
      const dealerProfile = await getDealerProfile();
      const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
      const agentName = dealerProfile?.agentName ?? "Brooke";
      const firstName = ctx?.lead?.firstName?.trim() || "";
      const greeting = firstName ? `Hi ${firstName} — ` : "Hi — ";
      const rawModel = ctx?.lead?.vehicle?.model ?? ctx?.lead?.vehicle?.description ?? "";
      const modelKnown = !!rawModel && !isUnknownModel(rawModel);
      const yearLabel = ctx?.lead?.vehicle?.year ? `${ctx.lead.vehicle.year} ` : "";
      const modelLabel = normalizeModelLabel(rawModel);
      const thanks = modelKnown
        ? `Thanks for your interest in the ${yearLabel}${modelLabel}. `
        : "Thanks for your inquiry. ";
      const salesName = await detectSalespersonMention(event.body);
      const reachOut = salesName
        ? `I’ll have ${salesName} reach out.`
        : "I’ll have someone from our sales team reach out.";
      const ack =
        `${greeting}${thanks}` +
        `This is ${agentName} at ${dealerName}. ` +
        `${reachOut}`;
      return finalize({
        intent,
        stage: "ENGAGED",
        shouldRespond: true,
        draft: ack,
        handoff: { required: true, reason: "other", ack }
      });
    }
    callbackRequested = true;
    if (!handoff) handoff = { required: true, reason: "other" };
  }

  if (hoursRequest) {
    try {
      const cfg = await getSchedulerConfig();
      const hoursLine = formatBusinessHours(cfg.businessHours);
      const requestedDay = inferRequestedDay(event.body);
      const wantsVisit =
        hasSchedulingIntent(event.body) ||
        /(stop in|come in|come by|stop by|swing by|try to stop|try to come|head in|head over|make it in|make it|what about)/i.test(
          event.body
        ) ||
        !!requestedDay;
      const salesLead =
        !!ctx?.lead?.vehicle?.model ||
        !!ctx?.lead?.vehicle?.description ||
        !!ctx?.lead?.vehicle?.stockId ||
        !!ctx?.lead?.vehicle?.vin;
      const tz = cfg.timezone ?? "America/New_York";
      const todayKey = dayKey(new Date(), tz);
      const todayHours = cfg.businessHours?.[todayKey];
      const closeToday = todayHours?.close ?? null;
      const hoursTodayLine = closeToday ? `We're open until ${closeToday} today.` : null;
      const requestedDayKey = requestedDay ?? null;
      const requestedDayLabel = requestedDayKey
        ? requestedDayKey.replace(/^\w/, c => c.toUpperCase())
        : null;
      const requestedHours = requestedDayKey ? cfg.businessHours?.[requestedDayKey] : null;
      const requestedHoursLine =
        requestedDayLabel && requestedHours?.open && requestedHours?.close
          ? `We're open ${requestedDayLabel} ${formatHoursRange(requestedHours.open, requestedHours.close)}.`
          : null;
      if (hoursLine) {
        if (wantsVisit && salesLead) {
          try {
            const appointmentType = inferAppointmentType(event.body);
            const durationMinutes =
              cfg.appointmentTypes?.[appointmentType]?.durationMinutes ?? 60;
            const now = new Date();
            let candidatesByDay = generateCandidateSlots(cfg, now, durationMinutes, 7);
            if (requestedDayKey) {
              candidatesByDay = candidatesByDay.filter(
                d => dayKey(d.dayStart, tz) === requestedDayKey
              );
            }

            const preferredSalespeople = getPreferredSalespeople(cfg);
            const salespeople = cfg.salespeople ?? [];
            const gapMinutes = cfg.minGapBetweenAppointmentsMinutes ?? 60;
            const cal = await getAuthedCalendarClient();
            let suggested: any[] = [];
            for (const salespersonId of preferredSalespeople) {
              const sp = salespeople.find(s => s.id === salespersonId);
              if (!sp) continue;
              const fb = await queryFreeBusy(
                cal,
                [sp.calendarId],
                now.toISOString(),
                new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                cfg.timezone
              );
              const busy = (fb.calendars?.[sp.calendarId]?.busy ?? []) as any;
              const expanded = expandBusyBlocks(busy, gapMinutes);
              suggested = pickSlotsForSalesperson(
                cfg,
                sp.id,
                sp.calendarId,
                candidatesByDay,
                expanded,
                2
              );
              if (suggested.length >= 2) break;
            }
            const a = suggested[0]?.start ? formatSlotLocal(suggested[0].start, tz) : null;
            const b = suggested[1]?.start ? formatSlotLocal(suggested[1].start, tz) : null;
            const scheduleLine =
              a && b
                ? `If you want to come by, a time can be reserved — ${a} or ${b}. Which works?`
                : "If you want to come by, what time works best?";
            const hoursText =
              requestedHoursLine ?? hoursTodayLine ?? `Our hours this week are ${hoursLine}.`;
            return finalize({
              intent,
              stage: "ENGAGED",
              shouldRespond: true,
              draft: `${hoursText} ${scheduleLine}`
            });
          } catch {
            const hoursText =
              requestedHoursLine ?? hoursTodayLine ?? `Our hours this week are ${hoursLine}.`;
            return finalize({
              intent,
              stage: "ENGAGED",
              shouldRespond: true,
              draft: `${hoursText} If you want to come by, what time works best?`
            });
          }
        }
        return finalize({
          intent,
          stage: "ENGAGED",
          shouldRespond: true,
          draft: requestedHoursLine ?? hoursTodayLine ?? `Our hours this week are ${hoursLine}.`
        });
      }
    } catch {}
    return finalize({
      intent,
      stage: "ENGAGED",
      shouldRespond: true,
      draft: "Our hours vary by day. What day are you thinking?"
    });
  }

  const fallbackDraft = "Thanks for reaching out. How can I help?";
  const dayName = extractDayName(event.body);
  const dayPart = extractDayPart(event.body);
  const timeMatch = String(event.body ?? "").match(/\b(\d{1,2})(?::\d{2})?\s*(am|pm)\b/i);
  const financeRequest =
    detectFinanceRequest(event.body) || detectFinanceApplyFollowUp(event.body, history ?? []);
  const explicitTradeRequest = detectTradeRequest(event.body);
  const availabilityAskedMulti = /(available|availability|still there|in stock|do you have|have any)/i.test(event.body);
  const wantsAvailability = (availabilityAskedMulti || intent === "AVAILABILITY") && !explicitTradeRequest;
  const wantsScheduling = hasSchedulingIntent(event.body) || !!dayName || !!dayPart || !!timeMatch;
  const wantsPayments =
    detectPaymentPressure(event.body) ||
    detectPaymentFollowUp(event.body, history ?? []);
  const wantsTrade = intent === "TRADE_IN" || explicitTradeRequest;
  const multiIntentCount = [wantsAvailability, wantsScheduling, wantsPayments, wantsTrade].filter(Boolean).length;
  const ambiguousFlow =
    intent === "GENERAL" &&
    multiIntentCount === 0 &&
    !pricingIntent &&
    !financeRequest &&
    !hoursRequest &&
    !managerRequest &&
    !approvalStatus &&
    !callbackRequest;
  flowDebug = {
    at: new Date().toISOString(),
    ambiguousFlow,
    intent,
    signals: {
      pricingIntent,
      financeRequest,
      hoursRequest,
      managerRequest,
      approvalStatus,
      callbackRequest,
      wantsAvailability,
      wantsScheduling,
      wantsPayments,
      wantsTrade,
      multiIntentCount
    }
  };
  if (process.env.LLM_DEBUG_FLOW === "1") {
    // eslint-disable-next-line no-console
    console.log("[llm-flow]", { leadKey: event.from, ...flowDebug });
  }

  const pricingTermsOnly = /(price|pricing|msrp|cost|how much|what's the price|what is the price|out the door|\botd\b|total price)/i.test(
    String(event.body ?? "")
  );
  if (financeRequest && !pricingTermsOnly && !wantsPayments) {
    const dealerProfile = await getDealerProfile();
    const draft = buildFinanceAppLine(dealerProfile);
    return finalize({
      intent: "FINANCING",
      stage: "ENGAGED",
      shouldRespond: true,
      draft
    });
  }

  const monthlyBudget = extractMonthlyBudget(event.body);
  const wantsPreownedBudget =
    !!monthlyBudget &&
    /\b(pre[-\s]?owned|preowned|used|pre[-\s]?owned realm)\b/i.test(event.body) &&
    /\binsurance\b/i.test(event.body);
  if (wantsPreownedBudget) {
    try {
      const items = await getInventoryFeed();
      const models = Array.from(new Set(items.map(i => i.model).filter(Boolean))) as string[];
      const mentionedModels = resolveModelsFromText(event.body, models);
      const priceCap = 10000;
      const holds = await listInventoryHolds();
      const solds = await listInventorySolds();
      const matches = items.filter(i => {
        if (!i.model || !i.price || i.price > priceCap) return false;
        if (!isUsedCondition(i.condition, i.year)) return false;
        if (mentionedModels.length) {
          const modelKey = normalizeModelMatchText(i.model);
          const hasMatch = mentionedModels.some(m => normalizeModelMatchText(m) === modelKey);
          if (!hasMatch) return false;
        }
        const holdKey = normalizeInventoryHoldKey(i.stockId, i.vin);
        const soldKey = normalizeInventorySoldKey(i.stockId, i.vin);
        if (holdKey && holds?.[holdKey]) return false;
        if (soldKey && solds?.[soldKey]) return false;
        return true;
      });
      const sorted = matches.sort((a, b) => (a.price ?? 0) - (b.price ?? 0)).slice(0, 4);
      if (!sorted.length) {
        const modelNote = mentionedModels.length
          ? ` in ${mentionedModels.map(normalizeModelLabel).join(", ")}`
          : "";
        return finalize({
          intent: "PRICING",
          stage: "ENGAGED",
          shouldRespond: true,
          draft:
            `I don’t see any pre‑owned options under $10k${modelNote} right now. ` +
            `If you’re open to a higher budget or different models, tell me what you want to focus on.`
        });
      }
      const nf = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
      const channelIsEmail = event.channel === "email";
      const list = sorted
        .map(item => {
          const yearLabel = item.year ? `${item.year} ` : "";
          const modelLabel = normalizeModelLabel(item.model);
          const priceLabel = item.price ? nf.format(item.price) : "";
          const stockLabel = item.stockId ? ` (Stock ${item.stockId})` : "";
          const base = `${yearLabel}${modelLabel} — ${priceLabel}${stockLabel}`;
          const photo = channelIsEmail ? item.images?.[0] : null;
          return photo ? `${base}\nPhoto: ${photo}` : base;
        })
        .join(channelIsEmail ? "\n\n" : "; ");
      const budgetLine = monthlyBudget
        ? `Thanks for the detail. To stay around ~$${monthlyBudget}/mo (incl. insurance), you’d probably be looking at something $10k and under.`
        : "Thanks for the detail. You’d probably be looking at something $10k and under.";
      const firstName = (ctx?.lead?.firstName ?? "").trim() || "there";
      const greeting = channelIsEmail ? `Hey ${normalizeModelLabel(firstName)},\n\n` : "";
      const dealerProfile = await getDealerProfile();
      const inventoryLink = String(
        dealerProfile?.usedInventoryUrl ??
          dealerProfile?.preownedInventoryUrl ??
          ""
      ).trim();
      const extrasLine = inventoryLink
        ? `We do have a few others under $10k. Here’s our pre‑owned inventory link if you want to browse:\n${inventoryLink}`
        : "We do have a few others under $10k if you want me to pull more.";
      return finalize({
        intent: "PRICING",
        stage: "ENGAGED",
        shouldRespond: true,
        draft:
          `${greeting}${budgetLine} We currently have:\n\n${list}\n\n${extrasLine}`
      });
    } catch {
      return finalize({
        intent: "PRICING",
        stage: "ENGAGED",
        shouldRespond: true,
        draft:
          "I can pull pre‑owned options under $10k and send a few picks. Which models should I focus on?"
      });
    }
  }

  if (wantsAvailability && multiIntentCount === 1) {
    try {
      const items = await getInventoryFeed();
      const models = Array.from(new Set(items.map(i => i.model).filter(Boolean))) as string[];
      const modelCandidates = getModelCandidates(models);
      const lastOutbound = [...(history ?? [])].reverse().find(h => h.direction === "out")?.body ?? "";
      const modelFromInbound = resolveModelFromText(event.body, modelCandidates);
      const modelFromLastOutbound = resolveModelFromText(lastOutbound, modelCandidates);
      const modelFromHistory = resolveModelFromHistory(history, modelCandidates);
      const model =
        modelFromInbound ||
        modelFromLastOutbound ||
        modelFromHistory ||
        ctx?.lead?.vehicle?.model ||
        deriveModelFromDescription(ctx?.lead?.vehicle?.description ?? null) ||
        null;
      if (!model) {
        return finalize({
          intent: "AVAILABILITY",
          stage: "ENGAGED",
          shouldRespond: true,
          draft: "Which model are you asking about?"
        });
      }
      const yearFromInbound = deriveYearFromText(event.body);
      const year =
        yearFromInbound ??
        (modelFromInbound
          ? null
          : deriveYearFromText(lastOutbound) ?? ctx?.lead?.vehicle?.year ?? null);
      const msrpColors = await getMsrpColorNames();
      const colorFromInbound = extractColorMention(event.body, msrpColors);
      const color =
        colorFromInbound ||
        (modelFromInbound
          ? null
          : extractColorMention(lastOutbound, msrpColors) ||
            findRecentInboundColor(history, msrpColors) ||
            ctx?.lead?.vehicle?.color ||
            null);
      const conditionFromInbound = detectRequestedInventoryConditionFromText(event.body);
      const conditionFromContext = modelFromInbound
        ? null
        : detectRequestedInventoryConditionFromText(lastOutbound) ||
          normalizeRequestedInventoryCondition(ctx?.lead?.vehicle?.condition ?? null);
      const requestedCondition = conditionFromInbound || conditionFromContext;
      let matches = await findInventoryMatches({ year: year ?? null, model });
      if (requestedCondition) {
        matches = matches.filter(m => inventoryItemMatchesRequestedCondition(m, requestedCondition));
      }
      if (color) {
        const colorLower = color.toLowerCase();
        matches = matches.filter(m => (m.color ?? "").toLowerCase().includes(colorLower));
      }
      const holds = await listInventoryHolds();
      const solds = await listInventorySolds();
      const availableMatches = matches.filter(m => {
        const holdKey = normalizeInventoryHoldKey(m.stockId, m.vin);
        const soldKey = normalizeInventorySoldKey(m.stockId, m.vin);
        if (holdKey && holds?.[holdKey]) return false;
        if (soldKey && solds?.[soldKey]) return false;
        return true;
      });
      const count = availableMatches.length;
      const conditionPrefix = formatRequestedConditionPrefix(requestedCondition);
      const yearLabel = year ? `${year} ` : "";
      const modelLabel = normalizeModelLabel(model);
      const colorLabel = color ? ` in ${color}` : "";
      const preferencePrompt = buildOutOfStockPreferencePrompt({
        requestedCondition,
        color
      });
      const reply =
        count <= 0
          ? `I’m not seeing any ${conditionPrefix}${yearLabel}${modelLabel}${colorLabel} in stock right now. ${buildOutOfStockHumanOptionsLine()}${preferencePrompt ? ` ${preferencePrompt}` : ""}`
          : count === 1
            ? `We do have 1 ${conditionPrefix}${yearLabel}${modelLabel}${colorLabel} in stock. Want photos or details?`
            : `We have ${count} ${conditionPrefix}${yearLabel}${modelLabel}${colorLabel} in stock. Want photos or details on a specific one?`;
      return finalize({
        intent: "AVAILABILITY",
        stage: "ENGAGED",
        shouldRespond: true,
        draft: reply
      });
    } catch {
      return finalize({
        intent: "AVAILABILITY",
        stage: "ENGAGED",
        shouldRespond: true,
        draft: "Let me check inventory and get you an update."
      });
    }
  }

  if (multiIntentCount >= 2) {
    const leadVehicle = ctx?.lead?.vehicle ?? {};
    const modelRaw =
      leadVehicle?.model ??
      leadVehicle?.description ??
      deriveModelFromDescription(leadVehicle?.description ?? null) ??
      null;
    const yearRaw =
      leadVehicle?.year ??
      deriveYearFromText(leadVehicle?.description ?? null) ??
      null;
    const modelKnown = !!modelRaw && !isUnknownModel(modelRaw);
    const modelLabel = modelKnown ? normalizeModelLabel(modelRaw) : "that bike";
    const yearLabel = yearRaw ? `${yearRaw} ` : "";
    const bikeLabel = modelKnown ? `${yearLabel}${modelLabel}`.trim() : "that bike";
    const stockId = leadVehicle?.stockId ?? stockIdFromText ?? null;
    const vin = leadVehicle?.vin ?? null;

    let availabilityLine = "";
    if (wantsAvailability) {
      const requestedCondition =
        detectRequestedInventoryConditionFromText(event.body) ||
        normalizeRequestedInventoryCondition(leadVehicle?.condition ?? null);
      const conditionPrefix = formatRequestedConditionPrefix(requestedCondition);
      const preferencePrompt = buildOutOfStockPreferencePrompt({
        requestedCondition,
        color: leadVehicle?.color ?? null
      });
      let availabilityState: "available" | "unavailable" | "unknown" = "unknown";
      try {
        if (stockId || vin) {
          const feedMatch = await findInventoryPrice({ stockId, vin, year: yearRaw, model: modelRaw });
          if (feedMatch?.item) {
            availabilityState = inventoryItemMatchesRequestedCondition(feedMatch.item, requestedCondition)
              ? "available"
              : "unavailable";
          } else if (stockId) {
            const resolved = await resolveInventoryUrlByStock(stockId);
            if (resolved.ok) {
              const status = await checkInventorySalePendingByUrl(resolved.url);
              availabilityState = status === "AVAILABLE" ? "available" : status === "PENDING" ? "unavailable" : "unknown";
            }
          }
        } else if (modelRaw) {
          const matches = (await findInventoryMatches({ year: yearRaw, model: modelRaw })).filter(m =>
            inventoryItemMatchesRequestedCondition(m, requestedCondition)
          );
          availabilityState = matches.length ? "available" : "unavailable";
        }
      } catch {
        availabilityState = "unknown";
      }

      if (availabilityState === "available") {
        availabilityLine = `The ${conditionPrefix}${bikeLabel} is still available.`;
      } else if (availabilityState === "unavailable") {
        availabilityLine = modelKnown
          ? `I’m not seeing a ${conditionPrefix}${bikeLabel} in stock right now. ${buildOutOfStockHumanOptionsLine()}${preferencePrompt ? ` ${preferencePrompt}` : ""}`
          : `I’m not seeing that bike in stock right now. ${buildOutOfStockHumanOptionsLine()}`;
      } else {
        availabilityLine = modelKnown
          ? `I’m checking availability on the ${conditionPrefix}${bikeLabel} and will update you shortly.`
          : "I’m checking availability and will update you shortly.";
      }
    }

    let schedulingLine = "";
    if (wantsScheduling) {
      if (dayName || dayPart || timeMatch) {
        if (timeMatch) {
          const when = `${dayName ? `${dayName} ` : ""}${timeMatch[0]}`.trim();
          schedulingLine = `If you want to come by ${when}, I can reserve that time. Does that work on your end?`;
        } else if (dayName && dayPart) {
          schedulingLine = `If you want to come by ${dayName} ${dayPart}, what time works best?`;
        } else if (dayName) {
          schedulingLine = `If you want to come by ${dayName}, what time works best?`;
        } else if (dayPart) {
          schedulingLine = `If ${dayPart} works, what time should I plan for?`;
        }
      } else {
        schedulingLine = "If you’d like to stop in, what day and time works best?";
      }
    }

    let paymentsLine = "";
    if (wantsPayments) {
      try {
        const priceLookup = await findInventoryPrice({ stockId, vin, year: yearRaw, model: modelRaw });
        const range = modelRaw ? await findPriceRange({ year: yearRaw, model: modelRaw }) : null;
        const paymentRange =
          priceLookup?.price != null
            ? { min: priceLookup.price, max: priceLookup.price }
            : range?.min != null && range?.max != null
              ? { min: range.min, max: range.max }
              : null;
        const conditionRaw = [leadVehicle?.condition, (priceLookup as any)?.item?.condition]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        const isUsed = /(pre|used|pre-owned|preowned|owned)/.test(conditionRaw);
        const dealerProfile = await getDealerProfile();
        const taxRateRaw = Number((dealerProfile as any)?.taxRate ?? 8);
        const taxRate = Number.isFinite(taxRateRaw) ? (taxRateRaw > 1 ? taxRateRaw / 100 : taxRateRaw) : 0.08;
        const preferredTerm = extractPreferredTermMonths(event.body) ?? 60;
        const downInfo = parseDownPayment(event.body);
        const downPayment = downInfo?.amount;
        const downPaymentAssumed = downInfo?.assumedThousands ?? false;

        if (paymentRange) {
          paymentsLine = buildMonthlyPaymentLine({
            priceMin: paymentRange.min,
            priceMax: paymentRange.max,
            isUsed,
            termMonths: preferredTerm,
            taxRate,
            downPayment,
            downPaymentAssumed
          });
        } else {
          paymentsLine = "I can ballpark payments once I confirm the exact price.";
        }
      } catch {
        paymentsLine = "I can ballpark payments once I confirm the exact price.";
      }
    }

    let tradeLine = "";
    if (wantsTrade) {
      tradeLine = "We can start with an estimate based on the bike details and finalize it in person.";
    }

    const parts = [availabilityLine, paymentsLine, tradeLine, schedulingLine].filter(Boolean);
    const draft = parts.join(" ").trim() || fallbackDraft;
    return finalize({
      intent,
      stage: "ENGAGED",
      shouldRespond: true,
      draft
    });
  }

  if (pricingIntent && pricingAttempts >= 1 && !detectPaymentPressure(event.body)) {
    const reason = detectPaymentPressure(event.body) ? "payments" : "pricing";
    if (!useLLM) {
      const ack = exactPressure
        ? "Got it — I’ll have a manager pull the exact numbers and follow up shortly."
        : "Got it — I’ll have a manager pull the most accurate numbers and follow up shortly.";
      return finalize({
        intent,
        stage: "ENGAGED",
        shouldRespond: true,
        draft: ack,
        handoff: { required: true, reason, ack }
      });
    }
    if (!handoff) handoff = { required: true, reason };
  }

  if (pricingIntent) {
    try {
      const leadForPrice = ctx?.lead ?? {};
      const longTermMonths = leadForPrice?.purchaseTimeframeMonthsStart ?? null;
      const longTermTimeframe = leadForPrice?.purchaseTimeframe ?? "";
      const wantsSoftTimeline =
        event.provider === "sendgrid_adf" &&
        ((!!longTermMonths && longTermMonths >= 7) || /\bmonth|months|year|years\b/i.test(longTermTimeframe));
      const dealerProfile = await getDealerProfile();
      const agentName = dealerProfile?.agentName ?? "Brooke";
      const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
      const financeLine = financeRequest ? buildFinanceAppLine(dealerProfile) : "";
      const yearForRange =
        leadForPrice?.vehicle?.year ??
        deriveYearFromText(leadForPrice?.vehicle?.description ?? null) ??
        null;
      const modelForRange =
        leadForPrice?.vehicle?.model ??
        deriveModelFromDescription(leadForPrice?.vehicle?.description ?? null) ??
        null;
      const longTermInvite = wantsSoftTimeline
        ? `I know you mentioned a ${longTermTimeframe || "longer-term"} timeline — no rush at all. ` +
          `I’m here when you’re ready. `
        : "";
      const modelUnknown = isUnknownModel(modelForRange);
      const stockForPrice = leadForPrice?.vehicle?.stockId ?? stockIdFromText ?? null;
      const vinForPrice = leadForPrice?.vehicle?.vin ?? null;
      const priceLookup = await findInventoryPrice({
        stockId: stockForPrice,
        vin: vinForPrice,
        year: yearForRange,
        model: modelForRange
      });
      let price = priceLookup?.price ?? null;
      const inventoryNote = await getInventoryNote(stockForPrice, vinForPrice);
      const range =
        yearForRange && modelForRange ? await findPriceRange({ year: yearForRange, model: modelForRange }) : null;
      if (!stockForPrice && !vinForPrice && range?.count && range.count > 1) {
        price = null;
      }
      const hintText = [leadForPrice?.vehicle?.description, event.body].filter(Boolean).join(" ");
      const trimHint = [leadForPrice?.vehicle?.modelOptions?.join(" "), hintText].filter(Boolean).join(" ");
      const colorHint = [leadForPrice?.vehicle?.color, hintText].filter(Boolean).join(" ");
      const msrpLookup = await findMsrpPricing({
        year: yearForRange,
        model: mapMsrpModelAlias(modelForRange),
        trimText: trimHint,
        colorText: colorHint
      });
      const numericYear = yearForRange ? Number(yearForRange) : null;
      const paymentFollowUp = detectPaymentFollowUp(event.body, history ?? []);
      const paymentQuestion = detectPaymentPressure(event.body) || paymentFollowUp;
      const targetMonthly = extractMonthlyBudget(event.body);
      const downQuestionOnly =
        detectDownPaymentQuestion(event.body) &&
        !/(payment|monthly|month|\/\s*mo|\/\s*month|per month|a month|apr|term|rate|interest|\$\s*\d+)/i.test(
          event.body
        );
      const preferredTerm = extractPreferredTermMonths(event.body) ?? 60;
      const downInfo = parseDownPayment(event.body);
      const downPayment = downInfo?.amount;
      const downPaymentAssumed = downInfo?.assumedThousands ?? false;
      const conditionRaw = [
        leadForPrice?.vehicle?.condition,
        (priceLookup as any)?.item?.condition
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const isUsed = /(pre|used|pre-owned|preowned|owned)/.test(conditionRaw);
      const taxRateRaw = Number(dealerProfile?.taxRate ?? 8);
      const taxRate =
        Number.isFinite(taxRateRaw) && taxRateRaw > 0
          ? taxRateRaw > 1
            ? taxRateRaw / 100
            : taxRateRaw
          : 0.08;
      const paymentRange =
        price != null
          ? { min: price, max: price }
          : range?.min != null && range?.max != null
            ? { min: range.min, max: range.max }
            : msrpLookup?.exact != null
              ? { min: msrpLookup.exact, max: msrpLookup.exact }
              : msrpLookup?.rangeForTrim ?? msrpLookup?.rangeForColor ?? msrpLookup?.range ?? null;

      if (detectDownPaymentQuestion(event.body) && targetMonthly != null) {
        const nf = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
        const financeLine = buildFinanceAppLine(dealerProfile);
        if (paymentRange) {
          const downLowRaw = estimateDownNeededForTargetPayment({
            targetMonthly,
            price: paymentRange.min,
            isUsed,
            termMonths: preferredTerm,
            taxRate
          });
          const downHighRaw = estimateDownNeededForTargetPayment({
            targetMonthly,
            price: paymentRange.max,
            isUsed,
            termMonths: preferredTerm,
            taxRate
          });
          const round100 = (v: number) => Math.round(v / 100) * 100;
          const downLow = round100(Math.min(downLowRaw, downHighRaw));
          const downHigh = round100(Math.max(downLowRaw, downHighRaw));
          const targetLabel = nf.format(targetMonthly);
          const downLabel = downLow === downHigh ? nf.format(downLow) : `${nf.format(downLow)}–${nf.format(downHigh)}`;
          const termProvided = extractPreferredTermMonths(event.body) != null;
          const termFollow = termProvided ? "" : " If you want, I can also run it at 72 or 84 months.";
          const draft =
            `To target about ${targetLabel}/mo at ${preferredTerm} months, you'd likely need roughly ${downLabel} down, ` +
            `depending on exact bike, taxes/fees, and APR.${termFollow} ${financeLine}`;
          return finalize({
            intent,
            stage: "ENGAGED",
            shouldRespond: true,
            draft,
            pricingAttempted,
            paymentsAnswered: true
          });
        }
        const targetLabel = nf.format(targetMonthly);
        const modelHint = modelUnknown
          ? "If you share model/year (or stock #), I can run the down-payment target more accurately."
          : "I can tighten it as soon as I confirm the exact bike price.";
        const draft = `I can estimate what down payment gets you near ${targetLabel}/mo, but I need the exact bike price first. ${modelHint} ${financeLine}`;
        return finalize({
          intent,
          stage: "ENGAGED",
          shouldRespond: true,
          draft,
          pricingAttempted,
          paymentsAnswered: true
        });
      }

      if (downQuestionOnly) {
        const financeLine = buildFinanceAppLine(dealerProfile);
        const draft = `Down payment depends on the finance application. ${financeLine}`;
        return finalize({
          intent,
          stage: "ENGAGED",
          shouldRespond: true,
          draft,
          paymentsAnswered: true
        });
      }
      if (paymentQuestion && paymentRange) {
        let draft = buildMonthlyPaymentLine({
          priceMin: paymentRange.min,
          priceMax: paymentRange.max,
          isUsed,
          termMonths: preferredTerm,
          taxRate,
          downPayment,
          downPaymentAssumed
        });
        const termProvided = extractPreferredTermMonths(event.body) != null;
        const downProvided = downPayment != null || downPaymentAssumed;
        if (!termProvided || !downProvided) {
          const parts: string[] = [];
          if (!termProvided) parts.push("60, 72, or 84 months");
          if (!downProvided) parts.push("about how much down");
          const follow =
            parts.length === 2
              ? "Were you thinking 60, 72, or 84 months, and about how much down?"
              : `Were you thinking ${parts[0]}?`;
          draft = `${draft} ${follow}`;
        }
        return finalize({
          intent,
          stage: "ENGAGED",
          shouldRespond: true,
          draft,
          pricingAttempted,
          paymentsAnswered: true
        });
      }
      if (!price && !range) {
        if (msrpLookup && modelForRange && !isUnknownModel(modelForRange)) {
          const nf = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
          const firstName = leadForPrice?.firstName?.trim() || "there";
          const modelLabel = normalizeModelLabel(modelForRange);
          const yearLabel = yearForRange ? `${yearForRange} ` : "";
          const trimLabel = msrpLookup.trim?.name ? msrpLookup.trim.name.trim() : "";
          const colorLabel = msrpLookup.color?.name ? msrpLookup.color.name.trim() : "";
          const detail = [trimLabel, colorLabel].filter(Boolean).join(", ");

          let priceLine = "";
          if (msrpLookup.exact != null) {
            priceLine = detail
              ? `MSRP for a ${yearLabel}${modelLabel} (${detail}) is about ${nf.format(msrpLookup.exact)}.`
              : `MSRP for a ${yearLabel}${modelLabel} is about ${nf.format(msrpLookup.exact)}.`;
          } else if (trimLabel && msrpLookup.rangeForTrim) {
            priceLine =
              `With the ${trimLabel} trim, MSRP runs about ${nf.format(msrpLookup.rangeForTrim.min)} ` +
              `to ${nf.format(msrpLookup.rangeForTrim.max)}, depending on color.`;
          } else if (colorLabel && msrpLookup.rangeForColor) {
            priceLine =
              `In ${colorLabel}, MSRP runs about ${nf.format(msrpLookup.rangeForColor.min)} ` +
              `to ${nf.format(msrpLookup.rangeForColor.max)}, depending on trim.`;
          } else {
            priceLine =
              `MSRP for a ${yearLabel}${modelLabel} runs about ${nf.format(msrpLookup.range.min)} ` +
              `to ${nf.format(msrpLookup.range.max)}, depending on trim and color.`;
          }

          const disclaimer = "MSRP is before tax, fees, trade-in, and financing.";
          const timelineNote = longTermInvite ? longTermInvite.trim() : "";
          const draft =
            `Hi ${firstName} — thanks for your interest in the ${yearLabel}${modelLabel}. ` +
            `This is ${agentName} at ${dealerName}. ${priceLine} ${disclaimer}` +
            (timelineNote ? ` ${timelineNote}` : "") +
            (financeLine ? ` ${financeLine}` : "");
          return finalize({
            intent,
            stage: "ENGAGED",
            shouldRespond: true,
            draft
          });
        }
        if (
          numericYear &&
          Number.isFinite(numericYear) &&
          numericYear >= 2021 &&
          modelForRange &&
          !isUnknownModel(modelForRange)
        ) {
          const fallbackYear = numericYear - 1;
          const fallbackRange = await findPriceRange({ year: String(fallbackYear), model: modelForRange });
          if (fallbackRange?.count) {
            const nf = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
            const firstName = leadForPrice?.firstName?.trim() || "there";
            const modelLabel = normalizeModelLabel(modelForRange);
            const originalLabel = `${numericYear} ${modelLabel}`.trim();
            const fallbackLabel = `${fallbackYear} ${modelLabel}`.trim();
            const priceLine =
              fallbackRange.count === 1
                ? `The listed price for a ${fallbackLabel} we have in stock is ${nf.format(fallbackRange.min)}.`
                : `Listed prices for ${fallbackLabel} units we have in stock range from ${nf.format(
                    fallbackRange.min
                  )} to ${nf.format(fallbackRange.max)}.`;
            const fallbackMatch =
              (await findInventoryPrice({ year: String(fallbackYear), model: modelForRange })) ??
              null;
            const fallbackItem =
              fallbackMatch?.item ?? (await findInventoryMatches({ year: String(fallbackYear), model: modelForRange }))[0];
            const fallbackNote = fallbackItem
              ? await getInventoryNote(fallbackItem.stockId ?? null, fallbackItem.vin ?? null)
              : null;
            const timelineNote = longTermInvite ? longTermInvite.trim() : "";
            const draft =
              `Hi ${firstName} — thanks for your interest in the ${originalLabel}. ` +
              `This is ${agentName} at ${dealerName}. ` +
              `We don’t have a ${originalLabel} in stock right now, ` +
              `but we do have ${fallbackLabel} units available. ${priceLine} ` +
              `${fallbackNote ? `Right now there's ${fallbackNote} available. ` : ""}` +
              `If you want, I can send photos or details.` +
              (timelineNote ? ` ${timelineNote}` : "") +
              (financeLine ? ` ${financeLine}` : "");
          return finalize({
              intent,
              stage: "ENGAGED",
              shouldRespond: true,
              draft
            });
          }
        }
        if (modelUnknown) {
          const firstName = leadForPrice?.firstName?.trim() || "there";
          const yearLabel = yearForRange ? `${yearForRange} ` : "";
          const timelineNote = longTermInvite ? longTermInvite.trim() : "";
          const draft =
            `Hi ${firstName} — this is ${agentName} at ${dealerName}. ` +
            `Thanks for your Facebook quote request. I’d love to help with pricing. Which ${yearLabel}model are you interested in?` +
            (timelineNote ? ` ${timelineNote}` : "") +
            (financeLine ? ` ${financeLine}` : "");
          return finalize({
            intent,
            stage: "ENGAGED",
            shouldRespond: true,
            draft
          });
        }
        const firstName = leadForPrice?.firstName?.trim() || "there";
        const modelLabel = normalizeModelLabel(modelForRange);
        const modelKnown = modelForRange && !isUnknownModel(modelForRange);
        const yearLabel = yearForRange ? `${yearForRange} ` : "";
        const thankLine = modelKnown
          ? `Thanks for your interest in the ${yearLabel}${modelLabel}. `
          : "Thanks for your Facebook quote request. ";
        const timelineNote = longTermInvite ? longTermInvite.trim() : "";
        const ack =
          `Hi ${firstName} — ${thankLine}This is ${agentName} at ${dealerName}. ` +
          "I’ll have a manager pull the exact pricing and follow up shortly." +
          (timelineNote ? ` ${timelineNote}` : "") +
          (financeLine ? ` ${financeLine}` : "");
        return finalize({
          intent,
          stage: "ENGAGED",
          shouldRespond: true,
          draft: ack,
          handoff: { required: true, reason: "pricing", ack }
        });
      }
    } catch {
      const ack = "Got it — I’ll have a manager pull the exact pricing and follow up shortly.";
      return finalize({
        intent,
        stage: "ENGAGED",
        shouldRespond: true,
        draft: ack,
        handoff: { required: true, reason: "pricing", ack }
      });
    }
  }

  // --- Inventory verification (stock -> URL -> pending tag) ---
  let inventoryUrl: string | null = null;
  let inventoryStatus: InventoryStatus | null = null;
  let stockId: string | null = null;
  const vin = ctx?.lead?.vehicle?.vin ?? null;
  const availabilityAskedStock = /(available|availability|still there|in stock)/i.test(event.body);
  const inventoryCountQuestion =
    /\b(only one|just one|is that all|any others|how many|how many do you have|only one you have)\b/i.test(
      event.body
    );

  // Stock IDs on your site are commonly like C1-26, T11-26, etc.
  // Keep this permissive; tune later if needed.
  const stockMatch = event.body.match(/\b[A-Z0-9]{1,5}-\d{1,4}\b/i);
  if (stockMatch?.[0]) stockId = stockMatch[0].toUpperCase();

  if (inventoryCountQuestion) {
    try {
      const items = await getInventoryFeed();
      const models = Array.from(new Set(items.map(i => i.model).filter(Boolean))) as string[];
      const modelCandidates = getModelCandidates(models);
      const lastOutbound = [...(history ?? [])].reverse().find(h => h.direction === "out")?.body ?? "";
      const modelFromInbound = resolveModelFromText(event.body, modelCandidates);
      const modelFromLastOutbound = resolveModelFromText(lastOutbound, modelCandidates);
      const modelFromHistory = resolveModelFromHistory(history, modelCandidates);
      const model =
        modelFromInbound ||
        modelFromLastOutbound ||
        modelFromHistory ||
        ctx?.lead?.vehicle?.model ||
        deriveModelFromDescription(ctx?.lead?.vehicle?.description ?? null) ||
        null;
      if (!model) {
        return finalize({
          intent: "AVAILABILITY",
          stage: "ENGAGED",
          shouldRespond: true,
          draft: "Which model are you asking about?"
        });
      }
      const yearFromInbound = deriveYearFromText(event.body);
      const year =
        yearFromInbound ??
        (modelFromInbound
          ? null
          : deriveYearFromText(lastOutbound) ?? ctx?.lead?.vehicle?.year ?? null);
      const msrpColors = await getMsrpColorNames();
      const colorFromInbound = extractColorMention(event.body, msrpColors);
      const color =
        colorFromInbound ||
        (modelFromInbound
          ? null
          : extractColorMention(lastOutbound, msrpColors) ||
            findRecentInboundColor(history, msrpColors) ||
            ctx?.lead?.vehicle?.color ||
            null);
      const conditionFromInbound = detectRequestedInventoryConditionFromText(event.body);
      const conditionFromContext = modelFromInbound
        ? null
        : detectRequestedInventoryConditionFromText(lastOutbound) ||
          normalizeRequestedInventoryCondition(ctx?.lead?.vehicle?.condition ?? null);
      const requestedCondition = conditionFromInbound || conditionFromContext;
      let matches = await findInventoryMatches({ year: year ?? null, model });
      if (requestedCondition) {
        matches = matches.filter(m => inventoryItemMatchesRequestedCondition(m, requestedCondition));
      }
      if (color) {
        const colorLower = color.toLowerCase();
        matches = matches.filter(m => (m.color ?? "").toLowerCase().includes(colorLower));
      }
      const holds = await listInventoryHolds();
      const solds = await listInventorySolds();
      const availableMatches = matches.filter(m => {
        const holdKey = normalizeInventoryHoldKey(m.stockId, m.vin);
        const soldKey = normalizeInventorySoldKey(m.stockId, m.vin);
        if (holdKey && holds?.[holdKey]) return false;
        if (soldKey && solds?.[soldKey]) return false;
        return true;
      });
      const count = availableMatches.length;
      const conditionPrefix = formatRequestedConditionPrefix(requestedCondition);
      const yearLabel = year ? `${year} ` : "";
      const modelLabel = normalizeModelLabel(model);
      const colorLabel = color ? ` in ${color}` : "";
      const preferencePrompt = buildOutOfStockPreferencePrompt({
        requestedCondition,
        color
      });
      const reply =
        count <= 0
          ? `I’m not seeing ${conditionPrefix}${yearLabel}${modelLabel}${colorLabel} in stock right now. ${buildOutOfStockHumanOptionsLine()}${preferencePrompt ? ` ${preferencePrompt}` : ""}`
          : count === 1
            ? `That’s the only ${conditionPrefix}${yearLabel}${modelLabel}${colorLabel} we have in stock right now.`
            : `We have ${count} ${conditionPrefix}${yearLabel}${modelLabel}${colorLabel} units in stock right now.`;
      return finalize({
        intent: "AVAILABILITY",
        stage: "ENGAGED",
        shouldRespond: true,
        draft: reply
      });
    } catch {
      return finalize({
        intent: "AVAILABILITY",
        stage: "ENGAGED",
        shouldRespond: true,
        draft: "Let me check and get you a count."
      });
    }
  }

  const normalizeLeadCondition = (raw?: string | null): "new" | "used" | null => {
    const t = String(raw ?? "").toLowerCase();
    if (!t) return null;
    if (/(pre|used|pre-owned|preowned|owned)/.test(t)) return "used";
    if (/new/.test(t)) return "new";
    return null;
  };
  const leadModelForCondition =
    ctx?.lead?.vehicle?.model ??
    deriveModelFromDescription(ctx?.lead?.vehicle?.description ?? null) ??
    null;
  const leadCondition = normalizeLeadCondition(ctx?.lead?.vehicle?.condition ?? null);
  const currentYear = new Date().getFullYear();
  const modelRecent = leadModelForCondition
    ? isModelInRecentYears(leadModelForCondition, currentYear, 1)
    : false;
  const condition = stockId
    ? /^u/i.test(stockId)
      ? "used"
      : "new"
    : leadCondition ?? (modelRecent ? "new_model_interest" : "used");

  if (intent === "AVAILABILITY" && stockId && event.body.toLowerCase().includes(stockId.toLowerCase())) {
    try {
      const feedMatch = await findInventoryPrice({ stockId, vin });
      if (feedMatch?.item) {
        inventoryUrl = feedMatch.item.url ?? inventoryUrl;
        inventoryStatus = "AVAILABLE";
      } else {
        const resolved = await resolveInventoryUrlByStock(stockId);
        if (resolved.ok) {
          inventoryUrl = resolved.url;
          inventoryStatus = await checkInventorySalePendingByUrl(inventoryUrl);
        } else {
          inventoryStatus = "UNKNOWN";
        }
      }
    } catch {
      inventoryStatus = "UNKNOWN";
    }
  }

  if (availabilityAskedStock && stockId && inventoryStatus === "UNKNOWN") {
    const dealerProfile = await getDealerProfile();
    const agentName = dealerProfile?.agentName ?? "Brooke";
    const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
    const ack =
      `Hi, this is ${agentName} at ${dealerName}. ` +
      "Thanks for checking — I’m going to have a manager verify availability and follow up shortly.";
    return finalize({
      intent,
      stage: "ENGAGED",
      shouldRespond: true,
      draft: ack,
      handoff: { required: true, reason: "other", ack }
    });
  }

  if (availabilityAskedStock && stockId && inventoryStatus === "AVAILABLE") {
    const dayName = extractDayName(event.body);
    const dayPart = extractDayPart(event.body);
    const modelLabelRaw =
      ctx?.lead?.vehicle?.model ??
      ctx?.lead?.vehicle?.description ??
      null;
    const yearLabelRaw = ctx?.lead?.vehicle?.year ?? null;
    const modelLabel = modelLabelRaw
      ? String(modelLabelRaw).trim()
      : null;
    const yearLabel = yearLabelRaw ? String(yearLabelRaw).trim() : "";
    const bikeLabel = modelLabel
      ? `${yearLabel ? `${yearLabel} ` : ""}${modelLabel}`.trim()
      : "that bike";
    const whenLine =
      dayName && dayPart
        ? ` If you want to come by ${dayName} ${dayPart}, what time works best?`
        : " If you want to stop in, what day and time works best?";
    const ack = `Got it — the ${bikeLabel} is still available.${whenLine}`.trim();
    return finalize({
      intent,
      stage: "ENGAGED",
      shouldRespond: true,
      draft: ack
    });
  }

  if (useLLM) {
    try {
      const dealerProfile = await getDealerProfile();
      const cfg = await getSchedulerConfig();
      const tz = cfg.timezone ?? "America/New_York";
      const today = new Date().toLocaleDateString("en-US", { weekday: "long", timeZone: tz });
      const todayKey = dayKey(new Date(), tz);
      const todayHours = cfg.businessHours?.[todayKey];
      const dealerClosedToday = !todayHours?.open || !todayHours?.close;
      const dealerHoursToday = todayHours?.open && todayHours?.close ? `${todayHours.open}–${todayHours.close}` : null;
      const appointment = ctx?.appointment ?? null;
      const followUp = ctx?.followUp ?? null;
      let listPrice: number | null = null;
      let priceRange: { min: number; max: number; count: number } | null = null;
      if (pricingIntent) {
        try {
          const yearForRange =
            ctx?.lead?.vehicle?.year ??
            deriveYearFromText(ctx?.lead?.vehicle?.description ?? null) ??
            null;
          const modelForRange =
            ctx?.lead?.vehicle?.model ??
            deriveModelFromDescription(ctx?.lead?.vehicle?.description ?? null) ??
            null;
          const stockForPrice = ctx?.lead?.vehicle?.stockId ?? stockIdFromText ?? null;
          const vinForPrice = ctx?.lead?.vehicle?.vin ?? null;
          const priceLookup = await findInventoryPrice({
            stockId: stockForPrice,
            vin: vinForPrice,
            year: yearForRange,
            model: modelForRange
          });
          listPrice = priceLookup?.price ?? null;
          if (yearForRange && modelForRange) {
            priceRange = await findPriceRange({ year: yearForRange, model: modelForRange });
          }
          if (!stockForPrice && !vinForPrice && priceRange?.count && priceRange.count > 1) {
            listPrice = null;
          }
        } catch {}
      }

      const lead: LeadProfile = {
        ...(ctx?.lead ?? {}),
        vehicle: {
          ...(ctx?.lead?.vehicle ?? {}),
          stockId: stockId ?? ctx?.lead?.vehicle?.stockId,
          condition,
          listPrice: listPrice ?? ctx?.lead?.vehicle?.listPrice,
          priceRange: priceRange ?? undefined
        }
      };
      const inboundHistory = [...history].reverse().filter(h => h.direction === "in");
      const prevInbound = inboundHistory.length > 1 ? inboundHistory[1]?.body ?? "" : "";
      const prevAskedAvailability = /(available|availability|still there|in stock)/i.test(prevInbound);

      let suggestedSlots: any[] = [];
      let requestedTime: { year: number; month: number; day: number; hour24: number; minute: number; dayOfWeek: string } | null = null;
      let requestedDayNoAvailability = false;
      let requestedDayKey: string | null = null;
      let requestedDaySpecified = false;
      let requestedDayClosed = false;
      let requestedDayMaxSlots = 0;
      const schedulingText = ctx?.schedulingText || event.body;
      const hasIntent = hasSchedulingIntent(schedulingText);
      const isAdfLead = /adf/i.test(ctx?.leadSource ?? "") || /adf/i.test(ctx?.lead?.source ?? "");
      const cta = ctx?.cta ?? "";
      const bucket = ctx?.bucket ?? "";
      const ctxSuggestsScheduling =
        /(check_availability|inventory_interest|appointment|schedule|book|visit|test_ride)/i.test(cta) ||
        /(inventory_interest|appointment|schedule|book|visit|test_ride)/i.test(bucket);
      const allowSchedulingOffer =
        ctx?.allowSchedulingOffer ?? (event.provider === "sendgrid_adf" || isAdfLead || hasIntent);
      const schedulingIntent =
        hasIntent ||
        event.provider === "sendgrid_adf" ||
        isAdfLead ||
        (ctxSuggestsScheduling && allowSchedulingOffer);
      const appointmentType = ctx?.appointmentTypeOverride ?? inferAppointmentType(event.body);

      const apptBooked = appointment?.bookedEventId;
      const apptConfirmed = !!apptBooked;
      const holding =
        followUp?.mode === "holding_inventory" ||
        followUp?.mode === "manual_handoff" ||
        followUp?.mode === "paused_indefinite";

      console.log("[scheduler] gate", {
        provider: event.provider,
        hasIntent,
        isAdfLead,
        cta,
        bucket,
        ctxSuggestsScheduling,
        schedulingIntent,
        apptConfirmed,
        holding
      });

      if (pricingAttempted && prevAskedAvailability && !inventoryStatus) {
        const prevStock = lead.vehicle?.stockId;
        if (prevStock) {
          const resolvedPrev = await resolveInventoryUrlByStock(prevStock);
          if (resolvedPrev.ok) {
            inventoryUrl = resolvedPrev.url;
            inventoryStatus = await checkInventorySalePendingByUrl(inventoryUrl);
          } else {
            inventoryStatus = "UNKNOWN";
          }
        }
      }

      if (schedulingIntent && !apptConfirmed && !holding) {
        try {
          const cfg = await getSchedulerConfig();
          const appointmentTypes = cfg.appointmentTypes ?? { inventory_visit: { durationMinutes: 60 } };
          const preferredSalespeople = getPreferredSalespeople(cfg);
          const salespeople = cfg.salespeople ?? [];
          const gapMinutes = cfg.minGapBetweenAppointmentsMinutes ?? 60;
          const durationMinutes = appointmentTypes[appointmentType]?.durationMinutes ?? 60;

          const now = new Date();
          const preferredDate = ctx?.lead?.preferredDate;
          const preferredTime = ctx?.lead?.preferredTime;
          const requestedSeed =
            [preferredDate, preferredTime].filter(Boolean).join(" ").trim() || schedulingText;
          let requestedDay = inferRequestedDay(requestedSeed);
          requestedTime =
            preferredDate && preferredTime
              ? parsePreferredDateTime(preferredDate, preferredTime, cfg.timezone)
              : null;
          if (!requestedTime) {
            requestedTime = parseRequestedDayTime(requestedSeed, cfg.timezone);
          }
          if (!requestedDay && requestedTime && preferredDate) {
            requestedDay = requestedTime.dayOfWeek;
          }
          requestedDaySpecified =
            !!requestedDay && requestedDay !== "today" && requestedDay !== "tomorrow";
          if (requestedDaySpecified) {
            requestedDayKey = requestedDay;
          } else if (requestedTime && preferredDate) {
            requestedDaySpecified = true;
            requestedDayKey = requestedTime.dayOfWeek;
          } else if (requestedDay === "today" || requestedDay === "tomorrow") {
            const d = new Date(now);
            d.setDate(d.getDate() + (requestedDay === "tomorrow" ? 1 : 0));
            requestedDayKey = dayKey(d, cfg.timezone);
          }
          const requestedDaysOut =
            requestedTime
              ? Math.ceil(
                  (Date.UTC(
                    requestedTime.year,
                    requestedTime.month - 1,
                    requestedTime.day,
                    requestedTime.hour24,
                    requestedTime.minute
                  ) - now.getTime()) /
                    (24 * 60 * 60 * 1000)
                )
              : null;
          const schedulingSearchDays = Math.max(
            14,
            Math.min(90, requestedDaysOut != null ? requestedDaysOut + 3 : 14)
          );
          const candidatesByDay = generateCandidateSlots(
            cfg,
            now,
            durationMinutes,
            schedulingSearchDays
          );
          const requestedDayHours = requestedDayKey ? cfg.businessHours?.[requestedDayKey] : undefined;
          requestedDayClosed =
            !!requestedDayKey && (!requestedDayHours || !requestedDayHours.open || !requestedDayHours.close);

          const overlaps = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) => aStart < bEnd && bStart < aEnd;
          const addMinutes = (d: Date, mins: number) => new Date(d.getTime() + mins * 60_000);
          const requestedStart = requestedTime
            ? localPartsToUtcDate(cfg.timezone, {
                year: requestedTime.year,
                month: requestedTime.month,
                day: requestedTime.day,
                hour24: requestedTime.hour24,
                minute: requestedTime.minute
              })
            : null;
          const requestedDayStart = requestedTime
            ? localPartsToUtcDate(cfg.timezone, {
                year: requestedTime.year,
                month: requestedTime.month,
                day: requestedTime.day,
                hour24: 0,
                minute: 0
              })
            : null;
          const sameLocalDate = (d: Date) => {
            if (!requestedTime) return true;
            const fmt = new Intl.DateTimeFormat("en-US", {
              timeZone: cfg.timezone,
              year: "numeric",
              month: "2-digit",
              day: "2-digit"
            });
            const parts = fmt.formatToParts(d);
            const map: Record<string, string> = {};
            for (const p of parts) {
              if (p.type !== "literal") map[p.type] = p.value;
            }
            return (
              Number(map.year) === requestedTime.year &&
              Number(map.month) === requestedTime.month &&
              Number(map.day) === requestedTime.day
            );
          };

          let cal: any = null;
          try {
            cal = await getAuthedCalendarClient();
          } catch (e: any) {
            console.log("[scheduler] calendar unavailable, using open availability:", e?.message ?? e);
          }

          for (const salespersonId of preferredSalespeople) {
            const sp = salespeople.find((p: any) => p.id === salespersonId);
            if (!sp) continue;

            const timeMin = new Date(now).toISOString();
            const timeMax = new Date(
              now.getTime() + schedulingSearchDays * 24 * 60 * 60 * 1000
            ).toISOString();

            let busy: any[] = [];
            if (cal) {
              const fb = await queryFreeBusy(cal, [sp.calendarId], timeMin, timeMax, cfg.timezone);
              busy = fb.calendars?.[sp.calendarId]?.busy ?? [];
            }
            const expanded = expandBusyBlocks(busy as any, gapMinutes);

            let slots: any[] = [];
            if (requestedDay && !requestedDayClosed) {
              let targetDayKey = requestedDay;
              if (requestedDay === "today" || requestedDay === "tomorrow") {
                const d = new Date(now);
                d.setDate(d.getDate() + (requestedDay === "tomorrow" ? 1 : 0));
                targetDayKey = dayKey(d, cfg.timezone);
              }
              const preferredDays = candidatesByDay.filter(d => {
                if (dayKey(d.dayStart, cfg.timezone) !== targetDayKey) return false;
                if (requestedDay !== "today" && requestedDay !== "tomorrow") {
                  const targetStart = requestedDayStart ?? requestedStart ?? d.dayStart;
                  // If they named a weekday, treat it as the next occurrence (not today)
                  return (
                    d.dayStart.getTime() >= targetStart.getTime() &&
                    sameLocalDate(d.dayStart) &&
                    d.candidates.length > 0
                  );
                }
                return d.candidates.length > 0;
              });
              if (requestedStart) {
                const flat = preferredDays.flatMap(d =>
                  d.candidates.map(c => ({
                    start: c.start,
                    end: c.end
                  }))
                );
                const available = flat
                  .filter(c => !expanded.some(b => overlaps(c.start, c.end, b.start, b.end)))
                  .sort((a, b) => a.start.getTime() - b.start.getTime());
                const after = available.filter(c => c.start.getTime() >= requestedStart.getTime());
                const before = available
                  .filter(c => c.start.getTime() < requestedStart.getTime())
                  .sort((a, b) => b.start.getTime() - a.start.getTime());
                const picked: { start: Date; end: Date }[] = [];
                const tryAdd = (c: { start: Date; end: Date }) => {
                  if (picked.length >= 3) return;
                  const tooClose = picked.some(r => {
                    const rs = addMinutes(r.start, -gapMinutes);
                    const re = addMinutes(r.end, gapMinutes);
                    return overlaps(c.start, c.end, rs, re);
                  });
                  if (!tooClose) picked.push(c);
                };
                for (const c of after) tryAdd(c);
                for (const c of before) tryAdd(c);
                slots = picked.map(p => ({
                  salespersonId: sp.id,
                  calendarId: sp.calendarId,
                  start: p.start.toISOString(),
                  end: p.end.toISOString()
                }));
              } else {
                slots = pickSlotsForSalesperson(cfg, sp.id, sp.calendarId, preferredDays, expanded, 3);
              }
              if (slots.length > requestedDayMaxSlots) {
                requestedDayMaxSlots = slots.length;
              }
            }
            if (slots.length < 2 && (!requestedDay || requestedDay === "today" || requestedDay === "tomorrow" || requestedDayClosed)) {
              if (requestedStart && !requestedDayClosed) {
                const flat = candidatesByDay.flatMap(d =>
                  d.candidates.map(c => ({
                    start: c.start,
                    end: c.end
                  }))
                );
                const available = flat
                  .filter(c => !expanded.some(b => overlaps(c.start, c.end, b.start, b.end)))
                  .sort((a, b) => a.start.getTime() - b.start.getTime());
                const after = available.filter(c => c.start.getTime() >= requestedStart.getTime());
                const before = available
                  .filter(c => c.start.getTime() < requestedStart.getTime())
                  .sort((a, b) => b.start.getTime() - a.start.getTime());
                const picked: { start: Date; end: Date }[] = [];
                const tryAdd = (c: { start: Date; end: Date }) => {
                  if (picked.length >= 3) return;
                  const tooClose = picked.some(r => {
                    const rs = addMinutes(r.start, -gapMinutes);
                    const re = addMinutes(r.end, gapMinutes);
                    return overlaps(c.start, c.end, rs, re);
                  });
                  if (!tooClose) picked.push(c);
                };
                for (const c of after) tryAdd(c);
                for (const c of before) tryAdd(c);
                slots = picked.map(p => ({
                  salespersonId: sp.id,
                  calendarId: sp.calendarId,
                  start: p.start.toISOString(),
                  end: p.end.toISOString()
                }));
              } else {
                slots = pickSlotsForSalesperson(cfg, sp.id, sp.calendarId, candidatesByDay, expanded, 3);
              }
            }

            if (slots.length >= 1) {
              const fmtLocal = (iso: string) =>
                new Date(iso).toLocaleString("en-US", {
                  timeZone: cfg.timezone,
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit"
                });

              suggestedSlots = slots.map(s => ({
                ...s,
                startLocal: fmtLocal(s.start),
                endLocal: fmtLocal(s.end),
                appointmentType,
                salespersonId: sp.id,
                salespersonName: sp.name
              })).sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
              break;
            }
          }

          if (requestedDaySpecified && !requestedDayClosed && requestedDayMaxSlots === 0) {
            requestedDayNoAvailability = true;
          }
          if (requestedDayClosed) {
            requestedDayNoAvailability = true;
          }
        } catch (e: any) {
          console.log("[scheduler] ERROR", e?.message ?? e);
          suggestedSlots = [];
        }
      }

      console.log("[scheduler] suggestedSlots", { provider: event.provider, len: suggestedSlots.length });

      const isTradeValueLead =
        ctx?.bucket === "trade_in_sell" &&
        (ctx?.cta === "value_my_trade" || ctx?.cta === "trade_in_value") &&
        !hasPriorOutbound;
      if (isTradeValueLead) {
        const dealerProfile = await getDealerProfile();
        const agentName = dealerProfile?.agentName ?? "Brooke";
        const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
        const leadFirst = ctx?.lead?.firstName?.trim() || "there";
        const trade = ctx?.lead?.tradeVehicle;
        const tradeYear = trade?.year ? `${trade.year} ` : "";
        const tradeModel = normalizeModelLabel(trade?.model ?? trade?.description);
        const tradeLabel = (tradeYear + tradeModel).trim();
        const opening = tradeLabel
          ? `Hi ${leadFirst} — thanks for using our trade‑in estimator on your ${tradeLabel}. `
          : `Hi ${leadFirst} — thanks for using our trade‑in estimator. `;
        const disclaimer =
          "The estimate is a guide; final trade value comes from an in‑person evaluation and can be higher. ";
        const schedule =
          suggestedSlots.length >= 2
            ? `I can set up a trade appraisal. I have ${suggestedSlots[0].startLocal} or ${suggestedSlots[1].startLocal} — do any of these times work?`
            : "I can set up a trade appraisal. What day and time works for you?";
        return finalize({
          intent: "TRADE_IN",
          stage: "ENGAGED",
          shouldRespond: true,
          draft: `${opening}This is ${agentName} at ${dealerName}. ${disclaimer}${schedule}`,
          suggestedSlots
        });
      }

      if (pricingIntent && (listPrice || priceRange)) {
        const dealerProfile = await getDealerProfile();
        const financeLine = financeRequest ? buildFinanceAppLine(dealerProfile) : "";
        const nf = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
        const yearLabel = lead.vehicle?.year ? `${lead.vehicle.year} ` : "";
        const modelFromText = deriveModelFromDescription(event.body ?? "") ?? null;
        const modelCandidate = lead.vehicle?.model ?? modelFromText ?? null;
        const modelUnknown = !modelCandidate || isUnknownModel(modelCandidate);
        const modelLabel = modelCandidate ?? "that model";
        const stockLabel = lead.vehicle?.stockId ?? stockId;
        const msrpColors = await getMsrpColorNames();
        const colorMention =
          extractColorMention(event.body, msrpColors) || findRecentInboundColor(history, msrpColors);
        const modelMentionedInText = !!modelFromText;
        if (!modelMentionedInText && colorMention) {
          const leadName = lead?.firstName?.trim() || "there";
          const question = `Which ${yearLabel}model are you interested in (the ${colorMention} color)?`;
          return finalize({
            intent,
            stage: "ENGAGED",
            shouldRespond: true,
            draft: `Hi ${leadName} — I can help with pricing. ${question}${financeLine ? ` ${financeLine}` : ""}`.trim()
          });
        }
        if (modelUnknown) {
          const leadName = lead?.firstName?.trim() || "there";
          const colorNote = colorMention ? ` (the ${colorMention} color)` : "";
          const question = `Which ${yearLabel}model are you interested in${colorNote}?`;
          return finalize({
            intent,
            stage: "ENGAGED",
            shouldRespond: true,
            draft: `Hi ${leadName} — I can help with pricing. ${question}${financeLine ? ` ${financeLine}` : ""}`.trim()
          });
        }
        let priceLine = "";
        if (listPrice) {
          if (stockLabel) {
            priceLine = `The price we have listed for ${stockLabel} is ${nf.format(listPrice)}.`;
          } else {
            priceLine = `The price we have listed for the ${yearLabel}${modelLabel} is ${nf.format(
              listPrice
            )}.`;
          }
        } else if (priceRange) {
          if (priceRange.count === 1) {
            priceLine = `The price we have listed for the ${yearLabel}${modelLabel} is ${nf.format(
              priceRange.min
            )}.`;
          } else {
            priceLine = `Prices we have listed for ${yearLabel}${modelLabel} run about ${nf.format(
              priceRange.min
            )} to ${nf.format(priceRange.max)}, depending on trim and options.`;
          }
        }
        const disclaimer = "Final price can change with tax, fees, trade-in, and financing.";
        const schedule = suggestedSlots.length >= 2
          ? `I can set up a time to stop in and go over options. I have ${suggestedSlots[0].startLocal} or ${suggestedSlots[1].startLocal} — do any of these times work?`
          : "I can set up a time to stop in and go over options. What day and time works for you?";
        const qualifier = financeRequest ? "" : "Do you have a trade?";
        const isFirstOutbound = !history.some(h => h.direction === "out");
        const leadName = lead?.firstName?.trim() || "there";
        const thankLabel = normalizeModelLabel(lead.vehicle?.model ?? lead.vehicle?.description);
        const thankYear = lead.vehicle?.year ? `${lead.vehicle.year} ` : "";
        const greeting =
          isFirstOutbound && event.provider === "sendgrid_adf"
            ? `Hi ${leadName} — thanks for your interest in the ${thankYear}${thankLabel}. `
            : "";

        return finalize({
          intent,
          stage: "ENGAGED",
          shouldRespond: true,
          draft: `${greeting}${priceLine} ${disclaimer}${financeLine ? ` ${financeLine}` : ""}\n\n${schedule} ${qualifier}`.trim(),
          suggestedSlots
        });
      }

      if (suggestedSlots.length === 1 && requestedDayKey) {
        const reply = `I have ${suggestedSlots[0].startLocal}. If that doesn’t work, what other day works for you?`;
        return finalize({
          intent,
          stage: "ENGAGED",
          shouldRespond: true,
          draft: reply,
          suggestedSlots
        });
      }

      if (suggestedSlots.length >= 2) {
        suggestedSlots = [...suggestedSlots].sort(
          (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
        );
      }

      if (requestedDayNoAvailability && requestedDayKey) {
        const dayName = requestedDayKey.charAt(0).toUpperCase() + requestedDayKey.slice(1);
        if (requestedDayClosed && suggestedSlots.length >= 2) {
          const fallbackMessage = `We’re closed on ${dayName}. I have ${suggestedSlots[0].startLocal} or ${suggestedSlots[1].startLocal} — do any of these times work?`;
          return finalize({
            intent,
            stage: "ENGAGED",
            shouldRespond: true,
            draft: fallbackMessage,
            suggestedSlots
          });
        }
        const fallbackMessage = requestedDayClosed
          ? `We’re closed on ${dayName}. Is there another day that works for you?`
          : `I'm booked up for ${dayName}. Is there another day that works for you?`;
        return finalize({
          intent,
          stage: "ENGAGED",
          shouldRespond: true,
          draft: fallbackMessage,
          suggestedSlots: []
        });
      }

      const longTermMonths = lead.purchaseTimeframeMonthsStart;
      if (event.provider === "sendgrid_adf" && longTermMonths && longTermMonths >= 1) {
        const msg = buildLongTermMessage(lead.purchaseTimeframe, lead.hasMotoLicense);
        return finalize({
          intent,
          stage: "ENGAGED",
          shouldRespond: true,
          draft: msg,
          suggestedSlots: []
        });
      }

      const stockForNote = ctx?.lead?.vehicle?.stockId ?? stockId ?? null;
      const vinForNote = ctx?.lead?.vehicle?.vin ?? null;
      const inventoryNote = await getInventoryNote(stockForNote, vinForNote);

      const draft = await generateDraftWithLLM({
        channel: "sms",
        leadSource: ctx?.leadSource ?? null,
        bucket: ctx?.bucket ?? null,
        cta: ctx?.cta ?? null,
        leadKey: event.from,
        lead,
        inquiry: event.body,
        history,
        stockId,
        inventoryUrl,
        inventoryStatus,
        inventoryNote,
        dealerProfile,
        dealerTimeZone: tz,
        dealerClosedToday,
        dealerHoursToday,
        today,
        appointment,
        followUp,
        suggestedSlots,
        pricingAttempts,
        pricingIntent,
        pickup: ctx?.pickup ?? null,
        weather: ctx?.weather ?? null,
        handoff,
        callbackRequest: callbackRequested,
        voiceSummary: ctx?.voiceSummary ?? null,
        memorySummary: ambiguousFlow ? ctx?.memorySummary ?? null : null
      });

      let memorySummary: string | null = null;
      if (ambiguousFlow && ctx?.memorySummaryShouldUpdate) {
        memorySummary = await summarizeConversationMemoryWithLLM({
          existingSummary: ctx?.memorySummary ?? null,
          lead: ctx?.lead ?? null,
          appointment,
          followUp,
          hold: ctx?.hold ?? null,
          sale: ctx?.sale ?? null,
          inventoryWatch: ctx?.inventoryWatch ?? null,
          inventoryWatches: ctx?.inventoryWatches ?? null,
          history
        });
      }

      let finalDraft = (draft || fallbackDraft).trim();
      finalDraft = stripRescheduleOffers(finalDraft);
      finalDraft = enforceNoPrematureBooking(finalDraft, appointment);
      if (pricingAttempted && prevAskedAvailability && !/available|sale pending|verify availability/i.test(finalDraft)) {
        if (inventoryStatus === "PENDING") {
          finalDraft = `That unit is sale pending. ${finalDraft}`;
        } else if (inventoryStatus === "AVAILABLE") {
          const id = lead.vehicle?.stockId ?? stockId ?? "That unit";
          finalDraft = `${id} is available right now. ${finalDraft}`;
        } else if (inventoryStatus === "UNKNOWN" || !inventoryStatus) {
          finalDraft = `Let me verify availability and I’ll confirm shortly. ${finalDraft}`;
        }
      }
      const isFirstOutbound = !history.some(h => h.direction === "out");
      if (isFirstOutbound && event.provider === "sendgrid_adf") {
        const agentName = dealerProfile?.agentName ?? "Brooke";
        const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
        const leadName = lead?.firstName?.trim() || "there";
        const thankLabel = normalizeModelLabel(lead.vehicle?.model ?? lead.vehicle?.description);
        const thankYear = lead.vehicle?.year ? `${lead.vehicle.year} ` : "";
        const leadSourceLower = (ctx?.leadSource ?? lead?.source ?? "").toLowerCase();
        const isCustomBuild = /custom build/.test(leadSourceLower);
        const thanksLine = isCustomBuild
          ? `thanks for building your ${thankYear}${thankLabel} online. `
          : `thanks for your interest in the ${thankYear}${thankLabel}. `;
        const greeting = `Hi ${leadName} — ${thanksLine}`;
        const availabilityAskedLead = /(available|availability|still there|in stock)/i.test(event.body);
        const hasAvailabilityAnswer = inventoryStatus === "AVAILABLE";
        const hasPendingAnswer = inventoryStatus === "PENDING";
        const hasUnknownAnswer = inventoryStatus === "UNKNOWN" || !inventoryStatus;
        let availabilityLine = "";
        if (availabilityAskedLead) {
          if (hasPendingAnswer) {
            availabilityLine = "That unit is sale pending. ";
          } else if (hasAvailabilityAnswer) {
            availabilityLine = `${stockId ?? "That unit"} is available right now. `;
          } else if (hasUnknownAnswer) {
            availabilityLine = "Let me verify availability and I’ll confirm shortly. ";
          }
        }
        const canScheduleNow = !(availabilityAskedLead && (inventoryStatus === "UNKNOWN" || !inventoryStatus));
        let hasBuildInventory = false;
        if (isCustomBuild) {
          const modelForBuild = lead.vehicle?.model ?? lead.vehicle?.description ?? null;
          const modelKnown = !!modelForBuild && !isUnknownModel(modelForBuild);
          if (modelKnown) {
            try {
              hasBuildInventory = await hasInventoryForModelYear({
                model: modelForBuild,
                year: lead.vehicle?.year ?? null,
                yearDelta: 1
              });
            } catch {}
          }
        }
        const hasConcreteInventory =
          !!stockId || inventoryStatus === "AVAILABLE" || (isCustomBuild && hasBuildInventory);
        const scheduleInvite = buildScheduleInvite(hasConcreteInventory);
        const noteLine = inventoryNote ? `Right now there's ${inventoryNote} available. ` : "";
        const buildLine = isCustomBuild
          ? "I can walk you through build options and next steps. "
          : "";
        if (canScheduleNow && suggestedSlots.length >= 2) {
          const a = suggestedSlots[0].startLocal;
          const b = suggestedSlots[1].startLocal;
          finalDraft = `${greeting}This is ${agentName} at ${dealerName}. ${availabilityLine}${noteLine}${buildLine}${scheduleInvite} I have ${a} or ${b} — do any of these times work?`.trim();
        } else if (canScheduleNow) {
          finalDraft = `${greeting}This is ${agentName} at ${dealerName}. ${availabilityLine}${noteLine}${buildLine}${scheduleInvite} What day and time works for you?`.trim();
        } else {
          finalDraft = `${greeting}This is ${agentName} at ${dealerName}. ${availabilityLine}I'll confirm availability shortly and follow up.`;
        }
      }

      return finalize({
        intent,
        stage: "ENGAGED",
        shouldRespond: true,
        draft: finalDraft,
        suggestedSlots,
        requestedTime,
        requestedAppointmentType: appointmentType,
        pricingAttempted,
        handoff: handoff ? { ...handoff, ack: finalDraft } : undefined,
        memorySummary
      });
    } catch {
      return finalize({
        intent,
        stage: "ENGAGED",
        shouldRespond: true,
        draft: fallbackDraft,
        pricingAttempted
      });
    }
  }

  return finalize({
    intent,
    stage: "ENGAGED",
    shouldRespond: true,
    draft: fallbackDraft,
    pricingAttempted
  });
}
