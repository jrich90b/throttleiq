// services/api/src/domain/orchestrator.ts
import { loadSystemPrompt } from "./loadPrompt.js";
import type { InboundMessageEvent, OrchestratorResult } from "./types.js";
import { generateDraftWithLLM } from "./llmDraft.js";
import { resolveInventoryUrlByStock } from "./inventoryUrlResolver.js";
import { checkInventorySalePendingByUrl, type InventoryStatus } from "./inventoryChecker.js";
import { getDealerProfile } from "./dealerProfile.js";
import type { LeadProfile } from "./conversationStore.js";
import { parseRequestedDayTime } from "./conversationStore.js";
import { getSchedulerConfig, dayKey } from "./schedulerConfig.js";
import { getAuthedCalendarClient, queryFreeBusy } from "./googleCalendar.js";
import { generateCandidateSlots, expandBusyBlocks, pickSlotsForSalesperson } from "./schedulerEngine.js";

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

function inferAppointmentType(
  text: string
): "inventory_visit" | "test_ride" | "trade_appraisal" | "finance_discussion" {
  const t = text.toLowerCase();
  if (/(test ride|demo ride)/.test(t)) return "test_ride";
  if (/(trade appraisal|appraisal|value my trade|trade in)/.test(t)) return "trade_appraisal";
  if (/(finance|credit|prequal|hdfs|payment)/.test(t)) return "finance_discussion";
  return "inventory_visit";
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

  if (looksLikeOptOut(event.body)) {
    return {
      intent: "GENERAL",
      stage: "ENGAGED",
      shouldRespond: true,
      draft: "Got it — I won’t message you again."
    };
  }

  const intent = simpleIntent(event.body);
  const pricingAttempts = ctx?.pricingAttempts ?? 0;
  const managerRequest = detectManagerRequest(event.body);
  const approvalStatus = detectApprovalStatus(event.body);
  const pricingIntent = detectPricingOrPayment(event.body, intent);
  const exactPressure = detectExactNumberPressure(event.body);
  const pricingAttempted = pricingIntent && pricingAttempts === 0;

  if (managerRequest) {
    const ack =
      "Got it — I’ll have a manager follow up shortly. What’s the best time to reach you today?";
    return {
      intent,
      stage: "ENGAGED",
      shouldRespond: true,
      draft: ack,
      handoff: { required: true, reason: "manager", ack }
    };
  }

  if (approvalStatus) {
    const ack =
      "Got it — I’ll have our team check the status and follow up shortly. What’s the best time to reach you today?";
    return {
      intent,
      stage: "ENGAGED",
      shouldRespond: true,
      draft: ack,
      handoff: { required: true, reason: "approval", ack }
    };
  }

  if (pricingIntent && pricingAttempts >= 1) {
    const reason = detectPaymentPressure(event.body) ? "payments" : "pricing";
    const ack = exactPressure
      ? "Got it — to make sure the numbers are accurate, I’m going to have a manager pull the exact out-the-door/payment options and follow up shortly. What’s the best time to reach you today?"
      : "Got it — I’ll have a manager pull the most accurate numbers and follow up shortly. What’s the best time to reach you today?";
    return {
      intent,
      stage: "ENGAGED",
      shouldRespond: true,
      draft: ack,
      handoff: { required: true, reason, ack }
    };
  }

  const fallbackDraft =
    "Thanks for reaching out — what day and time works best for you to stop in?";

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
    return {
      intent,
      stage: "ENGAGED",
      shouldRespond: true,
      draft: ack,
      handoff: { required: true, reason: "other", ack }
    };
  }

  // Use LLM when enabled; otherwise fall back to template.
  const useLLM = process.env.LLM_ENABLED === "1" && !!process.env.OPENAI_API_KEY;

  if (useLLM) {
    try {
      const today = new Date().toLocaleDateString("en-US", { weekday: "long" });
      const dealerProfile = await getDealerProfile();
      const appointment = ctx?.appointment ?? null;
      const followUp = ctx?.followUp ?? null;
      const lead: LeadProfile = {
        ...(ctx?.lead ?? {}),
        vehicle: {
          ...(ctx?.lead?.vehicle ?? {}),
          stockId: stockId ?? ctx?.lead?.vehicle?.stockId,
          condition
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
      let requestedDayMaxSlots = 0;
      const schedulingIntent = hasSchedulingIntent(event.body) || event.provider === "sendgrid_adf";
      const appointmentType = inferAppointmentType(event.body);

      const apptBooked = appointment?.bookedEventId;
      const apptConfirmed = !!apptBooked;
      const holding = followUp?.mode === "holding_inventory";

      console.log("[scheduler] intent?", schedulingIntent, "apptConfirmed?", apptConfirmed, "holding?", holding);

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
          const durationMinutes = cfg.appointmentTypes[appointmentType]?.durationMinutes ?? 60;

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

          let cal: any = null;
          try {
            cal = await getAuthedCalendarClient();
          } catch (e: any) {
            console.log("[scheduler] calendar unavailable, using open availability:", e?.message ?? e);
          }

          for (const salespersonId of cfg.preferredSalespeople) {
            const sp = cfg.salespeople.find((p: any) => p.id === salespersonId);
            if (!sp) continue;

            const timeMin = new Date(now).toISOString();
            const timeMax = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

            let busy: any[] = [];
            if (cal) {
              const fb = await queryFreeBusy(cal, [sp.calendarId], timeMin, timeMax, cfg.timezone);
              busy = fb.calendars?.[sp.calendarId]?.busy ?? [];
            }
            const expanded = expandBusyBlocks(busy as any, cfg.minGapBetweenAppointmentsMinutes);

            let slots: any[] = [];
            if (requestedDay) {
              let targetDayKey = requestedDay;
              if (requestedDay === "today" || requestedDay === "tomorrow") {
                const d = new Date(now);
                d.setDate(d.getDate() + (requestedDay === "tomorrow" ? 1 : 0));
                targetDayKey = dayKey(d, cfg.timezone);
              }
              const preferredDays = candidatesByDay.filter(d => {
                if (dayKey(d.dayStart, cfg.timezone) !== targetDayKey) return false;
                if (requestedDay !== "today" && requestedDay !== "tomorrow") {
                  // If they named a weekday, treat it as the next occurrence (not today)
                  return d.dayStart.getTime() > now.getTime() && d.candidates.length > 0;
                }
                return d.candidates.length > 0;
              });
              slots = pickSlotsForSalesperson(cfg, sp.id, sp.calendarId, preferredDays, expanded, 3);
              if (slots.length > requestedDayMaxSlots) {
                requestedDayMaxSlots = slots.length;
              }
            }
            if (slots.length < 2 && (!requestedDay || requestedDay === "today" || requestedDay === "tomorrow")) {
              slots = pickSlotsForSalesperson(cfg, sp.id, sp.calendarId, candidatesByDay, expanded, 3);
            }

            if (slots.length >= 2) {
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
              }));
              break;
            }
          }

          if (requestedDaySpecified && requestedDayMaxSlots < 2) {
            requestedDayNoAvailability = true;
          }
        } catch (e: any) {
          console.log("[scheduler] ERROR", e?.message ?? e);
          suggestedSlots = [];
        }
      }

      console.log("[scheduler] suggestedSlots", suggestedSlots.length);

      if (requestedDayNoAvailability && requestedDayKey) {
        const dayName = requestedDayKey.charAt(0).toUpperCase() + requestedDayKey.slice(1);
        const fallbackMessage = `I'm booked up for ${dayName}. Is there another day that works for you?`;
        return {
          intent,
          stage: "ENGAGED",
          shouldRespond: true,
          draft: fallbackMessage,
          suggestedSlots: []
        };
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
          finalDraft = `Hi, this is ${agentName} at ${dealerName}. ${availabilityLine}I can get you scheduled to come in. I have ${a} or ${b} — which works best?`.trim();
        } else if (canScheduleNow) {
          finalDraft = `Hi, this is ${agentName} at ${dealerName}. ${availabilityLine}I can get you scheduled to come in — what day and time works best for you?`.trim();
        } else {
          finalDraft = `Hi, this is ${agentName} at ${dealerName}. ${availabilityLine}I'll confirm availability shortly and follow up.`;
        }
      }

      return {
        intent,
        stage: "ENGAGED",
        shouldRespond: true,
        draft: finalDraft,
        suggestedSlots,
        requestedTime,
        requestedAppointmentType: appointmentType,
        pricingAttempted
      };
    } catch {
      return {
        intent,
        stage: "ENGAGED",
        shouldRespond: true,
        draft: fallbackDraft,
        pricingAttempted
      };
    }
  }

  return {
    intent,
    stage: "ENGAGED",
    shouldRespond: true,
    draft: fallbackDraft,
    pricingAttempted
  };
}
