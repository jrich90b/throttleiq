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
const {
  shouldSurfaceUnsentFirstTouch,
  upsertConversationByLeadKey,
  decideFirstTouchTodoResolution,
  isFirstTouchTodo,
  FIRST_TOUCH_TODO_MAX_AGE_DAYS
} = await import("../services/api/src/domain/conversationStore.ts");

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
// Retired for good: once the todo aged out unactioned, the re-nudge loop must NOT recreate it.
{
  const retired = mk({ firstTouchSurfacedAt: daysAgo(20) });
  (retired as any).firstTouchRetiredAt = daysAgo(3);
  ok(shouldSurfaceUnsentFirstTouch(retired, false, NOW) === false, "firstTouchRetiredAt permanently stops the re-nudge loop");
  n += 1;
}

// --- First-touch todo LIFECYCLE (task-hygiene, 7/23): the class had NO closer at all — reason
// `note` is ineligible for the LLM fulfillment auto-close, so "Send the first reply" tasks stayed
// open even after the reply went out (Annie +17165361711, 20 days), and the 6/25 backfill batch sat
// 27 days with the re-nudge loop standing by to recreate it. The resolution is deterministic
// (the objective is a FACT): contacted => close; aged out uncontacted => retire; young => keep. ---
{
  const noteTodo = { summary: "Send the first reply to Annie — a reply was drafted but never sent (check the Email tab).", createdAt: daysAgo(20) };
  const callTodo = { summary: "Call Ron — they prefer a call and no first contact has gone out yet.", createdAt: daysAgo(2) };
  ok(isFirstTouchTodo(noteTodo) === true, "the email-variant summary is recognized");
  ok(isFirstTouchTodo(callTodo) === true, "the call-variant summary is recognized");
  ok(isFirstTouchTodo({ summary: "Call customer (follow-up)" }) === false, "an ordinary call todo is NOT a first-touch todo");

  const contacted = mk({ messages: [inbound(daysAgo(20)), { direction: "out", provider: "twilio", body: "hello Annie its stone", at: daysAgo(1) }] });
  ok(decideFirstTouchTodoResolution(contacted, noteTodo, NOW) === "close_contacted", "a real outbound after the task => objective achieved => close (the Annie case)");

  const stillUncontactedOld = mk({});
  ok(decideFirstTouchTodoResolution(stillUncontactedOld, noteTodo, NOW) === "retire_aged", `open ${20} days with no contact => retire (past the ${FIRST_TOUCH_TODO_MAX_AGE_DAYS}d actionable window; the 6/25 batch)`);

  const stillUncontactedYoung = mk({});
  ok(decideFirstTouchTodoResolution(stillUncontactedYoung, callTodo, NOW) === "keep", "a young uncontacted first-touch task keeps doing its job");

  // A pending draft_ai is NOT contact — the task must not close off an unsent draft.
  const draftOnly = mk({ messages: [inbound(daysAgo(3)), { direction: "out", provider: "draft_ai", body: "Hi...", at: daysAgo(2) }] });
  ok(decideFirstTouchTodoResolution(draftOnly, callTodo, NOW) === "keep", "an unsent draft is not contact — task stays");
  n += 7;
}

// --- Source guards: the reconcile runs it, channel-aware, recorded. ---
const api = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(api, /shouldSurfaceUnsentFirstTouch\(conv, convIdsWithOpenTodoNow\.has\(conv\.id\), now\)/, "reconcile runs the predicate with a FRESH open-todo set");
assert.match(api, /unsent_first_touch_surfaced/, "route outcome recorded");
assert.match(api, /Call \$\{who\} — they prefer a call/, "phone-preferred => a call todo");
assert.match(api, /Send the first reply to \$\{who\}/, "else => a send-the-drafted-reply todo");
// The auto-close backfill only runs on a REAL prior outbound (not an unsent draft_ai), so it can't
// silently close a never-contacted lead's fresh first-touch todo.
assert.match(api, /REAL_OUTBOUND_CONTACT_PROVIDERS\.has\(String\(m\?\.provider \?\? ""\)\)/, "auto-close backfill gates on a REAL outbound, not a draft");
// The lifecycle sweep is wired into the reconcile tick, and retirement stamps the permanent stop.
assert.match(api, /decideFirstTouchTodoResolution\(conv, t, now\)/, "the reconcile resolves open first-touch todos");
assert.match(api, /firstTouchRetiredAt = now\.toISOString\(\)/, "aged-out retirement stamps the permanent stop");
n += 7;

console.log(`PASS unsent first-touch eval (${n} assertions)`);
