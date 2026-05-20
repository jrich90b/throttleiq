import { promises as fs } from "node:fs";
import * as path from "node:path";
import crypto from "node:crypto";
import { dataPath } from "./dataDir.js";
import type { SalesProspect } from "./salesProspectStore.js";

export type ZoomTokenRecord = {
  connectedAt: string;
  updatedAt: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  apiBase: string;
  scope?: string;
};

export type ZoomStatus = {
  configured: boolean;
  connected: boolean;
  connectedAt?: string;
  updatedAt?: string;
  apiBase?: string;
  redirectUri?: string;
  scopes?: string;
  missing: string[];
};

export type ZoomMeetingResult = {
  id: string;
  topic: string;
  joinUrl: string;
  startUrl?: string;
  startTime?: string;
  duration?: number;
  timezone?: string;
};

const TOKEN_PATH = process.env.ZOOM_TOKEN_PATH || dataPath("zoom_tokens.json");
const STATE_MAX_AGE_MS = 15 * 60 * 1000;

function zoomConfig() {
  const clientId = String(process.env.ZOOM_CLIENT_ID ?? "").trim();
  const clientSecret = String(process.env.ZOOM_CLIENT_SECRET ?? "").trim();
  const leadriderApiBase = String(process.env.LEADRIDER_API_BASE_URL ?? "https://api.leadrider.ai").trim().replace(/\/$/, "");
  const redirectUri = String(process.env.ZOOM_REDIRECT_URI ?? `${leadriderApiBase}/integrations/zoom/callback`).trim();
  const oauthBase = String(process.env.ZOOM_OAUTH_BASE ?? "https://zoom.us").trim().replace(/\/$/, "");
  const apiBase = String(process.env.ZOOM_API_BASE ?? "https://api.zoom.us/v2").trim().replace(/\/$/, "");
  const scopes = String(process.env.ZOOM_SCOPES ?? "").trim();
  const stateSecret =
    String(process.env.ZOOM_STATE_SECRET ?? "").trim() ||
    String(process.env.SESSION_SECRET ?? "").trim() ||
    "zoom_state_secret";
  return { clientId, clientSecret, redirectUri, oauthBase, apiBase, scopes, stateSecret };
}

export function getZoomStatusSync(): ZoomStatus {
  const cfg = zoomConfig();
  const missing = [
    !cfg.clientId ? "ZOOM_CLIENT_ID" : "",
    !cfg.clientSecret ? "ZOOM_CLIENT_SECRET" : "",
    !cfg.redirectUri ? "ZOOM_REDIRECT_URI" : ""
  ].filter(Boolean);
  return {
    configured: missing.length === 0,
    connected: false,
    apiBase: cfg.apiBase,
    redirectUri: cfg.redirectUri || undefined,
    scopes: cfg.scopes || undefined,
    missing
  };
}

export async function getZoomStatus(): Promise<ZoomStatus> {
  const base = getZoomStatusSync();
  const tokens = await loadZoomTokens();
  if (!tokens) return base;
  return {
    ...base,
    connected: true,
    connectedAt: tokens.connectedAt,
    updatedAt: tokens.updatedAt,
    apiBase: tokens.apiBase || base.apiBase,
    scopes: tokens.scope || base.scopes
  };
}

export function buildZoomAuthUrl() {
  const cfg = zoomConfig();
  const missing = getZoomStatusSync().missing;
  if (missing.length) throw new Error(`Zoom is missing: ${missing.join(", ")}`);
  const url = new URL(`${cfg.oauthBase}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("state", buildState());
  if (cfg.scopes) url.searchParams.set("scope", cfg.scopes);
  return url.toString();
}

export async function exchangeZoomCode(code: string, state: string): Promise<ZoomTokenRecord> {
  const parsed = parseState(state);
  if (!parsed.ok) throw new Error(`Invalid Zoom state: ${parsed.error}`);
  const cfg = zoomConfig();
  const resp = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri
  });
  return saveZoomTokens(resp);
}

export async function createZoomMeetingForProspect(
  prospect: SalesProspect,
  input: {
    topic?: string;
    startTime?: string;
    duration?: number;
    timezone?: string;
    agenda?: string;
    userId?: string;
  } = {}
): Promise<ZoomMeetingResult> {
  const token = await getValidAccessToken();
  const cfg = zoomConfig();
  const apiBase = token.apiBase || cfg.apiBase;
  const userId = String(input.userId ?? process.env.ZOOM_MEETING_USER_ID ?? "me").trim() || "me";
  const topic =
    clean(input.topic, 180) ||
    `LeadRider discovery - ${prospect.dealerName}`;
  const startTime = normalizeStartTime(input.startTime || prospect.nextStepAt);
  const duration = Math.max(15, Math.min(240, Math.floor(Number(input.duration ?? 30) || 30)));
  const timezone = clean(input.timezone, 80) || process.env.ZOOM_TIMEZONE || "America/New_York";
  const agenda =
    clean(input.agenda, 1800) ||
    [
      `Dealer prospect: ${prospect.dealerName}`,
      prospect.contactName ? `Contact: ${prospect.contactName}` : "",
      prospect.contactEmail ? `Email: ${prospect.contactEmail}` : "",
      prospect.contactPhone ? `Phone: ${prospect.contactPhone}` : "",
      prospect.website ? `Website: ${prospect.website}` : "",
      prospect.nextStep ? `Next step: ${prospect.nextStep}` : ""
    ]
      .filter(Boolean)
      .join("\n");

  const resp = await fetch(`${apiBase}/users/${encodeURIComponent(userId)}/meetings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      topic,
      type: 2,
      start_time: startTime,
      duration,
      timezone,
      agenda,
      settings: {
        waiting_room: true,
        join_before_host: false,
        approval_type: 2,
        calendar_type: 1
      }
    })
  });
  const json = await readJson(resp);
  if (!resp.ok) throw new Error(`Zoom meeting create failed: ${extractZoomError(json)}`);
  const joinUrl = String(json?.join_url ?? "").trim();
  const id = String(json?.id ?? "").trim();
  if (!joinUrl || !id) throw new Error("Zoom did not return a meeting link.");
  return {
    id,
    topic: String(json?.topic ?? topic).trim() || topic,
    joinUrl,
    startUrl: String(json?.start_url ?? "").trim() || undefined,
    startTime: String(json?.start_time ?? startTime).trim() || startTime,
    duration: Number(json?.duration ?? duration) || duration,
    timezone: String(json?.timezone ?? timezone).trim() || timezone
  };
}

