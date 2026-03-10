// services/api/src/domain/orchestrator.ts
import { loadSystemPrompt } from "./loadPrompt.js";
import type { InboundMessageEvent, OrchestratorResult } from "./types.js";
import { generateDraftWithLLM } from "./llmDraft.js";
import { resolveInventoryUrlByStock } from "./inventoryUrlResolver.js";
import { checkInventorySalePendingByUrl, type InventoryStatus } from "./inventoryChecker.js";
import { findInventoryPrice, findPriceRange } from "./inventoryFeed.js";
import { getDealerProfile } from "./dealerProfile.js";
import type { LeadProfile } from "./conversationStore.js";
import { parseRequestedDayTime } from "./conversationStore.js";
import { getSchedulerConfig, dayKey, getPreferredSalespeople } from "./schedulerConfig.js";
import { getAuthedCalendarClient, queryFreeBusy } from "./googleCalendar.js";
import {
  generateCandidateSlots,
  expandBusyBlocks,
  pickSlotsForSalesperson,
  localPartsToUtcDate
} from "./schedulerEngine.js";

function simpleIntent(body: string): OrchestratorResult["intent"] {
  const t = body.toLowerCase();
  if (/(stock|vin|available|availability|still there)/.test(t)) return "AVAILABILITY";
  if (/(price|otd|out the door|payment|monthly)/.test(t)) return "PRICING";
  if (/(finance|credit|apr)/.test(t)) return "FINANCING";
  if (/(trade|trade-in|trade in)/.test(t)) return "TRADE_IN";
  if (/(test ride|ride it|demo)/.test(t)) return "TEST_RIDE";
  if (/(spec|seat height|weight|hp|horsepower|torque)/.test(t)) return "SPECS";
  return "GENERAL";
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
  const hasCallback =
    /(call me|call him|call her|give me a call|give (him|her) a call|reach me|reach him|reach her|contact me|can you call|can you have|please call|have .* call|tell .* i will call|i will call)/.test(
      t
    );
  const hasTimeframe =
    /(today|tomorrow|this weekend|this week|next week|tuesday|wednesday|thursday|friday|saturday|sunday|monday|\bmon\b|\btue\b|\bwed\b|\bthu\b|\bfri\b|\bsat\b|\bsun\b|\b\d{1,2}:\d{2}\s*(am|pm)?\b|\b\d{1,2}\s*(am|pm)\b)/.test(
      t
    );
  const hasPhone = /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(t);
  const hasTrade = /(trade[-\s]?in|trade in|trading in)/.test(t);
  return hasCallback || (hasTimeframe && (hasPhone || hasTrade));
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
  return /(monthly payment|what would it be a month|what would it be per month|how much down|\bapr\b|term)/.test(
    t
  );
}

function detectPricingOrPayment(text: string, intent?: OrchestratorResult["intent"]): boolean {
  if (intent === "PRICING" || intent === "FINANCING") return true;
  const t = text.toLowerCase();
  return /(price|deal|discount|lowest|\botd\b|out the door|payment|monthly|down|apr|term)/.test(t);
}

function detectCorporateIntent(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /(harley[-\s]?davidson corporate|harley corporate|corporate office|headquarters|\bhq\b)/.test(t) ||
    /(customer service|complaint|feedback|warranty|recall|vin lookup|information on.*vin|vin information)/.test(t) ||
    /(employment|job|career|hr|human resources|business relations|media|press)/.test(t)
  );
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
  return (
    /(appointment|appt|schedule|book|reserve)/.test(t) ||
    /(come in|stop in|stop by|swing by|visit)/.test(t) ||
    /(test ride|demo ride)/.test(t) ||
    /(trade appraisal|appraisal|value my trade)/.test(t) ||
    /(finance|credit|prequal)/.test(t) ||
    /\b(today|tomorrow|sat|saturday|sun|sunday|mon|monday|tue|tuesday|wed|wednesday|thu|thursday|fri|friday)\b/.test(
      t
    ) ||
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
  const letters = trimmed.replace(/[^A-Za-z]/g, "");
  const isAllCaps = letters.length > 0 && letters === letters.toUpperCase();
  return isAllCaps ? toTitleCase(trimmed) : trimmed;
}

