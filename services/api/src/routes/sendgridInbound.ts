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
  getAllConversations,
  getPricingAttempts,
  incrementPricingAttempt,
  addTodo,
  setFollowUpMode,
  pauseFollowUpCadence,
  stopFollowUpCadence,
  markPricingEscalated,
  closeConversation,
  setContactPreference,
  normalizeLeadKey,
  getConversation,
  saveConversation,
  flushConversationStore
} from "../domain/conversationStore.js";
import { orchestrateInbound } from "../domain/orchestrator.js";
import { resolveChannel, resolveLeadRule } from "../domain/leadSourceRules.js";
import type { InboundMessageEvent } from "../domain/types.js";
import { getSchedulerConfig, getPreferredSalespeople } from "../domain/schedulerConfig.js";
import { getAuthedCalendarClient, insertEvent, queryFreeBusy } from "../domain/googleCalendar.js";
import {
  expandBusyBlocks,
  findExactSlotForSalesperson,
  formatSlotLocal,
  generateCandidateSlots,
  localPartsToUtcDate
} from "../domain/schedulerEngine.js";
import { getDealerProfile } from "../domain/dealerProfile.js";
import { getInventoryNote } from "../domain/inventoryNotes.js";
import { hasInventoryForModelYear } from "../domain/inventoryFeed.js";

