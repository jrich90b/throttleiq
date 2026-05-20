import { google } from "googleapis";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { dataPath } from "./dataDir.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Store tokens locally for now (later: DB per account)
const TOKEN_PATH = path.resolve(__dirname, "../../data/google_tokens.json");
const SUPPORT_MAIL_TOKEN_PATH = process.env.GOOGLE_SUPPORT_MAIL_TOKEN_PATH || dataPath("google_support_mail_tokens.json");
const PERSONAL_MAIL_TOKEN_PATH = process.env.GOOGLE_PERSONAL_MAIL_TOKEN_PATH || dataPath("google_personal_mail_tokens.json");

export function getOAuthClient(redirectUriOverride?: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  const redirectUri = redirectUriOverride || process.env.GOOGLE_REDIRECT_URI!;

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export async function loadTokens() {
  try {
    const raw = await fs.readFile(TOKEN_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveTokens(tokens: any) {
  await fs.mkdir(path.dirname(TOKEN_PATH), { recursive: true });
  await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf8");
}

export async function loadSupportMailTokens() {
  try {
    const raw = await fs.readFile(SUPPORT_MAIL_TOKEN_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveSupportMailTokens(tokens: any) {
  await fs.mkdir(path.dirname(SUPPORT_MAIL_TOKEN_PATH), { recursive: true });
  await fs.writeFile(SUPPORT_MAIL_TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf8");
}

export async function loadPersonalMailTokens() {
  try {
    const raw = await fs.readFile(PERSONAL_MAIL_TOKEN_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function savePersonalMailTokens(tokens: any) {
  await fs.mkdir(path.dirname(PERSONAL_MAIL_TOKEN_PATH), { recursive: true });
  await fs.writeFile(PERSONAL_MAIL_TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf8");
}

async function getAuthedGmailClient(tokens: any, notConnectedMessage: string) {
  const oauth2 = getOAuthClient();
  if (!tokens) throw new Error(notConnectedMessage);

  oauth2.setCredentials(tokens);
  return google.gmail({ version: "v1", auth: oauth2 });
}

export async function getAuthedSupportGmailClient() {
  return getAuthedGmailClient(
    await loadSupportMailTokens(),
    "Support Gmail not connected. Visit /integrations/google/start?kind=support_mail"
  );
}

export async function getAuthedPersonalGmailClient() {
  return getAuthedGmailClient(
    await loadPersonalMailTokens(),
    "Personal Gmail not connected. Visit /integrations/google/start?kind=personal_mail"
  );
}

function decodeBase64Url(value?: string | null) {
  if (!value) return "";
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function findHeader(headers: Array<{ name?: string | null; value?: string | null }> | undefined, name: string) {
  return headers?.find(header => String(header.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? "";
}

function extractPlainText(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodeBase64Url(payload.body.data);
  for (const part of payload.parts ?? []) {
    const nested = extractPlainText(part);
    if (nested) return nested;
  }
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  return "";
}

export async function getSupportGmailProfile() {
  const gmail = await getAuthedSupportGmailClient();
  const resp = await gmail.users.getProfile({ userId: "me" });
  return resp.data;
}

export async function getPersonalGmailProfile() {
  const gmail = await getAuthedPersonalGmailClient();
  const resp = await gmail.users.getProfile({ userId: "me" });
  return resp.data;
}

async function listInboxMessages(gmail: any, limit = 10) {
  const list = await gmail.users.messages.list({
    userId: "me",
    labelIds: ["INBOX"],
    q: "newer_than:30d",
    maxResults: Math.max(1, Math.min(25, Math.floor(limit)))
  });
  const messages = await Promise.all(
    (list.data.messages ?? []).map(async (message: any) => {
      const full = await gmail.users.messages.get({
        userId: "me",
        id: message.id!,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"]
      });
      const headers = full.data.payload?.headers ?? [];
      return {
        id: full.data.id,
        threadId: full.data.threadId,
        from: findHeader(headers, "From"),
        subject: findHeader(headers, "Subject") || "(no subject)",
        date: findHeader(headers, "Date"),
        snippet: full.data.snippet ?? "",
        labelIds: full.data.labelIds ?? []
      };
    })
  );
  return messages;
}

export async function listSupportInboxMessages(limit = 10) {
  return listInboxMessages(await getAuthedSupportGmailClient(), limit);
}

export async function listPersonalInboxMessages(limit = 10) {
  return listInboxMessages(await getAuthedPersonalGmailClient(), limit);
}

export async function createSupportGmailDraftReply(messageId: string, bodyText: string) {
  const gmail = await getAuthedSupportGmailClient();
  const original = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const headers = original.data.payload?.headers ?? [];
  const to = findHeader(headers, "Reply-To") || findHeader(headers, "From");
  const originalSubject = findHeader(headers, "Subject") || "LeadRider support";
  const subject = /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`;
  const messageIdHeader = findHeader(headers, "Message-ID");
  const references = findHeader(headers, "References") || messageIdHeader;
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    messageIdHeader ? `In-Reply-To: ${messageIdHeader}` : "",
    references ? `References: ${references}` : "",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    bodyText
  ].filter(line => line !== "");
  const raw = Buffer.from(lines.join("\r\n")).toString("base64url");
  const draft = await gmail.users.drafts.create({
    userId: "me",
    requestBody: {
      message: {
        threadId: original.data.threadId ?? undefined,
        raw
      }
    }
  });
  return draft.data;
}

export async function trashSupportGmailMessage(messageId: string) {
  const gmail = await getAuthedSupportGmailClient();
  const resp = await gmail.users.messages.trash({
    userId: "me",
    id: messageId
  });
  return resp.data;
}

export async function trashPersonalGmailMessage(messageId: string) {
  const gmail = await getAuthedPersonalGmailClient();
  const resp = await gmail.users.messages.trash({
    userId: "me",
    id: messageId
  });
  return resp.data;
}

export async function getAuthedCalendarClient() {
  const oauth2 = getOAuthClient();
  const tokens = await loadTokens();
  if (!tokens) throw new Error("Google not connected. Visit /integrations/google/start");

  oauth2.setCredentials(tokens);
  return google.calendar({ version: "v3", auth: oauth2 });
}

/**
 * Free/busy query: POST https://www.googleapis.com/calendar/v3/freeBusy :contentReference[oaicite:4]{index=4}
 */
export async function queryFreeBusy(calendar: any, calendarIds: string[], timeMinIso: string, timeMaxIso: string, timeZone: string) {
  console.log("[gcal] freebusy.query", { calendarId: calendarIds?.[0], timeMin: timeMinIso, timeMax: timeMaxIso });
  const resp = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
      timeZone,
      items: calendarIds.map(id => ({ id }))
    }
  });
  console.log("[gcal] freebusy.ok", {
    calendarId: calendarIds?.[0],
    calendars: Object.keys(resp.data.calendars ?? {}).length
  });
  return resp.data;
}

/**
 * Create event: events.insert with start/end dateTime :contentReference[oaicite:5]{index=5}
 */
export async function insertEvent(
  calendar: any,
  calendarId: string,
  timeZone: string,
  summary: string,
  description: string,
  startIso: string,
  endIso: string,
  colorId?: string
) {
  console.log("[gcal] insertEvent.request", { calendarId, summary, startIso, endIso, timeZone });
  try {
    const resp = await calendar.events.insert({
      calendarId,
      requestBody: {
        summary,
        description,
        ...(colorId ? { colorId } : {}),
        start: { dateTime: startIso, timeZone },
        end: { dateTime: endIso, timeZone }
      }
    });
    console.log("[gcal] insertEvent.ok", { calendarId, eventId: resp.data?.id });
    return resp.data; // includes id, htmlLink, etc.
  } catch (e: any) {
    console.error("[gcal] insertEvent.failed", e?.message ?? e);
    throw e;
  }
}

export async function updateEvent(calendar: any, calendarId: string, eventId: string, timeZone: string, startIso: string, endIso: string) {
  const resp = await calendar.events.patch({
    calendarId,
    eventId,
    requestBody: {
      start: { dateTime: startIso, timeZone },
      end: { dateTime: endIso, timeZone }
    }
  });
  return resp.data;
}

export async function updateEventDetails(
  calendar: any,
  calendarId: string,
  eventId: string,
  timeZone: string,
  params: {
    startIso?: string;
    endIso?: string;
    summary?: string;
    description?: string;
    status?: string;
    colorId?: string;
  }
) {
  const requestBody: any = {};
  if (params.summary != null) requestBody.summary = params.summary;
  if (params.description != null) requestBody.description = params.description;
  if (params.status != null) requestBody.status = params.status;
  if (params.colorId != null) requestBody.colorId = params.colorId || null;
  if (params.startIso) requestBody.start = { dateTime: params.startIso, timeZone };
  if (params.endIso) requestBody.end = { dateTime: params.endIso, timeZone };
  const resp = await calendar.events.patch({
    calendarId,
    eventId,
    requestBody
  });
  return resp.data;
}

export async function moveEvent(
  calendar: any,
  sourceCalendarId: string,
  eventId: string,
  destinationCalendarId: string
) {
  const resp = await calendar.events.move({
    calendarId: sourceCalendarId,
    eventId,
    destination: destinationCalendarId
  });
  return resp.data;
}

export async function listEvents(
  calendar: any,
  calendarId: string,
  timeMinIso: string,
  timeMaxIso: string,
  timeZone: string
) {
  const resp = await calendar.events.list({
    calendarId,
    timeMin: timeMinIso,
    timeMax: timeMaxIso,
    singleEvents: true,
    orderBy: "startTime",
    timeZone
  });
  return resp.data.items ?? [];
}

export async function createCalendar(calendar: any, summary: string, timeZone: string) {
  const resp = await calendar.calendars.insert({
    requestBody: {
      summary,
      timeZone
    }
  });
  return resp.data;
}

export async function createRecurringBlock(
  calendar: any,
  calendarId: string,
  timeZone: string,
  summary: string,
  startTime: { hour: number; minute: number },
  endTime: { hour: number; minute: number },
  rrule: string
) {
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const baseDate = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const startIso = `${baseDate}T${pad(startTime.hour)}:${pad(startTime.minute)}:00`;
  const endIso = `${baseDate}T${pad(endTime.hour)}:${pad(endTime.minute)}:00`;
  const resp = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary,
      start: { dateTime: startIso, timeZone },
      end: { dateTime: endIso, timeZone },
      recurrence: [rrule]
    }
  });
  return resp.data;
}

export async function deleteEvent(calendar: any, calendarId: string, eventId: string) {
  await calendar.events.delete({ calendarId, eventId });
}
