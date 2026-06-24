import OpenAI from "openai";
import { recordOpenAIUsage } from "./openaiUsageLogger.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type MdfUploadedFile = {
  name: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
  url?: string;
  providedRole?: MdfFileRole;
};

type MdfFileRole = "invoice" | "proof_of_performance" | "creative" | "receipt" | "supporting_only" | "unknown";

export type MdfInvoicePacket = {
  vendorName: string;
  invoiceDate: string;
  invoiceNumber: string;
  amount: string;
  fileNames: string[];
  description: string;
};

export type MdfClaimPacket = {
  claimType: "media" | "event" | "map_only" | "unknown";
  activityType: string;
  confidence: number;
  extractedFields: {
    campaignName: string;
    eventName: string;
    vendorName: string;
    invoiceDate: string;
    invoiceNumber: string;
    spend: string;
    activityStartDate: string;
    activityEndDate: string;
    totalLeads: string;
    attendance: string;
    motorcyclesSold: string;
    paAlSales: string;
  };
  invoices: MdfInvoicePacket[];
  descriptionDraft: string;
  eligibility: {
    status: "likely_eligible" | "review_needed" | "likely_ineligible" | "unknown";
    concerns: string[];
  };
  requiredDocumentation: string[];
  uploadedFiles: Array<{
    name: string;
    type: string;
    size: number;
    url?: string;
    inferredRole: MdfFileRole;
  }>;
  missingFields: string[];
  portalSteps: string[];
  browserAutomation: {
    status: "ready_for_draft" | "needs_review" | "not_ready";
    nextStep: string;
  };
};

const MDF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "claimType",
    "activityType",
    "confidence",
    "extractedFields",
    "invoices",
    "descriptionDraft",
    "eligibility",
    "requiredDocumentation",
    "uploadedFiles",
    "missingFields",
    "portalSteps",
    "browserAutomation"
  ],
  properties: {
    claimType: { type: "string", enum: ["media", "event", "map_only", "unknown"] },
    activityType: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    extractedFields: {
      type: "object",
      additionalProperties: false,
      required: [
        "campaignName",
        "eventName",
        "vendorName",
        "invoiceDate",
        "invoiceNumber",
        "spend",
        "activityStartDate",
        "activityEndDate",
        "totalLeads",
        "attendance",
        "motorcyclesSold",
        "paAlSales"
      ],
      properties: {
        campaignName: { type: "string" },
        eventName: { type: "string" },
        vendorName: { type: "string" },
        invoiceDate: { type: "string" },
        invoiceNumber: { type: "string" },
        spend: { type: "string" },
        activityStartDate: { type: "string" },
        activityEndDate: { type: "string" },
        totalLeads: { type: "string" },
        attendance: { type: "string" },
        motorcyclesSold: { type: "string" },
        paAlSales: { type: "string" }
      }
    },
    invoices: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["vendorName", "invoiceDate", "invoiceNumber", "amount", "fileNames", "description"],
        properties: {
          vendorName: { type: "string" },
          invoiceDate: { type: "string" },
          invoiceNumber: { type: "string" },
          amount: { type: "string" },
          fileNames: { type: "array", items: { type: "string" } },
          description: { type: "string" }
        }
      }
    },
    descriptionDraft: { type: "string" },
    eligibility: {
      type: "object",
      additionalProperties: false,
      required: ["status", "concerns"],
      properties: {
        status: { type: "string", enum: ["likely_eligible", "review_needed", "likely_ineligible", "unknown"] },
        concerns: { type: "array", items: { type: "string" } }
      }
    },
    requiredDocumentation: { type: "array", items: { type: "string" } },
    uploadedFiles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "type", "size", "inferredRole"],
        properties: {
          name: { type: "string" },
          type: { type: "string" },
          size: { type: "number" },
          inferredRole: {
            type: "string",
            enum: ["invoice", "proof_of_performance", "creative", "receipt", "supporting_only", "unknown"]
          }
        }
      }
    },
    missingFields: { type: "array", items: { type: "string" } },
    portalSteps: { type: "array", items: { type: "string" } },
    browserAutomation: {
      type: "object",
      additionalProperties: false,
      required: ["status", "nextStep"],
      properties: {
        status: { type: "string", enum: ["ready_for_draft", "needs_review", "not_ready"] },
        nextStep: { type: "string" }
      }
    }
  }
};

