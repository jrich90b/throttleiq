import type { Request, Response } from "express";
import multer from "multer";
import { XMLParser } from "fast-xml-parser";
import { extractAdfXmlFromEmail, parseAdfXml } from "../domain/adfParser.js";
import {
  upsertConversationByLeadKey,
  appendInbound,
  appendOutbound,
  mergeConversationLead,
  setConversationClassification,
  updateHoldingFromInbound,
  confirmAppointmentIfMatchesSuggested,
  startFollowUpCadence,
  scheduleLongTermFollowUp,
  discardPendingDrafts,
  getPricingAttempts,
  incrementPricingAttempt,
  addTodo,
  setFollowUpMode,
  stopFollowUpCadence,
  markPricingEscalated,
  closeConversation
} from "../domain/conversationStore.js";
import { orchestrateInbound } from "../domain/orchestrator.js";
import { resolveChannel, resolveLeadRule } from "../domain/leadSourceRules.js";
import type { InboundMessageEvent } from "../domain/types.js";
import { getSchedulerConfig, getPreferredSalespeople } from "../domain/schedulerConfig.js";
import { getAuthedCalendarClient, insertEvent, queryFreeBusy } from "../domain/googleCalendar.js";
import { expandBusyBlocks, findExactSlotForSalesperson, formatSlotLocal } from "../domain/schedulerEngine.js";
import { getDealerProfile } from "../domain/dealerProfile.js";
import { upsertContact } from "../domain/contactsStore.js";

const upload = multer({ storage: multer.memoryStorage() });
export const sendgridInboundMiddleware = upload.any();

function text(v: any): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (typeof v === "object" && typeof v["#text"] === "string") return v["#text"].trim();
  return undefined;
}

function attr(v: any, name: string): string | undefined {
  if (!v || typeof v !== "object") return undefined;
  const direct = v[`@_${name}`] ?? v[name];
  if (typeof direct === "string") return direct.trim();
  return undefined;
}

function pickNameValue(v: any): string | undefined {
  if (!v) return undefined;
  const list = Array.isArray(v) ? v : [v];
  for (const n of list) {
    if (typeof n === "string") return n.trim();
    if (typeof n === "object") {
      if (typeof n["#text"] === "string") return n["#text"].trim();
      if (typeof n.full === "string") return n.full.trim();
      if (typeof n.first === "string" || typeof n.last === "string") {
        const f = typeof n.first === "string" ? n.first.trim() : "";
        const l = typeof n.last === "string" ? n.last.trim() : "";
        const joined = `${f} ${l}`.trim();
        if (joined) return joined;
      }
    }
  }
  return undefined;
}

