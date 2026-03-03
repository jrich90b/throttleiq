import { google } from "googleapis";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Store tokens locally for now (later: DB per account)
const TOKEN_PATH = path.resolve(__dirname, "../../data/google_tokens.json");

export function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI!;

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
  const resp = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
      timeZone,
      items: calendarIds.map(id => ({ id }))
    }
  });
  return resp.data;
}

/**
 * Create event: events.insert with start/end dateTime :contentReference[oaicite:5]{index=5}
 */
export async function insertEvent(calendar: any, calendarId: string, timeZone: string, summary: string, description: string, startIso: string, endIso: string) {
  const resp = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary,
      description,
      start: { dateTime: startIso, timeZone },
      end: { dateTime: endIso, timeZone }
    }
  });
  return resp.data; // includes id, htmlLink, etc.
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
  }
) {
  const requestBody: any = {};
  if (params.summary != null) requestBody.summary = params.summary;
  if (params.description != null) requestBody.description = params.description;
  if (params.status != null) requestBody.status = params.status;
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