function validMdfFileRole(value: unknown): MdfFileRole | null {
  return ["invoice", "proof_of_performance", "creative", "receipt", "supporting_only", "unknown"].includes(String(value))
    ? (String(value) as MdfFileRole)
    : null;
}

function inferRoleFromName(name: string): MdfFileRole {
  const lower = name.toLowerCase();
  if (/\binvoice|bill|statement\b/.test(lower)) return "invoice";
  if (/\breceipt|paid|payment\b/.test(lower)) return "receipt";
  if (/\bflyer|creative|artwork|ad|mailer|poster\b/.test(lower)) return "creative";
  if (/\bscreenshot|proof|live|tear|script|keyword|performance\b/.test(lower)) return "proof_of_performance";
  return "unknown";
}

function fallbackPacket(files: MdfUploadedFile[], reason: string): MdfClaimPacket {
  return {
    claimType: "unknown",
    activityType: "",
    confidence: 0,
    extractedFields: {
      campaignName: "",
      eventName: "",
      vendorName: "",
      invoiceDate: "",
      invoiceNumber: "",
      spend: "",
      activityStartDate: "",
      activityEndDate: "",
      totalLeads: "",
      attendance: "",
      motorcyclesSold: "",
      paAlSales: ""
    },
    invoices: [],
    descriptionDraft: "",
    eligibility: {
      status: "unknown",
      concerns: [reason]
    },
    requiredDocumentation: ["Invoice", "Proof of performance or final creative, based on activity type"],
    uploadedFiles: files.map(file => ({
      name: file.name,
      type: file.mimeType,
      size: file.size,
      url: (file as any).url,
      inferredRole: file.providedRole || inferRoleFromName(file.name)
    })),
    missingFields: ["Claim type", "Activity type", "Dates of activity", "Vendor", "Invoice date", "Invoice number", "Spend"],
    portalSteps: [
      "Open the MDF Portal from H-Dnet.",
      "Choose MDF Recap or Pre-Approval.",
      "Create the proper 2026 Media Claim, 2026 Event Claim, or MAP-only request.",
      "Fill required fields, attach invoice and supporting proof, then save as draft for review."
    ],
    browserAutomation: {
      status: "not_ready",
      nextStep: "Review the uploaded files and fill the missing claim fields before browser automation."
    }
  };
}

function fileInput(file: MdfUploadedFile) {
  const mime = file.mimeType || "application/octet-stream";
  const data = file.buffer.toString("base64");
  if (mime.startsWith("image/")) {
    return {
      type: "input_image",
      image_url: `data:${mime};base64,${data}`,
      detail: "high"
    };
  }
  if (mime === "application/pdf") {
    return {
      type: "input_file",
      filename: openAiSafeFileName(file.name, "mdf-file.pdf"),
      file_data: `data:application/pdf;base64,${data}`
    };
  }
  return null;
}

function fileManifest(files: MdfUploadedFile[]): string {
  return files
    .map((file, index) => {
      const role = file.providedRole || inferRoleFromName(file.name);
      return `${index + 1}. ${file.name} — role: ${role}; type: ${file.mimeType}; size: ${file.size}`;
    })
    .join("\n");
}

const SPREADSHEET_MAX_CHARS = 20000;

function isCsvFile(file: MdfUploadedFile): boolean {
  return /text\/csv|application\/csv/i.test(file.mimeType) || /\.csv$/i.test(file.name);
}

function isXlsxFile(file: MdfUploadedFile): boolean {
  return /spreadsheetml/i.test(file.mimeType) || /\.xlsx$/i.test(file.name);
}

function formatSpreadsheetCell(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const v: any = value;
    if (typeof v.text === "string") return v.text; // hyperlink / richText container
    if (Array.isArray(v.richText)) return v.richText.map((r: any) => r?.text ?? "").join("");
    if (typeof v.result !== "undefined" && v.result !== null) return String(v.result); // formula result
    if (typeof v.hyperlink === "string") return v.hyperlink;
    return "";
  }
  return String(value);
}

