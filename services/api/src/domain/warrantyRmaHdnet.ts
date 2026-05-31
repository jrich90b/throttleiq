import type { WarrantyRmaReview, WarrantyRmaSubmission } from "./warrantyRmaAssistant.js";

export type HdnetClaimFormKind = "short" | "long";
export type HdnetDetailType = "Sublet" | "Note" | "Materials" | "Towing";

export type HdnetDraftInput = WarrantyRmaSubmission & {
  review?: WarrantyRmaReview;
  forceFormKind?: HdnetClaimFormKind;
  detailRows?: {
    labor8888?: Array<{
      laborCode?: string;
      hours?: string;
      comments?: string;
    }>;
    otherLabor?: Array<{
      laborCode?: string;
    }>;
    otherDetails?: Array<{
      type?: string;
      cost?: string;
      comments?: string;
    }>;
  };
};

export type HdnetDraftPacket = {
  formKind: HdnetClaimFormKind;
  formTitle: string;
  formSource: string;
  reason: string;
  fields: Record<string, string>;
  missing: string[];
  warnings: string[];
  detailRows: {
    labor8888: Array<{
      row: string;
      laborCode: string;
      hours: string;
      comments: string;
    }>;
    otherLabor: Array<{
      row: string;
      laborCode: string;
    }>;
    otherDetails: Array<{
      row: string;
      type: HdnetDetailType;
      cost: string;
      comments: string;
    }>;
  };
};

const SHORT_FORM_DETAIL_LIMIT = 14;
const LONG_OTHER_LABOR_ROWS = [
  "strLaborCode6",
  "strLaborCode8",
  "strLaborCode10",
  "strLaborCode12",
  "strLaborCode14",
  "strLaborCode16",
  "strLaborCode18",
  "strLaborCode20",
  "strLaborCode22",
  "strLaborCode24",
  "strLaborCode26",
  "strLaborCode28",
  "strLaborCode30",
  "strLaborCode32",
  "strLaborCode34",
  "strLaborCode36"
];
const LONG_OTHER_DETAIL_ROWS = ["37", "38", "39", "40"];
const LONG_LABOR_8888_ROWS = ["2", "4"];

const CLAIM_TYPE_TO_EVENT_TYPE: Record<string, { code: string; warning?: string }> = {
  motorcycle_warranty: { code: "MC" },
  parts_accessory_warranty: { code: "PNA" },
  pre_delivery_warranty: { code: "PRD" },
  freight_damage: { code: "FRT" },
  goodwill: { code: "GDW" },
  general_merchandise: { code: "GM" },
  engine_return: {
    code: "REM",
    warning: "Engine/core return mapped to REM. Confirm the exact H-Dnet claim type before submission."
  },
  parts_rma: {
    code: "",
    warning: "Parts RMA/return may use a return workflow instead of a Warranty-Link claim. Confirm the H-Dnet destination before entry."
  },
  recall_campaign: {
    code: "",
    warning: "Recall/campaign work may require the recall/campaign workflow instead of a standard warranty claim. Confirm before entry."
  }
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function prefer(...values: unknown[]): string {
  for (const value of values) {
    const cleaned = clean(value);
    if (cleaned) return cleaned;
  }
  return "";
}

function reviewField(input: HdnetDraftInput, key: keyof WarrantyRmaReview["dmsPayloadDraft"]): string {
  return prefer((input as Record<string, unknown>)[key], input.review?.dmsPayloadDraft?.[key]);
}

function two(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (!digits) return "";
  return digits.padStart(2, "0").slice(-2);
}

function dateParts(value: string): { mm: string; dd: string; yy: string } {
  const raw = clean(value);
  if (!raw) return { mm: "", dd: "", yy: "" };
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return { mm: two(iso[2]), dd: two(iso[3]), yy: iso[1].slice(-2) };
  const us = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (us) return { mm: two(us[1]), dd: two(us[2]), yy: us[3].slice(-2) };
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return {
      mm: two(String(parsed.getUTCMonth() + 1)),
      dd: two(String(parsed.getUTCDate())),
      yy: String(parsed.getUTCFullYear()).slice(-2)
    };
  }
  return { mm: "", dd: "", yy: "" };
}

