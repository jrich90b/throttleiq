import { promises as fs } from "node:fs";
import { dataPath } from "./dataDir.js";
import type { MdfClaimPacket } from "./mdfAssistant.js";

export type MdfClaimStatus = "draft" | "needs_info" | "ready_for_portal" | "portal_draft" | "submitted" | "completed";

export type MdfClaimEntry = {
  id: string;
  title: string;
  status: MdfClaimStatus;
  notes?: string;
  packet: MdfClaimPacket;
  createdByUserId?: string;
  createdByUserName?: string;
  createdAt: string;
  updatedAt: string;
};

const DB_PATH = process.env.MDF_CLAIMS_DB_PATH
  ? String(process.env.MDF_CLAIMS_DB_PATH)
  : dataPath("mdf_claims.json");

const claims = new Map<string, MdfClaimEntry>();
let saveTimer: NodeJS.Timeout | null = null;

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  return `mdf_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function normalizeStatus(raw: unknown): MdfClaimStatus {
  const value = String(raw ?? "").trim();
  if (
    value === "draft" ||
    value === "needs_info" ||
    value === "ready_for_portal" ||
    value === "portal_draft" ||
    value === "submitted" ||
    value === "completed"
  ) {
    return value;
  }
  return "draft";
}

function titleFromPacket(packet: MdfClaimPacket): string {
  const fields = packet.extractedFields;
  const title =
    fields.campaignName ||
    fields.eventName ||
    [packet.activityType, fields.vendorName].filter(Boolean).join(" - ");
  return title.trim() || "Untitled MDF claim";
}

async function saveToDisk() {
  const payload = {
    version: 1,
    savedAt: nowIso(),
    claims: Array.from(claims.values())
  };
  const tmp = `${DB_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmp, DB_PATH);
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveToDisk();
  }, 200);
}

async function loadFromDisk() {
  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    const parsed = JSON.parse(raw) as { claims?: MdfClaimEntry[] };
    claims.clear();
    for (const row of parsed.claims ?? []) {
      if (!row?.id || !row.packet) continue;
      claims.set(row.id, {
        ...row,
        title: String(row.title ?? "").trim() || titleFromPacket(row.packet),
        status: normalizeStatus(row.status),
        notes: String(row.notes ?? "").trim() || undefined,
        createdAt: String(row.createdAt ?? "").trim() || nowIso(),
        updatedAt: String(row.updatedAt ?? "").trim() || nowIso()
      });
    }
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      await saveToDisk();
    }
  }
}

void loadFromDisk();

export function listMdfClaims(): MdfClaimEntry[] {
  return Array.from(claims.values()).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export function getMdfClaim(id: string): MdfClaimEntry | null {
  return claims.get(id) ?? null;
}

export function addMdfClaim(input: {
  packet: MdfClaimPacket;
  title?: string;
  status?: MdfClaimStatus;
  notes?: string;
  createdByUserId?: string;
  createdByUserName?: string;
}): MdfClaimEntry {
  const now = nowIso();
  const entry: MdfClaimEntry = {
    id: makeId(),
    title: String(input.title ?? "").trim() || titleFromPacket(input.packet),
    status: normalizeStatus(input.status),
    notes: String(input.notes ?? "").trim() || undefined,
    packet: input.packet,
    createdByUserId: input.createdByUserId,
    createdByUserName: input.createdByUserName,
    createdAt: now,
    updatedAt: now
  };
  claims.set(entry.id, entry);
  scheduleSave();
  return entry;
}

export function updateMdfClaim(
  id: string,
  patch: Partial<Pick<MdfClaimEntry, "title" | "status" | "notes" | "packet">>
): MdfClaimEntry | null {
  const existing = claims.get(id);
  if (!existing) return null;
  const packet = patch.packet ?? existing.packet;
  const next: MdfClaimEntry = {
    ...existing,
    packet,
    title:
      patch.title !== undefined
        ? String(patch.title ?? "").trim() || titleFromPacket(packet)
        : existing.title,
    status: patch.status !== undefined ? normalizeStatus(patch.status) : existing.status,
    notes: patch.notes !== undefined ? String(patch.notes ?? "").trim() || undefined : existing.notes,
    updatedAt: nowIso()
  };
  claims.set(id, next);
  scheduleSave();
  return next;
}

export function deleteMdfClaim(id: string): boolean {
  const existed = claims.delete(id);
  if (existed) scheduleSave();
  return existed;
}
