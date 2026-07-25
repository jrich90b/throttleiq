/**
 * Inventory equipment vision — Phase A SAMPLE REPORT generator (DARK).
 *
 * Pulls REAL inventory units from the live feed, runs the equipment vision over
 * each unit's photos, and writes a readable Markdown table so Joe can spot-check
 * accuracy (this becomes the ground-truth eval seed). NOTHING is customer-facing.
 *
 * Env it honors:
 *   LLM_ENABLED=1, OPENAI_API_KEY                     — required to actually call vision
 *   INVENTORY_EQUIPMENT_VISION_ENABLED=1              — the dark flag (must be on)
 *   INVENTORY_XML_URL                                 — feed override (else AH legacy default)
 *   EQUIP_SAMPLE_LIMIT (default 25)                   — how many units to scan
 *   EQUIP_SAMPLE_OUT (default: scratchpad md path)    — report output path
 *   EQUIP_SAMPLE_USED_ONLY=1                           — restrict to used units
 *
 * Run: env LLM_ENABLED=1 INVENTORY_EQUIPMENT_VISION_ENABLED=1 npx tsx \
 *        scripts/inventory_equipment_vision_sample.ts
 */
import * as fs from "node:fs/promises";

import { getInventoryFeed, type InventoryFeedItem } from "../services/api/src/domain/inventoryFeed.ts";
import {
  EQUIPMENT_FEATURE_KEYS,
  getUnitEquipmentProfile,
  inventoryEquipmentVisionEnabled,
  loadEquipmentCache,
  saveEquipmentCache,
  type EquipmentProfile
} from "../services/api/src/domain/inventoryEquipmentVision.ts";

const OUT_PATH =
  process.env.EQUIP_SAMPLE_OUT?.trim() ||
  "/private/tmp/claude-501/-Users-joehartrich-throttleiq/dd17d470-b3c3-49cc-83a5-9e453f4204d5/scratchpad/equipment_vision_sample.md";
const LIMIT = Math.max(1, Number(process.env.EQUIP_SAMPLE_LIMIT ?? 25));
const USED_ONLY = process.env.EQUIP_SAMPLE_USED_ONLY === "1";

const FEATURE_LABEL: Record<string, string> = {
  bags: "bags",
  windshield: "windshield",
  fairing: "fairing",
  backrestSissybar: "backrest",
  tourpak: "tour-pak",
  forwardControls: "fwd controls",
  apeHangers: "ape hangers",
  floorboards: "floorboards",
  crashBars: "crash bars"
};

function equipCell(profile: EquipmentProfile): string {
  const parts: string[] = [];
  for (const key of EQUIPMENT_FEATURE_KEYS) {
    const f = profile.features[key];
    if (!f.detected) continue;
    const pct = Math.round(f.confidence * 100);
    const mark = f.asserted ? "" : " _(below-thr)_";
    let label = FEATURE_LABEL[key];
    if (key === "bags" && profile.bagType !== "unknown") label = `bags:${profile.bagType}`;
    if (key === "fairing" && profile.fairingType !== "unknown") label = `fairing:${profile.fairingType}`;
    parts.push(`${label} ${pct}%${mark}`);
  }
  return parts.length ? parts.join(", ") : "_(none detected)_";
}

function priorCell(profile: EquipmentProfile): string {
  const p = profile.modelPrior;
  const base = p.fairing === "unknown" && p.windshield === "unknown" ? "no prior" : `${p.reason}`;
  return `${profile.priorAgreement}${base ? ` — ${base}` : ""}`;
}