// Convert a CSV/XLSX claim source file into tab-separated text the extractor LLM can read
// (it ingests PDFs/images directly but not spreadsheets). Bounded so a large workbook
// can't blow up the prompt. Returns null for non-spreadsheet files (or unparseable ones).
export async function spreadsheetFileToText(file: MdfUploadedFile): Promise<string | null> {
  if (isCsvFile(file)) {
    return file.buffer.toString("utf-8").slice(0, SPREADSHEET_MAX_CHARS).trim() || null;
  }
  if (isXlsxFile(file)) {
    try {
      const mod: any = await import("exceljs");
      const ExcelJS = mod.default ?? mod;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(file.buffer);
      const lines: string[] = [];
      wb.eachSheet((sheet: any) => {
        lines.push(`# Sheet: ${sheet.name}`);
        sheet.eachRow({ includeEmpty: false }, (row: any) => {
          const values = Array.isArray(row.values) ? (row.values as unknown[]).slice(1) : [];
          lines.push(values.map(formatSpreadsheetCell).join("\t"));
        });
      });
      return lines.join("\n").slice(0, SPREADSHEET_MAX_CHARS).trim() || null;
    } catch {
      return null;
    }
  }
  return null;
}

async function fileContentInputs(files: MdfUploadedFile[]) {
  const content: any[] = [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const role = file.providedRole || inferRoleFromName(file.name);
    const sheetText = await spreadsheetFileToText(file);
    if (sheetText) {
      content.push({
        type: "input_text",
        text: `File ${index + 1}: ${file.name}. User-selected role: ${role}. Spreadsheet contents (tab-separated rows):\n${sheetText}`
      });
      continue;
    }
    const input = fileInput(file);
    if (!input) continue;
    content.push({
      type: "input_text",
      text: `File ${index + 1}: ${file.name}. User-selected role: ${role}.`
    });
    content.push(input);
  }
  return content;
}

