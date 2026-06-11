import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import OpenAI from "openai";
import { dataPath } from "./dataDir.js";
import type { WarrantyRmaManualDocument } from "./warrantyRmaStore.js";
import type { WarrantyRmaSubmission } from "./warrantyRmaAssistant.js";

const require = createRequire(import.meta.url);
type PdfParseFn = (buffer: Buffer) => Promise<{ text?: string }>;
let cachedPdfParse: PdfParseFn | null | undefined;

function getPdfParse(): PdfParseFn {
  if (cachedPdfParse !== undefined) {
    if (!cachedPdfParse) {
      throw new Error("pdf-parse is not installed; PDF warranty/RMA manual extraction is unavailable in this environment.");
    }
    return cachedPdfParse;
  }
  try {
    cachedPdfParse = require("pdf-parse/lib/pdf-parse.js") as PdfParseFn;
  } catch {
    cachedPdfParse = null;
    throw new Error("pdf-parse is not installed; PDF warranty/RMA manual extraction is unavailable in this environment.");
  }
  return cachedPdfParse;
}

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
      namespace?: string;
      scope?: "global" | "dealer";
      indexedAt: string;
    }
  >;
};

export type WarrantyRmaVectorStatus = {
  configured: boolean;
  missing: string[];
  indexName: string;
  namespace: string;
  globalNamespace: string;
  dealerNamespace: string;
  legacyNamespace?: string;
  searchNamespaces: string[];
  embeddingModel: string;
  apiVersion: string;
  hostConfigured: boolean;
};

