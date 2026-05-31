import { promises as fs } from "node:fs";
import OpenAI from "openai";
import { recordOpenAIUsage } from "./openaiUsageLogger.js";
import type { WarrantyRmaManualDocument } from "./warrantyRmaStore.js";
import {
  searchWarrantyRmaManualChunks,
  warrantyRmaVectorQueryForSubmission,
  type WarrantyRmaVectorMatch
} from "./warrantyRmaVectorStore.js";

let client: OpenAI | null = null;

function openaiClient(): OpenAI {
  client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

export type WarrantyRmaReview = {
  status: "likely_warranty" | "needs_review" | "likely_not_covered" | "unknown";
  confidence: number;
  summary: string;
  coverageReasoning: string;
  manualReferences: Array<{
    documentTitle: string;
    excerpt: string;
    reason: string;
  }>;
  requiredInfo: string[];
  dmsPayloadDraft: {
    claimType: string;
    partNumber: string;
    partDescription: string;
    customerName: string;
    roNumber: string;
    invoiceNumber: string;
    orderNumber: string;
    vin: string;
    mileage: string;
    invoiceDate: string;
    workOrderDate: string;
    serviceStartDate: string;
    serviceEndDate: string;
    purchaseDate: string;
    installDate: string;
    failureDate: string;
    quantity: string;
    laborHours: string;
    jobTimeCode: string;
    technicianName: string;
    dealerNumber: string;
    authorizationNumber: string;
    customerConcernCode: string;
    conditionCode: string;
    carrierName: string;
    bolNumber: string;
    returnAuthorizationNumber: string;
    complaint: string;
    cause: string;
    correction: string;
    failureCode: string;
    causalPart: string;
    requestedAction: string;
    notes: string;
  };
  nextSteps: string[];
  dms: {
    status: "not_configured" | "ready_for_mapping";
    nextStep: string;
  };
};

export type WarrantyRmaSubmission = {
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
};

export type WarrantyRmaUploadedFile = {
  name: string;
  mimeType: string;
  buffer: Buffer;
};

export type WarrantyRmaIntakeExtraction = {
  status: "extracted" | "needs_review" | "unsupported" | "disabled";
  confidence: number;
  summary: string;
  fields: {
    claimType: string;
    partNumber: string;
    partDescription: string;
    customerName: string;
    roNumber: string;
    invoiceNumber: string;
    orderNumber: string;
    vin: string;
    mileage: string;
    invoiceDate: string;
    workOrderDate: string;
    serviceStartDate: string;
    serviceEndDate: string;
    purchaseDate: string;
    installDate: string;
    failureDate: string;
    quantity: string;
    laborHours: string;
    jobTimeCode: string;
    technicianName: string;
    dealerNumber: string;
    authorizationNumber: string;
    customerConcernCode: string;
    conditionCode: string;
    carrierName: string;
    bolNumber: string;
    returnAuthorizationNumber: string;
    symptom: string;
    cause: string;
    correction: string;
    requestedAction: string;
  };
  requiredInfo: string[];
  evidenceNotes: string[];
  sourceFiles: Array<{
    fileName: string;
    evidenceType: string;
    notes: string;
  }>;
};

const WARRANTY_RMA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "confidence",
    "summary",
    "coverageReasoning",
    "manualReferences",
    "requiredInfo",
    "dmsPayloadDraft",
    "nextSteps",
    "dms"
  ],
  properties: {
    status: { type: "string", enum: ["likely_warranty", "needs_review", "likely_not_covered", "unknown"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    summary: { type: "string" },
    coverageReasoning: { type: "string" },
    manualReferences: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["documentTitle", "excerpt", "reason"],
        properties: {
          documentTitle: { type: "string" },
          excerpt: { type: "string" },
          reason: { type: "string" }
        }
      }
    },
    requiredInfo: { type: "array", items: { type: "string" } },
    dmsPayloadDraft: {
      type: "object",
      additionalProperties: false,
      required: [
        "claimType",
        "partNumber",
        "partDescription",
        "customerName",
        "roNumber",
        "invoiceNumber",
        "orderNumber",
        "vin",
        "mileage",
        "invoiceDate",
        "workOrderDate",
        "serviceStartDate",
        "serviceEndDate",
        "purchaseDate",
        "installDate",
        "failureDate",
        "quantity",
        "laborHours",
        "jobTimeCode",
        "technicianName",
        "dealerNumber",
        "authorizationNumber",
        "customerConcernCode",
        "conditionCode",
        "carrierName",
        "bolNumber",
        "returnAuthorizationNumber",
        "complaint",
        "cause",
        "correction",
        "failureCode",
        "causalPart",
        "requestedAction",
        "notes"
      ],
      properties: {
        partNumber: { type: "string" },
        claimType: { type: "string" },
        partDescription: { type: "string" },
        customerName: { type: "string" },
        roNumber: { type: "string" },
        invoiceNumber: { type: "string" },
        orderNumber: { type: "string" },
        vin: { type: "string" },
        mileage: { type: "string" },
        invoiceDate: { type: "string" },
        workOrderDate: { type: "string" },
        serviceStartDate: { type: "string" },
        serviceEndDate: { type: "string" },
        purchaseDate: { type: "string" },
        installDate: { type: "string" },
        failureDate: { type: "string" },
        quantity: { type: "string" },
        laborHours: { type: "string" },
        jobTimeCode: { type: "string" },
        technicianName: { type: "string" },
        dealerNumber: { type: "string" },
        authorizationNumber: { type: "string" },
        customerConcernCode: { type: "string" },
        conditionCode: { type: "string" },
        carrierName: { type: "string" },
        bolNumber: { type: "string" },
        returnAuthorizationNumber: { type: "string" },
        complaint: { type: "string" },
        cause: { type: "string" },
        correction: { type: "string" },
        failureCode: { type: "string" },
        causalPart: { type: "string" },
        requestedAction: { type: "string" },
        notes: { type: "string" }
      }
    },
    nextSteps: { type: "array", items: { type: "string" } },
    dms: {
      type: "object",
      additionalProperties: false,
      required: ["status", "nextStep"],
      properties: {
        status: { type: "string", enum: ["not_configured", "ready_for_mapping"] },
        nextStep: { type: "string" }
      }
    }
  }
};