function openAiSafeFileName(name: string, fallback: string) {
  const ext = (name.match(/\.[a-z0-9]{1,8}$/i)?.[0] ?? ".pdf").toLowerCase();
  const base = name
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${base || fallback.replace(/\.[a-z0-9]{1,8}$/i, "")}${ext}`;
}

function sanitizeMdfSubmissionText(value: unknown): string {
  let text = String(value ?? "").trim();
  if (!text) return "";
  text = text
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => {
      if (!line) return false;
      return !/^(missing|missing\/needs review|needs review|required documentation|eligibility concerns?|concerns?|internal note|review note)\s*[:\-]/i.test(line);
    })
    .join("\n");
  text = text.replace(
    /\s+(Missing|Missing\/needs review|Needs review|Required documentation|Eligibility concerns?|Concerns?)\s*:\s*[\s\S]*$/i,
    ""
  );
  return text.trim();
}

// extractedFields.spend mirrors only the PRIMARY invoice (back-compat). For a multi-invoice
// claim that under-reports the total — Taste of Country showed $2446.88 (IBBQ) and dropped the
// $61.40 Consumer's Beverages invoice. The claim's headline/submission spend must be the SUM of
// every extracted invoice. Deterministic aggregation; returns null for <2 amounts so a
// single-invoice claim keeps the extracted value verbatim.
export function sumInvoiceSpend(invoices: Array<{ amount?: string }>): string | null {
  const amounts = (invoices ?? [])
    .map(inv => parseFloat(String(inv?.amount ?? "").replace(/[^0-9.]/g, "")))
    .filter(n => Number.isFinite(n) && n > 0);
  if (amounts.length < 2) return null;
  return amounts.reduce((sum, n) => sum + n, 0).toFixed(2);
}

// Files that could each be a distinct invoice/receipt: an image or PDF that isn't tagged as
// creative / proof / support-only. Used to drive PER-FILE invoice extraction so two invoices
// for the same event can never be merged into one (root cause of "two invoices, only one
// parsed" — the single-call extractor non-deterministically collapsed two same-event images).
export function invoiceCandidateFiles(files: MdfUploadedFile[]): MdfUploadedFile[] {
  return (files ?? []).filter(file => {
    const role = file.providedRole || inferRoleFromName(file.name);
    if (role === "creative" || role === "proof_of_performance" || role === "supporting_only") return false;
    const mime = file.mimeType || "";
    return mime.startsWith("image/") || mime === "application/pdf";
  });
}

function normalizePacket(raw: any, files: MdfUploadedFile[]): MdfClaimPacket {
  const fallback = fallbackPacket(files, "Extractor returned incomplete data.");
  const packet = raw && typeof raw === "object" ? raw : {};
  const invoices = Array.isArray(packet.invoices)
    ? packet.invoices
        .map((row: any) => ({
          vendorName: String(row?.vendorName ?? row?.vendor ?? "").trim(),
          invoiceDate: String(row?.invoiceDate ?? row?.invoice_date ?? "").trim(),
          invoiceNumber: String(row?.invoiceNumber ?? row?.invoice_number ?? "").trim(),
          amount: String(row?.amount ?? row?.spend ?? row?.invoiceAmount ?? "").trim(),
          fileNames: Array.isArray(row?.fileNames)
            ? row.fileNames.map((v: unknown) => String(v)).filter(Boolean).slice(0, 12)
            : [],
          description: String(row?.description ?? "").trim()
        }))
        .filter((row: MdfInvoicePacket) => row.vendorName || row.invoiceDate || row.invoiceNumber || row.amount || row.fileNames.length)
        .slice(0, 12)
    : [];
  const extractedFields = {
    campaignName: String(packet.extractedFields?.campaignName ?? ""),
    eventName: String(packet.extractedFields?.eventName ?? ""),
    vendorName: String(packet.extractedFields?.vendorName ?? ""),
    invoiceDate: String(packet.extractedFields?.invoiceDate ?? ""),
    invoiceNumber: String(packet.extractedFields?.invoiceNumber ?? ""),
    spend: String(packet.extractedFields?.spend ?? ""),
    activityStartDate: String(packet.extractedFields?.activityStartDate ?? ""),
    activityEndDate: String(packet.extractedFields?.activityEndDate ?? ""),
    totalLeads: String(packet.extractedFields?.totalLeads ?? ""),
    attendance: String(packet.extractedFields?.attendance ?? ""),
    motorcyclesSold: String(packet.extractedFields?.motorcyclesSold ?? ""),
    paAlSales: String(packet.extractedFields?.paAlSales ?? "")
  };
  if (!invoices.length && (extractedFields.vendorName || extractedFields.invoiceDate || extractedFields.invoiceNumber || extractedFields.spend)) {
    invoices.push({
      vendorName: extractedFields.vendorName,
      invoiceDate: extractedFields.invoiceDate,
      invoiceNumber: extractedFields.invoiceNumber,
      amount: extractedFields.spend,
      fileNames: files
        .filter(file => {
          const role = file.providedRole || inferRoleFromName(file.name);
          return role === "invoice" || role === "receipt";
        })
        .map(file => file.name),
      description: "Primary invoice"
    });
  }
  // Multi-invoice claim: the headline spend is the SUM of all invoices, not the primary.
  const summedSpend = sumInvoiceSpend(invoices);
  if (summedSpend) extractedFields.spend = summedSpend;
  return {
    claimType: ["media", "event", "map_only", "unknown"].includes(packet.claimType) ? packet.claimType : fallback.claimType,
    activityType: String(packet.activityType ?? ""),
    confidence: Math.max(0, Math.min(1, Number(packet.confidence ?? 0))),
    extractedFields,
    invoices,
    descriptionDraft: sanitizeMdfSubmissionText(packet.descriptionDraft),
    eligibility: {
      status: ["likely_eligible", "review_needed", "likely_ineligible", "unknown"].includes(packet.eligibility?.status)
        ? packet.eligibility.status
        : "unknown",
      concerns: Array.isArray(packet.eligibility?.concerns)
        ? packet.eligibility.concerns.map((v: unknown) => String(v)).filter(Boolean).slice(0, 10)
        : []
    },
    requiredDocumentation: Array.isArray(packet.requiredDocumentation)
      ? packet.requiredDocumentation.map((v: unknown) => String(v)).filter(Boolean).slice(0, 12)
      : fallback.requiredDocumentation,
    uploadedFiles: Array.isArray(packet.uploadedFiles) && packet.uploadedFiles.length
      ? packet.uploadedFiles.map((row: any, index: number) => ({
          name: String(row?.name ?? files[index]?.name ?? "Uploaded file"),
          type: String(row?.type ?? files[index]?.mimeType ?? ""),
          size: Number(row?.size ?? files[index]?.size ?? 0),
          url: String((files[index] as any)?.url ?? row?.url ?? "").trim() || undefined,
          inferredRole:
            files[index]?.providedRole ||
            validMdfFileRole(row?.inferredRole) ||
            inferRoleFromName(String(row?.name ?? files[index]?.name ?? ""))
        }))
      : fallback.uploadedFiles,
    missingFields: Array.isArray(packet.missingFields)
      ? packet.missingFields.map((v: unknown) => String(v)).filter(Boolean).slice(0, 20)
      : fallback.missingFields,
    portalSteps: Array.isArray(packet.portalSteps)
      ? packet.portalSteps.map((v: unknown) => String(v)).filter(Boolean).slice(0, 12)
      : fallback.portalSteps,
    browserAutomation: {
      status: ["ready_for_draft", "needs_review", "not_ready"].includes(packet.browserAutomation?.status)
        ? packet.browserAutomation.status
        : "needs_review",
      nextStep: String(packet.browserAutomation?.nextStep ?? "Review the claim packet before filling the MDF portal.")
    }
  };
}

function parseJsonObject(text: unknown): any | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function parsedResponsePayload(resp: any): any | null {
  if (resp?.output_parsed) return resp.output_parsed;
  const output = Array.isArray(resp?.output) ? resp.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (block?.parsed) return block.parsed;
      const parsed = parseJsonObject(block?.text);
      if (parsed) return parsed;
    }
  }
  return parseJsonObject(resp?.output_text);
}

// Mirror the headline extractedFields (vendor / date / number / spend) from the AUTHORITATIVE invoice
// set: the primary invoice's vendor/date/number and the SUM of all invoice amounts. Blank them when
// there are no invoices yet (e.g. only creative uploaded so far) so a creative/proof file's numbers
// can never surface as invoice facts or spend. Pure. (Replaces the old single-call invoice-only
// fallback + merge path — invoices are now always extracted per-file by extractInvoicesPerFile.)
export function syncExtractedInvoiceFields(packet: MdfClaimPacket): void {
  const invoices = packet.invoices ?? [];
  if (!invoices.length) {
    packet.extractedFields.vendorName = "";
    packet.extractedFields.invoiceDate = "";
    packet.extractedFields.invoiceNumber = "";
    packet.extractedFields.spend = "";
    return;
  }
  const primary = invoices[0];
  packet.extractedFields.vendorName = primary.vendorName || "";
  packet.extractedFields.invoiceDate = primary.invoiceDate || "";
  packet.extractedFields.invoiceNumber = primary.invoiceNumber || "";
  packet.extractedFields.spend = sumInvoiceSpend(invoices) ?? (primary.amount || "");
}

// Fallback when the per-file pass comes back empty: keep the main-pass invoices that are supported by at
// least one invoice-eligible file, dropping any sourced SOLELY from creative/proof/support-only files (so
// a creative still can't leak in). Unattributed invoices (no fileNames) are kept — can't prove they're
// creative-sourced, and dropping a real invoice is the worse failure. Pure.
export function invoicesFromInvoiceRoleFiles(
  invoices: MdfInvoicePacket[] | undefined,
  files: MdfUploadedFile[]
): MdfInvoicePacket[] {
  const nonInvoice = new Set(
    (files ?? [])
      .filter(file => {
        const role = file.providedRole || inferRoleFromName(file.name);
        return role === "creative" || role === "proof_of_performance" || role === "supporting_only";
      })
      .map(file => file.name)
  );
  return (invoices ?? []).filter(inv => {
    const names = (inv.fileNames ?? []).filter(Boolean);
    if (!names.length) return true;
    return names.some(name => !nonInvoice.has(name)); // drop only if EVERY supporting file is non-invoice
  });
}

// Watchdog on packet generation: structural anomalies worth surfacing to the rep (and logging) rather
// than failing silently. The main one: invoice-eligible files were uploaded but no invoice came out
// (extraction miss). Pure — returns human-readable warnings.
export function auditMdfExtraction(packet: MdfClaimPacket, files: MdfUploadedFile[]): string[] {
  const warnings: string[] = [];
  const candidates = invoiceCandidateFiles(files);
  const invoices = packet.invoices ?? [];
  if (candidates.length && !invoices.length) {
    warnings.push(
      `Couldn't read invoice details from ${candidates.length} uploaded file${candidates.length === 1 ? "" : "s"} — please review or re-upload the invoice.`
    );
  }
  const missingAmount = invoices.filter(inv => !String(inv?.amount ?? "").trim()).length;
  if (missingAmount) {
    warnings.push(`${missingAmount} invoice${missingAmount === 1 ? "" : "s"} extracted without an amount — confirm the spend.`);
  }
  return warnings;
}

