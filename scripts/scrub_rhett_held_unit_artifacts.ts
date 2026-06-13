/**
 * One-off scrub: remove the fabricated held-unit artifacts the over-resolution
 * bug created on Rhett Craft (+15856048591) — the auto-created "Road Glide 3 /
 * Iron Horse Metallic" inventory watch(es) and the unsent draft built from it.
 * The forward fix (commit 9f5131ed) stops new ones; this clears the existing.
 *
 * MUST run with the API stopped (live store is in-memory). Dry-run by default;
 * SCRUB_APPLY=1 to apply. Scoped to one lead by SCRUB_LEAD_KEY.
 */
const store = await import("../services/api/src/domain/conversationStore.ts");
await store.reloadConversationStore();

const APPLY = process.env.SCRUB_APPLY === "1";
const leadKey = process.env.SCRUB_LEAD_KEY || "+15856048591";
const conv = store.getAllConversations().find((c: any) => String(c.leadKey) === leadKey) as any;
if (!conv) {
  console.error(`lead ${leadKey} not found`);
  process.exit(1);
}

const watches = [
  ...(conv.inventoryWatch ? [conv.inventoryWatch] : []),
  ...(Array.isArray(conv.inventoryWatches) ? conv.inventoryWatches : [])
];
const badWatches = watches.filter(
  (w: any) => /held-unit follow-up guard/i.test(String(w?.note ?? "")) || /road glide 3/i.test(String(w?.model ?? ""))
);
// Only the fabricated Road Glide 3 draft — leave any other pending draft alone.
const isBadDraft = (m: any) =>
  m?.direction === "out" && String(m?.provider ?? "") === "draft_ai" && m?.status !== "sent" && /road glide 3/i.test(String(m?.body ?? ""));
const badDrafts = (conv.messages ?? []).filter(isBadDraft);
const emailDraftBad = /road glide 3/i.test(String(conv.emailDraft?.body ?? conv.emailDraft ?? ""));

console.log(JSON.stringify({
  apply: APPLY,
  leadKey,
  badWatches: badWatches.map((w: any) => ({ model: w.model, color: w.color, note: w.note })),
  badDraftsToRemove: badDrafts.map((m: any) => String(m.body ?? "").slice(0, 70)),
  emailDraftBad
}, null, 2));

if (APPLY) {
  // Drop the fabricated watches; keep any legitimately customer-created ones.
  const keep = (w: any) =>
    !/held-unit follow-up guard/i.test(String(w?.note ?? "")) && !/road glide 3/i.test(String(w?.model ?? ""));
  conv.inventoryWatches = (Array.isArray(conv.inventoryWatches) ? conv.inventoryWatches : []).filter(keep);
  if (conv.inventoryWatch && !keep(conv.inventoryWatch)) delete conv.inventoryWatch;
  if (!conv.inventoryWatches.length) delete conv.inventoryWatches;
  conv.messages = (conv.messages ?? []).filter((m: any) => !isBadDraft(m));
  if (emailDraftBad) delete conv.emailDraft;
  store.saveConversation(conv);
  await store.flushConversationStore();
  console.log(`APPLIED: removed ${badWatches.length} bad watch(es) + ${badDrafts.length} fabricated draft(s) (other drafts preserved)`);
} else {
  console.log("DRY RUN — set SCRUB_APPLY=1 to apply");
}
