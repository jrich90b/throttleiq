"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type WarrantyRmaStatus =
  | "draft"
  | "needs_info"
  | "ready_for_dms"
  | "dms_queued"
  | "submitted"
  | "closed"
  | "denied";

type WarrantyRmaManualDocument = {
  id: string;
  title: string;
  fileName: string;
  mimeType: string;
  size: number;
  url?: string;
  documentType?: "warranty_manual" | "policy" | "parts_reference" | "other";
  scope?: "global" | "dealer";
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

type WarrantyRmaReview = {
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

type WarrantyRmaCaseEntry = {
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
  dmsPush: {
    status: "not_configured" | "ready" | "queued" | "pushed" | "failed";
    message?: string;
    externalId?: string;
    updatedAt?: string;
  };
  createdAt: string;
  updatedAt: string;
};

type CaseForm = {
  claimType: string;
  partNumber: string;
  partDescription: string;
  issueDescription: string;
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
  cause: string;
  correction: string;
  requestedAction: string;
  notes: string;
};

const emptyCaseForm: CaseForm = {
  claimType: "",
  partNumber: "",
  partDescription: "",
  issueDescription: "",
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
  cause: "",
  correction: "",
  requestedAction: "",
  notes: ""
};

type WarrantyRmaIntakeExtraction = {
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

type WarrantyRmaVectorStatus = {
  configured: boolean;
  missing: string[];
  indexName: string;
  namespace: string;
  globalNamespace?: string;
  dealerNamespace?: string;
  legacyNamespace?: string;
  searchNamespaces?: string[];
  embeddingModel: string;
  apiVersion: string;
  hostConfigured: boolean;
};

const statusLabels: Record<WarrantyRmaStatus, string> = {
  draft: "Draft",
  needs_info: "Needs info",
  ready_for_dms: "Ready for handoff",
  dms_queued: "Handoff queued",
  submitted: "Submitted",
  closed: "Closed",
  denied: "Denied"
};

const statusClasses: Record<WarrantyRmaStatus, string> = {
  draft: "bg-slate-100 text-slate-700",
  needs_info: "bg-amber-100 text-amber-800",
  ready_for_dms: "bg-emerald-100 text-emerald-800",
  dms_queued: "bg-blue-100 text-blue-800",
  submitted: "bg-indigo-100 text-indigo-800",
  closed: "bg-slate-200 text-slate-800",
  denied: "bg-red-100 text-red-800"
};

const claimTypeOptions = [
  { value: "", label: "Unknown / let assistant classify" },
  { value: "motorcycle_warranty", label: "Warranty claim - motorcycle (MC)" },
  { value: "parts_accessory_warranty", label: "Parts/accessory warranty (PNA)" },
  { value: "pre_delivery_warranty", label: "Pre-delivery warranty (PRD)" },
  { value: "freight_damage", label: "Freight damage (FRT)" },
  { value: "parts_rma", label: "Parts RMA / return" },
  { value: "recall_campaign", label: "Recall / campaign" },
  { value: "goodwill", label: "Goodwill (GDW)" },
  { value: "general_merchandise", label: "General merchandise (GM)" },
  { value: "engine_return", label: "Engine/core return" },
  { value: "other", label: "Other" }
];

type RequirementItem = {
  label: string;
  fields?: Array<keyof CaseForm>;
  anyOf?: Array<keyof CaseForm>;
  detail?: string;
};

const requiredProfiles: Record<string, { source: string; items: RequirementItem[] }> = {
  unknown: {
    source: "Assistant classification + Claim Processing Guidelines",
    items: [
      { label: "Part number", fields: ["partNumber"] },
      { label: "Issue description", fields: ["issueDescription"] },
      { label: "Proof of purchase, invoice, work order, or order number", anyOf: ["invoiceNumber", "roNumber", "orderNumber"] },
      { label: "Supporting evidence", detail: "Attach photos, PDFs, repair orders, invoices, labels, or notes." },
      { label: "Customer, VIN, or merchandise context when available", anyOf: ["customerName", "vin", "partDescription"] }
    ]
  },
  motorcycle_warranty: {
    source: "MC Claim Processing Guide, Warranty Condition Codes, Customer Concern Codes",
    items: [
      { label: "Problem part number", fields: ["partNumber"] },
      { label: "Complaint / failure description", fields: ["issueDescription"] },
      { label: "VIN", fields: ["vin"] },
      { label: "Mileage at concern", fields: ["mileage"] },
      { label: "Work order number", fields: ["roNumber"] },
      { label: "Service start date", fields: ["serviceStartDate"] },
      { label: "Service end date", fields: ["serviceEndDate"] },
      { label: "Primary labor / job time code", anyOf: ["jobTimeCode", "laborHours"] },
      { label: "Customer concern code", fields: ["customerConcernCode"] },
      { label: "Condition code", fields: ["conditionCode"] },
      { label: "Diagnosis and correction", fields: ["cause", "correction"] }
    ]
  },
  parts_accessory_warranty: {
    source: "PNA Claim Type Processing Guide, Warranty Condition Codes, Customer Concern Codes",
    items: [
      { label: "Registered failed part or kit number", fields: ["partNumber"] },
      { label: "Part description", fields: ["partDescription"] },
      { label: "VIN", fields: ["vin"] },
      { label: "Mileage at concern", fields: ["mileage"] },
      { label: "Work order number", fields: ["roNumber"] },
      { label: "Service start date", fields: ["serviceStartDate"] },
      { label: "Service end date", fields: ["serviceEndDate"] },
      { label: "Primary labor / job time code", anyOf: ["jobTimeCode", "laborHours"] },
      { label: "Customer concern and condition codes", fields: ["customerConcernCode", "conditionCode"] },
      { label: "Confirm part is registered to VIN", detail: "Document check before TALON/Warranty-Link review." }
    ]
  },
  pre_delivery_warranty: {
    source: "PRD Claim Type Processing Guide, 2026 Loose Parts",
    items: [
      { label: "Problem part number", fields: ["partNumber"] },
      { label: "VIN", fields: ["vin"] },
      { label: "Mileage", fields: ["mileage"] },
      { label: "Work order number", fields: ["roNumber"] },
      { label: "Service start date before retail date", fields: ["serviceStartDate"] },
      { label: "Service end date", fields: ["serviceEndDate"] },
      { label: "Customer concern and condition codes", fields: ["customerConcernCode", "conditionCode"] },
      { label: "Photos / DPQA for cosmetic damage", detail: "Attach as intake evidence when applicable." },
      { label: "Loose-in-crate parts checked against loose parts list", detail: "Missing loose parts usually route to RMA." }
    ]
  },
  freight_damage: {
    source: "FRT Claim Type Processing Guide, Product Damaged in Shipping Warranty vs. RMA",
    items: [
      { label: "VIN", fields: ["vin"] },
      { label: "Work order number", fields: ["roNumber"] },
      { label: "BOL number or signed BOL evidence", fields: ["bolNumber"] },
      { label: "Carrier", fields: ["carrierName"] },
      { label: "Service start date / damage noticed date", fields: ["serviceStartDate"] },
      { label: "Service end date", fields: ["serviceEndDate"] },
      { label: "Damage description", fields: ["issueDescription"] },
      { label: "Photos of damage", detail: "Attach as intake evidence." },
      { label: "Customer concern and condition codes", fields: ["customerConcernCode", "conditionCode"] }
    ]
  },
  parts_rma: {
    source: "Product Damaged in Shipping Warranty vs. RMA, 2026 Loose Parts, ShipExec User Guide",
    items: [
      { label: "Part number", fields: ["partNumber"] },
      { label: "Part description", fields: ["partDescription"] },
      { label: "Quantity", fields: ["quantity"] },
      { label: "Invoice or order number", anyOf: ["invoiceNumber", "orderNumber"] },
      { label: "Reason for return / shortage / wrong part", fields: ["issueDescription"] },
      { label: "Requested action", fields: ["requestedAction"] },
      { label: "Return authorization number", fields: ["returnAuthorizationNumber"] },
      { label: "Photos or shipping evidence", detail: "Attach as intake evidence when damage/shortage is involved." }
    ]
  },
  recall_campaign: {
    source: "Talon Recall Processing Guide, Dealer Service Card for Older Campaigns",
    items: [
      { label: "VIN", fields: ["vin"] },
      { label: "Work order number", fields: ["roNumber"] },
      { label: "Service start date", fields: ["serviceStartDate"] },
      { label: "Service end date", fields: ["serviceEndDate"] },
      { label: "Recall/campaign labor or 8888 code", anyOf: ["jobTimeCode", "laborHours"] },
      { label: "Replacement parts used", fields: ["partNumber"] },
      { label: "Keep recall on separate TALON work order", detail: "Document check before Warranty-Link transmit." }
    ]
  },
  goodwill: {
    source: "GDW Claim Type Processing Guide",
    items: [
      { label: "Technical Services authorization number", fields: ["authorizationNumber"] },
      { label: "VIN", fields: ["vin"] },
      { label: "Mileage at concern", fields: ["mileage"] },
      { label: "Work order number", fields: ["roNumber"] },
      { label: "Service start date", fields: ["serviceStartDate"] },
      { label: "Service end date", fields: ["serviceEndDate"] },
      { label: "Problem part number", fields: ["partNumber"] },
      { label: "Customer concern and condition codes", fields: ["customerConcernCode", "conditionCode"] },
      { label: "Problem, diagnosis, and solution summary", fields: ["issueDescription", "cause", "correction"] }
    ]
  },
  general_merchandise: {
    source: "GM Claim Type Processing Guide, General Merchandise Warranty Concern & Condition Codes",
    items: [
      { label: "Item part number", fields: ["partNumber"] },
      { label: "Item description", fields: ["partDescription"] },
      { label: "Customer or dealer-stock context", anyOf: ["customerName", "notes"] },
      { label: "Retail / purchase / received date", anyOf: ["purchaseDate", "invoiceDate"] },
      { label: "Service start date", fields: ["serviceStartDate"] },
      { label: "Service end date", fields: ["serviceEndDate"] },
      { label: "Condition and concern codes", fields: ["conditionCode", "customerConcernCode"] },
      { label: "One item per claim when part/size/condition differ", detail: "Document check before TALON/Warranty-Link review." }
    ]
  },
  engine_return: {
    source: "Engine Return Paperwork, LongBlock Program",
    items: [
      { label: "VIN", fields: ["vin"] },
      { label: "Work order number", fields: ["roNumber"] },
      { label: "Engine/core part number", fields: ["partNumber"] },
      { label: "Authorization or return number", anyOf: ["authorizationNumber", "returnAuthorizationNumber"] },
      { label: "Carrier", fields: ["carrierName"] },
      { label: "Bill of lading date/number", fields: ["bolNumber"] },
      { label: "Failure description and repair decision", fields: ["issueDescription", "cause", "correction"] }
    ]
  },
  other: {
    source: "Claim Processing Guidelines",
    items: [
      { label: "Claim type or reason", fields: ["claimType"] },
      { label: "Part number", fields: ["partNumber"] },
      { label: "Issue description", fields: ["issueDescription"] },
      { label: "Proof of purchase, invoice, or work order", anyOf: ["invoiceNumber", "roNumber", "orderNumber"] },
      { label: "Supporting evidence", detail: "Attach photos, notes, PDFs, or emails." }
    ]
  }
};

export default function WarrantyRmaPage() {
  const [manuals, setManuals] = useState<WarrantyRmaManualDocument[]>([]);
  const [cases, setCases] = useState<WarrantyRmaCaseEntry[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [selectedManualIds, setSelectedManualIds] = useState<string[]>([]);
  const [caseForm, setCaseForm] = useState<CaseForm>(emptyCaseForm);
  const [manualTitle, setManualTitle] = useState("");
  const [manualType, setManualType] = useState<WarrantyRmaManualDocument["documentType"]>("warranty_manual");
  const [manualScope, setManualScope] = useState<"global" | "dealer">("global");
  const [manualNotes, setManualNotes] = useState("");
  const [showReferenceManager, setShowReferenceManager] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [extractingIntake, setExtractingIntake] = useState(false);
  const [indexingReferences, setIndexingReferences] = useState(false);
  const [lastExtraction, setLastExtraction] = useState<WarrantyRmaIntakeExtraction | null>(null);
  const [vectorStatus, setVectorStatus] = useState<WarrantyRmaVectorStatus | null>(null);
  const [caseActionBusy, setCaseActionBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const intakeFileInputRef = useRef<HTMLInputElement | null>(null);

  const selectedCase = useMemo(
    () => cases.find(item => item.id === selectedCaseId) ?? cases[0] ?? null,
    [cases, selectedCaseId]
  );
  const activeRequirements = useMemo(
    () => buildRequirementSummary(caseForm, manuals, selectedManualIds),
    [caseForm, manuals, selectedManualIds]
  );

  useEffect(() => {
    void loadWorkspace();
  }, []);

  async function loadWorkspace() {
    setLoading(true);
    setError(null);
    try {
      const [manualsResponse, casesResponse, vectorData] = await Promise.all([
        fetch("/api/warranty-rma/manuals", { cache: "no-store" }),
        fetch("/api/warranty-rma/cases", { cache: "no-store" }),
        fetch("/api/warranty-rma/vector/status", { cache: "no-store" })
          .then(async response => ({ response, data: await response.json().catch(() => null) }))
          .catch(() => null)
      ]);
      const manualsData = await manualsResponse.json();
      const casesData = await casesResponse.json();
      if (!manualsResponse.ok || !manualsData.ok) throw new Error(manualsData.error || "Could not load manuals.");
      if (!casesResponse.ok || !casesData.ok) throw new Error(casesData.error || "Could not load cases.");
      if (vectorData?.response.ok && vectorData.data?.ok) setVectorStatus(vectorData.data.vector ?? null);
      setManuals(manualsData.manuals ?? []);
      setCases(casesData.cases ?? []);
      if (!selectedCaseId && casesData.cases?.[0]?.id) setSelectedCaseId(casesData.cases[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Warranty/RMA workspace could not load.");
    } finally {
      setLoading(false);
    }
  }

  async function uploadManual() {
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setError("Choose a warranty manual or policy document first.");
      return;
    }
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("title", manualTitle || file.name);
      form.append("documentType", manualType || "warranty_manual");
      form.append("scope", manualScope);
      form.append("notes", manualNotes);
      const response = await fetch("/api/warranty-rma/manuals", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Document upload failed.");
      setManuals(prev => [data.manual, ...prev.filter(item => item.id !== data.manual.id)]);
      setSelectedManualIds(prev => Array.from(new Set([data.manual.id, ...prev])));
      setManualTitle("");
      setManualNotes("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      setNotice("Warranty/RMA document uploaded.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Document upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function extractIntake() {
    const files = Array.from(intakeFileInputRef.current?.files ?? []);
    if (!files.length) {
      setError("Choose at least one invoice, repair order, work order, photo, or PDF to extract.");
      return;
    }
    setExtractingIntake(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      for (const file of files) form.append("files", file);
      const response = await fetch("/api/warranty-rma/intake/extract", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Intake extraction failed.");
      const extraction = data.extraction as WarrantyRmaIntakeExtraction;
      setLastExtraction(extraction);
      setCaseForm(prev => mergeExtractionIntoCaseForm(prev, extraction));
      setNotice(
        extraction.status === "extracted"
          ? "Evidence extracted and added to the case form."
          : "Evidence reviewed. Check missing items before submitting."
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Intake extraction failed.");
    } finally {
      setExtractingIntake(false);
    }
  }

  async function deleteManual(id: string) {
    setCaseActionBusy(id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/warranty-rma/manuals/${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Document could not be deleted.");
      setManuals(prev => prev.filter(item => item.id !== id));
      setSelectedManualIds(prev => prev.filter(value => value !== id));
      setNotice("Warranty/RMA document deleted.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Document could not be deleted.");
    } finally {
      setCaseActionBusy(null);
    }
  }

  async function indexReferences() {
    setIndexingReferences(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/warranty-rma/vector/reindex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manualIds: selectedManualIds })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "References could not be indexed.");
      const result = data.result ?? {};
      if (!result.configured) {
        const missing = vectorStatus?.missing?.length ? vectorStatus.missing.join(", ") : "Pinecone settings";
        throw new Error(`Vector search is not configured yet. Missing: ${missing}.`);
      }
      const indexed = Number(result.documentsIndexed ?? 0);
      const chunks = Number(result.chunksUpserted ?? 0);
      const skipped = Array.isArray(result.skipped) ? result.skipped.length : 0;
      const errors = Array.isArray(result.errors) ? result.errors.length : 0;
      setNotice(
        `Reference index updated: ${indexed} document${indexed === 1 ? "" : "s"}, ${chunks} chunk${chunks === 1 ? "" : "s"} indexed${skipped ? `, ${skipped} skipped` : ""}${errors ? `, ${errors} error${errors === 1 ? "" : "s"}` : ""}.`
      );
      void loadWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : "References could not be indexed.");
    } finally {
      setIndexingReferences(false);
    }
  }

  async function createCase() {
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/warranty-rma/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...caseForm,
          selectedManualIds
        })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Warranty/RMA case could not be reviewed.");
      setCases(prev => [data.case, ...prev.filter(item => item.id !== data.case.id)]);
      setSelectedCaseId(data.case.id);
      setCaseForm(emptyCaseForm);
      setNotice("Warranty/RMA case reviewed and saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Warranty/RMA case could not be reviewed.");
    } finally {
      setSubmitting(false);
    }
  }

  async function updateCaseStatus(id: string, status: WarrantyRmaStatus) {
    setCaseActionBusy(`${id}:${status}`);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/warranty-rma/cases/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Case status could not be updated.");
      setCases(prev => prev.map(item => (item.id === id ? data.case : item)));
      setNotice(`Case marked ${statusLabels[status].toLowerCase()}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Case status could not be updated.");
    } finally {
      setCaseActionBusy(null);
    }
  }

  async function prepareDmsPush(id: string) {
    setCaseActionBusy(`${id}:dms`);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/warranty-rma/cases/${encodeURIComponent(id)}/dms-push`, { method: "POST" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Claim packet could not be prepared.");
      if (data.case) setCases(prev => prev.map(item => (item.id === id ? data.case : item)));
      setNotice(data.message || "Claim packet prepared for TALON/Warranty-Link review.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Claim packet could not be prepared.");
    } finally {
      setCaseActionBusy(null);
    }
  }

  function toggleManualSelection(id: string) {
    setSelectedManualIds(prev => (prev.includes(id) ? prev.filter(value => value !== id) : [...prev, id]));
  }

  return (
    <main className="min-h-screen bg-[#f4f6f8] text-slate-950">
      <header className="border-b border-slate-200 bg-white px-4 py-4 shadow-sm">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#fb7f04]">LeadRider</div>
            <h1 className="text-xl font-semibold">Warranty/RMA Workspace</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              href="/"
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50"
            >
              Messaging Platform
            </a>
            <a
              href="/?section=mdf"
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50"
            >
              MDF Assistant
            </a>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-4 px-4 py-5 lg:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="space-y-4">
          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Reference Library</div>
                <h2 className="mt-1 text-lg font-semibold">Warranty/RMA references</h2>
              </div>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                {manuals.length ? `${manuals.length} loaded` : "None loaded"}
              </span>
            </div>
            <p className="mt-3 text-sm text-slate-600">
              Global Harley references can be reused across dealers. Dealer references stay isolated for that rooftop.
              Leave selection automatic, or choose exact documents when a claim needs a specific manual.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="rounded-full bg-orange-50 px-2.5 py-1 text-xs font-semibold text-orange-800">
                {selectedManualIds.length
                  ? `${selectedManualIds.length} selected`
                  : "Automatic relevance"}
              </span>
              <span
                className={[
                  "rounded-full px-2.5 py-1 text-xs font-semibold",
                  vectorStatus?.configured ? "bg-emerald-50 text-emerald-800" : "bg-slate-100 text-slate-700"
                ].join(" ")}
              >
                {vectorStatus?.configured ? "Vector search ready" : "Vector search off"}
              </span>
              <button
                type="button"
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                onClick={() => void loadWorkspace()}
                disabled={loading}
              >
                Refresh
              </button>
              <button
                type="button"
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                onClick={() => setShowReferenceManager(prev => !prev)}
              >
                {showReferenceManager ? "Hide manager" : "Manage references"}
              </button>
              <button
                type="button"
                className="rounded-lg border border-[#fb7f04] px-3 py-1.5 text-xs font-semibold text-[#b84f00] hover:bg-orange-50 disabled:opacity-60"
                onClick={() => void indexReferences()}
                disabled={indexingReferences || !manuals.length || !vectorStatus?.configured}
              >
                {indexingReferences ? "Indexing..." : "Index references"}
              </button>
            </div>
            <div className="mt-2 text-xs text-slate-500">
              {vectorStatus?.configured
                ? `Pinecone index ${vectorStatus.indexName}; global ${vectorStatus.globalNamespace || vectorStatus.namespace}; dealer ${vectorStatus.dealerNamespace || "not set"}${vectorStatus.legacyNamespace ? `; legacy ${vectorStatus.legacyNamespace}` : ""}; model ${vectorStatus.embeddingModel}.`
                : vectorStatus?.missing?.length
                  ? `Add ${vectorStatus.missing.join(", ")} to enable Pinecone retrieval.`
                  : "Pinecone retrieval status is not available."}
            </div>

            {showReferenceManager ? (
              <div className="mt-4 space-y-4 border-t border-slate-200 pt-4">
                <div className="space-y-3">
                  <input
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950"
                    value={manualTitle}
                    onChange={event => setManualTitle(event.target.value)}
                    placeholder="Document title"
                  />
                  <select
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950"
                    value={manualType}
                    onChange={event => setManualType(event.target.value as WarrantyRmaManualDocument["documentType"])}
                  >
                    <option value="warranty_manual">Warranty manual</option>
                    <option value="policy">Policy</option>
                    <option value="parts_reference">Parts reference</option>
                    <option value="other">Other</option>
                  </select>
                  <select
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950"
                    value={manualScope}
                    onChange={event => setManualScope(event.target.value === "dealer" ? "dealer" : "global")}
                  >
                    <option value="global">Global Harley reference</option>
                    <option value="dealer">Dealer private reference</option>
                  </select>
                  <div className="text-xs text-slate-500">
                    Use global for Harley-Davidson policy/manual docs. Use dealer private for store-specific process notes,
                    internal pricing, or dealer-only forms.
                  </div>
                  <textarea
                    className="min-h-20 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950"
                    value={manualNotes}
                    onChange={event => setManualNotes(event.target.value)}
                    placeholder="Notes for the assistant"
                  />
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.md,.csv,.json,.xml,application/pdf,image/png,image/jpeg,image/webp,text/plain,text/markdown,text/csv,application/json,application/xml,text/xml"
                    className="w-full rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-sm"
                  />
                  <button
                    type="button"
                    className="w-full rounded-lg border border-[#fb7f04] bg-[#fb7f04] px-4 py-2 text-sm font-semibold text-white shadow-sm disabled:opacity-60"
                    onClick={() => void uploadManual()}
                    disabled={uploading}
                  >
                    {uploading ? "Uploading..." : "Upload document"}
                  </button>
                </div>

                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Choose exact references</div>
                  <div className="mt-2 max-h-[520px] space-y-2 overflow-y-auto pr-1">
                    {manuals.length ? (
                      manuals.map(manual => (
                        <div key={manual.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                          <label className="flex items-start gap-2">
                            <input
                              type="checkbox"
                              className="mt-1"
                              checked={selectedManualIds.includes(manual.id)}
                              onChange={() => toggleManualSelection(manual.id)}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-semibold text-slate-900">{manual.title}</span>
                              <span className="mt-0.5 block text-xs text-slate-500">
                                {(manual.scope === "dealer" ? "dealer private" : "global")} · {manual.documentType?.replace(/_/g, " ") || "document"} · {formatBytes(manual.size)}
                              </span>
                            </span>
                          </label>
                          <div className="mt-2 flex items-center gap-2">
                            {manual.url ? (
                              <a className="text-xs font-semibold text-[#fb7f04]" href={manual.url} target="_blank" rel="noreferrer">
                                Open
                              </a>
                            ) : null}
                            <button
                              type="button"
                              className="text-xs font-semibold text-red-600 disabled:opacity-60"
                              onClick={() => void deleteManual(manual.id)}
                              disabled={caseActionBusy === manual.id}
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="rounded-lg border border-dashed border-slate-300 p-3 text-sm text-slate-500">
                        Upload warranty manuals or policy documents before relying on AI review.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </section>
        </aside>

        <div className="space-y-4">
          {(error || notice) ? (
            <div
              className={[
                "rounded-lg border px-4 py-3 text-sm",
                error ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"
              ].join(" ")}
            >
              {error || notice}
            </div>
          ) : null}

          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">New submission</div>
                <h2 className="mt-1 text-lg font-semibold">Review a part issue</h2>
                <p className="mt-1 text-sm text-slate-500">
                  The assistant checks uploaded manuals and prepares a claim packet for TALON/Warranty-Link review.
                </p>
              </div>
              <span className="inline-flex w-fit rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">
                TALON handoff not connected
              </span>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div className="md:col-span-2 rounded-lg border border-orange-100 bg-orange-50 p-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-orange-700">Intake evidence</div>
                    <p className="mt-1 text-sm text-slate-700">
                      Upload photos, invoices, TALON work-order printouts or exports, labels, PDFs, or notes. The assistant extracts
                      names, part numbers, VINs, dates, complaint/cause/correction, and claim details into the form.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="rounded-lg border border-[#fb7f04] bg-[#fb7f04] px-4 py-2 text-sm font-semibold text-white shadow-sm disabled:opacity-60"
                    onClick={() => void extractIntake()}
                    disabled={extractingIntake}
                  >
                    {extractingIntake ? "Extracting..." : "Extract and fill"}
                  </button>
                </div>
                <input
                  ref={intakeFileInputRef}
                  type="file"
                  multiple
                  accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.md,.csv,.json,.xml,application/pdf,image/png,image/jpeg,image/webp,text/plain,text/markdown,text/csv,application/json,application/xml,text/xml"
                  className="mt-3 w-full rounded-lg border border-dashed border-orange-200 bg-white px-3 py-3 text-sm text-slate-700"
                />
                {lastExtraction ? (
                  <div className="mt-3 grid gap-3 lg:grid-cols-3">
                    <div className="rounded-lg border border-orange-100 bg-white p-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Extraction</div>
                      <div className="mt-1 text-sm font-semibold text-slate-900">
                        {lastExtraction.status.replace(/_/g, " ")} · {Math.round((lastExtraction.confidence || 0) * 100)}%
                      </div>
                      <p className="mt-1 text-xs text-slate-600">{lastExtraction.summary || "Evidence parsed."}</p>
                    </div>
                    <ListBlock
                      title="Still needed"
                      rows={lastExtraction.requiredInfo}
                      empty="No blocking missing items reported."
                    />
                    <ListBlock
                      title="Evidence notes"
                      rows={lastExtraction.evidenceNotes}
                      empty="No evidence notes returned."
                    />
                  </div>
                ) : null}
              </div>

              <SelectField
                label="Claim type"
                value={caseForm.claimType}
                options={claimTypeOptions}
                onChange={value => setCaseForm(prev => ({ ...prev, claimType: value }))}
              />
              <Field label="Part number" value={caseForm.partNumber} onChange={value => setCaseForm(prev => ({ ...prev, partNumber: value }))} />
              <Field label="Part description" value={caseForm.partDescription} onChange={value => setCaseForm(prev => ({ ...prev, partDescription: value }))} />
              <Field label="Customer name" value={caseForm.customerName} onChange={value => setCaseForm(prev => ({ ...prev, customerName: value }))} />
              <Field label="Repair order" value={caseForm.roNumber} onChange={value => setCaseForm(prev => ({ ...prev, roNumber: value }))} />
              <Field label="Invoice" value={caseForm.invoiceNumber} onChange={value => setCaseForm(prev => ({ ...prev, invoiceNumber: value }))} />
              <Field label="Order number" value={caseForm.orderNumber} onChange={value => setCaseForm(prev => ({ ...prev, orderNumber: value }))} />
              <Field label="VIN" value={caseForm.vin} onChange={value => setCaseForm(prev => ({ ...prev, vin: value }))} />
              <Field label="Mileage" value={caseForm.mileage} onChange={value => setCaseForm(prev => ({ ...prev, mileage: value }))} />
              <Field label="Invoice date" value={caseForm.invoiceDate} onChange={value => setCaseForm(prev => ({ ...prev, invoiceDate: value }))} />
              <Field label="Work order date" value={caseForm.workOrderDate} onChange={value => setCaseForm(prev => ({ ...prev, workOrderDate: value }))} />
              <Field label="Service start date" value={caseForm.serviceStartDate} onChange={value => setCaseForm(prev => ({ ...prev, serviceStartDate: value }))} />
              <Field label="Service end date" value={caseForm.serviceEndDate} onChange={value => setCaseForm(prev => ({ ...prev, serviceEndDate: value }))} />
              <Field label="Purchase date" value={caseForm.purchaseDate} onChange={value => setCaseForm(prev => ({ ...prev, purchaseDate: value }))} />
              <Field label="Install date" value={caseForm.installDate} onChange={value => setCaseForm(prev => ({ ...prev, installDate: value }))} />
              <Field label="Failure date" value={caseForm.failureDate} onChange={value => setCaseForm(prev => ({ ...prev, failureDate: value }))} />
              <Field label="Quantity" value={caseForm.quantity} onChange={value => setCaseForm(prev => ({ ...prev, quantity: value }))} />
              <Field label="Labor hours" value={caseForm.laborHours} onChange={value => setCaseForm(prev => ({ ...prev, laborHours: value }))} />
              <Field label="Job time code" value={caseForm.jobTimeCode} onChange={value => setCaseForm(prev => ({ ...prev, jobTimeCode: value }))} />
              <Field label="Technician" value={caseForm.technicianName} onChange={value => setCaseForm(prev => ({ ...prev, technicianName: value }))} />
              <Field label="Dealer number" value={caseForm.dealerNumber} onChange={value => setCaseForm(prev => ({ ...prev, dealerNumber: value }))} />
              <Field label="Authorization number" value={caseForm.authorizationNumber} onChange={value => setCaseForm(prev => ({ ...prev, authorizationNumber: value }))} />
              <Field label="Customer concern code" value={caseForm.customerConcernCode} onChange={value => setCaseForm(prev => ({ ...prev, customerConcernCode: value }))} />
              <Field label="Condition code" value={caseForm.conditionCode} onChange={value => setCaseForm(prev => ({ ...prev, conditionCode: value }))} />
              <Field label="Carrier" value={caseForm.carrierName} onChange={value => setCaseForm(prev => ({ ...prev, carrierName: value }))} />
              <Field label="BOL number" value={caseForm.bolNumber} onChange={value => setCaseForm(prev => ({ ...prev, bolNumber: value }))} />
              <Field label="Return authorization" value={caseForm.returnAuthorizationNumber} onChange={value => setCaseForm(prev => ({ ...prev, returnAuthorizationNumber: value }))} />
              <div className="md:col-span-2">
                <RequirementPanel summary={activeRequirements} />
              </div>
              <div className="md:col-span-2">
                <label className="text-sm font-semibold text-slate-700">Issue description</label>
                <textarea
                  className="mt-1 min-h-28 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950"
                  value={caseForm.issueDescription}
                  onChange={event => setCaseForm(prev => ({ ...prev, issueDescription: event.target.value }))}
                  placeholder="Briefly describe what failed, what was observed, and what action is requested."
                />
              </div>
              <div>
                <label className="text-sm font-semibold text-slate-700">Cause / diagnosis</label>
                <textarea
                  className="mt-1 min-h-20 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950"
                  value={caseForm.cause}
                  onChange={event => setCaseForm(prev => ({ ...prev, cause: event.target.value }))}
                  placeholder="Known cause or technician diagnosis."
                />
              </div>
              <div>
                <label className="text-sm font-semibold text-slate-700">Correction</label>
                <textarea
                  className="mt-1 min-h-20 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950"
                  value={caseForm.correction}
                  onChange={event => setCaseForm(prev => ({ ...prev, correction: event.target.value }))}
                  placeholder="Repair, replacement, return, or requested remedy."
                />
              </div>
              <div className="md:col-span-2">
                <label className="text-sm font-semibold text-slate-700">Requested action</label>
                <input
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950"
                  value={caseForm.requestedAction}
                  onChange={event => setCaseForm(prev => ({ ...prev, requestedAction: event.target.value }))}
                  placeholder="Warranty claim, RMA, replacement, credit, goodwill, or review."
                />
              </div>
              <div className="md:col-span-2">
                <label className="text-sm font-semibold text-slate-700">Internal notes</label>
                <textarea
                  className="mt-1 min-h-20 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950"
                  value={caseForm.notes}
                  onChange={event => setCaseForm(prev => ({ ...prev, notes: event.target.value }))}
                  placeholder="Photos, technician notes, install date, customer context, or policy concerns."
                />
              </div>
            </div>
            <div className="mt-4 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div className="text-xs text-slate-500">
                {selectedManualIds.length
                  ? `${selectedManualIds.length} selected reference${selectedManualIds.length === 1 ? "" : "s"}`
                  : "No references selected; the assistant will pick the most relevant uploaded documents."}
              </div>
              <button
                type="button"
                className="rounded-lg border border-[#fb7f04] bg-[#fb7f04] px-4 py-2 text-sm font-semibold text-white shadow-sm disabled:opacity-60"
                onClick={() => void createCase()}
                disabled={submitting}
              >
                {submitting ? "Reviewing..." : "Review and save case"}
              </button>
            </div>
          </section>

          <section className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
            <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Cases</div>
                  <h2 className="mt-1 text-lg font-semibold">Workspace history</h2>
                </div>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                  {cases.length}
                </span>
              </div>
              <div className="mt-3 space-y-2">
                {loading ? (
                  <div className="rounded-lg border border-dashed border-slate-300 p-3 text-sm text-slate-500">Loading cases...</div>
                ) : cases.length ? (
                  cases.map(item => (
                    <button
                      key={item.id}
                      type="button"
                      className={[
                        "w-full rounded-lg border p-3 text-left transition",
                        selectedCase?.id === item.id
                          ? "border-[#fb7f04] bg-orange-50"
                          : "border-slate-200 bg-white hover:bg-slate-50"
                      ].join(" ")}
                      onClick={() => setSelectedCaseId(item.id)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-slate-900">{item.title}</div>
                          <div className="mt-1 text-xs text-slate-500">{new Date(item.updatedAt).toLocaleString()}</div>
                        </div>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusClasses[item.status]}`}>
                          {statusLabels[item.status]}
                        </span>
                      </div>
                      <div className="mt-2 line-clamp-2 text-xs text-slate-600">{item.issueDescription}</div>
                    </button>
                  ))
                ) : (
                  <div className="rounded-lg border border-dashed border-slate-300 p-3 text-sm text-slate-500">
                    Saved warranty/RMA cases will appear here.
                  </div>
                )}
              </div>
            </div>

            <CaseDetail
              selectedCase={selectedCase}
              busyKey={caseActionBusy}
              onStatus={updateCaseStatus}
              onDms={prepareDmsPush}
            />
          </section>
        </div>
      </div>
    </main>
  );
}

function Field(props: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="text-sm font-semibold text-slate-700">{props.label}</span>
      <input
        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950"
        value={props.value}
        onChange={event => props.onChange(event.target.value)}
      />
    </label>
  );
}

function SelectField(props: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-sm font-semibold text-slate-700">{props.label}</span>
      <select
        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950"
        value={props.value}
        onChange={event => props.onChange(event.target.value)}
      >
        {props.options.map(option => (
          <option key={option.value || "unknown"} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function RequirementPanel(props: {
  summary: {
    source: string;
    references: string[];
    items: Array<RequirementItem & { satisfied: boolean }>;
  };
}) {
  const missing = props.summary.items.filter(item => !item.satisfied);
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Needed for this claim</div>
          <div className="mt-1 text-sm font-semibold text-slate-900">
            {missing.length ? `${missing.length} item${missing.length === 1 ? "" : "s"} still needed` : "Checklist complete"}
          </div>
        </div>
        <div className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-700">
          {props.summary.source}
        </div>
      </div>
      {props.summary.references.length ? (
        <div className="mt-2 text-xs text-slate-500">Matched references: {props.summary.references.join(", ")}</div>
      ) : null}
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {props.summary.items.map((item, index) => (
          <div key={`${item.label}-${index}`} className="rounded border border-slate-200 bg-white px-3 py-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-800">{item.label}</div>
                {item.detail ? <div className="mt-0.5 text-xs text-slate-500">{item.detail}</div> : null}
              </div>
              <span
                className={[
                  "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                  item.satisfied ? "bg-emerald-100 text-emerald-800" : item.fields || item.anyOf ? "bg-amber-100 text-amber-800" : "bg-blue-100 text-blue-800"
                ].join(" ")}
              >
                {item.satisfied ? "Done" : item.fields || item.anyOf ? "Missing" : "Review"}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CaseDetail(props: {
  selectedCase: WarrantyRmaCaseEntry | null;
  busyKey: string | null;
  onStatus: (id: string, status: WarrantyRmaStatus) => Promise<void>;
  onDms: (id: string) => Promise<void>;
}) {
  const item = props.selectedCase;
  if (!item) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="text-sm text-slate-500">Select or create a warranty/RMA case to review the assistant output.</div>
      </div>
    );
  }
  const review = item.review;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Review output</div>
          <h2 className="mt-1 text-lg font-semibold">{item.title}</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusClasses[item.status]}`}>
              {statusLabels[item.status]}
            </span>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
              {review.status.replace(/_/g, " ")} · {Math.round((review.confidence || 0) * 100)}%
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-60"
            onClick={() => void props.onStatus(item.id, "needs_info")}
            disabled={props.busyKey === `${item.id}:needs_info`}
          >
            Needs info
          </button>
          <button
            type="button"
            className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-60"
            onClick={() => void props.onStatus(item.id, "ready_for_dms")}
            disabled={props.busyKey === `${item.id}:ready_for_dms`}
          >
            Ready
          </button>
          <button
            type="button"
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-60"
            onClick={() => void props.onDms(item.id)}
            disabled={props.busyKey === `${item.id}:dms`}
          >
            Prepare claim packet
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <InfoBlock title="Summary" text={review.summary} />
        <InfoBlock title="Coverage reasoning" text={review.coverageReasoning} />
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <ListBlock title="Required info" rows={review.requiredInfo} empty="No missing items reported." />
        <ListBlock title="Next steps" rows={review.nextSteps} empty="No next steps reported." />
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">TALON/Warranty-Link handoff</div>
          <div className="mt-2 text-sm font-semibold text-slate-900">{item.dmsPush.status.replace(/_/g, " ")}</div>
          <p className="mt-1 text-sm text-slate-600">{item.dmsPush.message || review.dms.nextStep}</p>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Warranty claim packet</div>
        <dl className="mt-3 grid gap-3 md:grid-cols-2">
          <PayloadField label="Claim type" value={review.dmsPayloadDraft.claimType} />
          <PayloadField label="Part number" value={review.dmsPayloadDraft.partNumber} />
          <PayloadField label="Part description" value={review.dmsPayloadDraft.partDescription} />
          <PayloadField label="Customer" value={review.dmsPayloadDraft.customerName} />
          <PayloadField label="Repair order" value={review.dmsPayloadDraft.roNumber} />
          <PayloadField label="Invoice" value={review.dmsPayloadDraft.invoiceNumber} />
          <PayloadField label="Order" value={review.dmsPayloadDraft.orderNumber} />
          <PayloadField label="VIN" value={review.dmsPayloadDraft.vin} />
          <PayloadField label="Mileage" value={review.dmsPayloadDraft.mileage} />
          <PayloadField label="Invoice date" value={review.dmsPayloadDraft.invoiceDate} />
          <PayloadField label="Work order date" value={review.dmsPayloadDraft.workOrderDate} />
          <PayloadField label="Service start date" value={review.dmsPayloadDraft.serviceStartDate} />
          <PayloadField label="Service end date" value={review.dmsPayloadDraft.serviceEndDate} />
          <PayloadField label="Purchase date" value={review.dmsPayloadDraft.purchaseDate} />
          <PayloadField label="Install date" value={review.dmsPayloadDraft.installDate} />
          <PayloadField label="Failure date" value={review.dmsPayloadDraft.failureDate} />
          <PayloadField label="Quantity" value={review.dmsPayloadDraft.quantity} />
          <PayloadField label="Labor hours" value={review.dmsPayloadDraft.laborHours} />
          <PayloadField label="Job time code" value={review.dmsPayloadDraft.jobTimeCode} />
          <PayloadField label="Technician" value={review.dmsPayloadDraft.technicianName} />
          <PayloadField label="Dealer number" value={review.dmsPayloadDraft.dealerNumber} />
          <PayloadField label="Authorization number" value={review.dmsPayloadDraft.authorizationNumber} />
          <PayloadField label="Customer concern code" value={review.dmsPayloadDraft.customerConcernCode} />
          <PayloadField label="Condition code" value={review.dmsPayloadDraft.conditionCode} />
          <PayloadField label="Carrier" value={review.dmsPayloadDraft.carrierName} />
          <PayloadField label="BOL number" value={review.dmsPayloadDraft.bolNumber} />
          <PayloadField label="Return authorization" value={review.dmsPayloadDraft.returnAuthorizationNumber} />
          <PayloadField label="Causal part" value={review.dmsPayloadDraft.causalPart} />
          <PayloadField label="Failure code" value={review.dmsPayloadDraft.failureCode || "Needs mapping"} />
          <PayloadField label="Requested action" value={review.dmsPayloadDraft.requestedAction} />
          <PayloadField label="Complaint" value={review.dmsPayloadDraft.complaint} wide />
          <PayloadField label="Cause" value={review.dmsPayloadDraft.cause} wide />
          <PayloadField label="Correction" value={review.dmsPayloadDraft.correction} wide />
          <PayloadField label="Notes" value={review.dmsPayloadDraft.notes} wide />
        </dl>
      </div>

      <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Manual references</div>
        <div className="mt-3 space-y-3">
          {review.manualReferences.length ? (
            review.manualReferences.map((reference, index) => (
              <div key={`${reference.documentTitle}-${index}`} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="text-sm font-semibold text-slate-900">{reference.documentTitle || "Reference"}</div>
                {reference.excerpt ? <p className="mt-1 text-sm text-slate-600">"{reference.excerpt}"</p> : null}
                {reference.reason ? <p className="mt-1 text-xs text-slate-500">{reference.reason}</p> : null}
              </div>
            ))
          ) : (
            <div className="rounded-lg border border-dashed border-slate-300 p-3 text-sm text-slate-500">
              No manual references returned yet. Upload/select manuals and rerun a case for document-backed review.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function InfoBlock(props: { title: string; text: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{props.title}</div>
      <p className="mt-2 text-sm text-slate-700">{props.text || "No detail returned."}</p>
    </div>
  );
}

function ListBlock(props: { title: string; rows: string[]; empty: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{props.title}</div>
      {props.rows.length ? (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
          {props.rows.map((row, index) => (
            <li key={`${row}-${index}`}>{row}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-slate-500">{props.empty}</p>
      )}
    </div>
  );
}

function PayloadField(props: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={props.wide ? "md:col-span-2" : ""}>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{props.label}</dt>
      <dd className="mt-1 rounded border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800">
        {props.value || "Not set"}
      </dd>
    </div>
  );
}

function normalizeClaimTypeValue(value: string | undefined) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.includes("mc") || raw.includes("motorcycle")) return "motorcycle_warranty";
  if (raw.includes("pna") || raw.includes("parts warranty") || raw.includes("accessory")) return "parts_accessory_warranty";
  if (raw.includes("prd") || raw.includes("pre-delivery") || raw.includes("pre delivery")) return "pre_delivery_warranty";
  if (raw.includes("frt") || raw.includes("freight") || raw.includes("shipping damage")) return "freight_damage";
  if (raw.includes("rma") || raw.includes("return")) return "parts_rma";
  if (raw.includes("recall") || raw.includes("campaign")) return "recall_campaign";
  if (raw.includes("gdw") || raw.includes("goodwill")) return "goodwill";
  if (raw === "gm" || raw.includes("general merchandise") || raw.includes("apparel")) return "general_merchandise";
  if (raw.includes("engine") || raw.includes("core") || raw.includes("longblock") || raw.includes("long block")) return "engine_return";
  if (claimTypeOptions.some(option => option.value === raw)) return raw;
  return "other";
}

function buildRequirementSummary(caseForm: CaseForm, manuals: WarrantyRmaManualDocument[], selectedManualIds: string[]) {
  const normalizedType = normalizeClaimTypeValue(caseForm.claimType);
  const profile = requiredProfiles[normalizedType || "unknown"] ?? requiredProfiles.other;
  const selected = selectedManualIds.length ? new Set(selectedManualIds) : null;
  const referenceKeywords = referenceKeywordsForClaimType(normalizedType);
  const candidateManuals = manuals
    .filter(manual => {
      if (selected) return selected.has(manual.id);
      const text = `${manual.title} ${manual.fileName}`.toLowerCase();
      return referenceKeywords.some(keyword => text.includes(keyword));
    })
    .slice(0, 4)
    .map(manual => manual.title);
  const items = profile.items.map(item => ({
    ...item,
    satisfied: requirementSatisfied(item, caseForm)
  }));
  return {
    source: profile.source,
    references: candidateManuals,
    items
  };
}

function referenceKeywordsForClaimType(claimType: string) {
  const map: Record<string, string[]> = {
    motorcycle_warranty: ["mc claim", "warranty condition", "customer concern"],
    parts_accessory_warranty: ["pna claim", "warranty condition", "customer concern"],
    pre_delivery_warranty: ["prd claim", "loose parts"],
    freight_damage: ["frt claim", "product damaged in shipping"],
    parts_rma: ["product damaged in shipping", "shipexec", "loose parts"],
    recall_campaign: ["recall", "service card"],
    goodwill: ["gdw claim"],
    general_merchandise: ["gm claim", "general merchandise"],
    engine_return: ["engine return", "longblock", "long block"],
    other: ["claim processing guidelines"],
    unknown: ["claim processing guidelines"]
  };
  return map[claimType || "unknown"] ?? map.other;
}

function requirementSatisfied(item: RequirementItem, caseForm: CaseForm) {
  const present = (field: keyof CaseForm) => String(caseForm[field] ?? "").trim().length > 0;
  if (item.fields?.length) return item.fields.every(present);
  if (item.anyOf?.length) return item.anyOf.some(present);
  return false;
}

function mergeExtractionIntoCaseForm(prev: CaseForm, extraction: WarrantyRmaIntakeExtraction): CaseForm {
  const fields = extraction.fields ?? ({} as WarrantyRmaIntakeExtraction["fields"]);
  const choose = (current: string, extracted: string | undefined) => {
    const currentTrimmed = String(current ?? "").trim();
    const extractedTrimmed = String(extracted ?? "").trim();
    return currentTrimmed || extractedTrimmed;
  };
  const issueFromEvidence = [fields.symptom, fields.cause ? `Cause: ${fields.cause}` : "", fields.correction ? `Correction: ${fields.correction}` : ""]
    .map(value => String(value ?? "").trim())
    .filter(Boolean)
    .join("\n");
  const evidenceLines = [
    extraction.summary ? `Extraction summary: ${extraction.summary}` : "",
    ...extraction.evidenceNotes.map(note => `Evidence: ${note}`),
    ...extraction.sourceFiles.map(file => `Source: ${file.fileName}${file.evidenceType ? ` (${file.evidenceType})` : ""}${file.notes ? ` - ${file.notes}` : ""}`)
  ].filter(Boolean);
  const evidenceNote = evidenceLines.join("\n");
  const existingNotes = String(prev.notes ?? "").trim();
  return {
    ...prev,
    claimType: choose(prev.claimType, normalizeClaimTypeValue(fields.claimType)),
    partNumber: choose(prev.partNumber, fields.partNumber),
    partDescription: choose(prev.partDescription, fields.partDescription),
    issueDescription: choose(prev.issueDescription, issueFromEvidence || fields.symptom),
    customerName: choose(prev.customerName, fields.customerName),
    roNumber: choose(prev.roNumber, fields.roNumber),
    invoiceNumber: choose(prev.invoiceNumber, fields.invoiceNumber),
    orderNumber: choose(prev.orderNumber, fields.orderNumber),
    vin: choose(prev.vin, fields.vin),
    mileage: choose(prev.mileage, fields.mileage),
    invoiceDate: choose(prev.invoiceDate, fields.invoiceDate),
    workOrderDate: choose(prev.workOrderDate, fields.workOrderDate),
    serviceStartDate: choose(prev.serviceStartDate, fields.serviceStartDate),
    serviceEndDate: choose(prev.serviceEndDate, fields.serviceEndDate),
    purchaseDate: choose(prev.purchaseDate, fields.purchaseDate),
    installDate: choose(prev.installDate, fields.installDate),
    failureDate: choose(prev.failureDate, fields.failureDate),
    quantity: choose(prev.quantity, fields.quantity),
    laborHours: choose(prev.laborHours, fields.laborHours),
    jobTimeCode: choose(prev.jobTimeCode, fields.jobTimeCode),
    technicianName: choose(prev.technicianName, fields.technicianName),
    dealerNumber: choose(prev.dealerNumber, fields.dealerNumber),
    authorizationNumber: choose(prev.authorizationNumber, fields.authorizationNumber),
    customerConcernCode: choose(prev.customerConcernCode, fields.customerConcernCode),
    conditionCode: choose(prev.conditionCode, fields.conditionCode),
    carrierName: choose(prev.carrierName, fields.carrierName),
    bolNumber: choose(prev.bolNumber, fields.bolNumber),
    returnAuthorizationNumber: choose(prev.returnAuthorizationNumber, fields.returnAuthorizationNumber),
    cause: choose(prev.cause, fields.cause),
    correction: choose(prev.correction, fields.correction),
    requestedAction: choose(prev.requestedAction, fields.requestedAction),
    notes: evidenceNote && !existingNotes.includes(evidenceNote)
      ? [existingNotes, evidenceNote].filter(Boolean).join("\n\n")
      : existingNotes
  };
}

function formatBytes(size: number) {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
