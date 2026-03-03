import { promises as fs } from "node:fs";
import * as path from "node:path";
import { dataPath } from "./dataDir.js";

export type SystemMode = "suggest" | "autopilot";

const DEFAULT_PATH = dataPath("settings.json");
const SETTINGS_PATH = process.env.SETTINGS_DB_PATH
  ? path.resolve(process.env.SETTINGS_DB_PATH)
  : DEFAULT_PATH;

let mode: SystemMode = "suggest";
let saveTimer: NodeJS.Timeout | null = null;

async function ensureDirForFile(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function loadFromDisk() {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as { mode?: SystemMode };
    if (parsed?.mode === "suggest" || parsed?.mode === "autopilot") {
      mode = parsed.mode;
    }
    console.log(`⚙️ Loaded settings from ${SETTINGS_PATH} (mode=${mode})`);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      await ensureDirForFile(SETTINGS_PATH);
      await saveToDisk(); // create default file
      console.log(`⚙️ Created settings at ${SETTINGS_PATH} (mode=${mode})`);
      return;
    }
    console.warn("⚠️ Failed to load settings:", err?.message ?? err);
  }
}

async function saveToDisk() {
  try {
    await ensureDirForFile(SETTINGS_PATH);
    const payload = { version: 1, savedAt: new Date().toISOString(), mode };
    const tmp = `${SETTINGS_PATH}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
    await fs.rename(tmp, SETTINGS_PATH);
  } catch (err: any) {
    console.warn("⚠️ Failed to save settings:", err?.message ?? err);
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveToDisk(), 250);
}

void loadFromDisk();

export function getSystemMode(): SystemMode {
  return mode;
}

export function setSystemMode(next: SystemMode): SystemMode {
  mode = next;
  scheduleSave();
  return mode;
}