async function createMdfJsonResponse(
  model: string,
  prompt: string,
  inputs: any[],
  schemaName: string,
  maxOutputTokens: number
) {
  return (client.responses as any).create({
    model,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: prompt }, ...inputs] as any[]
      }
    ],
    max_output_tokens: maxOutputTokens,
    text: {
      format: {
        type: "json_schema",
        name: schemaName,
        schema: MDF_SCHEMA,
        strict: true
      }
    }
  });
}

// Extract invoices ONE FILE AT A TIME — the AUTHORITY for invoices[]. Each call sees a single
// invoice-candidate file (invoiceCandidateFiles already excludes creative/proof/support-only) and
// returns at most one invoice, or none if THAT file isn't actually an invoice/receipt. This is what
// guarantees (a) a creative/flyer can never become an invoice or inflate spend, and (b) two distinct
// invoices never collapse into one. Runs for ANY invoice-candidate file (1+), not just 2+.
async function extractInvoicesPerFile(files: MdfUploadedFile[], model: string): Promise<MdfInvoicePacket[]> {
  const candidates = invoiceCandidateFiles(files);
  if (!candidates.length) return [];
  const out: MdfInvoicePacket[] = [];
  for (const file of candidates) {
    const inputs = await fileContentInputs([file]);
    if (!inputs.length) continue;
    const prompt = [
      "Extract the SINGLE invoice or receipt contained in THIS one file.",
      "Return the MDF claim packet schema. invoices[] must contain AT MOST ONE entry — for this file only.",
      "Fill vendorName, invoiceDate, invoiceNumber, amount for that one invoice.",
      "If this file is NOT an invoice or receipt (e.g. a flyer, creative, screenshot, proof, or photo), return invoices: [] and leave the invoice fields blank.",
      "Do not invent values; leave unknown fields blank.",
      `This file: ${file.name}.`
    ].join("\n");
    // The per-file call returns the FULL (strict) MDF_SCHEMA, so it needs real headroom or the JSON
    // truncates and the invoice is silently lost — the truncation class that blanked invoices once this
    // pass became authoritative. 3000 leaves room for the whole packet shape.
    const resp = await createMdfJsonResponse(model, prompt, inputs, "mdf_invoice_fields", 3000).catch(() => null);
    if (!resp) continue;
    recordOpenAIUsage(resp, {
      feature: "mdf_assistant",
      operation: "extract_invoice_per_file",
      requestKind: "responses.create",
      model
    });
    const raw = parsedResponsePayload(resp);
    const rawInvoices = Array.isArray(raw?.invoices) ? raw.invoices : [];
    const first = rawInvoices[0];
    if (!first) continue;
    const vendorName = String(first.vendorName ?? first.vendor ?? "").trim();
    const amount = String(first.amount ?? first.spend ?? first.invoiceAmount ?? "").trim();
    const invoiceNumber = String(first.invoiceNumber ?? first.invoice_number ?? "").trim();
    const invoiceDate = String(first.invoiceDate ?? first.invoice_date ?? "").trim();
    if (vendorName || invoiceNumber || amount) {
      out.push({ vendorName, invoiceDate, invoiceNumber, amount, fileNames: [file.name], description: String(first.description ?? "").trim() });
    }
  }
  return out;
}

