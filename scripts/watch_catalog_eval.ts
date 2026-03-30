import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

type Catalog = {
  aliases?: Record<string, string[]>;
  families?: Record<string, string[]>;
};

type SessionRow = {
  token?: string;
  userId?: string;
  expiresAt?: string;
};

type Json = Record<string, any>;

const BASE_URL = String(process.env.BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? "3001"}`).replace(/\/+$/, "");
const API_PREFIX_RAW = String(process.env.API_PREFIX ?? "");
const API_PREFIX = API_PREFIX_RAW === "/" ? "" : API_PREFIX_RAW.replace(/\/+$/, "");
const TEST_PHONE = String(process.env.TEST_PHONE ?? "+19995550123");
const MAX_ITEMS = Number(process.env.MAX_ITEMS ?? "0");
const DEBUG = /^(1|true|yes)$/i.test(String(process.env.DEBUG ?? ""));
const CATALOG_PATH = String(
  process.env.MODEL_CODES_BY_FAMILY_PATH ??
    path.resolve(process.cwd(), "services/api/src/domain/model_codes_by_family.json")
);
const AUTH_TOKEN_ENV = String(process.env.AUTH_TOKEN ?? process.env.X_AUTH_TOKEN ?? "").trim();

function endpoint(route: string): string {
  const p = route.startsWith("/") ? route : `/${route}`;
  return `${BASE_URL}${API_PREFIX}${p}`;
}

function isNotExpired(iso: string | undefined): boolean {
  if (!iso) return true;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return true;
  return t > Date.now();
}

function candidateSessionPaths(): string[] {
  const dataDir = String(process.env.DATA_DIR ?? "").trim();
  const explicit = String(process.env.SESSIONS_PATH ?? "").trim();
  return Array.from(
    new Set(
      [
        explicit,
        dataDir ? path.join(dataDir, "sessions.json") : "",
        path.resolve(process.cwd(), "services/api/data/sessions.json"),
        path.resolve(process.cwd(), "data/sessions.json"),
        "/home/ubuntu/throttleiq-runtime/data/sessions.json"
      ].filter(Boolean)
    )
  );
}

async function loadAuthToken(): Promise<string> {
  if (AUTH_TOKEN_ENV) return AUTH_TOKEN_ENV;
  for (const p of candidateSessionPaths()) {
    try {
      if (!existsSync(p)) continue;
      const raw = await readFile(p, "utf8");
      const parsed = JSON.parse(raw) as { sessions?: SessionRow[] };
      const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
      const valid = sessions.find(s => s?.token && isNotExpired(s.expiresAt));
      if (valid?.token) return String(valid.token);
    } catch {
      // try next path
    }
  }
  throw new Error(
    "No auth token found. Set AUTH_TOKEN=<token> or provide readable sessions.json " +
      "(DATA_DIR/sessions.json or /home/ubuntu/throttleiq-runtime/data/sessions.json)."
  );
}

function mergeHeaders(base: HeadersInit | undefined, extra: Record<string, string>): HeadersInit {
  const out: Record<string, string> = {};
  if (base && !Array.isArray(base)) {
    for (const [k, v] of Object.entries(base as Record<string, string>)) out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) out[k] = v;
  return out;
}

async function requestJson(
  route: string,
  authToken: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; json: Json; text: string }> {
  const url = endpoint(route);
  const headers = mergeHeaders(init?.headers, {
    "x-auth-token": authToken,
    Authorization: `Bearer ${authToken}`
  });
  const res = await fetch(url, { ...(init ?? {}), headers });
  const text = await res.text();
  let json: Json = {};
  try {
    json = text ? (JSON.parse(text) as Json) : {};
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, json, text };
}

function normalizeKey(v: string): string {
  return String(v ?? "").trim().toLowerCase();
}

async function loadCatalog(): Promise<{ aliases: string[]; families: string[]; all: string[] }> {
  const raw = await readFile(CATALOG_PATH, "utf8");
  const parsed = JSON.parse(raw) as Catalog;
  const aliases = Object.keys(parsed.aliases ?? {}).map(s => s.trim()).filter(Boolean).sort();
  const families = Object.keys(parsed.families ?? {}).map(s => s.trim()).filter(Boolean).sort();
  const dedup = new Map<string, string>();
  for (const name of [...aliases, ...families]) {
    const key = normalizeKey(name);
    if (!key || dedup.has(key)) continue;
    dedup.set(key, name);
  }
  const all = [...dedup.values()].sort((a, b) => a.localeCompare(b));
  return { aliases, families, all };
}

async function preflight(authToken: string): Promise<void> {
  const inv = await requestJson("/inventory", authToken);
  if (!inv.ok) {
    throw new Error(
      `Preflight failed: GET ${endpoint("/inventory")} => ${inv.status}\n` +
        `Response: ${inv.text.slice(0, 300)}\n` +
        `Hint: set API_PREFIX=/api if you are calling through the web domain.`
    );
  }
  const compose = await requestJson("/conversations/compose", authToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: TEST_PHONE, firstName: "Watch", lastName: "Catalog" })
  });
  if (!compose.ok) {
    throw new Error(
      `Preflight failed: POST ${endpoint("/conversations/compose")} => ${compose.status}\n` +
        `Response: ${compose.text.slice(0, 300)}`
    );
  }
}

async function run(): Promise<void> {
  const authToken = await loadAuthToken();
  await preflight(authToken);
  const catalog = await loadCatalog();
  const names = MAX_ITEMS > 0 ? catalog.all.slice(0, MAX_ITEMS) : catalog.all;
  const convId = encodeURIComponent(TEST_PHONE);

  const failures: Array<Record<string, any>> = [];
  let idx = 0;

  for (const model of names) {
    idx += 1;
    const clear = await requestJson(`/conversations/${convId}/watch`, authToken, { method: "DELETE" });
    if (!clear.ok) {
      failures.push({
        model,
        step: "clear_watch",
        status: clear.status,
        error: clear.json?.error ?? clear.text.slice(0, 180)
      });
      continue;
    }

    const set = await requestJson(`/conversations/${convId}/watch`, authToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ model }] })
    });
    if (!set.ok) {
      failures.push({
        model,
        step: "set_watch",
        status: set.status,
        error: set.json?.error ?? set.text.slice(0, 180)
      });
      continue;
    }

    const get = await requestJson(`/conversations/${convId}`, authToken);
    if (!get.ok) {
      failures.push({
        model,
        step: "get_conversation",
        status: get.status,
        error: get.json?.error ?? get.text.slice(0, 180)
      });
      continue;
    }

    const stored = String(get.json?.conversation?.inventoryWatches?.[0]?.model ?? "");
    if (stored !== model) {
      failures.push({
        model,
        step: "verify_saved_model",
        status: get.status,
        gotModel: stored || null
      });
      continue;
    }

    if (DEBUG && idx % 25 === 0) {
      console.log(`[watch-catalog-eval] progress ${idx}/${names.length}`);
    }
  }

  const passed = names.length - failures.length;
  console.log(`Catalog aliases+families tested: ${names.length}`);
  console.log(`Pass: ${passed}`);
  console.log(`Fail: ${failures.length}`);
  if (failures.length) {
    console.log("Sample failures:");
    console.table(failures.slice(0, 100));
    process.exitCode = 1;
    return;
  }
  console.log("All checks passed.");
}

run().catch(err => {
  console.error("[watch-catalog-eval] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
