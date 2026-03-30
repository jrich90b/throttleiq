import { readFile } from "node:fs/promises";
import path from "node:path";

type Catalog = {
  aliases?: Record<string, string[]>;
  families?: Record<string, string[]>;
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

function endpoint(route: string): string {
  const p = route.startsWith("/") ? route : `/${route}`;
  return `${BASE_URL}${API_PREFIX}${p}`;
}

async function requestJson(route: string, init?: RequestInit): Promise<{ ok: boolean; status: number; json: Json; text: string }> {
  const url = endpoint(route);
  const res = await fetch(url, init);
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

async function preflight(): Promise<void> {
  const inv = await requestJson("/inventory");
  if (!inv.ok) {
    throw new Error(
      `Preflight failed: GET ${endpoint("/inventory")} => ${inv.status}\n` +
        `Response: ${inv.text.slice(0, 300)}\n` +
        `Hint: set API_PREFIX=/api if you are calling through the web domain.`
    );
  }
  const compose = await requestJson("/conversations/compose", {
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
  await preflight();
  const catalog = await loadCatalog();
  const names = MAX_ITEMS > 0 ? catalog.all.slice(0, MAX_ITEMS) : catalog.all;
  const convId = encodeURIComponent(TEST_PHONE);

  const failures: Array<Record<string, any>> = [];
  let idx = 0;

  for (const model of names) {
    idx += 1;
    const clear = await requestJson(`/conversations/${convId}/watch`, { method: "DELETE" });
    if (!clear.ok) {
      failures.push({
        model,
        step: "clear_watch",
        status: clear.status,
        error: clear.json?.error ?? clear.text.slice(0, 180)
      });
      continue;
    }

    const set = await requestJson(`/conversations/${convId}/watch`, {
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

    const get = await requestJson(`/conversations/${convId}`);
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

