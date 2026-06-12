/**
 * Language seed filter — quality gate between language_corpus:mine and
 * manual_outbound:promote (Joe, 2026-06-12). Mined staff exemplars teach the
 * draft generator TONE, so only charter-clean replies free of feed artifacts
 * may be promoted. The first full-history mine surfaced rows like
 * "2020 Harley-davidson Harley-davidson Street 750" (doubled brand) and
 * "Heritage Classi" (feed truncation) that must never become exemplars.
 *
 * Usage: npx tsx scripts/language_seed_filter.ts [--report-dir DIR]
 * Reads/writes few_shot_seed_manual_outbound.json in place; prints a summary.
 */
import fs from "node:fs";
import path from "node:path";

import { checkMessage } from "./voice_charter_audit.ts";

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) continue;
    args.set(argv[i], value);
    i += 1;
  }
  return args;
}

// Retired system copy must never come back as a "staff" exemplar.
const RETIRED_SYSTEM_PHRASES = [/^understood - i'?ll stop texting\.?$/i];

export function seedRowRejectionReason(reply: string): string | null {
  const text = String(reply ?? "").replace(/\s+/g, " ").trim();
  if (text.length < 30) return "too_short";
  if (text.length > 450) return "too_long";
  if (RETIRED_SYSTEM_PHRASES.some(re => re.test(text))) return "retired_system_phrase";
  // Feed artifacts: immediate doubled word/phrase ("Harley-davidson Harley-davidson",
  // "2017 Street Glide Special 2017").
  if (/\b(\w[\w-]{2,})\s+\1\b/i.test(text)) return "doubled_word";
  if (/\b(\d{4})\b[^.]{0,40}\b\1\b/.test(text)) return "doubled_year";
  // Mis-cased brand from raw feed text.
  if (/Harley-davidson/.test(text)) return "feed_brand_casing";
  // Truncated model names from feed cuts (word ends mid-token before period).
  if (/\b(Classi|Limite|Specia|Glid|Sportst)\b/.test(text)) return "feed_truncation";
  const violations = checkMessage(text, { firstOutbound: false, smsLike: true, staffHasSent: true });
  if (violations.length) return `charter:${violations.map((v: any) => v.check ?? v).join(",")}`;
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const reportDir =
    args.get("--report-dir") ||
    process.env.LANGUAGE_CORPUS_OUT_DIR ||
    path.resolve(process.cwd(), "reports", "language_corpus");
  const seedPath = path.join(reportDir, "few_shot_seed_manual_outbound.json");
  if (!fs.existsSync(seedPath)) {
    console.log(JSON.stringify({ ok: true, seedPath, skipped: "no seed file" }));
    return;
  }
  const raw = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  const rows: any[] = Array.isArray(raw) ? raw : raw?.rows ?? [];
  const kept: any[] = [];
  const rejected: Array<{ reason: string; preview: string }> = [];
  for (const row of rows) {
    const reason = seedRowRejectionReason(String(row?.preferredDraft ?? ""));
    if (reason) {
      rejected.push({ reason, preview: String(row?.preferredDraft ?? "").slice(0, 80) });
    } else {
      kept.push(row);
    }
  }
  const out = Array.isArray(raw) ? kept : { ...raw, rows: kept };
  fs.writeFileSync(seedPath, JSON.stringify(out, null, 2) + "\n");
  console.log(
    JSON.stringify(
      {
        ok: true,
        seedPath,
        loaded: rows.length,
        kept: kept.length,
        rejected: rejected.length,
        rejectionReasons: rejected.reduce<Record<string, number>>((acc, r) => {
          acc[r.reason] = (acc[r.reason] ?? 0) + 1;
          return acc;
        }, {}),
        rejectedPreviews: rejected.slice(0, 10)
      },
      null,
      2
    )
  );
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith("language_seed_filter.ts");
if (isDirectRun) main();
