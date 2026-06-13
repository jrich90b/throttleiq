/**
 * One-off backfill: start a follow-up cadence for H-D Meta Promo Offer leads
 * that were stranded by the pre-fix initial-ADF bug (sent the opener, no
 * cadence — Jason +17162801172 et al.). The forward fix (commit de84adeb)
 * only covers NEW leads; this re-engages the existing ones.
 *
 * MUST run with the API stopped (the live store is in-memory; a running API
 * would overwrite this script's write on its next flush). Dry-run by default;
 * set BACKFILL_APPLY=1 to actually start the cadences.
 *
 *   pm2 stop throttleiq-api
 *   DATA_DIR=/home/ubuntu/leadrider-runtime/americanharley/data npx tsx scripts/backfill_meta_promo_cadence.ts        # dry run
 *   DATA_DIR=... BACKFILL_APPLY=1 npx tsx scripts/backfill_meta_promo_cadence.ts                                       # apply
 *   pm2 start throttleiq-api
 */
const store = await import("../services/api/src/domain/conversationStore.ts");
await store.reloadConversationStore();

const APPLY = process.env.BACKFILL_APPLY === "1";
const TZ = process.env.TZ_OVERRIDE || "America/New_York";
const SOURCE_RE = /meta promo offer/i;
const now = new Date();
const MAX_IDLE_MS = 14 * 24 * 60 * 60 * 1000;

const convs = store.getAllConversations();
const affected: Array<{ leadKey: string; firstName: string; idleDays: number }> = [];
let skippedExisting = 0;

for (const conv of convs as any[]) {
  if (conv.closedAt || conv.closedReason || conv.sale?.soldAt) continue;
  if (!SOURCE_RE.test(String(conv.lead?.source ?? ""))) continue;
  if (String(conv.followUpCadence?.status ?? "").toLowerCase() === "active") {
    skippedExisting += 1;
    continue;
  }
  const mode = conv.followUp?.mode;
  if (mode === "manual_handoff" || mode === "paused_indefinite" || mode === "holding_inventory") continue;
  if (conv.appointment?.bookedEventId) continue;
  const msgs = Array.isArray(conv.messages) ? conv.messages : [];
  if (!msgs.some((m: any) => m?.direction === "in" && String(m?.body ?? "").trim())) continue;
  if (!msgs.some((m: any) => m?.direction === "out" && String(m?.body ?? "").trim())) continue;
  let last = 0;
  for (const m of msgs) {
    const t = Date.parse(String(m?.at ?? ""));
    if (Number.isFinite(t) && t > last) last = t;
  }
  if (!(now.getTime() - last < MAX_IDLE_MS)) continue;

  affected.push({
    leadKey: conv.leadKey,
    firstName: String(conv.lead?.firstName ?? conv.lead?.name ?? "?"),
    idleDays: last ? Math.floor((now.getTime() - last) / 86_400_000) : 0
  });
  if (APPLY) {
    store.startFollowUpCadence(conv, now.toISOString(), TZ);
    store.saveConversation(conv);
  }
}

if (APPLY) await store.flushConversationStore();

console.log(JSON.stringify({ apply: APPLY, matched: affected.length, skippedAlreadyActive: skippedExisting, affected }, null, 2));
console.log(APPLY ? `APPLIED cadence to ${affected.length} Meta-promo leads` : `DRY RUN — ${affected.length} Meta-promo leads would get a cadence (set BACKFILL_APPLY=1 to apply)`);
