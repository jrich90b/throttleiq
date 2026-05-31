import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "warranty-rma-eval-"));
process.env.LLM_ENABLED = "0";
process.env.OPENAI_API_KEY ||= "sk-test";
process.env.WARRANTY_RMA_DB_PATH = path.join(tempDir, "warranty_rma.json");
process.env.PINECONE_API_KEY = "";
process.env.PINECONE_WARRANTY_INDEX = "";
process.env.PINECONE_INDEX = "";
delete process.env.PINECONE_WARRANTY_GLOBAL_NAMESPACE;
delete process.env.PINECONE_WARRANTY_DEALER_NAMESPACE;
delete process.env.PINECONE_WARRANTY_LEGACY_NAMESPACE;
delete process.env.PINECONE_WARRANTY_NAMESPACE;
process.env.WARRANTY_RMA_VECTOR_MANIFEST_PATH = path.join(tempDir, "warranty_rma_vector_index.json");

const { analyzeWarrantyRmaSubmission, extractWarrantyRmaIntake } = await import("../services/api/src/domain/warrantyRmaAssistant.ts");
const { buildHdnetDraftPacket } = await import("../services/api/src/domain/warrantyRmaHdnet.ts");
const {
  chunkWarrantyRmaTextForVectorIndex,
  getWarrantyRmaVectorStatus,
  indexWarrantyRmaManuals,
  rankWarrantyRmaVectorMatchesForSubmission,
  warrantyRmaRetrievalHintsForSubmission,
  warrantyRmaVectorQueryForSubmission
} = await import("../services/api/src/domain/warrantyRmaVectorStore.ts");
const {
  addWarrantyRmaCase,
  addWarrantyRmaManual,
  listWarrantyRmaCases,
  listWarrantyRmaManuals,
  updateWarrantyRmaCase,
  warrantyRmaStoreReady
} = await import("../services/api/src/domain/warrantyRmaStore.ts");

await warrantyRmaStoreReady;

const manualPath = path.join(tempDir, "parts-policy.txt");
await fs.writeFile(manualPath, "Warranty claims require proof of purchase and technician failure notes.", "utf8");

const manual = addWarrantyRmaManual({
  title: "Parts Warranty Policy",
  fileName: "parts-policy.txt",
  mimeType: "text/plain",
  size: 75,
  storagePath: manualPath,
  documentType: "policy"
});
assert.equal(listWarrantyRmaManuals().length, 1);
assert.equal(manual.title, "Parts Warranty Policy");
assert.equal(manual.scope, "global");

const dealerManualPath = path.join(tempDir, "dealer-process.txt");
await fs.writeFile(dealerManualPath, "Dealer-specific RMA notes: attach internal counter slip before submission.", "utf8");
const dealerManual = addWarrantyRmaManual({
  title: "Dealer RMA Process",
  fileName: "dealer-process.txt",
  mimeType: "text/plain",
  size: 78,
  storagePath: dealerManualPath,
  documentType: "other",
  scope: "dealer"
});
assert.equal(listWarrantyRmaManuals().length, 2);
assert.equal(dealerManual.scope, "dealer");

const vectorStatus = getWarrantyRmaVectorStatus();
assert.equal(vectorStatus.configured, false);
assert.ok(vectorStatus.missing.includes("PINECONE_API_KEY"));
assert.ok(vectorStatus.missing.includes("PINECONE_WARRANTY_INDEX"));
assert.equal(vectorStatus.namespace, "warranty-rma-global");
assert.equal(vectorStatus.globalNamespace, "warranty-rma-global");
assert.equal(vectorStatus.dealerNamespace, "dealer-default");
assert.deepEqual(vectorStatus.searchNamespaces, ["warranty-rma-global", "dealer-default"]);
const chunks = chunkWarrantyRmaTextForVectorIndex(
  "Warranty claim processing requires the part number, repair order, customer concern, condition code, diagnosis, and correction. ".repeat(30)
);
assert.ok(chunks.length > 1);
const vectorNoop = await indexWarrantyRmaManuals([manual]);
assert.equal(vectorNoop.configured, false);
assert.ok(vectorNoop.errors[0]?.error.includes("PINECONE_API_KEY"));
assert.deepEqual(vectorNoop.namespaces, []);