function isUnknownModel(label?: string | null): boolean {
  if (!label) return true;
  const trimmed = label.trim().toLowerCase();
  if (!trimmed) return true;
  return trimmed === "other" || /\bother\b/.test(trimmed);
}

function inferAppointmentType(
  text: string
): "inventory_visit" | "test_ride" | "trade_appraisal" | "finance_discussion" {
  const t = text.toLowerCase();
  if (/(test ride|demo ride)/.test(t)) return "test_ride";
  if (/(trade appraisal|appraisal|value my trade|trade in)/.test(t)) return "trade_appraisal";
  if (/(finance|credit|prequal|hdfs|payment)/.test(t)) return "finance_discussion";
  return "inventory_visit";
}

function buildLongTermMessage(timeframe?: string, hasLicense?: boolean) {
  const tf = timeframe ? timeframe.trim() : "a future";
  if (hasLicense === true) {
    return `Hi, this is Brooke at American Harley-Davidson. Just circling back since you mentioned a ${tf} timeline. Want to come in and check out options or set up a test ride? I can get you scheduled for a test ride.`;
  }
  return `Hi, this is Brooke at American Harley-Davidson. Just circling back since you mentioned a ${tf} timeline. Want to come in and check out options?`;
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
  const t = body.trim().toLowerCase();
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

function enforceNoPrematureBooking(draft: string, appointment: any, suggestedSlots: any[]) {
  if (appointment?.status === "confirmed") return draft;

  let out = draft
    .replace(
      /\b(i have you|you('| a)?re|you are)\s+(scheduled|booked|confirmed|all set|set)\b/gi,
      "I can get you scheduled"
    )
    .replace(/\bsee you\b/gi, "I can get you scheduled")
    .trim();

  if (Array.isArray(suggestedSlots) && suggestedSlots.length >= 2) {
    const a = suggestedSlots[0].startLocal;
    const b = suggestedSlots[1].startLocal;
    out = `I can get you scheduled to come in. I have ${a} or ${b} — which works best?`;
  }

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
  }
): Promise<OrchestratorResult> {
  await loadSystemPrompt("orchestrator");

  const finalize = (result: OrchestratorResult): OrchestratorResult => {
    const out: OrchestratorResult = {
      ...result,
      suggestedSlots: result.suggestedSlots ?? []
    };
    console.log("[orchestrateInbound] return", {
      provider: event.provider,
      suggestedSlotsLen: out.suggestedSlots?.length ?? 0
    });
    return out;
  };

  if (looksLikeOptOut(event.body)) {
    return finalize({
      intent: "GENERAL",
      stage: "ENGAGED",
      shouldRespond: true,
      draft: "Got it — I won’t message you again."
    });
  }

  const leadSourceRaw = (ctx?.leadSource ?? ctx?.lead?.source ?? "").toLowerCase();
  const isSellMyBike = /sell my bike/.test(leadSourceRaw);
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
    const draft = `Hi ${leadFirst} — thanks for reaching out about selling your ${yearLabel}${modelLabel}. We can help with a trade‑in appraisal.${mileageLine} ${optionLine} Do you have a couple photos? If you’d rather stop in, I can set a time.`;
    return finalize({
      intent: "TRADE_IN",
      stage: "ENGAGED",
      shouldRespond: true,
      draft
    });
  }

  const isHdfsCoa = /hdfs\s*coa\s*online/.test(leadSourceRaw);
  if (isHdfsCoa && event.provider === "sendgrid_adf") {
    const leadFirst = ctx?.lead?.firstName?.trim() || "there";
    const yearLabel = ctx?.lead?.vehicle?.year ? `${ctx.lead.vehicle.year} ` : "";
    const modelLabel = normalizeModelLabel(ctx?.lead?.vehicle?.model ?? ctx?.lead?.vehicle?.description);
    const dealerProfile = await getDealerProfile();
    const agentName = dealerProfile?.agentName ?? "Brooke";
    const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
    const draft =
      `Hi ${leadFirst} — thanks for your interest in the ${yearLabel}${modelLabel}. ` +
      `This is ${agentName} at ${dealerName}. We received your online credit application. ` +
      "I’ll have our business manager reach out to go over your options. What time would work best?";
    return finalize({
      intent: "FINANCING",
      stage: "ENGAGED",
      shouldRespond: true,
      draft,
      handoff: { required: true, reason: "approval", ack: draft }
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
      "Thanks for reaching out — due to our dealer agreement, we can only sell to customers within the United States.";
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
  const callbackRequest = detectCallbackRequest(event.body);
  const pricingIntent =
    detectPricingOrPayment(event.body, intent) ||
    /request a quote|raq/i.test(ctx?.leadSource ?? "");
  const exactPressure = detectExactNumberPressure(event.body);
  const pricingAttempted = pricingIntent && pricingAttempts === 0;
  const stockIdFromText = event.body.match(/\b[A-Z0-9]{1,5}-\d{1,4}\b/i)?.[0]?.toUpperCase() ?? null;

  if (managerRequest) {
    const ack =
      "Got it — I’ll have a manager follow up shortly. What’s the best time to reach you today?";
    return finalize({
      intent,
      stage: "ENGAGED",
      shouldRespond: true,
      draft: ack,
      handoff: { required: true, reason: "manager", ack }
    });
  }

  if (approvalStatus) {
    const ack =
      "Got it — I’ll have our team check the status and follow up shortly. What’s the best time to reach you today?";
    return finalize({
      intent,
      stage: "ENGAGED",
      shouldRespond: true,
      draft: ack,
      handoff: { required: true, reason: "approval", ack }
    });
  }

  if (callbackRequest) {
    const ack =
      "Got it — I’ll have Scotty reach out. If you prefer, you can call us when you’re back. What’s the best number and time to reach you?";
    return finalize({
      intent,
      stage: "ENGAGED",
      shouldRespond: true,
      draft: ack,
      handoff: { required: true, reason: "other", ack }
    });
  }

  if (pricingIntent && pricingAttempts >= 1) {
    const reason = detectPaymentPressure(event.body) ? "payments" : "pricing";
    const ack = exactPressure
      ? "Got it — to make sure the numbers are accurate, I’m going to have a manager pull the exact out-the-door/payment options and follow up shortly. What’s the best time to reach you today?"
      : "Got it — I’ll have a manager pull the most accurate numbers and follow up shortly. What’s the best time to reach you today?";
    return finalize({
      intent,
      stage: "ENGAGED",
      shouldRespond: true,
      draft: ack,
      handoff: { required: true, reason, ack }
    });
  }

  const fallbackDraft =
    "Thanks for reaching out — what day and time works best for you to stop in?";

  if (pricingIntent) {
    try {
      const leadForPrice = ctx?.lead ?? {};
      const yearForRange =
        leadForPrice?.vehicle?.year ??
        deriveYearFromText(leadForPrice?.vehicle?.description ?? null) ??
        null;
      const modelForRange =
        leadForPrice?.vehicle?.model ??
        deriveModelFromDescription(leadForPrice?.vehicle?.description ?? null) ??
        null;
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
      const range =
        yearForRange && modelForRange ? await findPriceRange({ year: yearForRange, model: modelForRange }) : null;
      if (!stockForPrice && !vinForPrice && range?.count && range.count > 1) {
        price = null;
      }
      if (!price && !range) {
        if (modelUnknown) {
          const firstName = leadForPrice?.firstName?.trim() || "there";
          const yearLabel = yearForRange ? `${yearForRange} ` : "";
          const dealerProfile = await getDealerProfile();
          const agentName = dealerProfile?.agentName ?? "Brooke";
          const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
          const draft =
            `Hi ${firstName} — this is ${agentName} at ${dealerName}. ` +
            `Thanks for your Facebook quote request. I’d love to help with pricing. Which ${yearLabel}model are you interested in?`;
          return finalize({
            intent,
            stage: "ENGAGED",
            shouldRespond: true,
            draft
          });
        }
        const ack =
          "Got it — I’ll have a manager pull the exact pricing and follow up shortly. What’s the best time to reach you today?";
        return finalize({
          intent,
          stage: "ENGAGED",
          shouldRespond: true,
          draft: ack,
          handoff: { required: true, reason: "pricing", ack }
        });
      }
    } catch {
      const ack =
        "Got it — I’ll have a manager pull the exact pricing and follow up shortly. What’s the best time to reach you today?";
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
  const availabilityAsked = /(available|availability|still there|in stock)/i.test(event.body);

  // Stock IDs on your site are commonly like C1-26, T11-26, etc.
  // Keep this permissive; tune later if needed.
  const stockMatch = event.body.match(/\b[A-Z0-9]{1,5}-\d{1,4}\b/i);
  if (stockMatch?.[0]) stockId = stockMatch[0].toUpperCase();

  const condition = stockId ? (/^u/i.test(stockId) ? "used" : "new") : "new_model_interest";

  if (intent === "AVAILABILITY" && stockId && event.body.toLowerCase().includes(stockId.toLowerCase())) {

    const resolved = await resolveInventoryUrlByStock(stockId);
    if (resolved.ok) {
      inventoryUrl = resolved.url;
      inventoryStatus = await checkInventorySalePendingByUrl(inventoryUrl);
    } else {
      inventoryStatus = "UNKNOWN";
    }
  }

  if (availabilityAsked && stockId && inventoryStatus === "UNKNOWN") {
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

  // Use LLM when enabled; otherwise fall back to template.
  const useLLM = process.env.LLM_ENABLED === "1" && !!process.env.OPENAI_API_KEY;

  if (useLLM) {
    try {
      const today = new Date().toLocaleDateString("en-US", { weekday: "long" });
      const dealerProfile = await getDealerProfile();
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
      const hasIntent = hasSchedulingIntent(event.body);
      const isAdfLead = /adf/i.test(ctx?.leadSource ?? "") || /adf/i.test(ctx?.lead?.source ?? "");
      const cta = ctx?.cta ?? "";
      const bucket = ctx?.bucket ?? "";
      const ctxSuggestsScheduling =
        /(check_availability|inventory_interest|appointment|schedule|book|visit|test_ride)/i.test(cta) ||
        /(inventory_interest|appointment|schedule|book|visit|test_ride)/i.test(bucket);
      const schedulingIntent =
        hasIntent || event.provider === "sendgrid_adf" || isAdfLead || ctxSuggestsScheduling;
      const appointmentType = inferAppointmentType(event.body);

      const apptBooked = appointment?.bookedEventId;
      const apptConfirmed = !!apptBooked;
      const holding = followUp?.mode === "holding_inventory";

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
          const candidatesByDay = generateCandidateSlots(cfg, now, durationMinutes, 14);
          const requestedDay = inferRequestedDay(event.body);
          requestedTime = parseRequestedDayTime(event.body, cfg.timezone);
          requestedDaySpecified =
            !!requestedDay && requestedDay !== "today" && requestedDay !== "tomorrow";
          if (requestedDaySpecified) {
            requestedDayKey = requestedDay;
          } else if (requestedDay === "today" || requestedDay === "tomorrow") {
            const d = new Date(now);
            d.setDate(d.getDate() + (requestedDay === "tomorrow" ? 1 : 0));
            requestedDayKey = dayKey(d, cfg.timezone);
          }
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
            const timeMax = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

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

      if (pricingIntent && (listPrice || priceRange)) {
        const nf = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
        const yearLabel = lead.vehicle?.year ? `${lead.vehicle.year} ` : "";
        const modelLabel = lead.vehicle?.model ?? "that model";
        const stockLabel = lead.vehicle?.stockId ?? stockId;
        let priceLine = "";
        if (listPrice) {
          if (stockLabel) {
            priceLine = `The listed price for ${stockLabel} is ${nf.format(listPrice)}.`;
          } else {
            priceLine = `The listed price for the ${yearLabel}${modelLabel} we have in stock is ${nf.format(
              listPrice
            )}.`;
          }
        } else if (priceRange) {
          if (priceRange.count === 1) {
            priceLine = `The listed price for the ${yearLabel}${modelLabel} we have in stock is ${nf.format(
              priceRange.min
            )}.`;
          } else {
            priceLine = `Listed prices for ${yearLabel}${modelLabel} units we have in stock range from ${nf.format(
              priceRange.min
            )} to ${nf.format(priceRange.max)}, depending on color/trim/options.`;
          }
        }
        const disclaimer = "Final numbers depend on tax, fees, any trade, and financing.";
        const schedule = suggestedSlots.length >= 2
          ? `I could get you scheduled to meet with our sales team. I have ${suggestedSlots[0].startLocal} or ${suggestedSlots[1].startLocal} — which works best?`
          : "I could get you scheduled to meet with our sales team — what day/time works best?";
        const qualifier = "Do you have a trade?";
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
          draft: `${greeting}${priceLine} ${disclaimer}\n\n${schedule} ${qualifier}`.trim(),
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
          const fallbackMessage = `We’re closed on ${dayName}. I have ${suggestedSlots[0].startLocal} or ${suggestedSlots[1].startLocal} — which works best?`;
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
        dealerProfile,
        today,
        appointment,
        followUp,
        suggestedSlots,
        pricingAttempts,
        pricingIntent
      });

      let finalDraft = (draft || fallbackDraft).trim();
      finalDraft = stripRescheduleOffers(finalDraft);
      finalDraft = enforceNoPrematureBooking(finalDraft, appointment, suggestedSlots);
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
        const greeting = `Hi ${leadName} — thanks for your interest in the ${thankYear}${thankLabel}. `;
        const availabilityAsked = /(available|availability|still there|in stock)/i.test(event.body);
        const hasAvailabilityAnswer = inventoryStatus === "AVAILABLE";
        const hasPendingAnswer = inventoryStatus === "PENDING";
        const hasUnknownAnswer = inventoryStatus === "UNKNOWN" || !inventoryStatus;
        let availabilityLine = "";
        if (availabilityAsked) {
          if (hasPendingAnswer) {
            availabilityLine = "That unit is sale pending. ";
          } else if (hasAvailabilityAnswer) {
            availabilityLine = `${stockId ?? "That unit"} is available right now. `;
          } else if (hasUnknownAnswer) {
            availabilityLine = "Let me verify availability and I’ll confirm shortly. ";
          }
        }
        const canScheduleNow = !(availabilityAsked && (inventoryStatus === "UNKNOWN" || !inventoryStatus));
        if (canScheduleNow && suggestedSlots.length >= 2) {
          const a = suggestedSlots[0].startLocal;
          const b = suggestedSlots[1].startLocal;
          finalDraft = `${greeting}This is ${agentName} at ${dealerName}. ${availabilityLine}I can get you scheduled to come in. I have ${a} or ${b} — which works best?`.trim();
        } else if (canScheduleNow) {
          finalDraft = `${greeting}This is ${agentName} at ${dealerName}. ${availabilityLine}I can get you scheduled to come in — what day and time works best for you?`.trim();
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
        pricingAttempted
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
