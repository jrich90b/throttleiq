import { promises as fs } from "node:fs";
import * as path from "node:path";
import crypto from "node:crypto";
import { dataPath } from "./dataDir.js";
import type { EsignPacket } from "./esignPacketStore.js";

export type DocusignTokenRecord = {
  connectedAt: string;
  updatedAt: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
  basePath: string;
};

export type DocusignStatus = {
  configured: boolean;
  connected: boolean;
  accountId?: string;
  basePath?: string;
  connectedAt?: string;
  updatedAt?: string;
  redirectUri?: string;
  missing: string[];
};

const TOKEN_PATH = process.env.DOCUSIGN_TOKEN_PATH || dataPath("docusign_tokens.json");
const STATE_MAX_AGE_MS = 15 * 60 * 1000;

function docusignConfig() {
  const integrationKey = String(process.env.DOCUSIGN_INTEGRATION_KEY ?? "").trim();
  const clientSecret = String(process.env.DOCUSIGN_CLIENT_SECRET ?? "").trim();
  const accountId = String(process.env.DOCUSIGN_ACCOUNT_ID ?? "").trim();
  const basePath = String(process.env.DOCUSIGN_BASE_PATH ?? "https://demo.docusign.net/restapi").trim().replace(/\/$/, "");
  const oauthBase = String(process.env.DOCUSIGN_OAUTH_BASE ?? "https://account-d.docusign.com").trim().replace(/\/$/, "");
  const redirectUri = String(process.env.DOCUSIGN_REDIRECT_URI ?? "").trim();
  const stateSecret =
    String(process.env.DOCUSIGN_STATE_SECRET ?? "").trim() ||
    String(process.env.SESSION_SECRET ?? "").trim() ||
    "docusign_state_secret";
  return { integrationKey, clientSecret, accountId, basePath, oauthBase, redirectUri, stateSecret };
}

export function getDocusignStatusSync(): DocusignStatus {
  const cfg = docusignConfig();
  const missing = [
    !cfg.integrationKey ? "DOCUSIGN_INTEGRATION_KEY" : "",
    !cfg.clientSecret ? "DOCUSIGN_CLIENT_SECRET" : "",
    !cfg.accountId ? "DOCUSIGN_ACCOUNT_ID" : "",
    !cfg.redirectUri ? "DOCUSIGN_REDIRECT_URI" : ""
  ].filter(Boolean);
  return {
    configured: missing.length === 0,
    connected: false,
    accountId: cfg.accountId || undefined,
    basePath: cfg.basePath || undefined,
    redirectUri: cfg.redirectUri || undefined,
    missing
  };
}

export async function getDocusignStatus(): Promise<DocusignStatus> {
  const base = getDocusignStatusSync();
  const tokens = await loadDocusignTokens();
  if (!tokens) return base;
  return {
    ...base,
    connected: true,
    accountId: tokens.accountId,
    basePath: tokens.basePath,
    connectedAt: tokens.connectedAt,
    updatedAt: tokens.updatedAt
  };
}

export function buildDocusignAuthUrl() {
  const cfg = docusignConfig();
  const missing = getDocusignStatusSync().missing;
  if (missing.length) {
    throw new Error(`DocuSign is missing: ${missing.join(", ")}`);
  }
  const state = buildState();
  const url = new URL(`${cfg.oauthBase}/oauth/auth`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "signature");
  url.searchParams.set("client_id", cfg.integrationKey);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeDocusignCode(code: string, state: string): Promise<DocusignTokenRecord> {
  const parsed = parseState(state);
  if (!parsed.ok) throw new Error(`Invalid DocuSign state: ${parsed.error}`);
  const cfg = docusignConfig();
  const resp = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri
  });
  const token = await saveDocusignTokens(resp);
  return token;
}

export async function sendDocusignEnvelope(packet: EsignPacket): Promise<{
  envelopeId: string;
  envelopeUrl: string;
  status: string;
}> {
  if (!packet.signerEmail || !packet.signerName) {
    throw new Error("Signer name and signer email are required before sending through DocuSign.");
  }
  if (!packet.agreementUrl) {
    throw new Error("Agreement PDF/document URL is required before sending through DocuSign.");
  }
  const token = await getValidAccessToken();
  const document = await fetchAgreementDocument(packet.agreementUrl);
  const cfg = docusignConfig();
  const accountId = token.accountId || cfg.accountId;
  const basePath = token.basePath || cfg.basePath;
  const resp = await fetch(`${basePath}/v2.1/accounts/${encodeURIComponent(accountId)}/envelopes`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      emailSubject: packet.agreementTitle || `${packet.dealerName} LeadRider Agreement`,
      documents: [
        {
          documentBase64: document.base64,
          name: document.name,
          fileExtension: document.fileExtension,
          documentId: "1"
        }
      ],
      recipients: {
        signers: [
          {
            email: packet.signerEmail,
            name: packet.signerName,
            recipientId: "1",
            routingOrder: "1",
            tabs: {
              signHereTabs: [
                {
                  documentId: "1",
                  pageNumber: "1",
                  xPosition: "120",
                  yPosition: "650"
                }
              ],
              dateSignedTabs: [
                {
                  documentId: "1",
                  pageNumber: "1",
                  xPosition: "360",
                  yPosition: "650"
                }
              ]
            }
          }
        ]
      },
      status: "sent"
    })
  });
  const json = await readJson(resp);
  if (!resp.ok) {
    throw new Error(`DocuSign send failed: ${extractDocusignError(json)}`);
  }
  const envelopeId = String(json?.envelopeId ?? "").trim();
  if (!envelopeId) throw new Error("DocuSign did not return an envelope ID.");
  return {
    envelopeId,
    envelopeUrl: buildEnvelopeUrl(basePath, envelopeId),
    status: String(json?.status ?? "sent")
  };
}

