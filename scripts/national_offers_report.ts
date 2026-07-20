/**
 * national_offers_report — DRY RUN (read-only) proof of the high-quality-cadence value source.
 *
 * Fetches the live H-D national offers, parses them, and matches them against the dealer's real open
 * leads — printing, per lead, the on-voice value touch the cadence WOULD send, or "stay quiet" when no
 * offer genuinely applies. This is the exact production code path (nationalOffers.ts + the typed
 * parsers), just invoked offline. It sends nothing and mutates nothing.
 *
 * Run (needs OPENAI_API_KEY; the flag is forced on for this dry run only — prod stays dark):
 *   CONVERSATIONS_DB_PATH=/path/to/conversations.json \
 *   NATIONAL_OFFERS_ENABLED=1 LLM_ENABLED=1 npx tsx scripts/national_offers_report.ts [--limit N]
 */
import fs from "node:fs";
import { getNationalOffers, findNationalOfferForVehicle } from "../services/api/src/domain/nationalOffers.ts";

function vehicleOf(c: any): string {
  const v = (c?.lead?.vehicle ?? {}) as any;
  let lab = ["year", "make", "model", "trim"].map(k => String(v?.[k] ?? "").trim()).join(" ").trim();
  if (!lab) {
    const w = (c?.inventoryWatch ?? {}) as any;
    lab = ["make", "model"].map(k => String(w?.[k] ?? "").trim()).join(" ").trim();
  }
  return lab.replace(/\s+/g, " ").trim();
}

(async () => {
  if (process.env.NATIONAL_OFFERS_ENABLED == null) process.env.NATIONAL_OFFERS_ENABLED = "1";
  const dbPath = process.env.CONVERSATIONS_DB_PATH;
  const limit = Number((process.argv.find(a => a.startsWith("--limit="))?.split("=")[1]) ?? 25);

  console.log("Fetching + parsing live H-D national offers…");
  const offers = await getNationalOffers({ bypassCache: true });
  console.log(`\n===== NATIONAL OFFERS: ${offers.length} =====`);
  for (const o of offers) {
    console.log(`  • ${o.title}\n      applies: ${o.appliesTo} | ${o.terms} | ${o.eligibility} | exp ${o.expiration}`);
  }
  if (offers.length === 0) {
    console.log("\n(no offers parsed — check NATIONAL_OFFERS_ENABLED=1, OPENAI_API_KEY, and connectivity)");
    return;
  }

  if (!dbPath || !fs.existsSync(dbPath)) {
    console.log("\nNo CONVERSATIONS_DB_PATH set — offers-only run (skip lead matching).");
    return;
  }
  const raw = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const convs: any[] = Array.isArray(raw) ? raw : raw.conversations ?? [];
  const leads = convs
    .filter(c => c?.status !== "closed" && c?.mode !== "human")
    .map(c => ({ id: c?.id, vehicle: vehicleOf(c) }))
    .filter(l => l.vehicle && l.vehicle.split(" ").length >= 2);
  const seen = new Set<string>();
  const uniq = leads.filter(l => (seen.has(l.vehicle.toLowerCase()) ? false : (seen.add(l.vehicle.toLowerCase()), true))).slice(0, limit);

  console.log(`\n===== MATCHING ${uniq.length} REAL OPEN LEADS =====`);
  let fired = 0;
  for (const lead of uniq) {
    const m = await findNationalOfferForVehicle(lead.vehicle);
    if (m) {
      fired++;
      console.log(`\n✓ ${lead.vehicle}\n    offer: ${m.offerTitle}\n    would send: "${m.message}"`);
    } else {
      console.log(`\n· ${lead.vehicle} — stay quiet (no genuine offer match)`);
    }
  }
  console.log(`\n===== ${fired} value touches / ${uniq.length - fired} stay quiet (of ${uniq.length}) =====`);
})().catch(e => {
  console.error("report failed:", e?.message ?? e);
  process.exit(1);
});