function decodeQuotedPrintable(input: string): string {
  if (!input) return "";
  const softBreak = input.replace(/=\s*\r?\n/g, "");
  return softBreak.replace(/=([A-Fa-f0-9]{2})/g, (_m, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

function extractLeadMeta(adfXml: string): { leadSource?: string; model?: string } {
  try {
    const cleaned = decodeQuotedPrintable(adfXml);
    const parser = new XMLParser({ ignoreAttributes: false });
    const doc = parser.parse(cleaned);
    const adf = doc?.adf ?? doc;
    const prospect = adf?.prospect ?? {};

    const sourceFromId = text(attr(prospect?.id, "source"));
    const providerName =
      pickNameValue(prospect?.provider?.name) ??
      text(prospect?.provider) ??
      pickNameValue(adf?.provider?.name) ??
      text(adf?.provider);
    const vendorName =
      pickNameValue(prospect?.vendor?.name) ??
      text(prospect?.vendor) ??
      pickNameValue(adf?.vendor?.name) ??
      text(adf?.vendor);

    let leadSource = [providerName, vendorName, sourceFromId].find(v => v && v.length > 0);
    if (!leadSource) {
      const providerMatch = cleaned.match(
        /<provider[^>]*>[\s\S]*?<name[^>]*>([^<]+)<\/name>/i
      );
      const vendorMatch = cleaned.match(
        /<vendor[^>]*>[\s\S]*?<vendorname[^>]*>([^<]+)<\/vendorname>/i
      );
      const idSourceMatch = cleaned.match(/<id[^>]*source=["']([^"']+)["'][^>]*>/i);
      leadSource = providerMatch?.[1]?.trim() ?? vendorMatch?.[1]?.trim() ?? idSourceMatch?.[1]?.trim();
    }

    const vehicle = prospect?.vehicle ?? prospect?.request?.vehicle ?? adf?.vehicle ?? {};
    const model = text(vehicle?.model);

    return { leadSource, model };
  } catch {
    return {};
  }
}

function parseTimeframeMonths(raw?: string): { start?: number; end?: number } | null {
  if (!raw) return null;
  const t = raw.toLowerCase();
  if (/unsure|not sure|unknown/.test(t)) return null;
  const range = t.match(/(\d+)\s*[-to]+\s*(\d+)\s*month/);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (!Number.isNaN(a) && !Number.isNaN(b)) {
      return { start: Math.min(a, b), end: Math.max(a, b) };
    }
  }
  const single = t.match(/(\d+)\s*month/);
  if (single) {
    const a = Number(single[1]);
    if (!Number.isNaN(a)) return { start: a };
  }
  return null;
}

function buildLongTermMessage(timeframe?: string, hasLicense?: boolean) {
  const tf = timeframe ? timeframe.trim() : "a future";
  if (hasLicense === true) {
    return `Hi, this is Brooke at American Harley-Davidson. Just circling back since you mentioned a ${tf} timeline. Want to come in and check out options or set up a test ride? I can get you scheduled for a test ride.`;
  }
  return `Hi, this is Brooke at American Harley-Davidson. Just circling back since you mentioned a ${tf} timeline. Want to come in and check out options?`;
}

export async function handleSendgridInbound(req: Request, res: Response) {
  console.log("[sendgrid inbound] meta:", {
    contentType: req.header("content-type"),
    contentLength: req.header("content-length"),
    files: Array.isArray(req.files) ? req.files.length : 0
  });
  console.log("[sendgrid inbound] keys:", Object.keys(req.body));
  if (req.body?.email) {
    const sample = [];
    for (let i = 0; i < Math.min(10, req.body.email.length); i++) {
      sample.push(req.body.email[i]);
    }
    console.log("[sendgrid inbound] email body sample:", sample);
  }

  const textBody = typeof req.body?.text === "string" ? req.body.text : undefined;
  const htmlBody = typeof req.body?.html === "string" ? req.body.html : undefined;
  const emailBody = typeof req.body?.email === "string" ? req.body.email : undefined;

  let adfXml = extractAdfXmlFromEmail(textBody, htmlBody);

  // Some SendGrid configurations provide the full MIME in "email"
  if (!adfXml && emailBody) {
    adfXml = extractAdfXmlFromEmail(emailBody, undefined);
  }

  // Try raw MIME payload (SendGrid’s full MIME when enabled)
  const rawMime = typeof req.body?.raw === "string" ? req.body.raw : undefined;
  if (!adfXml && rawMime) {
    try {
      const decoded = Buffer.from(rawMime, "base64").toString("utf8");
      console.log("[sendgrid inbound] raw decoded sample:", decoded.slice(0, 200).replace(/\s+/g, " "));
      adfXml = extractAdfXmlFromEmail(decoded, undefined);
    } catch {
      adfXml = null;
    }
  }

  // Try attachments (any type) for embedded ADF XML
  if (!adfXml && Array.isArray(req.files)) {
    for (const f of req.files as Express.Multer.File[]) {
      const s = f.buffer.toString("utf8");
      const found = extractAdfXmlFromEmail(s, undefined);
      if (found) {
        adfXml = found;
        break;
      }
    }
  }

  if (!adfXml) {
    console.warn("[sendgrid inbound] No ADF found", {
      subject: req.body?.subject,
      from: req.body?.from
    });
    return res.status(200).json({ ok: true, parsed: false, reason: "no_adf_found" });
  }

  console.log("[sendgrid inbound] to:", req.body?.to);
  console.log("[sendgrid inbound] envelope:", req.body?.envelope);
  console.log(
    "[sendgrid inbound] adf snippet:",
    adfXml.slice(0, 200).replace(/\s+/g, " ")
  );

  const lead = parseAdfXml(adfXml);
  const leadRefFallback =
    adfXml.match(/<prospect[^>]*>[\s\S]*?<id[^>]*>([^<]+)<\/id>/i)?.[1]?.trim() ??
    undefined;
  const leadRef = lead.leadRef ?? leadRefFallback;
  console.log("[sendgrid inbound] parsed lead:", {
    leadRef,
    firstName: lead.firstName,
    lastName: lead.lastName,
    email: lead.email,
    phone: lead.phone,
    stockId: lead.stockId,
    vin: lead.vin,
    year: lead.year,
    inquiry: lead.inquiry
  });
  const meta = extractLeadMeta(adfXml);
  const leadSource = meta.leadSource?.trim() || undefined;
  const leadSourceId = lead.leadSourceId ?? undefined;
  const timeframeInfo = parseTimeframeMonths(lead.purchaseTimeframe);

  // Choose a stable conversation key
  const leadKey =
    (lead.phone && lead.phone.trim()) ||
    (lead.email && lead.email.trim()) ||
    `unknown_${Date.now()}`;

  const conv = upsertConversationByLeadKey(leadKey, "suggest");
  mergeConversationLead(conv, {
    leadRef,
    source: leadSource,
    sourceId: leadSourceId,
    firstName: lead.firstName,
    lastName: lead.lastName,
    preferredDate: lead.preferredDate,
    preferredTime: lead.preferredTime,
    email: lead.email,
    phone: lead.phone,
    street: lead.street,
    city: lead.city,
    region: lead.region,
    postal: lead.postal,
    purchaseTimeframe: lead.purchaseTimeframe,
    purchaseTimeframeMonthsStart: timeframeInfo?.start,
    purchaseTimeframeMonthsEnd: timeframeInfo?.end,
    hasMotoLicense: lead.hasMotoLicense,
    sellOption: lead.sellOption,
    vehicle: {
      stockId: lead.stockId,
      vin: lead.vin,
      year: lead.year,
      model: meta.model,
      color: lead.vehicleColor,
      description: lead.vehicleDescription,
      mileage: lead.mileage
    }
  });
  const stockId = lead.stockId?.trim() || undefined;
  conv.lead = conv.lead ?? {};
  conv.lead.vehicle = conv.lead.vehicle ?? {};
  if (stockId) {
    conv.lead.vehicle.stockId = stockId;
    conv.lead.vehicle.condition = /^u/i.test(stockId) ? "used" : "new";
  } else {
    conv.lead.vehicle.condition = "new_model_interest";
  }

  upsertContact({
    leadKey: conv.leadKey,
    conversationId: conv.id,
    leadRef,
    leadSource,
    leadSourceId,
    firstName: lead.firstName,
    lastName: lead.lastName,
    name: [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim() || undefined,
    email: lead.email,
    phone: lead.phone,
    vehicleDescription: lead.vehicleDescription ?? meta.model,
    stockId: lead.stockId,
    vin: lead.vin,
    year: lead.year,
    vehicle: meta.model,
    inquiry: lead.inquiry,
    lastAdfAt: new Date().toISOString()
  });

  const rule = resolveLeadRule(leadSource, leadSourceId);
  const inquiryText = (lead.inquiry ?? "").toLowerCase();
  const hasStockIntent =
    !!lead.stockId || !!lead.vin || inquiryText.includes("available");

  const leadSourceLower = (leadSource ?? "").toLowerCase();
  let inferredBucket = rule.bucket;
  let inferredCta = rule.cta;
  if (!leadSource || rule.ruleName === "default") {
    if (hasStockIntent) {
      inferredBucket = "inventory_interest";
      inferredCta = "check_availability";
    } else if (inquiryText.includes("test ride") || inquiryText.includes("demo")) {
      inferredBucket = "test_ride";
      inferredCta = "schedule_test_ride";
    } else if (
      inquiryText.includes("prequal") ||
      inquiryText.includes("credit") ||
      inquiryText.includes("finance")
    ) {
      inferredBucket = "finance_prequal";
      inferredCta = inquiryText.includes("prequal") ? "prequalify" : "prequalify";
    } else if (
      inquiryText.includes("value my trade") ||
      inquiryText.includes("trade") ||
      inquiryText.includes("sell")
    ) {
      inferredBucket = "trade_in_sell";
      inferredCta = inquiryText.includes("sell") ? "sell_my_bike" : "value_my_trade";
    } else if (inquiryText.includes("service")) {
      inferredBucket = "service";
      inferredCta = "service_request";
    } else {
      inferredBucket = "general_inquiry";
      inferredCta = "unknown";
    }
  }
  const forcedTestRide = leadSourceLower.includes("test ride") || leadSourceLower.includes("book test ride");
  if (forcedTestRide) {
    inferredBucket = "test_ride";
    inferredCta = "schedule_test_ride";
  }
  const channel = resolveChannel({
    leadSource,
    sourceId: leadSourceId,
    hasSms: !!lead.phone,
    hasEmail: !!lead.email,
    hasFacebook:
      leadSourceLower.includes("facebook") ||
      leadSourceLower.includes("autodealers.digital") ||
      leadSourceLower.includes("autodealersdigital.com")
  });
  console.log("[sendgrid inbound] classification", {
    leadSource,
    leadSourceId,
    inferredBucket,
    inferredCta,
    forcedTestRide
  });
  setConversationClassification(conv, {
    bucket: inferredBucket,
    cta: inferredCta,
    channel,
    ruleName: forcedTestRide ? "room58_book_test_ride_forced" : rule.ruleName
  });


  const inboundBody =
    [
      `WEB LEAD (ADF)`,
      leadSource ? `Source: ${leadSource}` : null,
      leadRef ? `Ref: ${leadRef}` : null,
      lead.firstName || lead.lastName ? `Name: ${(lead.firstName ?? "").trim()} ${(lead.lastName ?? "").trim()}`.trim() : null,
      lead.email ? `Email: ${lead.email}` : null,
      lead.phone ? `Phone: ${lead.phone}` : null,
      lead.stockId ? `Stock: ${lead.stockId}` : null,
      lead.vin ? `VIN: ${lead.vin}` : null,
      lead.year ? `Year: ${lead.year}` : null,
      lead.vehicleDescription ? `Vehicle: ${lead.vehicleDescription}` : null,
      "",
      `Inquiry:`,
      inquiryText
    ]
      .filter(v => v !== null)
      .join("\n");

  const event: InboundMessageEvent = {
    channel: "email",
    provider: "sendgrid_adf",
    from: lead.email || lead.phone || "unknown_sender",
    to: "dealership",
    body: inboundBody,
    providerMessageId: String(req.body?.MessageID ?? req.body?.message_id ?? ""),
    receivedAt: new Date().toISOString()
  };

  appendInbound(conv, event);
  discardPendingDrafts(conv, "new_inbound");
  confirmAppointmentIfMatchesSuggested(conv, event.body, event.providerMessageId);
  updateHoldingFromInbound(conv, event.body);

  const isUsed =
    conv.lead?.vehicle?.condition === "used" ||
    (!!conv.lead?.vehicle?.stockId && /^u/i.test(conv.lead?.vehicle?.stockId ?? "")) ||
    /\bU[A-Z0-9]{0,4}-\d{1,4}\b/i.test(event.body);
  const isPendingComplaint = /sale pending|still pending|been pending|pending for|pending too long|what is going on/i.test(
    event.body
  );
  if (isUsed && isPendingComplaint) {
    const ack =
      "Thanks for the heads-up — I’m going to have a salesperson check the sale‑pending status and follow up shortly.";
    addTodo(conv, "other", event.body, event.providerMessageId);
    setFollowUpMode(conv, "manual_handoff", "pending_used_followup");
    stopFollowUpCadence(conv, "manual_handoff");
    appendOutbound(conv, "dealership", leadKey, ack, "draft_ai");
    return res.status(200).json({
      ok: true,
      parsed: true,
      leadKey,
      lead,
      leadSource,
      bucket: inferredBucket,
      cta: inferredCta,
      channel,
      intent: "GENERAL",
      stage: "ENGAGED",
      draft: ack
    });
  }

  const history = conv.messages.slice(-20).map(m => ({ direction: m.direction, body: m.body }));
  const result = await orchestrateInbound(event, history, {
    appointment: conv.appointment,
    followUp: conv.followUp,
    lead: conv.lead,
    leadSource: conv.lead?.source ?? null,
    bucket: conv.classification?.bucket ?? null,
    cta: conv.classification?.cta ?? null,
    pricingAttempts: getPricingAttempts(conv)
  });
  console.log("[sendgrid inbound] requestedTime", result.requestedTime);

  if (result.handoff?.required) {
    const reason = result.handoff.reason;
    addTodo(conv, reason, event.body, event.providerMessageId);
    setFollowUpMode(conv, "manual_handoff", `handoff:${reason}`);
    stopFollowUpCadence(conv, "manual_handoff");
    if (reason === "pricing" || reason === "payments") {
      markPricingEscalated(conv);
    }
    appendOutbound(conv, "dealership", leadKey, result.handoff.ack, "draft_ai");
    return res.status(200).json({
      ok: true,
      parsed: true,
      leadKey,
      lead,
      leadSource,
      bucket: inferredBucket,
      cta: inferredCta,
      channel,
      intent: result.intent,
      stage: result.stage,
      draft: result.handoff.ack,
      handoff: result.handoff
    });
  }

  if (result.autoClose?.reason) {
    closeConversation(conv, result.autoClose.reason);
    appendOutbound(conv, "dealership", leadKey, result.draft, "draft_ai");
    return res.status(200).json({
      ok: true,
      parsed: true,
      leadKey,
      lead,
      leadSource,
      bucket: inferredBucket,
      cta: inferredCta,
      channel,
      intent: result.intent,
      stage: result.stage,
      draft: result.draft,
      autoClose: result.autoClose
    });
  }

  if (result.pricingAttempted) {
    incrementPricingAttempt(conv);
  }

  if (result.requestedTime && !conv.appointment?.bookedEventId) {
    try {
      const cfg = await getSchedulerConfig();
      const appointmentTypes = cfg.appointmentTypes ?? { inventory_visit: { durationMinutes: 60 } };
      const preferredSalespeople = getPreferredSalespeople(cfg);
      const salespeople = cfg.salespeople ?? [];
      const gapMinutes = cfg.minGapBetweenAppointmentsMinutes ?? 60;
      const appointmentType = String(result.requestedAppointmentType ?? "inventory_visit");
      const durationMinutes = appointmentTypes[appointmentType]?.durationMinutes ?? 60;

      const cal = await getAuthedCalendarClient();
      const now = new Date();
      const timeMin = new Date(now).toISOString();
      const timeMax = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

      for (const salespersonId of preferredSalespeople) {
        const sp = salespeople.find((p: any) => p.id === salespersonId);
        if (!sp) continue;

        const fb = await queryFreeBusy(cal, [sp.calendarId], timeMin, timeMax, cfg.timezone);
        const busy = (fb.calendars?.[sp.calendarId]?.busy ?? []) as any;
        const expanded = expandBusyBlocks(busy, gapMinutes);

        const exact = findExactSlotForSalesperson(
          cfg,
          sp.id,
          sp.calendarId,
          result.requestedTime,
          durationMinutes,
          expanded
        );

        if (exact) {
          const stockId = conv.lead?.vehicle?.stockId ?? null;
          const leadNameRaw = conv.lead?.name?.trim() ?? "";
          const firstName = conv.lead?.firstName ?? "";
          const lastName = conv.lead?.lastName ?? "";
          const leadName = leadNameRaw || [firstName, lastName].filter(Boolean).join(" ").trim() || conv.leadKey;

          const summary = `Appt: ${appointmentType} – ${leadName}${stockId ? ` – ${stockId}` : ""}`;
          const description = [
            `LeadKey: ${conv.leadKey}`,
            `Phone: ${conv.lead?.phone ?? conv.leadKey}`,
            `Email: ${conv.lead?.email ?? ""}`,
            `Stock: ${stockId ?? ""}`,
            `VIN: ${conv.lead?.vehicle?.vin ?? ""}`,
            `Source: ${conv.lead?.source ?? ""}`
          ]
            .filter(Boolean)
            .join("\n");

          const eventObj = await insertEvent(
            cal,
            exact.calendarId,
            cfg.timezone,
            summary,
            description,
            exact.start,
            exact.end
          );

          conv.appointment = conv.appointment ?? { status: "none", updatedAt: new Date().toISOString() };
          conv.appointment.status = "confirmed";
          conv.appointment.whenText = formatSlotLocal(exact.start, cfg.timezone);
          conv.appointment.whenIso = exact.start;
          conv.appointment.confirmedBy = "customer";
          conv.appointment.updatedAt = new Date().toISOString();
          conv.appointment.acknowledged = true;
          conv.appointment.bookedEventId = eventObj.id ?? null;
          conv.appointment.bookedEventLink = eventObj.htmlLink ?? null;
          conv.appointment.bookedSalespersonId = exact.salespersonId ?? null;
          stopFollowUpCadence(conv, "appointment_booked");

          if (conv.scheduler) {
            conv.scheduler.lastSuggestedSlots = [];
            conv.scheduler.updatedAt = new Date().toISOString();
          }

          const profile = await getDealerProfile();
          const dealerName = profile?.dealerName ?? "American Harley-Davidson";
          const agentName = profile?.agentName ?? "Brooke";
          const addressLine = profile?.address
            ? `${profile.address.line1 ?? ""}${profile.address.city ? `, ${profile.address.city}` : ""}${
                profile.address.state ? `, ${profile.address.state}` : ""
              }${profile.address.zip ? ` ${profile.address.zip}` : ""}`.replace(/^\s*,\s*/,"").trim()
            : "1149 Erie Ave., North Tonawanda, NY 14120";
          const when = formatSlotLocal(exact.start, cfg.timezone);
          const repName = sp.name ? ` with ${sp.name}` : "";
          const firstNameGreeting = conv.lead?.firstName ?? "";
          const rawModel = conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? "";
          const model = /full line/i.test(rawModel) ? "" : rawModel;
          const greeting = firstNameGreeting
            ? `Hi ${firstNameGreeting} — thanks for booking a test ride${model ? ` on the ${model}` : ""}. `
            : `Thanks for booking a test ride${model ? ` on the ${model}` : ""}. `;
          const intro = `This is ${agentName} at ${dealerName}. `;
          const confirmText =
            `${greeting}${intro}` +
            `Perfect — you’re booked for ${when}${repName}. ` +
            `${dealerName} is at ${addressLine}.`;

          appendOutbound(conv, "dealership", leadKey, confirmText, "draft_ai", eventObj.id ?? undefined);
          return res.status(200).json({
            ok: true,
            parsed: true,
            leadKey,
            lead,
            leadSource,
            bucket: inferredBucket,
            cta: inferredCta,
            channel,
            intent: result.intent,
            stage: result.stage,
            draft: confirmText,
            booked: true
          });
        }
      }
    } catch (e: any) {
      console.log("[exact-book] failed:", e?.message ?? e);
      // fall through to normal draft behavior
    }
  }

  const draft = result.shouldRespond ? result.draft : "Thanks — I’ll follow up shortly.";

  // Store the draft as an outbound message (suggest-only for now)
  appendOutbound(conv, "dealership", leadKey, draft, "draft_ai");
  if (!conv.followUpCadence?.status && !conv.appointment?.bookedEventId) {
    const cfg = await getSchedulerConfig();
    const monthsStart = conv.lead?.purchaseTimeframeMonthsStart;
    if (monthsStart && monthsStart >= 1) {
      const due = new Date();
      due.setMonth(due.getMonth() + monthsStart);
      due.setHours(10, 30, 0, 0);
      const msg = buildLongTermMessage(conv.lead?.purchaseTimeframe, conv.lead?.hasMotoLicense);
      scheduleLongTermFollowUp(conv, due.toISOString(), msg);
    } else {
      startFollowUpCadence(conv, new Date().toISOString(), cfg.timezone);
    }
  }

  return res.status(200).json({
    ok: true,
    parsed: true,
    leadKey,
    lead,
    leadSource,
    bucket: inferredBucket,
    cta: inferredCta,
    channel,
    intent: result.intent,
    stage: result.stage,
    draft
  });
}