const freightSubmission = {
  claimType: "freight_damage",
  partNumber: "57000345",
  partDescription: "Fairing trim",
  issueDescription: "Box arrived crushed and the trim was scratched.",
  carrierName: "UPS",
  bolNumber: "BOL-8812",
  requestedAction: "Replacement requested"
};
const freightHints = warrantyRmaRetrievalHintsForSubmission(freightSubmission);
assert.ok(freightHints.includes("FRT"));
assert.ok(freightHints.includes("product damaged in shipping"));
const freightQuery = warrantyRmaVectorQueryForSubmission(freightSubmission);
assert.match(freightQuery, /Preferred warranty\/RMA reference terms: .*FRT/i);
assert.match(freightQuery, /BOL: BOL-8812/i);
const rankedMatches = rankWarrantyRmaVectorMatchesForSubmission(
  [
    {
      id: "generic",
      score: 0.72,
      manualId: "generic",
      title: "Generic Warranty Manual",
      fileName: "generic.pdf",
      documentType: "policy",
      namespace: "warranty-rma-global",
      scope: "global",
      chunkIndex: 0,
      chunkCount: 1,
      text: "General warranty review."
    },
    {
      id: "frt",
      score: 0.70,
      manualId: "frt",
      title: "FRT Claim Type Processing Guide",
      fileName: "FRT-Claim-Type-Processing-Guide.pdf",
      documentType: "policy",
      namespace: "warranty-rma-global",
      scope: "global",
      chunkIndex: 0,
      chunkCount: 1,
      text: "Freight damage and product damaged in shipping claim instructions."
    }
  ],
  freightSubmission
);
assert.equal(rankedMatches[0]?.manualId, "frt");

const review = await analyzeWarrantyRmaSubmission({
  submission: {
    claimType: "motorcycle_warranty",
    partNumber: "HD-12345",
    partDescription: "Replacement switch",
    issueDescription: "Customer says the replacement switch failed after install.",
    customerName: "Pat Customer",
    invoiceDate: "2026-05-30",
    serviceStartDate: "2026-05-29",
    serviceEndDate: "2026-05-30",
    vin: "1HD1KRP16PB123456",
    customerConcernCode: "9901",
    conditionCode: "9110",
    authorizationNumber: "123456",
    cause: "Internal switch failure",
    correction: "Replace switch",
    requestedAction: "Warranty review"
  },
  manuals: [manual]
});

assert.equal(review.status, "unknown");
assert.equal(review.dms.status, "not_configured");
assert.equal(review.dmsPayloadDraft.partNumber, "HD-12345");
assert.equal(review.dmsPayloadDraft.partDescription, "Replacement switch");
assert.equal(review.dmsPayloadDraft.customerName, "Pat Customer");
assert.equal(review.dmsPayloadDraft.invoiceDate, "2026-05-30");
assert.equal(review.dmsPayloadDraft.serviceStartDate, "2026-05-29");
assert.equal(review.dmsPayloadDraft.serviceEndDate, "2026-05-30");
assert.equal(review.dmsPayloadDraft.vin, "1HD1KRP16PB123456");
assert.equal(review.dmsPayloadDraft.customerConcernCode, "9901");
assert.equal(review.dmsPayloadDraft.conditionCode, "9110");
assert.equal(review.dmsPayloadDraft.authorizationNumber, "123456");
assert.equal(review.dmsPayloadDraft.cause, "Internal switch failure");
assert.equal(review.dmsPayloadDraft.correction, "Replace switch");
assert.ok(review.requiredInfo.some(item => /warranty manual|proof of purchase/i.test(item)));