function fallbackReview(submission: WarrantyRmaSubmission, reason: string): WarrantyRmaReview {
  const partNumber = String(submission.partNumber ?? "").trim();
  const issue = String(submission.issueDescription ?? "").trim();
  return {
    status: "unknown",
    confidence: 0,
    summary: partNumber ? `Warranty/RMA review needed for ${partNumber}.` : "Warranty/RMA review needed.",
    coverageReasoning: reason,
    manualReferences: [],
    requiredInfo: [
      "Warranty manual or policy reference",
      "Proof of purchase or repair order",
      "Part failure description",
      "Photos or technician notes when available"
    ],
    dmsPayloadDraft: {
      partNumber,
      claimType: String(submission.claimType ?? "").trim(),
      partDescription: String(submission.partDescription ?? "").trim(),
      customerName: String(submission.customerName ?? "").trim(),
      roNumber: String(submission.roNumber ?? "").trim(),
      invoiceNumber: String(submission.invoiceNumber ?? "").trim(),
      orderNumber: String(submission.orderNumber ?? "").trim(),
      vin: String(submission.vin ?? "").trim(),
      mileage: String(submission.mileage ?? "").trim(),
      invoiceDate: String(submission.invoiceDate ?? "").trim(),
      workOrderDate: String(submission.workOrderDate ?? "").trim(),
      serviceStartDate: String(submission.serviceStartDate ?? "").trim(),
      serviceEndDate: String(submission.serviceEndDate ?? "").trim(),
      purchaseDate: String(submission.purchaseDate ?? "").trim(),
      installDate: String(submission.installDate ?? "").trim(),
      failureDate: String(submission.failureDate ?? "").trim(),
      quantity: String(submission.quantity ?? "").trim(),
      laborHours: String(submission.laborHours ?? "").trim(),
      jobTimeCode: String(submission.jobTimeCode ?? "").trim(),
      technicianName: String(submission.technicianName ?? "").trim(),
      dealerNumber: String(submission.dealerNumber ?? "").trim(),
      authorizationNumber: String(submission.authorizationNumber ?? "").trim(),
      customerConcernCode: String(submission.customerConcernCode ?? "").trim(),
      conditionCode: String(submission.conditionCode ?? "").trim(),
      carrierName: String(submission.carrierName ?? "").trim(),
      bolNumber: String(submission.bolNumber ?? "").trim(),
      returnAuthorizationNumber: String(submission.returnAuthorizationNumber ?? "").trim(),
      complaint: issue,
      cause: String(submission.cause ?? "").trim(),
      correction: String(submission.correction ?? "").trim(),
      failureCode: "",
      causalPart: partNumber,
      requestedAction: String(submission.requestedAction ?? "").trim() || "Review warranty/RMA eligibility",
      notes: reason
    },
    nextSteps: [
      "Review the warranty manual and supporting documents.",
      "Confirm proof of purchase, install date, and failure details.",
      "Submit to the DMS only after the DMS API mapping is configured."
    ],
    dms: {
      status: "not_configured",
      nextStep: "Connect the dealer management system API and map required warranty/RMA fields."
    }
  };
}

