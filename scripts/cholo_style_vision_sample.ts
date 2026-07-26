/**
 * Cholo-style vision — Phase A DARK lot-scan report generator.
 *
 * Pulls REAL inventory units from the live feed, runs the equipment vision (WITH the cholo cues on) over
 * each unit's photos, scores the cholo BUILD composite, and writes a readable Markdown table so Joe can
 * eyeball which units flag cholo and why (per-cue confidences). NOTHING is customer-facing — this is the
 * Phase A accuracy spot-check before any exposure.
 *
 * SAFE DRY-RUN: with no OPENAI_API_KEY / flags off it does NOT call vision; it just lists the real units
 * that WOULD be scanned (proving the plumbing + which lot it hits), so it never fails or spends money.
 *
 * Env it honors:
 *   LLM_ENABLED=1, OPENAI_API_KEY                       — required to actually call vision
 *   INVENTORY_EQUIPMENT_VISION_ENABLED=1                — the equipment-vision flag (cholo rides inside it)
 *   CHOLO_STYLE_VISION_ENABLED=1                        — the cholo flag (adds the cue reads)
 *   INVENTORY_XML_URL                                   — feed override (else AH legacy default)
 *   CHOLO_SAMPLE_LIMIT (default 40)                     — how many units to scan
 *   CHOLO_SAMPLE_OUT (default: scratchpad md path)      — report output path
 *   CHOLO_SAMPLE_USED_ONLY=1                            — restrict to used units (cholo is a used-lot build)
 *
 * Run for real (on the box, or wherever the feed + key live):
 *   env LLM_ENABLED=1 INVENTORY_EQUIPMENT_VISION_ENABLED=1 CHOLO_STYLE_VISION_ENABLED=1 \
 *       npx tsx scripts/cholo_style_vision_sample.ts
 */
import * as fs from "node:fs/promises";

import { getInventoryFeed, type InventoryFeedItem } from "../services/api/src/domain/inventoryFeed.ts";
import {
  getUnitEquipmentProfile,
  deriveCholoBuild,
  choloStyleVisionEnabled,
  buildCholoConfirmLine,
  loadEquipmentCache,
  saveEquipmentCache,
  EQUIPMENT_ASSERTION_CONFIDENCE_MIN,
  type EquipmentProfile
} from "../services/api/src/domain/inventoryEquipmentVision.ts";

const OUT_PATH =
  process.env.CHOLO_SAMPLE_OUT?.trim() ||
  "/private/tmp/claude-501/-Users-joehartrich-throttleiq/dd17d470-b3c3-49cc-83a5-9e453f4204d5/scratchpad/cholo_style_vision_sample.md";
const LIMIT = Math.max(1, Number(process.env.CHOLO_SAMPLE_LIMIT ?? 40));
const USED_ONLY = process.env.CHOLO_SAMPLE_USED_ONLY === "1";

const CHOLO_CUE_KEYS = [
  "apeHangers",
  "whitewalls",
  "fatSpokeWheels",
  "fishtailExhaust",
  "soloSeat",
  "heavyChrome",
  "lowStance",
  "blackedOut"
] as const;
const CUE_LABEL: Record<string, string> = {
  apeHangers: "ape hangers",
  whitewalls: "whitewalls",
  fatSpokeWheels: "fat spokes",
  fishtailExhaust: "fishtails",
  soloSeat: "solo seat",
  heavyChrome: "heavy chrome",
  lowStance: "low stance",
  blackedOut: "BLACKED-OUT(disqualifier)"
};

function cueCell(profile: EquipmentProfile): string {
  const parts: string[] = [];
  for (const key of CHOLO_CUE_KEYS) {
    const f = profile.features[key];
    if (!f?.detected) continue;
    const pct = Math.round(f.confidence * 100);
    const mark = f.asserted ? "" : " _(below-thr)_";
    parts.push(`${CUE_LABEL[key]} ${pct}%${mark}`);
  }
  return parts.length ? parts.join(", ") : "_(no cholo cues seen)_";
}

