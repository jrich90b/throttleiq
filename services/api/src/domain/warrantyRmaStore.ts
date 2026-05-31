import { promises as fs } from "node:fs";
import path from "node:path";
import { dataPath } from "./dataDir.js";
import type { HdnetDraftPacket } from "./warrantyRmaHdnet.js";
import type { WarrantyRmaReview } from "./warrantyRmaAssistant.js";

export type WarrantyRmaStatus =
  | "draft"
  | "needs_info"
  | "ready_for_dms"
  | "dms_queued"
  | "submitted"
  | "closed"
  | "denied";

export type WarrantyRmaDmsStatus = "not_configured" | "ready" | "queued" | "pushed" | "failed";
export type WarrantyRmaManualScope = "global" | "dealer";

export type WarrantyRmaManualDocument = {
  id: string;
  title: string;
  fileName: string;
  mimeType: string;
  size: number;
  storagePath: string;
  url?: string;
  documentType?: "warranty_manual" | "policy" | "parts_reference" | "other";
  scope?: WarrantyRmaManualScope;
  notes?: string;
  uploadedByUserId?: string;
  uploadedByUserName?: string;
  createdAt: string;
  updatedAt: string;
};

export type WarrantyRmaCaseEntry = {
  id: string;
  title: string;
  status: WarrantyRmaStatus;
  partNumber: string;
  issueDescription: string;
  partDescription?: string;
  claimType?: string;
  customerName?: string;
  roNumber?: string;
  invoiceNumber?: string;
  orderNumber?: string;
  vin?: string;
  mileage?: string;
  invoiceDate?: string;
  workOrderDate?: string;
  serviceStartDate?: string;
  serviceEndDate?: string;
  purchaseDate?: string;
  installDate?: string;
  failureDate?: string;
  quantity?: string;
  laborHours?: string;
  jobTimeCode?: string;
  technicianName?: string;
  dealerNumber?: string;
  authorizationNumber?: string;
  customerConcernCode?: string;
  conditionCode?: string;
  carrierName?: string;
  bolNumber?: string;
  returnAuthorizationNumber?: string;
  cause?: string;
  correction?: string;
  requestedAction?: string;
  notes?: string;
  selectedManualIds: string[];
  review: WarrantyRmaReview;
  hdnetDraftPacket?: HdnetDraftPacket;
  dmsPush: {
    status: WarrantyRmaDmsStatus;
    message?: string;
    externalId?: string;
    updatedAt?: string;
  };
  createdByUserId?: string;
  createdByUserName?: string;
  createdAt: string;
  updatedAt: string;
};

const DB_PATH = process.env.WARRANTY_RMA_DB_PATH
  ? String(process.env.WARRANTY_RMA_DB_PATH)
  : dataPath("warranty_rma.json");

const manuals = new Map<string, WarrantyRmaManualDocument>();
const cases = new Map<string, WarrantyRmaCaseEntry>();
let saveTimer: NodeJS.Timeout | null = null;

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function normalizeStatus(raw: unknown): WarrantyRmaStatus {
  const value = String(raw ?? "").trim();
  if (
    value === "draft" ||
    value === "needs_info" ||
    value === "ready_for_dms" ||
    value === "dms_queued" ||
    value === "submitted" ||
    value === "closed" ||
    value === "denied"
  ) {
    return value;
  }
  return "draft";
}

function normalizeDmsStatus(raw: unknown): WarrantyRmaDmsStatus {
  const value = String(raw ?? "").trim();
  if (value === "not_configured" || value === "ready" || value === "queued" || value === "pushed" || value === "failed") {
    return value;
  }
  return "not_configured";
}

export function normalizeWarrantyRmaManualScope(raw: unknown): WarrantyRmaManualScope {
  return String(raw ?? "").trim() === "dealer" ? "dealer" : "global";
}

function titleFromCase(input: { partNumber?: string; customerName?: string; issueDescription?: string }) {
  const part = String(input.partNumber ?? "").trim();
  const customer = String(input.customerName ?? "").trim();
  if (part && customer) return `${part} - ${customer}`;
  if (part) return `Warranty/RMA ${part}`;
  return String(input.issueDescription ?? "").trim().slice(0, 64) || "Warranty/RMA case";
}