function fileInput(document: WarrantyRmaManualDocument, buffer: Buffer): any | null {
  const mime = document.mimeType || "application/octet-stream";
  const data = buffer.toString("base64");
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
      filename: safeFileName(document.fileName, "warranty-manual.pdf"),
      file_data: `data:application/pdf;base64,${data}`
    };
  }
  if (/^(text\/|application\/json|application\/xml)/i.test(mime) || /\.(txt|md|csv|json|xml)$/i.test(document.fileName)) {
    return {
      type: "input_text",
      text: `Document: ${document.title}\n\n${buffer.toString("utf8").slice(0, 90000)}`
    };
  }
  return null;
}

function uploadedFileInput(file: WarrantyRmaUploadedFile): any | null {
  const mime = file.mimeType || "application/octet-stream";
  const data = file.buffer.toString("base64");
  if (mime.startsWith("image/")) {
    return {
      type: "input_image",
      image_url: `data:${mime};base64,${data}`,
      detail: "high"
    };
  }
  if (mime === "application/pdf" || /\.pdf$/i.test(file.name)) {
    return {
      type: "input_file",
      filename: safeFileName(file.name, "warranty-rma-intake.pdf"),
      file_data: `data:application/pdf;base64,${data}`
    };
  }
  if (/^(text\/|application\/json|application\/xml)/i.test(mime) || /\.(txt|md|csv|json|xml)$/i.test(file.name)) {
    return {
      type: "input_text",
      text: `Evidence file: ${file.name}\n\n${file.buffer.toString("utf8").slice(0, 90000)}`
    };
  }
  return null;
}

async function manualInputs(documents: WarrantyRmaManualDocument[]) {
  const content: any[] = [];
  const maxDocuments = Math.max(1, Math.min(20, Number(process.env.WARRANTY_RMA_MAX_REVIEW_DOCUMENTS ?? 12)));
  for (const document of documents.slice(0, maxDocuments)) {
    const buffer = await fs.readFile(document.storagePath).catch(() => null);
    if (!buffer) continue;
    const input = fileInput(document, buffer);
    if (!input) continue;
    content.push({
      type: "input_text",
      text: [
        `Warranty/RMA reference document: ${document.title}`,
        `File: ${document.fileName}`,
        document.documentType ? `Type: ${document.documentType}` : "",
        document.notes ? `Notes: ${document.notes}` : ""
      ]
        .filter(Boolean)
        .join("\n")
    });
    content.push(input);
  }
  return content;
}

function vectorReferenceInputs(matches: WarrantyRmaVectorMatch[]) {
  return matches.slice(0, 12).map(match => ({
    type: "input_text",
    text: [
      "Warranty/RMA retrieved reference excerpt:",
      `Document: ${match.title || match.fileName || match.manualId}`,
      match.fileName ? `File: ${match.fileName}` : "",
      match.documentType ? `Type: ${match.documentType}` : "",
      `Chunk: ${match.chunkIndex + 1}${match.chunkCount ? ` of ${match.chunkCount}` : ""}`,
      `Score: ${Number.isFinite(match.score) ? match.score.toFixed(4) : "n/a"}`,
      "",
      match.text
    ]
      .filter(Boolean)
      .join("\n")
  }));
}