export type WarrantyRmaVectorIndexResult = {
  configured: boolean;
  indexName: string;
  namespace: string;
  namespaces: string[];
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
  namespace: string;
  scope: "global" | "dealer" | "legacy";
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

function vectorGlobalNamespace() {
  return env("PINECONE_WARRANTY_GLOBAL_NAMESPACE") || "warranty-rma-global";
}

function vectorDealerNamespace() {
  const explicit = env("PINECONE_WARRANTY_DEALER_NAMESPACE");
  if (explicit) return explicit;
  const dealerSlug = env("DEALER_SLUG") || env("DEALER_ID") || env("TENANT_SLUG");
  return dealerSlug ? `dealer-${dealerSlug.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase()}` : "dealer-default";
}

function vectorLegacyNamespace() {
  return env("PINECONE_WARRANTY_LEGACY_NAMESPACE") || env("PINECONE_WARRANTY_NAMESPACE") || undefined;
}

function uniqueNamespaces(namespaces: Array<string | undefined>) {
  return Array.from(new Set(namespaces.map(value => String(value ?? "").trim()).filter(Boolean)));
}

function activeSearchNamespaces() {
  return uniqueNamespaces([vectorGlobalNamespace(), vectorDealerNamespace(), vectorLegacyNamespace()]);
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
    namespace: vectorGlobalNamespace(),
    globalNamespace: vectorGlobalNamespace(),
    dealerNamespace: vectorDealerNamespace(),
    legacyNamespace: vectorLegacyNamespace(),
    searchNamespaces: activeSearchNamespaces(),
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
    const parsed = await getPdfParse()(buffer);
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

function manualScope(manual: WarrantyRmaManualDocument): "global" | "dealer" {
  return manual.scope === "dealer" ? "dealer" : "global";
}

export function namespaceForWarrantyRmaManual(manual: WarrantyRmaManualDocument) {
  return manualScope(manual) === "dealer" ? vectorDealerNamespace() : vectorGlobalNamespace();
}

function metadataForChunk(
  manual: WarrantyRmaManualDocument,
  chunk: string,
  contentHash: string,
  chunkIndex: number,
  chunkCount: number,
  namespace: string
) {
  return {
    source: VECTOR_SOURCE,
    manualId: manual.id,
    title: manual.title,
    fileName: manual.fileName,
    documentType: manual.documentType ?? "other",
    scope: manualScope(manual),
    namespace,
    contentHash,
    chunkIndex,
    chunkCount,
    text: chunk.slice(0, 2800)
  };
}

async function deleteVectorIds(ids: string[], namespace: string) {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 1000) {
    const batch = ids.slice(i, i + 1000);
    if (!batch.length) continue;
    await pineconeDataRequest("/vectors/delete", {
      namespace,
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
    namespaces: [],
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
  const namespacesTouched = new Set<string>();
  for (const manual of candidates) {
    try {
      const namespace = namespaceForWarrantyRmaManual(manual);
      namespacesTouched.add(namespace);
      const text = await extractWarrantyRmaManualText(manual);
      const chunks = chunkWarrantyRmaTextForVectorIndex(text);
      if (!chunks.length) {
        result.skipped.push({ manualId: manual.id, title: manual.title, reason: "No extractable text." });
        continue;
      }
      const contentHash = sha256(text);
      const previous = manifest.manuals[manual.id];
      if (previous?.contentHash === contentHash && previous.chunkCount === chunks.length && previous.namespace === namespace) {
        result.skipped.push({ manualId: manual.id, title: manual.title, reason: "Already indexed." });
        continue;
      }
      if (previous?.vectorIds?.length && previous.namespace && previous.namespace !== namespace) {
        result.chunksDeleted += await deleteVectorIds(previous.vectorIds, previous.namespace);
      } else if (previous?.vectorIds?.length && previous.namespace === namespace) {
        result.chunksDeleted += await deleteVectorIds(previous.vectorIds, namespace);
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
            metadata: metadataForChunk(manual, chunk, contentHash, chunkIndex, chunks.length, namespace)
          };
        });
        await pineconeDataRequest("/vectors/upsert", {
          namespace,
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
        namespace,
        scope: manualScope(manual),
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
  result.namespaces = Array.from(namespacesTouched);
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
    let deleted = 0;
    for (const namespace of uniqueNamespaces([previous.namespace, ...activeSearchNamespaces()])) {
      deleted += await deleteVectorIds(previous.vectorIds, namespace);
    }
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

function scopeForNamespace(namespace: string): "global" | "dealer" | "legacy" {
  if (namespace === vectorDealerNamespace()) return "dealer";
  if (namespace === vectorGlobalNamespace()) return "global";
  return "legacy";
}

type WarrantyRmaRetrievalHintGroup = {
  key: string;
  aliases: string[];
  matchPatterns: RegExp[];
};

const CLAIM_RETRIEVAL_HINTS: WarrantyRmaRetrievalHintGroup[] = [
  {
    key: "freight_damage",
    aliases: ["FRT", "freight damage", "shipping damage", "product damaged in shipping", "carrier", "BOL", "ShipExec"],
    matchPatterns: [/\bfrt\b/i, /freight/i, /shipping damage/i, /damaged in shipping/i, /carrier/i, /\bbol\b/i, /shipexec/i]
  },
  {
    key: "parts_rma",
    aliases: ["RMA", "return merchandise authorization", "parts return", "replacement", "credit", "shortage", "wrong part", "return authorization"],
    matchPatterns: [/\brma\b/i, /return merchandise/i, /parts? return/i, /shortage/i, /wrong part/i, /return authorization/i]
  },
  {
    key: "parts_accessory_warranty",
    aliases: ["PNA", "parts accessory warranty", "P&A warranty", "parts warranty", "accessory warranty", "part number", "invoice"],
    matchPatterns: [/\bpna\b/i, /parts? accessory/i, /\bp&a\b/i, /parts? warranty/i, /accessory warranty/i]
  },
  {
    key: "dealer_stock_parts",
    aliases: ["DFS", "dealer stock parts", "over-the-counter parts", "counter parts warranty", "dealer inventory parts"],
    matchPatterns: [/\bdfs\b/i, /dealer stock parts?/i, /over[- ]the[- ]counter parts?/i, /counter parts? warranty/i, /dealer inventory parts?/i]
  },
  {
    key: "motorcycle_warranty",
    aliases: ["MC", "motorcycle warranty", "vehicle warranty", "warranty manual", "VIN", "mileage", "customer concern code", "condition code"],
    matchPatterns: [/\bmc\b/i, /motorcycle warranty/i, /vehicle warranty/i, /warranty manual/i, /\bvin\b/i, /mileage/i, /concern code/i, /condition code/i]
  },
  {
    key: "pre_delivery_warranty",
    aliases: ["PRD", "pre-delivery", "pre delivery", "loose parts", "setup claim"],
    matchPatterns: [/\bprd\b/i, /pre[- ]delivery/i, /loose parts?/i, /setup claim/i]
  },
  {
    key: "recall_campaign",
    aliases: ["recall", "campaign", "dealer service card", "service card"],
    matchPatterns: [/recall/i, /campaign/i, /dealer service card/i, /service card/i]
  },
  {
    key: "goodwill",
    aliases: ["GDW", "goodwill", "good will", "customer satisfaction", "policy adjustment"],
    matchPatterns: [/\bgdw\b/i, /good ?will/i, /customer satisfaction/i, /policy adjustment/i]
  },
  {
    key: "general_merchandise",
    aliases: ["GM", "general merchandise", "apparel", "licensed merchandise"],
    matchPatterns: [/\bgm\b/i, /general merchandise/i, /apparel/i, /licensed merchandise/i]
  },
  {
    key: "engine_return",
    aliases: ["engine return", "longblock", "long block", "core return"],
    matchPatterns: [/engine return/i, /long ?block/i, /core return/i]
  }
];

function normalizedClaimSignal(submission: WarrantyRmaSubmission) {
  const source = [
    submission.claimType,
    submission.issueDescription,
    submission.partDescription,
    submission.requestedAction,
    submission.carrierName,
    submission.bolNumber,
    submission.returnAuthorizationNumber,
    submission.cause,
    submission.correction,
    submission.notes
  ]
    .filter(Boolean)
    .join(" ");
  return source.toLowerCase().replace(/[_-]+/g, " ");
}

export function warrantyRmaRetrievalHintsForSubmission(submission: WarrantyRmaSubmission): string[] {
  const source = normalizedClaimSignal(submission);
  if (!source) return [];
  const hints = new Set<string>();
  for (const group of CLAIM_RETRIEVAL_HINTS) {
    const keyMatches = source.includes(group.key.replace(/_/g, " "));
    const aliasMatches = group.aliases.some(alias => source.includes(alias.toLowerCase()));
    const patternMatches = group.matchPatterns.some(pattern => pattern.test(source));
    if (keyMatches || aliasMatches || patternMatches) {
      for (const alias of group.aliases) hints.add(alias);
    }
  }
  return Array.from(hints).slice(0, 28);
}

function retrievalBoostForMatch(match: WarrantyRmaVectorMatch, submission: WarrantyRmaSubmission) {
  const hints = warrantyRmaRetrievalHintsForSubmission(submission);
  if (!hints.length) return 0;
  const haystack = [
    match.title,
    match.fileName,
    match.documentType,
    match.text.slice(0, 600)
  ]
    .join(" ")
    .toLowerCase();
  let hits = 0;
  for (const hint of hints) {
    if (haystack.includes(hint.toLowerCase())) hits += 1;
  }
  return Math.min(0.12, hits * 0.025);
}

export function rankWarrantyRmaVectorMatchesForSubmission(
  matches: WarrantyRmaVectorMatch[],
  submission: WarrantyRmaSubmission
): WarrantyRmaVectorMatch[] {
  return matches
    .map((match, index) => ({
      match,
      index,
      boostedScore: match.score + retrievalBoostForMatch(match, submission)
    }))
    .sort((a, b) => b.boostedScore - a.boostedScore || b.match.score - a.match.score || a.index - b.index)
    .map(row => row.match);
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
  const filter = queryFilter(args.manualIds);
  const namespaceResults = await Promise.allSettled(
    activeSearchNamespaces().map(async namespace => {
      const response = await pineconeDataRequest("/query", {
        namespace,
        vector: embedding,
        topK,
        includeMetadata: true,
        filter
      });
      const matches: any[] = Array.isArray(response.matches) ? response.matches : [];
      return matches.map((match: any): WarrantyRmaVectorMatch => {
        const metadata = match?.metadata && typeof match.metadata === "object" ? match.metadata : {};
        const metadataScope = String(metadata.scope ?? "");
        return {
          id: String(match?.id ?? ""),
          score: Number(match?.score ?? 0),
          manualId: String(metadata.manualId ?? ""),
          title: String(metadata.title ?? ""),
          fileName: String(metadata.fileName ?? ""),
          documentType: String(metadata.documentType ?? ""),
          namespace,
          scope:
            metadataScope === "global" || metadataScope === "dealer" || metadataScope === "legacy"
              ? metadataScope
              : scopeForNamespace(namespace),
          chunkIndex: Number(metadata.chunkIndex ?? 0),
          chunkCount: Number(metadata.chunkCount ?? 0),
          text: String(metadata.text ?? "")
        };
      });
    })
  );
  const deduped = new Map<string, WarrantyRmaVectorMatch>();
  for (const match of namespaceResults
    .flatMap(result => (result.status === "fulfilled" ? result.value : []))
    .filter((match: WarrantyRmaVectorMatch) => match.id && match.text)) {
    const key = [match.manualId, match.chunkIndex, match.text.slice(0, 160)].join(":");
    const previous = deduped.get(key);
    if (!previous || previous.scope === "legacy" || match.score > previous.score) {
      deduped.set(key, match);
    }
  }
  return Array.from(deduped.values())
    .sort((a: WarrantyRmaVectorMatch, b: WarrantyRmaVectorMatch) => b.score - a.score)
    .slice(0, topK);
}

export function warrantyRmaVectorQueryForSubmission(submission: WarrantyRmaSubmission) {
  const retrievalHints = warrantyRmaRetrievalHintsForSubmission(submission);
  return [
    submission.claimType ? `Claim type: ${submission.claimType}` : "",
    retrievalHints.length ? `Preferred warranty/RMA reference terms: ${retrievalHints.join(", ")}` : "",
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
