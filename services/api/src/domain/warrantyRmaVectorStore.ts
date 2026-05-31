import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import OpenAI from "openai";
import { dataPath } from "./dataDir.js";
import type { WarrantyRmaManualDocument } from "./warrantyRmaStore.js";
import type { WarrantyRmaSubmission } from "./warrantyRmaAssistant.js";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (buffer: Buffer) => Promise<{ text?: string }>;

const VECTOR_MANIFEST_PATH = process.env.WARRANTY_RMA_VECTOR_MANIFEST_PATH
  ? String(process.env.WARRANTY_RMA_VECTOR_MANIFEST_PATH)
  : dataPath("warranty_rma_vector_index.json");

const VECTOR_SOURCE = "warranty_rma_manual";
let client: OpenAI | null = null;
let cachedPineconeHost: string | null = null;

type WarrantyRmaVectorManifest = {
  version: 1;
  updatedAt: string;
  manuals: Record<
    string,
    {
      title: string;
      fileName: string;
      contentHash: string;
      chunkCount: number;
      vectorIds: string[];
      indexedAt: string;
    }
  >;
};

export type WarrantyRmaVectorStatus = {
  configured: boolean;
  missing: string[];
  indexName: string;
  namespace: string;
  embeddingModel: string;
  apiVersion: string;
  hostConfigured: boolean;
};

export type WarrantyRmaVectorIndexResult = {
  configured: boolean;
  indexName: string;
  namespace: string;
  documentsConsidered: number;
  documentsIndexed: number;
  chunksUpserted: number;
  chunksDeleted: number;
  skipped: Array<{ manualId: string; title: string; reason: string }>;
  errors: Array<{ manualId?: string; title?: string; error: string }>;
};

export type WarrantyRmaVectorMatch = {
  id: string;
  score: number;
  manualId: string;
  title: string;
  fileName: string;
  documentType: string;
  chunkIndex: number;
  chunkCount: number;
  text: string;
};

