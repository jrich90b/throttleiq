/**
 * One-off: re-shape EXISTING Meta promo leads' active cadences to match the purchase-
 * timeframe plan (commits eab864d8 + 67272709, which only cover NEW leads). For each Meta
 * promo lead currently on an active, non-long_term cadence (not handed off / booked / closed):
 *   - "not interested at this time"  -> stop the cadence + paused_indefinite (opener only).
 *   - far-out (7+ months / multi-year) -> restart as long_term [30,90,180].
 *   - near-term / unsure              -> left on standard (untouched).
 *
 * MUST run with the API stopped (the live store is in-memory; a running API would overwrite
 * this script's write on its next flush). Dry-run by default; RECADENCE_APPLY=1 to apply.
 *
 *   pm2 stop throttleiq-api
 *   DATA_DIR=/home/ubuntu/leadrider-runtime/americanharley/data npx tsx scripts/recadence_meta_promo_timeframe.ts        # dry run
 *   DATA_DIR=... RECADENCE_APPLY=1 npx tsx scripts/recadence_meta_promo_timeframe.ts                                      # apply
 *   pm2 start throttleiq-api
 */
const store = await import("../services/api/src/domain/conversationStore.ts");
await store.reloadConversationStore();

const APPLY = process.env.RECADENCE_APPLY === "1";
const TZ = process.env.TZ_OVERRIDE || "America/New_York";
const SOURCE_RE = /meta promo offer/i;
const now = new Date();

const convs = store.getAllConversations() as any[];
const suppressed: any[] = [];
const longTermed: any[] = [];

for (const conv of convs) {
  if (conv.closedAt || conv.closedReason || conv.sale?.soldAt) continue;
  if (!SOURCE_RE.test(String(conv.lead?.source ?? ""))) continue;
  const fc = conv.followUpCadence;
  if (!fc || fc.status !== "active") continue; // only re-shape active cadences
  if (fc.kind === "long_term") continue; // already gentle
  const mode = conv.followUp?.mode;
  if (mode === "manual_handoff" || mode === "paused_indefinite" || mode === "holding_inventory") continue;
  if (conv.appointment?.bookedEventId) continue;

  const plan = store.resolveInitialAdfCadencePlan({
    purchaseTimeframe: conv.lead?.purchaseTimeframe,
    purchaseTimeframeMonthsStart: conv.lead?.purchaseTimeframeMonthsStart
  });
  if (plan === "standard") continue; // near-term stays on the standard ramp

  const rec = {
    leadKey: conv.leadKey,
    firstName: String(conv.lead?.firstName ?? conv.lead?.name ?? "?"),
    purchaseTimeframe: String(conv.lead?.purchaseTimeframe ?? ""),
    fromKind: fc.kind ?? "(none)",
    fromNextDue: fc.nextDueAt ?? null
  };

  if (plan === "suppress") {
    suppressed.push(rec);
    if (APPLY) {
      store.stopFollowUpCadence(conv, "meta_not_interested_at_this_time");
      store.setFollowUpMode(conv, "paused_indefinite", "meta_not_interested_at_this_time");
      store.saveConversation(conv);
    }
  } else {
    longTermed.push(rec);
    if (APPLY) {
      conv.followUpCadence = undefined;
      store.startFollowUpCadence(conv, now.toISOString(), TZ, { kind: "long_term" });
      store.saveConversation(conv);
    }
  }
}

if (APPLY) await store.flushConversationStore();

console.log(
  JSON.stringify(
    { apply: APPLY, suppress: suppressed, long_term: longTermed },
    null,
    2
  )
);
console.log(
  APPLY
    ? `APPLIED — suppressed ${suppressed.length}, re-cadenced ${longTermed.length} to long_term`
    : `DRY RUN — would suppress ${suppressed.length}, re-cadence ${longTermed.length} to long_term (set RECADENCE_APPLY=1 to apply)`
);
