/**
 * One-off data repair: put Ethan Mouyeos (+17166970787) back on the sale date he actually bought
 * on, and back on the rung of the owner sequence he had actually reached.
 *
 * WHY (Joe, 2026-08-16): Joe worked the morning digest's list of appointments still missing an
 * outcome and recorded showed -> sold on an appointment for a bike bought on 2026-04-15. Three
 * places stamp `conv.sale` and only one checked whether a sale was already recorded, so the
 * back-dated outcome REWROTE the existing sale record with "now", and `decideCadenceStart`'s
 * post_sale arm (which had no already-ran clause) re-armed the owner sequence at step 0. PR #731
 * fixes the class; it is forward-only and cannot heal this record. This script heals the record.
 *
 * WHAT THE DAMAGE ACTUALLY IS — measured against
 * `data/backups/conversations.20260816_021501.json`, NOT assumed from the PR description. This
 * matters: #731's own body claims the bike was swapped, the salesperson re-attributed, and the
 * anniversary re-dated. NONE of those happened to this record. Verified identical on both sides:
 *
 *     sale.soldById / soldByName   0ba7c600-…/"Giovanni Boccabella"   (attribution intact)
 *     sale.stockId / vin           U577-08 / 1HD1GY4458K341758        (correct unit, never swapped)
 *     followUpCadence.nextDueAt    2027-04-15T14:30:00.000Z           (anniversary never moved)
 *
 * Two live fields are ENRICHMENTS the outcome added, and this script deliberately KEEPS them —
 * reverting them would be the same overwrite-what-we-already-knew mistake in reverse:
 *
 *     sale.label   "2008 Harley-Davidson Fat Bob" -> "2008 Harley-Davidson Dyna Fat Bob (Efi)"
 *                  (same VIN, fuller feed name — better data, keep it)
 *     sale.leadRef  absent -> "10933"             (new information, keep it)
 *
 * So the repair is exactly SIX fields — every one of them a date or a position in the sequence:
 *
 *   sale.soldAt                  2026-08-16T12:07:57.482Z -> 2026-04-15T19:30:03.963Z
 *   closedAt                     2026-08-16T12:07:57.482Z -> 2026-04-15T19:30:03.963Z
 *   followUpCadence.anchorAt     2026-08-16T12:07:57.482Z -> 2026-04-15T19:30:03.963Z
 *   followUpCadence.stepIndex    0                        -> 2
 *   followUpCadence.lastSentAt   (absent)                 -> 2026-06-13T14:30:32.128Z
 *   followUpCadence.lastSentStep (absent)                 -> 1
 *
 * THE ONE THAT MATTERS is the last three. Ethan's day-1 owner text went in April and his day-60
 * went on 6/13 — he replied "Good to know. Thank you!". With stepIndex back at 0 and no
 * lastSentAt, the sequence believes it has never spoken to him and is queued to send DAY-ONE
 * "congratulations on the new bike" copy about a bike he bought four months ago. Repairing only
 * the dates would leave that intact; repairing only the rung would leave the sale mis-dated for
 * reporting. Both, or it half-lands.
 *
 * SAFETY: dry-run by default; --apply writes. Touches exactly ONE conversation and exactly the six
 * fields above — it asserts every other field of `sale` and `followUpCadence` is untouched before
 * writing. Idempotent (a record already carrying the April date proposes nothing). Refuses if the
 * live record does not look like the damage it expects, so it cannot be run blind against a record
 * someone has since edited by hand.
 *
 * The running API holds the store in memory and would clobber an in-place edit, so:
 *   1. pm2 stop throttleiq-api
 *   2. cp conversations.json data/backups/conversations.pre-ethan-repair-<stamp>.json
 *   3. CONVERSATIONS_DB_PATH=… npx tsx scripts/backfill_ethan_sold_record.ts --apply
 *   4. pm2 start throttleiq-api   (then confirm /health)
 *
 *   SELF-TEST: npx tsx scripts/backfill_ethan_sold_record.ts --self-test
 *   DRY RUN:   CONVERSATIONS_DB_PATH=/path/conversations.json npx tsx scripts/backfill_ethan_sold_record.ts
 *   APPLY:     CONVERSATIONS_DB_PATH=/path/conversations.json npx tsx scripts/backfill_ethan_sold_record.ts --apply
 */