async function main() {
  const dry = !choloStyleVisionEnabled() || process.env.LLM_ENABLED !== "1" || !process.env.OPENAI_API_KEY;
  let items: InventoryFeedItem[] = [];
  try {
    items = await getInventoryFeed({ bypassCache: true });
  } catch (err: any) {
    console.warn("[cholo-sample] feed load failed", { message: err?.message ?? String(err) });
  }

  let withPhotos = items.filter(i => (i.images ?? []).filter(Boolean).length > 0);
  if (USED_ONLY) withPhotos = withPhotos.filter(i => String(i.condition ?? "").toLowerCase().includes("used"));
  const sample = withPhotos.slice(0, LIMIT);

  const lines: string[] = [];
  lines.push("# Cholo-style vision — Phase A DARK lot-scan report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(
    "What this is: for each real used unit below, the vision looked at the actual listing photos and scored " +
      "the CHOLO BUILD SIGNATURE (recalibrated 7/26): tall ape hangers AND the CHROME/WHITEWALL lowrider FINISH " +
      "(heavy chrome OR whitewalls — MANDATORY) AND a period cue (fishtails OR whitewalls OR chrome fat spokes), " +
      `and NOT blacked-out. Each cue needs ≥${Math.round(EQUIPMENT_ASSERTION_CONFIDENCE_MIN * 100)}% confidence. ` +
      "Cholo is the CHROME lowrider look — a murdered-out/blacked-out bike is disqualified, no matter the bars. " +
      "The base model (Heritage/Deluxe/Road King = the usual canvas) is a SOFT prior only, never a decider. " +
      "A unit reads **CHOLO** only when the whole signature holds — never one part, never the model alone. DARK: " +
      "no customer sees it. Joe: spot-check the CHOLO? column against the photo. A YES is 'looks like — let me confirm'.");
  lines.push("");

  if (dry) {
    lines.push("> DRY RUN — vision was NOT executed.");
    lines.push(">");
    lines.push(
      "> To produce real reads set `LLM_ENABLED=1`, `OPENAI_API_KEY`, `INVENTORY_EQUIPMENT_VISION_ENABLED=1`, and " +
        "`CHOLO_STYLE_VISION_ENABLED=1`. The table below lists the real units that WOULD be scanned (from the live " +
        "feed), so the plumbing is proven end-to-end.");
    lines.push("");
  }
  if (!items.length) {
    lines.push("> The live feed returned NO units from this environment (no `INVENTORY_XML_URL` / feed unreachable). " +
      "Run this on the box (or set `INVENTORY_XML_URL`) to fill in real reads.");
    lines.push("");
  }

  lines.push(`Feed units total: ${items.length} · with photos: ${withPhotos.length} · scanned this run: ${sample.length}${USED_ONLY ? " (used only)" : ""}`);
  lines.push("");
  lines.push("| # | Stock | Year | Model | Cond | CHOLO? | Composite | Cue reads (per-cue confidence) | Photo |");
  lines.push("|--:|-------|------|-------|------|--------|-----------|--------------------------------|-------|");

  const cache = await loadEquipmentCache();
  let ran = 0;
  let failures = 0;
  let choloCount = 0;
  let idx = 0;
  const choloUnits: string[] = [];
  for (const item of sample) {
    idx++;
    const firstImg = (item.images ?? []).filter(Boolean)[0] ?? "";
    const photoCell = firstImg ? `[img](${firstImg})` : "—";
    const base = `| ${idx} | ${item.stockId ?? "—"} | ${item.year ?? "—"} | ${item.model ?? "—"} | ${item.condition ?? "—"} |`;
    if (dry) {
      lines.push(`${base} _(dry run)_ | — | _(not scanned)_ | ${photoCell} |`);
      continue;
    }
    try {
      const res = await getUnitEquipmentProfile(item, { cache, forceRefresh: process.env.CHOLO_SAMPLE_FORCE === "1" });
      if (res.ranVision) ran++;
      if (!res.profile) {
        failures++;
        lines.push(`${base} _(vision failed)_ | — | — | ${photoCell} |`);
        continue;
      }
      const cholo = deriveCholoBuild(res.profile);
      const flag = cholo.isCholo ? `**YES** ✓` : "no";
      const comp = cholo.isCholo ? `${Math.round(cholo.confidence * 100)}%` : "—";
      if (cholo.isCholo) {
        choloCount++;
        choloUnits.push(`${item.year ?? ""} ${item.model ?? ""} (stock ${item.stockId ?? "?"})`.trim());
      }
      lines.push(`${base} ${flag} | ${comp} | ${cueCell(res.profile)} | ${photoCell} |`);
    } catch (err: any) {
      failures++;
      lines.push(`${base} _(error: ${String(err?.message ?? err).slice(0, 40)})_ | — | — | ${photoCell} |`);
    }
  }

  if (!dry) {
    await saveEquipmentCache(cache);
    lines.push("");
    lines.push(`Vision calls this run: ${ran} · failures: ${failures} · flagged CHOLO: ${choloCount} · cache file: \`inventory_equipment_profiles.json\``);
    if (choloUnits.length) {
      lines.push("");
      lines.push("Units flagged cholo (the near-threshold customer line would be a confirm, e.g.):");
      lines.push(`> ${buildCholoConfirmLine(choloUnits[0])}`);
      lines.push("");
      for (const u of choloUnits) lines.push(`- ${u}`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("Phase A is DARK and approve-first: cholo tagging/watch-fire is behind `CHOLO_STYLE_VISION_ENABLED` " +
    "(which also requires `INVENTORY_EQUIPMENT_VISION_ENABLED`) and is NOT wired into any customer reply. A cholo " +
    "watch stays inert until the flag is flipped in a later phase.");

  await fs.writeFile(OUT_PATH, lines.join("\n"), "utf8");
  console.log(`[cholo-sample] wrote ${OUT_PATH} — ${sample.length} units${dry ? " (DRY RUN)" : `, ${ran} vision calls, ${failures} failures, ${choloCount} flagged cholo`}`);
}

main().catch(err => {
  console.error("[cholo-sample] fatal", err);
  process.exit(1);
});
