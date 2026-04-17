import { promises as fs } from "node:fs";
import { dataPath } from "./dataDir.js";

export type MetaPageSnapshot = {
  id: string;
  name: string;
  hasInstagram: boolean;
  instagramBusinessAccountId?: string;
  instagramBusinessAccountUsername?: string;
};

export type MetaIntegrationRecord = {
  connectedAt: string;
  updatedAt: string;
  userAccessToken: string;
  pageId: string;
  pageName: string;
  pageAccessToken: string;
  instagramBusinessAccountId?: string;
  instagramBusinessAccountUsername?: string;
  availablePages: MetaPageSnapshot[];
};

const DB_PATH = process.env.META_INTEGRATION_DB_PATH
  ? String(process.env.META_INTEGRATION_DB_PATH)
  : dataPath("meta_integration.json");

let loaded = false;
let cache: MetaIntegrationRecord | null = null;

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<MetaIntegrationRecord>;
    const pageId = String(parsed?.pageId ?? "").trim();
    const pageAccessToken = String(parsed?.pageAccessToken ?? "").trim();
    const userAccessToken = String(parsed?.userAccessToken ?? "").trim();
    if (!pageId || !pageAccessToken || !userAccessToken) {
      cache = null;
      return;
    }
    const availablePages = Array.isArray(parsed?.availablePages)
      ? parsed.availablePages
          .map((p: any) => ({
            id: String(p?.id ?? "").trim(),
            name: String(p?.name ?? "").trim() || "Facebook Page",
            hasInstagram: Boolean(p?.hasInstagram),
            instagramBusinessAccountId: String(p?.instagramBusinessAccountId ?? "").trim() || undefined,
            instagramBusinessAccountUsername:
              String(p?.instagramBusinessAccountUsername ?? "").trim() || undefined
          }))
          .filter(p => p.id)
      : [];
    cache = {
      connectedAt: String(parsed?.connectedAt ?? "").trim() || new Date().toISOString(),
      updatedAt: String(parsed?.updatedAt ?? "").trim() || new Date().toISOString(),
      userAccessToken,
      pageId,
      pageName: String(parsed?.pageName ?? "").trim() || "Facebook Page",
      pageAccessToken,
      instagramBusinessAccountId: String(parsed?.instagramBusinessAccountId ?? "").trim() || undefined,
      instagramBusinessAccountUsername:
        String(parsed?.instagramBusinessAccountUsername ?? "").trim() || undefined,
      availablePages
    };
  } catch {
    cache = null;
  }
}

async function writeRecord(record: MetaIntegrationRecord | null) {
  await fs.mkdir(new URL(".", `file://${DB_PATH}`).pathname, { recursive: true }).catch(async () => {
    const path = await import("node:path");
    await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  });
  const tmpPath = `${DB_PATH}.tmp`;
  if (!record) {
    await fs.rm(DB_PATH, { force: true }).catch(() => undefined);
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    return;
  }
  await fs.writeFile(tmpPath, JSON.stringify(record, null, 2), "utf8");
  await fs.rename(tmpPath, DB_PATH);
}

export async function getMetaIntegrationRecord(): Promise<MetaIntegrationRecord | null> {
  await ensureLoaded();
  if (!cache) return null;
  return {
    ...cache,
    availablePages: Array.isArray(cache.availablePages) ? cache.availablePages.map(p => ({ ...p })) : []
  };
}

export async function saveMetaIntegrationRecord(record: MetaIntegrationRecord): Promise<void> {
  await ensureLoaded();
  cache = {
    ...record,
    availablePages: Array.isArray(record.availablePages)
      ? record.availablePages
          .map(p => ({
            id: String(p?.id ?? "").trim(),
            name: String(p?.name ?? "").trim() || "Facebook Page",
            hasInstagram: Boolean(p?.hasInstagram),
            instagramBusinessAccountId: String(p?.instagramBusinessAccountId ?? "").trim() || undefined,
            instagramBusinessAccountUsername:
              String(p?.instagramBusinessAccountUsername ?? "").trim() || undefined
          }))
          .filter(p => p.id)
      : []
  };
  await writeRecord(cache);
}

export async function clearMetaIntegrationRecord(): Promise<void> {
  await ensureLoaded();
  cache = null;
  await writeRecord(null);
}

export async function getMetaIntegrationStatus() {
  const record = await getMetaIntegrationRecord();
  if (!record) {
    return {
      connected: false as const
    };
  }
  return {
    connected: true as const,
    connectedAt: record.connectedAt,
    updatedAt: record.updatedAt,
    pageId: record.pageId,
    pageName: record.pageName,
    hasInstagram: Boolean(record.instagramBusinessAccountId),
    instagramBusinessAccountId: record.instagramBusinessAccountId,
    instagramBusinessAccountUsername: record.instagramBusinessAccountUsername,
    availablePages: record.availablePages
  };
}