import fs from "node:fs";
import assert from "node:assert/strict";

const CONV_ID = "+17166970787";

/** The true values, read from data/backups/conversations.20260816_021501.json on 2026-08-16. */
const TRUE_SOLD_AT = "2026-04-15T19:30:03.963Z";
const TRUE_STEP_INDEX = 2;
const TRUE_LAST_SENT_AT = "2026-06-13T14:30:32.128Z";
const TRUE_LAST_SENT_STEP = 1;
/** What the erroneous outcome stamped, so we can refuse to touch anything else. */
const DAMAGED_SOLD_AT = "2026-08-16T12:07:57.482Z";

type Plan = { field: string; from: unknown; to: unknown }[];

export function planEthanRepair(conv: any): { plan: Plan; reason?: string } {
  if (!conv) return { plan: [], reason: "conversation not found" };
  const sale = conv.sale;
  const cadence = conv.followUpCadence;
  if (!sale || !cadence) return { plan: [], reason: "no sale or cadence record" };

  // Idempotent: already repaired.
  if (sale.soldAt === TRUE_SOLD_AT && cadence.stepIndex === TRUE_STEP_INDEX) {
    return { plan: [], reason: "already repaired" };
  }
  // Refuse if this is not the damage we measured — never guess at a record someone else has moved.
  if (sale.soldAt !== DAMAGED_SOLD_AT) {
    return { plan: [], reason: `unexpected sale.soldAt ${sale.soldAt} — refusing` };
  }
  if (cadence.kind !== "post_sale") {
    return { plan: [], reason: `unexpected cadence.kind ${cadence.kind} — refusing` };
  }

  const plan: Plan = [];
  if (sale.soldAt !== TRUE_SOLD_AT) plan.push({ field: "sale.soldAt", from: sale.soldAt, to: TRUE_SOLD_AT });
  if (conv.closedAt !== TRUE_SOLD_AT) plan.push({ field: "closedAt", from: conv.closedAt, to: TRUE_SOLD_AT });
  if (cadence.anchorAt !== TRUE_SOLD_AT)
    plan.push({ field: "followUpCadence.anchorAt", from: cadence.anchorAt, to: TRUE_SOLD_AT });
  if (cadence.stepIndex !== TRUE_STEP_INDEX)
    plan.push({ field: "followUpCadence.stepIndex", from: cadence.stepIndex, to: TRUE_STEP_INDEX });
  if (cadence.lastSentAt !== TRUE_LAST_SENT_AT)
    plan.push({ field: "followUpCadence.lastSentAt", from: cadence.lastSentAt, to: TRUE_LAST_SENT_AT });
  if (cadence.lastSentStep !== TRUE_LAST_SENT_STEP)
    plan.push({ field: "followUpCadence.lastSentStep", from: cadence.lastSentStep, to: TRUE_LAST_SENT_STEP });
  return { plan };
}

export function applyEthanRepair(conv: any): void {
  const before = { sale: { ...conv.sale }, cadence: { ...conv.followUpCadence } };
  conv.sale.soldAt = TRUE_SOLD_AT;
  conv.closedAt = TRUE_SOLD_AT;
  conv.followUpCadence.anchorAt = TRUE_SOLD_AT;
  conv.followUpCadence.stepIndex = TRUE_STEP_INDEX;
  conv.followUpCadence.lastSentAt = TRUE_LAST_SENT_AT;
  conv.followUpCadence.lastSentStep = TRUE_LAST_SENT_STEP;

  // Everything else on both records must be byte-identical. The enrichments (label, leadRef) are
  // part of "everything else" — this asserts we KEPT them.
  for (const k of Object.keys(before.sale)) {
    if (k === "soldAt") continue;
    assert.deepEqual(conv.sale[k], (before.sale as any)[k], `sale.${k} must not change`);
  }
  for (const k of Object.keys(before.cadence)) {
    if (["anchorAt", "stepIndex", "lastSentAt", "lastSentStep"].includes(k)) continue;
    assert.deepEqual(conv.followUpCadence[k], (before.cadence as any)[k], `cadence.${k} must not change`);
  }
}