function lastName(value: string): string {
  const parts = clean(value)
    .replace(/[,]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function limitField(label: string, value: string, max: number, warnings: string[]): string {
  const cleaned = clean(value);
  if (cleaned.length <= max) return cleaned;
  warnings.push(`${label} was shortened to ${max} characters for the H-Dnet field limit.`);
  return cleaned.slice(0, max);
}

function normalizeClaimType(value: string): string {
  const raw = clean(value).toLowerCase().replace(/[-\s]+/g, "_");
  if (!raw) return "";
  if (raw.includes("pna") || raw.includes("parts_accessory") || raw.includes("parts_warranty") || raw.includes("accessory")) return "parts_accessory_warranty";
  if (raw.includes("prd") || raw.includes("pre_delivery")) return "pre_delivery_warranty";
  if (raw.includes("frt") || raw.includes("freight") || raw.includes("shipping_damage")) return "freight_damage";
  if (raw.includes("rma") || raw.includes("return")) return "parts_rma";
  if (raw.includes("recall") || raw.includes("campaign")) return "recall_campaign";
  if (raw.includes("gdw") || raw.includes("goodwill")) return "goodwill";
  if (raw === "gm" || raw.includes("general_merchandise") || raw.includes("apparel")) return "general_merchandise";
  if (raw.includes("engine") || raw.includes("core") || raw.includes("longblock") || raw.includes("long_block") || raw.includes("rem")) return "engine_return";
  if (raw.includes("mc") || raw.includes("motorcycle") || raw.includes("vehicle")) return "motorcycle_warranty";
  return raw;
}

function normalizeDetailType(value: string): HdnetDetailType {
  const raw = clean(value).toLowerCase();
  if (raw.includes("sublet")) return "Sublet";
  if (raw.includes("material")) return "Materials";
  if (raw.includes("tow")) return "Towing";
  return "Note";
}

function addDateFields(fields: Record<string, string>, prefix: string, value: string) {
  const parts = dateParts(value);
  fields[`${prefix}MM`] = parts.mm;
  fields[`${prefix}DD`] = parts.dd;
  fields[`${prefix}YY`] = parts.yy;
}

function allDateFieldsPresent(fields: Record<string, string>, prefix: string): boolean {
  return Boolean(fields[`${prefix}MM`] && fields[`${prefix}DD`] && fields[`${prefix}YY`]);
}

function noteText(input: HdnetDraftInput): string {
  const issue = prefer(input.review?.dmsPayloadDraft.complaint, input.issueDescription);
  return [
    issue ? `Complaint: ${issue}` : "",
    reviewField(input, "cause") ? `Cause/diagnosis: ${reviewField(input, "cause")}` : "",
    reviewField(input, "correction") ? `Correction: ${reviewField(input, "correction")}` : "",
    reviewField(input, "requestedAction") ? `Requested action: ${reviewField(input, "requestedAction")}` : "",
    prefer(input.notes, input.review?.dmsPayloadDraft.notes)
  ]
    .map(clean)
    .filter(Boolean)
    .join("\n");
}

function missingIfEmpty(missing: string[], label: string, value: string) {
  if (!clean(value)) missing.push(label);
}

export function buildHdnetDraftPacket(input: HdnetDraftInput): HdnetDraftPacket {
  const warnings: string[] = [];
  const missing: string[] = [];
  const claimType = normalizeClaimType(reviewField(input, "claimType"));
  const eventType = CLAIM_TYPE_TO_EVENT_TYPE[claimType] ?? {
    code: "",
    warning: claimType ? `No safe H-Dnet event type code is mapped for ${claimType}; review the claim guide before entry.` : undefined
  };
  if (eventType.warning) warnings.push(eventType.warning);

  const fields: Record<string, string> = {};
  addDateFields(fields, "strStartDate", reviewField(input, "serviceStartDate") || reviewField(input, "workOrderDate"));
  addDateFields(fields, "strEndDate", reviewField(input, "serviceEndDate") || reviewField(input, "invoiceDate"));
  addDateFields(
    fields,
    "strProbDate",
    reviewField(input, "failureDate") || reviewField(input, "installDate") || reviewField(input, "serviceEndDate") || reviewField(input, "invoiceDate")
  );

  const problemDescription = prefer(input.review?.dmsPayloadDraft.complaint, input.issueDescription, reviewField(input, "notes"));
  fields.strCustName = limitField("Owner last name", lastName(reviewField(input, "customerName")), 33, warnings);
  fields.strCrankCase = "";
  fields.strVIN = limitField("VIN", reviewField(input, "vin"), 17, warnings).toUpperCase();
  fields.strMileage = limitField("Odometer reading", reviewField(input, "mileage"), 20, warnings);
  fields.strWorkOrder = limitField("Work order", prefer(reviewField(input, "roNumber"), reviewField(input, "orderNumber")), 15, warnings);
  fields.strEventType = limitField("Event type", eventType.code, 3, warnings);
  fields.strQty = limitField("Quantity", reviewField(input, "quantity") || "1", 3, warnings);
  fields.strProbPart = limitField("Problem part number", reviewField(input, "partNumber"), 19, warnings).toUpperCase();
  fields.strPrimaryLabor = limitField("Primary labor code", reviewField(input, "jobTimeCode"), 4, warnings);
  fields.strConcernCode = limitField("Customer concern code", reviewField(input, "customerConcernCode"), 4, warnings);
  fields.strConditionCode = limitField("Condition code", reviewField(input, "conditionCode"), 4, warnings);
  fields.strEventAuth = limitField("Dealer authorization code", reviewField(input, "authorizationNumber"), 6, warnings);
  fields.strProbDesc = limitField("Problem description", problemDescription, 30, warnings);
  fields.strNotes = noteText(input);

  if (fields.strProbPart || fields.strPrimaryLabor) {
    warnings.push(
      "Problem part and primary labor stay in H-Dnet header fields; H-Dnet auto-creates those event detail items, so do not duplicate them in detail rows."
    );
  }
  if (claimType === "goodwill" && !fields.strEventAuth) {
    missing.push("Technical Services authorization number");
  }

  if (!allDateFieldsPresent(fields, "strStartDate")) missing.push("Service start date");
  if (!allDateFieldsPresent(fields, "strEndDate")) missing.push("Service end date");
  if (!allDateFieldsPresent(fields, "strProbDate")) missing.push("Problem date");
  missingIfEmpty(missing, "Owner last name", fields.strCustName);
  if (!fields.strVIN && !fields.strCrankCase) missing.push("VIN or crankcase number");
  missingIfEmpty(missing, "Odometer reading", fields.strMileage);
  missingIfEmpty(missing, "Work order", fields.strWorkOrder);
  missingIfEmpty(missing, "Event type", fields.strEventType);
  missingIfEmpty(missing, "Quantity", fields.strQty);
  missingIfEmpty(missing, "Problem part number", fields.strProbPart);
  missingIfEmpty(missing, "Primary labor code", fields.strPrimaryLabor);
  missingIfEmpty(missing, "Customer concern code", fields.strConcernCode);
  missingIfEmpty(missing, "Condition code", fields.strConditionCode);
  missingIfEmpty(missing, "Problem description", fields.strProbDesc);

  const inputLabor8888 = input.detailRows?.labor8888 ?? [];
  const labor8888 =
    fields.strPrimaryLabor === "8888" && !inputLabor8888.length
      ? [
          {
            laborCode: "8888",
            hours: reviewField(input, "laborHours"),
            comments: limitField("Labor 8888 comments", fields.strNotes || fields.strProbDesc, 80, warnings)
          }
        ]
      : inputLabor8888.map(row => ({
          laborCode: limitField("Labor 8888 code", prefer(row.laborCode, "8888"), 4, warnings),
          hours: limitField("Labor 8888 hours", row.hours ?? "", 4, warnings),
          comments: limitField("Labor 8888 comments", row.comments ?? "", 80, warnings)
        }));

  const detailRows = {
    labor8888: labor8888.slice(0, LONG_LABOR_8888_ROWS.length).map((row, index) => ({
      row: LONG_LABOR_8888_ROWS[index],
      ...row
    })),
    otherLabor: (input.detailRows?.otherLabor ?? [])
      .map(row => ({
        laborCode: limitField("Other labor code", row.laborCode ?? "", 4, warnings)
      }))
      .filter(row => row.laborCode)
      .slice(0, LONG_OTHER_LABOR_ROWS.length)
      .map((row, index) => ({
        row: LONG_OTHER_LABOR_ROWS[index],
        ...row
      })),
    otherDetails: (input.detailRows?.otherDetails ?? [])
      .map(row => ({
        type: normalizeDetailType(row.type ?? ""),
        cost: limitField("Other detail cost", row.cost ?? "", 9, warnings),
        comments: limitField("Other detail comments", row.comments ?? "", 80, warnings)
      }))
      .filter(row => row.cost || row.comments)
      .slice(0, LONG_OTHER_DETAIL_ROWS.length)
      .map((row, index) => ({
        row: LONG_OTHER_DETAIL_ROWS[index],
        ...row
      }))
  };

  if ((input.detailRows?.labor8888?.length ?? 0) > LONG_LABOR_8888_ROWS.length) {
    warnings.push(`Only ${LONG_LABOR_8888_ROWS.length} labor 8888 rows fit in the inspected H-Dnet long claim form.`);
  }
  if ((input.detailRows?.otherLabor?.length ?? 0) > LONG_OTHER_LABOR_ROWS.length) {
    warnings.push(`Only ${LONG_OTHER_LABOR_ROWS.length} other labor rows fit in the inspected H-Dnet long claim form.`);
  }
  if ((input.detailRows?.otherDetails?.length ?? 0) > LONG_OTHER_DETAIL_ROWS.length) {
    warnings.push(`Only ${LONG_OTHER_DETAIL_ROWS.length} other detail rows fit in the inspected H-Dnet long claim form.`);
  }

  const detailCount = detailRows.labor8888.length + detailRows.otherLabor.length + detailRows.otherDetails.length;
  const formKind =
    input.forceFormKind ??
    (detailCount > SHORT_FORM_DETAIL_LIMIT || /\blong claim\b/i.test(`${input.notes ?? ""} ${input.requestedAction ?? ""}`)
      ? "long"
      : "short");
  const reason =
    formKind === "short"
      ? `Use H-Dnet short claim by default because ${detailCount} detail item${detailCount === 1 ? "" : "s"} fit under the ${SHORT_FORM_DETAIL_LIMIT}-item short-claim threshold.`
      : `Use H-Dnet long claim because the packet has ${detailCount} detail item${detailCount === 1 ? "" : "s"} or was explicitly marked for long-claim entry.`;

  return {
    formKind,
    formTitle: formKind === "short" ? "H-Dnet short warranty claim" : "H-Dnet long warranty claim",
    formSource: "H-Dnet Warranty-Link field names inspected from Add New Long Warranty Claim; short claim uses the same reviewed header packet where fields are present.",
    reason,
    fields,
    missing: Array.from(new Set(missing)),
    warnings: Array.from(new Set(warnings)),
    detailRows
  };
}