function base64UrlDecode(input: string): string | null {
  try {
    const padded = input.replace(/-/g, "+").replace(/_/g, "/");
    const padLen = padded.length % 4;
    const withPad = padLen ? padded + "=".repeat(4 - padLen) : padded;
    return Buffer.from(withPad, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function extractLeadKeyFromTaggedEmail(addr?: string | null): string | null {
  if (!addr) return null;
  const email = extractEmailAddress(addr);
  if (!email) return null;
  const m = email.match(/^([^+]+)\+([^@]+)@(.+)$/);
  if (!m) return null;
  const domain = m[3].toLowerCase();
  if (domain !== "inbound.leadrider.ai") return null;
  return base64UrlDecode(m[2]);
}

function maybeTagReplyTo(replyTo: string | undefined, conv: any): string | undefined {
  if (!replyTo) return replyTo;
  if (!/@inbound\.leadrider\.ai$/i.test(replyTo)) return replyTo;
  const id = String(conv?.id ?? conv?.leadKey ?? "").trim();
  if (!id) return replyTo;
  const tag = base64UrlEncode(id);
  const [local, domain] = replyTo.split("@");
  if (!local || !domain) return replyTo;
  return `${local}+${tag}@${domain}`;
}

function inferAppointmentTypeFromConv(conv: any): string | null {
  const bucket = conv?.classification?.bucket ?? "";
  const cta = conv?.classification?.cta ?? "";
  if (bucket === "test_ride" || cta === "schedule_test_ride") return "test_ride";
  if (bucket === "trade_in_sell" || cta === "value_my_trade" || cta === "trade_in_value") return "trade_appraisal";
  if (bucket === "finance_prequal" || /prequal|credit|finance|hdfs/i.test(cta)) return "finance_discussion";
  return "inventory_visit";
}

function buildBookingUrlForLead(baseUrl: string | undefined | null, conv: any): string | null {
  const raw = (baseUrl ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const type = inferAppointmentTypeFromConv(conv);
    const firstName = conv?.lead?.firstName ?? "";
    const lastName = conv?.lead?.lastName ?? "";
    const email = conv?.lead?.email ?? "";
    const phone = conv?.lead?.phone ?? "";
    const leadKey = conv?.leadKey ?? "";
    if (type) url.searchParams.set("type", type);
    if (firstName) url.searchParams.set("firstName", firstName);
    if (lastName) url.searchParams.set("lastName", lastName);
    if (email) url.searchParams.set("email", email);
    if (phone) url.searchParams.set("phone", phone);
    if (leadKey) url.searchParams.set("leadKey", leadKey);
    return url.toString();
  } catch {
    return raw;
  }
}

function formatModelLabel(year?: string | null, model?: string | null): string | null {
  if (!model) return null;
  const clean = String(model).trim();
  if (!clean || /full line|other/i.test(clean)) return null;
  return year ? `${year} ${clean}` : clean;
}

function buildInitialEmailDraft(
  conv: any,
  dealerProfile: any,
  inventoryNote?: string | null,
  buildInventoryAvailable?: boolean | null
): string {
  const rawName = conv?.lead?.firstName?.trim() || conv?.lead?.name?.trim() || "there";
  const name = rawName.split(" ")[0] || "there";
  const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
  const agentName = dealerProfile?.agentName ?? "our team";
  const bookingUrl = buildBookingUrlForLead(dealerProfile?.bookingUrl, conv);
  const model = formatModelLabel(conv?.lead?.vehicle?.year ?? conv?.lead?.year, conv?.lead?.vehicle?.model ?? conv?.lead?.vehicle?.description);
  const leadSourceLower = (conv?.lead?.source ?? conv?.leadSource ?? "").toLowerCase();
  const isCustomBuild = /custom build/.test(leadSourceLower);
  const isTestRide =
    conv?.classification?.bucket === "test_ride" || conv?.classification?.cta === "schedule_test_ride";
  const thanks = isTestRide
    ? model
      ? `Thanks for your interest in a test ride on the ${model}.`
      : "Thanks for your interest in a test ride."
    : isCustomBuild
      ? model
        ? `Thanks for building your ${model} online.`
        : "Thanks for your custom build request."
      : model
        ? `Thanks for your interest in the ${model}.`
        : "Thanks for your interest.";
  const intro = `This is ${agentName} at ${dealerName}.`;
  const help = "I’m happy to help with pricing, options, and availability.";
  const noteLine = inventoryNote ? `Right now there’s ${inventoryNote} available.` : "";
  const buildLine = isCustomBuild
    ? buildInventoryAvailable
      ? "We do have one in stock if you’d like to check it out. I can also walk you through build options and next steps."
      : "I can walk you through build options and next steps."
    : "";
  const visit = isCustomBuild
    ? buildInventoryAvailable
      ? "If you want to stop in to check it out and go over build options, you can book an appointment below."
      : "If you want to stop in to go over build options, you can book an appointment below."
    : model
      ? "If you want to stop in to check out the bike and go over options, you can book an appointment below."
      : "If you want to stop in to go over options, you can book an appointment below.";
  const bookingLine = bookingUrl
    ? `You can book an appointment here: ${bookingUrl}`
    : "Just reply with a day and time that works for you.";
  const extra = "If a walkaround or extra photos would help, just let me know.";

  return `Hi ${name},\n\n${thanks} ${intro} ${help} ${noteLine} ${buildLine} ${visit}\n\n${bookingLine}\n\n${extra}`.replace(/\s+\n/g, "\n").trim();
}
import { getSystemMode } from "../domain/settingsStore.js";
import { sendEmail } from "../domain/emailSender.js";
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

function extractEmailAddress(input?: string): string | undefined {
  if (!input) return undefined;
  const m = String(input)
    .trim()
    .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m?.[0]?.toLowerCase();
}

function stripHtml(input?: string): string | undefined {
  if (!input) return undefined;
  const withBreaks = input.replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n");
  const stripped = withBreaks.replace(/<[^>]+>/g, " ").replace(/\s+\n/g, "\n");
  const cleaned = stripped.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned || undefined;
}

function isCallOnlyText(input?: string | null): boolean {
  if (!input) return false;
  return /\b(call only|phone only|call me only|no text|do not text|don't text|text me not)\b/i.test(
    input
  );
}

function getLeadIdentifiers(conv: any, fromEmail?: string) {
  const email =
    (conv?.lead?.email ?? fromEmail ?? (conv?.leadKey?.includes?.("@") ? conv.leadKey : ""))
      ?.toString()
      .trim()
      .toLowerCase() || undefined;
  const phoneRaw =
    conv?.lead?.phone ?? (!conv?.leadKey?.includes?.("@") ? conv?.leadKey : undefined);
  const phone = phoneRaw ? normalizeLeadKey(String(phoneRaw)) : undefined;
  return { email, phone };
}

function pauseRelatedCadencesOnInbound(conv: any, fromEmail?: string) {
  const { email, phone } = getLeadIdentifiers(conv, fromEmail);
  if (!email && !phone) return;
  const pauseUntil = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  for (const other of getAllConversations()) {
    if (!other || other.id === conv.id) continue;
    const ids = getLeadIdentifiers(other);
    const emailMatch = email && ids.email && ids.email === email;
    const phoneMatch = phone && ids.phone && ids.phone === phone;
    if (!emailMatch && !phoneMatch) continue;
    pauseFollowUpCadence(other, pauseUntil, "cross_channel_inbound");
  }
  pauseFollowUpCadence(conv, pauseUntil, "inbound_email");
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

function normalizeVehicleCondition(raw?: string | null): "new" | "used" | undefined {
  if (!raw) return undefined;
  const t = String(raw).toLowerCase();
  if (t.includes("used") || t.includes("pre-owned") || t.includes("preowned")) return "used";
  if (t.includes("new")) return "new";
  return undefined;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeVehicleModel(raw?: string | null, make?: string | null): string | undefined {
  let model = raw ? String(raw).trim() : "";
  if (!model) return undefined;
  const makeClean = make ? String(make).trim() : "";
  if (makeClean) {
    const re = new RegExp(`^${escapeRegExp(makeClean)}\\s+`, "i");
    model = model.replace(re, "").trim();
  }
  model = model.replace(/\bharley[-\s]?davidson\b/gi, "").replace(/\bh[-\s]?d\b/gi, "").trim();
  model = model.replace(/^[\s\-–—:,]+|[\s\-–—:,]+$/g, "").trim();
  return model || undefined;
}

function parseTimeframeMonths(raw?: string): { start?: number; end?: number } | null {
  if (!raw) return null;
  const t = raw.toLowerCase();
  if (/unsure|not sure|unknown/.test(t)) return null;
  if (/over\s*\d+\s*year/.test(t) || /over\s*a\s*year/.test(t) || /over\s*one\s*year/.test(t)) {
    return { start: 12 };
  }
  if (/\byear\b/.test(t)) {
    const years = t.match(/(\d+)\s*year/);
    if (years) {
      const y = Number(years[1]);
      if (!Number.isNaN(y)) return { start: y * 12 };
    }
    return { start: 12 };
  }
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
    return `Hi, this is Brooke at American Harley-Davidson. You mentioned a ${tf} timeline. I’m happy to help when you’re ready. Want me to set a reminder for you?`;
  }
  return `Hi, this is Brooke at American Harley-Davidson. You mentioned a ${tf} timeline. I’m happy to help when you’re ready. Want me to set a reminder for you?`;
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
    const envelopeRaw = req.body?.envelope;
    let envelope: any = null;
    if (typeof envelopeRaw === "string") {
      try {
        envelope = JSON.parse(envelopeRaw);
      } catch {
        envelope = null;
      }
    }
    const fromEmail =
      extractEmailAddress(req.body?.from) ?? extractEmailAddress(envelope?.from) ?? undefined;
    const toEmail =
      extractEmailAddress(req.body?.to) ??
      (Array.isArray(envelope?.to) ? extractEmailAddress(envelope?.to[0]) : undefined) ??
      extractEmailAddress(envelope?.to) ??
      "dealership";
    const taggedLeadKey =
      extractLeadKeyFromTaggedEmail(req.body?.to) ??
      (Array.isArray(envelope?.to)
        ? extractLeadKeyFromTaggedEmail(envelope?.to[0])
        : extractLeadKeyFromTaggedEmail(envelope?.to));
    const subject = typeof req.body?.subject === "string" ? req.body.subject.trim() : "";
    const plain = textBody?.trim();
    const htmlText = stripHtml(htmlBody) ?? stripHtml(emailBody);
    const bodyText = plain || htmlText || "";
    const body = [subject ? `Subject: ${subject}` : null, bodyText]
      .filter(Boolean)
      .join("\n\n")
      .trim();

    if (!fromEmail) {
      console.warn("[sendgrid inbound] No ADF found and no from email", {
        subject: req.body?.subject,
        from: req.body?.from
      });
      return res.status(200).json({ ok: true, parsed: false, reason: "no_adf_found" });
    }

    const existingByTag = taggedLeadKey ? getConversation(taggedLeadKey) : null;
    const existingConv =
      existingByTag ??
      getAllConversations().find(c => {
        const email =
          (c?.lead?.email ?? (c?.leadKey?.includes?.("@") ? c.leadKey : ""))?.toString().toLowerCase();
        return !!email && email === fromEmail;
      });
    const leadKey = existingConv?.leadKey ?? taggedLeadKey ?? fromEmail;
    const conv = existingConv ?? upsertConversationByLeadKey(leadKey, "suggest");
    mergeConversationLead(conv, {
      email: fromEmail
    });
    if (!conv.classification?.channel) {
      setConversationClassification(conv, {
        bucket: conv.classification?.bucket ?? "general_inquiry",
        cta: conv.classification?.cta ?? "unknown",
        channel: "email",
        ruleName: conv.classification?.ruleName ?? "email_reply"
      });
    }

    upsertContact({
      leadKey: conv.leadKey,
      conversationId: conv.id,
      email: fromEmail
    });

    const event: InboundMessageEvent = {
      channel: "email",
      provider: "sendgrid",
      from: fromEmail,
      to: toEmail || "dealership",
      body: body || "(no content)",
      providerMessageId: String(req.body?.MessageID ?? req.body?.message_id ?? ""),
      receivedAt: new Date().toISOString()
    };

    appendInbound(conv, event);
    discardPendingDrafts(conv, "new_inbound");
    confirmAppointmentIfMatchesSuggested(conv, event.body, event.providerMessageId);
    updateHoldingFromInbound(conv, event.body);
    pauseRelatedCadencesOnInbound(conv, fromEmail);

    if (conv.contactPreference === "call_only" || isCallOnlyText(body)) {
      setContactPreference(conv, "call_only");
      addTodo(conv, "other", event.body ?? "Call only requested", event.providerMessageId);
      setFollowUpMode(conv, "manual_handoff", "call_only");
      stopFollowUpCadence(conv, "manual_handoff");
      return res.status(200).json({
        ok: true,
        parsed: true,
        leadKey,
        lead: conv.lead,
        channel: "email",
        note: "call_only_no_email_draft"
      });
    }

    const history = conv.messages.slice(-20).map(m => ({ direction: m.direction, body: m.body }));
    const allowSchedulingOffer =
      /(appointment|appt|schedule|book|reserve|come in|stop in|stop by|visit|test ride|demo ride|\b\d{1,2}(:\d{2})?\s*(am|pm)\b)/i.test(
        event.body ?? ""
      );
    const result = await orchestrateInbound(event, history, {
      appointment: conv.appointment,
      followUp: conv.followUp,
      lead: conv.lead,
      leadSource: conv.lead?.source ?? null,
      bucket: conv.classification?.bucket ?? null,
      cta: conv.classification?.cta ?? null,
      pricingAttempts: getPricingAttempts(conv),
      allowSchedulingOffer
    });

    if (result.handoff?.required) {
      addTodo(conv, result.handoff.reason, event.body, event.providerMessageId);
      setFollowUpMode(conv, "manual_handoff", `handoff:${result.handoff.reason}`);
      stopFollowUpCadence(conv, "manual_handoff");
      if (result.handoff.reason === "pricing" || result.handoff.reason === "payments") {
        markPricingEscalated(conv);
      }
      conv.emailDraft = result.handoff.ack;
    } else if (result.autoClose?.reason) {
      closeConversation(conv, result.autoClose.reason);
      conv.emailDraft = result.draft;
    } else {
      conv.emailDraft = result.draft;
    }

    saveConversation(conv);
    await flushConversationStore();

    return res.status(200).json({ ok: true, parsed: true, type: "email_reply", draft: conv.emailDraft });
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
  const make = lead.vehicleMake ?? undefined;
  const model = normalizeVehicleModel(
    lead.vehicleModel ?? meta.model ?? lead.vehicleDescription ?? undefined,
    make ?? null
  );

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
      make,
      model,
      trim: lead.vehicleTrim,
      color: lead.vehicleColor,
      condition: lead.vehicleCondition,
      description: lead.vehicleDescription,
      mileage: lead.mileage
    },
    tradeVehicle: lead.tradeVehicle
  });
  const stockId = lead.stockId?.trim() || undefined;
  conv.lead = conv.lead ?? {};
  conv.lead.vehicle = conv.lead.vehicle ?? {};
  if (stockId) conv.lead.vehicle.stockId = stockId;
  const parsedCondition = normalizeVehicleCondition(lead.vehicleCondition);
  if (parsedCondition) {
    conv.lead.vehicle.condition = parsedCondition;
  } else if (stockId) {
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
    vehicle: model ?? meta.model,
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
  const forcedTradeIn =
    leadSourceLower.includes("trade accelerator") ||
    /\btrade[-\s]?in\b/.test(leadSourceLower);
  if (forcedTradeIn) {
    inferredBucket = "trade_in_sell";
    inferredCta = "value_my_trade";
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
      lead.tradeVehicle?.description || lead.tradeVehicle?.year
        ? `Trade-In: ${[lead.tradeVehicle?.year, lead.tradeVehicle?.description ?? lead.tradeVehicle?.model]
            .filter(Boolean)
            .join(" ")}`
        : null,
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

  const callOnlyRequested = isCallOnlyText(inquiryText);

  let creditTodoCreated = false;
  const isCreditLead =
    inferredBucket === "finance_prequal" ||
    inferredCta === "hdfs_coa" ||
    inferredCta === "prequalify" ||
    /coa|credit application|apply for credit|finance application|prequal/i.test(leadSourceLower);
  if (isCreditLead) {
    addTodo(conv, "approval", event.body ?? "Credit application", event.providerMessageId);
    creditTodoCreated = true;
    setFollowUpMode(conv, "manual_handoff", "credit_app");
    stopFollowUpCadence(conv, "manual_handoff");
  }

  appendInbound(conv, event);
  discardPendingDrafts(conv, "new_inbound");
  confirmAppointmentIfMatchesSuggested(conv, event.body, event.providerMessageId);
  updateHoldingFromInbound(conv, event.body);

  if (callOnlyRequested) {
    setContactPreference(conv, "call_only");
    addTodo(conv, "other", event.body ?? "Call only requested", event.providerMessageId);
    setFollowUpMode(conv, "manual_handoff", "call_only");
    stopFollowUpCadence(conv, "manual_handoff");
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
      note: "call_only_no_text"
    });
  }

  const isInitialAdf =
    event.provider === "sendgrid_adf" &&
    !(conv.messages ?? []).some((m: any) => m.direction === "out");
  const applyInitialAdfPrefix = async (text: string) => {
    if (!isInitialAdf) return text;
    const profile = await getDealerProfile();
    const dealerName = profile?.dealerName ?? "American Harley-Davidson";
    const agentName = profile?.agentName ?? "Brooke";
    const firstName = conv.lead?.firstName?.trim() || "";
    const greeting = firstName ? `Hi ${firstName} — ` : "Hi — ";
    const prefix = `${greeting}Thanks for your inquiry. This is ${agentName} at ${dealerName}. `;
    const prefixLower = prefix.toLowerCase();
    let body = String(text ?? "").trim();
    if (body.toLowerCase().startsWith(prefixLower)) return body;
    body = body.replace(/^hi\s+[^—]+—\s*/i, "");
    body = body.replace(/^thanks for[^.]*\.\s*/i, "");
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const agentEsc = esc(agentName);
    const dealerEsc = esc(dealerName);
    body = body.replace(new RegExp(`\\bthis is\\s+${agentEsc}\\s+at\\s+${dealerEsc}\\.?\\s*`, "ig"), "");
    return `${prefix}${body}`.trim();
  };

  const isUsed =
    conv.lead?.vehicle?.condition === "used" ||
    (!!conv.lead?.vehicle?.stockId && /^u/i.test(conv.lead?.vehicle?.stockId ?? "")) ||
    /\bU[A-Z0-9]{0,4}-\d{1,4}\b/i.test(event.body);
  const isPendingComplaint = /sale pending|still pending|been pending|pending for|pending too long|what is going on/i.test(
    event.body
  );
  if (isUsed && isPendingComplaint) {
    let ack =
      "Thanks for the heads-up. I’ll have someone check the sale‑pending status and follow up soon.";
    ack = await applyInitialAdfPrefix(ack);
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

  const isRoom58Standard =
    leadSourceLower.includes("room58 - standard") || rule.ruleName === "room58_standard";
  if (isRoom58Standard) {
    const profile = await getDealerProfile();
    const dealerName = profile?.dealerName ?? "American Harley-Davidson";
    const agentName = profile?.agentName ?? "Brooke";
    const firstName = conv.lead?.firstName ?? "";
    const greeting = firstName ? `Hi ${firstName} — ` : "Hi — ";
    let ack = `${greeting}thanks for reaching out. This is ${agentName} at ${dealerName}. We got your inquiry and someone will follow up soon.`;
    ack = await applyInitialAdfPrefix(ack);

    addTodo(conv, "other", event.body, event.providerMessageId);
    setFollowUpMode(conv, "manual_handoff", "room58_standard");
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

  const metaOfferRawModel = conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? "";
  const isMetaPromoOffer = /meta promo offer/i.test(leadSourceLower);
  if (isMetaPromoOffer && /^(other|full line)$/i.test(metaOfferRawModel.trim())) {
    const profile = await getDealerProfile();
    const dealerName = profile?.dealerName ?? "American Harley-Davidson";
    const agentName = profile?.agentName ?? "Brooke";
    const firstName = conv.lead?.firstName ?? "";
    const greeting = firstName ? `Hi ${firstName} — ` : "Hi — ";
    let ack =
      `${greeting}thanks for your H‑D Meta promo offer request. ` +
      `This is ${agentName} at ${dealerName}. ` +
      `I’d love to help with pricing. Which model are you interested in (and any trim or color)?`;
    ack = await applyInitialAdfPrefix(ack);

    appendOutbound(conv, "dealership", leadKey, ack, "draft_ai");
    conv.emailDraft = ack;
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
    pricingAttempts: getPricingAttempts(conv),
    allowSchedulingOffer: true
  });
  console.log("[sendgrid inbound] requestedTime", result.requestedTime);

  if (result.handoff?.required) {
    const reason = result.handoff.reason;
    const ack = await applyInitialAdfPrefix(result.handoff.ack);
    if (!creditTodoCreated) {
      addTodo(conv, reason, event.body, event.providerMessageId);
    }
    setFollowUpMode(conv, "manual_handoff", `handoff:${reason}`);
    stopFollowUpCadence(conv, "manual_handoff");
    if (reason === "pricing" || reason === "payments") {
      markPricingEscalated(conv);
    }
    appendOutbound(conv, "dealership", leadKey, ack, "draft_ai");
    conv.emailDraft = ack;
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
      draft: ack,
      handoff: { ...result.handoff, ack }
    });
  }

  if (result.autoClose?.reason) {
    const ack = await applyInitialAdfPrefix(result.draft);
    closeConversation(conv, result.autoClose.reason);
    appendOutbound(conv, "dealership", leadKey, ack, "draft_ai");
    conv.emailDraft = ack;
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
      draft: ack,
      autoClose: result.autoClose
    });
  }

  if (result.pricingAttempted) {
    incrementPricingAttempt(conv);
  }

  if (isInitialAdf) {
    const profile = await getDealerProfile();
    const stockForNote = conv.lead?.vehicle?.stockId ?? null;
    const vinForNote = conv.lead?.vehicle?.vin ?? null;
    const inventoryNote = await getInventoryNote(stockForNote, vinForNote);
    const leadSourceLower = (conv.lead?.source ?? "").toLowerCase();
    let buildInventoryAvailable: boolean | null = null;
    if (leadSourceLower.includes("custom build")) {
      const modelForBuild = conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? null;
      const yearForBuild = conv.lead?.vehicle?.year ?? null;
      if (modelForBuild && !/full line|other/i.test(modelForBuild)) {
        buildInventoryAvailable = await hasInventoryForModelYear({
          model: modelForBuild,
          year: yearForBuild,
          yearDelta: 1
        });
      } else {
        buildInventoryAvailable = false;
      }
    }
    conv.emailDraft = buildInitialEmailDraft(conv, profile, inventoryNote, buildInventoryAvailable);
  } else {
    conv.emailDraft = result.draft;
  }

  if (result.requestedTime && !conv.appointment?.bookedEventId) {
    try {
      const cfg = await getSchedulerConfig();
      console.log("[sendgrid inbound] scheduler cfg", {
        salespeople: (cfg.salespeople ?? []).length,
        preferred: (cfg.preferredSalespeople ?? []).length,
        timezone: cfg.timezone,
        appointmentTypes: Object.keys(cfg.appointmentTypes ?? {})
      });
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

        let exact = findExactSlotForSalesperson(
          cfg,
          sp.id,
          sp.calendarId,
          result.requestedTime,
          durationMinutes,
          expanded
        );
        if (!exact) {
          const requested = result.requestedTime!;
          const requestedStartUtc = localPartsToUtcDate(cfg.timezone, requested);
          const candidatesByDay = generateCandidateSlots(cfg, now, durationMinutes, 14);
          const matchesSameDay = (d: Date) => {
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
              Number(map.year) === requested.year &&
              Number(map.month) === requested.month &&
              Number(map.day) === requested.day
            );
          };
          const candidate = candidatesByDay
            .flatMap(d => d.candidates)
            .find(c => matchesSameDay(c.start) && c.start.getTime() === requestedStartUtc.getTime());
          if (candidate) {
            const blocked = expanded.some(b => candidate.start < b.end && b.start < candidate.end);
            if (!blocked) {
              exact = {
                salespersonId: sp.id,
                calendarId: sp.calendarId,
                start: candidate.start.toISOString(),
                end: candidate.end.toISOString()
              };
            }
          }
        }
        if (!exact) {
          console.log("[sendgrid inbound] exact slot not found", {
            salespersonId: sp.id,
            calendarId: sp.calendarId,
            requestedTime: result.requestedTime
          });
        }

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
            `You’re booked for ${when}${repName}. ` +
            `${dealerName} is at ${addressLine}.`;

          appendOutbound(conv, "dealership", leadKey, confirmText, "draft_ai", eventObj.id ?? undefined);
          saveConversation(conv);
          await flushConversationStore();
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

  let draft = result.shouldRespond ? result.draft : "Thanks — I’ll follow up shortly.";
  if (
    inferredBucket === "test_ride" &&
    typeof draft === "string" &&
    /^Hi [^—]+— /i.test(draft)
  ) {
    const m = draft.match(/^Hi ([^—]+)—\s*([^.]*)\.\s*(.*)$/i);
    if (m) {
      const name = m[1];
      const rest = m[3] ?? "";
      draft = `Hi ${name} — thanks for your interest in a test ride. ${rest}`.trim();
    }
  }
  const rawModel = conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? "";
  if (/full line/i.test(rawModel) && typeof draft === "string") {
    draft = draft
      .replace(/\s+in the\s+\d{4}\s+harley-davidson\s+full line\b/gi, "")
      .replace(/\s+for the\s+\d{4}\s+harley-davidson\s+full line\b/gi, "")
      .replace(/\s+on the\s+\d{4}\s+harley-davidson\s+full line\b/gi, "");
  }
  if (
    result.requestedTime &&
    typeof draft === "string" &&
    /I have .*— which works best\?/i.test(draft) &&
    !/already taken|booked up|closed/i.test(draft)
  ) {
    const introMatch = draft.match(/^(.*?\bThis is [^.]+\. )(.+)$/i);
    if (introMatch) {
      const head = introMatch[1];
      const tail = introMatch[2];
      draft = `${head}That time is already taken, but ${tail.charAt(0).toLowerCase()}${tail.slice(1)}`;
    } else if (draft.startsWith("Hi ")) {
      const marker = ". ";
      const idx = draft.indexOf(marker);
      if (idx > -1) {
        const head = draft.slice(0, idx + marker.length);
        const tail = draft.slice(idx + marker.length);
        draft = `${head}That time is already taken, but ${tail.charAt(0).toLowerCase()}${tail.slice(1)}`;
      } else {
        draft = `That time is already taken, but ${draft.charAt(0).toLowerCase()}${draft.slice(1)}`;
      }
    } else {
      draft = `That time is already taken, but ${draft.charAt(0).toLowerCase()}${draft.slice(1)}`;
    }
  }

  draft = await applyInitialAdfPrefix(draft);

  const systemMode = getSystemMode();
  const emailTo = lead.email?.trim();
  const useEmail = channel === "email" && !!emailTo && lead.emailOptIn === true;
  const dealerProfile = await getDealerProfile();

  if (systemMode !== "suggest" && useEmail) {
    const dealerName = dealerProfile?.dealerName ?? "Dealership";
    const { from: emailFrom, replyTo: emailReplyTo, signature } = {
      from: (dealerProfile?.fromEmail ?? process.env.SENDGRID_FROM_EMAIL ?? "").trim(),
      replyTo: (dealerProfile?.replyToEmail ?? process.env.SENDGRID_REPLY_TO ?? "").trim(),
      signature: String(dealerProfile?.emailSignature ?? "").trim() || undefined
    };
    const replyTo = maybeTagReplyTo(emailReplyTo || undefined, conv);
    if (emailFrom) {
      try {
        const subject = `Thanks for your inquiry at ${dealerName}`;
        const signed =
          signature
            ? `${draft}\n\n${signature}${dealerProfile?.logoUrl ? `\n\n${dealerProfile.logoUrl}` : ""}`
            : draft;
        await sendEmail({
          to: emailTo!,
          subject,
          text: signed,
          from: emailFrom,
          replyTo
        });
        appendOutbound(conv, emailFrom, emailTo!, signed, "sendgrid");
        saveConversation(conv);
        await flushConversationStore();
      } catch (e: any) {
        console.log("[sendgrid inbound] email send failed:", e?.message ?? e);
        appendOutbound(conv, "dealership", leadKey, draft, "draft_ai");
      }
    } else {
      appendOutbound(conv, "dealership", leadKey, draft, "draft_ai");
    }
  } else {
    // Store the draft as an outbound message (suggest-only for now)
    appendOutbound(conv, "dealership", leadKey, draft, "draft_ai");
  }
  if (conv.classification?.bucket === "event_promo") {
    closeConversation(conv, "event_promo_no_cadence");
    stopFollowUpCadence(conv, "manual_handoff");
  }
  const shouldStartCadence =
    !conv.followUpCadence?.status &&
    !conv.appointment?.bookedEventId &&
    conv.classification?.bucket !== "finance_prequal" &&
    conv.classification?.bucket !== "event_promo" &&
    conv.classification?.cta !== "hdfs_coa" &&
    conv.classification?.cta !== "prequalify";
  if (shouldStartCadence) {
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