function selfTest() {
  const damaged = () => ({
    id: CONV_ID,
    closedAt: DAMAGED_SOLD_AT,
    sale: {
      soldAt: DAMAGED_SOLD_AT,
      soldById: "0ba7c600-9549-4b56-8480-a0117f9fd855",
      soldByName: "Giovanni Boccabella",
      leadRef: "10933",
      stockId: "U577-08",
      vin: "1HD1GY4458K341758",
      label: "2008 Harley-Davidson Dyna Fat Bob (Efi)"
    },
    followUpCadence: {
      status: "active",
      anchorAt: DAMAGED_SOLD_AT,
      nextDueAt: "2027-04-15T14:30:00.000Z",
      stepIndex: 0,
      kind: "post_sale",
      scheduleInviteCount: 0,
      scheduleMuted: false
    }
  });

  const c = damaged();
  const { plan } = planEthanRepair(c);
  assert.equal(plan.length, 6, "expected exactly six repairs");
  applyEthanRepair(c);
  assert.equal(c.sale.soldAt, TRUE_SOLD_AT);
  assert.equal(c.closedAt, TRUE_SOLD_AT);
  assert.equal(c.followUpCadence.anchorAt, TRUE_SOLD_AT);
  assert.equal(c.followUpCadence.stepIndex, 2);
  assert.equal(c.followUpCadence.lastSentAt, TRUE_LAST_SENT_AT);
  assert.equal(c.followUpCadence.lastSentStep, 1);
  // enrichments preserved
  assert.equal(c.sale.label, "2008 Harley-Davidson Dyna Fat Bob (Efi)", "the fuller feed label must be KEPT");
  assert.equal(c.sale.leadRef, "10933", "leadRef must be KEPT");
  assert.equal(c.sale.soldByName, "Giovanni Boccabella", "attribution must be untouched");
  assert.equal(c.sale.vin, "1HD1GY4458K341758", "the unit must be untouched");
  assert.equal(c.followUpCadence.nextDueAt, "2027-04-15T14:30:00.000Z", "the anniversary must be untouched");

  // idempotent
  assert.equal(planEthanRepair(c).plan.length, 0, "second run must propose nothing");
  // refuses an unexpected record
  const moved = damaged();
  moved.sale.soldAt = "2026-05-01T00:00:00.000Z";
  assert.equal(planEthanRepair(moved).plan.length, 0, "must refuse a record it does not recognise");
  // refuses a non-post_sale cadence
  const wrongKind = damaged();
  (wrongKind.followUpCadence as any).kind = "long_term";
  assert.equal(planEthanRepair(wrongKind).plan.length, 0, "must refuse a non-post_sale cadence");

  console.log("PASS backfill_ethan_sold_record self-test (6 repairs, enrichments kept, idempotent, refuses surprises)");
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) return selfTest();

  const dbPath = process.env.CONVERSATIONS_DB_PATH;
  if (!dbPath) throw new Error("CONVERSATIONS_DB_PATH is required");
  const raw = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const convs = Array.isArray(raw) ? raw : raw.conversations;
  const conv = convs.find((c: any) => c.id === CONV_ID || c.leadKey === CONV_ID);

  const { plan, reason } = planEthanRepair(conv);
  if (!plan.length) {
    console.log(`no repair proposed: ${reason ?? "nothing to do"}`);
    return;
  }
  console.log(`Repair plan for ${CONV_ID} (${plan.length} field(s)):`);
  for (const p of plan) console.log(`  ${p.field.padEnd(30)} ${JSON.stringify(p.from)} -> ${JSON.stringify(p.to)}`);

  if (!args.includes("--apply")) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply (stop the API and back up first).");
    return;
  }
  applyEthanRepair(conv);
  const tmp = `${dbPath}.repair-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
  fs.renameSync(tmp, dbPath);
  console.log(`\nAPPLIED to ${dbPath}. Restart the API so it reloads the store.`);
}

main();