async function getValidAccessToken(): Promise<ZoomTokenRecord> {
  const current = await loadZoomTokens();
  if (!current?.refreshToken) throw new Error("Zoom is not connected. Connect Zoom first.");
  if (current.accessToken && current.expiresAt > Date.now() + 2 * 60 * 1000) return current;
  const refreshed = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: current.refreshToken
  });
  return saveZoomTokens(refreshed, current);
}

async function tokenRequest(body: Record<string, string>) {
  const cfg = zoomConfig();
  const resp = await fetch(`${cfg.oauthBase}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(body)
  });
  const json = await readJson(resp);
  if (!resp.ok) throw new Error(`Zoom token request failed: ${extractZoomError(json)}`);
  return json;
}

async function saveZoomTokens(raw: any, previous?: ZoomTokenRecord | null): Promise<ZoomTokenRecord> {
  const cfg = zoomConfig();
  const now = new Date().toISOString();
  const accessToken = String(raw?.access_token ?? "").trim();
  const refreshToken = String(raw?.refresh_token ?? previous?.refreshToken ?? "").trim();
  const expiresIn = Math.max(60, Number(raw?.expires_in ?? 3600));
  if (!accessToken || !refreshToken) throw new Error("Zoom token response was missing required tokens.");
  const apiUrl = String(raw?.api_url ?? "").trim().replace(/\/$/, "");
  const record: ZoomTokenRecord = {
    connectedAt: previous?.connectedAt ?? now,
    updatedAt: now,
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    apiBase: apiUrl ? `${apiUrl}/v2` : previous?.apiBase || cfg.apiBase,
    scope: String(raw?.scope ?? previous?.scope ?? cfg.scopes ?? "").trim() || undefined
  };
  await fs.mkdir(path.dirname(TOKEN_PATH), { recursive: true });
  await fs.writeFile(TOKEN_PATH, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(TOKEN_PATH, 0o600).catch(() => undefined);
  return record;
}

async function loadZoomTokens(): Promise<ZoomTokenRecord | null> {
  try {
    const raw = await fs.readFile(TOKEN_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed?.refreshToken) return null;
    return parsed as ZoomTokenRecord;
  } catch {
    return null;
  }
}

function normalizeStartTime(value: unknown) {
  const raw = String(value ?? "").trim();
  if (raw) {
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const fallback = new Date(Date.now() + 24 * 60 * 60 * 1000);
  fallback.setMinutes(0, 0, 0);
  return fallback.toISOString();
}

function clean(value: unknown, max: number): string | undefined {
  const text = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  return text || undefined;
}

function buildState() {
  const cfg = zoomConfig();
  const payload = Buffer.from(
    JSON.stringify({ ts: Date.now(), nonce: crypto.randomBytes(12).toString("hex") }),
    "utf8"
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", cfg.stateSecret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function parseState(stateRaw: string): { ok: true } | { ok: false; error: string } {
  const cfg = zoomConfig();
  const state = String(stateRaw ?? "").trim();
  const idx = state.lastIndexOf(".");
  if (idx <= 0) return { ok: false, error: "invalid_state" };
  const payload = state.slice(0, idx);
  const sig = state.slice(idx + 1);
  const expected = crypto.createHmac("sha256", cfg.stateSecret).update(payload).digest("hex");
  const got = Buffer.from(sig, "utf8");
  const want = Buffer.from(expected, "utf8");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, error: "invalid_signature" };
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const ts = Number(parsed?.ts);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > STATE_MAX_AGE_MS) return { ok: false, error: "expired_state" };
    return { ok: true };
  } catch {
    return { ok: false, error: "invalid_payload" };
  }
}

async function readJson(resp: Response): Promise<any> {
  const text = await resp.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text.slice(0, 500) };
  }
}

function extractZoomError(value: any) {
  return (
    String(value?.message ?? "").trim() ||
    String(value?.reason ?? "").trim() ||
    String(value?.error_description ?? "").trim() ||
    String(value?.error ?? "").trim() ||
    "unknown error"
  );
}
