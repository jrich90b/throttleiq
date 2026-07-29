/**
 * MDF portal runner daemon (reliability rework 2026-07-29).
 *
 * Spawns scripts/mdf_portal_runner.ts each tick. This rework hardens the always-on loop:
 *  - TIMESTAMPS on every line (the old log had none — failures couldn't be dated).
 *  - CHROME AUTO-HEAL: when the dedicated CDP Chrome (:9222) is dead/unreachable, kickstart
 *    its LaunchAgent (ai.leadrider.hdnet-chrome) and re-probe — the #1 manual runbook item
 *    (a dead Chrome silently degraded every run to a guided packet). Only fires when the
 *    probe FAILS (a dead browser has nothing to lose); rate-limited; MDF_PORTAL_CHROME_AUTOHEAL=0
 *    disables.
 *  - POLL BACKOFF: repeated runner failures (API 502s during deploys, network blips) back off
 *    to 5-minute polling and log STATE CHANGES instead of a line per failure (the old log was
 *    a wall of "runner exited with code 1").
 *  - QUIET IDLE + hourly heartbeat: the runner's per-tick "No MDF portal task found." (83k
 *    lines / 2MB) is silenced (MDF_PORTAL_QUIET_IDLE=1); the daemon prints one heartbeat/hour
 *    with chrome state so "alive and healthy" is still visible.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnvFile(path.join(rootDir, ".env"));
loadEnvFile(path.join(rootDir, "services", "api", ".env"));

const intervalMs = Math.max(15_000, Number(process.env.MDF_PORTAL_RUNNER_POLL_MS ?? 60_000));
const failureBackoffMs = Math.max(intervalMs, Number(process.env.MDF_PORTAL_RUNNER_BACKOFF_MS ?? 5 * 60_000));
const apiBase =
  process.env.MDF_PORTAL_API_BASE_URL?.trim() ||
  process.env.LEADRIDER_API_BASE_URL?.trim() ||
  "https://api.americanharley.leadrider.ai";
const cdpUrl = process.env.MDF_PORTAL_CDP_URL?.trim() || process.env.BROWSER_USE_CDP_URL?.trim() || "";
const chromeAutohealEnabled = !["0", "false", "no"].includes(
  String(process.env.MDF_PORTAL_CHROME_AUTOHEAL ?? "1").trim().toLowerCase()
);
const CHROME_KICKSTART_COOLDOWN_MS = 10 * 60_000;
const HEARTBEAT_MS = 60 * 60_000;

let running = false;
let stopping = false;
let consecutiveFailures = 0;
let backoffUntil = 0;
let lastKickstartAt = 0;
let lastHeartbeatAt = 0;
let tickCount = 0;
let failuresTotal = 0;
let lastChromeOk: boolean | null = null;

function ts(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}
function log(message: string) {
  console.log(`[${ts()}] ${message}`);
}
function warn(message: string) {
  console.warn(`[${ts()}] ${message}`);
}

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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

async function probeChrome(): Promise<boolean> {
  if (!cdpUrl) return true; // no CDP configured => nothing to probe (guided-only setup)
  try {
    const res = await fetch(new URL("/json/version", cdpUrl), { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Restart the dedicated runner Chrome's LaunchAgent when it's dead (the manual runbook, automated). */
async function kickstartChrome(): Promise<void> {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  await new Promise<void>(resolve => {
    const child = spawn("launchctl", ["kickstart", "-k", `gui/${uid}/ai.leadrider.hdnet-chrome`], {
      stdio: "ignore"
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

async function ensureChromeHealthy(): Promise<boolean> {
  const ok = await probeChrome();
  if (ok) {
    if (lastChromeOk === false) log("runner Chrome (CDP) is reachable again.");
    lastChromeOk = true;
    return true;
  }
  if (lastChromeOk !== false) warn(`runner Chrome (CDP ${cdpUrl}) is unreachable.`);
  lastChromeOk = false;
  const now = Date.now();
  if (chromeAutohealEnabled && cdpUrl.includes("127.0.0.1") && now - lastKickstartAt > CHROME_KICKSTART_COOLDOWN_MS) {
    lastKickstartAt = now;
    warn("auto-heal: kickstarting ai.leadrider.hdnet-chrome…");
    await kickstartChrome();
    await new Promise(resolve => setTimeout(resolve, 6_000));
    const healed = await probeChrome();
    if (healed) {
      log("auto-heal: runner Chrome is back.");
      lastChromeOk = true;
      return true;
    }
    warn("auto-heal: runner Chrome still unreachable after kickstart (will retry next cooldown).");
  }
  return false;
}

function runOnce(): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(
      "npx",
      [
        "tsx",
        "scripts/mdf_portal_runner.ts",
        "--run",
        "--idle-ok",
        "--api-base",
        apiBase
      ],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          MDF_PORTAL_USE_BROWSER_USE: process.env.MDF_PORTAL_USE_BROWSER_USE?.trim() || "0",
          MDF_HDNET_URL: process.env.MDF_HDNET_URL?.trim() || "https://h-dnet.com",
          MDF_PORTAL_QUIET_IDLE: "1"
        },
        stdio: "inherit"
      }
    );
    child.on("close", code => resolve(code ?? 1));
    child.on("error", err => {
      warn(`runner spawn failed: ${err?.message ?? err}`);
      resolve(1);
    });
  });
}

async function tick() {
  if (running || stopping) return;
  if (Date.now() < backoffUntil) return; // backing off after repeated failures
  running = true;
  tickCount += 1;
  try {
    // Chrome health first: a dead browser turns every run into a guided packet, so heal it
    // BEFORE the runner looks for work. A still-dead Chrome does not skip the tick — the
    // runner's own guided fallback remains the safety net.
    await ensureChromeHealthy();
    const code = await runOnce();
    if (code !== 0) {
      consecutiveFailures += 1;
      failuresTotal += 1;
      if (consecutiveFailures === 1) warn(`runner exited with code ${code}.`);
      if (consecutiveFailures === 3) {
        backoffUntil = Date.now() + failureBackoffMs;
        warn(
          `3 consecutive runner failures (likely the API deploying or offline) — backing off to ${Math.round(failureBackoffMs / 60_000)}-minute polling.`
        );
      } else if (consecutiveFailures > 3) {
        backoffUntil = Date.now() + failureBackoffMs;
        if (consecutiveFailures % 10 === 0) warn(`still failing (${consecutiveFailures} consecutive).`);
      }
    } else {
      if (consecutiveFailures >= 3) log("runner recovered after failures — resuming normal polling.");
      consecutiveFailures = 0;
      backoffUntil = 0;
    }
  } catch (err: any) {
    warn(`runner failed: ${err?.message ?? err}`);
  } finally {
    running = false;
  }
  const now = Date.now();
  if (now - lastHeartbeatAt >= HEARTBEAT_MS) {
    lastHeartbeatAt = now;
    log(
      `heartbeat: alive (ticks=${tickCount}, failures=${failuresTotal}, chrome=${lastChromeOk === false ? "DOWN" : "ok"}).`
    );
  }
}

function stop() {
  stopping = true;
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

log(`polling ${apiBase} every ${Math.round(intervalMs / 1000)}s (chrome auto-heal ${chromeAutohealEnabled && cdpUrl ? "on" : "off"})`);
void tick();
setInterval(() => void tick(), intervalMs);