function openaiClient(): OpenAI {
  client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

function env(name: string) {
  return String(process.env[name] ?? "").trim();
}

function vectorIndexName() {
  return env("PINECONE_WARRANTY_INDEX") || env("PINECONE_INDEX");
}

function vectorNamespace() {
  return env("PINECONE_WARRANTY_NAMESPACE") || "warranty-rma";
}

function vectorEmbeddingModel() {
  return env("OPENAI_WARRANTY_RMA_EMBEDDING_MODEL") || "text-embedding-3-small";
}

function pineconeApiVersion() {
  return env("PINECONE_API_VERSION") || "2025-10";
}

function directPineconeHost() {
  return (env("PINECONE_WARRANTY_HOST") || env("PINECONE_HOST")).replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export function getWarrantyRmaVectorStatus(): WarrantyRmaVectorStatus {
  const missing: string[] = [];
  if (!env("OPENAI_API_KEY")) missing.push("OPENAI_API_KEY");
  if (!env("PINECONE_API_KEY")) missing.push("PINECONE_API_KEY");
  if (!vectorIndexName()) missing.push("PINECONE_WARRANTY_INDEX");
  return {
    configured: missing.length === 0,
    missing,
    indexName: vectorIndexName(),
    namespace: vectorNamespace(),
    embeddingModel: vectorEmbeddingModel(),
    apiVersion: pineconeApiVersion(),
    hostConfigured: Boolean(directPineconeHost())
  };
}

export function isWarrantyRmaVectorSearchConfigured() {
  return getWarrantyRmaVectorStatus().configured;
}

function nowIso() {
  return new Date().toISOString();
}

function sha256(input: Buffer | string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function normalizeText(text: string) {
  return text
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function chunkWarrantyRmaTextForVectorIndex(text: string): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const targetChars = Math.max(800, Math.min(2800, Number(process.env.WARRANTY_RMA_VECTOR_CHUNK_CHARS ?? 1600)));
  const overlapChars = Math.max(80, Math.min(500, Number(process.env.WARRANTY_RMA_VECTOR_CHUNK_OVERLAP_CHARS ?? 220)));
  const maxChunks = Math.max(1, Math.min(1000, Number(process.env.WARRANTY_RMA_VECTOR_MAX_CHUNKS_PER_DOCUMENT ?? 240)));
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < normalized.length && chunks.length < maxChunks) {
    let end = Math.min(normalized.length, cursor + targetChars);
    if (end < normalized.length) {
      const window = normalized.slice(cursor, end);
      const sentenceBreak = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n\n"), window.lastIndexOf("; "));
      if (sentenceBreak > Math.floor(targetChars * 0.55)) {
        end = cursor + sentenceBreak + 1;
      }
    }
    const chunk = normalized.slice(cursor, end).trim();
    if (chunk.length >= 80) chunks.push(chunk);
    const nextCursor = Math.max(end - overlapChars, cursor + 1);
    if (nextCursor <= cursor) break;
    cursor = nextCursor;
  }
  return chunks;
}

function textFileLike(manual: WarrantyRmaManualDocument) {
  const mime = String(manual.mimeType ?? "").toLowerCase();
  return /^(text\/|application\/json|application\/xml)/i.test(mime) || /\.(txt|md|csv|json|xml)$/i.test(manual.fileName);
}

export async function extractWarrantyRmaManualText(manual: WarrantyRmaManualDocument): Promise<string> {
  const buffer = await fs.readFile(manual.storagePath);
  const header = [
    `Document title: ${manual.title}`,
    `File name: ${manual.fileName}`,
    manual.documentType ? `Document type: ${manual.documentType}` : "",
    manual.notes ? `Notes: ${manual.notes}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  if (String(manual.mimeType ?? "").toLowerCase() === "application/pdf" || /\.pdf$/i.test(manual.fileName)) {
    const parsed = await pdfParse(buffer);
    return normalizeText([header, parsed.text ?? ""].filter(Boolean).join("\n\n"));
  }
  if (textFileLike(manual)) {
    return normalizeText([header, buffer.toString("utf8")].filter(Boolean).join("\n\n"));
  }
  if (String(manual.mimeType ?? "").toLowerCase().startsWith("image/")) {
    return normalizeText(header);
  }
  return normalizeText(header);
}

async function loadManifest(): Promise<WarrantyRmaVectorManifest> {
  try {
    const raw = await fs.readFile(VECTOR_MANIFEST_PATH, "utf8");
    const parsed = JSON.parse(raw) as WarrantyRmaVectorManifest;
    return {
      version: 1,
      updatedAt: String(parsed.updatedAt ?? nowIso()),
      manuals: parsed.manuals && typeof parsed.manuals === "object" ? parsed.manuals : {}
    };
  } catch {
    return { version: 1, updatedAt: nowIso(), manuals: {} };
  }
}

async function saveManifest(manifest: WarrantyRmaVectorManifest) {
  manifest.updatedAt = nowIso();
  await fs.mkdir(path.dirname(VECTOR_MANIFEST_PATH), { recursive: true });
  const tmp = `${VECTOR_MANIFEST_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2), "utf8");
  await fs.rename(tmp, VECTOR_MANIFEST_PATH);
}

async function resolvePineconeHost() {
  const directHost = directPineconeHost();
  if (directHost) return directHost;
  if (cachedPineconeHost) return cachedPineconeHost;
  const indexName = vectorIndexName();
  if (!indexName) throw new Error("PINECONE_WARRANTY_INDEX is required.");
  const response = await fetch(`https://api.pinecone.io/indexes/${encodeURIComponent(indexName)}`, {
    headers: {
      "Api-Key": env("PINECONE_API_KEY"),
      "X-Pinecone-Api-Version": pineconeApiVersion()
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Pinecone index lookup failed (${response.status}): ${text.slice(0, 240)}`);
  }
  const parsed = JSON.parse(text) as { host?: string };
  const host = String(parsed.host ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!host) throw new Error("Pinecone index lookup did not return a host.");
  cachedPineconeHost = host;
  return host;
}

async function pineconeDataRequest(pathname: string, body: Record<string, unknown>) {
  const host = await resolvePineconeHost();
  const response = await fetch(`https://${host}${pathname}`, {
    method: "POST",
    headers: {
      "Api-Key": env("PINECONE_API_KEY"),
      "Content-Type": "application/json",
      "X-Pinecone-Api-Version": pineconeApiVersion()
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Pinecone ${pathname} failed (${response.status}): ${text.slice(0, 240)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function embedTexts(texts: string[]) {
  const response = await openaiClient().embeddings.create({
    model: vectorEmbeddingModel(),
    input: texts
  });
  return response.data.map(row => row.embedding);
}

function vectorIdForManualChunk(manualId: string, chunkIndex: number) {
  const safeManualId = manualId.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 120);
  return `wrm_${safeManualId}_${String(chunkIndex).padStart(4, "0")}`;
}

function metadataForChunk(
  manual: WarrantyRmaManualDocument,
  chunk: string,
  contentHash: string,
  chunkIndex: number,
  chunkCount: number
) {
  return {
    source: VECTOR_SOURCE,
    manualId: manual.id,
    title: manual.title,
    fileName: manual.fileName,
    documentType: manual.documentType ?? "other",
    contentHash,
    chunkIndex,
    chunkCount,
    text: chunk.slice(0, 2800)
  };
}

async function deleteVectorIds(ids: string[]) {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 1000) {
    const batch = ids.slice(i, i + 1000);
    if (!batch.length) continue;
    await pineconeDataRequest("/vectors/delete", {
      namespace: vectorNamespace(),
      ids: batch
    });
    deleted += batch.length;
  }
  return deleted;
}

export async function indexWarrantyRmaManuals(
  manuals: WarrantyRmaManualDocument[],
  options: { manualIds?: string[] } = {}
): Promise<WarrantyRmaVectorIndexResult> {
  const status = getWarrantyRmaVectorStatus();
  const selectedIds = new Set((options.manualIds ?? []).map(id => String(id).trim()).filter(Boolean));
  const candidates = selectedIds.size ? manuals.filter(manual => selectedIds.has(manual.id)) : manuals;
  const result: WarrantyRmaVectorIndexResult = {
    configured: status.configured,
    indexName: status.indexName,
    namespace: status.namespace,
    documentsConsidered: candidates.length,
    documentsIndexed: 0,
    chunksUpserted: 0,
    chunksDeleted: 0,
    skipped: [],
    errors: []
  };
  if (!status.configured) {
    result.errors.push({ error: `Vector search is not configured. Missing: ${status.missing.join(", ")}` });
    return result;
  }

  const manifest = await loadManifest();
  for (const manual of candidates) {
    try {
      const text = await extractWarrantyRmaManualText(manual);
      const chunks = chunkWarrantyRmaTextForVectorIndex(text);
      if (!chunks.length) {
        result.skipped.push({ manualId: manual.id, title: manual.title, reason: "No extractable text." });
        continue;
      }
      const contentHash = sha256(text);
      const previous = manifest.manuals[manual.id];
      if (previous?.contentHash === contentHash && previous.chunkCount === chunks.length) {
        result.skipped.push({ manualId: manual.id, title: manual.title, reason: "Already indexed." });
        continue;
      }
      if (previous?.vectorIds?.length) {
        result.chunksDeleted += await deleteVectorIds(previous.vectorIds);
      }

      const vectorIds = chunks.map((_, index) => vectorIdForManualChunk(manual.id, index));
      for (let i = 0; i < chunks.length; i += 64) {
        const textBatch = chunks.slice(i, i + 64);
        const embeddings = await embedTexts(textBatch);
        const vectors = textBatch.map((chunk, offset) => {
          const chunkIndex = i + offset;
          return {
            id: vectorIds[chunkIndex],
            values: embeddings[offset],
            metadata: metadataForChunk(manual, chunk, contentHash, chunkIndex, chunks.length)
          };
        });
        await pineconeDataRequest("/vectors/upsert", {
          namespace: vectorNamespace(),
          vectors
        });
        result.chunksUpserted += vectors.length;
      }
      manifest.manuals[manual.id] = {
        title: manual.title,
        fileName: manual.fileName,
        contentHash,
        chunkCount: chunks.length,
        vectorIds,
        indexedAt: nowIso()
      };
      result.documentsIndexed += 1;
    } catch (err) {
      result.errors.push({
        manualId: manual.id,
        title: manual.title,
        error: err instanceof Error ? err.message : "Document could not be indexed."
      });
    }
  }
  await saveManifest(manifest);
  return result;
}

export async function deleteWarrantyRmaManualVectors(manualId: string): Promise<{
  configured: boolean;
  deleted: number;
  error?: string;
}> {
  const status = getWarrantyRmaVectorStatus();
  if (!status.configured) return { configured: false, deleted: 0 };
  const id = String(manualId ?? "").trim();
  if (!id) return { configured: true, deleted: 0 };
  const manifest = await loadManifest();
  const previous = manifest.manuals[id];
  if (!previous?.vectorIds?.length) {
    delete manifest.manuals[id];
    await saveManifest(manifest);
    return { configured: true, deleted: 0 };
  }
  try {
    const deleted = await deleteVectorIds(previous.vectorIds);
    delete manifest.manuals[id];
    await saveManifest(manifest);
    return { configured: true, deleted };
  } catch (err) {
    return {
      configured: true,
      deleted: 0,
      error: err instanceof Error ? err.message : "Warranty/RMA vectors could not be deleted."
    };
  }
}

function queryFilter(manualIds: string[] | undefined) {
  const ids = Array.from(new Set((manualIds ?? []).map(id => String(id).trim()).filter(Boolean)));
  if (ids.length === 1) return { manualId: { "$eq": ids[0] } };
  if (ids.length > 1) return { manualId: { "$in": ids } };
  return { source: { "$eq": VECTOR_SOURCE } };
}

export async function searchWarrantyRmaManualChunks(args: {
  query: string;
  manualIds?: string[];
  topK?: number;
}): Promise<WarrantyRmaVectorMatch[]> {
  if (!getWarrantyRmaVectorStatus().configured) return [];
  const query = normalizeText(args.query).slice(0, 8000);
  if (!query) return [];
  const [embedding] = await embedTexts([query]);
  if (!embedding) return [];
  const topK = Math.max(1, Math.min(24, Number(args.topK ?? process.env.WARRANTY_RMA_VECTOR_TOP_K ?? 8)));
  const response = await pineconeDataRequest("/query", {
    namespace: vectorNamespace(),
    vector: embedding,
    topK,
    includeMetadata: true,
    filter: queryFilter(args.manualIds)
  });
  const matches: any[] = Array.isArray(response.matches) ? response.matches : [];
  return matches
    .map((match: any): WarrantyRmaVectorMatch => {
      const metadata = match?.metadata && typeof match.metadata === "object" ? match.metadata : {};
      return {
        id: String(match?.id ?? ""),
        score: Number(match?.score ?? 0),
        manualId: String(metadata.manualId ?? ""),
        title: String(metadata.title ?? ""),
        fileName: String(metadata.fileName ?? ""),
        documentType: String(metadata.documentType ?? ""),
        chunkIndex: Number(metadata.chunkIndex ?? 0),
        chunkCount: Number(metadata.chunkCount ?? 0),
        text: String(metadata.text ?? "")
      };
    })
    .filter((match: WarrantyRmaVectorMatch) => match.id && match.text)
    .sort((a: WarrantyRmaVectorMatch, b: WarrantyRmaVectorMatch) => b.score - a.score);
}

export function warrantyRmaVectorQueryForSubmission(submission: WarrantyRmaSubmission) {
  return [
    submission.claimType ? `Claim type: ${submission.claimType}` : "",
    submission.partNumber ? `Part number: ${submission.partNumber}` : "",
    submission.partDescription ? `Part description: ${submission.partDescription}` : "",
    submission.issueDescription ? `Issue: ${submission.issueDescription}` : "",
    submission.requestedAction ? `Requested action: ${submission.requestedAction}` : "",
    submission.vin ? `VIN: ${submission.vin}` : "",
    submission.mileage ? `Mileage: ${submission.mileage}` : "",
    submission.invoiceNumber ? `Invoice: ${submission.invoiceNumber}` : "",
    submission.orderNumber ? `Order: ${submission.orderNumber}` : "",
    submission.roNumber ? `Repair order: ${submission.roNumber}` : "",
    submission.customerConcernCode ? `Customer concern code: ${submission.customerConcernCode}` : "",
    submission.conditionCode ? `Condition code: ${submission.conditionCode}` : "",
    submission.carrierName ? `Carrier: ${submission.carrierName}` : "",
    submission.bolNumber ? `BOL: ${submission.bolNumber}` : "",
    submission.cause ? `Cause: ${submission.cause}` : "",
    submission.correction ? `Correction: ${submission.correction}` : "",
    submission.notes ? `Notes: ${submission.notes}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}