async function saveToDisk() {
  const payload = {
    version: 1,
    savedAt: nowIso(),
    manuals: Array.from(manuals.values()),
    cases: Array.from(cases.values())
  };
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
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
    const parsed = JSON.parse(raw) as {
      manuals?: WarrantyRmaManualDocument[];
      cases?: WarrantyRmaCaseEntry[];
    };
    manuals.clear();
    cases.clear();
    for (const row of parsed.manuals ?? []) {
      if (!row?.id || !row.storagePath) continue;
      manuals.set(row.id, {
        ...row,
        title: String(row.title ?? "").trim() || String(row.fileName ?? "").trim() || "Warranty document",
        fileName: String(row.fileName ?? "").trim() || "warranty-document",
        mimeType: String(row.mimeType ?? "").trim() || "application/octet-stream",
        size: Number(row.size ?? 0),
        scope: normalizeWarrantyRmaManualScope(row.scope),
        createdAt: String(row.createdAt ?? "").trim() || nowIso(),
        updatedAt: String(row.updatedAt ?? "").trim() || nowIso()
      });
    }
    for (const row of parsed.cases ?? []) {
      if (!row?.id || !row.review) continue;
      const selectedManualIds = Array.isArray(row.selectedManualIds)
        ? row.selectedManualIds.map(value => String(value)).filter(Boolean)
        : [];
      cases.set(row.id, {
        ...row,
        title: String(row.title ?? "").trim() || titleFromCase(row),
        status: normalizeStatus(row.status),
        partNumber: String(row.partNumber ?? "").trim(),
        issueDescription: String(row.issueDescription ?? "").trim(),
        selectedManualIds,
        hdnetDraftPacket: row.hdnetDraftPacket,
        dmsPush: {
          status: normalizeDmsStatus(row.dmsPush?.status),
          message: String(row.dmsPush?.message ?? "").trim() || undefined,
          externalId: String(row.dmsPush?.externalId ?? "").trim() || undefined,
          updatedAt: String(row.dmsPush?.updatedAt ?? "").trim() || undefined
        },
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

export const warrantyRmaStoreReady = loadFromDisk();

export function listWarrantyRmaManuals(): WarrantyRmaManualDocument[] {
  return Array.from(manuals.values()).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export function getWarrantyRmaManual(id: string): WarrantyRmaManualDocument | null {
  return manuals.get(id) ?? null;
}

export function addWarrantyRmaManual(input: Omit<WarrantyRmaManualDocument, "id" | "createdAt" | "updatedAt">) {
  const now = nowIso();
  const entry: WarrantyRmaManualDocument = {
    ...input,
    id: makeId("wrm_doc"),
    title: String(input.title ?? "").trim() || String(input.fileName ?? "").trim() || "Warranty document",
    scope: normalizeWarrantyRmaManualScope(input.scope),
    createdAt: now,
    updatedAt: now
  };
  manuals.set(entry.id, entry);
  scheduleSave();
  return entry;
}

export function deleteWarrantyRmaManual(id: string): WarrantyRmaManualDocument | null {
  const existing = manuals.get(id) ?? null;
  if (!existing) return null;
  manuals.delete(id);
  scheduleSave();
  return existing;
}

export function listWarrantyRmaCases(): WarrantyRmaCaseEntry[] {
  return Array.from(cases.values()).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export function getWarrantyRmaCase(id: string): WarrantyRmaCaseEntry | null {
  return cases.get(id) ?? null;
}

export function addWarrantyRmaCase(input: {
  partNumber: string;
  issueDescription: string;
  partDescription?: string;
  claimType?: string;
  customerName?: string;
  roNumber?: string;
  invoiceNumber?: string;
  orderNumber?: string;
  vin?: string;
  mileage?: string;
  invoiceDate?: string;
  workOrderDate?: string;
  serviceStartDate?: string;
  serviceEndDate?: string;
  purchaseDate?: string;
  installDate?: string;
  failureDate?: string;
  quantity?: string;
  laborHours?: string;
  jobTimeCode?: string;
  technicianName?: string;
  dealerNumber?: string;
  authorizationNumber?: string;
  customerConcernCode?: string;
  conditionCode?: string;
  carrierName?: string;
  bolNumber?: string;
  returnAuthorizationNumber?: string;
  cause?: string;
  correction?: string;
  requestedAction?: string;
  notes?: string;
  selectedManualIds?: string[];
  review: WarrantyRmaReview;
  hdnetDraftPacket?: HdnetDraftPacket;
  status?: WarrantyRmaStatus;
  createdByUserId?: string;
  createdByUserName?: string;
}): WarrantyRmaCaseEntry {
  const now = nowIso();
  const entry: WarrantyRmaCaseEntry = {
    id: makeId("wrm_case"),
    title: titleFromCase(input),
    status: normalizeStatus(input.status),
    partNumber: String(input.partNumber ?? "").trim(),
    issueDescription: String(input.issueDescription ?? "").trim(),
    partDescription: String(input.partDescription ?? "").trim() || undefined,
    claimType: String(input.claimType ?? "").trim() || undefined,
    customerName: String(input.customerName ?? "").trim() || undefined,
    roNumber: String(input.roNumber ?? "").trim() || undefined,
    invoiceNumber: String(input.invoiceNumber ?? "").trim() || undefined,
    orderNumber: String(input.orderNumber ?? "").trim() || undefined,
    vin: String(input.vin ?? "").trim() || undefined,
    mileage: String(input.mileage ?? "").trim() || undefined,
    invoiceDate: String(input.invoiceDate ?? "").trim() || undefined,
    workOrderDate: String(input.workOrderDate ?? "").trim() || undefined,
    serviceStartDate: String(input.serviceStartDate ?? "").trim() || undefined,
    serviceEndDate: String(input.serviceEndDate ?? "").trim() || undefined,
    purchaseDate: String(input.purchaseDate ?? "").trim() || undefined,
    installDate: String(input.installDate ?? "").trim() || undefined,
    failureDate: String(input.failureDate ?? "").trim() || undefined,
    quantity: String(input.quantity ?? "").trim() || undefined,
    laborHours: String(input.laborHours ?? "").trim() || undefined,
    jobTimeCode: String(input.jobTimeCode ?? "").trim() || undefined,
    technicianName: String(input.technicianName ?? "").trim() || undefined,
    dealerNumber: String(input.dealerNumber ?? "").trim() || undefined,
    authorizationNumber: String(input.authorizationNumber ?? "").trim() || undefined,
    customerConcernCode: String(input.customerConcernCode ?? "").trim() || undefined,
    conditionCode: String(input.conditionCode ?? "").trim() || undefined,
    carrierName: String(input.carrierName ?? "").trim() || undefined,
    bolNumber: String(input.bolNumber ?? "").trim() || undefined,
    returnAuthorizationNumber: String(input.returnAuthorizationNumber ?? "").trim() || undefined,
    cause: String(input.cause ?? "").trim() || undefined,
    correction: String(input.correction ?? "").trim() || undefined,
    requestedAction: String(input.requestedAction ?? "").trim() || undefined,
    notes: String(input.notes ?? "").trim() || undefined,
    selectedManualIds: input.selectedManualIds ?? [],
    review: input.review,
    hdnetDraftPacket: input.hdnetDraftPacket,
    dmsPush: {
      status: "not_configured",
      message: input.hdnetDraftPacket
        ? `${input.hdnetDraftPacket.formTitle} prepared for H-Dnet portal review. Portal automation is not connected yet.`
        : "DMS API integration is not configured yet."
    },
    createdByUserId: input.createdByUserId,
    createdByUserName: input.createdByUserName,
    createdAt: now,
    updatedAt: now
  };
  cases.set(entry.id, entry);
  scheduleSave();
  return entry;
}

export function updateWarrantyRmaCase(
  id: string,
  patch: Partial<
    Pick<
      WarrantyRmaCaseEntry,
      | "title"
      | "status"
      | "notes"
      | "review"
      | "hdnetDraftPacket"
      | "dmsPush"
      | "partDescription"
      | "claimType"
      | "customerName"
      | "roNumber"
      | "invoiceNumber"
      | "orderNumber"
      | "vin"
      | "mileage"
      | "invoiceDate"
      | "workOrderDate"
      | "serviceStartDate"
      | "serviceEndDate"
      | "purchaseDate"
      | "installDate"
      | "failureDate"
      | "quantity"
      | "laborHours"
      | "jobTimeCode"
      | "technicianName"
      | "dealerNumber"
      | "authorizationNumber"
      | "customerConcernCode"
      | "conditionCode"
      | "carrierName"
      | "bolNumber"
      | "returnAuthorizationNumber"
      | "cause"
      | "correction"
      | "requestedAction"
      | "selectedManualIds"
    >
  >
): WarrantyRmaCaseEntry | null {
  const existing = cases.get(id);
  if (!existing) return null;
  const next: WarrantyRmaCaseEntry = {
    ...existing,
    ...patch,
    status: patch.status !== undefined ? normalizeStatus(patch.status) : existing.status,
    dmsPush: patch.dmsPush
      ? {
          ...existing.dmsPush,
          ...patch.dmsPush,
          status: normalizeDmsStatus(patch.dmsPush.status),
          updatedAt: patch.dmsPush.updatedAt ?? nowIso()
        }
      : existing.dmsPush,
    updatedAt: nowIso()
  };
  cases.set(id, next);
  scheduleSave();
  return next;
}
