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

function fileContentInputs(files: MdfUploadedFile[]) {
  const content: any[] = [];
  files.forEach((file, index) => {
    const input = fileInput(file);
    if (!input) return;
    const role = file.providedRole || inferRoleFromName(file.name);
    content.push({
      type: "input_text",
      text: `File ${index + 1}: ${file.name}. User-selected role: ${role}.`
    });
    content.push(input);
  });
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

function normalizePacket(raw: any, files: MdfUploadedFile[]): MdfClaimPacket {
  const fallback = fallbackPacket(files, "Extractor returned incomplete data.");
  const packet = raw && typeof raw === "object" ? raw : {};
  return {
    claimType: ["media", "event", "map_only", "unknown"].includes(packet.claimType) ? packet.claimType : fallback.claimType,
    activityType: String(packet.activityType ?? ""),
    confidence: Math.max(0, Math.min(1, Number(packet.confidence ?? 0))),
    extractedFields: {
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
    },
    descriptionDraft: String(packet.descriptionDraft ?? ""),
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

function mergeInvoiceFields(packet: MdfClaimPacket, invoicePacket: MdfClaimPacket): MdfClaimPacket {
  const invoiceKeys: Array<keyof MdfClaimPacket["extractedFields"]> = [
    "vendorName",
    "invoiceDate",
    "invoiceNumber",
    "spend"
  ];
  const extractedFields = { ...packet.extractedFields };
  for (const key of invoiceKeys) {
    const value = String(invoicePacket.extractedFields[key] ?? "").trim();
    if (value) extractedFields[key] = value;
  }
  const missingFields = packet.missingFields.filter(field => {
    const normalized = field.toLowerCase();
    if (extractedFields.vendorName && normalized.includes("vendor")) return false;
    if (extractedFields.invoiceDate && normalized.includes("invoice date")) return false;
    if (extractedFields.invoiceNumber && normalized.includes("invoice number")) return false;
    if (extractedFields.spend && normalized.includes("spend")) return false;
    return true;
  });
  return {
    ...packet,
    confidence: Math.max(packet.confidence || 0, invoicePacket.confidence || 0),
    extractedFields,
    missingFields
  };
}

async function extractInvoiceFields(files: MdfUploadedFile[], model: string): Promise<MdfClaimPacket | null> {
  const invoiceFiles = files.filter(file => {
    const role = file.providedRole || inferRoleFromName(file.name);
    return role === "invoice" || role === "receipt";
  });
  if (!invoiceFiles.length) return null;
  const inputs = fileContentInputs(invoiceFiles);
  if (!inputs.length) return null;
  const prompt = [
    "Extract ONLY invoice/payment fields from these MDF invoice or receipt files.",
    "Return the same MDF claim packet schema.",
    "Fill vendorName, invoiceDate, invoiceNumber, and spend when visible.",
    "Do not use artwork, tear sheets, magazine cover dates, or proof screenshots as invoice facts.",
    "Leave unknown fields blank and list missing invoice fields in missingFields.",
    "Set uploadedFiles roles to invoice or receipt based on the provided role."
  ].join("\n");
  const resp = await client.responses.parse({
    model,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: prompt }, ...inputs] as any[]
      }
    ],
    max_output_tokens: 1200,
    text: {
      format: {
        type: "json_schema",
        name: "mdf_invoice_fields",
        schema: MDF_SCHEMA,
        strict: true
      }
    }
  });
  recordOpenAIUsage(resp, {
    feature: "mdf_assistant",
    operation: "extract_invoice_fields",
    requestKind: "responses.parse",
    model,
    metadata: { fileCount: invoiceFiles.length }
  });
  return normalizePacket(parsedResponsePayload(resp), invoiceFiles);
}

export async function extractMdfClaimPacket(files: MdfUploadedFile[], notes: string): Promise<MdfClaimPacket> {
  if (!files.length) return fallbackPacket(files, "Upload at least one invoice, receipt, creative, or proof file.");
  const supportedInputs = fileContentInputs(files);
  if (!supportedInputs.length) {
    return fallbackPacket(files, "No supported PDF or image files were uploaded.");
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
    "- Use files marked creative, proof_of_performance, or supporting_only only for campaign description, proof, eligibility, documentation, and concerns.",
    "- If a magazine cover, tear sheet, screenshot, artwork, or proof file contains unrelated dates/prices/numbers, do not treat those as invoice fields.",
    "- If no invoice or receipt is provided, leave invoice/spend fields blank and list them as missing.",
    "- If evidence is missing or uncertain, do not guess. Put it in missingFields or eligibility.concerns.",
    "The portal should only be filled as a saved draft after human review. Never indicate final submit is automatic.",
    notes.trim() ? `Dealer notes: ${notes.trim()}` : "Dealer notes: none."
  ].join("\\n");

  try {
    const resp = await client.responses.parse({
      model,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: prompt }, ...supportedInputs] as any[]
        }
      ],
      max_output_tokens: 2200,
      text: {
        format: {
          type: "json_schema",
          name: "mdf_claim_packet",
          schema: MDF_SCHEMA,
          strict: true
        }
      }
    });
    recordOpenAIUsage(resp, {
      feature: "mdf_assistant",
      operation: "extract_claim_packet",
      requestKind: "responses.parse",
      model,
      metadata: { fileCount: files.length }
    });
    const packet = normalizePacket(parsedResponsePayload(resp), files);
    const invoicePacket = await extractInvoiceFields(files, model).catch(() => null);
    return invoicePacket ? mergeInvoiceFields(packet, invoicePacket) : packet;
  } catch (err: any) {
    return fallbackPacket(files, err?.message ? `Extractor failed: ${err.message}` : "Extractor failed.");
  }
}
