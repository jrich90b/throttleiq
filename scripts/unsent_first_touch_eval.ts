/**
 * Unsent first-touch safety-net eval (2026-06-25).
 *
 * `shouldSurfaceUnsentFirstTouch` (conversationStore) flags a NEVER-contacted lead whose initial reply
 * was DRAFTED but never sent — the email-first-touch silence pool (8 old AutoDealers.Digital inventory
 * leads whose `conv.emailDraft` sat in the Email tab with no cadence + no todo, aged past the
 * stale-handoff 21-day window into silence). The cron reconcile surfaces ONE channel-aware staff todo
 * (call if phone-preferred, else "send the drafted reply"). DISTINCT from the stale-handoff nudge: a
 * missed FIRST touch has NO max-idle cap (the customer never heard from us), unlike a
 * contacted-then-quiet handoff (capped at 21d).
 *
 * Run: npx tsx scripts/unsent_first_touch_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH || path.join(os.tmpdir(), `unsent-first-touch-eval-${Date.now()}.json`);
const { shouldSurfaceUnsentFirstTouch, upsertConversationByLeadKey } = await import(
  "../services/api/src/domain/conversationStore.ts"
);

const NOW = new Date("2026-06-25T18:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString();
const inbound = (at: string) => ({ direction: "in", provider: "sendgrid_adf", body: "WEB LEAD Source: AutoDealers.Digital", at });

let seq = 0;
const mk = (over: any = {}) => {
  const c: any = upsertConversationByLeadKey(`+1555100${String(seq++).padStart(4, "0")}`, "suggest");
  c.lead = { preferredContactMethod: "email", email: "x@y.com", firstName: "Pat", ...(over.lead ?? {}) };
  c.emailDraft = "emailDraft" in over ? over.emailDraft : "Hi Pat, thanks for your inquiry about the bike...";
  c.messages = over.messages ?? [inbound(daysAgo(5))];
  c.classification = over.classification ?? { bucket: "inventory_interest", cta: "check_availability" };
  c.followUp = over.followUp ?? undefined;
  c.followUpCadence = over.followUpCadence ?? undefined;
  c.closedAt = undefined;
  c.closedReason = undefined;
  c.firstTouchSurfacedAt = over.firstTouchSurfacedAt;
  if (over.conv) Object.assign(c, over.conv);
  return c;
};
let n = 0;
const ok = (cond: boolean, msg: string) => { assert.equal(cond, true, msg); n++; };

// --- POSITIVE: email-only, drafted-but-unsent, never contacted, no cadence, idle 5d => surface. ---
ok(shouldSurfaceUnsentFirstTouch(mk(), false, NOW) === true, "email-only never-contacted unsent draft => surface");
// NO max-idle: a 76-day-old missed first touch still surfaces (the actual silence-pool ages).
ok(shouldSurfaceUnsentFirstTouch(mk({ messages: [inbound(daysAgo(76))] }), false, NOW) === true, "ancient (76d) missed first touch still surfaces — no max cap");
// A non-stale pending draft_ai (SMS) counts as a pending first touch too.
ok(
  shouldSurfaceUnsentFirstTouch(
    mk({ emailDraft: "", messages: [inbound(daysAgo(5)), { direction: "out", provider: "draft_ai", draftStatus: "pending", body: "Hi!", at: daysAgo(5) }] }),
    false,
    NOW
  ) === true,
  "a pending draft_ai also counts"
);

// --- NEGATIVES. ---
ok(shouldSurfaceUnsentFirstTouch(mk(), true, NOW) === false, "already has an open todo => skip (no stack)");
ok(
  shouldSurfaceUnsentFirstTouch(mk({ messages: [inbound(daysAgo(5)), { direction: "out", provider: "sendgrid", body: "sent!", at: daysAgo(4) }] }), false, NOW) === false,
  "already contacted (real sendgrid outbound) => not surfaced"
);
// Contacted by PHONE (voice_*) counts too — a lead worked by phone is not awaiting a first touch
// (Cody/Ron: Scott called them; their draft_ai opener was superseded by the call).
ok(
  shouldSurfaceUnsentFirstTouch(
    mk({
      lead: { preferredContactMethod: "phone", phone: "+17165551212", firstName: "Ron" },
      messages: [inbound(daysAgo(5)), { direction: "out", provider: "voice_transcript", body: "Scott: Hi Ron...", at: daysAgo(4) }]
    }),
    false,
    NOW
  ) === false,
  "already contacted by phone (voice_transcript) => not surfaced"
);
ok(shouldSurfaceUnsentFirstTouch(mk({ emailDraft: "" }), false, NOW) === false, "no pending draft => not surfaced");
ok(shouldSurfaceUnsentFirstTouch(mk({ followUpCadence: { status: "active", kind: "standard" } }), false, NOW) === false, "active cadence already nudges => skip");
ok(shouldSurfaceUnsentFirstTouch(mk({ followUp: { mode: "paused_indefinite" } }), false, NOW) === false, "paused_indefinite (deliberate not-now) => skip");
ok(shouldSurfaceUnsentFirstTouch(mk({ classification: { bucket: "event_promo", cta: "sweepstakes" } }), false, NOW) === false, "event_promo gets an ack, not a sales chase => skip");
ok(shouldSurfaceUnsentFirstTouch(mk({ conv: { closedReason: "sold" } }), false, NOW) === false, "closed/sold => skip");
ok(shouldSurfaceUnsentFirstTouch(mk({ messages: [inbound(new Date(NOW.getTime() - 30 * 60 * 1000).toISOString())] }), false, NOW) === false, "just came in (<4h) => give the normal flow a beat");

// --- Dedup + re-nudge. ---
ok(shouldSurfaceUnsentFirstTouch(mk({ firstTouchSurfacedAt: daysAgo(2) }), false, NOW) === false, "surfaced 2d ago => within the 7d re-nudge window, skip");
ok(shouldSurfaceUnsentFirstTouch(mk({ firstTouchSurfacedAt: daysAgo(10) }), false, NOW) === true, "surfaced 10d ago => past re-nudge, surface again");

// --- Source guards: the reconcile runs it, channel-aware, recorded. ---
const api = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(api, /shouldSurfaceUnsentFirstTouch\(conv, convIdsWithOpenTodoNow\.has\(conv\.id\), now\)/, "reconcile runs the predicate with a FRESH open-todo set");
assert.match(api, /unsent_first_touch_surfaced/, "route outcome recorded");
assert.match(api, /Call \$\{who\} — they prefer a call/, "phone-preferred => a call todo");
assert.match(api, /Send the first reply to \$\{who\}/, "else => a send-the-drafted-reply todo");
// The auto-close backfill only runs on a REAL prior outbound (not an unsent draft_ai), so it can't
// silently close a never-contacted lead's fresh first-touch todo.
assert.match(api, /REAL_OUTBOUND_CONTACT_PROVIDERS\.has\(String\(m\?\.provider \?\? ""\)\)/, "auto-close backfill gates on a REAL outbound, not a draft");
n += 5;

console.log(`PASS unsent first-touch eval (${n} assertions)`);