async function main() {
  const dry = !inventoryEquipmentVisionEnabled() || process.env.LLM_ENABLED !== "1" || !process.env.OPENAI_API_KEY;
  let items: InventoryFeedItem[] = [];
  try {
    items = await getInventoryFeed({ bypassCache: true });
  } catch (err: any) {
    console.warn("[equip-sample] feed load failed", { message: err?.message ?? String(err) });
  }

  let withPhotos = items.filter(i => (i.images ?? []).filter(Boolean).length > 0);
  if (USED_ONLY) withPhotos = withPhotos.filter(i => String(i.condition ?? "").toLowerCase().includes("used"));
  const sample = withPhotos.slice(0, LIMIT);

  const lines: string[] = [];
  lines.push("# Inventory equipment vision — Phase A sample report (DARK)");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(
    "What this is: for each real inventory unit below, the equipment-vision pass looked at the unit's " +
      "actual listing photos and detected which equipment is on the bike, with a confidence for each feature. " +
      "This is DARK — no customer sees any of it. Joe: spot-check the detected equipment against the photo " +
      "(first image URL linked). Anything marked _(below-thr)_ was seen but NOT confident enough to assert " +
      `(threshold 0.7) — the agent would say "looks like" and confirm, never claim it. "Prior" shows whether ` +
      "vision agreed with what the model name implies (a Street/Road Glide should read fairing, not windshield).");
  lines.push("");

  if (dry) {
    lines.push("> DRY RUN — vision was NOT executed.");
    lines.push(">");
    lines.push(
      "> To produce real reads set `LLM_ENABLED=1`, `OPENAI_API_KEY`, and `INVENTORY_EQUIPMENT_VISION_ENABLED=1`. " +
        "The table below lists the real units that WOULD be scanned (from the live feed), so the plumbing is proven end-to-end.");
    lines.push("");
  }
  if (!items.length) {
    lines.push("> The live feed returned NO units from this environment (no `INVENTORY_XML_URL` / feed unreachable). " +
      "Run this on the box (or set `INVENTORY_XML_URL`) to fill in real reads.");
    lines.push("");
  }

  lines.push(`Feed units total: ${items.length} · with photos: ${withPhotos.length} · scanned this run: ${sample.length}${USED_ONLY ? " (used only)" : ""}`);
  lines.push("");
  lines.push("| # | Stock | Year | Model | Cond | Detected equipment (per-feature confidence) | Prior agreement | Photo |");
  lines.push("|--:|-------|------|-------|------|----------------------------------------------|-----------------|-------|");

  const cache = await loadEquipmentCache();
  let ran = 0;
  let failures = 0;
  let idx = 0;
  for (const item of sample) {
    idx++;
    const firstImg = (item.images ?? []).filter(Boolean)[0] ?? "";
    const photoCell = firstImg ? `[img](${firstImg})` : "—";
    const base = `| ${idx} | ${item.stockId ?? "—"} | ${item.year ?? "—"} | ${item.model ?? "—"} | ${item.condition ?? "—"} |`;
    if (dry) {
      lines.push(`${base} _(dry run — not scanned)_ | — | ${photoCell} |`);
      continue;
    }
    try {
      const res = await getUnitEquipmentProfile(item, { cache });
      if (res.ranVision) ran++;
      if (!res.profile) {
        failures++;
        lines.push(`${base} _(vision failed / no read)_ | — | ${photoCell} |`);
        continue;
      }
      lines.push(`${base} ${equipCell(res.profile)} | ${priorCell(res.profile)} | ${photoCell} |`);
    } catch (err: any) {
      failures++;
      lines.push(`${base} _(error: ${String(err?.message ?? err).slice(0, 40)})_ | — | ${photoCell} |`);
    }
  }

  if (!dry) {
    await saveEquipmentCache(cache);
    lines.push("");
    lines.push(`Vision calls this run: ${ran} · failures: ${failures} · cache file: \`inventory_equipment_profiles.json\``);
  }
  lines.push("");
  lines.push("---");
  lines.push("Phase A is DARK and approve-first: this pass is NOT wired into search or any customer reply. " +
    "Phase B (canary, flagged) wires it into inventory search with the fail-safe replies.");

  await fs.writeFile(OUT_PATH, lines.join("\n"), "utf8");
  console.log(`[equip-sample] wrote ${OUT_PATH} — ${sample.length} units${dry ? " (DRY RUN)" : `, ${ran} vision calls, ${failures} failures`}`);
}

main().catch(err => {
  console.error("[equip-sample] fatal", err);
  process.exit(1);
});