async function getValidAccessToken(): Promise<DocusignTokenRecord> {
  const current = await loadDocusignTokens();
  if (!current?.refreshToken) throw new Error("DocuSign is not connected. Connect DocuSign first.");
  if (current.accessToken && current.expiresAt > Date.now() + 2 * 60 * 1000) return current;
  const refreshed = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: current.refreshToken
  });
  return saveDocusignTokens(refreshed, current);
}

async function tokenRequest(body: Record<string, string>) {
  const cfg = docusignConfig();
  const resp = await fetch(`${cfg.oauthBase}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.integrationKey}:${cfg.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(body)
  });
  const json = await readJson(resp);
  if (!resp.ok) throw new Error(`DocuSign token request failed: ${extractDocusignError(json)}`);
  return json;
}

async function saveDocusignTokens(raw: any, previous?: DocusignTokenRecord | null): Promise<DocusignTokenRecord> {
  const cfg = docusignConfig();
  const now = new Date().toISOString();
  const accessToken = String(raw?.access_token ?? "").trim();
  const refreshToken = String(raw?.refresh_token ?? previous?.refreshToken ?? "").trim();
  const expiresIn = Math.max(60, Number(raw?.expires_in ?? 3600));
  if (!accessToken || !refreshToken) throw new Error("DocuSign token response was missing required tokens.");
  const record: DocusignTokenRecord = {
    connectedAt: previous?.connectedAt ?? now,
    updatedAt: now,
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    accountId: cfg.accountId || previous?.accountId || "",
    basePath: cfg.basePath || previous?.basePath || "https://demo.docusign.net/restapi"
  };
  await fs.mkdir(path.dirname(TOKEN_PATH), { recursive: true });
  await fs.writeFile(TOKEN_PATH, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(TOKEN_PATH, 0o600).catch(() => undefined);
  return record;
}

async function loadDocusignTokens(): Promise<DocusignTokenRecord | null> {
  try {
    const raw = await fs.readFile(TOKEN_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed?.refreshToken) return null;
    return parsed as DocusignTokenRecord;
  } catch {
    return null;
  }
}

async function fetchAgreementDocument(urlRaw: string): Promise<{ base64: string; name: string; fileExtension: string }> {
  const url = String(urlRaw ?? "").trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("Agreement URL must be a public https link.");
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Agreement document could not be downloaded (${resp.status}).`);
  const arrayBuffer = await resp.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (!buffer.length) throw new Error("Agreement document download was empty.");
  const contentType = String(resp.headers.get("content-type") ?? "");
  const fileExtension = inferFileExtension(url, contentType);
  return {
    base64: buffer.toString("base64"),
    name: basenameFromUrl(url) || "LeadRider Agreement",
    fileExtension
  };
}

function inferFileExtension(url: string, contentType: string) {
  const lower = `${url} ${contentType}`.toLowerCase();
  if (lower.includes(".docx") || lower.includes("wordprocessingml")) return "docx";
  if (lower.includes(".doc") || lower.includes("msword")) return "doc";
  if (lower.includes(".pdf") || lower.includes("application/pdf")) return "pdf";
  return "pdf";
}

function basenameFromUrl(urlRaw: string) {
  try {
    const url = new URL(urlRaw);
    const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(last).replace(/\.(pdf|docx?|html?)$/i, "").replace(/[-_]+/g, " ").trim();
  } catch {
    return "";
  }
}

function buildEnvelopeUrl(basePath: string, envelopeId: string) {
  return basePath.includes("demo.docusign.net")
    ? `https://appdemo.docusign.com/documents/details/${encodeURIComponent(envelopeId)}`
    : `https://app.docusign.com/documents/details/${encodeURIComponent(envelopeId)}`;
}

function buildState() {
  const cfg = docusignConfig();
  const payload = Buffer.from(
    JSON.stringify({ ts: Date.now(), nonce: crypto.randomBytes(12).toString("hex") }),
    "utf8"
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", cfg.stateSecret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function parseState(stateRaw: string): { ok: true } | { ok: false; error: string } {
  const cfg = docusignConfig();
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

function extractDocusignError(value: any) {
  return (
    String(value?.error_description ?? "").trim() ||
    String(value?.message ?? "").trim() ||
    String(value?.error ?? "").trim() ||
    "unknown error"
  );
}
