import { promises as fs } from "node:fs";
import * as path from "node:path";
import { dataPath } from "./dataDir.js";

export type EsignPacketProvider = "manual" | "docusign" | "dropbox_sign" | "pandadoc" | "signwell";
export type EsignPacketStatus = "draft" | "ready" | "sent" | "signed" | "declined" | "voided";

export type EsignPacket = {
  id: string;
  dealerSetupId?: string;
  dealerName: string;
  provider: EsignPacketProvider;
  status: EsignPacketStatus;
  agreementTitle: string;
  signerName?: string;
  signerEmail?: string;
  signerTitle?: string;
  agreementUrl?: string;
  externalPacketId?: string;
  externalUrl?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
  signedAt?: string;
};

const STORE_PATH = process.env.ESIGN_PACKETS_PATH || dataPath("esign_packets.json");
const MAX_ROWS = Number(process.env.ESIGN_PACKETS_MAX_ROWS ?? "1000");

let loaded = false;
let rows: EsignPacket[] = [];
let saveTimer: NodeJS.Timeout | null = null;

export async function listEsignPackets(input: { dealerSetupId?: string; limit?: number } = {}): Promise<EsignPacket[]> {
  await ensureLoaded();
  const bounded = Math.max(1, Math.min(1000, Math.floor(input.limit ?? 200)));
  return [...rows]
    .filter(row => !input.dealerSetupId || row.dealerSetupId === input.dealerSetupId)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, bounded);
}

export async function getEsignPacket(id: string): Promise<EsignPacket | null> {
  await ensureLoaded();
  return rows.find(row => row.id === id) ?? null;
}

export async function addEsignPacket(input: {
  dealerSetupId?: string;
  dealerName: string;
  provider?: EsignPacketProvider;
  agreementTitle?: string;
  signerName?: string;
  signerEmail?: string;
  signerTitle?: string;
  agreementUrl?: string;
  externalPacketId?: string;
  externalUrl?: string;
  notes?: string;
}): Promise<EsignPacket> {
  await ensureLoaded();
  const now = new Date().toISOString();
  const packet: EsignPacket = {
    id: `esign_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    dealerSetupId: clean(input.dealerSetupId, 120),
    dealerName: clean(input.dealerName, 180) || "Dealer",
    provider: input.provider ?? "manual",
    status: "draft",
    agreementTitle: clean(input.agreementTitle, 180) || `${clean(input.dealerName, 120) || "Dealer"} LeadRider Agreement`,
    signerName: clean(input.signerName, 160),
    signerEmail: clean(input.signerEmail, 180),
    signerTitle: clean(input.signerTitle, 120),
    agreementUrl: clean(input.agreementUrl, 500),
    externalPacketId: clean(input.externalPacketId, 160),
    externalUrl: clean(input.externalUrl, 500),
    notes: clean(input.notes, 2000),
    createdAt: now,
    updatedAt: now
  };
  rows.unshift(packet);
  const maxRows = Number.isFinite(MAX_ROWS) && MAX_ROWS > 0 ? Math.floor(MAX_ROWS) : 1000;
  if (rows.length > maxRows) rows = rows.slice(0, maxRows);
  scheduleSave();
  return packet;
}

export async function updateEsignPacket(
  id: string,
  patch: Partial<
    Pick<
      EsignPacket,
      | "status"
      | "provider"
      | "agreementTitle"
      | "signerName"
      | "signerEmail"
      | "signerTitle"
      | "agreementUrl"
      | "externalPacketId"
      | "externalUrl"
      | "notes"
    >
  >
): Promise<EsignPacket | null> {
  await ensureLoaded();
  const packet = rows.find(row => row.id === id);
  if (!packet) return null;
  if (patch.provider) packet.provider = patch.provider;
  if (patch.status) {
    packet.status = patch.status;
    if (patch.status === "sent" && !packet.sentAt) packet.sentAt = new Date().toISOString();
    if (patch.status === "signed" && !packet.signedAt) packet.signedAt = new Date().toISOString();
  }
  for (const key of [
    "agreementTitle",
    "signerName",
    "signerEmail",
    "signerTitle",
    "agreementUrl",
    "externalPacketId",
    "externalUrl",
    "notes"
  ] as const) {
    if (typeof patch[key] === "string") (packet as any)[key] = clean(patch[key], key === "notes" ? 2000 : 500);
  }
  packet.updatedAt = new Date().toISOString();
  scheduleSave();
  return packet;
}

function clean(value: unknown, max: number): string | undefined {
  const text = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  return text || undefined;
}

function isEsignPacket(row: any): row is EsignPacket {
  return (
    !!row &&
    typeof row === "object" &&
    typeof row.id === "string" &&
    typeof row.dealerName === "string" &&
    typeof row.createdAt === "string"
  );
}

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    rows = Array.isArray(parsed) ? parsed.filter(isEsignPacket) : [];
  } catch {
    rows = [];
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveNow();
  }, 200);
}

async function saveNow() {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, `${JSON.stringify(rows, null, 2)}\n`);
}