export async function extractMdfClaimPacket(files: MdfUploadedFile[], notes: string): Promise<MdfClaimPacket> {
  if (!files.length) return fallbackPacket(files, "Upload at least one invoice, receipt, creative, or proof file.");
  const supportedInputs = await fileContentInputs(files);
  if (!supportedInputs.length) {
    return fallbackPacket(files, "No supported PDF, image, or spreadsheet (CSV/XLSX) files were uploaded.");
  }
  if (process.env.LLM_ENABLED !== "1" || !process.env.OPENAI_API_KEY) {
    return fallbackPacket(files, "LLM extraction is not enabled.");
  }

  const model = process.env.OPENAI_MDF_ASSISTANT_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const prompt = [
    "You are LeadRider's Harley-Davidson MDF claim assistant.",
    "Extract a structured MDF recap/pre-approval claim packet from the uploaded invoice, receipt, proof, and artwork files.",
    "Use these 2026 MDF rules:",
    "- Recaps must include complete expense and asset documentation.",
    "- Recaps are due within 45 days of the activity month-end.",
    "- Media claims need dates live, media type, media/campaign description, total leads, vendor, invoice date, invoice number, spend, invoice, and proof of performance.",
    "- Event claims need event name, event description, attendance, motorcycles sold, P&A/A&L sales, vendor, invoice date, invoice number, spend, invoice, and event proof/creative/photos when applicable.",
    "- Common media documentation: social requires invoice or billing summary and screenshot of live asset; email/text marketing requires invoice plus screenshots of campaign texts/emails; search needs invoice and keyword list; display/video needs invoice plus live screenshots/video/link; direct mail needs invoice and final creative.",
    "- Exclusions include transactional email/text, AI fees, mail fees, creative development, alcohol/tobacco/cannabis, permanent facility signage, business cards, and operational support tools.",
    "Use this file manifest and respect the user-selected roles:",
    fileManifest(files),
    "- Extract vendor, invoice date, invoice number, and spend only from files marked invoice or receipt.",
    "- Create one invoices[] entry for every distinct invoice or receipt. Multiple invoices for the same claim are allowed and should stay separate.",
    "- For each invoices[] entry, include the invoice/receipt file names that support that invoice. Do not assign proof, creative, tear sheet, or support-only files to invoices[].",
    "- Mirror the first/primary invoice into extractedFields.vendorName, extractedFields.invoiceDate, extractedFields.invoiceNumber, and extractedFields.spend so older draft views still show a summary.",
    "- Use files marked creative, proof_of_performance, or supporting_only only for campaign description, proof, eligibility, documentation, and concerns.",
    "- If a magazine cover, tear sheet, screenshot, artwork, or proof file contains unrelated dates/prices/numbers, do not treat those as invoice fields.",
    "- If no invoice or receipt is provided, leave invoice/spend fields blank and list them as missing.",
    "- If evidence is missing or uncertain, do not guess. Put it in missingFields or eligibility.concerns.",
    "- Do not put missing fields, proof gaps, review notes, or internal concerns in descriptionDraft. descriptionDraft must contain only clean claim/activity description text that is safe to enter into the MDF portal.",
    "The portal should only be filled as a saved draft after human review. Never indicate final submit is automatic.",
    notes.trim() ? `Dealer notes: ${notes.trim()}` : "Dealer notes: none."
  ].join("\\n");

  try {
    const resp = await createMdfJsonResponse(model, prompt, supportedInputs, "mdf_claim_packet", 5000);
    recordOpenAIUsage(resp, {
      feature: "mdf_assistant",
      operation: "extract_claim_packet",
      requestKind: "responses.create",
      model,
      metadata: { fileCount: files.length }
    });
    const packet = normalizePacket(parsedResponsePayload(resp), files);
    // INVOICES: per-file (role-respecting) extraction is the authority — it excludes creative/proof so a
    // creative can't become an invoice, and reads each file alone so two invoices never merge. BUT a
    // per-file miss (truncation / transient error) must NOT silently blank an invoice the customer
    // uploaded: if per-file comes back empty while invoice-eligible files exist, fall back to the main
    // pass's invoices filtered to role-eligible files (creative still excluded). No invoice-eligible files
    // (e.g. only creative) -> no invoices, blank spend.
    const candidates = invoiceCandidateFiles(files);
    if (candidates.length) {
      const perFile = await extractInvoicesPerFile(files, model).catch(() => []);
      packet.invoices = perFile.length ? perFile : invoicesFromInvoiceRoleFiles(packet.invoices, files);
    } else {
      packet.invoices = [];
    }
    syncExtractedInvoiceFields(packet);
    // WATCHDOG: surface (don't fail silently) when packet generation produced no/incomplete invoices
    // despite invoice-eligible uploads. Logged + added as a visible eligibility concern so the UI flags it.
    const watch = auditMdfExtraction(packet, files);
    if (watch.length) {
      packet.eligibility.concerns = [...watch, ...packet.eligibility.concerns].slice(0, 10);
      console.warn("[mdf-extract-watchdog]", {
        files: files.length,
        invoiceCandidates: candidates.length,
        invoices: packet.invoices.length,
        warnings: watch
      });
    }
    return packet;
  } catch (err: any) {
    return fallbackPacket(files, err?.message ? `Extractor failed: ${err.message}` : "Extractor failed.");
  }
}