function normalizeReview(raw: any, fallback: WarrantyRmaReview): WarrantyRmaReview {
  const review = raw && typeof raw === "object" ? raw : {};
  return {
    status: ["likely_warranty", "needs_review", "likely_not_covered", "unknown"].includes(review.status)
      ? review.status
      : fallback.status,
    confidence: Math.max(0, Math.min(1, Number(review.confidence ?? 0))),
    summary: String(review.summary ?? fallback.summary).trim(),
    coverageReasoning: String(review.coverageReasoning ?? fallback.coverageReasoning).trim(),
    manualReferences: Array.isArray(review.manualReferences)
      ? review.manualReferences
          .map((row: any) => ({
            documentTitle: String(row?.documentTitle ?? "").trim(),
            excerpt: String(row?.excerpt ?? "").trim(),
            reason: String(row?.reason ?? "").trim()
          }))
          .filter((row: any) => row.documentTitle || row.excerpt || row.reason)
          .slice(0, 8)
      : [],
    requiredInfo: Array.isArray(review.requiredInfo)
      ? review.requiredInfo.map((value: unknown) => String(value)).filter(Boolean).slice(0, 12)
      : fallback.requiredInfo,
    dmsPayloadDraft: {
      claimType: String(review.dmsPayloadDraft?.claimType ?? fallback.dmsPayloadDraft.claimType).trim(),
      partNumber: String(review.dmsPayloadDraft?.partNumber ?? fallback.dmsPayloadDraft.partNumber).trim(),
      partDescription: String(review.dmsPayloadDraft?.partDescription ?? fallback.dmsPayloadDraft.partDescription).trim(),
      customerName: String(review.dmsPayloadDraft?.customerName ?? fallback.dmsPayloadDraft.customerName).trim(),
      roNumber: String(review.dmsPayloadDraft?.roNumber ?? fallback.dmsPayloadDraft.roNumber).trim(),
      invoiceNumber: String(review.dmsPayloadDraft?.invoiceNumber ?? fallback.dmsPayloadDraft.invoiceNumber).trim(),
      orderNumber: String(review.dmsPayloadDraft?.orderNumber ?? fallback.dmsPayloadDraft.orderNumber).trim(),
      vin: String(review.dmsPayloadDraft?.vin ?? fallback.dmsPayloadDraft.vin).trim(),
      mileage: String(review.dmsPayloadDraft?.mileage ?? fallback.dmsPayloadDraft.mileage).trim(),
      invoiceDate: String(review.dmsPayloadDraft?.invoiceDate ?? fallback.dmsPayloadDraft.invoiceDate).trim(),
      workOrderDate: String(review.dmsPayloadDraft?.workOrderDate ?? fallback.dmsPayloadDraft.workOrderDate).trim(),
      serviceStartDate: String(review.dmsPayloadDraft?.serviceStartDate ?? fallback.dmsPayloadDraft.serviceStartDate).trim(),
      serviceEndDate: String(review.dmsPayloadDraft?.serviceEndDate ?? fallback.dmsPayloadDraft.serviceEndDate).trim(),
      purchaseDate: String(review.dmsPayloadDraft?.purchaseDate ?? fallback.dmsPayloadDraft.purchaseDate).trim(),
      installDate: String(review.dmsPayloadDraft?.installDate ?? fallback.dmsPayloadDraft.installDate).trim(),
      failureDate: String(review.dmsPayloadDraft?.failureDate ?? fallback.dmsPayloadDraft.failureDate).trim(),
      quantity: String(review.dmsPayloadDraft?.quantity ?? fallback.dmsPayloadDraft.quantity).trim(),
      laborHours: String(review.dmsPayloadDraft?.laborHours ?? fallback.dmsPayloadDraft.laborHours).trim(),
      jobTimeCode: String(review.dmsPayloadDraft?.jobTimeCode ?? fallback.dmsPayloadDraft.jobTimeCode).trim(),
      technicianName: String(review.dmsPayloadDraft?.technicianName ?? fallback.dmsPayloadDraft.technicianName).trim(),
      dealerNumber: String(review.dmsPayloadDraft?.dealerNumber ?? fallback.dmsPayloadDraft.dealerNumber).trim(),
      authorizationNumber: String(review.dmsPayloadDraft?.authorizationNumber ?? fallback.dmsPayloadDraft.authorizationNumber).trim(),
      customerConcernCode: String(review.dmsPayloadDraft?.customerConcernCode ?? fallback.dmsPayloadDraft.customerConcernCode).trim(),
      conditionCode: String(review.dmsPayloadDraft?.conditionCode ?? fallback.dmsPayloadDraft.conditionCode).trim(),
      carrierName: String(review.dmsPayloadDraft?.carrierName ?? fallback.dmsPayloadDraft.carrierName).trim(),
      bolNumber: String(review.dmsPayloadDraft?.bolNumber ?? fallback.dmsPayloadDraft.bolNumber).trim(),
      returnAuthorizationNumber: String(review.dmsPayloadDraft?.returnAuthorizationNumber ?? fallback.dmsPayloadDraft.returnAuthorizationNumber).trim(),
      complaint: String(review.dmsPayloadDraft?.complaint ?? fallback.dmsPayloadDraft.complaint).trim(),
      cause: String(review.dmsPayloadDraft?.cause ?? fallback.dmsPayloadDraft.cause).trim(),
      correction: String(review.dmsPayloadDraft?.correction ?? fallback.dmsPayloadDraft.correction).trim(),
      failureCode: String(review.dmsPayloadDraft?.failureCode ?? "").trim(),
      causalPart: String(review.dmsPayloadDraft?.causalPart ?? fallback.dmsPayloadDraft.causalPart).trim(),
      requestedAction: String(review.dmsPayloadDraft?.requestedAction ?? fallback.dmsPayloadDraft.requestedAction).trim(),
      notes: String(review.dmsPayloadDraft?.notes ?? fallback.dmsPayloadDraft.notes).trim()
    },
    nextSteps: Array.isArray(review.nextSteps)
      ? review.nextSteps.map((value: unknown) => String(value)).filter(Boolean).slice(0, 12)
      : fallback.nextSteps,
    dms: {
      status: review.dms?.status === "ready_for_mapping" ? "ready_for_mapping" : "not_configured",
      nextStep: String(review.dms?.nextStep ?? fallback.dms.nextStep).trim()
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

function emptyIntakeFields(): WarrantyRmaIntakeExtraction["fields"] {
  return {
    claimType: "",
    partNumber: "",
    partDescription: "",
    customerName: "",
    roNumber: "",
    invoiceNumber: "",
    orderNumber: "",
    vin: "",
    mileage: "",
    invoiceDate: "",
    workOrderDate: "",
    serviceStartDate: "",
    serviceEndDate: "",
    purchaseDate: "",
    installDate: "",
    failureDate: "",
    quantity: "",
    laborHours: "",
    jobTimeCode: "",
    technicianName: "",
    dealerNumber: "",
    authorizationNumber: "",
    customerConcernCode: "",
    conditionCode: "",
    carrierName: "",
    bolNumber: "",
    returnAuthorizationNumber: "",
    symptom: "",
    cause: "",
    correction: "",
    requestedAction: ""
  };
}

const WARRANTY_RMA_INTAKE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "confidence", "summary", "fields", "requiredInfo", "evidenceNotes", "sourceFiles"],
  properties: {
    status: { type: "string", enum: ["extracted", "needs_review", "unsupported", "disabled"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    summary: { type: "string" },
    fields: {
      type: "object",
      additionalProperties: false,
      required: Object.keys(emptyIntakeFields()),
      properties: Object.fromEntries(Object.keys(emptyIntakeFields()).map(key => [key, { type: "string" }]))
    },
    requiredInfo: { type: "array", items: { type: "string" } },
    evidenceNotes: { type: "array", items: { type: "string" } },
    sourceFiles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fileName", "evidenceType", "notes"],
        properties: {
          fileName: { type: "string" },
          evidenceType: { type: "string" },
          notes: { type: "string" }
        }
      }
    }
  }
};

function fallbackIntakeExtraction(files: WarrantyRmaUploadedFile[], reason: string): WarrantyRmaIntakeExtraction {
  return {
    status: process.env.LLM_ENABLED === "1" ? "needs_review" : "disabled",
    confidence: 0,
    summary: reason,
    fields: emptyIntakeFields(),
    requiredInfo: [
      "Part number",
      "Issue description",
      "Customer, repair order, invoice, VIN, or work order details when available"
    ],
    evidenceNotes: files.map(file => `${file.name}: uploaded for manual review.`),
    sourceFiles: files.map(file => ({
      fileName: file.name,
      evidenceType: "unclassified",
      notes: reason
    }))
  };
}

function normalizeIntakeExtraction(raw: any, fallback: WarrantyRmaIntakeExtraction): WarrantyRmaIntakeExtraction {
  const value = raw && typeof raw === "object" ? raw : {};
  const rawFields = value.fields && typeof value.fields === "object" ? value.fields : {};
  const fields = emptyIntakeFields();
  for (const key of Object.keys(fields) as Array<keyof WarrantyRmaIntakeExtraction["fields"]>) {
    fields[key] = String(rawFields[key] ?? "").trim();
  }
  const status = ["extracted", "needs_review", "unsupported", "disabled"].includes(value.status)
    ? value.status as WarrantyRmaIntakeExtraction["status"]
    : fallback.status;
  return {
    status,
    confidence: Math.max(0, Math.min(1, Number(value.confidence ?? 0))),
    summary: String(value.summary ?? fallback.summary).trim(),
    fields,
    requiredInfo: Array.isArray(value.requiredInfo)
      ? value.requiredInfo.map((item: unknown) => String(item)).filter(Boolean).slice(0, 20)
      : fallback.requiredInfo,
    evidenceNotes: Array.isArray(value.evidenceNotes)
      ? value.evidenceNotes.map((item: unknown) => String(item)).filter(Boolean).slice(0, 20)
      : fallback.evidenceNotes,
    sourceFiles: Array.isArray(value.sourceFiles)
      ? value.sourceFiles
          .map((row: any) => ({
            fileName: String(row?.fileName ?? "").trim(),
            evidenceType: String(row?.evidenceType ?? "").trim(),
            notes: String(row?.notes ?? "").trim()
          }))
          .filter((row: any) => row.fileName || row.evidenceType || row.notes)
          .slice(0, 12)
      : fallback.sourceFiles
  };
}

function safeFileName(name: string, fallback: string) {
  const ext = (name.match(/\.[a-z0-9]{1,8}$/i)?.[0] ?? ".pdf").toLowerCase();
  const base = name
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${base || fallback.replace(/\.[a-z0-9]{1,8}$/i, "")}${ext}`;
}

export async function extractWarrantyRmaIntake(files: WarrantyRmaUploadedFile[]): Promise<WarrantyRmaIntakeExtraction> {
  const usableFiles = files
    .map(file => ({
      name: String(file.name ?? "").trim() || "warranty-rma-evidence",
      mimeType: String(file.mimeType ?? "").trim() || "application/octet-stream",
      buffer: file.buffer
    }))
    .filter(file => file.buffer?.length);
  const fallback = fallbackIntakeExtraction(usableFiles, "LLM warranty/RMA intake extraction is not enabled.");
  if (!usableFiles.length) {
    return fallbackIntakeExtraction([], "Upload at least one photo, PDF, invoice, repair order, or note.");
  }
  if (process.env.LLM_ENABLED !== "1" || !process.env.OPENAI_API_KEY) {
    return fallback;
  }

  const content: any[] = [];
  for (const file of usableFiles.slice(0, 8)) {
    const input = uploadedFileInput(file);
    if (!input) continue;
    content.push({
      type: "input_text",
      text: [
        `Evidence file: ${file.name}`,
        `MIME type: ${file.mimeType}`,
        "Extract only facts visibly present in this evidence or directly stated in its text."
      ].join("\n")
    });
    content.push(input);
  }
  if (!content.length) {
    return fallbackIntakeExtraction(usableFiles, "Uploaded files are not supported for warranty/RMA intake extraction.");
  }

  const model = process.env.OPENAI_WARRANTY_RMA_INTAKE_MODEL || process.env.OPENAI_WARRANTY_RMA_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const prompt = [
    "You are a Harley-Davidson dealership warranty/RMA administrator intake assistant.",
    "Read the uploaded evidence files, photos, invoices, repair orders, work orders, customer notes, and labels.",
    "Extract structured claim intake facts for a warranty or return-merchandise authorization submission.",
    "Do not guess. Leave fields blank unless the value is visible or explicitly stated.",
    "Normalize VINs, part numbers, dates, repair order numbers, invoice numbers, customer names, mileage, quantity, labor hours, and job time codes when present.",
    "Extract service start/end dates, authorization numbers, customer concern codes, condition codes, carrier names, BOL numbers, and return authorization numbers when present.",
    "Use claimType for likely categories such as warranty, RMA, parts warranty, goodwill, recall, freight/shipping damage, or unknown.",
    "Use symptom for the customer/technician complaint, cause for known diagnosis, and correction for repair/replacement action.",
    "requiredInfo should list only missing items that would likely block a clean claim review or DMS submission.",
    "Return only the structured JSON schema."
  ].join("\n");

  try {
    const resp = await (openaiClient().responses as any).create({
      model,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: prompt }, ...content] as any[]
        }
      ],
      max_output_tokens: 2400,
      text: {
        format: {
          type: "json_schema",
          name: "warranty_rma_intake_extraction",
          schema: WARRANTY_RMA_INTAKE_SCHEMA,
          strict: true
        }
      }
    });
    recordOpenAIUsage(resp, {
      feature: "warranty_rma",
      operation: "extract_intake",
      requestKind: "responses.create",
      model,
      metadata: {
        fileCount: usableFiles.length,
        fileNames: usableFiles.map(file => file.name).slice(0, 8).join(", ")
      }
    });
    return normalizeIntakeExtraction(parsedResponsePayload(resp), fallback);
  } catch (err: any) {
    return fallbackIntakeExtraction(
      usableFiles,
      err?.message ? `Warranty/RMA intake extraction failed: ${err.message}` : "Warranty/RMA intake extraction failed."
    );
  }
}

export async function analyzeWarrantyRmaSubmission(args: {
  submission: WarrantyRmaSubmission;
  manuals: WarrantyRmaManualDocument[];
}): Promise<WarrantyRmaReview> {
  const fallback = fallbackReview(args.submission, "Warranty/RMA manual review is not available.");
  if (!String(args.submission.partNumber ?? "").trim()) {
    return fallbackReview(args.submission, "Part number is required before warranty/RMA review.");
  }
  if (!String(args.submission.issueDescription ?? "").trim()) {
    return fallbackReview(args.submission, "Issue description is required before warranty/RMA review.");
  }
  if (process.env.LLM_ENABLED !== "1" || !process.env.OPENAI_API_KEY) {
    return fallbackReview(args.submission, "LLM warranty/RMA review is not enabled.");
  }

  const vectorMatches = await searchWarrantyRmaManualChunks({
    query: warrantyRmaVectorQueryForSubmission(args.submission),
    manualIds: args.manuals.map(manual => manual.id),
    topK: Number(process.env.WARRANTY_RMA_VECTOR_TOP_K ?? 8)
  }).catch(() => []);
  const inputs = vectorMatches.length ? vectorReferenceInputs(vectorMatches) : await manualInputs(args.manuals);
  if (!inputs.length) {
    return fallbackReview(args.submission, "No warranty/RMA manual documents are available for review.");
  }

  const model = process.env.OPENAI_WARRANTY_RMA_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const prompt = [
    "You are LeadRider's dealership warranty and return-merchandise authorization assistant.",
    vectorMatches.length
      ? "Review the submitted part issue against the retrieved warranty manual, policy, and parts-reference excerpts."
      : "Review the submitted part issue against the uploaded warranty manuals, policy documents, and parts references.",
    "Return only the structured JSON schema.",
    "Do not invent coverage. If the manuals do not clearly answer the issue, use needs_review or unknown.",
    "Use likely_warranty only when the document support is clear. Use likely_not_covered only when an exclusion or non-covered condition is clear.",
    vectorMatches.length
      ? "Use retrieved excerpts first. If a retrieved excerpt is not enough to support the answer, say what is missing instead of guessing."
      : "",
    "Use short manualReferences excerpts from the reference material. Do not include long copyrighted passages.",
    "Build a DMS payload draft, but keep dms.status as not_configured unless a DMS API mapping is explicitly available in system configuration.",
    "",
    "Submission:",
    args.submission.claimType ? `Claim type: ${args.submission.claimType}` : "",
    `Part number: ${args.submission.partNumber}`,
    args.submission.partDescription ? `Part description: ${args.submission.partDescription}` : "",
    `Issue: ${args.submission.issueDescription}`,
    args.submission.customerName ? `Customer: ${args.submission.customerName}` : "",
    args.submission.roNumber ? `Repair order: ${args.submission.roNumber}` : "",
    args.submission.invoiceNumber ? `Invoice: ${args.submission.invoiceNumber}` : "",
    args.submission.orderNumber ? `Order: ${args.submission.orderNumber}` : "",
    args.submission.vin ? `VIN: ${args.submission.vin}` : "",
    args.submission.mileage ? `Mileage: ${args.submission.mileage}` : "",
    args.submission.invoiceDate ? `Invoice date: ${args.submission.invoiceDate}` : "",
    args.submission.workOrderDate ? `Work order date: ${args.submission.workOrderDate}` : "",
    args.submission.serviceStartDate ? `Service start date: ${args.submission.serviceStartDate}` : "",
    args.submission.serviceEndDate ? `Service end date: ${args.submission.serviceEndDate}` : "",
    args.submission.purchaseDate ? `Purchase date: ${args.submission.purchaseDate}` : "",
    args.submission.installDate ? `Install date: ${args.submission.installDate}` : "",
    args.submission.failureDate ? `Failure date: ${args.submission.failureDate}` : "",
    args.submission.quantity ? `Quantity: ${args.submission.quantity}` : "",
    args.submission.laborHours ? `Labor hours: ${args.submission.laborHours}` : "",
    args.submission.jobTimeCode ? `Job time code: ${args.submission.jobTimeCode}` : "",
    args.submission.technicianName ? `Technician: ${args.submission.technicianName}` : "",
    args.submission.dealerNumber ? `Dealer number: ${args.submission.dealerNumber}` : "",
    args.submission.authorizationNumber ? `Authorization number: ${args.submission.authorizationNumber}` : "",
    args.submission.customerConcernCode ? `Customer concern code: ${args.submission.customerConcernCode}` : "",
    args.submission.conditionCode ? `Condition code: ${args.submission.conditionCode}` : "",
    args.submission.carrierName ? `Carrier: ${args.submission.carrierName}` : "",
    args.submission.bolNumber ? `BOL number: ${args.submission.bolNumber}` : "",
    args.submission.returnAuthorizationNumber ? `Return authorization: ${args.submission.returnAuthorizationNumber}` : "",
    args.submission.cause ? `Cause: ${args.submission.cause}` : "",
    args.submission.correction ? `Correction: ${args.submission.correction}` : "",
    args.submission.requestedAction ? `Requested action: ${args.submission.requestedAction}` : "",
    args.submission.notes ? `Internal notes: ${args.submission.notes}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const resp = await (openaiClient().responses as any).create({
      model,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: prompt }, ...inputs] as any[]
        }
      ],
      max_output_tokens: 3600,
      text: {
        format: {
          type: "json_schema",
          name: "warranty_rma_review",
          schema: WARRANTY_RMA_SCHEMA,
          strict: true
        }
      }
    });
    recordOpenAIUsage(resp, {
      feature: "warranty_rma",
      operation: "review_submission",
      requestKind: "responses.create",
      model,
      metadata: {
        manualCount: args.manuals.length,
        referenceMode: vectorMatches.length ? "pinecone_vector" : "uploaded_document",
        vectorMatchCount: vectorMatches.length,
        partNumber: args.submission.partNumber
      }
    });
    return normalizeReview(parsedResponsePayload(resp), fallback);
  } catch (err: any) {
    return fallbackReview(args.submission, err?.message ? `Warranty/RMA review failed: ${err.message}` : "Warranty/RMA review failed.");
  }
}
