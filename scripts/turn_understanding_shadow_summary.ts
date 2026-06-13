/**
 * Turn Understanding shadow summary (Phase 1 of the comprehension plan).
 * Reads reports/turn_understanding_shadow/disagreements_*.jsonl and reports the
 * rate the LLM understanding pass diverged from the deterministic extractors,
 * by field. This is the precision measurement + Phase-2 readiness signal:
 * disagreements where the LLM is right (owned-bike surfaced, model corrected)
 * are exactly the cases the deterministic layer was missing.
 *
 * Usage: npx tsx scripts/turn_understanding_shadow_summary.ts [--dir DIR] [--days N]
 */
import fs from "node:fs";
import path from "node:path";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dir =
  arg("--dir", "") ||
  process.env.TU_SHADOW_DIR ||
  path.join(process.env.REPORT_ROOT || path.resolve(process.cwd(), "reports"), "turn_understanding_shadow");
const days = Number(arg("--days", "7")) || 7;
const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

if (!fs.existsSync(dir)) {
  console.log(JSON.stringify({ ok: true, dir, note: "no shadow logs yet", total: 0 }));
  process.exit(0);
}

const rows: any[] = [];
for (const f of fs.readdirSync(dir).filter(n => /^disagreements_.*\.jsonl$/.test(n))) {
  for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (Date.parse(o.ts) >= cutoffMs) rows.push(o);
    } catch {
      /* skip */
    }
  }
}

const byField: Record<string, number> = {};
for (const r of rows) for (const d of r.disagreements ?? []) byField[d] = (byField[d] ?? 0) + 1;

const samples = rows
  .filter(r => (r.disagreements ?? []).includes("owned_bike_surfaced") || (r.disagreements ?? []).includes("models"))
  .slice(0, 12)
  .map(r => ({
    convId: r.convId,
    inbound: String(r.inbound ?? "").slice(0, 90),
    det: r.det?.models,
    llm: r.llm?.models,
    owned: r.llm?.owned?.family ?? null
  }));

const out = { ok: true, dir, days, totalDisagreements: rows.length, byField, samples };

const outDir = dir;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "turn_understanding_shadow_summary.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ ok: true, totalDisagreements: rows.length, byField }));