const hdnetPacket = buildHdnetDraftPacket({
  claimType: "motorcycle_warranty",
  partNumber: "HD-12345",
  partDescription: "Replacement switch",
  issueDescription: "Customer says the replacement switch failed after install and no longer starts the bike.",
  customerName: "Pat Customer",
  roNumber: "RO-8812345678901",
  serviceStartDate: "2026-05-29",
  serviceEndDate: "2026-05-30",
  failureDate: "05/28/2026",
  vin: "1hd1krp16pb123456",
  mileage: "1205",
  quantity: "1",
  jobTimeCode: "1234",
  laborHours: "0.4",
  customerConcernCode: "9901",
  conditionCode: "9110",
  authorizationNumber: "1234567",
  cause: "Internal switch failure",
  correction: "Replace switch",
  requestedAction: "Warranty review"
});
assert.equal(hdnetPacket.formKind, "short");
assert.equal(hdnetPacket.fields.strEventType, "MC");
assert.equal(hdnetPacket.fields.strCustName, "Customer");
assert.equal(hdnetPacket.fields.strVIN, "1HD1KRP16PB123456");
assert.equal(hdnetPacket.fields.strWorkOrder, "RO-881234567890");
assert.equal(hdnetPacket.fields.strStartDateMM, "05");
assert.equal(hdnetPacket.fields.strStartDateDD, "29");
assert.equal(hdnetPacket.fields.strStartDateYY, "26");
assert.equal(hdnetPacket.fields.strProbDateMM, "05");
assert.equal(hdnetPacket.fields.strProbDateDD, "28");
assert.equal(hdnetPacket.fields.strProbDateYY, "26");
assert.equal(hdnetPacket.fields.strProbDesc.length, 30);
assert.equal(hdnetPacket.detailRows.otherLabor.length, 0);
assert.ok(hdnetPacket.warnings.some(item => /shortened to 30 characters/i.test(item)));
assert.ok(hdnetPacket.warnings.some(item => /do not duplicate/i.test(item)));
assert.equal(hdnetPacket.missing.includes("VIN or crankcase number"), false);

const hdnetLongPacket = buildHdnetDraftPacket({
  claimType: "motorcycle_warranty",
  partNumber: "HD-12345",
  issueDescription: "Extra labor details required.",
  customerName: "Pat Customer",
  roNumber: "RO-1",
  serviceStartDate: "2026-05-29",
  serviceEndDate: "2026-05-30",
  failureDate: "2026-05-30",
  vin: "1HD1KRP16PB123456",
  mileage: "1205",
  quantity: "1",
  jobTimeCode: "1234",
  customerConcernCode: "9901",
  conditionCode: "9110",
  detailRows: {
    otherLabor: Array.from({ length: 15 }, (_, index) => ({ laborCode: String(7000 + index) }))
  }
});
assert.equal(hdnetLongPacket.formKind, "long");
assert.equal(hdnetLongPacket.detailRows.otherLabor.length, 15);

const extraction = await extractWarrantyRmaIntake([
  {
    name: "repair-order.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Customer: Pat Customer\nVIN: 1HD1KRP16PB123456\nComplaint: Switch failed after install", "utf8")
  }
]);
assert.equal(extraction.status, "disabled");
assert.equal(extraction.sourceFiles[0]?.fileName, "repair-order.txt");
assert.ok(extraction.requiredInfo.some(item => /part number/i.test(item)));

const created = addWarrantyRmaCase({
  partNumber: "HD-12345",
  partDescription: "Replacement switch",
  issueDescription: "Customer says the replacement switch failed after install.",
  customerName: "Pat Customer",
  invoiceDate: "2026-05-30",
  serviceStartDate: "2026-05-29",
  serviceEndDate: "2026-05-30",
  vin: "1HD1KRP16PB123456",
  customerConcernCode: "9901",
  conditionCode: "9110",
  authorizationNumber: "123456",
  cause: "Internal switch failure",
  correction: "Replace switch",
  selectedManualIds: [manual.id],
  review,
  hdnetDraftPacket: hdnetPacket,
  status: "needs_info",
  createdByUserName: "Warranty Eval"
});
assert.equal(listWarrantyRmaCases().length, 1);
assert.equal(created.dmsPush.status, "not_configured");
assert.equal(created.hdnetDraftPacket?.formKind, "short");
assert.equal(created.partDescription, "Replacement switch");
assert.equal(created.customerName, "Pat Customer");
assert.equal(created.invoiceDate, "2026-05-30");
assert.equal(created.serviceStartDate, "2026-05-29");
assert.equal(created.serviceEndDate, "2026-05-30");
assert.equal(created.vin, "1HD1KRP16PB123456");
assert.equal(created.customerConcernCode, "9901");
assert.equal(created.conditionCode, "9110");

const updated = updateWarrantyRmaCase(created.id, {
  status: "ready_for_dms",
  dmsPush: {
    status: "not_configured",
    message: "DMS API integration is not configured yet."
  }
});
assert.equal(updated?.status, "ready_for_dms");
assert.equal(updated?.dmsPush.status, "not_configured");

console.log("warranty_rma_eval passed");
