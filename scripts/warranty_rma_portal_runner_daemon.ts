import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnvFile(path.join(rootDir, ".env"));
loadEnvFile(path.join(rootDir, "services", "api", ".env"));

const intervalMs = Math.max(15_000, Number(process.env.WARRANTY_RMA_PORTAL_RUNNER_POLL_MS ?? 60_000));
const apiBase =
  process.env.WARRANTY_RMA_PORTAL_API_BASE_URL?.trim() ||
  process.env.MDF_PORTAL_API_BASE_URL?.trim() ||
  process.env.LEADRIDER_API_BASE_URL?.trim() ||
  "https://api.americanharley.leadrider.ai";

let running = false;
let stopping = false;

function loadEnvFile(filePath: string) {
  if (!existsSync(filePath)) return;
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function runOnce(): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(
      "npx",
      [
        "tsx",
        "scripts/warranty_rma_portal_runner.ts",
        "--run",
        "--idle-ok",
        "--api-base",
        apiBase
      ],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          WARRANTY_RMA_HDNET_URL: process.env.WARRANTY_RMA_HDNET_URL?.trim() || process.env.MDF_HDNET_URL?.trim() || "https://h-dnet.com"
        },
        stdio: "inherit"
      }
    );
    child.on("close", code => resolve(code ?? 1));
    child.on("error", err => {
      console.error("[warranty/RMA portal daemon] runner spawn failed:", err?.message ?? err);
      resolve(1);
    });
  });
}

async function tick() {
  if (running || stopping) return;
  running = true;
  try {
    const code = await runOnce();
    if (code !== 0) console.warn(`[warranty/RMA portal daemon] runner exited with code ${code}`);
  } catch (err: any) {
    console.warn("[warranty/RMA portal daemon] runner failed:", err?.message ?? err);
  } finally {
    running = false;
  }
}

function stop() {
  stopping = true;
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

console.log(`[warranty/RMA portal daemon] polling ${apiBase} every ${Math.round(intervalMs / 1000)}s`);
void tick();
setInterval(() => void tick(), intervalMs);
